-- 019_channels_and_productions.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Multi-channel anime production house model:
--   - channels: one public brand row per production channel. Public branding
--     only; the owning agent stays internal (AGENTS.md Rule 15) and is linked
--     by id, never exposed through public DTOs.
--   - production_releases: one planned episode (season/episode) per channel.
--     A unique index enforces "one planned release per (channel, season,
--     episode)" so duplicate queue requests fail closed as 409s.
--
-- All statements are idempotent (IF NOT EXISTS) so migration 005+ semantics
-- (re-runnable boot) are preserved.

CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,80}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 120),
  tagline text CHECK (char_length(tagline) <= 300),
  language text CHECK (char_length(language) <= 80),
  agent_id text NOT NULL REFERENCES agents(id),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channels_owner_idx ON channels (owner_id);

CREATE TABLE IF NOT EXISTS production_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  season integer NOT NULL CHECK (season BETWEEN 1 AND 100),
  episode integer NOT NULL CHECK (episode BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_production', 'rendering', 'review', 'published', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, season, episode)
);

CREATE INDEX IF NOT EXISTS productions_owner_idx ON production_releases (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS productions_channel_idx ON production_releases (channel_id, season, episode);

-- ---------------------------------------------------------------------------
-- jobs.owner_id (used by owner dashboard scoping, mirrored from sql/017)
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_id uuid;
CREATE INDEX IF NOT EXISTS jobs_owner_status_idx ON jobs (owner_id, status, created_at);
