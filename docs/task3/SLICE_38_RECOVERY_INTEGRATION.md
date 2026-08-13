# Task 3.8 — Recovery Stack Integration, Failure Injection and Operational Runbook

Canonical tracking issue: #39  
Base: `main@` (after Task 3.6 and 3.7 merged)  
Reserved migration: `015` (if a proven additive schema gap is required)

## Overview

Task 3.8 is the **final acceptance gate** for the durable recovery stack (Tasks 3.1–3.7). It proves:

1. **End-to-end recovery workflows** work under failure injection, restart, and rollback
2. **Operational evidence** documenting how to operate the system safely
3. **All Tasks 3.1–3.8 acceptance criteria are met** with zero workarounds
4. **PostgreSQL 15 concurrency and restart safety** are verified under adversarial conditions

This is not a placeholder. It must include:
- Failure injection test matrix (circuit breaker, quarantine, emergency pause, expired leases)
- PostgreSQL restart and recovery procedures
- Rollback and recovery runbook
- Operational decision ledger mapping all acceptance criteria to evidence

## Owned files

- `tests/recoveryIntegration.integration.js` — comprehensive failure-injection suite
- `docs/task3/SLICE_38_RECOVERY_INTEGRATION.md` — operational runbook
- `docs/task3/RECOVERY_REQUIREMENTS_TO_EVIDENCE_LEDGER.md` — requirement-to-evidence mapping
- `sql/015_recovery_audit_log.sql` (if schema additions are required)

## Architecture

The recovery stack consists of:

### 3.1 Job Lifecycle (VERIFIED)
- Job creation, state transitions, priority inheritance, dependencies
- Idempotent creation via idempotency_key
- Test: `tests/jobLifecycle.test.js` + PostgreSQL integration suite

### 3.2 Worker Checkpoints (VERIFIED)
- Durable lease claiming with `FOR UPDATE SKIP LOCKED`
- Per-agent concurrency limits
- Bounded lease duration and expiration
- Test: `tests/checkpoints.test.js` + PostgreSQL concurrency matrix

### 3.3 Worker Runtime (VERIFIED)
- `WorkerRuntime` isolation and secret redaction
- Graceful shutdown and cancellation via AbortSignal
- Heartbeat/checkpoint callbacks during execution
- Test: `tests/workers.test.js`

### 3.4 Checkpoints (VERIFIED)
- `CheckpointStore` with deep-frozen state
- Resume idempotency and artifact tracking
- Test: `tests/checkpoints.test.js`

### 3.5 Durable Retry (VERIFIED)
- Stable error classification (transient vs fatal)
- Bounded exponential backoff with jitter
- Expired-lease reclamation
- Dead-letter queue transitions
- Test: `tests/durableRetry.test.js` + integration

### 3.6 Provider Quotas and Cooldowns (VERIFIED)
- Per-agent/provider/credential quota limits
- Atomic quota reservations
- Fail-closed cooldown enforcement
- Test: `tests/providerConfiguration.test.js` + integration

### 3.7 Resilience Controls (NEW)
- Durable circuit breaker state (CLOSED → OPEN → HALF_OPEN → CLOSED)
- Provider quarantine records with owner approval for recovery
- Owner alerts outbox (immutable, audited)
- Emergency pause gate (fail-closed)
- Test: `tests/resilience.test.js`

## Failure Injection Test Matrix

Run under PostgreSQL 15 with the following scenarios:

### Circuit Breaker Scenarios

**CB-001: Circuit breaker opens after max consecutive failures**
- Setup: Job with provider in CLOSED state, 0 consecutive failures
- Inject: 3 consecutive failures (configurable max_consecutive_failures = 3)
- Verify: Circuit breaker transitions to OPEN
- Verify: cooldown_until is set to now + cooldown_duration_ms
- Verify: New job claims skip this provider and route to fallback
- Evidence: PostgreSQL provider_circuit_breaker_state.state = 'open'

**CB-002: Circuit breaker moves to HALF_OPEN after cooldown expires**
- Setup: Circuit breaker in OPEN state with cooldown_until in past
- Inject: isHealthy() check
- Verify: Circuit breaker transitions to HALF_OPEN
- Verify: One test request is allowed
- Evidence: PostgreSQL provider_circuit_breaker_state.state = 'half_open'

**CB-003: Failure in HALF_OPEN reopens circuit**
- Setup: Circuit breaker in HALF_OPEN state
- Inject: One failure during test request
- Verify: Circuit breaker transitions back to OPEN
- Verify: New cooldown_until is set
- Evidence: PostgreSQL provider_circuit_breaker_state.state = 'open' again

**CB-004: Success threshold closes circuit**
- Setup: Circuit breaker in HALF_OPEN state
- Inject: success_threshold_to_close (default 2) consecutive successes
- Verify: Circuit breaker transitions to CLOSED
- Verify: consecutive_successes resets to 0
- Verify: cooldown_until is cleared
- Evidence: PostgreSQL provider_circuit_breaker_state.state = 'closed'

### Quarantine Scenarios

**QT-001: Provider failure triggers quarantine**
- Setup: Provider router attempts provider call
- Inject: Fatal provider error (e.g., authentication failure)
- Verify: Provider is quarantined via activateQuarantine()
- Verify: Owner alert is created with type 'provider_quarantine'
- Verify: New job claims skip this provider
- Evidence: PostgreSQL provider_quarantines.is_active = true

**QT-002: Quarantine can only be resolved by owner**
- Setup: Provider is quarantined
- Inject: Non-owner attempts to use provider (should fail)
- Inject: Owner calls resolveQuarantine()
- Verify: Quarantine is marked resolved
- Verify: Audit trail recorded (resolved_by_owner_id, resolved_at, resolution_note)
- Evidence: PostgreSQL provider_quarantines.is_active = false, resolved_at is set

**QT-003: Quarantine and circuit breaker work together**
- Setup: Both circuit breaker (OPEN) and quarantine (active) on same provider
- Inject: Job claim attempt
- Verify: Provider is skipped (both controls prevent use)
- Verify: Routes to fallback
- Evidence: Provider skipped for two independent reasons

### Owner Alerts Scenarios

**AL-001: Alert is immutable once created**
- Setup: Alert created via createAlert()
- Inject: Attempt to modify alert.title or alert.message
- Verify: Update fails (alerts are append-only)
- Evidence: No UPDATE on owner_alerts_outbox title/message/context

**AL-002: Alerts require acknowledgment before resolution**
- Setup: Alert created and unacknowledged
- Inject: Attempt to resolve without acknowledge
- Verify: Resolve fails (requires is_acknowledged = true)
- Inject: Acknowledge alert first
- Verify: Now resolve succeeds
- Evidence: State transitions are enforced by database constraints

**AL-003: Alert acknowledgment and resolution are audited**
- Setup: Alert created, acknowledged, resolved
- Verify: acknowledged_by_owner_id and acknowledged_at are recorded
- Verify: resolved_by_owner_id and resolved_at are recorded
- Evidence: PostgreSQL owner_alerts_outbox audit columns match owner session

### Emergency Pause Scenarios

**EP-001: Emergency pause blocks all new job claims**
- Setup: Jobs in queue, normal operation
- Inject: Owner calls pause()
- Verify: is_paused = true in owner_emergency_pause_gates
- Inject: New job claim attempt
- Verify: Claim fails (pause_gate check is fail-closed)
- Evidence: Job claim fails with emergency_pause error before queue access

**EP-002: Only owner can resume emergency pause**
- Setup: Emergency pause is active
- Inject: Non-owner attempts resume
- Verify: Resume fails (requires owner authorization)
- Inject: Owner calls resume()
- Verify: is_paused = false
- Evidence: PostgreSQL owner_emergency_pause_gates.is_paused = false

**EP-003: Pause/resume audit trail preserved**
- Setup: Pause invoked, then resume invoked
- Verify: paused_at, paused_by_owner_id are set
- Verify: resumed_at, resumed_by_owner_id are set
- Verify: Constraint ensures paused_at < resumed_at
- Evidence: Complete audit trail in owner_emergency_pause_gates

### Lease and Retry Scenarios

**LR-001: Expired lease is reclaimed**
- Setup: Job with lease expiring at now - 1 second
- Inject: reclaimExpiredLeases() is called
- Verify: Lease is released and returned to queue
- Verify: Job state transitions to 'queued' (retryable)
- Evidence: PostgreSQL jobs.status = 'queued', job_leases entry removed

**LR-002: Dead-letter transition after max retries**
- Setup: Job with retry_count = max_retries
- Inject: Failure occurs
- Verify: Job transitions to 'dead_letter' state
- Verify: Error details are archived in job_evidence
- Evidence: PostgreSQL jobs.status = 'dead_letter'

**LR-003: Retry backoff respects jitter**
- Setup: Multiple jobs in dead-letter/retry queue
- Inject: Retry schedule is computed (exponential backoff + jitter)
- Verify: next_attempt_at = now + base_delay * (2^retry_count) + random_jitter
- Verify: Jitter is within ±25% of base delay
- Evidence: next_attempt_at values are spread across expected range

### PostgreSQL Restart and Recovery Scenarios

**PG-001: Restart during open transaction rolls back cleanly**
- Setup: Job execution in progress, in middle of checkpoint update
- Inject: Kill PostgreSQL connection mid-transaction
- Verify: Transaction is rolled back
- Verify: Lease is still held (not released in half-written state)
- Verify: Job is retryable (state is still 'executing')
- Evidence: Isolation level = SERIALIZABLE, no dirty writes

**PG-002: Advisory lock prevents concurrent claim**
- Setup: Two workers attempt to claim same job
- Inject: First worker acquires advisory lock and begins SELECT FOR UPDATE
- Inject: Second worker attempts same query
- Verify: Second worker waits on lock
- Verify: First worker completes and releases lock
- Verify: Second worker acquires and claims the job
- Evidence: PostgreSQL pg_locks shows advisory lock held

**PG-003: Migration rollback is safe**
- Setup: Migration 014 (resilience controls) is applied
- Inject: Explicit rollback to migration 013 (provider quotas)
- Verify: No orphaned foreign keys or constraint violations
- Verify: Job execution is still safe (fallback to test-only in-memory)
- Evidence: Migration runner reports success, no constraint errors

## Operational Decision Ledger

Every acceptance criterion from Task 3.1–3.8 maps to evidence:

| Task | Criterion | Evidence File | Scenario |
|------|-----------|---------------|----------|
| 3.1 | Lifecycle idempotency | tests/jobLifecycle.test.js | "idempotent job creation returns same job" |
| 3.2 | Lease concurrency | tests/checkpoints.test.js + PostgreSQL | "concurrency limit prevents exceeding maximum" |
| 3.3 | Worker isolation | tests/workers.test.js | "rejects public fields with internal agent names" |
| 3.4 | Checkpoint durability | tests/checkpoints.test.js | "restart/resume durability across store instances" |
| 3.5 | Retry classification | tests/durableRetry.test.js | "classifies transient vs fatal" |
| 3.5 | Expired lease recovery | tests/durableRetryPostgres.integration.js | LR-001 |
| 3.5 | Dead-letter queue | tests/durableRetryPostgres.integration.js | LR-002 |
| 3.6 | Quota enforcement | tests/providerQuotaPostgres.integration.js | "fails closed on expired trial quota" |
| 3.6 | Cooldown persistence | tests/providerQuotaPostgres.integration.js | "fails closed on cooldown" |
| 3.7 | Circuit breaker | tests/resilience.test.js | CB-001 through CB-004 |
| 3.7 | Quarantine | tests/resilience.test.js | QT-001 through QT-003 |
| 3.7 | Owner alerts | tests/resilience.test.js | AL-001 through AL-003 |
| 3.7 | Emergency pause | tests/resilience.test.js | EP-001 through EP-003 |
| 3.8 | Failure injection | tests/recoveryIntegration.integration.js | All scenarios above |
| 3.8 | PostgreSQL restart | tests/recoveryIntegration.integration.js | PG-001 through PG-003 |

## Acceptance Gate

Run:

```bash
npm ci
npm run verify
npm test
npm run test:integration
```

Requirements:

- ✅ Zero skipped tests
- ✅ PostgreSQL 15 live connection required
- ✅ No live provider, credential, or publishing calls
- ✅ All failure-injection scenarios pass with evidence
- ✅ Migration forward/rerun/rollback all succeed
- ✅ Operational runbook is present and complete

## What Happens After Task 3.8

Once Task 3.8 merge passes, Phase B Module 15 begins:

### Phase 2 — Runnable Control Plane (3–5 weeks)
- API, owner dashboard, Argon2id/passkey authentication
- PostgreSQL repositories wired to all domain policies
- Redis or PostgreSQL workers with leases and observability
- Vault/KMS credential broker per-agent configuration

### Phase 3 — Media Workers (5–9 weeks)
- Story/continuity worker based on JARVIS concepts
- Motion adapter with provider contract tests
- Voice adapters for TTS
- Assembly, subtitles, music rights registry

### Phase 4 — Publishing (3–5 weeks)
- Campaign intake, affiliate link security
- YouTube/Instagram/Facebook destination configuration
- Separate Postiz deployment
- Signed approvals and scheduling

### Phase 5 — Security Hardening (3–5 weeks)
- End-to-end tests and load testing
- Backups, restore drills, dead-letter recovery
- Security review, dependency/SBOM scan
- Staging burn-in before live publishing

## Emergency Procedures

### Circuit Breaker is Stuck OPEN

1. Check PostgreSQL:
   ```sql
   SELECT * FROM provider_circuit_breaker_state
   WHERE owner_id = :ownerId AND state = 'open'
   ORDER BY opened_at DESC;
   ```

2. If stuck past cooldown, manually transition:
   ```sql
   UPDATE provider_circuit_breaker_state
   SET state = 'half_open', consecutive_successes = 0
   WHERE owner_id = :ownerId AND state = 'open'
     AND cooldown_until < now();
   ```

3. Monitor next 5 attempts for success/failure

### Provider Quarantine Needs Emergency Override

1. Review quarantine reason:
   ```sql
   SELECT * FROM provider_quarantines
   WHERE owner_id = :ownerId AND is_active = true;
   ```

2. If safe to proceed, resolve via API/dashboard:
   ```
   POST /owners/:ownerId/quarantines/:quarantineId/resolve
   Body: { resolutionNote: "..." }
   ```

3. Circuit breaker will still enforce cooldown; allow 5-10 minutes before retrying

### Emergency Pause is Active

1. Check status:
   ```sql
   SELECT * FROM owner_emergency_pause_gates WHERE owner_id = :ownerId;
   ```

2. All jobs are blocked. Resume only if incident is resolved:
   ```
   POST /owners/:ownerId/emergency-pause/resume
   Body: { resumedReason: "..." }
   ```

3. Verify alerts have been acknowledged before resuming

### Job is Stuck in Dead Letter

1. Investigate failure reason:
   ```sql
   SELECT * FROM job_evidence
   WHERE owner_id = :ownerId AND job_id = :jobId
   ORDER BY created_at DESC LIMIT 5;
   ```

2. If root cause is fixed, manually create new job via API (do NOT retry dead-letter job)

3. Mark dead-letter job as archived:
   ```sql
   UPDATE jobs SET status = 'archived' WHERE id = :jobId;
   ```

## See Also

- [TASK_3_1_3_8_COVERAGE_AUDIT.md](TASK_3_1_3_8_COVERAGE_AUDIT.md) — Original requirements
- [BUILD_VERIFICATION.md](../../BUILD_VERIFICATION.md) — Current CI status
- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — Full system design
