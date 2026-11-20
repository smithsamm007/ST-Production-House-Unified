BEGIN;
-- 043 — HERMES five-hour Owner publishing approvals (D5).
--
-- Additive only. Reuses forge_delegation_policies (sql/038) by extending it
-- with the explicit, versioned, revocable publishing-policy attributes; adds
-- the durable approval-request, notification-outbox and deadline-lease tables.
--
-- Invariants enforced by the database (not by application clocks):
--   * deadline_at is EXACTLY notified_at + 5 hours (silence window).
--   * A request cannot be AWAITING_OWNER before a confirmed delivery.
--   * publishing_authorized can only exist on an approved terminal status.
--   * A HERMES APPROVE always carries a durable decision timestamp.
--   * One notification per (approval, kind): no duplicate owner/decision mail.
--
-- PG15-compatible; idempotent (IF NOT EXISTS / OR REPLACE). No data migration.

ALTER TABLE forge_delegation_policies
  ADD COLUMN IF NOT EXISTS policy_version integer NOT NULL DEFAULT 1;

ALTER TABLE forge_delegation_policies
  ADD COLUMN IF NOT EXISTS permits_live_publishing boolean NOT NULL DEFAULT false;

ALTER TABLE forge_delegation_policies
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL;

-- ---------------------------------------------------------------------------
-- Approval requests: one row per Director publishing request. Status is the
-- single terminal decision carrier; transitions are guarded by row locks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_publishing_approvals (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key         text NOT NULL UNIQUE
                            CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  owner_id                uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  director_id             text NOT NULL CHECK (char_length(director_id) BETWEEN 2 AND 80),
  universe_id             text NULL CHECK (universe_id IS NULL OR char_length(universe_id) <= 120),
  package_id              text NULL CHECK (package_id IS NULL OR char_length(package_id) <= 160),
  requested_action        text NOT NULL DEFAULT 'publishing.publish_publicly'
                            CHECK (requested_action = 'publishing.publish_publicly'),
  artifact_sha256         char(64) NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  destinations            text[] NOT NULL
                            CHECK (array_length(destinations, 1) BETWEEN 1 AND 4),
  caption_snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb
                            CHECK (jsonb_typeof(caption_snapshot) = 'object'),
  policy_version          text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 40),
  delegated_policy_id     text NULL REFERENCES forge_delegation_policies(policy_id) ON DELETE SET NULL,
  status                  text NOT NULL DEFAULT 'PENDING_NOTIFICATION'
                            CHECK (status IN (
                              'PENDING_NOTIFICATION',
                              'AWAITING_OWNER',
                              'OWNER_APPROVED',
                              'OWNER_REJECTED',
                              'CHANGES_REQUESTED',
                              'HERMES_APPROVED',
                              'HERMES_REJECTED',
                              'SUPERSEDED',
                              'WITHDRAWN')),
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  notified_at             timestamptz NULL,
  deadline_at             timestamptz NULL,
  owner_response_at       timestamptz NULL,
  owner_response_by       uuid NULL REFERENCES owners(id) ON DELETE SET NULL,
  owner_response_reason   text NULL CHECK (owner_response_reason IS NULL OR char_length(owner_response_reason) <= 500),
  hermes_decided_at       timestamptz NULL,
  hermes_decision         text NULL CHECK (hermes_decision IN ('APPROVE', 'REJECT')),
  decision_reason_codes   text[] NOT NULL DEFAULT '{}',
  decision_summary        text NULL CHECK (decision_summary IS NULL OR char_length(decision_summary) <= 1000),
  evaluated_checks        jsonb NULL CHECK (evaluated_checks IS NULL OR jsonb_typeof(evaluated_checks) = 'object'),
  decision_evidence_hash  char(64) NULL CHECK (decision_evidence_hash IS NULL OR decision_evidence_hash ~ '^[a-f0-9]{64}$'),
  publishing_authorized   boolean NOT NULL DEFAULT false,
  authorization_expires_at timestamptz NULL,
  superseded_by           uuid NULL REFERENCES forge_publishing_approvals(id) ON DELETE SET NULL,
  invalidated_at          timestamptz NULL,
  invalidation_reason     text NULL CHECK (invalidation_reason IS NULL OR char_length(invalidation_reason) <= 500),
  CONSTRAINT forge_approval_deadline_is_five_hours CHECK (
    notified_at IS NULL OR deadline_at = notified_at + interval '5 hours'
  ),
  CONSTRAINT forge_approval_deadline_requires_notice CHECK (
    deadline_at IS NULL OR notified_at IS NOT NULL
  ),
  CONSTRAINT forge_approval_awaiting_requires_notice CHECK (
    status <> 'AWAITING_OWNER' OR notified_at IS NOT NULL
  ),
  CONSTRAINT forge_approval_authorization_requires_approval CHECK (
    publishing_authorized = false OR status IN ('OWNER_APPROVED', 'HERMES_APPROVED')
  ),
  CONSTRAINT forge_approval_hermes_decision_requires_time CHECK (
    hermes_decision IS NULL OR hermes_decided_at IS NOT NULL
  ),
  -- A HERMES APPROVE must have created a positive authorization at decision
  -- time. A LATER, explicitly recorded invalidation/supersession may revoke
  -- that authorization without rewriting the historical decision.
  CONSTRAINT forge_approval_hermes_approve_authorizes CHECK (
    hermes_decision IS DISTINCT FROM 'APPROVE'
    OR publishing_authorized = true
    OR invalidated_at IS NOT NULL
    OR superseded_by IS NOT NULL
  ),
  CONSTRAINT forge_approval_owner_authorization_requires_expiry CHECK (
    publishing_authorized = false
    OR status <> 'OWNER_APPROVED'
    OR authorization_expires_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_forge_approvals_deadline
  ON forge_publishing_approvals (deadline_at)
  WHERE status = 'AWAITING_OWNER';

CREATE INDEX IF NOT EXISTS idx_forge_approvals_owner
  ON forge_publishing_approvals (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_forge_approvals_artifact
  ON forge_publishing_approvals (artifact_sha256);

-- ---------------------------------------------------------------------------
-- Notification outbox: delivery state is truthful and separate from the row's
-- existence (created → queued → attempted → delivered | failed).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_approval_notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id     uuid NOT NULL REFERENCES forge_publishing_approvals(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('OWNER_APPROVAL_REQUEST', 'HERMES_DECISION')),
  dedupe_key      text NOT NULL UNIQUE CHECK (char_length(dedupe_key) BETWEEN 8 AND 200),
  channel         text NOT NULL DEFAULT 'owner_inbox' CHECK (char_length(channel) BETWEEN 1 AND 60),
  state           text NOT NULL DEFAULT 'created'
                    CHECK (state IN ('created', 'queued', 'attempted', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  body            jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  last_error      text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  queued_at       timestamptz NULL,
  attempted_at    timestamptz NULL,
  delivered_at    timestamptz NULL,
  failed_at       timestamptz NULL,
  CONSTRAINT forge_notification_delivered_requires_time CHECK (
    state <> 'delivered' OR delivered_at IS NOT NULL
  ),
  CONSTRAINT forge_notification_one_per_kind UNIQUE (approval_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_forge_approval_notifications_state
  ON forge_approval_notifications (state, created_at);

-- ---------------------------------------------------------------------------
-- Deadline worker leases: one row per approval, monotonic fencing token. The
-- approval itself stays the authoritative deadline; this table only decides
-- which instance may evaluate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_approval_deadline_leases (
  approval_id       uuid PRIMARY KEY REFERENCES forge_publishing_approvals(id) ON DELETE CASCADE,
  worker_id         text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 120),
  fencing_token     bigint NOT NULL CHECK (fencing_token > 0),
  lease_expires_at  timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------------------
-- Append-only decision ledger for the delegated publishing authority. Mirrors
-- sql/023 immutability so a decision cannot be rewritten after the fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_publishing_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id   uuid NOT NULL REFERENCES forge_publishing_approvals(id) ON DELETE CASCADE,
  actor         text NOT NULL CHECK (actor IN ('OWNER', 'HERMES')),
  decision      text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT', 'CHANGES_REQUESTED')),
  reason_codes  text[] NOT NULL DEFAULT '{}',
  summary       text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
  policy_id     text NULL,
  policy_version integer NULL,
  evidence_hash char(64) NULL CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[a-f0-9]{64}$'),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  decided_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_forge_publishing_decisions_approval
  ON forge_publishing_decisions (approval_id, decided_at);

CREATE OR REPLACE FUNCTION deny_forge_publishing_decision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: forge_publishing_decisions rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS forge_publishing_decisions_append_only ON forge_publishing_decisions;
CREATE TRIGGER forge_publishing_decisions_append_only
  BEFORE UPDATE OR DELETE ON forge_publishing_decisions
  FOR EACH ROW EXECUTE FUNCTION deny_forge_publishing_decision_mutation();

COMMIT;
