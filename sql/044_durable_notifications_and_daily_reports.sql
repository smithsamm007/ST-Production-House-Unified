BEGIN;
-- 044 — Durable notifications + autonomous daily FORGE Owner report (Day 4 / D6).
--
-- Additive only. Nothing in 001–043 is altered or dropped. The D5 outbox
-- (sql/043 forge_approval_notifications) stays exactly as it is: it is the
-- approval-deadline channel, not the general notification transport. This
-- migration adds the general durable event log, its per-channel delivery
-- state machine, the truthful channel-configuration records, the daily report
-- store and the durable report schedule.
--
-- Invariants enforced in the database (not by application clocks):
--   * one logical notification per idempotency key (UNIQUE);
--   * one delivery row per (event, channel);
--   * `delivered` always carries a delivery timestamp and never without an
--     attempt, `dead_letter` always carries a dead-letter timestamp;
--   * an external channel with no runtime transport is stored as
--     `unconfigured` with attempts = 0 — never as a delivery;
--   * one report per reporting date (UNIQUE), and a completed report's payload
--     and evidence hash are immutable;
--   * the schedule is a single durable row with an explicit next run time.
--
-- PG15-compatible; idempotent (IF NOT EXISTS / ON CONFLICT). No data migration.

-- ---------------------------------------------------------------------------
-- Channel configuration: deployment truth (runtime_configured) is recorded
-- separately from the Owner's own enable/disable decision (owner_enabled).
-- owner_inbox is the custody channel and can never be disabled.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_notification_channels (
  channel               TEXT PRIMARY KEY,
  transport             TEXT NULL CHECK (transport IS NULL OR char_length(transport) <= 60),
  runtime_configured    BOOLEAN NOT NULL DEFAULT false,
  owner_enabled         BOOLEAN NOT NULL DEFAULT true,
  required_secret_name  TEXT NULL CHECK (required_secret_name IS NULL OR char_length(required_secret_name) <= 80),
  status_reason         TEXT NULL CHECK (status_reason IS NULL OR char_length(status_reason) <= 120),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT forge_notification_channel_known CHECK (
    channel IN ('owner_inbox', 'email', 'push', 'webhook')
  ),
  CONSTRAINT forge_notification_inbox_always_configured CHECK (
    channel <> 'owner_inbox' OR (runtime_configured = true AND owner_enabled = true)
  )
);

INSERT INTO forge_notification_channels
  (channel, transport, runtime_configured, owner_enabled, required_secret_name, status_reason)
VALUES
  ('owner_inbox', 'durable_inbox', true, true, NULL, NULL),
  ('email', NULL, false, true, 'STPH_EMAIL_TRANSPORT', 'NO_EMAIL_TRANSPORT_CONFIGURED'),
  ('push', NULL, false, true, 'STPH_PUSH_WEBHOOK_URL', 'NO_PUSH_PROVIDER_CONFIGURED'),
  ('webhook', NULL, false, true, 'STPH_NOTIFICATION_WEBHOOK_URL', 'NO_WEBHOOK_URL_CONFIGURED')
ON CONFLICT (channel) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Durable Owner inbox / event log. One row per logical notification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_notification_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       TEXT NOT NULL CHECK (event_type IN (
                     'OWNER_APPROVAL_REQUEST',
                     'HERMES_DECISION',
                     'APPROVAL_DEADLINE_OUTCOME',
                     'FORGE_TASK_COMPLETED',
                     'FORGE_TASK_FAILED',
                     'WORKER_CRASH',
                     'WORKER_RETRY_EXHAUSTED',
                     'DIRECTOR_PRODUCTION_FAILED',
                     'PROVIDER_QUOTA_EXHAUSTED',
                     'PUBLISHING_FAILED',
                     'SECURITY_ALERT',
                     'AUTHORIZATION_ALERT',
                     'DELIVERY_ALERT',
                     'DAILY_FORGE_REPORT'
                   )),
  priority         TEXT NOT NULL CHECK (priority IN ('CRITICAL', 'HIGH', 'NORMAL', 'LOW')),
  recipient        TEXT NOT NULL DEFAULT 'OWNER'
                     CHECK (recipient = 'OWNER' OR recipient ~ '^director:[A-Za-z0-9._:-]{2,80}$'),
  owner_id         UUID NULL REFERENCES owners(id) ON DELETE CASCADE,
  director_id      TEXT NULL CHECK (director_id IS NULL OR char_length(director_id) BETWEEN 2 AND 80),
  task_ref         TEXT NULL CHECK (task_ref IS NULL OR char_length(task_ref) <= 160),
  idempotency_key  TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(payload) = 'object'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at          TIMESTAMPTZ NULL,
  read_by          UUID NULL REFERENCES owners(id) ON DELETE SET NULL,
  CONSTRAINT forge_notification_recipient_scope CHECK (
    (recipient = 'OWNER' AND owner_id IS NOT NULL) OR
    (recipient <> 'OWNER' AND director_id IS NOT NULL)
  ),
  CONSTRAINT forge_notification_read_shape CHECK (
    (read_at IS NULL AND read_by IS NULL) OR (read_at IS NOT NULL AND read_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_forge_notification_events_owner
  ON forge_notification_events (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_forge_notification_events_unread
  ON forge_notification_events (owner_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_forge_notification_events_priority
  ON forge_notification_events (priority, created_at DESC);

-- ---------------------------------------------------------------------------
-- Per-channel delivery state machine:
--   created → queued → attempted → delivered
--   attempted → failed → retry_scheduled → attempted
--   failed → dead_letter (exhausted or permanent)
--   created → unconfigured (no runtime transport for this channel)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_notification_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES forge_notification_events(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL CHECK (channel IN ('owner_inbox', 'email', 'push', 'webhook')),
  state             TEXT NOT NULL DEFAULT 'created' CHECK (state IN (
                      'created', 'queued', 'attempted', 'delivered',
                      'failed', 'retry_scheduled', 'dead_letter', 'unconfigured'
                    )),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at   TIMESTAMPTZ NULL,
  error_class       TEXT NULL CHECK (error_class IS NULL OR error_class IN (
                      'TRANSIENT', 'PERMANENT', 'RATE_LIMITED', 'AUTHENTICATION',
                      'UNCONFIGURED', 'WORKER_LEASE_EXPIRED', 'UNKNOWN'
                    )),
  last_error        TEXT NULL CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  channel_ref       TEXT NULL CHECK (channel_ref IS NULL OR char_length(channel_ref) <= 300),
  lease_owner       TEXT NULL CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 120),
  lease_expires_at  TIMESTAMPTZ NULL,
  fencing_token     BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  queued_at         TIMESTAMPTZ NULL,
  attempted_at      TIMESTAMPTZ NULL,
  delivered_at      TIMESTAMPTZ NULL,
  failed_at         TIMESTAMPTZ NULL,
  dead_lettered_at  TIMESTAMPTZ NULL,
  UNIQUE (event_id, channel),
  CONSTRAINT forge_notification_delivered_requires_time CHECK (
    state <> 'delivered' OR delivered_at IS NOT NULL
  ),
  CONSTRAINT forge_notification_dead_letter_requires_time CHECK (
    state <> 'dead_letter' OR dead_lettered_at IS NOT NULL
  ),
  CONSTRAINT forge_notification_attempt_requires_lease CHECK (
    state <> 'attempted' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT forge_notification_unconfigured_shape CHECK (
    state <> 'unconfigured' OR (attempts = 0 AND delivered_at IS NULL AND error_class = 'UNCONFIGURED')
  ),
  CONSTRAINT forge_notification_retry_shape CHECK (
    next_attempt_at IS NULL OR state IN ('failed', 'retry_scheduled')
  )
);

CREATE INDEX IF NOT EXISTS idx_forge_notification_deliveries_due
  ON forge_notification_deliveries (state, next_attempt_at, created_at)
  WHERE state IN ('queued', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_forge_notification_deliveries_event
  ON forge_notification_deliveries (event_id, channel);

CREATE INDEX IF NOT EXISTS idx_forge_notification_deliveries_dead
  ON forge_notification_deliveries (dead_lettered_at DESC)
  WHERE state = 'dead_letter';

-- ---------------------------------------------------------------------------
-- Daily reports: exactly one per reporting date, with a canonical payload and
-- a SHA-256 evidence hash. Payload/hash are immutable once complete.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_daily_reports (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date            DATE NOT NULL UNIQUE,
  timezone               TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  window_start           TIMESTAMPTZ NOT NULL,
  window_end             TIMESTAMPTZ NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'generating'
                           CHECK (status IN ('generating', 'complete', 'failed')),
  payload                JSONB NULL CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  evidence_hash          CHAR(64) NULL CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[a-f0-9]{64}$'),
  evidence_refs          JSONB NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(evidence_refs) = 'array'),
  generated_at           TIMESTAMPTZ NULL,
  generation_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (generation_attempts >= 0),
  max_generation_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_generation_attempts BETWEEN 1 AND 10),
  failed_reason          TEXT NULL CHECK (failed_reason IS NULL OR char_length(failed_reason) <= 300),
  generation_lease_owner TEXT NULL CHECK (generation_lease_owner IS NULL OR char_length(generation_lease_owner) <= 120),
  generation_lease_expires_at TIMESTAMPTZ NULL,
  generation_fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (generation_fencing_token >= 0),
  notification_event_id  UUID NULL REFERENCES forge_notification_events(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT forge_daily_report_window_order CHECK (window_end > window_start),
  CONSTRAINT forge_daily_report_complete_shape CHECK (
    status <> 'complete'
    OR (payload IS NOT NULL AND evidence_hash IS NOT NULL AND generated_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_forge_daily_reports_status
  ON forge_daily_reports (status, report_date DESC);

CREATE OR REPLACE FUNCTION deny_forge_daily_report_payload_rewrite() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'complete' AND (
       NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
    OR NEW.report_date <> OLD.report_date
    OR NEW.window_start <> OLD.window_start
    OR NEW.window_end <> OLD.window_end
  ) THEN
    RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: a completed daily report payload is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS forge_daily_reports_immutable ON forge_daily_reports;
CREATE TRIGGER forge_daily_reports_immutable
  BEFORE UPDATE ON forge_daily_reports
  FOR EACH ROW EXECUTE FUNCTION deny_forge_daily_report_payload_rewrite();

-- ---------------------------------------------------------------------------
-- Durable schedule: single row, database-time next run, Owner-configurable.
-- The 08:00 Asia/Kolkata default is created by the report repository on first
-- use (Asia/Kolkata has no daylight saving, and the instant is computed from
-- the runtime IANA database). The worker advances it only when a run is due or
-- the Owner changes the schedule.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge_report_schedule (
  schedule_id        TEXT PRIMARY KEY DEFAULT 'forge_daily_report'
                       CHECK (schedule_id = 'forge_daily_report'),
  enabled            BOOLEAN NOT NULL DEFAULT true,
  timezone           TEXT NOT NULL DEFAULT 'Asia/Kolkata'
                       CHECK (char_length(timezone) BETWEEN 3 AND 64),
  local_hour         INTEGER NOT NULL DEFAULT 8 CHECK (local_hour BETWEEN 0 AND 23),
  local_minute       INTEGER NOT NULL DEFAULT 0 CHECK (local_minute BETWEEN 0 AND 59),
  missed_run_policy  TEXT NOT NULL DEFAULT 'RUN_ONCE_ON_RECOVERY'
                       CHECK (missed_run_policy IN ('RUN_ONCE_ON_RECOVERY', 'SKIP')),
  last_run_at        TIMESTAMPTZ NULL,
  last_report_date   DATE NULL,
  next_run_at        TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_by         UUID NULL REFERENCES owners(id) ON DELETE SET NULL
);

-- The schedule row itself is created idempotently by the report repository
-- (`ensureSchedule`) because the 08:00 Asia/Kolkata instant is computed from
-- the runtime's IANA database, not from a SQL time-zone literal. That keeps
-- the durable default correct in every environment and keeps this migration
-- portable across the PostgreSQL and demo SQL adapters.

COMMIT;
