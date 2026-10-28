-- SQL Migration: 018_newton_catalog_registration.sql
-- S-M02-01 — Additive registration of the NEWTON Director Agent (issue #131).
--
-- Contract (AGENTS.md R1, R5; issue #131 acceptance criteria):
--   * Additive only. Existing migrations (001-017) are never modified and
--     existing agent rows are never altered.
--   * Idempotent: safe on re-run (guarded upserts + slot-level NOT EXISTS).
--   * The 50-agent hard cap remains the database-level trigger
--     `agents_max_50` from sql/001_core.sql — no new cap logic is added and
--     none is weakened.
--   * NEWTON receives exactly the same per-agent connection-slot invariants
--     as every existing agent (migration 003 shape): one unconfigured primary
--     email slot, and one unconfigured primary social slot per supported
--     platform (youtube, instagram, facebook, snapchat). Slots are seeded
--     WITHOUT an external identity so they stay 'unconfigured' (Rule 16).
--   * No secrets, no credential locators, no public-facing brand text.
--     NEWTON is an internal-only identifier (Rule 15) until an owner
--     explicitly configures a public profile (agent_public_profiles).

BEGIN;

-- 1. Agent row (guarded upsert — mirrors migration 002's ON CONFLICT shape)
INSERT INTO agents (id, name, namespace)
VALUES ('agent-21', 'NEWTON', 'st.agent.newton')
ON CONFLICT (id) DO NOTHING;

-- 2. Fail-closed integrity guard: the registered row must match the canonical
--    identity exactly. If a conflicting row pre-existed under this id, the
--    migration aborts (transaction rollback) rather than silently adopting a
--    divergent identity.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agents
    WHERE id = 'agent-21'
      AND name = 'NEWTON'
      AND namespace = 'st.agent.newton'
  ) THEN
    RAISE EXCEPTION 'NEWTON_AGENT_IDENTITY_CONFLICT';
  END IF;
END $$;

-- 3. Connection slots — idempotent per-slot seeding (slot-level NOT EXISTS,
--    so re-runs and concurrent applications cannot create duplicates; the
--    primary-slot partial unique indexes from 003 remain the hard guard).
--    3a. One unconfigured primary email slot
INSERT INTO agent_email_connections (agent_id, connection_status, is_primary)
SELECT 'agent-21', 'unconfigured', true
WHERE NOT EXISTS (
  SELECT 1 FROM agent_email_connections WHERE agent_id = 'agent-21'
);

-- 3b. One unconfigured primary social slot per supported platform
INSERT INTO agent_social_accounts (agent_id, platform, connection_status, is_primary)
SELECT 'agent-21', p.platform, 'unconfigured', true
FROM (VALUES ('youtube'), ('instagram'), ('facebook'), ('snapchat')) AS p(platform)
WHERE NOT EXISTS (
  SELECT 1 FROM agent_social_accounts
  WHERE agent_id = 'agent-21' AND platform = p.platform
);

-- 4. Final in-migration assertion: NEWTON must exit with exactly the same
--    slot inventory as every existing agent (1 email + 4 social slots). If
--    any slot was not created, the migration fails loudly instead of leaving
--    a half-provisioned agent.
DO $$
DECLARE
  v_email_slots integer;
  v_social_slots integer;
BEGIN
  SELECT count(*) INTO v_email_slots
  FROM agent_email_connections WHERE agent_id = 'agent-21';

  SELECT count(*) INTO v_social_slots
  FROM agent_social_accounts WHERE agent_id = 'agent-21';

  IF v_email_slots <> 1 THEN
    RAISE EXCEPTION 'NEWTON_SLOT_INVARIANT_VIOLATION: expected exactly 1 email slot, found %', v_email_slots;
  END IF;
  IF v_social_slots <> 4 THEN
    RAISE EXCEPTION 'NEWTON_SLOT_INVARIANT_VIOLATION: expected exactly 4 social slots, found %', v_social_slots;
  END IF;
END $$;

COMMIT;
