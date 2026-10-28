-- 029_director_production_schedule.sql
--
-- Additive migration (CONVENTIONS.md Rule 9 / AGENTS.md R1: never edit applied
-- migrations).
--
-- Per-Director episode duration & daily production schedule (owner's master
-- prompt: "PER-DIRECTOR EPISODE DURATION & DAILY PRODUCTION SCHEDULER").
--
--   - director_schedules: ONE persisted schedule row per (owner, agent). The
--     Director's own episode duration, daily episode target, production days,
--     preferred start time, timezone, and an explicit enable/pause flag.
--     Directors are independent (AGENTS.md Rule 5/16): every row carries
--     (owner_id, agent_id) and every read/write is scoped to both, so one
--     Director can never read or change another's schedule.
--   - director_schedule_slots: the durable, IDEMPOTENT reservation of one
--     scheduled production slot — one row per (owner, agent, schedule_date,
--     slot_index), UNIQUE by construction (AGENTS.md Rule 13). A duplicate
--     scheduler run can therefore never create a second logical episode for
--     the same slot; it records `pending` on claim and the final honest state
--     (queued | delayed | blocked | skipped) with a stable reason code, so the
--     owner can always see WHY a slot produced no episode.
--
-- Storage-unit choices (documented for the reader):
--   - episode_duration_seconds is an integer in SECONDS, constrained to the
--     three owner-selectable targets: 1800 (30 min), 2400 (40 min, default),
--     3000 (50 min). The same [1800, 3000] window the S-M33-01 main-video QC
--     gate already enforces, so no existing gate is weakened.
--   - production_days is stored as a compact ISO-weekday list ('1'=Monday …
--     '7'=Sunday) with a shape CHECK, ordered and duplicate-free by the
--     repository contract. This keeps the shared SQL subset (no array
--     operators) so the labeled demo adapter and the PostgreSQL adapter agree.
--   - production_start_time is 'HH:MM' in the Director's own timezone; the
--     repository resolves it to an instant with the IANA zone (DST-aware) at
--     scheduling time — the database never guesses an offset.
--
-- Honesty (AGENTS.md Rules 1–3): nothing here stores a provider receipt, a
-- media claim, or a success flag. The schedule is intent; the release, job and
-- pipeline records remain the only evidence of production. Saving or enabling
-- a schedule NEVER publishes (Rule 7 owner approval stays mandatory).
--
-- All statements are idempotent (IF NOT EXISTS). New closed enums introduced
-- by THIS migration only; existing status enums elsewhere are untouched (R5).

CREATE TABLE IF NOT EXISTS director_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  episode_duration_seconds integer NOT NULL DEFAULT 2400
    CHECK (episode_duration_seconds IN (1800, 2400, 3000)),
  episodes_per_day integer NOT NULL DEFAULT 1
    CHECK (episodes_per_day BETWEEN 1 AND 6),
  production_days text NOT NULL DEFAULT '1,2,3,4,5,6,7'
    CHECK (production_days ~ '^[1-7](,[1-7]){0,6}$'),
  production_start_time text NOT NULL DEFAULT '09:00'
    CHECK (production_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- IANA zone: Region/City (Asia/Kolkata) or a single-segment zone (UTC).
  -- The repository additionally resolves the zone through the runtime's own
  -- timezone database, so an unresolvable name is rejected before any write.
  timezone text NOT NULL DEFAULT 'Asia/Kolkata'
    CHECK (char_length(timezone) BETWEEN 3 AND 64
           AND timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)?$'),
  schedule_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id)
);

CREATE INDEX IF NOT EXISTS director_schedules_owner_idx
  ON director_schedules (owner_id, agent_id);

CREATE TABLE IF NOT EXISTS director_schedule_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  schedule_date date NOT NULL,
  slot_index smallint NOT NULL CHECK (slot_index BETWEEN 0 AND 5),
  episode_duration_seconds integer NOT NULL
    CHECK (episode_duration_seconds IN (1800, 2400, 3000)),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'queued', 'delayed', 'blocked', 'skipped')),
  reason_code text CHECK (reason_code IS NULL OR char_length(reason_code) <= 80),
  release_id uuid REFERENCES production_releases(id) ON DELETE SET NULL,
  job_id uuid,
  season integer CHECK (season IS NULL OR season BETWEEN 1 AND 100),
  episode integer CHECK (episode IS NULL OR episode BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, schedule_date, slot_index)
);

CREATE INDEX IF NOT EXISTS director_schedule_slots_agent_idx
  ON director_schedule_slots (owner_id, agent_id, schedule_date);
