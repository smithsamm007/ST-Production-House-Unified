-- 047 — Five-platform parity (add bilibili across publish_destinations,
-- owner_analytics_records, and forge_publishing_approvals).
--
-- Additive / idempotent PG15 migration; never edits migrations 001-046.
BEGIN;

ALTER TABLE publish_destinations
  DROP CONSTRAINT IF EXISTS publish_destinations_platform_check;
ALTER TABLE publish_destinations
  ADD CONSTRAINT publish_destinations_platform_check
  CHECK (platform IN ('youtube', 'instagram', 'facebook', 'snapchat', 'bilibili'));

ALTER TABLE owner_analytics_records
  DROP CONSTRAINT IF EXISTS owner_analytics_records_platform_check;
ALTER TABLE owner_analytics_records
  ADD CONSTRAINT owner_analytics_records_platform_check
  CHECK (platform IN ('youtube', 'instagram', 'facebook', 'snapchat', 'bilibili'));

ALTER TABLE forge_publishing_approvals
  DROP CONSTRAINT IF EXISTS forge_publishing_approvals_destinations_check;
ALTER TABLE forge_publishing_approvals
  ADD CONSTRAINT forge_publishing_approvals_destinations_check
  CHECK (array_length(destinations, 1) BETWEEN 1 AND 5);

COMMIT;
