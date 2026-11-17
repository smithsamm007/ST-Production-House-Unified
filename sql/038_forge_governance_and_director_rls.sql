BEGIN;
-- 038 — FORGE Governance, Authz Decisions, Delegation, HERMES Bridge, and Per-Director RLS Isolation (Phase 2.7, v1.2).

CREATE TABLE IF NOT EXISTS forge_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id        UUID NOT NULL,
  event_type            TEXT NOT NULL,
  actor                 TEXT NOT NULL,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_forge_events_corr ON forge_events (correlation_id);

CREATE TABLE IF NOT EXISTS forge_authz_decisions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id              TEXT NOT NULL,
  actor_type            TEXT NOT NULL,
  action                TEXT NOT NULL,
  permission_tier       TEXT NOT NULL CHECK (permission_tier IN ('T0','T1','T2','T3','T4','T5','T6a','T6b','T6c','T7')),
  resource              JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision              TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY')),
  code                  TEXT NOT NULL,
  reason                TEXT NOT NULL,
  evidence_hash         TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS forge_delegation_policies (
  policy_id             TEXT PRIMARY KEY,
  category              TEXT NOT NULL,
  allowed_actions       TEXT[] NOT NULL,
  max_risk              TEXT NOT NULL DEFAULT 'medium',
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at            TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS forge_delegation_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id            TEXT NOT NULL,
  action                TEXT NOT NULL,
  resource              TEXT NOT NULL,
  decision_deadline     TIMESTAMPTZ NULL,
  applicable_policy     TEXT NULL REFERENCES forge_delegation_policies(policy_id) ON DELETE SET NULL,
  risk_assessment       TEXT NOT NULL,
  authorization_result  TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  execution_outcome     TEXT NOT NULL,
  evidence_ref          TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS forge_hermes_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id        UUID NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  sender                TEXT NOT NULL CHECK (sender IN ('forge','hermes')),
  recipient             TEXT NOT NULL CHECK (recipient IN ('forge','hermes')),
  event_name            TEXT NOT NULL,
  delivery_state        TEXT NOT NULL DEFAULT 'created'
                          CHECK (delivery_state IN ('created','queued','sent','delivered','acknowledged','completed','failed')),
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_forge_hermes_state ON forge_hermes_messages (delivery_state, created_at);

CREATE TABLE IF NOT EXISTS forge_notifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity              TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  channel               TEXT NOT NULL,
  dedupe_key            TEXT NOT NULL,
  body                  TEXT NOT NULL,
  delivered_at          TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------------------
-- Director Isolation Table with Non-Forgeable Per-Director Role RLS (v1.2)
-- Policies bind strictly to PostgreSQL `current_user` (never caller-supplied
-- `SET LOCAL` session variables). `FORCE ROW LEVEL SECURITY` is enabled.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_director_isolated_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  director_id           TEXT NOT NULL,
  director_role         TEXT NOT NULL CHECK (director_role ~ '^st_dir_[a-z0-9_]+$'),
  record_type           TEXT NOT NULL,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_forge_dir_iso_role
  ON forge_director_isolated_records (director_role, director_id);

ALTER TABLE forge_director_isolated_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_director_isolated_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS director_self_isolation_policy ON forge_director_isolated_records;
CREATE POLICY director_self_isolation_policy
  ON forge_director_isolated_records
  USING (director_role = current_user)
  WITH CHECK (director_role = current_user);

COMMIT;
