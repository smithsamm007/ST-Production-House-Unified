-- SQL Seed Migration: 006_seed_initial_creative_charters.sql
-- Idempotent upserts for initial active Creative Charters (JARVIS & LAKME).
--
-- This migration provides an explicit, documented seeding procedure:
--
--   CALL seed_initial_creative_charters('your-authenticated-owner-uuid');
--
-- If no explicit owner ID is supplied, the procedure fails safely.

CREATE OR REPLACE PROCEDURE seed_initial_creative_charters(p_owner_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_jarvis_charter_id uuid := '8114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_lakme_charter_id  uuid := '8114f6d3-2b06-480d-ae81-e104de5f34c3';
  v_j_version_id      uuid := '9114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_l_version_id      uuid := '9114f6d3-2b06-480d-ae81-e104de5f34c3';
  v_j_universe_id     uuid;
  v_l_universe_id     uuid;
  v_j_approval_id     uuid := 'b114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_l_approval_id     uuid := 'b114f6d3-2b06-480d-ae81-e104de5f34c3';
  v_j_assignment_id   uuid := 'c114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_l_assignment_id   uuid := 'c114f6d3-2b06-480d-ae81-e104de5f34c3';

  -- Genuine computed snapshot hashes matching stable serializations
  v_j_hash            char(64) := 'de4fe123a0453899e35661debf8f22278be203dc26c500cdb019127f2edc3092';
  v_l_hash            char(64) := 'cea206577342ac7a633e0f91736d33b68513491556cc5dbb392672e169bd3a46';
BEGIN
  IF p_owner_id IS NULL THEN
    RAISE EXCEPTION 'EXPLICIT_OWNER_ID_REQUIRED_FOR_SEED_INITIALIZATION';
  END IF;

  -- 1. Idempotently upsert JARVIS Universe and resolve its actual ID by stable natural key (name)
  INSERT INTO creative_universes (name, universe_type, bible) VALUES
    ('JARVIS Horror Cinematic Universe', 'Hindi/Hinglish Horror', '{"vision": "Spooky connected horror"}')
  ON CONFLICT (name) DO UPDATE SET universe_type = EXCLUDED.universe_type
  RETURNING id INTO v_j_universe_id;

  -- 2. Idempotently upsert LAKME Universe and resolve its actual ID by stable natural key (name)
  INSERT INTO creative_universes (name, universe_type, bible) VALUES
    ('LAKME Mythology Universe', 'Hindu Mythology', '{"narrator": "Samay (Time)"}')
  ON CONFLICT (name) DO UPDATE SET universe_type = EXCLUDED.universe_type
  RETURNING id INTO v_l_universe_id;

  -- 3. Idempotently upsert Creative Charters
  INSERT INTO creative_charters (id, owner_id, name, vision, default_language, secondary_language, status) VALUES
    (v_jarvis_charter_id, p_owner_id, 'JARVIS Show Charter', 'A connected, long-running cinematic universe designed to produce stories and episodes for many years.', 'Hindi', 'Hinglish', 'active'),
    (v_lakme_charter_id, p_owner_id, 'LAKME Mythology Charter', 'Respectful treatment of Hindu traditions presenting timeline of cosmic and historical events.', 'Hindi', NULL, 'active')
  ON CONFLICT (id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    name = EXCLUDED.name,
    vision = EXCLUDED.vision,
    default_language = EXCLUDED.default_language,
    secondary_language = EXCLUDED.secondary_language,
    status = EXCLUDED.status;

  -- 4. Idempotently upsert Charter Versions
  -- Stable snapshot JSON representations must match exactly what computeSnapshotHash serializes
  INSERT INTO creative_charter_versions (id, charter_id, version_no, snapshot, snapshot_hash, is_active) VALUES
    (v_j_version_id, v_jarvis_charter_id, 1, '{"genresAndThemes":["horror","suspense","thriller","supernatural mystery","curses","crime","emotion","entertainment"],"universeBible":{"recurringCharacters":[],"supernaturalEntities":[],"cursedObjects":[],"curseRules":[],"organizations":[],"historicalEvents":[],"storyArcs":[],"episodeContinuity":[],"universeTimeline":[],"characterRelationships":[],"crossovers":[],"callbacks":[],"unresolvedMysteries":[],"postCreditContinuity":[],"canonAndNonCanon":[]},"universeType":"Hindi/Hinglish Horror Cinematic Universe"}', v_j_hash, true),
    (v_l_version_id, v_lakme_charter_id, 1, '{"claimSafetyClassifications":{"directlySupported":"directly supported by a cited source","dramatizedConnective":"dramatized connective material","interpretation":"scholarly or narrative interpretation","ownerApprovedFictional":"owner-approved fictionalization","traditionalVersion":"traditional or regional version"},"narrator":{"concept":"Samay narrates events according to their position in the cosmic and historical timeline.","identity":"Samay (Time)"},"sacredTerminology":"Sanskrit with Hindi explanations.","sourceCategories":["Vedas","Puranas","Upanishads","Ramayana","Mahabharata"],"universeType":"Hindu Mythology Universe"}', v_l_hash, true)
  ON CONFLICT (id) DO UPDATE SET
    snapshot = EXCLUDED.snapshot,
    snapshot_hash = EXCLUDED.snapshot_hash,
    is_active = EXCLUDED.is_active;

  -- 5. Idempotently upsert Owner Approvals
  INSERT INTO owner_charter_approvals (id, charter_version_id, snapshot_hash, assigned_agent_id, assigned_universe_id, owner_id) VALUES
    (v_j_approval_id, v_j_version_id, v_j_hash, 'agent-01', v_j_universe_id, p_owner_id),
    (v_l_approval_id, v_l_version_id, v_l_hash, 'agent-03', v_l_universe_id, p_owner_id)
  ON CONFLICT (id) DO UPDATE SET
    snapshot_hash = EXCLUDED.snapshot_hash,
    assigned_agent_id = EXCLUDED.assigned_agent_id,
    assigned_universe_id = EXCLUDED.assigned_universe_id,
    owner_id = EXCLUDED.owner_id;

  -- 6. Idempotently upsert Assignments
  INSERT INTO agent_charter_assignments (id, agent_id, charter_id, universe_id, is_active) VALUES
    (v_j_assignment_id, 'agent-01', v_jarvis_charter_id, v_j_universe_id, true),
    (v_l_assignment_id, 'agent-03', v_lakme_charter_id, v_l_universe_id, true)
  ON CONFLICT (id) DO UPDATE SET
    agent_id = EXCLUDED.agent_id,
    charter_id = EXCLUDED.charter_id,
    universe_id = EXCLUDED.universe_id,
    is_active = EXCLUDED.is_active;

  RAISE NOTICE 'Deterministic seeding completed successfully for JARVIS and LAKME.';
END $$;
