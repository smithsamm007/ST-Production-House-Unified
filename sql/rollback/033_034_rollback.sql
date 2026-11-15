-- Reviewed ROLLBACK artefact for migrations 033 + 034.
--
-- This file is NOT a migration: it lives outside sql/'s numbered sequence on
-- purpose, so the migration linter never picks it up. It is run only by an
-- authorised operator, against a database where 033/034 were applied.
--
-- What it restores
--   * removes the seven legacy retirement guards, their functions and the
--     retirement table (033)
--   * removes the ten canonical mappings and the six new agent rows (034)
--   * leaves every historical production row (jobs, releases, channels,
--     schedules, connections, OAuth states, campaigns, owners) untouched
--
-- What it does NOT restore
--   * it cannot restore lifecycle states changed by an operator after the
--     migration (activation, suspension, retirement of a canonical Director
--     performed later): those are business decisions, not migration state
--   * it does not undo anything a Director produced after the migration
--
-- Safety rules enforced by the script itself
--   1. Refuses if any of the six NEW canonical Directors has production
--      activity: rolling back 034 deletes their governance row, which would make
--      them ungoverned (able to originate work) — unsafe while data exists.
--   2. Refuses while any canonical mapping for the ten codes is not in the state
--      033/034 left it, unless the operator first re-runs it with
--      `SET LOCAL app.rollback_force = 'on'` (documented recovery path).
--   3. Never deletes rows from jobs, channels, releases or any evidence table.
--
-- Partial deployment: safe to run when 033 applied and 034 did not (and vice
-- versa) because every statement is guarded with IF EXISTS / NOT EXISTS.
-- Repeated rollback: idempotent; a second run is a no-op.
-- Rollback after activation: permitted only with app.rollback_force = 'on'.

BEGIN;

DO $$
DECLARE
  v_forced boolean := coalesce(current_setting('app.rollback_force', true), '') = 'on';
  v_activity integer;
  v_changed integer;
BEGIN
  -- 1. Refuse to remove governance from a Director that already produced work.
  SELECT count(*)::integer INTO v_activity
    FROM jobs
   WHERE agent_id IN ('agent-director-cosmos', 'agent-director-aadi', 'agent-director-chronos',
                      'agent-director-ai-news', 'agent-director-tech-master', 'agent-director-butterfly');
  IF v_activity > 0 AND NOT v_forced THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_NEW_DIRECTOR_HAS_JOB_HISTORY: % job row(s); set app.rollback_force = on after an owner-reviewed decision', v_activity;
  END IF;

  SELECT count(*)::integer INTO v_activity
    FROM channels
   WHERE agent_id LIKE 'agent-director-%';
  IF v_activity > 0 AND NOT v_forced THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_NEW_DIRECTOR_HAS_CHANNELS: % channel row(s)', v_activity;
  END IF;

  SELECT count(*)::integer INTO v_activity
    FROM director_schedules
   WHERE agent_id LIKE 'agent-director-%';
  IF v_activity > 0 AND NOT v_forced THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_NEW_DIRECTOR_HAS_SCHEDULE: % schedule row(s)', v_activity;
  END IF;

  -- 2. Refuse to silently discard lifecycle decisions made after the migration.
  SELECT count(*)::integer INTO v_changed
    FROM canonical_director_mappings
   WHERE (canonical_director_code IN ('JARVIS', 'SHERLOCK', 'LAKME', 'NEWTON')
          AND status <> 'active')
      OR (canonical_director_code IN ('COSMOS', 'AADI', 'CHRONOS', 'AI NEWS', 'TECH MASTER', 'BUTTERFLY')
          AND NOT (status = 'suspended' AND coalesce(suspended_note, '') = 'PENDING_OWNER_ACTIVATION'));
  IF v_changed > 0 AND NOT v_forced THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_LIFECYCLE_CHANGED_AFTER_MIGRATION: % mapping row(s) no longer match the seeded state; set app.rollback_force = on only after owner review', v_changed;
  END IF;
END $$;

-- 034: remove mappings first (FK), then the six agent rows (FK from mappings).
DELETE FROM canonical_director_mappings
 WHERE canonical_director_code IN
       ('JARVIS', 'SHERLOCK', 'LAKME', 'NEWTON', 'COSMOS', 'AADI', 'CHRONOS', 'AI NEWS', 'TECH MASTER', 'BUTTERFLY');

-- The six agent rows are removed only when nothing references them: a Director
-- that produced data keeps its row (rollback never deletes production data).
DELETE FROM agents a
 WHERE a.id IN ('agent-director-cosmos', 'agent-director-aadi', 'agent-director-chronos',
                'agent-director-ai-news', 'agent-director-tech-master', 'agent-director-butterfly')
   AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.agent_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.agent_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM director_schedules s WHERE s.agent_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM director_connections dc WHERE dc.agent_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM youtube_oauth_states y WHERE y.agent_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM social_oauth_states so WHERE so.agent_id = a.id);

-- 033: guards first, then the rows that feed them, then the table.
DROP TRIGGER IF EXISTS canonical_director_guard_channels ON channels;
DROP TRIGGER IF EXISTS canonical_director_guard_promo_campaigns ON promo_campaigns;
DROP FUNCTION IF EXISTS canonical_director_guard_channels();
DROP FUNCTION IF EXISTS canonical_director_guard_promo_campaigns();
DROP FUNCTION IF EXISTS enforce_canonical_director_active_origin(text);

DROP TRIGGER IF EXISTS legacy_director_guard_jobs ON jobs;
DROP TRIGGER IF EXISTS legacy_director_guard_director_schedules ON director_schedules;
DROP TRIGGER IF EXISTS legacy_director_guard_director_connections ON director_connections;
DROP TRIGGER IF EXISTS legacy_director_guard_channels ON channels;
DROP TRIGGER IF EXISTS legacy_director_guard_promo_campaigns ON promo_campaigns;
DROP TRIGGER IF EXISTS legacy_director_guard_youtube_oauth_states ON youtube_oauth_states;
DROP TRIGGER IF EXISTS legacy_director_guard_social_oauth_states ON social_oauth_states;

DROP FUNCTION IF EXISTS legacy_director_guard_jobs();
DROP FUNCTION IF EXISTS legacy_director_guard_director_schedules();
DROP FUNCTION IF EXISTS legacy_director_guard_director_connections();
DROP FUNCTION IF EXISTS legacy_director_guard_channels();
DROP FUNCTION IF EXISTS legacy_director_guard_promo_campaigns();
DROP FUNCTION IF EXISTS legacy_director_guard_youtube_oauth_states();
DROP FUNCTION IF EXISTS legacy_director_guard_social_oauth_states();
DROP FUNCTION IF EXISTS enforce_legacy_director_operational(text);

DELETE FROM director_legacy_retirements;
DROP TABLE IF EXISTS director_legacy_retirements;

COMMIT;
