-- SQL Seed Migration: 006_seed_initial_creative_charters.sql
-- Idempotent upserts for initial active Creative Charters (JARVIS & LAKME).
-- Requires at least one owner row to exist in 'owners' table to bind the charters safely.

DO $$
DECLARE
  v_owner_id uuid;
  v_jarvis_charter_id uuid := '8114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_lakme_charter_id  uuid := '8114f6d3-2b06-480d-ae81-e104de5f34c3';
  v_j_version_id      uuid := '9114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_l_version_id      uuid := '9114f6d3-2b06-480d-ae81-e104de5f34c3';
  v_j_universe_id     uuid := 'a114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_l_universe_id     uuid := 'a114f6d3-2b06-480d-ae81-e104de5f34c3';
  v_j_approval_id     uuid := 'b114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_l_approval_id     uuid := 'b114f6d3-2b06-480d-ae81-e104de5f34c3';
  v_j_assignment_id   uuid := 'c114f6d3-2b06-480d-ae81-e104de5f34c1';
  v_l_assignment_id   uuid := 'c114f6d3-2b06-480d-ae81-e104de5f34c3';
BEGIN
  -- 1. Safely resolve the first available owner from 'owners' table
  SELECT id INTO v_owner_id FROM owners LIMIT 1;

  IF v_owner_id IS NULL THEN
    RAISE NOTICE 'No owner found in the database. Seeding initial creative charters is deferred until at least one owner account exists.';
    RETURN;
  END IF;

  -- 2. Seed Creative Universes
  INSERT INTO creative_universes (id, name, universe_type, bible) VALUES
    (v_j_universe_id, 'JARVIS Horror Cinematic Universe', 'Hindi/Hinglish Horror', '{"vision": "Spooky folk horror"}'),
    (v_l_universe_id, 'LAKME Mythology Universe', 'Hindu Mythology', '{"narrator": "Samay (Time)"}')
  ON CONFLICT (name) DO NOTHING;

  -- 3. Seed Creative Charters
  INSERT INTO creative_charters (id, owner_id, name, vision, default_language, secondary_language, status) VALUES
    (v_jarvis_charter_id, v_owner_id, 'JARVIS Show Charter', 'A connected, long-running cinematic universe designed to produce stories and episodes for many years.', 'Hindi', 'Hinglish', 'active'),
    (v_lakme_charter_id, v_owner_id, 'LAKME Mythology Charter', 'Respectful treatment of Hindu traditions presenting timeline of cosmic and historical events.', 'Hindi', NULL, 'active')
  ON CONFLICT (id) DO NOTHING;

  -- 4. Seed Charter Versions
  INSERT INTO creative_charter_versions (id, charter_id, version_no, snapshot, snapshot_hash, is_active) VALUES
    (v_j_version_id, v_jarvis_charter_id, 1, '{"universeType": "Hindi/Hinglish Horror Cinematic Universe"}', 'aaba0fea69f026408888d1533f1e57b36de0e2c8aaba0fea69f026408888d153', true),
    (v_l_version_id, v_lakme_charter_id, 1, '{"universeType": "Hindu Mythology Universe", "narrator": {"identity": "Samay (Time)"}}', 'b23f289b23f289b23f289b23f289b23f289b23f289b23f289b23f289b23f289a', true)
  ON CONFLICT (id) DO NOTHING;

  -- 5. Seed Owner Approvals
  INSERT INTO owner_charter_approvals (id, charter_version_id, snapshot_hash, assigned_agent_id, assigned_universe_id, owner_id) VALUES
    (v_j_approval_id, v_j_version_id, 'aaba0fea69f026408888d1533f1e57b36de0e2c8aaba0fea69f026408888d153', 'agent-01', v_j_universe_id, v_owner_id),
    (v_l_approval_id, v_l_version_id, 'b23f289b23f289b23f289b23f289b23f289b23f289b23f289b23f289b23f289a', 'agent-03', v_l_universe_id, v_owner_id)
  ON CONFLICT (id) DO NOTHING;

  -- 6. Seed Assignments
  INSERT INTO agent_charter_assignments (id, agent_id, charter_id, universe_id, is_active) VALUES
    (v_j_assignment_id, 'agent-01', v_jarvis_charter_id, v_j_universe_id, true),
    (v_l_assignment_id, 'agent-03', v_lakme_charter_id, v_l_universe_id, true)
  ON CONFLICT (id) DO NOTHING;

  RAISE NOTICE 'Idempotent Creative Charter seeds successfully populated for JARVIS and LAKME.';
END $$;
