# Task 3.3 — Quota and Recovery Contracts

Coordination branch for per-agent quota ledgers, provider cooldown, circuit breakers, retry classification, recovery, and zero-cost routing. No paid services, live providers, or publishing.

## 1. Architecture & Design

### Test-Only In-Memory Quota Ledger (`src/quotas/quotaLedger.js`)
- **Explicit Test-Only Target**: Implemented as `TestOnlyInMemoryQuotaLedger` (with `QuotaLedger` alias for backward-compatibility).
- **Fail Closed**: Strictly fails closed (releasing/rejecting execution) if a requested route has no configured quota (i.e. no default unlimited access is ever granted).
- **Isolate State**: Keys are isolated uniquely by `agentId + slotName + provider + secretLocator` to prevent cross-agent credential leakage.
- **Strict Validation**: Rejects `Infinity` or negative values for limits, enforcing positive finite integers. Validates ISO string timestamp parsers for resets and trial expiries.
- **Atomic Reservation Protocol**: Defines a synchronous check-and-increment reservation (`reserve`), `commit` (on execution success), and `release` (reverting the count decrement on execution failure) protocol. Atomicity is guaranteed by the single-threaded nature of synchronous V8 execution ticks.

### Health, Cooldown, and Circuit Breaker States (`src/recovery/recoveryContract.js`)
- **Retry Taxonomy**:
  - Unrecognized/unknown errors must not default to transient; they are strictly classified as `"fatal"` (failing closed).
  - Transient failures are rate-limits (`429`, `RATE_LIMIT`), timeouts (`ETIMEDOUT`, `TIMEOUT`), and network drops (`503`, `SERVICE_UNAVAILABLE`).
- **Sanitized Provider Errors**: Implemented custom message scrubbing to redact API keys (`api_key=[REDACTED]`) and opaque vault secrets (`[REDACTED_VAULT_LOCATOR]`) before storing/exposing them.
- **Circuit Breaker Policy**: CLOSED, OPEN, and HALF_OPEN states are tracked per agent-slot-provider-credential locator, enforcing cooldown periods properly.

### Zero-Cost Routing Layer (`src/recovery/zeroCostRouter.js`)
- Subclasses/composes the standard provider policy router.
- Enforces bounded resource limits and circuit-breaker policies to **all** routes, including local emergency open-source routes (e.g. `ollama`).
- Intercepts provider executions with the `reserve -> execute -> commit/release` transactional lifecycle.
- Filters out paid/overage/expired/cooling-down slots.

---

## 2. Verification & Status

### Files Added/Modified:
- `src/quotas/quotaLedger.js`
- `src/recovery/recoveryContract.js`
- `src/recovery/zeroCostRouter.js`
- `tests/quotaRecovery.test.js`
- `docs/task3/SLICE_33_QUOTA_RECOVERY.md`

### Test Suite Execution:
- **Total Tests Run**: 8 custom tests (covering races, isolation, expiries, resets, sanitization, and emergency routes), 164 total repository tests (all passed).
- **Skips**: 0 skips, 0 failures.
- **Commands Run**:
  - `node --test tests/quotaRecovery.test.js`
  - `npm run verify`

---

## 3. Limitations & Constraints
- **In-Memory Store**: Quota usage, trial expirations, and circuit-breaker states are tracked in-memory, adhering to the "no database migrations" and "no new dependencies" rules. Explicitly labeled test-only.
- **Deterministic Simulation**: Leverages mock executors for verification to guarantee zero variable costs and avoid live third-party API dependencies.
