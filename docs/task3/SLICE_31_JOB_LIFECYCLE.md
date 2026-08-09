# Slice 3.1 — Durable PostgreSQL Job Lifecycle

Consolidated architectural design, database refinements, module contract, and testing strategy for the ST Production House Unified secure control plane job-lifecycle system.

## 1. Architectural Design & Database Trigger

A robust PostgreSQL-backed task queue with explicit allowed state transitions, concurrency limits, lease tracking, retries, and dead-letter queue routing.

### Schema Refinements (`sql/010_job_lifecycle.sql`)

1. **Agent Concurrency Limits**:
   - Added `concurrency_limit` integer column to the `agents` table, defaulting to `5` and restricted via constraint to be strictly positive (`> 0`).

2. **Durable State Machine Transition Trigger**:
   - Implemented `enforce_job_status_transition()` PL/pgSQL function triggered before any job status update.
   - Restricts status changes to only valid pathways:
     - `queued` -> `leased`
     - `leased` -> `running`, `queued`, `failed`, or `dead_letter`
     - `running` -> `succeeded`, `failed`, `dead_letter`, `leased`, or `queued`
     - `failed` -> `queued` or `dead_letter`
     - `dead_letter` -> `queued` (manual replay only)
     - `succeeded` -> strictly terminal (no transitions permitted)

3. **Performance Optimization**:
   - Created a partial index on `jobs (lease_expires_at) WHERE status IN ('leased', 'running')` to optimize expired lease detection and reclamation sweeps.

---

## 2. JavaScript Module API Contract (`src/jobs/lifecycle/jobLifecycle.js`)

Exports an atomic, battle-tested API driving the lifecycle:

1. **`createJob(client, { agentId, capability, idempotencyKey, payload, maxAttempts, priority })`**
   - Uses `ON CONFLICT (idempotency_key) DO NOTHING` to guarantee idempotency.
   - If a duplicate job exists, returns the original job state rather than erroring.

2. **`claimJob(client, { agentId, capability, leaseOwner, leaseDurationSeconds })`**
   - Serializes concurrent lease attempts per agent by acquiring a row lock on the agent (`FOR UPDATE`).
   - Counts non-expired leased or running jobs. If below `concurrency_limit`, grabs the highest-priority, oldest-queued job using `FOR UPDATE SKIP LOCKED`.
   - Transitions state to `leased`, increments `attempts`, and sets `lease_expires_at`.

3. **`renewLease(client, { jobId, leaseOwner, leaseDurationSeconds })`**
   - Extends an active job's lease, checking the owner to prevent hijacking.

4. **`startJob(client, { jobId, leaseOwner })`**
   - Transitions a job from `leased` to `running`.

5. **`completeJob(client, { jobId, leaseOwner, resultPayload })`**
   - Merges results into payload and transitions to terminal `succeeded` state, clearing lease info.

6. **`failJob(client, { jobId, leaseOwner, errorPayload })`**
   - Triggers transient status transitions to capture error context.
   - Compares current attempts to `max_attempts`. If attempts are exhausted, transitions to `dead_letter`; otherwise, returns to `queued`.

7. **`reclaimExpiredLeases(client)`**
   - Multi-tenant reclamation sweep. Finds timed-out leases and automatically fails/re-queues or dead-letters them.

---

## 3. Verification & Testing

Validated both locally using a high-fidelity in-memory Mock DB adapter and serially against a live PostgreSQL 15 instance:

1. **Unit tests (`tests/jobLifecycle.test.js`)**:
   - Confirmed complete state machine, per-agent concurrency enforcement (blocking when limit reached), idempotency, retries, and reclamation.
2. **Integration tests**:
   - Asserts exact DB trigger behaviors, database-level serialization, and transactional safety under PostgreSQL 15.
