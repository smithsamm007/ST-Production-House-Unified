# ST Production House — Production Runbook

This is the operational manual for the unified control plane. It covers startup
order, alert triage, emergency pause and recovery, credential rotation drills,
and the migration rollback policy. Every procedure below references real
scripts, modules, and database objects in this repository — nothing here is
aspirational.

---

## 1. Component Map (what runs where)

| Task | Component | Location | Operational surface |
|---|---|---|---|
| TASK-1.1 | Agent digital identity & isolation slots | `sql/001..003` | `agents` table; 20 preloaded identity slots; cap enforced by `AGENT_CAP_REACHED` |
| TASK-1.2 | Creative Charter & Reference Library | `sql/004..006` | Charter approval binds to SHA-256 version snapshots |
| TASK-1.3 | Owner-Agent Communication Studio | `sql/007` | Blueprint versions are frozen after owner approval |
| TASK-1.4 | Evidence Ledger | `src/evidence/evidenceLedger.js` | Append-only SHA-256 hash chain; receipts land here |
| TASK-2.1 | Opaque Credential Locator engine | `src/broker/locator.js` | `loc_v1_...` strings only; no secrets in the database |
| TASK-2.2 | Provider router & zero-cost chain | `src/providers/` | Canonical slots `p_remote_1..3` (disabled by default) + `p_local_fallback` (enabled) |
| TASK-2.3 | Credential & audit repositories | `src/credentials/`, `sql/011` | `rotate`, `revoke`, scoped reads; audit rows never contain secrets |
| TASK-2.4 | Authenticated Owner API | `src/catalog/server.js`, `server.js` | Express app on `0.0.0.0:3000`; Argon2id, TOTP MFA, CSRF, sessions |
| TASK-2.5 | Quota windows, cooldowns, recovery | `src/quotas/`, `sql/013` | Quota ledger reserves/releases; exhaustion routes to `WAITING_FOR_QUOTA` |
| TASK-2.6 | Circuit breaker, quarantine, pause | `src/resilience/`, `sql/014` | `resilience_circuits`, `quarantine_records`, `owner_alerts`, `emergency_pauses` |
| TASK-2.7 | Continuous development pipeline | `src/orchestration/` | Plan parsing, task envelopes, test-fix loop, merge gates |
| TASK-2.8 | Adversarial hardening | `tests/adversarial/` | Fuzzing + SQL-injection matrix; run via `npm test` |
| Multi-channel production | Channels, releases, deterministic pipeline | `sql/019`, `sql/020`, `src/catalog/productionRepository.js`, `src/pipeline/` | `POST /api/channels`, `POST /api/productions`, `POST /api/productions/:id/run`, `POST /api/productions/:id/publish`; worker via `STPH_ENABLE_WORKERS=1` |

Supporting infrastructure shared by all tasks:

- **Database access** — `src/db/postgresAdapter.js` reads `DATABASE_URL` or
  `POSTGRES_URL`, falling back to discrete `PGHOST` / `PGPORT` / `PGUSER` /
  `PGPASSWORD` / `PGDATABASE` variables. Pool sizing: `PGMAXPOOL` (default 10),
  `PGIDLETIMEOUT`, `PGCONNECTTIMEOUT`, `PGSTATEMENTTIMEOUT`.
- **Migrations** — `src/db/migrationRunner.js` applies `sql/NNN_*.sql` files
  transactionally and records checksums.
- **Checkpoints** — `src/checkpoints/checkpointStore.js` (`write` / `read` /
  `resume`) preserves step, progress, artifact refs, and evidence refs per task.
- **Workers** — `src/workers/workerRuntime.js` runs leased envelopes;
  `WorkerCancelledError` marks a clean preemption (checkpoint retained).
- **Dispatch bridge** — `src/providers/dispatchAdmission.js` +
  `src/jarvis/durableScriptDispatchCheckpoint.js` persist
  `WAITING_FOR_QUOTA` checkpoints and admit them back when capacity returns.

---

## 2. Startup Order

Perform these steps in order. Each step gates the next.

1. **Database reachable.** Confirm PostgreSQL is up and the connection string
   is present in the environment. `npm run migrate:status` must return
   `MIGRATION_STATUS` with all applied migrations listed. If it cannot connect,
   fix the database before proceeding — the API will fail its readiness probe.
2. **Migrations applied.** Run `npm run migrate`. It is idempotent; it prints
   `MIGRATIONS_COMPLETE` with `appliedCount`. Exit code 1 means a real failure
   (see §7 before touching anything).
3. **API server started.** `npm start` (or `npm run dev` for development — both
   execute `node server.js`). The server binds `0.0.0.0:3000`. It creates its
   own Postgres adapter at import time; if the database is down the process
   still boots but `/api/ready` will report `503 not_ready`.
4. **Readiness verified.**
   - `GET /api/health` → liveness only (`{"status":"healthy"}`). No database.
   - `GET /api/ready` → executes `SELECT 1`; returns `{"status":"ready"}`
     or `503 {"status":"not_ready"}`. Load balancers and the autonomous
     scheduler should treat `/api/ready` as the only gate.
5. **Bootstrap the first owner (fresh installs only).** `POST /api/auth/register`
   creates the first owner. Registration is rate-limited to 10 requests/minute
   per IP; repeated 429s during bootstrap are expected and self-clear.
6. **Workers and the scheduler join last.** Only start worker runtimes and any
   dispatch scheduler after `/api/ready` is green. Workers acquire leases via
   `WorkerRuntime.run`; the dispatch bridge then re-admits
   `WAITING_FOR_QUOTA` checkpoints as capacity returns. A restarted worker
   detects completed stages from the checkpoint store and never regenerates or
   republishes finished artifacts.

### Shutdown

Stop workers first (finish or checkpoint the current envelope), then the API
server, then the database (or leave it — it is the last dependency). Unplanned
worker loss is safe: leases expire and checkpoints survive.

---

## 3. Reading and Triage of Alerts (`owner_alerts`)

The alert queue is the `owner_alerts` table (`sql/014_resilience_controls.sql`).
There is one row per unacknowledged condition, deduplicated per owner/agent by
`dedupe_key`.

Row anatomy:

| Column | Meaning |
|---|---|
| `severity` | `info`, `warning`, or `critical` |
| `alert_code` | machine-readable condition (≤ 80 chars) |
| `dedupe_key` | collapsing key — repeated hits update nothing new |
| `subject_id` | the job, provider slot, or credential the alert is about |
| `acknowledged_at` | set when acknowledged; NULL means actionable |

### Daily triage

```sql
SELECT severity, alert_code, subject_id, created_at, id
FROM owner_alerts
WHERE acknowledged_at IS NULL
ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
         created_at ASC;
```

Triage rules:

1. **`critical`** — treat as a stop-the-line signal. Common causes: repeated
   provider failures opening a circuit, quarantine of generated content, or a
   pause request. If work must stop globally, apply an emergency pause (§4)
   *before* investigating, then investigate.
2. **`warning`** — capacity and quality signals: circuit half-open probes
   failing, quota windows draining, credential health degraded. Schedule
   rotation (§6) or provider restoral (§5) the same day.
3. **`info`** — record-keeping events (successful recovery, probe success).
   Acknowledge in bulk.

### Acknowledging

Acknowledge through `PostgresResilienceRepository.acknowledgeAlert(
{ ownerId, agentId, alertId }, { authorizedOwnerId })`. The authorized owner
must match the alert's owner — acknowledgment is authorization-checked, not a
bare UPDATE. Never clear alerts by hand-editing the table.

---

## 4. Emergency Pause & Recovery Procedure

### When to pause

- A `critical` alert whose cause is not yet understood.
- Suspected credential compromise (pause first, rotate after — §6).
- Publishing or evidence integrity concerns of any kind.
- A provider behaving adversarially (bad payloads, runaway quota drain).

### How to pause

Use `PostgresResilienceRepository` — never direct SQL:

```js
await resilienceRepo.setPause(
  { ownerId, agentId: null, scopeType: "global", operation: null },
  { reasonCode: "SECURITY_INCIDENT", approvalId, authorizedOwnerId }
);
```

Scope options (enforced by unique active-scope index, so one active pause per
scope): pause everything (`agentId: null`, `scopeType: "global"`), one agent
(`agentId` set), or one operation type for an agent (`operation` set, e.g.
publishing only — keep research running during a publishing incident).

Every gate in the work path calls `assertWorkAllowed({ ownerId, agentId,
operation })`. Once a pause is active, matching work is refused before any
provider call is attempted — including before quota spend. Paused jobs stay in
their current state (typically `CHECKPOINTED` or `WAITING_FOR_QUOTA`); no
state is lost.

### Recovery

1. Mitigate the underlying cause (rotate credential, restore provider, fix
   input validation).
2. Verify with a bounded probe: run a single known-good operation. If a circuit
   is open, `claimHalfOpenProbe` admits exactly one probe; `recordSuccess`
   closes it.
3. Clear the pause explicitly:
   `resilienceRepo.clearPause({ ownerId, pauseId }, { approvalId,
   authorizedOwnerId })`.
4. Confirm `/api/ready` is green and re-admit paused work. The dispatch bridge
   resumes from the last checkpoint — no duplicate generation, no duplicate
   publication.
5. Acknowledge the originating alerts (§3).

If the cause cannot be mitigated within the pause window, keep the pause active
and leave jobs in `WAITING_FOR_QUOTA` / `WAITING_FOR_APPROVAL`; do not clear
the pause to "see if it works now".

---

## 5. Circuit Breakers & Quarantine (daily operations)

- **Circuits** (`resilience_circuits`): `recordFailure` increments a scoped
  failure count (default threshold 3, cooldown 60 s) and opens the circuit;
  half-open probes are admitted one at a time via `claimHalfOpenProbe`;
  `recordSuccess` resets. An open circuit is a *capacity* signal — the router
  falls through to the next provider; a job only checkpoint-waits when every
  provider in its chain is unavailable.
- **Quarantine** (`quarantine_records`, `quarantine_actions`): content flagged
  by validation is quarantined with its `content_sha256` and classification.
  Releasing quarantined work requires `authorizeQuarantineAction` with an
  owner approval id — there is no unattended release path.

---

## 6. Credential Rotation Drill

Run this drill at least quarterly and after any suspected exposure. The
database stores only opaque locators, so rotation swaps locators, never
secrets, in the database.

**Preparation**

1. Create the new secret version in the secret manager (outside this
   codebase). Note its new locator path, e.g.
   `vault://st/agents/agent-01/providers/<provider>/primary@v2`.
2. Read the current credential row to capture its `id`, `owner_id`, `agent_id`,
   and current optimistic-concurrency `version`.
3. Snapshot the audit trail for the credential:
   `credentialAuditRepository.listLogsByCredential(credentialId, ownerId,
   agentId)` — this is the "before" evidence.

**Drill**

4. Rotate atomically:
   `credentialRepository.rotate(id, ownerId, agentId, { newSecretLocator,
   nextExpiresAt, expectedVersion })`. The call fails closed if another writer
   moved the row (`expectedVersion` mismatch) — re-read and retry, never
   force it.
5. Verify: a worker obtains the new locator through the broker and completes a
   task-scoped use; `listLogsByCredential` shows the rotation event and a
   successful use event; the old locator no longer resolves.
6. Revoke the old secret version in the secret manager. The database never
   held it, so no database cleanup is required.

**Rollback during the drill**

If step 5 fails: revoke the *new* secret version in the secret manager, then
rotate the row back to the previous locator with the row's now-current
version. If the credential must simply die, `credentialRepository.revoke(id,
ownerId, agentId)` — workers then route around it (fallback chain) or the job
checkpoint-waits, per the standard capacity rules.

**Compromise variation**: apply the emergency pause (§4) *before* step 4, and
lift it only after step 6.

---

## 7. Migration Rollback Policy

Migrations are **immutable and append-only** (Engineering Contract R1):
`sql/NNN_*.sql` files are never edited once applied, and new files always take
the next sequential number.

- **Never** write a destructive `DOWN` migration and never edit an applied
  file to "fix" a bad release. The runner records a checksum per migration;
  any drift raises `MigrationChecksumMismatchError`, which is a stop-ship
  condition: investigate what changed outside the pipeline (manual DDL, failed
  deploy) before doing anything else.
- **Rollback means a forward fix.** To undo migration N's effect, write
  migration N+1 that reverses it explicitly (drop objects it created, restore
  column defaults, etc.). Reversals must be written against the actual live
  schema, not against assumptions.
- **Failed migration mid-apply**: each migration runs inside a transaction
  (single-statement exceptions handled by the runner), so a failure leaves the
  database at the previous good state. Fix the file's *successor*, not the
  failed file.
- **Point-in-time recovery**: for schema damage that cannot be fixed forward,
  restore the database from the most recent backup to a point before the bad
  migration, then re-run `npm run migrate` to apply the clean sequence. This
  requires the regular database backup schedule to be active — verify it
  during every rotation drill.
- **Verification after any rollback**: `npm run migrate:status` must show a
  contiguous, fully-applied sequence with no checksum warnings, and
  `GET /api/ready` must be green.

---

## 8. Job States & Recovery Semantics (operator view)

Job lifecycle: `QUEUED → RUNNING`, then one of `COMPLETED`, `FAILED`,
`QUARANTINED`, `CHECKPOINTED`, `RETRY_SCHEDULED`, or a waiting state —
`WAITING_FOR_QUOTA`, `WAITING_FOR_GPU`, `WAITING_FOR_APPROVAL`.

Operator rules of thumb:

- **`WAITING_FOR_QUOTA`** — normal, not an error. The checkpoint holds the
  approved input snapshot, completed artifact hashes, attempt history, retry
  count, and next-eligible time. The scheduler re-admits it when a provider in
  the chain recovers. No action needed unless it ages unreasonably; then check
  provider status and quota windows (§5) rather than re-running the job.
- **`QUARANTINED`** — always owner-action: review the quarantine record and
  either authorize release or discard. Never bulk-release.
- **Episode production** — a queued `episode_production` job runs the
  deterministic pipeline (story → visual → audio → assembly). A failed stage
  leaves the job `failed` (retryable via `/api/control/jobs/:id/retry`) and
  the release back at `planned`; a completed run leaves the release in
  `review` awaiting the owner publish gate. Deterministic stage content makes
  retries idempotent by artifact hash — re-runs never duplicate artifacts.
- **`RETRY_SCHEDULED`** — bounded retries per policy; escalate to a pause only
  if retries are burning against a paused scope (which `assertWorkAllowed`
  prevents).
- **Worker interruption** — safe by design. Leases expire, the checkpoint
  store marks completed stages, and the replacement worker resumes from the
  last completed stage. Duplicate generation and duplicate publication are
  both prevented by checkpoint replay, not by operator discipline.
- **Publishing states** (`DRAFT → VALIDATED → OWNER_APPROVED → UPLOAD_PRIVATE
  → RECEIPT_VERIFIED → SCHEDULED → PUBLISHED`) each require the previous
  state's binding; owner approval is invalidated by any mutation of the bound
  artifact hash, caption, or destination.

---

## 9. Verification Commands (what to run after any intervention)

| Command | Purpose |
|---|---|
| `npm test` | Full offline unit suite (single-threaded; keep it that way) |
| `npm run test:integration` | PostgreSQL-backed integration suite (needs a live DB) |
| `npm run verify` | Syntax gate on entry points |
| `npm run lint` | Repository linter (secrets, HTTPS, migration immutability) |
| `npm run plan:check` | Validates `ROADMAP.md` as a machine-parseable plan |
| `npm run build` | Entry-point syntax check used by CI |

After pausing, rotating, recovering, or rolling back, run the full set. If any
of them fail, the incident is not closed.

---

## 10. Security Posture Notes for Operators

- Fuzzing and injection defenses are continuously exercised by
  `tests/adversarial/`: mutated locator strings never crash the parser,
  malformed headers and bodies always yield clean 4xx responses without
  leaking internals, and every repository call is verified to use bound
  parameters.
- Error responses use a fixed public error-code allowlist; internal errors are
  logged in sanitized form only. If you ever see a stack trace or SQL fragment
  in an API response, that is a `critical` incident — pause and file it.
- The provider registry ships with all remote slots disabled and only the
  keyless local fallback enabled; enabling a remote slot requires a stored
  locator plus owner approval, never an inline key.
- Publishing is draft/private by default and requires owner approval bound to
  artifact hashes. Public publishing without a configured primary brand or
  channel is blocked with `PUBLIC_PUBLISHING_IDENTITY_REQUIRED`.
