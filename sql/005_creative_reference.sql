BEGIN;

-- 1. creative_references
CREATE TABLE creative_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES owners(id) ON DELETE CASCADE,
  universe_id uuid NOT NULL REFERENCES creative_universes(id) ON DELETE CASCADE,
  reference_type text NOT NULL, -- 'niche', 'visual'
  canonical_url text NOT NULL,
  original_url text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'awaiting_analysis', -- 'awaiting_analysis', 'analyzing', 'analyzed', 'failed'
  written_brief text,
  owner_notes text,
  desired_characteristics text,
  characteristics_to_avoid text,
  language text DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_reference_type CHECK (reference_type IN ('niche', 'visual')),
  CONSTRAINT valid_analysis_status CHECK (status IN ('awaiting_analysis', 'analyzing', 'analyzed', 'failed')),
  CONSTRAINT unique_canonical_reference UNIQUE (universe_id, reference_type, canonical_url)
);

-- 2. niche_reference_profiles
CREATE TABLE niche_reference_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft', -- 'draft', 'approved', 'active', 'inactive'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_niche_profile_status CHECK (status IN ('draft', 'approved', 'active', 'inactive')),
  UNIQUE (reference_id, version_no)
);

CREATE UNIQUE INDEX niche_reference_profiles_active_idx
  ON niche_reference_profiles (reference_id)
  WHERE (status = 'active');

-- 3. visual_reference_profiles
CREATE TABLE visual_reference_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft', -- 'draft', 'approved', 'active', 'inactive'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_visual_profile_status CHECK (status IN ('draft', 'approved', 'active', 'inactive')),
  UNIQUE (reference_id, version_no)
);

CREATE UNIQUE INDEX visual_reference_profiles_active_idx
  ON visual_reference_profiles (reference_id)
  WHERE (status = 'active');

-- 4. reference_scope_assignments
CREATE TABLE reference_scope_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE CASCADE,
  niche_profile_id uuid REFERENCES niche_reference_profiles(id) ON DELETE SET NULL,
  visual_profile_id uuid REFERENCES visual_reference_profiles(id) ON DELETE SET NULL,
  scope_type text NOT NULL, -- 'universe', 'series', 'season', 'story_arc', 'episode', 'standalone_reel', 'main_video_promo'
  scope_target_id uuid NOT NULL, -- Generic foreign key matching series_id, episode_id, etc.
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
  updated_at timestamptz NOT NULL DEFAULT now()
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
  )
);

-- Trigger applications for updated_at column automatic updating
CREATE TRIGGER update_creative_references_updated_at BEFORE UPDATE ON creative_references FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_niche_reference_profiles_updated_at BEFORE UPDATE ON niche_reference_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_visual_reference_profiles_updated_at BEFORE UPDATE ON visual_reference_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_reference_scope_assignments_updated_at BEFORE UPDATE ON reference_scope_assignments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_reference_analysis_attempts_updated_at BEFORE UPDATE ON reference_analysis_attempts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_reference_owner_approvals_updated_at BEFORE UPDATE ON reference_owner_approvals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
