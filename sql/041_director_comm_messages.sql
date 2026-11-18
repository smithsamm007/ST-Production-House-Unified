-- 041_director_comm_messages.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Durable conversation custody for the Director Communication Engine
-- (Owner -> Director AI). The pre-existing director_messages table (sql/021)
-- records human/owner workspace messages and deliberately carries no provider
-- metadata, so the AI conversation gets its own additively created table rather
-- than altering an applied table:
--
--   * one row per message (never a whole-conversation blob), so concurrent
--     server instances append instead of overwriting each other;
--   * `seq bigserial` gives every instance the same total order, independent of
--     application clocks;
--   * UNIQUE (owner_id, agent_id, client_message_id, role) is the idempotency
--     contract: a retried clientMessageId (including after a restart or on a
--     different instance) cannot create a second message or a second AI reply;
--   * owner_id + agent_id scope every row, so a Director conversation is
--     owner-scoped and Director-scoped by construction;
--   * provider evidence (model, correlation_id, latency_ms, outcome, source) is
--     recorded with the reply, never fabricated.
--
-- No existing table, column, constraint or index is modified.

BEGIN;

CREATE TABLE IF NOT EXISTS director_comm_messages (
  seq               bigserial,
  id                text PRIMARY KEY,
  owner_id          uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id          text NOT NULL REFERENCES agents(id),
  client_message_id text NOT NULL CHECK (char_length(client_message_id) BETWEEN 8 AND 80),
  role              text NOT NULL CHECK (role IN ('owner', 'director')),
  kind              text NOT NULL CHECK (kind IN ('conversation', 'proposal', 'instruction', 'decision')),
  source            text NOT NULL CHECK (source IN ('owner', 'director_ai', 'system_error')),
  outcome           text CHECK (
                      outcome IS NULL OR outcome IN (
                        'DIRECTOR_RESPONDED',
                        'DIRECTOR_NEEDS_CLARIFICATION',
                        'TASK_ACCEPTED',
                        'TASK_REJECTED_WITH_REASON',
                        'PROVIDER_UNAVAILABLE',
                        'ROUTING_FAILED'
                      )
                    ),
  model             text CHECK (model IS NULL OR char_length(model) <= 120),
  correlation_id    text CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 80),
  latency_ms        integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  body              text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, agent_id, client_message_id, role)
);

CREATE INDEX IF NOT EXISTS director_comm_messages_order_idx
  ON director_comm_messages (owner_id, agent_id, seq ASC);

CREATE INDEX IF NOT EXISTS director_comm_messages_client_idx
  ON director_comm_messages (owner_id, agent_id, client_message_id);

COMMIT;
