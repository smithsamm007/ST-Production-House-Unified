# FORGE durable runtime (D3)

> Status: implemented and covered by disposable-PostgreSQL 15 integration tests.
> No migration has been applied to any persistent or production database.

## Why

Until D3 the mounted `/api/forge` control plane was constructed with
`new ForgeControlPlane()` — its task queue, leases, one-PR slot and
external-operation journal lived in `Map` objects, so a process restart erased
FORGE's knowledge of its own work. A durable PostgreSQL repository
(`PostgresForgeRepository`) existed but was never wired in.

## Runtime adapters

| Mode | Adapter | Durable? |
|---|---|---|
| PostgreSQL pool present | `PostgresForgeRepository` over `postgres.pool` | **Yes** — `durable` is reported only after a real `SELECT 1` probe succeeds |
| Demo storage (`STPH_DEMO_STORAGE=1`) | `local-memory` | **No** — labelled `LOCAL_MEMORY_ADAPTER_NON_DURABLE` in every status response |
| Production (`NODE_ENV=production`) without a pool | none | **Fails closed** — every `/api/forge` request returns `503 FORGE_PERSISTENCE_UNAVAILABLE`; nothing is served from memory |

`GET /api/forge/status` now returns a `persistence` block:

```json
{
  "persistence": {
    "adapter": "postgres",
    "durable": true,
    "ready": true,
    "verified": true,
    "databaseTime": "…",
    "runtime": {
      "tasks": { "total": 0, "byStatus": {} },
      "leases": { "active": 0, "expiredActive": 0 },
      "externalOps": { "inflight": 0, "committed": 0, "failedSafeToRetry": 0 },
      "prSlot": { "taskId": null, "watchdogOverdue": false },
      "checkpoints": 0,
      "lastReconciliation": null
    }
  }
}
```

It never reports `durable: true` merely because a repository object exists: a
failed or unreachable database yields `durable: false` with a stable reason.

## Persistence model (migration 042, additive)

| Table | Purpose |
|---|---|
| `forge_tasks` (035) | task identity, status, idempotency key, attempt count, fencing token |
| `forge_worker_leases` (035) | lease history; a partial unique index allows one active lease per task |
| `forge_pr_slots` (037) | single durable PR slot (`slot_id = 1`) |
| `forge_external_ops` (037) | write-ahead GitHub operation journal |
| `forge_task_checkpoints` (042) | progress checkpoints bound to `(task, fencing_token, sequence)` |
| `forge_task_results` (042) | terminal results bound to `(task, fencing_token)` |
| `forge_reconciliations` (042) | every boot reconciliation attempt and its decisions |

All lease and expiry comparisons use `clock_timestamp()` in SQL; application
clocks are not trusted.

## Lease, fencing and completion

`claimLease` runs one transaction: lock the task row `FOR UPDATE`, release any
expired active lease, refuse if another unexpired lease exists, move the task to
`DEAD_LETTER` at `max_attempts`, otherwise increment `active_fencing_token`,
increment `attempt_count` and insert the new lease.

`completeTask` locks the task, rejects a stale token (`FENCING_TOKEN_STALE`),
rejects a missing/expired lease (`LEASE_NOT_ACTIVE`), stores the result under
`(task_id, fencing_token)` (so a retried commit is a no-op), moves the task to
`ACCEPTED` or `READY`/`DEAD_LETTER`, and releases the lease. A worker whose lease
expired can therefore never commit a stale result.

`recordCheckpoint` only inserts while the caller's token equals the task's active
token; a stale write is rejected rather than silently stored.

## One-PR slot

`reservePrSlot` locks `forge_pr_slots` row 1 and refuses if another task holds it
(`ONE_PR_IN_FLIGHT_OCCUPIED`); the same holder retrying the same token is
idempotent. `expires_at` drives `watchdogOverdue` only. `releasePrSlot` requires
`prState` of `merged` or `closed` and throws `PR_SLOT_RELEASE_UNCONFIRMED`
otherwise — an overdue watchdog is never permission to release an uncertain slot.

## External-operation journal and reconciliation

`beginExternalOp` records the intended GitHub write (idempotency key, task,
fencing token, operation type, target branch, expected tree) **before** it is
attempted, and deduplicates on the idempotency key. `reconcileExternalOp` moves
`IN_FLIGHT` → `COMMITTED` / `FAILED_SAFE_TO_RETRY` at most once.

On startup `ForgeControlPlane.reconcileOnBoot` loads unfinished tasks, expired
leases, `IN_FLIGHT` operations and the PR slot, then:

- reconciles an operation only when an authoritative probe reports the write
  present/absent;
- records `EXTERNAL_OP_UNVERIFIED` and leaves the operation `IN_FLIGHT` when no
  authoritative state is available (no blind retry);
- never releases a PR slot without confirmed `merged`/`closed` state;
- writes the whole decision list to `forge_reconciliations` and the evidence
  ledger.

There is no server-side GitHub client today, so the probe is absent by default
and uncertain operations stay `IN_FLIGHT`. That is the intended fail-closed
behaviour, not a bug.

## Verification

- `tests/forgeRuntimeDurability.test.js` — adapter labelling, probe-gated
  durability, delegation, production fail-closed guard, reconciliation decisions.
- `tests/forgeDurableRuntime.integration.js` — disposable PostgreSQL 15:
  restart recovery, two-instance concurrency, fencing rejection, idempotent
  enqueue, PR-slot conflict/overdue/release, external-op reconciliation, and
  unreachable-database failure handling.

## Migration status

`sql/042_forge_runtime_durability.sql` is additive and idempotent, with
`sql/rollback/042_forge_runtime_rollback.sql`. It has only been applied to
disposable CI databases; applying it to production requires separate Owner
authorization.
