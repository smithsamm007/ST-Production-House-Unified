BEGIN;
-- 042 — FORGE durable runtime: task checkpoints, fencing-checked results, and
--       boot reconciliation records (Phase 2.7 / D3).
--
-- Additive only: no existing table, column, index or migration is altered.
-- 035–037 already provide forge_tasks, forge_task_dependencies, forge_workers,
-- forge_worker_leases, forge_pr_slots, forge_external_ops and the evidence
-- chain; this migration adds the three records the mounted runtime needs to
-- survive restarts without inventing state.
--
-- Idempotent (IF NOT EXISTS), so re-running boot semantics hold.

-- Progress checkpoints written by a lease holder. A checkpoint is only
-- acceptable from the task's current fencing token, and its sequence is unique
-- per (task, token) so a retried write is a no-op instead of a duplicate.
CREATE TABLE IF NOT EXISTS forge_task_checkpoints (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  fencing_token         BIGINT NOT NULL CHECK (fencing_token > 0),
  sequence              INTEGER NOT NULL CHECK (sequence > 0),
  state                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, fencing_token, sequence)
);

CREATE INDEX IF NOT EXISTS idx_forge_checkpoints_task_seq
  ON forge_task_checkpoints (task_id, sequence DESC);

-- Terminal results. The fencing token is part of the identity, so a stale
-- worker reusing an old token can never overwrite the holder's outcome.
CREATE TABLE IF NOT EXISTS forge_task_results (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  worker_id             UUID NULL REFERENCES forge_workers(id) ON DELETE SET NULL,
  fencing_token         BIGINT NOT NULL CHECK (fencing_token > 0),
  outcome               TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED')),
  result                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, fencing_token)
);

CREATE INDEX IF NOT EXISTS idx_forge_results_task
  ON forge_task_results (task_id, created_at DESC);

-- Durable record of every boot-time reconciliation attempt (decisions are
-- recorded even when the outcome is "unverified" — ambiguity is never repair).
CREATE TABLE IF NOT EXISTS forge_reconciliations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id           TEXT NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at           TIMESTAMPTZ NULL,
  decisions             JSONB NOT NULL DEFAULT '[]'::jsonb,
  degraded_reason       TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_forge_reconciliations_started
  ON forge_reconciliations (started_at DESC);

COMMIT;
