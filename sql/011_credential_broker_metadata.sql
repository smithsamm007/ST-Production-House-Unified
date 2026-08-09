BEGIN;

-- Create broker_credential_metadata table if not exists
CREATE TABLE IF NOT EXISTS broker_credential_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  capability text NOT NULL,
  secret_locator text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  rotation_status text NOT NULL DEFAULT 'stable' CHECK (rotation_status IN ('stable', 'rotating', 'failed_rotation')),
  expires_at timestamptz,
  last_health_status text NOT NULL DEFAULT 'healthy',
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Unique constraint for owner/agent/provider/capability/locator configuration
  UNIQUE (owner_id, agent_id, provider, capability, secret_locator),
  -- Prevent plaintext secrets: must start with safe prefix like 'vault://' or 'opaque://'
  CONSTRAINT no_plaintext_secrets_locator CHECK (
    secret_locator LIKE 'vault://%' OR secret_locator LIKE 'opaque://%'
  ),
  -- Length and value validations
  CONSTRAINT valid_provider_len CHECK (char_length(provider) BETWEEN 1 AND 100),
  CONSTRAINT valid_capability_len CHECK (char_length(capability) BETWEEN 1 AND 100),
  CONSTRAINT valid_last_health CHECK (last_health_status IN ('healthy', 'unhealthy', 'degraded'))
);

-- Optimize queries with indexes for fast query performance and isolation
CREATE INDEX IF NOT EXISTS broker_credential_metadata_owner_agent_idx ON broker_credential_metadata (owner_id, agent_id);

-- Create broker_credential_audit_log table if not exists
-- Standard referential integrity enforced using non-cascading ON DELETE RESTRICT (point 1)
CREATE TABLE IF NOT EXISTS broker_credential_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES broker_credential_metadata(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  action text NOT NULL,
  performed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  error_message text,
  client_ip text,
  user_agent text,
  -- Length and value validations
  CONSTRAINT valid_action_len CHECK (char_length(action) BETWEEN 1 AND 100),
  CONSTRAINT valid_status_len CHECK (char_length(status) BETWEEN 1 AND 100),
  CONSTRAINT valid_client_ip CHECK (char_length(client_ip) <= 45),
  CONSTRAINT valid_user_agent CHECK (char_length(user_agent) <= 500)
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
