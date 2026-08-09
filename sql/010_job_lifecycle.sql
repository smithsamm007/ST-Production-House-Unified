BEGIN;

-- Add concurrency_limit to the agents table, default to 5
ALTER TABLE agents ADD COLUMN IF NOT EXISTS concurrency_limit integer NOT NULL DEFAULT 5;

-- Concurrency-safe additive/idempotent guard for constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agents_concurrency_limit_positive'
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_concurrency_limit_positive CHECK (concurrency_limit > 0);
  END IF;
END;
$$;

-- Create a function to enforce explicit, valid state transitions
CREATE OR REPLACE FUNCTION enforce_job_status_transition()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'queued' AND NEW.status NOT IN ('leased') THEN
    RAISE EXCEPTION 'Invalid transition from queued to %', NEW.status;
  ELSIF OLD.status = 'leased' AND NEW.status NOT IN ('queued', 'running', 'failed', 'dead_letter') THEN
    RAISE EXCEPTION 'Invalid transition from leased to %', NEW.status;
  ELSIF OLD.status = 'running' AND NEW.status NOT IN ('succeeded', 'failed', 'dead_letter', 'leased', 'queued') THEN
    RAISE EXCEPTION 'Invalid transition from running to %', NEW.status;
  ELSIF OLD.status = 'failed' AND NEW.status NOT IN ('queued', 'dead_letter') THEN
    RAISE EXCEPTION 'Invalid transition from failed to %', NEW.status;
  ELSIF OLD.status = 'succeeded' THEN
    RAISE EXCEPTION 'Cannot transition from terminal status succeeded to %', NEW.status;
  ELSIF OLD.status = 'dead_letter' AND NEW.status NOT IN ('queued') THEN
    RAISE EXCEPTION 'Cannot transition from terminal status dead_letter to %', NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if it already exists to be idempotent
DROP TRIGGER IF EXISTS enforce_job_status_transition_trg ON jobs;

-- Create the trigger on the jobs table
CREATE TRIGGER enforce_job_status_transition_trg
  BEFORE UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_job_status_transition();

-- Optimize lease reclamation queries with a partial index
CREATE INDEX IF NOT EXISTS jobs_lease_expiry_idx
  ON jobs (lease_expires_at)
  WHERE status IN ('leased', 'running');

COMMIT;
