-- 027_analytics_records.sql
--
-- Additive migration (CONVENTIONS.md Rule 9 / AGENTS.md R1: never edit
-- applied migrations).
--
-- Durable analytics store (Issue #194): the genuine external analytics
-- records ingested through the owner live-operations API
-- (POST /ops/analytics/ingest) must survive process restarts and be
-- retrievable owner-scoped via GET /ops/analytics. The process-lifetime
-- in-memory Map remains only as the labeled demo transport; production
-- stores rows in this table through PostgresAnalyticsRepository.
--
-- Append-only semantics (same pattern as sql/022 director_connection_tests
-- and sql/023 hermes_decisions): rows are immutable — a BEFORE UPDATE OR
-- DELETE trigger rejects mutation (APPEND_ONLY_VIOLATION). Corrections or
-- later collections are NEW rows (a fresh collection snapshot per post),
-- never an UPDATE — analytics history is never rewritten (Rule 1).
--
-- Closed enums and bounds mirror the service contract exactly (R5: the
-- database mirrors existing module enums; no new states are introduced):
--   platform: youtube | instagram | facebook | snapchat
--   metrics:  non-negative integers, DB-enforced (the service already
--             validates; the database is the second line of defense).
--
-- Rule 17: `metadata` holds only non-secret, agent-name-free material —
-- the service's leakage gates reject secret-shaped values and internal
-- agent names BEFORE a row can exist; the CHECK here is a last-resort
-- bound on size, not a content oracle.
--
-- PG15-compatible: jsonb_typeof checks only — no IS JSON, no subqueries in
-- CHECK constraints. All statements idempotent (IF NOT EXISTS / OR REPLACE).
-- owner_id references owners(id) like every other owner-scoped table.

CREATE TABLE IF NOT EXISTS owner_analytics_records (
  id bigserial PRIMARY KEY,
  record_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text CHECK (agent_id IS NULL OR char_length(agent_id) BETWEEN 1 AND 80),
  platform_post_id text NOT NULL CHECK (char_length(platform_post_id) BETWEEN 1 AND 200),
  platform_url text NOT NULL CHECK (char_length(platform_url) BETWEEN 9 AND 512
    AND platform_url LIKE 'https://%'),
  platform text NOT NULL CHECK (platform IN ('youtube', 'instagram', 'facebook', 'snapchat')),
  views bigint NOT NULL DEFAULT 0 CHECK (views >= 0),
  watch_time_seconds bigint NOT NULL DEFAULT 0 CHECK (watch_time_seconds >= 0),
  likes bigint NOT NULL DEFAULT 0 CHECK (likes >= 0),
  shares bigint NOT NULL DEFAULT 0 CHECK (shares >= 0),
  comments_count bigint NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  -- Non-secret capture context only (already leakage-gated upstream).
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  collected_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS owner_analytics_records_owner_idx
  ON owner_analytics_records (owner_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS owner_analytics_records_post_idx
  ON owner_analytics_records (platform_post_id, recorded_at DESC);

-- Append-only enforcement (Rule 1): analytics history is immutable.
CREATE OR REPLACE FUNCTION reject_owner_analytics_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: owner_analytics_records rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS owner_analytics_records_append_only ON owner_analytics_records;
CREATE TRIGGER owner_analytics_records_append_only
  BEFORE UPDATE OR DELETE ON owner_analytics_records
  FOR EACH ROW EXECUTE FUNCTION reject_owner_analytics_mutation();
