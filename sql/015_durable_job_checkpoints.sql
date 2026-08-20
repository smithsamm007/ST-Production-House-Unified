BEGIN;

CREATE TABLE IF NOT EXISTS job_checkpoints (
  task_id text PRIMARY KEY CHECK (char_length(task_id) BETWEEN 1 AND 160),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  checkpoint_record jsonb NOT NULL CHECK (jsonb_typeof(checkpoint_record) = 'object'),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_checkpoints_scope_idx
  ON job_checkpoints (owner_id, agent_id, updated_at DESC);

COMMIT;
