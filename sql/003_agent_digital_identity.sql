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
  email_address text,
  provider text,
  secret_locator text,
  connection_status text NOT NULL,
  token_expires_at timestamptz,
  reauthentication_required boolean NOT NULL DEFAULT false,
  is_primary boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_email_connection_status CHECK (connection_status IN ('unconfigured', 'connected', 'expired', 'disconnected')),

  -- State consistency for email connections
  CONSTRAINT email_connection_state_check CHECK (
    (connection_status = 'unconfigured' AND email_address IS NULL AND provider IS NULL AND secret_locator IS NULL)
    OR
    (connection_status = 'connected' AND email_address IS NOT NULL AND provider IS NOT NULL AND secret_locator IS NOT NULL)
    OR
    (connection_status IN ('expired', 'disconnected') AND email_address IS NOT NULL AND provider IS NOT NULL)
  ),

  CONSTRAINT email_token_expiry_consistency CHECK (
    (connection_status <> 'expired') OR (reauthentication_required = true)
  )
);

-- Concurrency-safe partial unique index to allow only one primary operational email per agent
CREATE UNIQUE INDEX agent_email_connections_primary_idx
  ON agent_email_connections (agent_id)
  WHERE (is_primary = true);

-- Prevent same normalized email address from belonging to multiple agents once configured (case-insensitive)
CREATE UNIQUE INDEX agent_email_unique_address_idx
  ON agent_email_connections (lower(email_address))
  WHERE (email_address IS NOT NULL);

-- 3. Create agent_social_accounts
CREATE TABLE agent_social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform text NOT NULL,
  public_account_name text,
  external_account_id text,
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

  -- State consistency for social accounts
  CONSTRAINT social_connection_state_check CHECK (
    (connection_status = 'unconfigured' AND public_account_name IS NULL AND external_account_id IS NULL AND secret_locator IS NULL AND public_profile_url IS NULL)
    OR
    (connection_status = 'connected' AND public_account_name IS NOT NULL AND external_account_id IS NOT NULL AND secret_locator IS NOT NULL)
    OR
    (connection_status IN ('expired', 'disconnected') AND public_account_name IS NOT NULL AND external_account_id IS NOT NULL)
  ),

  CONSTRAINT social_token_expiry_consistency CHECK (
    (connection_status <> 'expired') OR (reauthentication_required = true)
  ),
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
  ADD CONSTRAINT valid_rotation_status CHECK (rotation_status IN ('stable', 'rotating', 'failed_rotation'));

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

-- 6. Seed unconfigured connection slots for all 20 agents
-- Seeding Email slots
INSERT INTO agent_email_connections (agent_id, connection_status, is_primary)
SELECT id, 'unconfigured', true FROM agents;

-- Seeding YouTube slots
INSERT INTO agent_social_accounts (agent_id, platform, connection_status, is_primary)
SELECT id, 'youtube', 'unconfigured', true FROM agents;

-- Seeding Instagram slots
INSERT INTO agent_social_accounts (agent_id, platform, connection_status, is_primary)
SELECT id, 'instagram', 'unconfigured', true FROM agents;

-- Seeding Facebook slots
INSERT INTO agent_social_accounts (agent_id, platform, connection_status, is_primary)
SELECT id, 'facebook', 'unconfigured', true FROM agents;

-- Seeding Snapchat slots
INSERT INTO agent_social_accounts (agent_id, platform, connection_status, is_primary)
SELECT id, 'snapchat', 'unconfigured', true FROM agents;

COMMIT;
