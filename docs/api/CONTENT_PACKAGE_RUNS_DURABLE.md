# Owner API — Durable Content Package Runs & Evidence Timeline

> Slice **S-M18-01** (Module 18 owner-dashboard surface, part 1).
> Read-only Owner routes over the durable Director execution records.
> Nothing here produces, publishes, spends, contacts a provider or claims a
> visual/UI verification.

## Where it lives

`src/fleet/contentPackageReadRepository.js` projects the durable rows;
`src/api/fleetRouter.js` exposes them under `/api/fleet`; the real server mounts
that router behind the same `authenticateOwner` → Owner-role gate → CSRF chain as
every other FORGE Owner route (`src/catalog/server.js`, `getFleetRuntime`).

The older `/api/content-runs` surface (documented in `CONTENT_RUNS_ROUTES.md`)
reads the legacy `jobs` queue and an in-memory ledger. It is unchanged; the
routes below are the durable replacement for Director production history.

## Canonical model reused (no second execution system)

| Concept | Durable table | Notes |
|---|---|---|
| Content package run | `director_projects` | `runId` is the project UUID; its `state` is `PLANNED/IN_PRODUCTION/COMPLETED/CANCELLED` |
| Stage execution | `director_tasks` | 14 canonical stages, 10 canonical statuses, attempts, fencing token, provider state, blocked reason |
| Stage relationship | `director_task_dependencies` | Declared upstream tasks |
| Evidence | `director_task_evidence` | Handler name/version, verification level, environment, fixture flag, worker, fencing token, artifact hash, validation, timestamps |
| Director identity | `director_fleet` | Display name and lifecycle state only |
| Worker identity | `director_workers` | Worker key, role, state — no metadata blob |

No migration was added: every field above already exists (sql/045 + sql/046), and
the keyset ordering uses `director_projects (created_at, id)` and evidence
`COALESCE(completed_at, created_at), id`, which PostgreSQL satisfies without a
new index at the sizes this control plane serves. A future index migration would
be performance-only, never a correctness prerequisite.

## Routes

All are `GET`, require an authenticated Owner session, and never accept a client
Owner identity.

### `GET /api/fleet/content-packages`

Query parameters (all optional):

| Parameter | Values | Meaning |
|---|---|---|
| `directorId` | `^[a-z0-9][a-z0-9_-]{1,63}$` | Scope to one Director |
| `state` | `PLANNED`, `IN_PRODUCTION`, `COMPLETED`, `CANCELLED` | Project state |
| `stage` | one of the 14 stages | Runs that contain that stage |
| `taskStatus` | one of the 10 task statuses | Runs that contain a task in that status |
| `from`, `to` | ISO-8601 | `created_at` range, inclusive |
| `limit` | 1–100 (default 25) | Page size |
| `cursor` | opaque | Keyset cursor from `page.nextCursor` |

```json
{
  "count": 1,
  "runs": [{
    "runId": "…",
    "directorId": "director-alpha",
    "projectKey": "ep-1",
    "universeId": "universe-alpha",
    "title": "Episode 1",
    "state": "IN_PRODUCTION",
    "createdAt": "…",
    "updatedAt": "…",
    "tasks": { "total": 3, "byStatus": { "COMPLETED": 1, "RETRY_SCHEDULED": 1, "BLOCKED": 1, "…": 0 } },
    "evidence": { "total": 2, "fixtures": 0, "productionVerified": 2, "providerVerified": 0, "fixtureOnly": false },
    "package": { "stage": "PACKAGE", "status": "NOT_SCHEDULED", "taskId": null, "completed": false, "productionVerified": false, "artifactHashes": [] },
    "publishing": { "stage": "PUBLISHING", "status": "NOT_SCHEDULED", "taskId": null, "verifiedReceipt": false }
  }],
  "page": { "limit": 25, "hasMore": false, "nextCursor": null }
}
```

Ordering is `created_at DESC, id DESC`. The cursor carries the database's own
microsecond ISO text, so a page can never skip a row that shares a millisecond
with the previous page.

### `GET /api/fleet/content-packages/:packageId`

Run detail: `run` (identity + Director display name/lifecycle), `progress`,
`package`, `publishing`, `production`, `evidence`, and `tasks[]` where each task
carries `stage`, `status`, `attemptCount`, `maxAttempts`, `retryScheduled`,
`providerState`, `providerRequirement`, allowlisted `blockedReason`,
`failure { code, class }`, sanitized `worker { workerKey, role, state }`,
`fencingToken`, `dependencies[]`, `resultRecorded` and its `evidence` summary.

### `GET /api/fleet/content-packages/:packageId/evidence`

Chronological evidence (`COALESCE(completed_at, created_at) ASC, id ASC`) with
`events[]`, an all-records `summary`, and the same keyset `page`.

Filters: `stage`, `verificationLevel`, `includeTestFixtures` (default `true`),
`limit`, `cursor`.

Each event carries `evidenceId`, `taskId`, `stage`, `evidenceType`,
`artifactHash` (validated 64-hex), `handlerName`, `handlerVersion`,
`verificationLevel`, `environment`, `testFixture`, derived
`productionVerified`/`providerVerified`, `workerKey`, `fencingToken`,
`validation { recorded, checks[], passed, failed, outcome }`, sanitized `refs`,
and `startedAt`/`completedAt`/`createdAt`.

## Truthfulness rules

1. **Completed task ≠ completed package.** `package.completed` reads the PACKAGE
   stage task; a run with only RESEARCH completed keeps `NOT_SCHEDULED`.
2. **Completed package ≠ published.** `publishing.status` reads the PUBLISHING
   task, and `publishing.verifiedReceipt` is true only for a recorded
   `PROVIDER_VERIFIED`, non-fixture receipt evidence. Absence stays
   `NOT_SCHEDULED`, never inferred.
3. **Fixture evidence is never production evidence.** `productionVerified`
   requires `verification_level = PRODUCTION_VERIFIED`, `test_fixture = false`
   and `environment = PRODUCTION`. Levels are echoed exactly as recorded, never
   upgraded; `fixtureOnly` is explicit.
4. **Missing evidence stays missing.** An empty timeline is `events: []` with a
   zeroed summary. Nothing is synthesized.
5. **Hash integrity is reported, not assumed.** `artifactHash` is only emitted
   when it is a valid 64-hex digest.

Director stage evidence is content-addressed (artifact hashes + validation),
not hash-chained. The platform's hash-chained ledger is `evidence_events`
(sql/001), which workers do not write; exposing a chain for these records would
be an invention, so it is intentionally absent.

## Security and isolation

- Every route sits behind the real Owner session, Owner-role gate and the
  fleet router's `getOwnerId` injection. Unauthenticated → `401 UNAUTHORIZED`;
  a non-Owner role → `403 FORBIDDEN` from `createForgeOwnerSessionGate`.
- The Owner is the platform operator and therefore reads the whole fleet; the
  isolation guarantee is that a Director-scoped query and every project/task/
  evidence join stay inside one Director (`t.director_id = e.director_id`,
  `t.project_id = p.id`), so a filter or identifier can never surface another
  Director's records. Director runtime roles remain additionally constrained by
  the FORCE RLS policies from sql/045.
- Explicit DTO allowlists: no payload blobs, no free-text `last_error`, no
  `director_tasks.input`, no worker metadata, no raw result refs.
- Reference strings survive only for `director-stage:`, `artifact:`, `sha256:`
  and `evidence:` schemes; absolute paths, `file:`, `vault:` and URLs are
  dropped and counted in `omitted`. Validation detail text is dropped for the
  same reason.
- Error codes: `400 QUERY_INVALID`, `400 CURSOR_INVALID`,
  `400 CONTENT_PACKAGE_ID_INVALID`, `404 CONTENT_PACKAGE_NOT_FOUND`,
  `401 UNAUTHORIZED`, `403 FORBIDDEN`, `503 CONTENT_PACKAGE_READS_UNAVAILABLE`
  (no durable read model), `500 FLEET_REQUEST_FAILED`.

## Verification

- `tests/contentPackageRead.test.js` — 8 unit tests: cursor round-trip and
  rejection, bounded limits, filter enums and ranges, fixture defaults,
  reference/validation sanitization, failure classification without free text.
- `tests/contentPackageRuns.integration.js` — real PostgreSQL, real repositories
  and the real mounted router through the real Owner gate: 401/403, deterministic
  ordering, keyset pagination across a tied timestamp, every filter, invalid
  input codes, run detail with dependencies/worker/failure class, completed-task
  vs completed-package vs publishing distinctions, chronological fixture-labelled
  evidence with preserved hashes and levels, missing evidence/404 behaviour,
  cross-Director isolation in both directions, and DTO allowlist key sets.

## Known limitations

- Read-only by design: no mutation routes were added (S-M18-02 owns those).
- The Owner view is fleet-wide; there is no multi-tenant Owner scoping because
  the Durable Director model has a single platform Owner.
- No web UI was added or visually verified; the Owner console panel is a
  separate slice.
- No pagination total-count endpoint; `hasMore`/`nextCursor` are the contract.
