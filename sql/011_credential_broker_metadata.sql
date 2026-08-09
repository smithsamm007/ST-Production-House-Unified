BEGIN;

-- Create broker_credential_metadata table if not exists
CREATE TABLE IF NOT EXISTS broker_credential_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider text NOT NULL,
  secret_locator text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  rotation_status text NOT NULL DEFAULT 'stable' CHECK (rotation_status IN ('stable', 'rotating', 'failed_rotation')),
  expires_at timestamptz,
  last_health_status text NOT NULL DEFAULT 'healthy',
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Unique constraint for owner/agent/provider/locator configuration
  UNIQUE (owner_id, agent_id, provider, secret_locator),
  -- Prevent plaintext secrets: must start with safe prefix like 'vault://' or 'opaque://'
  CONSTRAINT no_plaintext_secrets_locator CHECK (
    secret_locator LIKE 'vault://%' OR secret_locator LIKE 'opaque://%'
  )
);

-- Optimize queries with indexes for fast query performance and isolation
CREATE INDEX IF NOT EXISTS broker_credential_metadata_owner_idx ON broker_credential_metadata (owner_id);
CREATE INDEX IF NOT EXISTS broker_credential_metadata_agent_idx ON broker_credential_metadata (agent_id);

-- Create broker_credential_audit_log table if not exists
CREATE TABLE IF NOT EXISTS broker_credential_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES broker_credential_metadata(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action text NOT NULL,
  performed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  error_message text,
  client_ip text,
  user_agent text
);

-- Index for the audit log
CREATE INDEX IF NOT EXISTS broker_credential_audit_log_owner_idx ON broker_credential_audit_log (owner_id);
CREATE INDEX IF NOT EXISTS broker_credential_audit_log_credential_idx ON broker_credential_audit_log (credential_id);

-- Enforce append-only audit: trigger function to prevent mutations (updates or deletes)
CREATE OR REPLACE FUNCTION deny_credential_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CREDENTIAL_AUDIT_LOGS_ARE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists to ensure the migration is rerun-safe (idempotent)
DROP TRIGGER IF EXISTS credential_audit_no_update ON broker_credential_audit_log;

-- Attach the trigger to enforce append-only behavior on database level
CREATE TRIGGER credential_audit_no_update
BEFORE UPDATE OR DELETE ON broker_credential_audit_log
FOR EACH ROW EXECUTE FUNCTION deny_credential_audit_mutation();

COMMIT;
