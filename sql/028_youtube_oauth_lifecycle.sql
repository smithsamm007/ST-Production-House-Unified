-- 028_youtube_oauth_lifecycle.sql
--
-- Additive migration (R1: never edit applied migrations). Issue #206.
--
-- Owner-scoped YouTube OAuth lifecycle:
--   - youtube_oauth_states: one row per OAuth "Connect YouTube" start. The
--     state token itself is 32 random bytes handed to Google ONLY in the
--     authorization URL; the database stores ONLY its SHA-256 hash (never the
--     plaintext). Every row is bound to (owner, director, provider,
--     redirect_uri) and expires; consumption is atomic and single-use
--     (conditional UPDATE with consumed_at IS NULL — replay returns zero rows).
--   - youtube_director_accounts: one YouTube account per (owner, director).
--     Persists ONLY safe account identity (channel id/title/handle), the
--     EXISTING connection-status enum values from sql/003
--     (unconfigured | connected | expired | disconnected — R5: no new states),
--     and the OPAQUE secret-manager locator for the OAuth tokens. Raw access
--     tokens, refresh tokens, client secrets, and authorization codes are
--     structurally unpersistable here (Rule 17 CHECK below).
--
-- PG15-compatible. No triggers/functions: every statement stays inside the
-- SQL subset shared with the labeled demo adapter (single-table DDL/DML,
-- parameterized predicates, inlined integer LIMITs, RETURNING *).
-- All statements are idempotent (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS youtube_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hex of the state token. The plaintext state never touches the DB.
  state_hash text NOT NULL UNIQUE
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Issue #206 is the YouTube slice; binding is fixed by contract.
  provider_key text NOT NULL DEFAULT 'youtube' CHECK (provider_key = 'youtube'),
  -- Server-controlled, HTTPS-only redirect URI captured at start time so the
  -- callback validates against the exact value used for the authorization
  -- request (never client-controlled, never http).
  redirect_uri text NOT NULL CHECK (redirect_uri LIKE 'https://%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Atomic single-use marker: the claiming UPDATE matches
  -- consumed_at IS NULL, so exactly one callback can consume a state.
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS youtube_oauth_states_owner_agent_idx
  ON youtube_oauth_states (owner_id, agent_id, created_at);

CREATE TABLE IF NOT EXISTS youtube_director_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_key text NOT NULL DEFAULT 'youtube' CHECK (provider_key = 'youtube'),
  -- EXISTING status values (sql/003 agent_social_accounts.connection_status):
  -- no new enum states (R5). A missing row means "unconfigured".
  status text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('unconfigured', 'connected', 'expired', 'disconnected')),
  -- Safe public account identity returned by the official YouTube API.
  channel_id text CHECK (channel_id IS NULL OR char_length(channel_id) <= 64),
  channel_title text CHECK (channel_title IS NULL OR char_length(channel_title) <= 200),
  channel_handle text CHECK (channel_handle IS NULL OR char_length(channel_handle) <= 120),
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

CREATE INDEX IF NOT EXISTS youtube_director_accounts_owner_agent_idx
  ON youtube_director_accounts (owner_id, agent_id);
