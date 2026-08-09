# Task 3.3 — Quota and Recovery Contracts

Coordination branch for per-agent quota ledgers, provider cooldown, circuit breakers, retry classification, recovery, and zero-cost routing. No paid services, live providers, or publishing.

## 1. Architecture & Design

### Per-Agent/Per-Provider Slot Quota Ledger (`src/quotas/quotaLedger.js`)
- Tracks `usageCount`, `limit`, `resetTimestamp`, and `trialExpiryTimestamp` mapped isolatedly to `${agentId}:${slotName}`.
- Rejects any configurations with `isPaid: true` or tiers other than `free` or `trial`.
- Resets the `usageCount` to `0` automatically when a past `resetTimestamp` is detected.
- Bypasses expired trials based on current system clock comparison against `trialExpiryTimestamp`.

### Health, Cooldown, and Circuit Breaker States (`src/recovery/recoveryContract.js`)
- **Retry Taxonomy**: Classifies errors into `transient` or `fatal` categories.
  - `fatal`: Authorization, credentials, invalid inputs/requests, cross-agent credentials, and unregistered configurations (fails fast, trips circuit breaker).
  - `transient`: Rate-limits, timeouts, temporary connection issues, and service unavailability (increments failures; trips breaker on threshold).
- **Circuit-Breaker State Machine**:
  - `CLOSED`: Normal operation, healthy routing.
  - `OPEN`: Broken state after successive transient failures (or any fatal error), entering a cooldown duration (`cooldownUntil`). Requests bypass/skip this slot.
  - `HALF_OPEN`: Transition state after cooldown expiry. Executes a single probe; transitions to `CLOSED` on success, or back to `OPEN` on failure.

### Zero-Cost Routing Layer (`src/recovery/zeroCostRouter.js`)
- Subclasses/composes the standard provider policy router.
- Filters out any slots that are paid/overage, have expired trials, exceeded quotas, or are currently in `OPEN`/cooldown states.
- Ensures strict zero-cost fallback, routing through free tiers/trials before falling back to the approved local open-source fallback (such as `ollama` in the `open_source_emergency` slot).

---

## 2. Verification & Status

### Files Added/Modified:
- `src/quotas/quotaLedger.js`
- `src/recovery/recoveryContract.js`
- `src/recovery/zeroCostRouter.js`
- `tests/quotaRecovery.test.js`
- `docs/task3/SLICE_33_QUOTA_RECOVERY.md`

### Test Suite Execution:
- **Total Tests Run**: 9 custom tests, 165 total repository tests (all passed).
- **Skips**: 0 skips, 0 failures.
- **Commands Run**:
  - `node --test tests/quotaRecovery.test.js`
  - `npm run verify`
  - `npm test`

---

## 3. Limitations & Constraints
- **In-Memory Store**: Quota usage, trial expirations, and circuit-breaker states are tracked in-memory, adhering to the "no database migrations" and "no new dependencies" rules.
- **Deterministic Simulation**: Leverages mock executors for verification to guarantee zero variable costs and avoid live third-party API dependencies.
