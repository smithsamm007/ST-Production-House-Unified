# Director Fleet Orchestration (Day 5 / D7)

HERMES coordinates a fleet of independently owned Director universes over the
durable PostgreSQL runtime. This slice adds the fleet registry, per-Director
universes, a Director-scoped production dependency graph, fenced task
orchestration, provider-blocked honesty, fleet health escalation and the
Owner-facing fleet console.

Migration `sql/045_director_fleet_orchestration.sql` is additive. It has only
been applied to disposable test databases; applying it to a persistent or
production database remains an Owner action.

## Authority

```
OWNER            credentials, spending, publishing, suspension, retirement
  |
FORGE            engineering, reliability, infrastructure (no Owner override)
  |
HERMES           fleet scheduling, routine assignment, operational pause
  |
DIRECTORS        independent universes; never each other's private data
```

`HermesFleetManager` is the single management surface and it enforces the
boundary itself, not only in the UI:

| Action | Allowed actor |
|---|---|
| `activate`, `resume`, `retire`, `request_retirement`, Owner authorization | **OWNER only** (HERMES gets `403 DIRECTOR_NOT_AUTHORIZED`) |
| `pause`, `suspend` | OWNER or HERMES (operational safety) |
| assign a production stage | HERMES/OWNER, within the authority matrix |
| assign `PUBLISHING` / `OWNER_APPROVAL` | requires an unexpired Owner approval bound to an artifact hash **and** a destination; an Owner rejection is absolute |

## Registry and lifecycle

`director_fleet` holds the Director identity, universe, niche, genres, formats,
languages, audience, creative direction, team/production/provider/platform
configuration and a version counter.

Frozen lifecycle (migration CHECK + `src/fleet/fleetPolicy.js`):

```
DRAFT -> CONFIGURED -> READY -> ACTIVE <-> PAUSED
                          |         \-> SUSPENDED -> RETIRING -> RETIRED
                          \-> CONFIGURED
```

- `ACTIVE` requires **all nine** readiness requirements, evaluated from persisted
  configuration: universe identity, audience/languages, genres/formats, creative
  direction, team config, production config, provider references (opaque
  `vault://` locators only, never a plaintext key), platform destinations, and
  explicit Owner authorization.
- `RETIRED` is terminal. Retired Directors keep their rows, audit history and
  production evidence, and are exempt from the capacity count.
- Capacity: at most **50** non-retired Directors. Enforced by the repository and
  independently by a database trigger, so a writer that bypasses the application
  still cannot exceed the Owner's policy.
- Every action writes `director_fleet_audit` (actor, role, previous state, new
  state, reason, correlation id, policy reference). That table is append-only
  (`APPEND_ONLY_VIOLATION` on UPDATE/DELETE).

## Director isolation

- Every repository method takes an explicit `directorId` and adds
  `director_id = $n` to the SQL. Another Director's row is `null` /
  `TASK_NOT_FOUND` / `PROJECT_NOT_FOUND` — "not mine" and "not found" are
  indistinguishable.
- `director_fleet`, `director_projects`, `director_tasks` and
  `director_task_evidence` have `ENABLE`+`FORCE ROW LEVEL SECURITY` policies bound
  to `current_user` via `forge_director_role_for_agent` (sql/039), so a Director
  runtime role (`st_dir_<id>`) is confined to its own universe at the database
  layer.
- Provider configuration is stored per Director as opaque locators. No code path
  returns another Director's locator, and no secret value is ever stored.

## Production graph

Fourteen stages with a real dependency graph (parallel branches, not one queue):

```
RESEARCH -> SCRIPT -> CHARACTERS -> VISUALS -> ANIMATION ┐
                 └-> VOICE ──────────────────────────────┼-> ASSEMBLY -> FFPROBE
                 └-> MUSIC ──────────────────────────────┘        -> QC -> PACKAGE
                                       -> OWNER_APPROVAL -> PUBLISHING -> ANALYTICS
```

- Each stage declares the evidence it must persist (`research_brief`, `script`,
  `character_sheet`, `visual_assets`, `animation_render`, `voice_track`,
  `audio_mix`, `assembled_media`, `ffprobe_report`, `qc_report`,
  `final_package`, `owner_approval`, `publish_receipt`, `analytics_snapshot`).
- Media stages (`ANIMATION`, `ASSEMBLY`, `FFPROBE`, `PACKAGE`) additionally
  require a 64-hex verified artifact hash.
- Assignment and claim both validate upstream stages **and** their evidence.
  A queued task, a called handler or a planned episode is never completion.

## Task lifecycle, leases and recovery

```
CREATED -> QUEUED -> RUNNING -> COMPLETED
              |         ├-> BLOCKED (dependency / provider)
              |         ├-> RETRY_SCHEDULED -> RUNNING
              |         └-> DEAD_LETTER
              └-> CANCELLED
```

Engineering tasks remain in `forge_tasks` (sql/035); Director production tasks
live in `director_tasks` and reuse the same durability primitives rather than a
second engineering state machine: idempotency key, atomic claim
(`FOR UPDATE SKIP LOCKED`), one active lease per task (partial unique index),
monotonic fencing token, `clock_timestamp()` comparisons, bounded attempts and
durable results/evidence.

- **Idempotent creation**: the unique idempotency key returns the same task. A
  key owned by another Director is `TASK_IDEMPOTENCY_CONFLICT`.
- **Atomic assignment** (`assignTask`): locks the task, refuses a non-`ACTIVE`
  Director, validates dependencies, writes `QUEUED`, appends an audit row — one
  transaction.
- **Fenced completion**: a stale fencing token is `TASK_FENCING_TOKEN_STALE`; an
  expired or missing lease is `TASK_LEASE_NOT_ACTIVE`. A worker whose lease
  expired can never commit.
- **Restart recovery** (`recoverExpiredLeases`): expires dead leases with the
  database clock, then requeues (`RETRY_SCHEDULED`) or dead-letters exhausted
  tasks. It is safe to run from several instances.
- **Cancellation** flags running work (the next fenced commit is refused) and
  blocks declared dependents with `TASK_DEPENDENCY_CANCELLED`.

## Provider governance

- Quota exhaustion is a **blocked state with a cooldown**, not a retry loop:
  `markProviderBlocked` sets `BLOCKED`, records the provider state and pushes
  `next_run_at` forward; attempt count is not consumed.
- `claimTask` refuses a task whose provider state is `UNAVAILABLE` or
  `QUOTA_EXHAUSTED` and blocks it instead of attempting a call.
- No task payload carries a credential; providers remain referenced by opaque
  locator through the credential broker. No paid provider is called by this
  slice.

## Fleet health and escalation

Health is computed from `director_fleet`, `director_tasks`, `director_workers`
and escalations only:

| State | Derivation |
|---|---|
| `NOT_CONFIGURED` | DRAFT or CONFIGURED |
| `SUSPENDED` | SUSPENDED / RETIRING / RETIRED |
| `OFFLINE` | PAUSED, or no live registered runtime heartbeat (never "browser closed") |
| `BLOCKED` | blocked tasks or a provider-blocked task |
| `DEGRADED` | failed/dead-lettered tasks or a queue older than an hour |
| `HEALTHY` | a live runtime and no blocked/failed work |

`POST /api/fleet/health/scan` expires genuinely dead runtimes, persists
deduplicated `director_fleet_escalations`, and (when the Day 4 notifier and the
authenticated Owner are available) dispatches a durable notification. A delivery
failure never deletes the escalation.

## Owner interface

| Route | Purpose |
|---|---|
| `GET /api/fleet/directors` | fleet list with live health and capacity |
| `POST /api/fleet/directors` | register (DRAFT/CONFIGURED only) |
| `GET /api/fleet/directors/:id` | detail: readiness, projects, tasks, escalations, audit |
| `GET /api/fleet/directors/:id/readiness` | readiness requirements |
| `GET /api/fleet/directors/:id/audit` | append-only history |
| `PATCH /api/fleet/directors/:id/configuration` | configuration patch |
| `POST /api/fleet/directors/:id/authorization` | Owner activation authorization |
| `POST /api/fleet/directors/:id/{activate,pause,resume,suspend,retirement}` | lifecycle |
| `GET/POST /api/fleet/directors/:id/projects` | projects |
| `GET /api/fleet/directors/:id/projects/overview` | stage progress and evidence |
| `GET/POST /api/fleet/directors/:id/tasks` | task list / idempotent creation |
| `POST /api/fleet/directors/:id/tasks/:taskId/assign` | HERMES assignment |
| `POST /api/fleet/directors/:id/tasks/:taskId/cancel` | cancellation |
| `POST /api/fleet/directors/:id/tasks/:taskId/provider-block` | honest provider block |
| `GET /api/fleet/directors/:id/tasks/:taskId/evidence` | stage evidence |
| `GET /api/fleet/health`, `POST /api/fleet/health/scan`, `GET /api/fleet/escalations` | health |
| `GET /api/fleet/workers`, `POST /api/fleet/workers/heartbeat` | runtimes |
| `POST /api/fleet/tasks/claim`, `/tasks/recover`, `/tasks/:id/complete`, `/tasks/:id/fail` | worker operations |

All routes sit behind the Owner session gate, Owner-role check and CSRF guard,
and return `503 DIRECTOR_FLEET_UNAVAILABLE` without durable PostgreSQL. The
dashboard screen is **Director Fleet** (`src/screens/FleetScreen.tsx`).

## Daily report integration

`collectForgeDailyReport` now includes `sections.directorFleet`:
`directorFleetOverview` (registered/active/ready/paused/suspended/retired, with
active/blocked/failed tasks, provider-blocked Directors, live runtimes),
`universeProductionOverview` (projects per Director, completed/blocked/failed/in
-flight stages, hash-verified artifacts, publishing activity) and
`hermesManagementOverview` (assignments, lifecycle decisions, escalations,
owner-approval stage counts).

Every value is a `GROUP BY` over durable rows. Confirmed publishing activity is
reported `NOT_RUN` because a completed `PUBLISHING` stage is not a platform
receipt; the Day 4 evidence hash and immutability are unchanged.

## What this slice deliberately does not do

- No deployment, no production migration, no publishing, no paid provider call.
- No live Director runtime: workers are registered by the operator, and a fleet
  with no registered runtime is reported `OFFLINE` rather than assumed healthy.
- The Owner console was not visually inspected in this environment (no browser
  run); its routes and data are covered by HTTP tests.
