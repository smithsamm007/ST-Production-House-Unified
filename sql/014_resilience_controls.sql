BEGIN;

CREATE TABLE IF NOT EXISTS resilience_circuits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('provider', 'operation')),
  target_key text NOT NULL CHECK (char_length(target_key) BETWEEN 1 AND 120),
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  failure_threshold integer NOT NULL CHECK (failure_threshold BETWEEN 1 AND 100),
  opened_until timestamptz,
  failure_code text,
  probe_claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, target_type, target_key),
  CONSTRAINT resilience_circuit_state_shape CHECK (
    (state='closed' AND opened_until IS NULL AND probe_claimed_at IS NULL) OR
    (state='open' AND opened_until IS NOT NULL AND probe_claimed_at IS NULL) OR
    (state='half_open' AND opened_until IS NOT NULL AND probe_claimed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS resilience_circuit_scope_idx
  ON resilience_circuits (owner_id, agent_id, target_type, target_key, state);

CREATE TABLE IF NOT EXISTS quarantine_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 120),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  classification text NOT NULL CHECK (classification IN ('POLICY_REJECTED','QUALITY_REJECTED','SECURITY_REJECTED','MALFORMED_OUTPUT')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, operation, content_sha256)
);

CREATE TABLE IF NOT EXISTS quarantine_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quarantine_id uuid NOT NULL REFERENCES quarantine_records(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('release','retry')),
  approval_id text NOT NULL CHECK (char_length(approval_id) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quarantine_id, action, approval_id)
);

CREATE OR REPLACE FUNCTION deny_quarantine_record_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'QUARANTINE_RECORDS_ARE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quarantine_records_no_mutation ON quarantine_records;
CREATE TRIGGER quarantine_records_no_mutation
BEFORE UPDATE OR DELETE ON quarantine_records
FOR EACH ROW EXECUTE FUNCTION deny_quarantine_record_mutation();

CREATE TABLE IF NOT EXISTS owner_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  alert_code text NOT NULL CHECK (char_length(alert_code) BETWEEN 1 AND 80),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 160),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 160),
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS emergency_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text REFERENCES agents(id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK (scope_type IN ('global_owner','agent','operation')),
  operation text,
  reason_code text NOT NULL CHECK (reason_code IN ('OWNER_REQUEST','SECURITY_EVENT','QUOTA_EXHAUSTED','RECOVERY_GUARD')),
  approval_id text NOT NULL CHECK (char_length(approval_id) BETWEEN 1 AND 160),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  CONSTRAINT emergency_pause_scope_shape CHECK (
    (scope_type='global_owner' AND agent_id IS NULL AND operation IS NULL) OR
    (scope_type='agent' AND agent_id IS NOT NULL AND operation IS NULL) OR
    (scope_type='operation' AND agent_id IS NOT NULL AND char_length(operation) BETWEEN 1 AND 120)
  ),
  CONSTRAINT emergency_pause_active_shape CHECK (
    (active AND cleared_at IS NULL) OR (NOT active AND cleared_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS emergency_pause_active_scope_uq
  ON emergency_pauses (owner_id, COALESCE(agent_id,''), scope_type, COALESCE(operation,''))
  WHERE active;

COMMIT;
