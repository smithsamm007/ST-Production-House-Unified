# Task 3.5: Durable Retry, Expired Lease Recovery & Dead-Letter Evidence Corrective Slice

This document describes the design and implementation of the Task 3.5 corrective slice, which establishes robust, durable, and secure job retry scheduling, backoff, expired lease recovery, and dead-letter handling.

---

## 1. Durable Retry Scheduling & Backoff

To prevent busy-loops and retry storms when external dependencies or resources fail temporarily, we introduced durable retry scheduling directly into the database schema and job lifecycles.

### Database Migration (`sql/012_durable_retry_schedule.sql`)
An additive, transactional, and rerun-safe migration introduces:
- **`next_attempt_at`**: A `timestamptz` column representing when the job is next eligible for execution.
- **`backoff_metadata`**: A `jsonb` column preserving retry history and stable failure classifications.
- **`jobs_next_attempt_idx`**: A partial index optimized for identifying ready-to-run queued jobs:
  ```sql
  CREATE INDEX IF NOT EXISTS jobs_next_attempt_idx
    ON jobs (next_attempt_at)
    WHERE status = 'queued';
  ```

### Exponential Backoff with Injectable Jitter
We use a bounded exponential backoff calculation:
$$\text{delay} = \min(\text{max\_delay}, \text{base\_delay} \times \text{factor}^{\text{attempts} - 1})$$
Jitter is strictly bounded to prevent concurrent retry spikes. To ensure deterministic testing, we allow injecting custom jitter values or a custom jitter function (`jitterFn`) during backoff calculation.

### Claim Scheduling Predicates
Lease claims inside `claimJob` atomically exclude future-scheduled jobs by checking:
```sql
(next_attempt_at IS NULL OR next_attempt_at <= now())
```

---

## 2. Stable Retry Error Classification

We implement a strict fail-closed taxonomical error classification system:
- **Transient Errors**: Known temporary conditions (e.g. rate limits, 429, timeouts, network issues, lease expiration) are eligible for retry up to the maximum attempts configured.
- **Fatal/Unknown Errors**: Unclassified or unknown errors (e.g. DB exceptions, security/authorization failures, programming bugs) are treated as fatal and immediately fail closed without automated retry, moving straight to `dead_letter`.

---

## 3. Concurrency-Safe Expired Lease Recovery

Expired lease reclamation is executed durably, idempotently, and concurrently by checking for jobs stuck in `leased` or `running` state past their `lease_expires_at` timestamp.
- **Concurrency Safety**: To avoid race conditions, deadlocks, and double-processing, we query expired jobs using:
  ```sql
  SELECT id, lease_owner, attempts, max_attempts FROM jobs
   WHERE status IN ('leased', 'running')
     AND lease_expires_at < now()
   FOR UPDATE SKIP LOCKED;
  ```
- **Idempotency**: Exactly one sweeper will lock and claim any given expired lease, executing a single failure/retry transition and appending a single corresponding evidence event.

---

## 4. Dead-Letter Evidence and Redaction

- **Immutable Chain Evidence**: Every retry and dead-letter transition is recorded in the append-only `evidence_events` table as part of a secure SHA-256 hash chain, maintaining relational tuple integrity.
- **Strict Redaction / Sandboxing**: No raw provider errors, API keys, credentials, tokens, passwords, or secret locators (`vault://` or `opaque://`) are ever stored in the job's payload or written to the `evidence_events` table. All error text is strictly sanitized using pattern-matching redactions before being persisted.

---

## 5. Manual Replay and Agent Isolation

When attempts are exhausted, jobs transition permanently to the `dead_letter` status. Operators can manually replay a dead-lettered job under strict guidelines:
- **Authorization Verification**: Requires a valid `ownerId` and an explicit `evidenceId` (representing owner-authorized approval of the replay).
- **Agent/Job Isolation**: Replay operations are scoped strictly to a single agent. A cross-agent replay request will immediately throw an `AGENT_ISOLATION_VIOLATION` error.
- **History Preservation**: Replaying a job **never resets its attempt count silently to 0**. This ensures that audit trails remain transparent and immutable. Instead, `max_attempts` is durably incremented (e.g., increased by 3) to allow the job to run again while keeping the history intact. A `job_replay_authorized` evidence event is written to log the operator decision.
