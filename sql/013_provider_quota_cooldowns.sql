BEGIN;

CREATE TABLE IF NOT EXISTS provider_quota_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  slot text NOT NULL CHECK (slot IN ('primary', 'secondary', 'tertiary', 'emergency_1', 'emergency_2')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 100),
  credential_id uuid,
  credential_key text NOT NULL CHECK (char_length(credential_key) BETWEEN 1 AND 100),
  quota_limit integer NOT NULL CHECK (quota_limit > 0),
  usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  tier text NOT NULL CHECK (tier IN ('free', 'trial', 'free_trial')),
  is_paid boolean NOT NULL DEFAULT false CHECK (is_paid = false),
  trial_expires_at timestamptz,
  reset_at timestamptz,
  cooldown_until timestamptz,
  cooldown_code text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, slot, provider, credential_key),
  UNIQUE (id, owner_id, agent_id, slot, provider, credential_key),
  CONSTRAINT provider_quota_counts_bounded CHECK (usage_count + reserved_count <= quota_limit),
  CONSTRAINT provider_quota_credential_identity CHECK (
    (credential_id IS NULL AND credential_key = '__local__') OR
    (credential_id IS NOT NULL AND credential_key = credential_id::text)
  ),
  CONSTRAINT provider_quota_trial_expiry CHECK (
    (tier = 'free' AND trial_expires_at IS NULL) OR
    (tier IN ('trial', 'free_trial') AND trial_expires_at IS NOT NULL)
  ),
  CONSTRAINT provider_quota_cooldown_pair CHECK (
    (cooldown_until IS NULL AND cooldown_code IS NULL) OR
    (cooldown_until IS NOT NULL AND cooldown_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS provider_quota_scope_idx
  ON provider_quota_limits (owner_id, agent_id, slot, provider, credential_key);

CREATE INDEX IF NOT EXISTS provider_quota_cooldown_idx
  ON provider_quota_limits (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_quota_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quota_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  slot text NOT NULL CHECK (slot IN ('primary', 'secondary', 'tertiary', 'emergency_1', 'emergency_2')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 100),
  credential_key text NOT NULL CHECK (char_length(credential_key) BETWEEN 1 AND 100),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  units integer NOT NULL DEFAULT 1 CHECK (units > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  released_at timestamptz,
  UNIQUE (owner_id, agent_id, idempotency_key),
  CONSTRAINT provider_quota_reservation_scope_fk
    FOREIGN KEY (quota_id, owner_id, agent_id, slot, provider, credential_key)
    REFERENCES provider_quota_limits (id, owner_id, agent_id, slot, provider, credential_key)
    ON DELETE RESTRICT,
  CONSTRAINT provider_quota_reservation_terminal_timestamps CHECK (
    (status = 'reserved' AND committed_at IS NULL AND released_at IS NULL) OR
    (status = 'committed' AND committed_at IS NOT NULL AND released_at IS NULL) OR
    (status = 'released' AND committed_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS provider_quota_reservation_scope_idx
  ON provider_quota_reservations (owner_id, agent_id, slot, provider, credential_key, status);

COMMIT;
