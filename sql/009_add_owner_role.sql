BEGIN;

-- Task 2 security evolution. Migrations 001-008 remain immutable.
ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner',
  ADD CONSTRAINT owners_role_allowed CHECK (role IN ('owner', 'operator', 'viewer'));

ALTER TABLE owner_totp_enrollments
  ADD COLUMN IF NOT EXISTS last_used_step bigint,
  ADD CONSTRAINT totp_last_used_step_nonnegative CHECK (last_used_step IS NULL OR last_used_step >= 0);

-- Migration 008 called this column token_value. It always contained a SHA-256
-- digest after Task 2; rename it so the database contract cannot imply plaintext.
ALTER TABLE csrf_session_tokens RENAME COLUMN token_value TO token_hash;
ALTER TABLE csrf_session_tokens
  ADD CONSTRAINT csrf_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX csrf_one_token_per_session ON csrf_session_tokens (session_id);

CREATE OR REPLACE FUNCTION revoke_session_csrf_token() RETURNS trigger AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    DELETE FROM csrf_session_tokens WHERE session_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER owner_session_csrf_revocation
  AFTER UPDATE OF revoked_at ON owner_sessions
  FOR EACH ROW EXECUTE FUNCTION revoke_session_csrf_token();

CREATE INDEX owner_totp_confirmed_owner_idx
  ON owner_totp_enrollments (owner_id)
  WHERE is_confirmed = true;

COMMIT;
