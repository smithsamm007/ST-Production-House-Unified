BEGIN;

-- 025_reels_stage.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Issue #189: the episode pipeline grows the canonical short-form stage
-- (S-M34-01): two independent content Reels + one standalone brand Reel,
-- assembled from the release's OWN verified artifacts and bound in the
-- canonical S-M37 media-package manifest.
--
-- pipeline_events.stage (last widened by sql/024) gains `reels` (drop +
-- re-add, the sql/009 precedent for additive enum widening). Idempotent
-- (IF EXISTS / guarded DO block) so re-runnable boot semantics are kept.

ALTER TABLE pipeline_events DROP CONSTRAINT IF EXISTS pipeline_events_stage_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pipeline_events_stage_check'
  ) THEN
    ALTER TABLE pipeline_events ADD CONSTRAINT pipeline_events_stage_check
      CHECK (stage IN ('story', 'visual', 'audio', 'assembly', 'reels', 'packaging', 'qc', 'complete'));
  END IF;
END;
$$;

COMMIT;
