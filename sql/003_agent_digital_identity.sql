BEGIN;

-- 1. Create agent_public_profiles
CREATE TABLE agent_public_profiles (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  public_brand_name text NOT NULL,
  public_display_name text NOT NULL,
  public_description text,
  default_language text NOT NULL DEFAULT 'en',
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_profile_status CHECK (status IN ('draft', 'active', 'suspended'))
);

-- 2. Create agent_email_connections
CREATE TABLE agent_email_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  email_address text NOT NULL,
  provider text NOT NULL,
  secret_locator text,
  connection_status text NOT NULL,
  token_expires_at timestamptz,
  reauthentication_required boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_email_connection_status CHECK (connection_status IN ('unconfigured', 'connected', 'expired', 'disconnected')),
  CONSTRAINT email_secret_locator_required CHECK (connection_status = 'unconfigured' OR secret_locator IS NOT NULL),
  CONSTRAINT email_token_expiry_valid CHECK (token_expires_at IS NULL OR (token_expires_at >= created_at))
);

-- 3. Create agent_social_accounts
CREATE TABLE agent_social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform text NOT NULL,
  public_account_name text NOT NULL,
  external_account_id text NOT NULL,
  public_profile_url text,
  secret_locator text,
  connection_status text NOT NULL,
  oauth_scopes text[] NOT NULL DEFAULT '{}',
  token_expires_at timestamptz,
  reauthentication_required boolean NOT NULL DEFAULT false,
  is_primary boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_social_platform CHECK (platform IN ('youtube', 'instagram', 'facebook', 'snapchat')),
  CONSTRAINT valid_social_connection_status CHECK (connection_status IN ('unconfigured', 'connected', 'expired', 'disconnected')),
  CONSTRAINT social_secret_locator_required CHECK (connection_status = 'unconfigured' OR secret_locator IS NOT NULL),
  CONSTRAINT social_token_expiry_valid CHECK (token_expires_at IS NULL OR (token_expires_at >= created_at)),
  CONSTRAINT unique_external_account_per_platform UNIQUE (platform, external_account_id)
);

-- Concurrency-safe partial unique index to allow only one primary social account per agent/platform
CREATE UNIQUE INDEX agent_social_accounts_primary_idx
  ON agent_social_accounts (agent_id, platform)
  WHERE (is_primary = true);

-- 4. Extend credential_refs table
ALTER TABLE credential_refs
  ADD COLUMN rotation_status text NOT NULL DEFAULT 'stable',
  ADD COLUMN last_verified_at timestamptz,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN reauthentication_required boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_reason text,
  ADD CONSTRAINT valid_rotation_status CHECK (rotation_status IN ('stable', 'rotating', 'failed_rotation')),
  ADD CONSTRAINT credential_token_expiry_valid CHECK (expires_at IS NULL OR (expires_at >= created_at));

-- 5. Updated-at trigger function and triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_agent_public_profiles_updated_at
  BEFORE UPDATE ON agent_public_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agent_email_connections_updated_at
  BEFORE UPDATE ON agent_email_connections
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agent_social_accounts_updated_at
  BEFORE UPDATE ON agent_social_accounts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMIT;
