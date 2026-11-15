BEGIN;
-- 034 — canonical Director seed with a SAFE lifecycle classification.
--
-- Resolves defect D-1: the earlier draft seeded all ten mappings as `retired`,
-- and sql/032 refuses new work for any Director whose mapping is not `active`,
-- so the four ALREADY-OPERATIONAL preserved Directors would have been silently
-- disabled by seeding alone.
--
-- Classification used here (derived from the repository, not invented):
--
--   preserved operational Directors -> status 'active'
--     JARVIS (agent-01), SHERLOCK (agent-02), LAKME (agent-03), NEWTON (agent-21)
--     These are the Directors that are operational today. Seeding them as
--     `active` preserves the status quo; it activates nobody new.
--
--   new canonical Directors -> status 'suspended' + PENDING_OWNER_ACTIVATION
--     COSMOS, AADI, CHRONOS, AI NEWS, TECH MASTER, BUTTERFLY
--     They exist in the registry but may not originate work until the Owner
--     activates them through the cap-locked repository path. No migration ever
--     activates a new Director.
--
-- Lifecycle vocabulary (see docs/directors/DIRECTOR_LIFECYCLE.md):
--   active                         -> may originate new work
--   suspended + PENDING_OWNER_ACTIVATION -> pending activation (blocked)
--   suspended                      -> temporarily paused (blocked)
--   retired                        -> permanently retired (blocked)
--
-- Idempotency: inserts happen only when the row is missing (NOT EXISTS), so a
-- re-run never changes an approved lifecycle state and never duplicates a row.

-- sql/032 guards jobs, director_schedules, director_connections and both OAuth
-- state tables. It never covered channels or promo_campaigns, so a seeded but
-- unactivated Director could still originate those rows. Close that gap here
-- (additively: 032 itself is never modified or replaced), using the same
-- "governed non-active => refuse" rule and the same public error code.
CREATE OR REPLACE FUNCTION enforce_canonical_director_active_origin(p_agent_id text) RETURNS void AS $$
DECLARE v_status canonical_director_status;
BEGIN
  IF p_agent_id IS NULL THEN RETURN; END IF;
  SELECT status INTO v_status FROM canonical_director_mappings WHERE underlying_agent_id = p_agent_id;
  IF v_status IS NOT NULL AND v_status <> 'active' THEN
    RAISE EXCEPTION 'CANONICAL_DIRECTOR_NOT_ACTIVE';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION canonical_director_guard_channels() RETURNS trigger AS $$
BEGIN PERFORM enforce_canonical_director_active_origin(NEW.agent_id); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS canonical_director_guard_channels ON channels;
CREATE TRIGGER canonical_director_guard_channels BEFORE INSERT ON channels
  FOR EACH ROW EXECUTE FUNCTION canonical_director_guard_channels();

CREATE OR REPLACE FUNCTION canonical_director_guard_promo_campaigns() RETURNS trigger AS $$
BEGIN PERFORM enforce_canonical_director_active_origin(NEW.owner_agent_id); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS canonical_director_guard_promo_campaigns ON promo_campaigns;
CREATE TRIGGER canonical_director_guard_promo_campaigns BEFORE INSERT ON promo_campaigns
  FOR EACH ROW EXECUTE FUNCTION canonical_director_guard_promo_campaigns();

-- Seeding uses literal VALUES: the same migration must execute on PostgreSQL and
-- on the demo storage adapter. ON CONFLICT DO NOTHING makes re-runs no-ops, so an
-- approved lifecycle state is never rewritten by re-applying this migration.
INSERT INTO agents (id, name, namespace)
  VALUES
    ('agent-director-cosmos', 'COSMOS', 'st.agent.cosmos'),
    ('agent-director-aadi', 'AADI', 'st.agent.aadi'),
    ('agent-director-chronos', 'CHRONOS', 'st.agent.chronos'),
    ('agent-director-ai-news', 'AI NEWS', 'st.agent.ai-news'),
    ('agent-director-tech-master', 'TECH MASTER', 'st.agent.tech-master'),
    ('agent-director-butterfly', 'BUTTERFLY', 'st.agent.butterfly')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO canonical_director_mappings
  (canonical_director_code, underlying_agent_id, display_name, namespace,
   status, retired_at, retired_reason, suspended_note)
  VALUES
    ('JARVIS', 'agent-01', 'JARVIS', 'st.agent.jarvis', 'active', NULL, NULL, NULL),
    ('SHERLOCK', 'agent-02', 'SHERLOCK', 'st.agent.sherlock', 'active', NULL, NULL, NULL),
    ('LAKME', 'agent-03', 'LAKME', 'st.agent.lakme', 'active', NULL, NULL, NULL),
    ('NEWTON', 'agent-21', 'NEWTON', 'st.agent.newton', 'active', NULL, NULL, NULL),
    ('COSMOS', 'agent-director-cosmos', 'COSMOS', 'st.agent.cosmos', 'suspended', NULL, NULL, 'PENDING_OWNER_ACTIVATION'),
    ('AADI', 'agent-director-aadi', 'AADI', 'st.agent.aadi', 'suspended', NULL, NULL, 'PENDING_OWNER_ACTIVATION'),
    ('CHRONOS', 'agent-director-chronos', 'CHRONOS', 'st.agent.chronos', 'suspended', NULL, NULL, 'PENDING_OWNER_ACTIVATION'),
    ('AI NEWS', 'agent-director-ai-news', 'AI NEWS', 'st.agent.ai-news', 'suspended', NULL, NULL, 'PENDING_OWNER_ACTIVATION'),
    ('TECH MASTER', 'agent-director-tech-master', 'TECH MASTER', 'st.agent.tech-master', 'suspended', NULL, NULL, 'PENDING_OWNER_ACTIVATION'),
    ('BUTTERFLY', 'agent-director-butterfly', 'BUTTERFLY', 'st.agent.butterfly', 'suspended', NULL, NULL, 'PENDING_OWNER_ACTIVATION')
  ON CONFLICT (canonical_director_code) DO NOTHING;

COMMIT;
