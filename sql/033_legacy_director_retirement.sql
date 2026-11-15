BEGIN;
-- 033 — legacy Director retirement.
--
-- The 17 historical identities (agent-04 .. agent-20) keep every historical row
-- they own but may not originate NEW work. No agents row is deleted, renamed or
-- disabled; retirement is an additive row plus insertion guards, matching the
-- way sql/032 expresses canonical retirement.
--
-- Guarded new-work origins (7):
--   jobs                      INSERT
--   director_schedules        INSERT/UPDATE (only while schedule_enabled)
--   director_connections      INSERT/UPDATE
--   channels                  INSERT
--   promo_campaigns           INSERT
--   youtube_oauth_states      INSERT
--   social_oauth_states       INSERT
--
-- Deliberately NOT guarded: SELECT and UPDATE of existing rows. Retirement is a
-- new-work gate, never a freeze or a destructive operation; in-flight work may
-- complete, be retried or be dead-lettered exactly as before.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS / ON CONFLICT DO NOTHING, so re-running boot semantics hold.

CREATE TABLE IF NOT EXISTS director_legacy_retirements (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE RESTRICT,
  retired_at timestamptz NOT NULL DEFAULT now(),
  retired_reason text NOT NULL CHECK (char_length(retired_reason) BETWEEN 1 AND 500),
  retired_by text NOT NULL DEFAULT 'migration_033',
  canonical_successor_code text REFERENCES canonical_director_mappings(canonical_director_code),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION enforce_legacy_director_operational(p_agent_id text) RETURNS void AS $$
BEGIN
  IF p_agent_id IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM director_legacy_retirements WHERE agent_id = p_agent_id) THEN
    RAISE EXCEPTION 'LEGACY_DIRECTOR_RETIRED';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION legacy_director_guard_jobs() RETURNS trigger AS $$
BEGIN PERFORM enforce_legacy_director_operational(NEW.agent_id); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_director_guard_jobs ON jobs;
CREATE TRIGGER legacy_director_guard_jobs BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION legacy_director_guard_jobs();

CREATE OR REPLACE FUNCTION legacy_director_guard_director_schedules() RETURNS trigger AS $$
BEGIN
  IF NEW.schedule_enabled = true THEN PERFORM enforce_legacy_director_operational(NEW.agent_id); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_director_guard_director_schedules ON director_schedules;
CREATE TRIGGER legacy_director_guard_director_schedules BEFORE INSERT OR UPDATE ON director_schedules
  FOR EACH ROW EXECUTE FUNCTION legacy_director_guard_director_schedules();

CREATE OR REPLACE FUNCTION legacy_director_guard_director_connections() RETURNS trigger AS $$
BEGIN PERFORM enforce_legacy_director_operational(NEW.agent_id); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_director_guard_director_connections ON director_connections;
CREATE TRIGGER legacy_director_guard_director_connections BEFORE INSERT OR UPDATE ON director_connections
  FOR EACH ROW EXECUTE FUNCTION legacy_director_guard_director_connections();

CREATE OR REPLACE FUNCTION legacy_director_guard_channels() RETURNS trigger AS $$
BEGIN PERFORM enforce_legacy_director_operational(NEW.agent_id); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_director_guard_channels ON channels;
CREATE TRIGGER legacy_director_guard_channels BEFORE INSERT ON channels
  FOR EACH ROW EXECUTE FUNCTION legacy_director_guard_channels();

CREATE OR REPLACE FUNCTION legacy_director_guard_promo_campaigns() RETURNS trigger AS $$
BEGIN PERFORM enforce_legacy_director_operational(NEW.owner_agent_id); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_director_guard_promo_campaigns ON promo_campaigns;
CREATE TRIGGER legacy_director_guard_promo_campaigns BEFORE INSERT ON promo_campaigns
  FOR EACH ROW EXECUTE FUNCTION legacy_director_guard_promo_campaigns();

CREATE OR REPLACE FUNCTION legacy_director_guard_youtube_oauth_states() RETURNS trigger AS $$
BEGIN PERFORM enforce_legacy_director_operational(NEW.agent_id); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_director_guard_youtube_oauth_states ON youtube_oauth_states;
CREATE TRIGGER legacy_director_guard_youtube_oauth_states BEFORE INSERT ON youtube_oauth_states
  FOR EACH ROW EXECUTE FUNCTION legacy_director_guard_youtube_oauth_states();

CREATE OR REPLACE FUNCTION legacy_director_guard_social_oauth_states() RETURNS trigger AS $$
BEGIN PERFORM enforce_legacy_director_operational(NEW.agent_id); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_director_guard_social_oauth_states ON social_oauth_states;
CREATE TRIGGER legacy_director_guard_social_oauth_states BEFORE INSERT ON social_oauth_states
  FOR EACH ROW EXECUTE FUNCTION legacy_director_guard_social_oauth_states();

-- The 17 historical identities, listed literally so the same migration executes
-- on PostgreSQL and on the demo storage adapter. ON CONFLICT keeps re-runs safe.
INSERT INTO director_legacy_retirements (agent_id, retired_reason)
  VALUES
    ('agent-04', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-05', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-06', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-07', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-08', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-09', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-10', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-11', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-12', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-13', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-14', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-15', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-16', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-17', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-18', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-19', 'Retired by the canonical Director cutover: keeps history, may not originate new work'),
    ('agent-20', 'Retired by the canonical Director cutover: keeps history, may not originate new work')
  ON CONFLICT (agent_id) DO NOTHING;

COMMIT;
