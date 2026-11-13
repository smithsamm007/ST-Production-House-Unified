BEGIN;

-- 032_canonical_director_mappings.sql
--
-- Canonical 10 Director registry — Phase 2A schema (additive, R1: never edit an
-- applied migration).
--
-- What this migration establishes:
--   1. `canonical_director_mappings` — the SINGLE authoritative lifecycle state
--      for the canonical 10 Directors (JARVIS, COSMOS, NEWTON, AADI, LAKME,
--      SHERLOCK, CHRONOS, AI NEWS, TECH MASTER, BUTTERFLY). Each row maps one
--      canonical Director code to one underlying `agents(id)` key.
--   2. `canonical_director_cap_lock` — a dedicated one-row lock table. Every
--      activation path takes `SELECT ... FOR UPDATE` on
--      id = 'active_director_cap' inside its transaction, so the
--      50-active-Director invariant is serialized instead of raced.
--   3. DB enforcement of the active-only cap on the mapping table itself
--      (trigger), so the invariant holds even for a writer that bypasses the
--      application repository.
--   4. DB enforcement of retirement at the operational write paths: a mapping
--      that is retired or suspended cannot originate new jobs, schedules,
--      director connections, or OAuth state rows.
--
-- Deliberately NOT changed here:
--   - `agents_max_50` / `enforce_agent_cap()` (sql/001) keep their existing
--     behaviour (a hard ceiling on total agent rows). The Owner's active-only
--     invariant is a *separate*, stricter rule expressed on the mapping table;
--     replacing the row ceiling would silently drop an existing guarantee and
--     regress the tests that assert it.
--   - No agent rows are created, deleted, or repurposed. Retirement is expressed
--     on the mapping row, never by dropping an `agents` row.
--   - R5: no job/status enums are added. The only new enum is the mapping
--     lifecycle status, which is local to this table.
--
-- PostgreSQL 15 compatible. Every statement is idempotent (IF NOT EXISTS /
-- CREATE OR REPLACE / guarded DO block) so re-runnable boot semantics hold.

-- ---------------------------------------------------------------------------
-- 1. Mapping lifecycle status
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'canonical_director_status'
  ) THEN
    CREATE TYPE canonical_director_status AS ENUM ('active', 'retired', 'suspended');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Canonical Director mapping table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_director_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The canonical Director code (the human-stable identity). One row per code.
  canonical_director_code text NOT NULL UNIQUE
    CHECK (canonical_director_code IN (
      'JARVIS', 'COSMOS', 'NEWTON', 'AADI', 'LAKME',
      'SHERLOCK', 'CHRONOS', 'AI NEWS', 'TECH MASTER', 'BUTTERFLY'
    )),

  -- The underlying key in agents(id) this canonical Director resolves to.
  -- Preserved keys: agent-01, agent-02, agent-03, agent-21.
  -- New keys: agent-director-cosmos, agent-director-aadi,
  --           agent-director-chronos, agent-director-ai-news,
  --           agent-director-tech-master, agent-director-butterfly.
  underlying_agent_id text NOT NULL UNIQUE
    REFERENCES agents(id) ON DELETE RESTRICT,

  -- Canonical display name and namespace for the Director.
  display_name text NOT NULL UNIQUE
    CHECK (char_length(display_name) BETWEEN 2 AND 50),
  namespace text NOT NULL UNIQUE
    CHECK (namespace ~ '^st\.agent\.[a-z0-9-]{2,60}$'),

  -- SINGLE authoritative lifecycle state.
  status canonical_director_status NOT NULL DEFAULT 'retired',

  retired_at timestamptz,
  retired_reason text CHECK (retired_reason IS NULL OR char_length(retired_reason) <= 500),
  suspended_note text CHECK (suspended_note IS NULL OR char_length(suspended_note) <= 500),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Retirement/suspension bookkeeping stays coherent with status.
  CONSTRAINT canonical_director_active_has_no_retirement CHECK (
    status <> 'active' OR (retired_at IS NULL AND retired_reason IS NULL AND suspended_note IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS canonical_director_mappings_status_idx
  ON canonical_director_mappings (status);

-- ---------------------------------------------------------------------------
-- 3. Dedicated cap-lock row
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_director_cap_lock (
  id text PRIMARY KEY,
  note text NOT NULL DEFAULT ''
);

INSERT INTO canonical_director_cap_lock (id, note)
  VALUES ('active_director_cap', 'Serializes the 50-active-Director invariant')
  ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Active-only cap enforcement on the mapping table
-- ---------------------------------------------------------------------------
-- Fires only when a row becomes (or already is) active. Any writer — the
-- repository, a migration, or an operator psql session — is subject to it.
CREATE OR REPLACE FUNCTION enforce_canonical_director_active_cap() RETURNS trigger AS $$
DECLARE
  active_count integer;
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- Serialize every activation contender on the single dedicated lock row.
  PERFORM 1
     FROM canonical_director_cap_lock
    WHERE id = 'active_director_cap'
    FOR UPDATE;

  SELECT count(*)::integer INTO active_count
    FROM canonical_director_mappings
   WHERE status = 'active'
     AND id <> NEW.id;

  IF active_count >= 50 THEN
    RAISE EXCEPTION 'ACTIVE_DIRECTOR_CAP_REACHED';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_director_active_cap ON canonical_director_mappings;
CREATE TRIGGER canonical_director_active_cap
  BEFORE INSERT OR UPDATE OF status ON canonical_director_mappings
  FOR EACH ROW
  EXECUTE FUNCTION enforce_canonical_director_active_cap();

-- ---------------------------------------------------------------------------
-- 5. Resolution helper: canonical code -> active underlying agent id
-- ---------------------------------------------------------------------------
-- Returns the underlying agent id ONLY while the mapping is active. Callers at
-- the operational write paths use this (or the equivalent repository guard) so
-- a retired/suspended Director can never originate new work.
CREATE OR REPLACE FUNCTION resolve_active_canonical_director(p_code text)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  AS $$
DECLARE
  v_agent_id text;
BEGIN
  SELECT underlying_agent_id INTO v_agent_id
    FROM canonical_director_mappings
   WHERE canonical_director_code = p_code
     AND status = 'active';

  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'CANONICAL_DIRECTOR_NOT_ACTIVE';
  END IF;

  RETURN v_agent_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Retirement enforcement at the operational write paths
-- ---------------------------------------------------------------------------
-- One shared guard: raise when a mapping row EXISTS for the agent and it is not
-- active. A missing mapping row means "this agent is not governed by the
-- canonical registry yet" (the pre-cutover state), which must NOT block
-- existing behaviour — the canonical set is activated deliberately, not by
-- running a migration.
CREATE OR REPLACE FUNCTION enforce_canonical_director_operational(p_agent_id text) RETURNS void AS $$
DECLARE
  v_status canonical_director_status;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN;
  END IF;

  SELECT status INTO v_status
    FROM canonical_director_mappings
   WHERE underlying_agent_id = p_agent_id;

  -- Not governed yet, or governed and active: allow.
  IF v_status IS NULL OR v_status = 'active' THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'CANONICAL_DIRECTOR_NOT_ACTIVE';
END;
$$ LANGUAGE plpgsql STABLE;

-- jobs: the production queue is the primary new-work origin.
CREATE OR REPLACE FUNCTION canonical_director_guard_jobs() RETURNS trigger AS $$
BEGIN
  PERFORM enforce_canonical_director_operational(NEW.agent_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_director_guard_jobs ON jobs;
CREATE TRIGGER canonical_director_guard_jobs
  BEFORE INSERT ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION canonical_director_guard_jobs();

-- director_schedules: activating a schedule is a production commitment.
CREATE OR REPLACE FUNCTION canonical_director_guard_director_schedules() RETURNS trigger AS $$
BEGIN
  IF NEW.schedule_enabled = true THEN
    PERFORM enforce_canonical_director_operational(NEW.agent_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_director_guard_director_schedules ON director_schedules;
CREATE TRIGGER canonical_director_guard_director_schedules
  BEFORE INSERT OR UPDATE ON director_schedules
  FOR EACH ROW
  EXECUTE FUNCTION canonical_director_guard_director_schedules();

-- director_connections: new credential bindings are operational state.
CREATE OR REPLACE FUNCTION canonical_director_guard_director_connections() RETURNS trigger AS $$
BEGIN
  PERFORM enforce_canonical_director_operational(NEW.agent_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_director_guard_director_connections ON director_connections;
CREATE TRIGGER canonical_director_guard_director_connections
  BEFORE INSERT OR UPDATE ON director_connections
  FOR EACH ROW
  EXECUTE FUNCTION canonical_director_guard_director_connections();

-- OAuth state rows: starting an authorization round is a new-work origin.
CREATE OR REPLACE FUNCTION canonical_director_guard_youtube_oauth_states() RETURNS trigger AS $$
BEGIN
  PERFORM enforce_canonical_director_operational(NEW.agent_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_director_guard_youtube_oauth_states ON youtube_oauth_states;
CREATE TRIGGER canonical_director_guard_youtube_oauth_states
  BEFORE INSERT ON youtube_oauth_states
  FOR EACH ROW
  EXECUTE FUNCTION canonical_director_guard_youtube_oauth_states();

CREATE OR REPLACE FUNCTION canonical_director_guard_social_oauth_states() RETURNS trigger AS $$
BEGIN
  PERFORM enforce_canonical_director_operational(NEW.agent_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_director_guard_social_oauth_states ON social_oauth_states;
CREATE TRIGGER canonical_director_guard_social_oauth_states
  BEFORE INSERT ON social_oauth_states
  FOR EACH ROW
  EXECUTE FUNCTION canonical_director_guard_social_oauth_states();

COMMIT;
