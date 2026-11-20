# Director Worker Runtime (Day 6)

FORGE supervises the technical runtime. HERMES coordinates the Director fleet.
Directors own independent universes. Workers execute eligible tasks. Every
completed stage carries real evidence.

This milestone turns the Day 5 orchestration registry into an execution engine. It
does **not** enable any provider, publishing destination, deployment or paid call.

## Architecture

```
OWNER
  └─ FORGE control plane (Owner session + CSRF)
       └─ HERMES fleet manager (assignment, lifecycle)
            └─ Director registry (sql/045)
                 └─ Director task queue (director_tasks)
                      └─ Worker registry (sql/046, director_workers)
                           └─ Claim → lease → fencing token
                                └─ Stage handler registry
                                     └─ Execution
                                          └─ Evidence contract
                                               └─ Fenced completion / failure
                                                    └─ HERMES + daily report
```

## Files

| Concern | File |
|---|---|
| Worker registry, leases, checkpoints, metrics | `src/fleet/workerRepository.js` |
| Worker loop, heartbeat, drain, classification | `src/worker/workerRuntime.js` |
| Stage handler declarations and execution | `src/worker/stageHandlers.js` |
| Evidence contract, hashing, secret refusal | `src/worker/evidenceContract.js` |
| Owner routes | `src/api/fleetRouter.js` |
| Boot wiring | `src/catalog/server.js` (`startDirectorWorkerRuntime`) |
| Schema | `sql/046_director_worker_runtime.sql` (+ rollback) |
| Owner panel | `src/screens/FleetScreen.tsx` (Worker Operations) |

## Worker states

`REGISTERED → STARTING → IDLE ⇄ BUSY → DRAINING → STOPPED`, plus `DEGRADED`
(repeated failure) and `OFFLINE` (expired heartbeat). Transitions outside
`WORKER_TRANSITIONS` are refused. Every transition is appended to
`director_worker_events`, which is append-only at the database level.

A heartbeat is a real database write from a registered runtime instance. A browser
session is never a worker: the API rejects an instance-id mismatch and health is
computed from the database clock, not from request activity.

## Claiming and fencing

`claimTask` validates worker state, stage types and Director scope, then delegates
to the Day 5 fenced claim:

- `FOR UPDATE SKIP LOCKED` selects one due task;
- an ACTIVE Director is required for worker claims;
- `maxPerDirector` bounds concurrent RUNNING work per Director;
- a partial unique index allows at most one active lease per task;
- `active_fencing_token` increases monotonically and is carried by every
  completion, failure, checkpoint and lease renewal.

A stale token is rejected, and the refusal is written to
`director_lease_violations` (the refusing transaction rolls back, so the
operational fact needs its own row). A worker that loses its lease stops before
committing anything.

## Stage handlers

Every one of the 14 production stages has an explicit declaration: handler name
and version, required capabilities, required upstream stages and evidence, timeout,
hash requirement, output schema and availability.

Provider-independent handlers that genuinely execute:

| Stage | Handler | Real output |
|---|---|---|
| RESEARCH | `research-brief-structurer` | Structured brief from a real persisted document; SHA-256 of its bytes |
| SCRIPT | `script-structure-validator` | Measured word/scene/duration metadata; SHA-256 of the script bytes |
| CHARACTERS | `character-metadata-validator` | Validated character metadata (`containsDesign: false`) |
| FFPROBE | `ffprobe-media-inspection` | Real `ffprobe` stream facts + media hash (only when the binary exists) |
| QC | `qc-rule-executor` | Rules over measured ffprobe evidence |
| PACKAGE | `package-manifest-validator` | Canonical manifest hash |

Provider-backed stages (VISUALS, ANIMATION, VOICE, MUSIC, ASSEMBLY, PUBLISHING,
ANALYTICS) are declared unavailable and fail with `PROVIDER_NOT_CONFIGURED`, which
the runtime records as a **blocked** task with a cooldown. `OWNER_APPROVAL` fails
with `OWNER_APPROVAL_REQUIRED`. There is no placeholder fallback.

## Evidence contract

`director_task_evidence` records the evidence type, artifact SHA-256, handler name
and version, verification level (`IMPLEMENTED`, `UNIT_TESTED`,
`INTEGRATION_TESTED`, `CI_VERIFIED`, `PROVIDER_VERIFIED`, `PRODUCTION_VERIFIED`,
`BLOCKED`, `NOT_RUN`), environment, `test_fixture`, worker, fencing token, input
and output references, validation checks and start/end timestamps.

Rules enforced in code and schema:

- a completion requires its declared evidence types; media stages require a real
  hash from actual bytes;
- metadata-only output is labelled `metadataOnly: true` with `mediaFiles: []`;
- `test_fixture` evidence may never claim provider or production verification;
- a production completion refuses fixture-only evidence
  (`allowTestFixtures` is only true for a TEST environment runtime);
- secret-shaped values are refused before a handler runs and before evidence is
  persisted; opaque `vault://` locators are allowed.

## Failure, retry and recovery

| Class | Examples | Behaviour |
|---|---|---|
| TRANSIENT | connection reset, timeout | bounded retry, exponential backoff with deterministic jitter |
| PERMANENT | invalid input, unsupported stage, broken dependency | terminal on first occurrence (dead letter) |
| PROVIDER | not configured, quota exhausted | blocked + cooldown, **no attempt consumed**, no retry loop |

Restart recovery has two paths: expired leases are released and requeued by
`recoverExpiredLeases`, and a task left `RUNNING` with no active lease (a worker
that released on shutdown or was reclaimed externally) is also requeued, or
dead-lettered when its attempts are exhausted. Checkpoints are keyed by
`(task, checkpoint_key)` so a replayed worker cannot duplicate one.

Graceful shutdown drains, waits for in-flight work (bounded), releases remaining
leases with reason `restart`, and records `STOPPED`.

## Owner routes

All under `/api/fleet`, behind the Owner session, Owner-role gate and CSRF guard;
503 without durable PostgreSQL.

```
GET    /workers/registry
POST   /workers/register
POST   /workers/:workerKey/heartbeat
GET    /workers/:workerKey/history
POST   /workers/:workerKey/drain
POST   /workers/:workerKey/restart
GET    /workers/metrics
GET    /tasks/dead-letters
GET    /tasks/:taskId/checkpoints
GET    /directors/:directorId/tasks/:taskId/execution
```

Existing Day 5 claim, recover, complete, fail, evidence and health routes are
unchanged; `/tasks/claim` now enforces worker state, capability and Director scope
when the worker registry is configured.

## Running a worker

```bash
STPH_DIRECTOR_WORKERS=1 \
STPH_WORKER_STAGES=RESEARCH,SCRIPT,CHARACTERS \
STPH_WORKER_CAPABILITIES=document.structure,metadata.validation \
STPH_WORKER_ARTIFACTS_ROOT=/srv/stph/artifacts/inputs \
STPH_WORKER_CONCURRENCY=1 \
STPH_WORKER_KEY=director-worker-1 \
node server.js
```

Optional: `STPH_WORKER_DIRECTORS` (comma-separated Director scope),
`STPH_WORKER_LEASE_SECONDS`, `STPH_WORKER_HEARTBEAT_SECONDS`,
`STPH_WORKER_POLL_MS`, `STPH_WORKER_FFPROBE=0` to force ffprobe unavailable.

Inputs are persisted on the task (`director_tasks.input`). A file reference must
stay inside `STPH_WORKER_ARTIFACTS_ROOT`; traversal is refused.

## Reporting

The daily report adds `sections.workerExecution`, reconciled to SQL: workers
registered/online/offline/busy/draining/degraded, tasks queued/claimed/handler
started/completed/failed/retried/dead-lettered/recovered, evidence records,
production-eligible vs test-fixture evidence, stage types executed, provider
blocked tasks, per-Director execution, oldest pending task and lease violations.
`executionFidelity` states explicitly that queued ≠ claimed ≠ started ≠ completed
≠ production artifact.

## Known limitations

- No live provider is configured: VISUALS, ANIMATION, VOICE, MUSIC, ASSEMBLY,
  PUBLISHING and ANALYTICS remain honestly blocked.
- `OWNER_APPROVAL` remains an Owner decision, not a worker stage.
- QC/FFPROBE are implemented and unit/integration tested, but reaching them
  through the graph requires ASSEMBLY, which needs the media toolchain.
- The Owner Worker Operations panel is wired to real routes but was not visually
  inspected in a browser during this milestone.
- The HTTP worker routes are Owner-plane routes (single-operator platform). A
  separate machine-to-machine worker credential is not introduced in this
  milestone.
