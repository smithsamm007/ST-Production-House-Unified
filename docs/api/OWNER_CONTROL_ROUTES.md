# Owner Control Routes — Job Control, Approval Queue, Emergency Pause

> Status: implemented (control-plane only). These routes mutate durable job
> and pause state and write audit events. They never publish, never call
> providers, and never create receipts. Live publishing approval remains
> owner-gated (AGENTS.md Rule 7) and out of scope for this slice.

`src/api/ownerControlRouter.js` is the mutation half of the owner-dashboard
surface (S-M18-02), mounted behind `requireAuth` in `src/api/ownerServer.js`.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/control/approvals?limit=N` | Pending owner-approval queue (read-only) |
| POST | `/control/jobs/:jobId/retry` | Requeue a `failed`/`dead_letter` job to `queued` |
| POST | `/control/jobs/:jobId/cancel` | Cancel a `queued`/`leased`/`running` job |
| GET | `/control/pauses` | Active emergency pauses for the session owner |
| POST | `/control/pauses` | Set an emergency pause (reuses the resilience repository) |
| POST | `/control/pauses/:pauseId/clear` | Clear an active emergency pause |

## Security contract (AGENTS.md Rule 6, Rules 15/17)

- **Session + CSRF + authorization + audit.** Every mutation requires a valid
  Bearer session, a per-session CSRF token (`x-csrf-token` header, issued at
  `/session/start`, stored server-side as a SHA-256 hash), and writes one
  `owner_control_audit` row. Job retry/cancel audit rows are written by the
  store contract in the same transaction as the status change.
- **Server-authoritative identity.** The session's `ownerId` scopes every
  job, approval, pause, and audit query. A client-supplied `ownerId` that
  differs from the session owner is a 403 `SCOPE_MISMATCH`. Cross-owner jobs
  and pauses are indistinguishable 404s (no existence leak).
- **Status enums extended additively (R5).** `owner_cancelled` is a new
  terminal `job_status` value added by `sql/017_owner_job_control.sql`;
  existing enum values and transitions are unchanged. Owner cancel is legal
  only from `queued`/`leased`/`running`; owner retry only from
  `failed`/`dead_letter` (mirroring the jobs trigger contract). Terminal
  states never transition again.
- **Strict DTO allowlists (Rule 17).** Approvals, jobs, pauses, and pause-set
  responses serialize only allowlisted fields; unknown fields never appear.
  Error bodies use a fixed public error-code allowlist; all error strings
  flow through `deepRedactAndSanitize`.
- **Honest degradation.** Missing dependencies fail closed at request time:
  `JOB_CONTROL_STORE_UNAVAILABLE`, `RESILIENCE_REPOSITORY_UNAVAILABLE`,
  `DATABASE_ADAPTER_UNAVAILABLE`, `EVIDENCE_LEDGER_UNAVAILABLE` behavior
  (evidence append is skipped only when no ledger is configured). A pause
  mutation whose post-pause audit insert fails answers 500 while the durable
  pause state remains truthfully visible via `GET /control/pauses`.
- **Emergency pause reuses `PostgresResilienceRepository`** (`src/resilience/`),
  which writes its own in-transaction evidence event. The router records the
  additional owner-control audit row and its own ledger event.

## Durable state (sql/017_owner_job_control.sql)

- `jobs.owner_id` (uuid, nullable, indexed with status + created_at): durable
  per-job owner binding used to scope every control query.
- `owner_control_audit`: append-only audit table (`owner_id`, `agent_id`,
  `job_id`, `action`, `from_status`, `to_status`, `detail` jsonb) with an
  action CHECK allowlist (`job_retry`, `job_cancel`, `emergency_pause_set`,
  `emergency_pause_cleared`).
- `owner_cancelled` job status + trigger extension, additive and idempotent.
  The migration never drops tables and never deletes rows (verified by test).

## Approval queue (read-only)

The queue reads pending `publishing_requests` (status `pending`), projecting
the exact artifact hash (`artifact_sha256`), destination, caption snapshot,
mode, and expiry. Decisions on publishing remain owner-gated per Rule 7 and
are intentionally NOT implemented as automated routes in this slice.

## Truthfulness boundaries

1. No provider calls, media generation, or network I/O.
2. No publishing approval or receipt creation (Rule 7).
3. No client-selectable owner identity; no cross-owner existence leaks.
4. Failures are durable states, not silent drops: non-retryable and
   non-cancellable jobs answer 409 with `JOB_NOT_RETRYABLE` /
   `JOB_NOT_CANCELLABLE` and never mutate.

## Verification

`tests/ownerControlRouter.test.js` (21 tests) covers: session CSRF issuance,
authentication on every route, CSRF enforcement, wrong-token rejection,
cross-owner indistinguishable 404s, client `ownerId` rejection, retry/cancel
state-machine transitions with audit + evidence assertions, terminal-state
409s, malformed ids/limits, approval-queue owner scoping and allowlist keys,
pause set/clear delegation with reason/scope allowlists and secret-bearing
approval-id rejection, honest 503 degradation for store/resilience/database,
and the migration's additive-only contract. The router is mounted under
`/control` (Express 5 style) so unknown routes still fall through to the
generic 404 handler — a regression test in `tests/ownerServer.test.js` and
the adversarial `api-header-fuzz` suite both pin this behavior.

Evidence from this slice: `npm test` 528/528 passing (21 new),
`npm run verify`, `npm run lint`, and `npm run plan:check` all pass on the
slice branch.
