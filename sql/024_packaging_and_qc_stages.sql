BEGIN;

-- 024_packaging_and_qc_stages.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Issue #185: the episode pipeline grows two post-assembly stages:
--   - packaging: subtitles + metadata documents, thumbnail media, and the
--     episode package manifest binding the release's own recorded artifacts
--   - qc: the quality-control gate over that manifest and the release's
--     artifacts (automated checks now; human-in-the-loop decisions later)
--
-- pipeline_events.stage (sql/020) allowed exactly five values. The new
-- stage names extend that CHECK constraint in place (drop + re-add, the
-- sql/009 precedent for additive enum widening). Idempotent (IF EXISTS /
-- guarded DO block) so re-runnable boot semantics are preserved.

ALTER TABLE pipeline_events DROP CONSTRAINT IF EXISTS pipeline_events_stage_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pipeline_events_stage_check'
  ) THEN
    ALTER TABLE pipeline_events ADD CONSTRAINT pipeline_events_stage_check
      CHECK (stage IN ('story', 'visual', 'audio', 'assembly', 'packaging', 'qc', 'complete'));
  END IF;
END;
$$;

COMMIT;
