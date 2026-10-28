BEGIN;

-- 1. creative_references
CREATE TABLE creative_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  universe_id uuid NOT NULL REFERENCES creative_universes(id) ON DELETE CASCADE,
  reference_type text NOT NULL, -- 'niche', 'visual'
  reference_subclassification text NOT NULL, -- 'youtube_channel', 'youtube_video', 'youtube_playlist', 'written_brief', 'authorized_image', 'uploaded_asset_metadata'
  title text NOT NULL,
  canonical_url text,
  original_url text,
  priority integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'submitted',
  written_brief text,
  owner_notes text,
  desired_characteristics text,
  characteristics_to_avoid text,
  language text DEFAULT 'en',
  tags text[] NOT NULL DEFAULT '{}',

  -- Visual specific inputs
  start_timestamp numeric,
  end_timestamp numeric,
  authorized_image_reference text,
  uploaded_asset_metadata_reference jsonb,
  declared_authorization_status text DEFAULT 'pending',

  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT valid_reference_type CHECK (reference_type IN ('niche', 'visual')),
  CONSTRAINT valid_reference_subclass CHECK (reference_subclassification IN (
    'youtube_channel', 'youtube_video', 'youtube_playlist', 'written_brief', 'authorized_image', 'uploaded_asset_metadata'
  )),
  CONSTRAINT valid_auth_status CHECK (declared_authorization_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT valid_priority CHECK (priority BETWEEN 1 AND 1000),
  CONSTRAINT positive_ref_revision CHECK (revision > 0),
  CONSTRAINT non_empty_title CHECK (length(trim(title)) > 0),

  CONSTRAINT valid_analysis_status CHECK (status IN (
    'submitted', 'validation_failed', 'awaiting_analysis', 'analysis_in_progress',
    'analysis_failed', 'draft_profile_ready', 'awaiting_owner_review', 'approved', 'rejected', 'inactive'
  )),

  -- Timestamp independent constraints and ordering check
  CONSTRAINT valid_start_timestamp CHECK (start_timestamp IS NULL OR start_timestamp >= 0),
  CONSTRAINT valid_end_timestamp CHECK (end_timestamp IS NULL OR end_timestamp >= 0),
  CONSTRAINT valid_timestamp_ordering CHECK (
    end_timestamp IS NULL OR start_timestamp IS NULL OR (end_timestamp >= start_timestamp)
  ),

  -- Meaningful reference input constraints
  CONSTRAINT meaningful_input_check CHECK (
    (reference_type = 'niche' AND (canonical_url IS NOT NULL OR (written_brief IS NOT NULL AND length(trim(written_brief)) > 0)))
    OR
    (reference_type = 'visual' AND (canonical_url IS NOT NULL OR (written_brief IS NOT NULL AND length(trim(written_brief)) > 0) OR authorized_image_reference IS NOT NULL OR uploaded_asset_metadata_reference IS NOT NULL))
  )
);

CREATE UNIQUE INDEX unique_canonical_reference_idx
  ON creative_references (universe_id, reference_type, canonical_url)
  WHERE (canonical_url IS NOT NULL);

-- 2. niche_reference_profiles
CREATE TABLE niche_reference_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  is_active boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_niche_profile_status CHECK (status IN (
    'submitted', 'validation_failed', 'awaiting_analysis', 'analysis_in_progress',
    'analysis_failed', 'draft_profile_ready', 'awaiting_owner_review', 'approved', 'rejected', 'inactive'
  )),
  CONSTRAINT positive_niche_prof_revision CHECK (revision > 0),
  CONSTRAINT valid_hash_format CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT active_requires_approved CHECK (is_active = false OR status = 'approved')
);

CREATE UNIQUE INDEX niche_reference_profiles_active_idx
  ON niche_reference_profiles (reference_id)
  WHERE (is_active = true);

-- 3. visual_reference_profiles
CREATE TABLE visual_reference_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  is_active boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_visual_profile_status CHECK (status IN (
    'submitted', 'validation_failed', 'awaiting_analysis', 'analysis_in_progress',
    'analysis_failed', 'draft_profile_ready', 'awaiting_owner_review', 'approved', 'rejected', 'inactive'
  )),
  CONSTRAINT positive_visual_prof_revision CHECK (revision > 0),
  CONSTRAINT valid_visual_hash_format CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT active_requires_approved_visual CHECK (is_active = false OR status = 'approved')
);

CREATE UNIQUE INDEX visual_reference_profiles_active_idx
  ON visual_reference_profiles (reference_id)
  WHERE (is_active = true);

-- 4. reference_scope_assignments
CREATE TABLE reference_scope_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE CASCADE,
  niche_profile_id uuid REFERENCES niche_reference_profiles(id) ON DELETE SET NULL,
  visual_profile_id uuid REFERENCES visual_reference_profiles(id) ON DELETE SET NULL,
  scope_type text NOT NULL, -- 'universe', 'series', 'season', 'story_arc', 'episode', 'standalone_reel', 'main_video_promo'
  scope_target_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_scope_type CHECK (scope_type IN ('universe', 'series', 'season', 'story_arc', 'episode', 'standalone_reel', 'main_video_promo'))
);

CREATE UNIQUE INDEX reference_scope_assignment_active_idx
  ON reference_scope_assignments (scope_type, scope_target_id, reference_id)
  WHERE (is_active = true);

-- 5. reference_analysis_attempts
CREATE TABLE reference_analysis_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE CASCADE,
  status text NOT NULL, -- 'pending', 'succeeded', 'failed'
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_attempt_status CHECK (status IN ('pending', 'succeeded', 'failed'))
);

-- 6. reference_owner_approvals
CREATE TABLE reference_owner_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  niche_profile_id uuid REFERENCES niche_reference_profiles(id) ON DELETE CASCADE,
  visual_profile_id uuid REFERENCES visual_reference_profiles(id) ON DELETE CASCADE,
  snapshot_hash char(64) NOT NULL,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  approved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT separate_approval_types CHECK (
    (niche_profile_id IS NOT NULL AND visual_profile_id IS NULL)
    OR
    (niche_profile_id IS NULL AND visual_profile_id IS NOT NULL)
  ),
  CONSTRAINT valid_approval_hash CHECK (snapshot_hash ~ '^[a-f0-9]{64}$')
);

-- ----------------------------------------------------
-- SECURITY AND TYPE SEPARATION TRIGGERS
-- ----------------------------------------------------

-- Enforce Type Separation: Niche profile must reference a Niche Reference
CREATE OR REPLACE FUNCTION verify_niche_profile_type() RETURNS trigger AS $$
DECLARE
  ref_type text;
BEGIN
  SELECT reference_type INTO ref_type FROM creative_references WHERE id = NEW.reference_id;
  IF ref_type <> 'niche' THEN
    RAISE EXCEPTION 'PROFILE_TYPE_MISMATCH_WITH_REFERENCE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_niche_profile_type
  BEFORE INSERT OR UPDATE ON niche_reference_profiles
  FOR EACH ROW
  EXECUTE FUNCTION verify_niche_profile_type();

-- Enforce Type Separation: Visual profile must reference a Visual Reference
CREATE OR REPLACE FUNCTION verify_visual_profile_type() RETURNS trigger AS $$
DECLARE
  ref_type text;
BEGIN
  SELECT reference_type INTO ref_type FROM creative_references WHERE id = NEW.reference_id;
  IF ref_type <> 'visual' THEN
    RAISE EXCEPTION 'PROFILE_TYPE_MISMATCH_WITH_REFERENCE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_visual_profile_type
  BEFORE INSERT OR UPDATE ON visual_reference_profiles
  FOR EACH ROW
  EXECUTE FUNCTION verify_visual_profile_type();

-- Enforce Scope Profile Type Separation & Exact SQL Scope Bindings
CREATE OR REPLACE FUNCTION verify_scope_profile_types() RETURNS trigger AS $$
DECLARE
  ref_type text;
  ref_universe uuid;
  p_ref_id uuid;
  p_status text;
BEGIN
  SELECT reference_type, universe_id INTO ref_type, ref_universe
    FROM creative_references WHERE id = NEW.reference_id;

  -- Verify niche profile binding and reference
  IF NEW.niche_profile_id IS NOT NULL THEN
    SELECT reference_id, status INTO p_ref_id, p_status
      FROM niche_reference_profiles WHERE id = NEW.niche_profile_id;
    IF p_ref_id <> NEW.reference_id THEN
      RAISE EXCEPTION 'PROFILE_MUST_BELONG_TO_SAME_REFERENCE';
    END IF;
    IF ref_type <> 'niche' THEN
      RAISE EXCEPTION 'INVALID_PROFILE_TYPE_PLACEMENT';
    END IF;
    IF p_status <> 'approved' THEN
      RAISE EXCEPTION 'PROFILE_MUST_BE_APPROVED_IMMUTABLE';
    END IF;
  END IF;

  -- Verify visual profile binding and reference
  IF NEW.visual_profile_id IS NOT NULL THEN
    SELECT reference_id, status INTO p_ref_id, p_status
      FROM visual_reference_profiles WHERE id = NEW.visual_profile_id;
    IF p_ref_id <> NEW.reference_id THEN
      RAISE EXCEPTION 'PROFILE_MUST_BELONG_TO_SAME_REFERENCE';
    END IF;
    IF ref_type <> 'visual' THEN
      RAISE EXCEPTION 'INVALID_PROFILE_TYPE_PLACEMENT';
    END IF;
    IF p_status <> 'approved' THEN
      RAISE EXCEPTION 'PROFILE_MUST_BE_APPROVED_IMMUTABLE';
    END IF;
  END IF;

  -- Verify scope target matches universe reference
  IF NEW.scope_type = 'universe' THEN
    IF NEW.scope_target_id <> ref_universe THEN
      RAISE EXCEPTION 'SCOPE_TARGET_MUST_MATCH_REFERENCE_UNIVERSE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_scope_profile_types
  BEFORE INSERT OR UPDATE ON reference_scope_assignments
  FOR EACH ROW
  EXECUTE FUNCTION verify_scope_profile_types();

-- Enforce Immutability: Deny updates/deletes of approvals
CREATE OR REPLACE FUNCTION deny_approval_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPROVAL_RECORDS_ARE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approvals_no_mutation
  BEFORE UPDATE OR DELETE ON reference_owner_approvals
  FOR EACH ROW
  EXECUTE FUNCTION deny_approval_mutation();

-- Enforce Immutability: Deny modification of approved profile snapshots/hashes based on approvals
CREATE OR REPLACE FUNCTION check_profile_immutability() RETURNS trigger AS $$
DECLARE
  v_has_approval boolean;
BEGIN
  IF TG_TABLE_NAME = 'niche_reference_profiles' THEN
    SELECT EXISTS(SELECT 1 FROM reference_owner_approvals WHERE niche_profile_id = OLD.id) INTO v_has_approval;
  ELSE
    SELECT EXISTS(SELECT 1 FROM reference_owner_approvals WHERE visual_profile_id = OLD.id) INTO v_has_approval;
  END IF;

  IF v_has_approval THEN
    IF (NEW.snapshot <> OLD.snapshot OR NEW.snapshot_hash <> OLD.snapshot_hash) THEN
      RAISE EXCEPTION 'APPROVED_PROFILES_ARE_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER niche_profile_immutability
  BEFORE UPDATE ON niche_reference_profiles
  FOR EACH ROW
  EXECUTE FUNCTION check_profile_immutability();

CREATE TRIGGER visual_profile_immutability
  BEFORE UPDATE ON visual_reference_profiles
  FOR EACH ROW
  EXECUTE FUNCTION check_profile_immutability();

-- Trigger preventing deletion of approved profiles
CREATE OR REPLACE FUNCTION check_profile_deletion() RETURNS trigger AS $$
DECLARE
  v_has_approval boolean;
BEGIN
  IF TG_TABLE_NAME = 'niche_reference_profiles' THEN
    SELECT EXISTS(SELECT 1 FROM reference_owner_approvals WHERE niche_profile_id = OLD.id) INTO v_has_approval;
  ELSE
    SELECT EXISTS(SELECT 1 FROM reference_owner_approvals WHERE visual_profile_id = OLD.id) INTO v_has_approval;
  END IF;

  IF v_has_approval THEN
    RAISE EXCEPTION 'CANNOT_DELETE_APPROVED_PROFILE';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER niche_profile_no_delete
  BEFORE DELETE ON niche_reference_profiles
  FOR EACH ROW
  EXECUTE FUNCTION check_profile_deletion();

CREATE TRIGGER visual_profile_no_delete
  BEFORE DELETE ON visual_reference_profiles
  FOR EACH ROW
  EXECUTE FUNCTION check_profile_deletion();

-- Enforce Database Approval Binding rules before insert
CREATE OR REPLACE FUNCTION verify_reference_approval_binding() RETURNS trigger AS $$
DECLARE
  p_ref_id uuid;
  p_status text;
  p_hash char(64);
  ref_owner uuid;
  ref_type text;
BEGIN
  IF (NEW.niche_profile_id IS NOT NULL AND NEW.visual_profile_id IS NOT NULL) OR
     (NEW.niche_profile_id IS NULL AND NEW.visual_profile_id IS NULL) THEN
    RAISE EXCEPTION 'EXACTLY_ONE_PROFILE_ID_REQUIRED';
  END IF;

  IF NEW.niche_profile_id IS NOT NULL THEN
    SELECT reference_id, status, snapshot_hash INTO p_ref_id, p_status, p_hash
      FROM niche_reference_profiles WHERE id = NEW.niche_profile_id;

    IF p_ref_id IS NULL THEN
      RAISE EXCEPTION 'PROFILE_NOT_FOUND';
    END IF;
    IF p_status <> 'awaiting_owner_review' THEN
      RAISE EXCEPTION 'PROFILE_MUST_BE_AWAITING_OWNER_REVIEW';
    END IF;
    IF NEW.snapshot_hash <> p_hash THEN
      RAISE EXCEPTION 'SNAPSHOT_HASH_MISMATCH';
    END IF;

    SELECT owner_id, reference_type INTO ref_owner, ref_type FROM creative_references WHERE id = p_ref_id;
    IF ref_owner <> NEW.owner_id THEN
      RAISE EXCEPTION 'APPROVAL_OWNER_MISMATCH';
    END IF;
    IF ref_type <> 'niche' THEN
      RAISE EXCEPTION 'PROFILE_TYPE_MISMATCH_WITH_APPROVAL';
    END IF;
  END IF;

  IF NEW.visual_profile_id IS NOT NULL THEN
    SELECT reference_id, status, snapshot_hash INTO p_ref_id, p_status, p_hash
      FROM visual_reference_profiles WHERE id = NEW.visual_profile_id;

    IF p_ref_id IS NULL THEN
      RAISE EXCEPTION 'PROFILE_NOT_FOUND';
    END IF;
    IF p_status <> 'awaiting_owner_review' THEN
      RAISE EXCEPTION 'PROFILE_MUST_BE_AWAITING_OWNER_REVIEW';
    END IF;
    IF NEW.snapshot_hash <> p_hash THEN
      RAISE EXCEPTION 'SNAPSHOT_HASH_MISMATCH';
    END IF;

    SELECT owner_id, reference_type INTO ref_owner, ref_type FROM creative_references WHERE id = p_ref_id;
    IF ref_owner <> NEW.owner_id THEN
      RAISE EXCEPTION 'APPROVAL_OWNER_MISMATCH';
    END IF;
    IF ref_type <> 'visual' THEN
      RAISE EXCEPTION 'PROFILE_TYPE_MISMATCH_WITH_APPROVAL';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_reference_approval_binding
  BEFORE INSERT ON reference_owner_approvals
  FOR EACH ROW
  EXECUTE FUNCTION verify_reference_approval_binding();

-- Trigger applications for updated_at column automatic updating
CREATE TRIGGER update_creative_references_updated_at BEFORE UPDATE ON creative_references FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_niche_reference_profiles_updated_at BEFORE UPDATE ON niche_reference_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_visual_reference_profiles_updated_at BEFORE UPDATE ON visual_reference_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_reference_scope_assignments_updated_at BEFORE UPDATE ON reference_scope_assignments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_reference_analysis_attempts_updated_at BEFORE UPDATE ON reference_analysis_attempts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_reference_owner_approvals_updated_at BEFORE UPDATE ON reference_owner_approvals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
