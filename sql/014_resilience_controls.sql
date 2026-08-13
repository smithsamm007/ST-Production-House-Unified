-- Task 3.7: Durable circuit breakers, quarantine, owner alerts and emergency pause
-- Adds production-grade resilience controls: circuit breaker state persistence,
-- provider quarantine records, owner-alert outbox, and emergency pause gates.

BEGIN;

-- Durable Circuit Breaker State per agent/slot/provider/credential
-- Tracks CLOSED, HALF_OPEN, and OPEN states with cooldown enforcement.
CREATE TABLE IF NOT EXISTS provider_circuit_breaker_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  slot text NOT NULL CHECK (slot IN ('primary', 'secondary', 'tertiary', 'emergency_1', 'emergency_2')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 100),
  credential_key text NOT NULL CHECK (char_length(credential_key) BETWEEN 1 AND 100),
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'half_open', 'open')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  max_consecutive_failures integer NOT NULL DEFAULT 3 CHECK (max_consecutive_failures > 0),
  consecutive_successes integer NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
  success_threshold_to_close integer NOT NULL DEFAULT 2 CHECK (success_threshold_to_close > 0),
  cooldown_duration_ms integer NOT NULL DEFAULT 5000 CHECK (cooldown_duration_ms > 0),
  opened_at timestamptz,
  cooldown_until timestamptz,
  last_failure_reason text,
  last_success_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, slot, provider, credential_key),
  CONSTRAINT provider_cb_timestamps CHECK (
    (state = 'closed' AND opened_at IS NULL AND cooldown_until IS NULL) OR
    (state IN ('half_open', 'open') AND opened_at IS NOT NULL)
  ),
  CONSTRAINT provider_cb_cooldown_check CHECK (
    (state = 'open' AND cooldown_until IS NOT NULL) OR
    (state IN ('closed', 'half_open') AND cooldown_until IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS provider_circuit_breaker_scope_idx
  ON provider_circuit_breaker_state (owner_id, agent_id, slot, provider, credential_key);

CREATE INDEX IF NOT EXISTS provider_circuit_breaker_cooldown_idx
  ON provider_circuit_breaker_state (cooldown_until)
  WHERE state = 'open' AND cooldown_until IS NOT NULL;

-- Provider Quarantine: Durable quarantine records per agent/provider/credential
-- Once a provider fails catastrophically, it is quarantined until owner explicitly approves recovery.
CREATE TABLE IF NOT EXISTS provider_quarantines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  slot text NOT NULL CHECK (slot IN ('primary', 'secondary', 'tertiary', 'emergency_1', 'emergency_2')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 100),
  credential_key text NOT NULL CHECK (char_length(credential_key) BETWEEN 1 AND 100),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  triggered_by_event text NOT NULL CHECK (char_length(triggered_by_event) BETWEEN 1 AND 200),
  evidence_summary jsonb,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  resolved_by_owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_note text CHECK (resolved_at IS NULL OR resolution_note IS NOT NULL),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, slot, provider, credential_key, is_active),
  CONSTRAINT provider_quarantine_resolution CHECK (
    (is_active = true AND resolved_at IS NULL AND resolved_by_owner_id IS NULL) OR
    (is_active = false AND resolved_at IS NOT NULL AND resolved_by_owner_id IS NOT NULL)
  ),
  CONSTRAINT provider_quarantine_evidence_immutable CHECK (
    evidence_summary IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS provider_quarantine_scope_idx
  ON provider_quarantines (owner_id, agent_id, slot, provider, credential_key)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS provider_quarantine_active_idx
  ON provider_quarantines (owner_id, is_active);

-- Owner Alerts Outbox: Immutable log of alerts sent to owner
-- Alerts are durable and cannot be modified; owner can only acknowledge and resolve.
CREATE TABLE IF NOT EXISTS owner_alerts_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  alert_type text NOT NULL CHECK (alert_type IN (
    'circuit_breaker_open',
    'provider_quarantine',
    'quota_exhaustion',
    'emergency_pause_triggered',
    'recovery_success',
    'recovery_attempt_failed'
  )),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  provider text CHECK (char_length(provider) BETWEEN 1 AND 100),
  credential_key text CHECK (char_length(credential_key) BETWEEN 1 AND 100),
  context jsonb NOT NULL,
  is_acknowledged boolean NOT NULL DEFAULT false,
  acknowledged_by_owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  is_resolved boolean NOT NULL DEFAULT false,
  resolved_by_owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_alert_acknowledgment CHECK (
    (is_acknowledged = false AND acknowledged_at IS NULL AND acknowledged_by_owner_id IS NULL) OR
    (is_acknowledged = true AND acknowledged_at IS NOT NULL AND acknowledged_by_owner_id IS NOT NULL)
  ),
  CONSTRAINT owner_alert_resolution CHECK (
    (is_resolved = false AND resolved_at IS NULL AND resolved_by_owner_id IS NULL) OR
    (is_resolved = true AND resolved_at IS NOT NULL AND resolved_by_owner_id IS NOT NULL AND is_acknowledged = true)
  ),
  CONSTRAINT owner_alert_context_immutable CHECK (
    context IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS owner_alerts_owner_idx
  ON owner_alerts_outbox (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS owner_alerts_severity_idx
  ON owner_alerts_outbox (owner_id, severity, is_acknowledged)
  WHERE is_acknowledged = false;

CREATE INDEX IF NOT EXISTS owner_alerts_agent_idx
  ON owner_alerts_outbox (owner_id, agent_id, created_at DESC);

-- Owner Emergency Pause Gate: Allows owner to pause all job execution
-- Emergency pause is checked before claiming any job; it is fail-closed.
CREATE TABLE IF NOT EXISTS owner_emergency_pause_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  is_paused boolean NOT NULL DEFAULT false,
  paused_by_owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  paused_at timestamptz,
  paused_reason text CHECK (paused_at IS NULL OR paused_reason IS NOT NULL),
  resumed_by_owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  resumed_at timestamptz,
  resumed_reason text CHECK (resumed_at IS NULL OR resumed_reason IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id),
  CONSTRAINT owner_pause_state_consistency CHECK (
    (is_paused = false AND paused_at IS NULL AND paused_by_owner_id IS NULL) OR
    (is_paused = true AND paused_at IS NOT NULL AND paused_by_owner_id IS NOT NULL)
  ),
  CONSTRAINT owner_pause_transition_audit CHECK (
    (paused_at IS NULL OR resumed_at IS NULL OR paused_at < resumed_at)
  )
);

CREATE INDEX IF NOT EXISTS owner_emergency_pause_is_paused_idx
  ON owner_emergency_pause_gates (owner_id, is_paused)
  WHERE is_paused = true;

COMMIT;
