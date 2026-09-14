BEGIN;

-- ===========================================================================
-- 017_owner_job_control.sql
--
-- Additive, idempotent migration for the owner control surface (S-M18-02):
-- 1. Durable per-job ownership binding so owner routes can scope every job
--    query by the session owner without joining through communication/broker
--    tables (those joins do not cover all jobs in practice).
-- 2. An owner control audit table: every dashboard mutation writes one
--    tamper-evident row (AGENTS.md Rule 6), in the same transaction as the
--    state change it records.
-- 3. `owner_cancelled` job status with trigger transitions extended.
--    Existing job_status enum values are untouched (R5): this ADDS a value.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-job owner binding
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_id uuid;

-- Backfill: derive from canonical ownership sources where possible. Rows that
-- cannot be mapped stay NULL and are simply invisible to owner routes (they
-- are system jobs, not owner dashboard work).
DO $$
BEGIN
  UPDATE jobs j
     SET owner_id = cs.owner_id
    FROM communication_sessions cs
   WHERE cs.agent_id = j.agent_id
     AND j.owner_id IS NULL;
END;
$$;

-- 50 concurrent agents max; per-agent one owner in the dashboard model.
CREATE INDEX IF NOT EXISTS jobs_owner_status_idx
  ON jobs (owner_id, status, created_at);

-- ---------------------------------------------------------------------------
-- 2. Owner control audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS owner_control_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 60),
  from_status text,
  to_status text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_control_audit_shape CHECK (
    action IN ('job_retry', 'job_cancel', 'emergency_pause_set', 'emergency_pause_cleared')
  )
);

CREATE INDEX IF NOT EXISTS owner_control_audit_owner_idx
  ON owner_control_audit (owner_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. `owner_cancelled` job status + trigger extension (R5-compatible: additive)
-- ---------------------------------------------------------------------------
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'owner_cancelled';

-- Re-declare the transition function with one added branch: an owner cancel
-- is allowed from queued/leased/running (workers observe the cancel on their
-- next cancellation check; queued/leased jobs are simply never claimed).
-- All other transitions remain exactly as migration 010 defined them.
CREATE OR REPLACE FUNCTION enforce_job_status_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'queued' AND NEW.status NOT IN ('leased', 'owner_cancelled') THEN
    RAISE EXCEPTION 'Invalid transition from queued to %', NEW.status;
  ELSIF OLD.status = 'leased' AND NEW.status NOT IN ('queued', 'running', 'failed', 'dead_letter', 'owner_cancelled') THEN
    RAISE EXCEPTION 'Invalid transition from leased to %', NEW.status;
  ELSIF OLD.status = 'running' AND NEW.status NOT IN ('succeeded', 'failed', 'dead_letter', 'leased', 'queued', 'owner_cancelled') THEN
    RAISE EXCEPTION 'Invalid transition from running to %', NEW.status;
  ELSIF OLD.status = 'failed' AND NEW.status NOT IN ('queued', 'dead_letter') THEN
    RAISE EXCEPTION 'Invalid transition from failed to %', NEW.status;
  ELSIF OLD.status = 'succeeded' THEN
    RAISE EXCEPTION 'Cannot transition from terminal status succeeded to %', NEW.status;
  ELSIF OLD.status = 'dead_letter' AND NEW.status NOT IN ('queued') THEN
    RAISE EXCEPTION 'Cannot transition from terminal status dead_letter to %', NEW.status;
  ELSIF OLD.status = 'owner_cancelled' THEN
    RAISE EXCEPTION 'Cannot transition from terminal status owner_cancelled to %', NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
