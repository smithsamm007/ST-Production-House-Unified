-- 030_social_oauth_accounts.sql
--
-- Additive migration (R1: never edit applied migrations).
--
-- Generic, per-Director SOCIAL account-connection lifecycle. Issue #206 built
-- the YouTube-specific tables; this migration generalizes the SAME security
-- contract to every other supported social platform so a new Director gets the
-- reusable account-management functionality automatically and no platform is
-- structurally second-class:
--
--   - social_oauth_states: one row per "Connect <platform>" start. The state
--     token itself is 32 random bytes handed to the provider ONLY inside the
--     authorization URL; the database stores ONLY its SHA-256 hash (never the
--     plaintext). Every row is bound to (owner, director, provider,
--     redirect_uri) and expires; consumption is atomic and single-use
--     (conditional UPDATE with consumed_at IS NULL — replay matches no row).
--     PKCE needs no stored verifier: the code_verifier is DERIVED from the
--     state token at both start and callback (the callback receives the state
--     in plaintext), so no extra secret is persisted anywhere.
--   - social_director_accounts: one account per (owner, director, provider).
--     Persists ONLY safe, provider-returned identity (account id/name/handle),
--     the EXISTING connection-status enum values from sql/003
--     (unconfigured | connected | expired | disconnected — R5: no new states),
--     and the OPAQUE secret-manager locator for the OAuth tokens. Raw access
--     tokens, refresh tokens, client secrets, and authorization codes are
--     structurally unpersistable here (Rule 17 CHECK below).
--
-- Provider keys are restricted to the frozen governed SOCIAL set. A provider
-- whose official identity endpoint is not yet confirmed (bilibili) is still
-- listed so its status surface is honest, but the service refuses to mark it
-- connected — a CHECK cannot express that, so it is enforced in the service
-- with a stable code and documented in docs/publishing/SOCIAL_ACCOUNT_CONNECTIONS.md.
--
-- PG15-compatible. No triggers/functions: every statement stays inside the SQL
-- subset shared with the labeled demo adapter (single-table DDL/DML,
-- parameterized predicates, inlined integer LIMITs, RETURNING *).
-- All statements are idempotent (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS social_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hex of the state token. The plaintext state never touches the DB.
  state_hash text NOT NULL UNIQUE
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_key text NOT NULL
    CHECK (provider_key IN ('facebook', 'instagram', 'snapchat', 'bilibili')),
  -- Server-controlled, HTTPS-only redirect URI captured at start time so the
  -- callback validates against the exact value used for the authorization
  -- request (never client-controlled, never http).
  redirect_uri text NOT NULL CHECK (redirect_uri LIKE 'https://%'),
  -- PKCE: the code_verifier is derived from the state token, never stored. The
  -- challenge method is recorded so the callback rebuilds the same verifier.
  code_challenge_method text
    CHECK (code_challenge_method IS NULL OR code_challenge_method IN ('S256')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Atomic single-use marker: the claiming UPDATE matches
  -- consumed_at IS NULL, so exactly one callback can consume a state.
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS social_oauth_states_owner_agent_idx
  ON social_oauth_states (owner_id, agent_id, provider_key, created_at);

CREATE TABLE IF NOT EXISTS social_director_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_key text NOT NULL
    CHECK (provider_key IN ('facebook', 'instagram', 'snapchat', 'bilibili')),
  -- EXISTING status values (sql/003 agent_social_accounts.connection_status):
  -- no new enum states (R5). A missing row means "unconfigured".
  status text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('unconfigured', 'connected', 'expired', 'disconnected')),
  -- Safe public account identity returned by the official provider API.
  account_id text CHECK (account_id IS NULL OR char_length(account_id) <= 128),
  account_name text CHECK (account_name IS NULL OR char_length(account_name) <= 200),
  account_handle text CHECK (account_handle IS NULL OR char_length(account_handle) <= 120),
  -- Requested/granted OAuth scope strings (not secret material).
  oauth_scope text CHECK (oauth_scope IS NULL OR char_length(oauth_scope) <= 1000),
  -- Opaque locator for the token bundle in the EXTERNAL secret manager.
  -- Raw tokens are structurally unpersistable (Rule 17 CHECK below).
  token_locator text
    CHECK (token_locator IS NULL OR token_locator LIKE 'vault://%' OR token_locator LIKE 'opaque://%'),
  token_expires_at timestamptz,
  verified_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, provider_key)
);

CREATE INDEX IF NOT EXISTS social_director_accounts_owner_agent_idx
  ON social_director_accounts (owner_id, agent_id);
