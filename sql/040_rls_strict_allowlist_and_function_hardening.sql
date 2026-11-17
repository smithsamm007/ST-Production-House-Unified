BEGIN;
-- 040 — Strict Control-Plane Allowlist RLS & Function Hardening (Phase 2.7.2, v1.2).
-- Preserves sql/001..039 untouched. PostgreSQL 15+ compatible.
--
-- Fixes Phase 2.7.2 security findings:
--   1. Replaces permissive `current_user NOT LIKE 'st_dir_%'` with an explicit,
--      closed control-plane role allowlist (`st_app`, `st_control_plane`, `st_migrator`).
--      Any generic or unknown runtime role (e.g. `st_generic_worker`) is DENIED
--      cross-Director access by default.
--   2. Hardens `forge_director_role_for_agent(TEXT)` with `SECURITY INVOKER`,
--      pinned `SET search_path = pg_catalog`, and strict input validation
--      (fails closed to NULL on malformed/oversized agent IDs).
--   3. Extends ENABLE + FORCE ROW LEVEL SECURITY to remaining Director-scoped
--      tables (`promo_campaigns`, `evidence_events`, `agent_public_profiles`,
--      `agent_charter_assignments`, `communication_sessions`, `blueprint_drafts`,
--      `broker_credential_metadata`).

CREATE OR REPLACE FUNCTION forge_director_role_for_agent(p_agent_id TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_agent_id IS NULL THEN NULL
    WHEN p_agent_id !~ '^[A-Za-z0-9_-]{2,40}$' THEN NULL
    ELSE 'st_dir_' || pg_catalog.regexp_replace(pg_catalog.lower(p_agent_id), '[^a-z0-9_]', '_', 'g')
  END;
$$;

CREATE OR REPLACE FUNCTION forge_is_authorized_control_plane_role()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT current_user IN ('st_app', 'st_control_plane', 'st_migrator');
$$;

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('credential_refs',            'agent_id'),
      ('jobs',                       'agent_id'),
      ('artifacts',                  'agent_id'),
      ('publishing_requests',        'agent_id'),
      ('agent_social_accounts',      'agent_id'),
      ('agent_email_connections',    'agent_id'),
      ('agent_public_profiles',      'agent_id'),
      ('creative_charters',          'agent_id'),
      ('agent_charter_assignments',  'agent_id'),
      ('communication_sessions',     'agent_id'),
      ('blueprint_drafts',           'agent_id'),
      ('broker_credential_metadata', 'agent_id'),
      ('director_schedules',         'agent_id'),
      ('director_connections',       'agent_id'),
      ('channels',                   'agent_id'),
      ('evidence_events',            'agent_id'),
      ('promo_campaigns',            'owner_agent_id')
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
        'USING (forge_is_authorized_control_plane_role() OR forge_director_role_for_agent(%I) = current_user) ' ||
        'WITH CHECK (forge_is_authorized_control_plane_role() OR forge_director_role_for_agent(%I) = current_user)',
        rec.tbl_name, rec.col_name, rec.col_name
      );
    END IF;
  END LOOP;
END
$$;

COMMIT;
