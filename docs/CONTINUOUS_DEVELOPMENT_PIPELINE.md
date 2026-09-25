# Continuous Development Pipeline & Autonomous Orchestration

## 1. Overview
The Continuous Development Pipeline provides governed, autonomous execution across three parallel lanes without manual friction, while strictly enforcing the ST Production House Engineering Contract.

## 2. Core Components

### 2.1 Automated Planning & Roadmap Ingestion (`src/orchestration/roadmapParser.js`)
- Parses `ROADMAP.md` and `/specs/*.md` into structured task items.
- Resolves dependency graphs and identifies unblocked tasks ready for dispatch.
- Enforces strict single-task concurrency per lane.

### 2.2 Task Envelope & Territory Guard (`src/orchestration/taskEnvelope.js`)
- Validates task boundaries against assigned agent territories:
  - **Jules** (`lane-1`, `lane-2`): Broker, credentials, provider routers, quotas, resilience, SQL migrations.
  - **Night-shift** (`lane-3`): API, catalog, orchestration, workflows, workers, checkpoints.
- Enforces **Rule 15**: Internal agent names are scrubbed from public metadata.
- Enforces **Rule 17**: Plaintext secrets and passwords are strictly blocked.
- Generates canonical branch names following **Rule R8**: `task/<issue#>-<slug>`.

### 2.3 Fault-Tolerant Test-Fix Loop (`src/orchestration/testFixLoop.js`)
- Classifies failures into structured categories (`SYNTAX_ERROR`, `TEST_ASSERTION_FAILURE`, `SECRET_LEAK_DETECTED`, `TERRITORY_VIOLATION`, `TIMEOUT`).
- Sanitizes all diagnostic outputs to redact bearer tokens, passwords, and connection strings.
- Enforces **Rule R9**: Caps automated retries at exactly 3 attempts before escalating to `blocked` status with full diagnostic context.

### 2.4 Continuous Delivery Orchestrator (`src/orchestration/pipelineController.js`)
- Coordinates the end-to-end cycle: Plan -> Dispatch -> Test & Healing Loop -> Evidence Append -> Merge Gate.
- Appends cryptographic receipts into the immutable Evidence Ledger (`src/evidence/evidenceLedger.js`).

## 3. GitHub Actions Workflows & Templates
- `.github/workflows/ci.yml`: Full Continuous Integration pipeline executing automated linting, security audits, unit & policy tests, PostgreSQL integration tests, and consolidated PR reporting.
- `.github/workflows/continuous-pipeline.yml`: Pipeline runner triggerable on issue events, PR syncs, schedules, and workflow dispatch.
- `.github/workflows/repo-health.yml`: Scheduled daily repository health audit verifying syntax, contract security invariants, and migration sequence integrity.
- `.github/ISSUE_TEMPLATE/01_autonomous_task.yml`: Structured task submission form.
- `.github/ISSUE_TEMPLATE/02_owner_blueprint.yml`: Strategic blueprint template.
- `.github/ISSUE_TEMPLATE/03_blocker_escalation.yml`: Failure escalation template.

## 4. Automated Linting, Health Audits & Status Reporting
- **Repository Linter (`src/orchestration/repoLinter.js`)**:
  - Validates syntax across all `.js` and `.mjs` files using Node's native compiler.
  - Enforces **Rule 17** against plaintext secrets and API keys.
  - Enforces **Rule R3** requiring HTTPS protocols across network source files.
  - Validates **Rule R1** migration immutability and sequential ordering in `sql/`.
- **Status Reporting (`.github/scripts/ci-reporter.mjs`)**:
  - Automatically posts structured step summaries to `$GITHUB_STEP_SUMMARY`.
  - Emits automated failure comments on PRs to prevent stalled development.

## 5. Reconciliation Ordering & Truthful Publishing (issues #92, #90)

### 5.1 Awake Resume Controller (`awake-resume.yml`) — observe before reconcile
For every open autonomous `task/*` PR the controller follows a strict ordering
contract that makes head movement impossible while verification is in flight:

1. **Observe** the PR's current head and count active exact-head gate runs
   (ST Production House CI, PR Gate, Autonomous Merge Referee) at that head.
2. **Never reconcile an active PR**: if any gate run is not yet completed, the
   controller does nothing for that PR. Merge-refreshing from main here would
   move the head and silently invalidate the exact-head guarantees the
   referee depends on.
3. **Refresh + re-dispatch only idle, not-yet-verified PRs**: only when no
   gate run is active and not all three gates have passed at the current head
   does the controller refresh the branch from verified main and re-dispatch
   all three gates at the (possibly new) exact head.

### 5.2 Night Shift recovery — no duplicate re-queue (`night-shift.yml`)
When a Night Shift run fails, the failed issue is returned to the ready queue
**only when no open autonomous PR references it** (`Closes #<issue>` search).
An issue that already produced a PR stays `in-progress`; the backlog feeder
(issue #137) owns re-feeding after that PR closes without merging. This
preserves the one-canonical-PR-per-lane rule against duplicate branches.

### 5.3 AutoDev — verify before publishing (`autodev.yml`)
No implementation is committed, pushed, or opened as a PR until `npm test`
and `npm run verify` pass on the proposed tree. The PR body embeds the real
pasted output of both commands (Rule 1: honest evidence; Rule R6: real test
evidence in the PR body). A failing tree fails the workflow loudly and
nothing is published.
