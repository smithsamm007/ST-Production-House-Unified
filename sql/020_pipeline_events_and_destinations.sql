-- 020_pipeline_events_and_destinations.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Completes the multi-channel production model on top of 019:
--   - artifacts.release_id: links deterministic stage outputs to their
--     production release (the artifacts table from 001 stays canonical).
--   - pipeline_events: durable per-stage log (started/succeeded/failed) so a
--     crashed run is always resumable and auditable.
--   - publish_destinations: owner-scoped public channel identities per
--     platform. Publishing stays intent-only until live platform approvals
--     exist (AGENTS.md Rules 7/11/16).

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS release_id uuid REFERENCES production_releases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS artifacts_release_idx ON artifacts (release_id, created_at);

-- Deterministic retries produce identical content; identical output for one
-- release is stored once (different content = different sha256 = new row).
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_release_sha_uq
  ON artifacts (release_id, sha256)
  WHERE release_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipeline_events (
  id bigserial PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES production_releases(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('story', 'visual', 'audio', 'assembly', 'complete')),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  job_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_events_release_idx ON pipeline_events (release_id, id);

CREATE TABLE IF NOT EXISTS publish_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('youtube', 'instagram', 'facebook', 'snapchat')),
  handle text NOT NULL CHECK (char_length(handle) BETWEEN 2 AND 120),
  is_primary boolean NOT NULL DEFAULT false,
  public_attribution text NOT NULL CHECK (char_length(public_attribution) BETWEEN 2 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one primary destination per platform per channel.
CREATE UNIQUE INDEX IF NOT EXISTS publish_destinations_primary_uq
  ON publish_destinations (channel_id, platform)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS publish_destinations_channel_idx ON publish_destinations (channel_id);
