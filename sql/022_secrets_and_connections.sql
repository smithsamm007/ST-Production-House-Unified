-- 022_secrets_and_connections.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Secrets & Connections (owner-dashboard surface, per Director):
--   - director_connections: ONE connection per (owner, agent, provider_key,
--     kind). Directors never share credentials (Rule 5 isolation): every row
--     carries (owner_id, agent_id) and every read is scoped to both.
--   - director_connection_tests: append-only, honest test outcomes. A test
--     WITHOUT a live transport records `unverified` — never `success`
--     (AGENTS.md Rules 1–3). Rows are immutable (trigger blocks UPDATE/DELETE).
--
-- Secret-storage contract (Rule 17): `secret_fields` is a JSONB map of
-- field-key -> OPAQUE LOCATOR string. The locator shape (vault:// /
-- opaque:// prefixes) is enforced by the enforce_director_connection_
-- locator_shape() trigger below — plpgsql, PG15-compatible — so a plaintext
-- API key is structurally impossible to persist here. Non-secret
-- configuration lives separately in `config_fields` (displayable).
--
-- All statements are idempotent (IF NOT EXISTS / OR REPLACE). New closed
-- enums introduced by THIS migration only; existing status enums elsewhere
-- are untouched (R5).

CREATE TABLE IF NOT EXISTS director_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  kind text NOT NULL CHECK (kind IN ('llm', 'media', 'image', 'email', 'social')),
  status text NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured', 'configured', 'unverified', 'connection_failed')),
  credential_label text CHECK (char_length(credential_label) <= 120),
  -- field-key -> OPAQUE LOCATOR (vault:// or opaque://). Shape enforced by
  -- the locator trigger below; plaintext forbidden (Rule 17).
  secret_fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(secret_fields) = 'object'),
  -- non-secret configuration (model, region, channel id, username...).
  config_fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config_fields) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, provider_key, kind)
);

CREATE INDEX IF NOT EXISTS director_connections_owner_agent_idx
  ON director_connections (owner_id, agent_id);

-- Locator-shape enforcement (Rule 17): a subquery cannot live in a CHECK
-- constraint, so the per-value vault:// / opaque:// rule runs in this
-- BEFORE trigger. The repository re-validates before every write (defense
-- in depth); this makes plaintext unpersistable from ANY client.
CREATE OR REPLACE FUNCTION enforce_director_connection_locator_shape() RETURNS trigger AS $$
DECLARE
  pair record;
BEGIN
  IF NEW.secret_fields = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  FOR pair IN SELECT key, value FROM jsonb_each_text(NEW.secret_fields) LOOP
    IF pair.value NOT LIKE 'vault://%' AND pair.value NOT LIKE 'opaque://%' THEN
      RAISE EXCEPTION 'PLAINTEXT_SECRET_REJECTED: secret_fields values must be opaque locators (vault:// or opaque://)';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS director_connections_locator_shape ON director_connections;
CREATE TRIGGER director_connections_locator_shape
  BEFORE INSERT OR UPDATE ON director_connections
  FOR EACH ROW EXECUTE FUNCTION enforce_director_connection_locator_shape();

CREATE TABLE IF NOT EXISTS director_connection_tests (
  id bigserial PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES director_connections(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failed', 'unverified')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS director_connection_tests_connection_idx
  ON director_connection_tests (connection_id, id DESC);

-- Enforce append-only test history: mutation-blocking trigger.
CREATE OR REPLACE FUNCTION deny_director_connection_test_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: director_connection_tests rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS director_connection_tests_append_only ON director_connection_tests;
CREATE TRIGGER director_connection_tests_append_only
  BEFORE UPDATE OR DELETE ON director_connection_tests
  FOR EACH ROW EXECUTE FUNCTION deny_director_connection_test_mutation();
