BEGIN;
-- Rollback for sql/044_durable_notifications_and_daily_reports.sql.
-- Drops only the objects 044 created. 001–043 objects (including the D5
-- approval outbox in 043) are untouched.

DROP TRIGGER IF EXISTS forge_daily_reports_immutable ON forge_daily_reports;
DROP FUNCTION IF EXISTS deny_forge_daily_report_payload_rewrite();

DROP TABLE IF EXISTS forge_report_schedule;
DROP TABLE IF EXISTS forge_daily_reports;
DROP TABLE IF EXISTS forge_notification_deliveries;
DROP TABLE IF EXISTS forge_notification_events;
DROP TABLE IF EXISTS forge_notification_channels;

COMMIT;
