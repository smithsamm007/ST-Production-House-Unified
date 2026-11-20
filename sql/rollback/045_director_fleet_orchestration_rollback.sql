BEGIN;
-- Rollback for sql/045_director_fleet_orchestration.sql.
-- Drops ONLY the objects that migration 045 created. sql/001..044 are untouched.
-- Destructive by definition: run only on a disposable database, or with explicit
-- Owner authorization. Director history (audit, evidence, escalations) is
-- included because 045 owns it.

DROP TRIGGER IF EXISTS trg_director_fleet_audit_append_only ON director_fleet_audit;
DROP FUNCTION IF EXISTS director_fleet_audit_append_only();
DROP TRIGGER IF EXISTS trg_director_fleet_capacity ON director_fleet;
DROP FUNCTION IF EXISTS director_fleet_capacity_guard();

DROP TABLE IF EXISTS director_fleet_escalations;
DROP TABLE IF EXISTS director_workers;
DROP TABLE IF EXISTS director_task_evidence;
DROP TABLE IF EXISTS director_task_leases;
DROP TABLE IF EXISTS director_task_dependencies;
DROP TABLE IF EXISTS director_tasks;
DROP TABLE IF EXISTS director_projects;
DROP TABLE IF EXISTS director_fleet_audit;
DROP TABLE IF EXISTS director_fleet;

COMMIT;
