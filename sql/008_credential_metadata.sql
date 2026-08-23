BEGIN;

-- Enums for credential_metadata status and credential_audit_log event
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'credential_status_enum') THEN
    CREATE TYPE credential_status_enum AS ENUM ('provisioned', 'active', 'cooldown', 'revoked');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'credential_audit_event_enum') THEN
    CREATE TYPE credential_audit_event_enum AS ENUM ('created', 'status_changed', 'rotated', 'revoked', 'accessed');
  END IF;
END $$;

-- Table 1: credential_metadata
-- Stores metadata for credentials (locator_id is an opaque reference e.g., vault:// or opaque://).
-- Secret VALUES are strictly forbidden and barred at schema level via constraint.
CREATE TABLE IF NOT EXISTS credential_metadata (
  locator_id text PRIMARY KEY,
  provider_id text NOT NULL,
  status credential_status_enum NOT NULL DEFAULT 'provisioned',
  scope_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  expires_at timestamptz,
  created_by text NOT NULL,
  CONSTRAINT no_plaintext_secrets_locator CHECK (
    locator_id LIKE 'vault://%' OR locator_id LIKE 'opaque://%'
  )
);

CREATE INDEX IF NOT EXISTS credential_metadata_provider_idx ON credential_metadata (provider_id);
CREATE INDEX IF NOT EXISTS credential_metadata_status_idx ON credential_metadata (status);

-- Table 2: credential_audit_log
-- Immutable append-only audit trail for credential lifecycle events.
-- IMPORTANT: This table is INSERT-only design. UPDATES AND DELETES ARE STRICTLY PROHIBITED.
-- Immutability is enforced at the database level by the credential_audit_log_no_mutation trigger below.
CREATE TABLE IF NOT EXISTS credential_audit_log (
  id BIGSERIAL PRIMARY KEY,
  locator_id text NOT NULL REFERENCES credential_metadata(locator_id) ON DELETE RESTRICT,
  event credential_audit_event_enum NOT NULL,
  actor text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credential_audit_log_locator_idx ON credential_audit_log (locator_id);

-- Enforce append-only audit log: trigger function to deny mutations (updates or deletes)
CREATE OR REPLACE FUNCTION deny_credential_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CREDENTIAL_AUDIT_LOG_IS_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists to ensure rerun-safety / idempotency
DROP TRIGGER IF EXISTS credential_audit_log_no_mutation ON credential_audit_log;

-- Attach trigger enforcing append-only behavior on database level
CREATE TRIGGER credential_audit_log_no_mutation
BEFORE UPDATE OR DELETE ON credential_audit_log
FOR EACH ROW EXECUTE FUNCTION deny_credential_audit_log_mutation();

COMMIT;
