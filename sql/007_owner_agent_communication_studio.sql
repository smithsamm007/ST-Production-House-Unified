BEGIN;

-- 1. communication_sessions
CREATE TABLE communication_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  active_question_id uuid, -- Tracks currently active interview question
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. communication_messages
CREATE TABLE communication_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES communication_sessions(id) ON DELETE CASCADE,
  sender text NOT NULL, -- 'owner', 'agent', 'system'
  message_type text NOT NULL, -- 'owner_decision', 'owner_question', 'agent_question', 'agent_suggestion', 'agent_explanation', 'validation_warning', 'system_status'
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_sender CHECK (sender IN ('owner', 'agent', 'system')),
  CONSTRAINT valid_msg_type CHECK (message_type IN (
    'owner_decision', 'owner_question', 'agent_question', 'agent_suggestion', 'agent_explanation', 'validation_warning', 'system_status'
  )),
  CONSTRAINT non_empty_msg_content CHECK (length(trim(content)) > 0),

  -- Sender/message-type combinations check
  CONSTRAINT valid_sender_msg_combination CHECK (
    (sender = 'owner' AND message_type IN ('owner_decision', 'owner_question'))
    OR
    (sender = 'agent' AND message_type IN ('agent_question', 'agent_suggestion', 'agent_explanation'))
    OR
    (sender = 'system' AND message_type IN ('validation_warning', 'system_status'))
  )
);

-- 3. blueprint_drafts
CREATE TABLE blueprint_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  communication_session_id uuid REFERENCES communication_sessions(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  universe_id uuid REFERENCES creative_universes(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  predecessor_version_id uuid, -- Link to predecessor approved version (Correction 5)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. blueprint_versions
CREATE TABLE blueprint_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'unapproved', -- 'unapproved', 'approved', 'superseded'
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE, -- copied scope fields (Correction 2)
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  universe_id uuid REFERENCES creative_universes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blueprint_id, version_no),
  CONSTRAINT valid_snapshot_hash CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT valid_version_status CHECK (status IN ('unapproved', 'approved', 'superseded'))
);

-- Add foreign key from blueprint_drafts to blueprint_versions for predecessor lineage
ALTER TABLE blueprint_drafts
  ADD CONSTRAINT fk_blueprint_drafts_predecessor_version
  FOREIGN KEY (predecessor_version_id) REFERENCES blueprint_versions(id) ON DELETE SET NULL;

-- Database-enforced uniqueness strategy for exactly one current approved version per scope (Correction 2)
CREATE UNIQUE INDEX blueprint_versions_one_active_approved_scope_idx
  ON blueprint_versions (owner_id, agent_id, COALESCE(universe_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE (status = 'approved');

-- 5. blueprint_decisions
CREATE TABLE blueprint_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  section_no integer NOT NULL CHECK (section_no BETWEEN 1 AND 22),
  decision_value text NOT NULL,
  provenance text NOT NULL, -- 'direct_owner', 'accepted_suggestion', 'accepted_proposed_change', 'owner_direct_edit'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6. blueprint_suggestions
CREATE TABLE blueprint_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  section_no integer NOT NULL CHECK (section_no BETWEEN 1 AND 22),
  suggestion_value text NOT NULL,
  status text NOT NULL DEFAULT 'proposed', -- 'proposed', 'accepted', 'rejected', 'superseded'
  provenance text NOT NULL,
  decision_id uuid REFERENCES blueprint_decisions(id) ON DELETE SET NULL,
  confidence integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_suggestion_status CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  CONSTRAINT non_empty_suggest_value CHECK (length(trim(suggestion_value)) > 0),
  CONSTRAINT valid_confidence_range CHECK (confidence BETWEEN 0 AND 100)
);

-- 7. blueprint_unresolved_questions (Correction 6)
CREATE TABLE blueprint_unresolved_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  communication_session_id uuid NOT NULL REFERENCES communication_sessions(id) ON DELETE CASCADE,
  section_no integer NOT NULL CHECK (section_no BETWEEN 1 AND 22),
  question_text text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index enforcing exactly one active question per session (Correction 6)
CREATE UNIQUE INDEX blueprint_unresolved_questions_active_session_idx
  ON blueprint_unresolved_questions (communication_session_id)
  WHERE (is_active = TRUE);

-- 8. blueprint_validation_results
CREATE TABLE blueprint_validation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  snapshot_hash char(64) NOT NULL,
  is_valid boolean NOT NULL,
  errors text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_val_res_hash CHECK (snapshot_hash ~ '^[a-f0-9]{64}$')
);

-- 9. blueprint_owner_approvals (Correction 2, 7)
CREATE TABLE blueprint_owner_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_version_id uuid NOT NULL REFERENCES blueprint_versions(id) ON DELETE CASCADE,
  snapshot_hash char(64) NOT NULL,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  approved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_approval_hash CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  UNIQUE (blueprint_version_id)
);

-- 10. proposed_changes (Correction 2)
CREATE TABLE proposed_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES communication_sessions(id) ON DELETE CASCADE,
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  section_no integer NOT NULL CHECK (section_no BETWEEN 1 AND 22),
  raw_answer text NOT NULL,
  proposed_value jsonb NOT NULL,
  provenance text NOT NULL,
  status text NOT NULL DEFAULT 'proposed', -- 'proposed', 'accepted', 'rejected', 'superseded'
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_proposed_status CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  CONSTRAINT non_empty_raw_answer CHECK (length(trim(raw_answer)) > 0)
);

-- ----------------------------------------------------
-- IMMUTABILITY SECURITY TRIGGERS & CONSTRAINTS
-- ----------------------------------------------------

-- Deny updates/deletes of owner approval records
CREATE OR REPLACE FUNCTION deny_blueprint_approval_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BLUEPRINT_APPROVAL_RECORDS_ARE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blueprint_approval_no_mutation
  BEFORE UPDATE OR DELETE ON blueprint_owner_approvals
  FOR EACH ROW
  EXECUTE FUNCTION deny_blueprint_approval_mutation();

-- Deny modification of approved version snapshots
CREATE OR REPLACE FUNCTION check_blueprint_version_immutability() RETURNS trigger AS $$
DECLARE
  v_has_approval boolean;
BEGIN
  -- If old version already has an approval, prevent any mutation of blueprint contents
  SELECT EXISTS(SELECT 1 FROM blueprint_owner_approvals WHERE blueprint_version_id = OLD.id) INTO v_has_approval;
  IF v_has_approval OR OLD.status = 'approved' THEN
    -- Legitimate transitions like changing status from approved to superseded are allowed, but snapshot must remain untouched!
    IF (NEW.snapshot <> OLD.snapshot OR NEW.snapshot_hash <> OLD.snapshot_hash) THEN
      RAISE EXCEPTION 'APPROVED_BLUEPRINT_VERSIONS_ARE_IMMUTABLE';
    END IF;
    -- Also prevent changing from 'approved' back to 'unapproved'
    IF OLD.status = 'approved' AND NEW.status = 'unapproved' THEN
      RAISE EXCEPTION 'CANNOT_REVERT_APPROVED_VERSION_STATUS_TO_UNAPPROVED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blueprint_version_immutability
  BEFORE UPDATE ON blueprint_versions
  FOR EACH ROW
  EXECUTE FUNCTION check_blueprint_version_immutability();

-- Trigger preventing deletion of approved blueprint versions
CREATE OR REPLACE FUNCTION check_blueprint_version_deletion() RETURNS trigger AS $$
DECLARE
  v_has_approval boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM blueprint_owner_approvals WHERE blueprint_version_id = OLD.id) INTO v_has_approval;
  IF v_has_approval THEN
    RAISE EXCEPTION 'CANNOT_DELETE_APPROVED_BLUEPRINT_VERSION';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blueprint_version_no_delete
  BEFORE DELETE ON blueprint_versions
  FOR EACH ROW
  EXECUTE FUNCTION check_blueprint_version_deletion();

-- Enforce parent-draft scope binding on blueprint_versions (Correction 2)
CREATE OR REPLACE FUNCTION verify_blueprint_version_scope_binding() RETURNS trigger AS $$
DECLARE
  v_draft_owner_id uuid;
  v_draft_agent_id text;
  v_draft_universe_id uuid;
BEGIN
  SELECT owner_id, agent_id, universe_id INTO v_draft_owner_id, v_draft_agent_id, v_draft_universe_id
    FROM blueprint_drafts WHERE id = NEW.blueprint_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARENT_BLUEPRINT_DRAFT_NOT_FOUND';
  END IF;

  -- Version owner_id must match draft owner_id
  IF NEW.owner_id <> v_draft_owner_id THEN
    RAISE EXCEPTION 'VERSION_OWNER_ID_MUST_MATCH_DRAFT';
  END IF;

  -- Version agent_id must match draft agent_id
  IF NEW.agent_id <> v_draft_agent_id THEN
    RAISE EXCEPTION 'VERSION_AGENT_ID_MUST_MATCH_DRAFT';
  END IF;

  -- Version universe_id must match draft universe_id, including NULL handling
  IF (NEW.universe_id IS DISTINCT FROM v_draft_universe_id) THEN
    RAISE EXCEPTION 'VERSION_UNIVERSE_ID_MUST_MATCH_DRAFT';
  END IF;

  -- Blueprint scope is immutable after creation
  IF TG_OP = 'UPDATE' THEN
    IF OLD.owner_id <> NEW.owner_id OR OLD.agent_id <> NEW.agent_id OR OLD.universe_id IS DISTINCT FROM NEW.universe_id THEN
      RAISE EXCEPTION 'VERSION_SCOPE_IS_IMMUTABLE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blueprint_version_scope_verify_trigger
  BEFORE INSERT OR UPDATE ON blueprint_versions
  FOR EACH ROW
  EXECUTE FUNCTION verify_blueprint_version_scope_binding();

-- Verification of Blueprint Approval Constraints (Correction 2, 7)
CREATE OR REPLACE FUNCTION verify_blueprint_approval_constraints() RETURNS trigger AS $$
DECLARE
  v_version_hash char(64);
  v_version_blueprint_id uuid;
  v_blueprint_owner_id uuid;
  v_validation_valid boolean;
  v_has_open_questions boolean;
  v_version_status text;
  v_owner_id uuid;
  v_agent_id text;
  v_universe_id uuid;
BEGIN
  -- 1. verify the version exists
  SELECT blueprint_id, snapshot_hash, status INTO v_version_blueprint_id, v_version_hash, v_version_status
    FROM blueprint_versions WHERE id = NEW.blueprint_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLUEPRINT_VERSION_NOT_FOUND';
  END IF;

  -- 2. requires version status = 'unapproved'
  IF v_version_status <> 'unapproved' THEN
    RAISE EXCEPTION 'VERSION_MUST_BE_UNAPPROVED_BEFORE_APPROVAL';
  END IF;

  -- 3. verify the submitted hash matches the version snapshot hash
  IF NEW.snapshot_hash <> v_version_hash THEN
    RAISE EXCEPTION 'SNAPSHOT_HASH_MISMATCH';
  END IF;

  -- 4. verify the version belongs to the approving owner
  SELECT owner_id, agent_id, universe_id INTO v_owner_id, v_agent_id, v_universe_id
    FROM blueprint_drafts WHERE id = v_version_blueprint_id;

  IF NEW.owner_id <> v_owner_id THEN
    RAISE EXCEPTION 'OWNER_MISMATCH';
  END IF;

  -- 5. require a successful validation result for the exact snapshot hash
  SELECT is_valid INTO v_validation_valid
    FROM blueprint_validation_results
    WHERE blueprint_id = v_version_blueprint_id AND snapshot_hash = NEW.snapshot_hash
    LIMIT 1;

  IF NOT FOUND OR v_validation_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'NO_VALID_VALIDATION_RESULT_FOUND_FOR_HASH';
  END IF;

  -- 6. require zero active blocking questions
  SELECT EXISTS(
    SELECT 1 FROM blueprint_unresolved_questions
    WHERE blueprint_id = v_version_blueprint_id AND is_active = TRUE
  ) INTO v_has_open_questions;

  IF v_has_open_questions THEN
    RAISE EXCEPTION 'BLUEPRINT_HAS_ACTIVE_BLOCKING_QUESTIONS';
  END IF;

  -- 7. transaction-safe lock (Correction 2)
  PERFORM pg_advisory_xact_lock((hashtext(v_owner_id::text)::bigint + hashtext(v_agent_id)::bigint + COALESCE(hashtext(v_universe_id::text), 0)::bigint)::bigint);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blueprint_owner_approval_insert_verify
  BEFORE INSERT ON blueprint_owner_approvals
  FOR EACH ROW
  EXECUTE FUNCTION verify_blueprint_approval_constraints();

-- Post-approval operations: Atomic state transitions (Correction 2)
CREATE OR REPLACE FUNCTION post_blueprint_approval_operations() RETURNS trigger AS $$
DECLARE
  v_blueprint_id uuid;
  v_owner_id uuid;
  v_agent_id text;
  v_universe_id uuid;
BEGIN
  -- Retrieve blueprint draft id
  SELECT blueprint_id INTO v_blueprint_id FROM blueprint_versions WHERE id = NEW.blueprint_version_id;

  -- Retrieve scope elements
  SELECT owner_id, agent_id, universe_id INTO v_owner_id, v_agent_id, v_universe_id
    FROM blueprint_drafts WHERE id = v_blueprint_id;

  -- 1. supersede the previously approved versions in the same owner/agent/universe scope (Correction 2)
  UPDATE blueprint_versions
    SET status = 'superseded', updated_at = now()
    WHERE id <> NEW.blueprint_version_id
      AND status = 'approved'
      AND owner_id = v_owner_id
      AND agent_id = v_agent_id
      AND (universe_id = v_universe_id OR (universe_id IS NULL AND v_universe_id IS NULL));

  -- 2. change the approved version status to 'approved'
  UPDATE blueprint_versions
    SET status = 'approved', updated_at = now()
    WHERE id = NEW.blueprint_version_id;

  -- 3. deactivate the corresponding draft
  UPDATE blueprint_drafts
    SET is_active = false, updated_at = now()
    WHERE id = v_blueprint_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blueprint_owner_approval_after_insert
  AFTER INSERT ON blueprint_owner_approvals
  FOR EACH ROW
  EXECUTE FUNCTION post_blueprint_approval_operations();

-- Trigger applications for updated_at column automatic updating
CREATE TRIGGER update_communication_sessions_updated_at BEFORE UPDATE ON communication_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_blueprint_drafts_updated_at BEFORE UPDATE ON blueprint_drafts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_blueprint_versions_updated_at BEFORE UPDATE ON blueprint_versions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_blueprint_decisions_updated_at BEFORE UPDATE ON blueprint_decisions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_blueprint_suggestions_updated_at BEFORE UPDATE ON blueprint_suggestions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_blueprint_unresolved_questions_updated_at BEFORE UPDATE ON blueprint_unresolved_questions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_blueprint_validation_results_updated_at BEFORE UPDATE ON blueprint_validation_results FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_blueprint_owner_approvals_updated_at BEFORE UPDATE ON blueprint_owner_approvals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
