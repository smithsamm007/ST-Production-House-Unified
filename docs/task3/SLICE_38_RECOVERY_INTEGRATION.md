# Task 3.8 — Recovery-stack integration and operational closure

Canonical issue: #39
Dependencies: Task 3.6 PR #37 and Task 3.7 PR #40
Stacked base: Task 3.7 frozen head `39559efd5ccbaaa594ead761d39a2a5ed3fd30b5`

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

#### Trigger Condition
A severe security event, cross-tenant leak attempt, or system-wide quota exhaustion is detected.

#### Execution (Pause Work)
To set an active global emergency pause on a specific owner:
```sql
-- Replace :ownerId and :approvalId with active UUID and authorized session approval ID
INSERT INTO emergency_pauses (owner_id, scope_type, reason_code, approval_id, active)
VALUES (
  ':ownerId',
  'global_owner',
  'OWNER_REQUEST',
  ':approvalId',
  true
);
```

#### Verification (Check Active Pauses)
```sql
SELECT * FROM emergency_pauses WHERE active = true;
```

#### Resolution (Resume Work)
To safely lift the global pause:
```sql
UPDATE emergency_pauses
SET active = false,
    cleared_at = now()
WHERE id = ':pauseRecordId' AND owner_id = ':ownerId' AND active = true;
```

---

### 3. Dead-Letter Replay Procedure

#### Trigger Condition
A job has exhausted all retries or failed on a fatal error, and its status is `dead_letter`.

#### Investigation
Identify the underlying error details (safely redacted of all plaintext secrets):
```sql
SELECT payload->'error' as error_details
FROM jobs
WHERE id = ':jobId' AND status = 'dead_letter';
```

#### Authorization & Replay
The owner must explicitly authorize a replay by writing a signed `job_replay_authorized` evidence event. This is consumed by the replay mechanism to increment the job's `max_attempts` without erasing attempt history:
```sql
-- 1. Insert Owner-Authorized Replay Event
INSERT INTO evidence_events (id, subject_id, kind, classification, payload, event_hash)
VALUES (
  ':authEvidenceId', -- Generate new UUID
  ':jobId',
  'job_replay_authorized',
  'owner_authorized_replay',
  jsonb_build_object(
    'ownerId', ':ownerId',
    'agentId', ':agentId',
    'jobId', ':jobId',
    'action', 'replay',
    'additionalAttempts', 3
  ),
  encode(sha256(':authEvidenceId'::bytea), 'hex')
);

-- 2. Execute Replay (Can be called via control plane code or manual transactional update)
UPDATE jobs
SET status = 'queued',
    max_attempts = max_attempts + 3,
    updated_at = now()
WHERE id = ':jobId' AND status = 'dead_letter' AND agent_id = ':agentId';
```

---

### 4. Quarantine Release Procedure

#### Trigger Condition
A generated media asset has triggered a safety quarantine (status recorded in `quarantine_records`).

#### Verification (Check Active Quarantines)
```sql
SELECT * FROM quarantine_records WHERE owner_id = ':ownerId' AND agent_id = ':agentId';
```

#### Authorization (Release or Retry)
The owner must explicitly insert an entry into `quarantine_actions` with a signed `approval_id`:
```sql
INSERT INTO quarantine_actions (quarantine_id, owner_id, agent_id, action, approval_id)
VALUES (
  ':quarantineId',
  ':ownerId',
  ':agentId',
  'release', -- Can be 'release' or 'retry'
  ':approvalId'
);
```

---

### 5. Rollback Procedures

#### Scenario: Code/Schema Regression on Deployment
If an update introduces unstable or incorrect schema changes, rollback to the previous migration cleanly using the `MigrationRunner`:

```bash
# To rollback the last applied migration (e.g. from 014 back to 013)
# Execute this command on the control plane server:
node -e "
import('./src/db/index.js').then(async (m) => {
  const adapter = m.createPostgresAdapter();
  await adapter.query('DELETE FROM schema_migrations WHERE filename = \'014_resilience_controls.sql\'');
  await adapter.query('DROP TABLE IF EXISTS emergency_pauses, owner_alerts, quarantine_actions, quarantine_records, resilience_circuits CASCADE');
  console.log('Rollback to 013 successful');
  process.exit(0);
}).catch(err => {
  console.error('Rollback failed:', err);
  process.exit(1);
});
"
```

---

### 6. Database Backup/Restore Considerations

- **SERIALIZABLE Isolation Level**: Always run with serializable isolation level when executing critical billing, reservation, or concurrency-sensitive transactions.
- **Durable Audit Logs**: The `evidence_events` table contains exactly-once, immutable, append-only logs. Under no circumstances should `DELETE` or `UPDATE` queries be run on this table.
- **Backup Frequency**: Automated transactional logging should be backed up continuously (WAL archiving) with hourly snapshot replication to secure secondary hot storage.
