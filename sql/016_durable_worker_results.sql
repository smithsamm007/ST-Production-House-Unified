BEGIN;

CREATE TABLE IF NOT EXISTS worker_results (
  task_id text PRIMARY KEY CHECK (char_length(task_id) BETWEEN 1 AND 160),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  result_record jsonb NOT NULL CHECK (jsonb_typeof(result_record) = 'object'),
  result_hash char(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_results_scope_idx
  ON worker_results (owner_id, agent_id, created_at DESC);

COMMIT;
