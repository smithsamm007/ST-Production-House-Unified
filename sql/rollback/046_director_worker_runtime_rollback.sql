BEGIN;
-- Rollback for sql/046_director_worker_runtime.sql.
-- Removes only what migration 046 added; sql/045 objects are preserved.

DROP TRIGGER IF EXISTS trg_director_worker_events_append_only ON director_worker_events;
DROP FUNCTION IF EXISTS director_worker_events_append_only();
DROP TABLE IF EXISTS director_worker_events;

DROP TABLE IF EXISTS director_task_checkpoints;
DROP TABLE IF EXISTS director_lease_violations;

ALTER TABLE director_task_evidence DROP CONSTRAINT IF EXISTS director_task_evidence_verification_check;
DROP INDEX IF EXISTS idx_director_evidence_verification;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS handler_name;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS handler_version;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS verification_level;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS environment;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS test_fixture;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS worker_key;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS fencing_token;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS input_refs;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS output_refs;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS validation;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS started_at;
ALTER TABLE director_task_evidence DROP COLUMN IF EXISTS completed_at;

DROP INDEX IF EXISTS idx_director_checkpoints_task;

ALTER TABLE director_tasks DROP COLUMN IF EXISTS input;
ALTER TABLE director_tasks DROP COLUMN IF EXISTS claimed_worker_key;
ALTER TABLE director_tasks DROP COLUMN IF EXISTS claim_count;
ALTER TABLE director_tasks DROP COLUMN IF EXISTS last_checkpoint_key;

ALTER TABLE director_workers DROP CONSTRAINT IF EXISTS director_workers_state_check;
DROP INDEX IF EXISTS idx_director_workers_state;
ALTER TABLE director_workers DROP COLUMN IF EXISTS worker_type;
ALTER TABLE director_workers DROP COLUMN IF EXISTS runtime_instance_id;
ALTER TABLE director_workers DROP COLUMN IF EXISTS stage_types;
ALTER TABLE director_workers DROP COLUMN IF EXISTS capabilities;
ALTER TABLE director_workers DROP COLUMN IF EXISTS director_scope;
ALTER TABLE director_workers DROP COLUMN IF EXISTS state;
ALTER TABLE director_workers DROP COLUMN IF EXISTS config_version;
ALTER TABLE director_workers DROP COLUMN IF EXISTS current_task_id;
ALTER TABLE director_workers DROP COLUMN IF EXISTS current_director_id;
ALTER TABLE director_workers DROP COLUMN IF EXISTS last_completed_task_id;
ALTER TABLE director_workers DROP COLUMN IF EXISTS last_completed_at;
ALTER TABLE director_workers DROP COLUMN IF EXISTS last_failure_at;
ALTER TABLE director_workers DROP COLUMN IF EXISTS last_failure;
ALTER TABLE director_workers DROP COLUMN IF EXISTS failure_count;
ALTER TABLE director_workers DROP COLUMN IF EXISTS lease_violation_count;
ALTER TABLE director_workers DROP COLUMN IF EXISTS registered_at;
ALTER TABLE director_workers DROP COLUMN IF EXISTS drained_at;
ALTER TABLE director_workers DROP COLUMN IF EXISTS stopped_at;

COMMIT;
