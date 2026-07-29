BEGIN;

-- 1. creative_universes
CREATE TABLE creative_universes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  universe_type text NOT NULL,
  bible jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. creative_charters
CREATE TABLE creative_charters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  name text NOT NULL,
  vision text NOT NULL,
  default_language text NOT NULL DEFAULT 'en',
  secondary_language text,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_charter_status CHECK (status IN ('draft', 'approved', 'active', 'inactive'))
);

-- 3. creative_charter_versions
CREATE TABLE creative_charter_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charter_id uuid NOT NULL REFERENCES creative_charters(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (charter_id, version_no)
);

CREATE UNIQUE INDEX creative_charter_versions_active_idx
  ON creative_charter_versions (charter_id)
  WHERE (is_active = true);

-- 4. agent_charter_assignments
CREATE TABLE agent_charter_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  charter_id uuid NOT NULL REFERENCES creative_charters(id) ON DELETE CASCADE,
  universe_id uuid REFERENCES creative_universes(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one active charter assignment per agent
CREATE UNIQUE INDEX agent_charter_assignments_active_idx
  ON agent_charter_assignments (agent_id)
  WHERE (is_active = true);

-- 5. universe_hierarchy_nodes
CREATE TABLE universe_hierarchy_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id uuid NOT NULL REFERENCES creative_universes(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES universe_hierarchy_nodes(id) ON DELETE CASCADE,
  level_name text NOT NULL, -- 'Era', 'Yuga', 'Source Collection', 'Series', 'Season', 'Story Arc', 'Episode'
  name text NOT NULL,
  description text,
  position_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6. universe_entities
CREATE TABLE universe_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id uuid NOT NULL REFERENCES creative_universes(id) ON DELETE CASCADE,
  node_id uuid REFERENCES universe_hierarchy_nodes(id) ON DELETE SET NULL,
  name text NOT NULL,
  entity_type text NOT NULL, -- 'character', 'location', 'object', 'organization', 'event', 'supernatural'
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 7. universe_entity_relationships
CREATE TABLE universe_entity_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id uuid NOT NULL REFERENCES creative_universes(id) ON DELETE CASCADE,
  source_entity_id uuid NOT NULL REFERENCES universe_entities(id) ON DELETE CASCADE,
  target_entity_id uuid NOT NULL REFERENCES universe_entities(id) ON DELETE CASCADE,
  relationship_type text NOT NULL, -- 'protagonist', 'antagonist', 'incarnation', 'relationship', 'genealogy'
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 8. continuity_events
CREATE TABLE continuity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id uuid NOT NULL REFERENCES creative_universes(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  timeline_index numeric NOT NULL,
  is_canon boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 9. source_references
CREATE TABLE source_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id uuid NOT NULL REFERENCES creative_universes(id) ON DELETE CASCADE,
  citation_text text NOT NULL,
  url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 10. narrative_claim_classifications
CREATE TABLE narrative_claim_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id uuid NOT NULL REFERENCES creative_universes(id) ON DELETE CASCADE,
  claim_text text NOT NULL,
  classification_type text NOT NULL, -- 'directly_supported', 'traditional_version', 'interpretation', 'dramatized_connective', 'owner_approved_fictional'
  confidence_score integer NOT NULL DEFAULT 100,
  reference_id uuid REFERENCES source_references(id) ON DELETE SET NULL,
  interpretation_notes text,
  owner_review_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_classification CHECK (classification_type IN ('directly_supported', 'traditional_version', 'interpretation', 'dramatized_connective', 'owner_approved_fictional')),
  CONSTRAINT valid_review_status CHECK (owner_review_status IN ('pending', 'approved', 'rejected'))
);

-- 11. owner_charter_approvals
CREATE TABLE owner_charter_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charter_version_id uuid NOT NULL REFERENCES creative_charter_versions(id) ON DELETE CASCADE,
  snapshot_hash char(64) NOT NULL,
  assigned_agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  assigned_universe_id uuid REFERENCES creative_universes(id) ON DELETE SET NULL,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  approved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Triggers for updated_at column automatic updating
CREATE TRIGGER update_creative_universes_updated_at BEFORE UPDATE ON creative_universes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_creative_charters_updated_at BEFORE UPDATE ON creative_charters FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_creative_charter_versions_updated_at BEFORE UPDATE ON creative_charter_versions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_agent_charter_assignments_updated_at BEFORE UPDATE ON agent_charter_assignments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_universe_hierarchy_nodes_updated_at BEFORE UPDATE ON universe_hierarchy_nodes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_universe_entities_updated_at BEFORE UPDATE ON universe_entities FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_universe_entity_relationships_updated_at BEFORE UPDATE ON universe_entity_relationships FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_continuity_events_updated_at BEFORE UPDATE ON continuity_events FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_source_references_updated_at BEFORE UPDATE ON source_references FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_narrative_claim_classifications_updated_at BEFORE UPDATE ON narrative_claim_classifications FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_owner_charter_approvals_updated_at BEFORE UPDATE ON owner_charter_approvals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
