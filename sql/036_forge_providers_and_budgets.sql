BEGIN;
-- 036 — FORGE Provider-Independent Coding Gateway, Model Routing, and Budgets (Phase 2.7, v1.2).

CREATE TABLE IF NOT EXISTS forge_providers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL UNIQUE,
  adapter_type          TEXT NOT NULL,
  cost_tier             TEXT NOT NULL CHECK (cost_tier IN ('free','local','approved_paid')),
  health_status         TEXT NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy','degraded','cooldown','disabled')),
  retry_after_at        TIMESTAMPTZ NULL,
  secret_locator        TEXT NOT NULL CHECK (secret_locator LIKE 'vault://%'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS forge_model_routing (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type             TEXT NOT NULL UNIQUE,
  primary_provider_id   UUID NOT NULL REFERENCES forge_providers(id) ON DELETE RESTRICT,
  fallback_provider_id  UUID NULL REFERENCES forge_providers(id) ON DELETE RESTRICT,
  max_tokens            INTEGER NOT NULL DEFAULT 8192 CHECK (max_tokens > 0),
  timeout_ms            INTEGER NOT NULL DEFAULT 120000 CHECK (timeout_ms > 0)
);

CREATE TABLE IF NOT EXISTS forge_agent_executions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  worker_id             UUID NOT NULL REFERENCES forge_workers(id) ON DELETE RESTRICT,
  provider_id           UUID NOT NULL REFERENCES forge_providers(id) ON DELETE RESTRICT,
  fencing_token         BIGINT NOT NULL CHECK (fencing_token > 0),
  model_name            TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  status                TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','timed_out','quota_blocked')),
  provider_receipt_id   TEXT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at           TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_forge_executions_task
  ON forge_agent_executions (task_id, started_at);

CREATE TABLE IF NOT EXISTS forge_usage_budgets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                 TEXT NOT NULL,
  period_start          DATE NOT NULL,
  token_limit           BIGINT NOT NULL CHECK (token_limit >= 0),
  tokens_used           BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  usd_limit             NUMERIC(10,4) NOT NULL DEFAULT 0 CHECK (usd_limit >= 0),
  usd_used              NUMERIC(10,4) NOT NULL DEFAULT 0 CHECK (usd_used >= 0),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (scope, period_start)
);

COMMIT;
