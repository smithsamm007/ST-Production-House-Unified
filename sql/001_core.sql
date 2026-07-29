BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE provider_slot AS ENUM
  ('primary', 'secondary', 'tertiary', 'open_source_emergency');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'expired');
CREATE TYPE job_status AS ENUM
  ('queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter');

CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  namespace text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION enforce_agent_cap() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM agents) >= 50 THEN
    RAISE EXCEPTION 'AGENT_CAP_REACHED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_max_50
BEFORE INSERT ON agents
FOR EACH ROW EXECUTE FUNCTION enforce_agent_cap();

CREATE TABLE credential_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id),
  task_type text NOT NULL,
  slot provider_slot NOT NULL,
  provider text NOT NULL,
  secret_locator text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, task_type, slot),
  CHECK (
    (slot = 'open_source_emergency' AND secret_locator IS NULL)
    OR
    (slot <> 'open_source_emergency' AND secret_locator IS NOT NULL)
  )
);

CREATE TABLE product_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_identity text NOT NULL UNIQUE,
  identity_sha256 char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promo_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_identity_id uuid NOT NULL REFERENCES product_identities(id),
  owner_agent_id text NOT NULL REFERENCES agents(id),
  duplicate_authorized_by uuid REFERENCES owners(id),
  include_in_main_video boolean NOT NULL,
  target_episode_id uuid,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (include_in_main_video OR target_episode_id IS NULL),
  CHECK (NOT include_in_main_video OR target_episode_id IS NOT NULL)
);

CREATE TABLE promo_reels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_identity_id uuid NOT NULL UNIQUE REFERENCES product_identities(id),
  campaign_id uuid NOT NULL REFERENCES promo_campaigns(id),
  owner_agent_id text NOT NULL REFERENCES agents(id),
  status text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid,
  kind text NOT NULL,
  storage_uri text NOT NULL,
  sha256 char(64) NOT NULL,
  ffprobe_verified boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promo_reel_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_reel_id uuid NOT NULL REFERENCES promo_reels(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  artifact_id uuid REFERENCES artifacts(id),
  status text NOT NULL,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promo_reel_id, version_no)
);

CREATE TABLE main_video_promo_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES promo_campaigns(id),
  target_episode_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  approved_by uuid REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE affiliate_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES promo_campaigns(id),
  destination_url text NOT NULL,
  resolved_domain text NOT NULL,
  platform text NOT NULL,
  placement text NOT NULL,
  disclosure text NOT NULL,
  security_status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id),
  capability text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status job_status NOT NULL DEFAULT 'queued',
  priority integer NOT NULL DEFAULT 100,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  lease_owner text,
  lease_expires_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claimable_idx
  ON jobs (priority, created_at)
  WHERE status IN ('queued', 'leased');

CREATE TABLE provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  agent_id text NOT NULL REFERENCES agents(id),
  slot provider_slot NOT NULL,
  provider text NOT NULL,
  outcome text NOT NULL,
  provider_response_id text,
  error_code text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);

CREATE TABLE publishing_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  destination text NOT NULL,
  caption_snapshot text NOT NULL,
  mode text NOT NULL DEFAULT 'draft',
  status approval_status NOT NULL DEFAULT 'pending',
  approved_by uuid REFERENCES owners(id),
  approval_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publishing_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publishing_request_id uuid NOT NULL UNIQUE REFERENCES publishing_requests(id),
  platform_post_id text NOT NULL,
  platform_url text NOT NULL,
  provider_response_sha256 char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promotion_gateway_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES promo_campaigns(id),
  gateway text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL,
  verified_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id text NOT NULL,
  kind text NOT NULL,
  classification text NOT NULL,
  payload jsonb NOT NULL,
  previous_hash char(64),
  event_hash char(64) NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION deny_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EVIDENCE_EVENTS_ARE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_no_update
BEFORE UPDATE OR DELETE ON evidence_events
FOR EACH ROW EXECUTE FUNCTION deny_evidence_mutation();

COMMIT;
