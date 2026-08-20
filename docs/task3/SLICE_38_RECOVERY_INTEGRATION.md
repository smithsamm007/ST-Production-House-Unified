# Task 3.8 — Recovery-stack integration and operational closure

Canonical issue: #39
Dependencies: Task 3.6 PR #37 and Task 3.7 PR #40
Base: merged Task 3.7 (`main`)

## Owned scope

- Integration wiring through the public contracts delivered by Tasks 3.1–3.7.
- Focused end-to-end and PostgreSQL 15 failure-injection tests.
- Operator runbook, recovery matrix, requirement-to-evidence ledger, and rollback procedure.
- Migration 015 is reserved but must not be created unless an independently proven additive schema gap requires it.
- CI/package changes only when required to execute mandatory gates.

## Required behavior

Prove the complete isolated recovery path from job claim and credential lease through quota reservation, provider attempt, retry or success, circuit/quarantine/pause enforcement, durable owner alert, and append-only evidence. All unknown, malformed, unavailable-audit, cross-tenant, paid, unapproved, revoked, paused, open-circuit, quarantined, or exhausted routes fail closed.

Prove crash/restart recovery, multi-worker concurrency safety, database-time ordering, idempotent side effects, and transaction rollback when evidence fails. Never persist or expose credentials, tokens, locators, unsafe raw output, arbitrary provider errors, fabricated evidence, or live-service receipts.

---

## Failure-Recovery Matrix

This matrix maps critical failure modes across the Task 3 ST Production House Unified control plane, specifying the fail-closed behavior, automated recovery mechanisms, and human intervention points.

| Failure Mode | Trigger / Condition | Control Plane State | Fail-Closed / Security Action | Recovery Mechanism | Active Verification (Test Name) |
|--------------|---------------------|---------------------|-------------------------------|--------------------|---------------------------------|
| **Worker Crash** | Active worker process abruptly exits mid-job. | Job status is `leased` but lease expires. | Lease blocks duplicate acquisitions; secret material held in ephemeral Buffer memory only. | `reclaimExpiredLeases()` runs asynchronously, reclaiming job to `queued` and incrementing attempts. | `worker crash and expired-lease recovery` |
| **Transient Error** | Network timeout, 502/503 HTTP status from provider. | Job status transitions to `failed` intermediate state, then `queued`. | Raw error redacted to block internal names, tokens, and secret locators. | Exponential backoff scheduling with injected jitter computed via `calculateNextAttemptDelay()`. | `transient failure with bounded exponential backoff` |
| **Retry Exhaustion** | Job failure count reaches `max_attempts`. | Job status transitions to `dead_letter`. | Job is isolated from the active queue. Epic logged to `evidence_events`. | Manual owner review. The owner must issue an authorized approval to replay or cancel the job. | `retry exhaustion and dead-letter transition` |
| **Quota Exhaustion** | Active reservation count + usage count exceeds limits. | Reservation attempt fails with error. | Fail-closed immediately. Subsequent reservations rejected before provider call. | Fallback routing to secondary remote or local emergency open-source slots. | `atomic quota reservation, consumption, and exhaustion` |
| **Rate Limit / Cooldown** | Provider returns 429; cooldown triggers on error classification. | Quota record is updated with `cooldown_until`. | Fail-closed on all subsequent reservation checks until database-time cooldown expires. | Transition to `half_open` on cooldown expiration, allowing exactly one concurrent probe. | `circuit breaker state machine and concurrency protection` |
| **Circuit Breaker Open** | Provider consecutive failures exceed `max_consecutive_failures`. | Circuit state transitions to `open`. | Provider is skipped on next claim checks, raising alert `CIRCUIT_OPEN` to the outbox. | Automatic move to `half_open` on cooldown expiry; successful probe resets circuit to `closed`. | `circuit breaker state machine and concurrency protection` |
| **Hostile Output / Quality Failure** | Output fails policy check or commercial license constraints. | Quarantine record created in `quarantine_records`. | Table `quarantine_records` is protected by immutable trigger; updates blocked. | Owner must manually authorize quarantine action `release` or `retry` with signed `approval_id`. | `quarantine enforcement and authorized release` |
| **Emergency Pause** | Owner sets active global, agent, or operational pause gate. | `emergency_pauses` record is active. | `assertWorkAllowed()` fails closed, blocking job claims and routing attempts. | Owner must explicitly invoke `clearPause()` with authorized session and `approval_id`. | `emergency pause and authorized resume` |
| **Evidence DB Write Fail** | Database connection issues or validation error when logging evidence. | Transaction is rolled back. | Complete transaction rollback; state changes (like circuit transitions or quota use) discarded. | Safe transaction rollback ensures no unrecorded transitions can ever persist in the control plane. | `transaction rollback when evidence persistence fails` |

---

## Requirement-to-Evidence Ledger

The following ledger establishes a one-to-one mapping between the required Task 3.1–3.8 behaviors and the exact tests executing in `tests/recoveryIntegration.integration.js`.

| ID | Operational/Resilience Requirement | Table / Schema Entity Checked | Test Scope / Name in Integration Tests |
|----|-----------------------------------|-------------------------------|----------------------------------------|
| **REQ-01** | Clean migration chain on PostgreSQL 15 | `schema_migrations` | `verifies isolated PG connection, migration chain, and schema upgrade behavior` |
| **REQ-02** | Upgrade from verified `main` schema | `schema_migrations`, seed data | `verifies isolated PG connection, migration chain, and schema upgrade behavior` |
| **REQ-03** | Job claim through final completion | `jobs` | `job creation and atomic claim` |
| **REQ-04** | Worker crash after claim | `jobs` | `worker crash and expired-lease recovery` |
| **REQ-05** | Expired-lease recovery | `jobs` | `worker crash and expired-lease recovery` |
| **REQ-06** | Heartbeat and lease renewal | `jobs` | `heartbeat and lease renewal` |
| **REQ-07** | Graceful shutdown | `jobs` | `graceful shutdown returns leased job cleanly` |
| **REQ-08** | Transient failure & exponential backoff | `jobs`, `evidence_events` | `transient failure with bounded exponential backoff` |
| **REQ-09** | Retry exhaustion & dead-letter transition | `jobs`, `evidence_events` | `retry exhaustion and dead-letter transition` |
| **REQ-10** | Checkpoint/resume without duplicate artifacts | `CheckpointStore`, `TestCheckpointAdapter` | `checkpoint/resume without duplicate artifacts` |
| **REQ-11** | Quota reservation and exhaustion | `provider_quota_limits`, `provider_quota_reservations` | `atomic quota reservation, consumption, and exhaustion` |
| **REQ-12** | Cooldown and approved fallback | `provider_quota_limits` | `atomic quota reservation, consumption, and exhaustion` |
| **REQ-13** | Circuit OPEN/HALF_OPEN/CLOSED behavior | `resilience_circuits` | `circuit breaker state machine and concurrency protection` |
| **REQ-14** | Quarantine and authorized release | `quarantine_records`, `quarantine_actions` | `quarantine enforcement and authorized release` |
| **REQ-15** | Owner alerts and acknowledgement | `owner_alerts` | `durable alert creation, deduplication, and acknowledgement` |
| **REQ-16** | Emergency pause during active work | `emergency_pauses` | `emergency pause and authorized resume` |
| **REQ-17** | Multi-worker concurrency safety | `jobs` FOR UPDATE / Advisory Locks | `concurrent-worker claim safety using advisory locks` |
| **REQ-18** | Concurrent half-open probe safety | `resilience_circuits` | `circuit breaker state machine and concurrency protection` |
| **REQ-19** | Transaction rollback when evidence fails | `resilience_circuits`, `evidence_events` | `transaction rollback when evidence persistence fails` |
| **REQ-20** | Idempotent reruns | `jobs`, `provider_quota_reservations` | `checkpoint/resume without duplicate artifacts` |
| **REQ-21** | Restart recovery | `provider_quota_limits` | `process/repository recreation preserving durable state` |
| **REQ-22** | Owner and agent isolation | `quarantine_records` | `cross-owner and cross-agent isolation` |
| **REQ-23** | Append-only, exactly-once evidence | `evidence_events` | `quarantine enforcement and authorized release` |
| **REQ-24** | No plaintext credentials or secret leakage | `jobs` error payloads, logs | `safe redactions on error logs` |

---

## Operational Runbook and Recovery Procedures

This guide provides immediate instructions and exact commands for system operators managing the ST Production House Unified control plane under critical resilience scenarios.

### 1. Incident Classification

When an alert is fired to the `owner_alerts` table, it is classified under three severities:

1. **INFO**: Normal status change or successful automated recovery (e.g., successful retry, closed circuit). No immediate action.
2. **WARNING**: Quota usage near 90%, transient network error burst, or single circuit OPEN. Monitor the automatic fallback routes.
3. **CRITICAL**: Active quarantine of output, multiple circuits OPEN, or emergency pause triggered. Requires immediate operator investigation.

---

### 2. Emergency-Pause and Resume Procedure

Use the authenticated owner control-plane operation backed by
`PostgresResilienceRepository.setPause()`. Record the returned pause identifier
and confirm protected work fails with `EMERGENCY_PAUSE_ACTIVE`. Resume only
through the authenticated operation backed by `clearPause()` with a fresh,
scope-bound approval. Operators must not mutate pause tables directly because
that would bypass authorization and transactional evidence.

---

### 3. Dead-Letter Replay Procedure

Inspect the safely redacted job DTO and its append-only evidence chain. Replay
only through the owner-authorized `replayJob()` service path with a valid,
unconsumed approval-evidence identifier. Never insert evidence rows or change a
dead-letter job directly: the service validates owner/agent scope, consumes the
approval exactly once, preserves attempt history, and commits the transition
and evidence atomically.

---

### 4. Quarantine Release Procedure

Review the quarantined artifact hash and bounded policy metadata through the
owner-scoped API. Release or retry only through
`authorizeQuarantineAction()` with the authenticated owner identity and a fresh
approval identifier. Direct table changes are prohibited and immutable
quarantine records must remain untouched.

---

### 5. Rollback Procedures

Migrations are forward-only. Never delete `schema_migrations` rows or drop
production tables as an ad-hoc rollback. If a release is unhealthy, stop new
claims with the emergency-pause service, roll application code back to the last
compatible release, preserve the database, and restore from a verified backup
only under an approved incident procedure. Schema correction requires a new
reviewed additive migration and a successful restore rehearsal.

---

### 6. Database Backup/Restore Considerations

- **Transaction isolation**: Use the isolation level explicitly required by each reviewed service operation. Do not assume `SERIALIZABLE` globally; validate concurrency behavior with the PostgreSQL integration suite.
- **Durable Audit Logs**: The `evidence_events` table contains exactly-once, immutable, append-only logs. Under no circumstances should `DELETE` or `UPDATE` queries be run on this table.
- **Backup policy**: Production deployment must define, monitor, and rehearse an owner-approved PostgreSQL backup and point-in-time recovery policy. This repository does not configure infrastructure-level WAL archiving or snapshot schedules.
