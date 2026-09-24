-- 023_hermes_decisions.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Durable Hermes decision store (Issue #172): the append/list contract that
-- the manager module defines (src/manager/hermesManager.js) is backed by a
-- real table so decision history and monotonic decision numbering survive
-- restarts. The process-lifetime in-memory store remains only as the
-- labeled demo transport; production constructs PostgresHermesDecisionStore
-- over this table.
--
-- Append-only semantics (same pattern as sql/022 director_connection_tests):
-- rows are immutable — a BEFORE UPDATE OR DELETE trigger rejects mutation
-- (APPEND_ONLY_VIOLATION). A decision "completion" is a NEW record carrying
-- the same decision_number (supersedes_decision_number), never an UPDATE.
--
-- Closed enums mirror the manager module contract exactly (R5: the database
-- mirrors existing module enums; no new states are introduced anywhere):
--   authority: AUTONOMOUS | OWNER_POLICY_CONTROLLED | PROHIBITED
--   category:  production | scheduling | providers | resources | publishing
--              | security_refusal
--   outcome:   EXECUTING | EXECUTED | FAILED | BLOCKED |
--              OWNER_APPROVAL_REQUIRED
--
-- PG15-compatible: jsonb_typeof checks only — no IS JSON, no subqueries in
-- CHECK constraints. All statements idempotent (IF NOT EXISTS / OR REPLACE).
-- Secret-shaped material never reaches this layer: the manager's payload
-- gate rejects it before a record exists (Rule 17).

CREATE TABLE IF NOT EXISTS hermes_decisions (
  record_seq bigserial PRIMARY KEY,
  decision_number bigint NOT NULL CHECK (decision_number > 0),
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
  authority text NOT NULL CHECK (authority IN
    ('AUTONOMOUS', 'OWNER_POLICY_CONTROLLED', 'PROHIBITED')),
  director_id text NOT NULL CHECK (char_length(director_id) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (category IN
    ('production', 'scheduling', 'providers', 'resources', 'publishing',
     'security_refusal')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  outcome text NOT NULL CHECK (outcome IN
    ('EXECUTING', 'EXECUTED', 'FAILED', 'BLOCKED', 'OWNER_APPROVAL_REQUIRED')),
  reason_code text CHECK (reason_code IS NULL OR char_length(reason_code) <= 100),
  -- Structured intent, already secret-gated by the manager (Rule 17).
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  -- Credential REFERENCE request (agentId/providerKey/scope) — never
  -- credential material (Rules 4/5/17).
  credential_request jsonb CHECK (credential_request IS NULL OR jsonb_typeof(credential_request) = 'object'),
  supersedes_decision_number bigint CHECK (supersedes_decision_number IS NULL OR supersedes_decision_number > 0),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hermes_decisions_number_idx
  ON hermes_decisions (decision_number, record_seq DESC);
CREATE INDEX IF NOT EXISTS hermes_decisions_category_idx
  ON hermes_decisions (category, record_seq DESC);

-- Append-only enforcement: decision records are audit evidence.
CREATE OR REPLACE FUNCTION deny_hermes_decision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: hermes_decisions rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hermes_decisions_append_only ON hermes_decisions;
CREATE TRIGGER hermes_decisions_append_only
  BEFORE UPDATE OR DELETE ON hermes_decisions
  FOR EACH ROW EXECUTE FUNCTION deny_hermes_decision_mutation();
