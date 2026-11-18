BEGIN;
-- Rollback for 042 — FORGE durable runtime tables (D3).
-- Additive migration only: dropping these three tables removes checkpoints,
-- fencing-checked results and reconciliation history without touching the
-- 035–037 task, lease, PR-slot, journal or evidence tables.

DROP TABLE IF EXISTS forge_reconciliations;
DROP TABLE IF EXISTS forge_task_results;
DROP TABLE IF EXISTS forge_task_checkpoints;

COMMIT;
