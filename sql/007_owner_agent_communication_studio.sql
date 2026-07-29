BEGIN;

-- 1. communication_sessions
CREATE TABLE communication_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
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
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  universe_id uuid REFERENCES creative_universes(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX blueprint_drafts_active_idx
  ON blueprint_drafts (agent_id)
  WHERE (is_active = true);

-- 4. blueprint_versions
CREATE TABLE blueprint_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'unapproved', -- 'unapproved', 'approved', 'superseded'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blueprint_id, version_no),
  CONSTRAINT valid_snapshot_hash CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT valid_version_status CHECK (status IN ('unapproved', 'approved', 'superseded'))
);

-- 5. blueprint_decisions
CREATE TABLE blueprint_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  section_no integer NOT NULL CHECK (section_no BETWEEN 1 AND 22),
  decision_value text NOT NULL,
  provenance text NOT NULL, -- 'direct_owner', 'accepted_suggestion'
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

-- 7. blueprint_unresolved_questions
CREATE TABLE blueprint_unresolved_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  section_no integer NOT NULL CHECK (section_no BETWEEN 1 AND 22),
  question_text text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 8. blueprint_validation_results
CREATE TABLE blueprint_validation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES blueprint_drafts(id) ON DELETE CASCADE,
  snapshot_hash char(64) NOT NULL,
  is_valid boolean NOT NULL,
  errors text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 9. blueprint_owner_approvals
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

-- ----------------------------------------------------
-- IMMUTABILITY SECURITY TRIGGERS
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
  SELECT EXISTS(SELECT 1 FROM blueprint_owner_approvals WHERE blueprint_version_id = OLD.id) INTO v_has_approval;
  IF v_has_approval THEN
    IF (NEW.snapshot <> OLD.snapshot OR NEW.snapshot_hash <> OLD.snapshot_hash) THEN
      RAISE EXCEPTION 'APPROVED_BLUEPRINT_VERSIONS_ARE_IMMUTABLE';
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
