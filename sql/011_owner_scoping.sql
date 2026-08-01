BEGIN;

-- 1. Add owner_id to agents, jobs, publishing_requests, publishing_receipts, and evidence_events (Blocker #9)
ALTER TABLE agents ADD COLUMN owner_id uuid REFERENCES owners(id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN owner_id uuid REFERENCES owners(id) ON DELETE CASCADE;
ALTER TABLE publishing_requests ADD COLUMN owner_id uuid REFERENCES owners(id) ON DELETE CASCADE;
ALTER TABLE publishing_receipts ADD COLUMN owner_id uuid REFERENCES owners(id) ON DELETE CASCADE;
ALTER TABLE evidence_events ADD COLUMN owner_id uuid REFERENCES owners(id) ON DELETE CASCADE;

-- 2. Backfill existing preloaded agents/evidence to the first registered owner during bootstrap if exists
UPDATE agents SET owner_id = (SELECT id FROM owners ORDER BY created_at ASC LIMIT 1) WHERE owner_id IS NULL;
UPDATE evidence_events SET owner_id = (SELECT id FROM owners ORDER BY created_at ASC LIMIT 1) WHERE owner_id IS NULL;

-- 3. Create indexes for high-performance owner scoping checks
CREATE INDEX IF NOT EXISTS agents_owner_id_idx ON agents (owner_id);
CREATE INDEX IF NOT EXISTS jobs_owner_id_idx ON jobs (owner_id);
CREATE INDEX IF NOT EXISTS publishing_requests_owner_id_idx ON publishing_requests (owner_id);
CREATE INDEX IF NOT EXISTS publishing_receipts_owner_id_idx ON publishing_receipts (owner_id);
CREATE INDEX IF NOT EXISTS evidence_events_owner_id_idx ON evidence_events (owner_id);

-- 4. Prevent NULL/unowned protected resources once bootstrapped (Blocker #9)
CREATE OR REPLACE FUNCTION enforce_owner_scoping_trigger() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_id IS NULL AND EXISTS (SELECT 1 FROM owners) THEN
    RAISE EXCEPTION 'owner_id cannot be NULL once bootstrapped';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_owner_scoping_trigger
BEFORE INSERT ON agents
FOR EACH ROW EXECUTE FUNCTION enforce_owner_scoping_trigger();

CREATE TRIGGER jobs_owner_scoping_trigger
BEFORE INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION enforce_owner_scoping_trigger();

CREATE TRIGGER publishing_requests_owner_scoping_trigger
BEFORE INSERT ON publishing_requests
FOR EACH ROW EXECUTE FUNCTION enforce_owner_scoping_trigger();

CREATE TRIGGER publishing_receipts_owner_scoping_trigger
BEFORE INSERT ON publishing_receipts
FOR EACH ROW EXECUTE FUNCTION enforce_owner_scoping_trigger();

CREATE TRIGGER evidence_events_owner_scoping_trigger
BEFORE INSERT ON evidence_events
FOR EACH ROW EXECUTE FUNCTION enforce_owner_scoping_trigger();

-- 5. Enforce database-level publishing-receipt validity (Blocker #7/11)
CREATE OR REPLACE FUNCTION enforce_publishing_receipt_trigger() RETURNS trigger AS $$
DECLARE
  v_req_mode text;
BEGIN
  -- Fetch the associated request mode
  SELECT mode INTO v_req_mode FROM publishing_requests WHERE id = NEW.publishing_request_id;

  -- If request mode is draft or unapproved, reject inserting a publishing receipt
  IF v_req_mode IS NULL OR v_req_mode <> 'live' THEN
    RAISE EXCEPTION 'INVALID_PUBLISHING_RECEIPT_FOR_NON_LIVE_REQUEST';
  END IF;

  -- Verify basic platform fields are present and valid
  IF NEW.platform_post_id IS NULL OR length(trim(NEW.platform_post_id)) = 0 OR
     NEW.platform_url IS NULL OR NOT (NEW.platform_url LIKE 'https://%') OR
     NEW.provider_response_sha256 IS NULL OR length(trim(NEW.provider_response_sha256)) <> 64 THEN
    RAISE EXCEPTION 'INVALID_PUBLISHING_RECEIPT_FIELDS';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_receipt_validity
BEFORE INSERT ON publishing_receipts
FOR EACH ROW EXECUTE FUNCTION enforce_publishing_receipt_trigger();

COMMIT;
