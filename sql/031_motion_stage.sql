BEGIN;

-- 031_motion_stage.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Issue #241: the local motion stage (S-M40-01, #236) becomes a real pipeline
-- stage. It runs between `visual` and `assembly` when the owner opts in
-- (STPH_ENABLE_LOCAL_MOTION=1) and records its own artifacts and pipeline
-- events, so `motion` must be a legal pipeline_events.stage.
--
-- pipeline_events.stage (last widened by sql/025) gains `motion` (drop +
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
      CHECK (stage IN ('story', 'visual', 'audio', 'motion', 'assembly', 'reels', 'packaging', 'qc', 'complete'));
  END IF;
END;
$$;

COMMIT;
