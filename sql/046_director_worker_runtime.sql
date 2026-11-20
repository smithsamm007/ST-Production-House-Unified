BEGIN;
-- 046 — Durable Director worker runtime (Day 6).
--
-- Additive only: sql/001..045 are untouched. PostgreSQL 15+ compatible.
--
-- Design notes
--   * The Day 5 worker table (sql/045) only recorded a heartbeat. This migration
--     turns it into a real registry: an explicit lifecycle state machine, the
--     stage types and capabilities a runtime may execute, its Director scope, the
--     task it is currently holding and its durable failure history.
--     `status` (active|draining|offline) is kept for backward compatibility and is
--     kept in step with `state`; `state` is the rich vocabulary.
--   * Worker lifecycle decisions are audited append-only. A browser session can
--     never write here: registration is a runtime action performed by FORGE.
--   * `director_task_checkpoints` is the durability record a restart resumes from.
--     A checkpoint is keyed by (task, checkpoint key) so a replayed worker cannot
--     duplicate it.
--   * `director_lease_violations` records fenced-completion refusals. It exists
--     because the refusing transaction rolls back, so the operational fact needs
--     its own durable row outside that transaction.
--   * `director_task_evidence` gains the real evidence contract: handler name and
--     version, verification level, environment, test-fixture flag, worker and
--     fencing token, input/output references, validation results and execution
--     timestamps. Nothing about a stage completion is inferred any more.
--   * `director_tasks.input` carries the persisted stage inputs a handler works
--     from. It is JSON metadata only; secrets are refused by the worker layer.

-- --------------------------------------------------------------- workers

ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS worker_type TEXT NOT NULL DEFAULT 'production_worker';
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS runtime_instance_id TEXT NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS stage_types JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS director_scope JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'REGISTERED';
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS current_task_id UUID NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS current_director_id TEXT NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS last_completed_task_id UUID NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS last_completed_at TIMESTAMPTZ NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS last_failure TEXT NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS lease_violation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS drained_at TIMESTAMPTZ NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ NULL;
ALTER TABLE director_workers ADD COLUMN IF NOT EXISTS restart_requested_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'director_workers_state_check'
  ) THEN
    ALTER TABLE director_workers
      ADD CONSTRAINT director_workers_state_check
      CHECK (state IN ('REGISTERED','STARTING','IDLE','BUSY','DEGRADED','DRAINING','OFFLINE','STOPPED'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_director_workers_state
  ON director_workers (state, last_heartbeat_at);

-- Append-only worker lifecycle audit (registration, state changes, drain,
-- restart request, lease loss). Never rewritten.
CREATE TABLE IF NOT EXISTS director_worker_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_key      TEXT NOT NULL,
  action          TEXT NOT NULL,
  previous_state  TEXT NULL,
  new_state       TEXT NULL,
  reason          TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  actor_role      TEXT NOT NULL CHECK (actor_role IN ('OWNER','HERMES','FORGE','SYSTEM')),
  correlation_id  UUID NOT NULL,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_director_worker_events_key
  ON director_worker_events (worker_key, created_at DESC);

CREATE OR REPLACE FUNCTION director_worker_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION';
END;
$$;

DROP TRIGGER IF EXISTS trg_director_worker_events_append_only ON director_worker_events;
CREATE TRIGGER trg_director_worker_events_append_only
  BEFORE UPDATE OR DELETE ON director_worker_events
  FOR EACH ROW EXECUTE FUNCTION director_worker_events_append_only();

-- ------------------------------------------------------------- task inputs

ALTER TABLE director_tasks ADD COLUMN IF NOT EXISTS input JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE director_tasks ADD COLUMN IF NOT EXISTS claimed_worker_key TEXT NULL;
ALTER TABLE director_tasks ADD COLUMN IF NOT EXISTS claim_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE director_tasks ADD COLUMN IF NOT EXISTS last_checkpoint_key TEXT NULL;

-- Durable checkpoints: what a restarted worker may resume from.
CREATE TABLE IF NOT EXISTS director_task_checkpoints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES director_tasks(id) ON DELETE CASCADE,
  worker_key      TEXT NOT NULL,
  fencing_token   BIGINT NOT NULL CHECK (fencing_token > 0),
  checkpoint_key  TEXT NOT NULL CHECK (length(checkpoint_key) BETWEEN 1 AND 120),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, checkpoint_key)
);

CREATE INDEX IF NOT EXISTS idx_director_checkpoints_task
  ON director_task_checkpoints (task_id, created_at ASC);

-- Fenced-completion refusals, recorded outside the refusing transaction.
CREATE TABLE IF NOT EXISTS director_lease_violations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID NOT NULL,
  worker_key       TEXT NULL,
  presented_token  BIGINT NULL,
  active_token     BIGINT NULL,
  code             TEXT NOT NULL,
  detail           TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_director_lease_violations_task
  ON director_lease_violations (task_id, created_at DESC);

-- ----------------------------------------------------------- evidence contract

ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS handler_name TEXT NULL;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS handler_version TEXT NULL;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS verification_level TEXT NOT NULL DEFAULT 'IMPLEMENTED';
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS test_fixture BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS worker_key TEXT NULL;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS fencing_token BIGINT NULL;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS input_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS output_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS validation JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NULL;
ALTER TABLE director_task_evidence ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'director_task_evidence_verification_check'
  ) THEN
    ALTER TABLE director_task_evidence
      ADD CONSTRAINT director_task_evidence_verification_check
      CHECK (verification_level IN (
        'IMPLEMENTED','UNIT_TESTED','INTEGRATION_TESTED','CI_VERIFIED',
        'PROVIDER_VERIFIED','PRODUCTION_VERIFIED','BLOCKED','NOT_RUN'
      ));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_director_evidence_verification
  ON director_task_evidence (verification_level, created_at DESC);

COMMIT;
