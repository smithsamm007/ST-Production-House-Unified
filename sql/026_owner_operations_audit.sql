BEGIN;

-- 026_owner_operations_audit.sql
--
-- Additive migration (CONVENTIONS.md Rule 9 / AGENTS.md R1: never edit
-- applied migrations).
--
-- Issue #192: the owner live-operations surface (provider smoke test,
-- private-first publishing test, analytics ingestion) writes owner
-- mutations into the existing owner_control_audit trail (sql/017). The
-- table's shape CHECK only knows the four S-M18-02 actions, so this
-- migration additively widens the allowed action set (drop + re-add —
-- the sql/009/024/025 precedent for additive enum widening). Idempotent
-- (IF EXISTS / guarded DO block) so re-runnable boot semantics hold.
--
-- No existing rows are modified; previously legal actions stay legal.

ALTER TABLE owner_control_audit DROP CONSTRAINT IF EXISTS owner_control_audit_shape;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'owner_control_audit_shape'
  ) THEN
    ALTER TABLE owner_control_audit ADD CONSTRAINT owner_control_audit_shape
      CHECK (action IN (
        'job_retry',
        'job_cancel',
        'emergency_pause_set',
        'emergency_pause_cleared',
        'provider_smoke_test',
        'private_publishing_test',
        'analytics_ingest'
      ));
  END IF;
END;
$$;

COMMIT;
