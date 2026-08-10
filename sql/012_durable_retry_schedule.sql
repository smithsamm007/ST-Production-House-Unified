BEGIN;

-- Add next_attempt_at column if it does not exist
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz DEFAULT now();

-- Add backoff_metadata column if it does not exist
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS backoff_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Create index for optimized next attempt checks
CREATE INDEX IF NOT EXISTS jobs_next_attempt_idx
  ON jobs (next_attempt_at)
  WHERE status = 'queued';

COMMIT;
