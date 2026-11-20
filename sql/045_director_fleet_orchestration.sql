BEGIN;
-- 045 — HERMES Director fleet registry, independent universes, director-scoped
--       production tasks, fenced leases, evidence and fleet escalations (Day 5).
--
-- Additive only: sql/001..044 are untouched. PostgreSQL 15+ compatible.
--
-- Design notes
--   * `canonical_director_mappings` (sql/032) keeps its frozen three-state
--     lifecycle (active | retired | suspended). The fleet registry below is the
--     richer Owner-facing lifecycle (DRAFT..RETIRED) and never rewrites those
--     states; `underlying_agent_id` links a fleet Director to its runtime key.
--   * Production tasks are Director-scoped and distinct from the engineering
--     task queue in `forge_tasks` (sql/035). They reuse the SAME durability
--     primitives: a partial unique index for at-most-one active lease, a
--     monotonically increasing fencing token, database-clock expiry comparisons
--     and bounded attempts. No second engineering state machine is created.
--   * Every Director-owned table is subject to FORCE ROW LEVEL SECURITY bound to
--     `current_user` (sql/039 function), so a Director runtime role can only see
--     its own universe even if application code asked for another one.

CREATE TABLE IF NOT EXISTS director_fleet (
  director_id           TEXT PRIMARY KEY
                          CHECK (director_id ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  underlying_agent_id   TEXT NULL,
  display_name          TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  universe_name         TEXT NULL,
  niche                 TEXT NULL,
  genres                JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_formats       JSONB NOT NULL DEFAULT '[]'::jsonb,
  languages             JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_audience       TEXT NULL,
  creative_direction    TEXT NULL,
  lifecycle_state       TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (lifecycle_state IN (
                            'DRAFT','CONFIGURED','READY','ACTIVE',
                            'PAUSED','SUSPENDED','RETIRING','RETIRED'
                          )),
  readiness             JSONB NOT NULL DEFAULT '{}'::jsonb,
  readiness_checked_at  TIMESTAMPTZ NULL,
  team_config           JSONB NOT NULL DEFAULT '{}'::jsonb,
  production_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  platform_connections  JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_authorized_at   TIMESTAMPTZ NULL,
  state_reason          TEXT NULL,
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_activity_at      TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_director_fleet_underlying_agent
  ON director_fleet (underlying_agent_id)
  WHERE underlying_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_director_fleet_state
  ON director_fleet (lifecycle_state, director_id);

-- Fleet capacity (Owner policy: at most 50 Directors). A retired Director is
-- preserved as history and no longer consumes a slot; it can never be deleted
-- through the application because history must survive.
CREATE OR REPLACE FUNCTION director_fleet_capacity_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  occupied INTEGER;
BEGIN
  IF NEW.lifecycle_state = 'RETIRED' THEN
    RETURN NEW;
  END IF;
  SELECT count(*)::int INTO occupied
    FROM director_fleet
   WHERE lifecycle_state <> 'RETIRED'
     AND director_id <> NEW.director_id;
  IF occupied >= 50 THEN
    RAISE EXCEPTION 'DIRECTOR_FLEET_CAPACITY_REACHED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_director_fleet_capacity ON director_fleet;
CREATE TRIGGER trg_director_fleet_capacity
  BEFORE INSERT ON director_fleet
  FOR EACH ROW EXECUTE FUNCTION director_fleet_capacity_guard();

CREATE TABLE IF NOT EXISTS director_fleet_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  director_id     TEXT NOT NULL,
  action          TEXT NOT NULL,
  previous_state  TEXT NULL,
  new_state       TEXT NULL,
  reason          TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  actor_role      TEXT NOT NULL CHECK (actor_role IN ('OWNER','HERMES','FORGE','SYSTEM')),
  correlation_id  UUID NOT NULL,
  policy_ref      TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_director_fleet_audit_director
  ON director_fleet_audit (director_id, created_at DESC);

CREATE OR REPLACE FUNCTION director_fleet_audit_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION';
END;
$$;

DROP TRIGGER IF EXISTS trg_director_fleet_audit_append_only ON director_fleet_audit;
CREATE TRIGGER trg_director_fleet_audit_append_only
  BEFORE UPDATE OR DELETE ON director_fleet_audit
  FOR EACH ROW EXECUTE FUNCTION director_fleet_audit_append_only();

CREATE TABLE IF NOT EXISTS director_projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  director_id   TEXT NOT NULL REFERENCES director_fleet(director_id) ON DELETE RESTRICT,
  project_key   TEXT NOT NULL CHECK (length(project_key) BETWEEN 1 AND 120),
  universe_id   TEXT NOT NULL CHECK (length(universe_id) BETWEEN 1 AND 120),
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  state         TEXT NOT NULL DEFAULT 'PLANNED'
                  CHECK (state IN ('PLANNED','IN_PRODUCTION','COMPLETED','CANCELLED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (director_id, project_key)
);

CREATE INDEX IF NOT EXISTS idx_director_projects_owner
  ON director_projects (director_id, state);

CREATE TABLE IF NOT EXISTS director_tasks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  director_id           TEXT NOT NULL REFERENCES director_fleet(director_id) ON DELETE RESTRICT,
  project_id            UUID NOT NULL REFERENCES director_projects(id) ON DELETE RESTRICT,
  universe_id           TEXT NOT NULL,
  stage                 TEXT NOT NULL
                          CHECK (stage IN (
                            'RESEARCH','SCRIPT','CHARACTERS','VISUALS','ANIMATION',
                            'VOICE','MUSIC','ASSEMBLY','FFPROBE','QC','PACKAGE',
                            'OWNER_APPROVAL','PUBLISHING','ANALYTICS'
                          )),
  task_type             TEXT NOT NULL DEFAULT 'production'
                          CHECK (task_type IN ('production','review','owner_action')),
  status                TEXT NOT NULL DEFAULT 'CREATED'
                          CHECK (status IN (
                            'CREATED','QUEUED','ASSIGNED','RUNNING','BLOCKED',
                            'RETRY_SCHEDULED','FAILED','COMPLETED','CANCELLED','DEAD_LETTER'
                          )),
  priority              INTEGER NOT NULL DEFAULT 100,
  idempotency_key       TEXT NOT NULL UNIQUE,
  assignment_reason     TEXT NULL,
  assigned_at           TIMESTAMPTZ NULL,
  due_at                TIMESTAMPTZ NULL,
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts          INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  active_fencing_token  BIGINT NOT NULL DEFAULT 0 CHECK (active_fencing_token >= 0),
  next_run_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  cancel_requested      BOOLEAN NOT NULL DEFAULT FALSE,
  provider_requirement  TEXT NULL,
  provider_state        TEXT NOT NULL DEFAULT 'UNCONSTRAINED'
                          CHECK (provider_state IN ('UNCONSTRAINED','AVAILABLE','UNAVAILABLE','QUOTA_EXHAUSTED')),
  blocked_reason        TEXT NULL,
  last_error            TEXT NULL,
  result_ref            TEXT NULL,
  correlation_id        UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_director_tasks_sched
  ON director_tasks (status, priority, next_run_at);

CREATE INDEX IF NOT EXISTS idx_director_tasks_owner
  ON director_tasks (director_id, stage, status);

CREATE TABLE IF NOT EXISTS director_task_dependencies (
  task_id             UUID NOT NULL REFERENCES director_tasks(id) ON DELETE CASCADE,
  depends_on_task_id  UUID NOT NULL REFERENCES director_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS director_task_leases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID NOT NULL REFERENCES director_tasks(id) ON DELETE CASCADE,
  worker_key        TEXT NOT NULL CHECK (length(worker_key) BETWEEN 1 AND 120),
  fencing_token     BIGINT NOT NULL CHECK (fencing_token > 0),
  leased_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at  TIMESTAMPTZ NOT NULL,
  released_at       TIMESTAMPTZ NULL,
  release_reason    TEXT NULL
                      CHECK (release_reason IN ('completed','expired','cancelled','failed','reclaimed','restart')),
  UNIQUE (task_id, fencing_token)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_director_active_lease_per_task
  ON director_task_leases (task_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_director_leases_expiry
  ON director_task_leases (lease_expires_at)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS director_task_evidence (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID NOT NULL REFERENCES director_tasks(id) ON DELETE CASCADE,
  director_id    TEXT NOT NULL,
  stage          TEXT NOT NULL,
  evidence_type  TEXT NOT NULL CHECK (length(evidence_type) BETWEEN 1 AND 80),
  artifact_hash  TEXT NULL CHECK (artifact_hash IS NULL OR artifact_hash ~ '^[a-f0-9]{64}$'),
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, evidence_type)
);

CREATE INDEX IF NOT EXISTS idx_director_evidence_owner
  ON director_task_evidence (director_id, stage);

-- A heartbeat must come from a real registered runtime; a browser tab is never a
-- worker. Expiry is always evaluated with the database clock.
CREATE TABLE IF NOT EXISTS director_workers (
  worker_key         TEXT PRIMARY KEY CHECK (length(worker_key) BETWEEN 1 AND 120),
  instance_id        TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'production'
                       CHECK (role IN ('production','supervisor','reporting')),
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','draining','offline')),
  last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_director_workers_health
  ON director_workers (status, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS director_fleet_escalations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  director_id            TEXT NULL,
  code                   TEXT NOT NULL,
  severity               TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  detail                 TEXT NOT NULL,
  dedupe_key             TEXT NOT NULL UNIQUE,
  notification_event_id  UUID NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_director_escalations_director
  ON director_fleet_escalations (director_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Director isolation: FORCE RLS keyed to the non-forgeable current_user.
-- Owner control-plane roles (anything that is not a Director runtime role) keep
-- full access, exactly like sql/039.
-- ---------------------------------------------------------------------------
ALTER TABLE director_fleet ENABLE ROW LEVEL SECURITY;
ALTER TABLE director_fleet FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS director_fleet_self_policy ON director_fleet;
CREATE POLICY director_fleet_self_policy
  ON director_fleet
  USING (current_user NOT LIKE 'st_dir_%' OR forge_director_role_for_agent(director_id) = current_user)
  WITH CHECK (current_user NOT LIKE 'st_dir_%' OR forge_director_role_for_agent(director_id) = current_user);

ALTER TABLE director_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE director_projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS director_projects_self_policy ON director_projects;
CREATE POLICY director_projects_self_policy
  ON director_projects
  USING (current_user NOT LIKE 'st_dir_%' OR forge_director_role_for_agent(director_id) = current_user)
  WITH CHECK (current_user NOT LIKE 'st_dir_%' OR forge_director_role_for_agent(director_id) = current_user);

ALTER TABLE director_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE director_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS director_tasks_self_policy ON director_tasks;
CREATE POLICY director_tasks_self_policy
  ON director_tasks
  USING (current_user NOT LIKE 'st_dir_%' OR forge_director_role_for_agent(director_id) = current_user)
  WITH CHECK (current_user NOT LIKE 'st_dir_%' OR forge_director_role_for_agent(director_id) = current_user);

ALTER TABLE director_task_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE director_task_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS director_evidence_self_policy ON director_task_evidence;
CREATE POLICY director_evidence_self_policy
  ON director_task_evidence
  USING (current_user NOT LIKE 'st_dir_%' OR forge_director_role_for_agent(director_id) = current_user)
  WITH CHECK (current_user NOT LIKE 'st_dir_%' OR forge_director_role_for_agent(director_id) = current_user);

COMMIT;
