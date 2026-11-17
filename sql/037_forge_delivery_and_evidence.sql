BEGIN;
-- 037 — FORGE Delivery, Review Separation, Durable PR Slot, External-Op Journal, and Hash-Chained Evidence (Phase 2.7, v1.2).

CREATE TABLE IF NOT EXISTS forge_review_verdicts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  commit_sha            TEXT NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  author_worker_id      UUID NOT NULL REFERENCES forge_workers(id) ON DELETE RESTRICT,
  reviewer_worker_id    UUID NOT NULL REFERENCES forge_workers(id) ON DELETE RESTRICT,
  verdict               TEXT NOT NULL CHECK (verdict IN ('PASS','CHANGES_REQUESTED','REJECT')),
  findings              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (author_worker_id <> reviewer_worker_id)
);

-- Durable single-row One-PR-in-Flight reservation table (v1.2).
-- `expires_at` is an alert/reconciliation trigger ONLY; never auto-releases while PR is open on GitHub.
CREATE TABLE IF NOT EXISTS forge_pr_slots (
  slot_id               INTEGER PRIMARY KEY CHECK (slot_id = 1),
  reserved_by_task_id   UUID NULL REFERENCES forge_tasks(id) ON DELETE RESTRICT,
  fencing_token         BIGINT NULL CHECK (fencing_token IS NULL OR fencing_token > 0),
  branch_name           TEXT NULL,
  pr_number             INTEGER NULL,
  reserved_at           TIMESTAMPTZ NULL,
  expires_at            TIMESTAMPTZ NULL
);

INSERT INTO forge_pr_slots (slot_id) VALUES (1) ON CONFLICT (slot_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS forge_pull_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  pr_number             INTEGER NOT NULL UNIQUE,
  branch_name           TEXT NOT NULL,
  head_sha              TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  state                 TEXT NOT NULL CHECK (state IN ('open','merged','closed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_forge_one_open_pr
  ON forge_pull_requests (state)
  WHERE state = 'open';

-- Write-ahead external-operation journal for crash-after-GitHub-accept recovery (v1.2).
CREATE TABLE IF NOT EXISTS forge_external_ops (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key       TEXT NOT NULL UNIQUE,
  task_id               UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  fencing_token         BIGINT NOT NULL CHECK (fencing_token > 0),
  operation_type        TEXT NOT NULL,
  target_branch         TEXT NOT NULL,
  expected_tree_sha     TEXT NULL,
  observed_sha          TEXT NULL,
  status                TEXT NOT NULL DEFAULT 'IN_FLIGHT'
                          CHECK (status IN ('IN_FLIGHT','COMMITTED','FAILED_SAFE_TO_RETRY')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reconciled_at         TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_forge_external_ops_inflight
  ON forge_external_ops (status, created_at)
  WHERE status = 'IN_FLIGHT';

CREATE TABLE IF NOT EXISTS forge_ci_results (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id                 UUID NOT NULL REFERENCES forge_pull_requests(id) ON DELETE CASCADE,
  commit_sha            TEXT NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  workflow_name         TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('queued','in_progress','success','failure','cancelled')),
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, workflow_name)
);

-- Hash-chained evidence ledger with monotonic sequence ordering.
CREATE TABLE IF NOT EXISTS forge_evidence_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_seq             BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  task_id               UUID NULL REFERENCES forge_tasks(id) ON DELETE SET NULL,
  event_type            TEXT NOT NULL,
  actor_id              TEXT NOT NULL,
  commit_sha            TEXT NULL,
  prev_hash             TEXT NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  record_hash           TEXT NOT NULL UNIQUE CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS forge_evidence_checkpoints (
  checkpoint_seq        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_seq             BIGINT NOT NULL REFERENCES forge_evidence_records(chain_seq) ON DELETE RESTRICT,
  head_hash             TEXT NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  prev_checkpoint_hash  TEXT NOT NULL CHECK (prev_checkpoint_hash ~ '^[0-9a-f]{64}$'),
  signing_kid           TEXT NOT NULL,
  signature             TEXT NOT NULL,
  worm_object_uri       TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
