BEGIN;
-- 035 — FORGE Engineering Tasks, Dependencies, Workers, and Fenced Leases (Phase 2.7, v1.2).
-- Preserves sql/001..034 untouched. PostgreSQL 15+ compatible.

CREATE TABLE IF NOT EXISTS forge_tasks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number          INTEGER NOT NULL CHECK (issue_number > 0),
  derived_branch        TEXT NOT NULL CHECK (derived_branch ~ '^task/[0-9]+-[a-z0-9-]+$'),
  title                 TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'READY'
                          CHECK (status IN (
                            'NOT_STARTED','READY','IN_PROGRESS','REVIEW_REQUIRED',
                            'CI_PENDING','BLOCKED','FAILED','DEAD_LETTER',
                            'ACCEPTED','DEPLOYED','VERIFIED'
                          )),
  priority              INTEGER NOT NULL DEFAULT 100,
  idempotency_key       TEXT NOT NULL UNIQUE,
  active_fencing_token  BIGINT NOT NULL DEFAULT 0 CHECK (active_fencing_token >= 0),
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts          INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_run_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  cancel_requested      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_forge_tasks_sched
  ON forge_tasks (status, priority, next_run_at);

CREATE TABLE IF NOT EXISTS forge_task_dependencies (
  task_id               UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  depends_on_task_id    UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS forge_workers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_key            TEXT NOT NULL UNIQUE,
  role                  TEXT NOT NULL CHECK (role IN ('coder','qa','reviewer','security')),
  status                TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','active','draining','offline')),
  runtime_env           TEXT NOT NULL DEFAULT 'isolated_container',
  last_heartbeat_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_forge_workers_health
  ON forge_workers (status, last_heartbeat_at);

-- Historical leases are retained; at-most-one active lease per task is enforced
-- exclusively by the partial unique index below (v1.2 Critical Fix 1.2).
CREATE TABLE IF NOT EXISTS forge_worker_leases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  worker_id             UUID NOT NULL REFERENCES forge_workers(id) ON DELETE RESTRICT,
  fencing_token         BIGINT NOT NULL CHECK (fencing_token > 0),
  leased_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at      TIMESTAMPTZ NOT NULL,
  released_at           TIMESTAMPTZ NULL,
  release_reason        TEXT NULL CHECK (release_reason IN ('completed','expired','cancelled','failed','reclaimed')),
  UNIQUE (task_id, fencing_token)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_forge_active_lease_per_task
  ON forge_worker_leases (task_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_forge_leases_expiry
  ON forge_worker_leases (lease_expires_at)
  WHERE released_at IS NULL;

COMMIT;
