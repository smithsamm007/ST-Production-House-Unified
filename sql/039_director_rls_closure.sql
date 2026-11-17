BEGIN;
-- 039 — Complete Director RLS Closure across core Director-scoped tables (Phase 2.7.1, v1.2).
-- Preserves sql/001..038 untouched. PostgreSQL 15+ compatible.
--
-- Policy design:
--   - Every Director runtime role (`st_dir_<agent_id>`) is strictly isolated
--     to rows where `forge_director_role_for_agent(<owner_col>) = current_user`.
--   - `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` are applied.
--   - Non-director Owner-control-plane roles (e.g. `st_app` used by existing
--     Owner API integration tests) remain explicitly permitted only when
--     `current_user NOT LIKE 'st_dir_%'`, preventing regressions while enforcing
--     hard non-forgeable `current_user` isolation for all Director runtime roles.

CREATE OR REPLACE FUNCTION forge_director_role_for_agent(p_agent_id TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_agent_id IS NULL THEN NULL
    ELSE 'st_dir_' || regexp_replace(lower(p_agent_id), '[^a-z0-9_]', '_', 'g')
  END;
$$;

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('credential_refs',         'agent_id'),
      ('jobs',                    'agent_id'),
      ('artifacts',               'agent_id'),
      ('publishing_requests',     'agent_id'),
      ('agent_social_accounts',   'agent_id'),
      ('agent_email_connections', 'agent_id'),
      ('creative_charters',       'agent_id'),
      ('director_schedules',      'agent_id'),
      ('director_connections',    'agent_id'),
      ('channels',                'agent_id')
    ) AS t(tbl_name, col_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = rec.tbl_name
        AND column_name = rec.col_name
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', rec.tbl_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', rec.tbl_name);
      EXECUTE format('DROP POLICY IF EXISTS forge_director_rls_policy ON %I', rec.tbl_name);
      EXECUTE format(
        'CREATE POLICY forge_director_rls_policy ON %I ' ||
        'USING (current_user NOT LIKE ''st_dir_%%'' OR forge_director_role_for_agent(%I) = current_user) ' ||
        'WITH CHECK (current_user NOT LIKE ''st_dir_%%'' OR forge_director_role_for_agent(%I) = current_user)',
        rec.tbl_name, rec.col_name, rec.col_name
      );
    END IF;
  END LOOP;
END
$$;

COMMIT;
