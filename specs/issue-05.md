## Goal
Provider spend protection BEFORE any live key exists: quota windows, cooldowns,
fallback rerouting — all durable, all testable offline.

## Deliverables
- NEW `sql/009_provider_quotas.sql`: `provider_quota_state`
  (provider_id, window_start, window_unit('hour'|'day'), spent_units, cap_units),
  unique(provider_id, window_start, window_unit)
- NEW `src/providers/quota.js` (injected-store pattern like TASK-4.3):
  - `checkQuota(store, providerId, now)` → `{allowed:boolean, retryAfterSec}`
  - `spend(store, providerId, units, now)` → atomic increment w/ cap enforcement
  - Cooldown state machine: trip on cap breach → auto-clear after cooldownSec
  - Integration hook: router (TASK-4.2) consults quota before emitting chain order

## Acceptance criteria
- [ ] Cap reached → allowed=false with correct retryAfterSec; clears after window
- [ ] Concurrent-spend safety documented (single-writer assumption noted)
- [ ] Router integration test: exhausted provider drops to bottom of chain
- [ ] Fake-store unit tests; suite remains offline & dependency-free
