BEGIN;

-- Extend existing owners table or define authentication fields directly
ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'anonymous' CHECK (status IN ('anonymous', 'password_verified_mfa_pending', 'authenticated', 'locked', 'disabled', 'expired', 'revoked')),
  ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lockout_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS session_revocation_epoch integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 1. owner_sessions
CREATE TABLE owner_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE, -- SHA-256 hash of random session token
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  mfa_assurance_level text NOT NULL CHECK (mfa_assurance_level IN ('password_only', 'high_assurance')),
  user_agent_hash char(64),
  ip_metadata text,
  CONSTRAINT expiry_ordering CHECK (absolute_expires_at > created_at AND idle_expires_at > created_at)
);

-- Index for session lookups and expired cleanup (Canonical, compliant with non-immutable functions restriction)
CREATE INDEX owner_sessions_active_idx ON owner_sessions (token_hash, idle_expires_at, absolute_expires_at) WHERE (revoked_at IS NULL);

-- 2. owner_mfa_methods / owner_totp_enrollments
CREATE TABLE owner_totp_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  encrypted_totp_secret text NOT NULL, -- Encrypted or opaque KMS secret locator
  is_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. owner_recovery_codes (stored as SHA-256 hashes only)
CREATE TABLE owner_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL UNIQUE, -- SHA-256
  is_used boolean NOT NULL DEFAULT false,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. owner_passkey_credentials (WebAuthn Web tokens)
CREATE TABLE owner_passkey_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  sign_counter integer NOT NULL DEFAULT 0 CHECK (sign_counter >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 5. authentication_challenges (for anti-replay and expiration checks)
CREATE TABLE authentication_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  is_used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenge_not_expired CHECK (expires_at > created_at)
);

-- 6. csrf_session_tokens (anti-CSRF server binding)
CREATE TABLE csrf_session_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES owner_sessions(id) ON DELETE CASCADE,
  token_value char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 7. authentication_audit_events (append-only immutable security ledger)
CREATE TABLE authentication_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- Enforce immutability on audit records
CREATE OR REPLACE FUNCTION deny_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUTHENTICATION_AUDIT_EVENTS_ARE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_mutation
  BEFORE UPDATE OR DELETE ON authentication_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION deny_audit_mutation();

-- Trigger for automatic owners updated_at column
CREATE TRIGGER update_owners_updated_at BEFORE UPDATE ON owners FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
