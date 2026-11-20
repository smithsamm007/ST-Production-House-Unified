BEGIN;
-- Rollback for sql/043_hermes_publishing_approvals.sql.
-- Drops only the objects 043 created and reverses the additive policy columns.
-- forge_delegation_policies keeps its rows (038 remains canonical).

DROP TRIGGER IF EXISTS forge_publishing_decisions_append_only ON forge_publishing_decisions;
DROP FUNCTION IF EXISTS deny_forge_publishing_decision_mutation();

DROP TABLE IF EXISTS forge_publishing_decisions;
DROP TABLE IF EXISTS forge_approval_deadline_leases;
DROP TABLE IF EXISTS forge_approval_notifications;
DROP TABLE IF EXISTS forge_publishing_approvals;

ALTER TABLE forge_delegation_policies DROP COLUMN IF EXISTS revoked_at;
ALTER TABLE forge_delegation_policies DROP COLUMN IF EXISTS permits_live_publishing;
ALTER TABLE forge_delegation_policies DROP COLUMN IF EXISTS policy_version;

COMMIT;
