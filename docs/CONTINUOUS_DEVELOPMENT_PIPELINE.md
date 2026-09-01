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
