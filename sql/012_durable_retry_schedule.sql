BEGIN;

-- Check and validate resulting schema rather than silently accepting incompatible pre-existing columns
DO $$
DECLARE
  v_col_type text;
BEGIN
  -- Validate next_attempt_at if already exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'jobs' AND column_name = 'next_attempt_at'
  ) THEN
    SELECT data_type INTO v_col_type FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'jobs' AND column_name = 'next_attempt_at';
    IF v_col_type <> 'timestamp with time zone' THEN
      RAISE EXCEPTION 'Incompatible type for jobs.next_attempt_at: expected timestamp with time zone, got %', v_col_type;
    END IF;
  ELSE
    ALTER TABLE jobs ADD COLUMN next_attempt_at timestamptz DEFAULT now();
  END IF;

  -- Validate backoff_metadata if already exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'jobs' AND column_name = 'backoff_metadata'
  ) THEN
    SELECT data_type INTO v_col_type FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'jobs' AND column_name = 'backoff_metadata';
    IF v_col_type <> 'jsonb' THEN
      RAISE EXCEPTION 'Incompatible type for jobs.backoff_metadata: expected jsonb, got %', v_col_type;
    END IF;
  ELSE
    ALTER TABLE jobs ADD COLUMN backoff_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END;
$$;

-- Create partial index for optimized next attempt checks
CREATE INDEX IF NOT EXISTS jobs_next_attempt_idx
  ON jobs (next_attempt_at)
  WHERE status = 'queued';

COMMIT;
