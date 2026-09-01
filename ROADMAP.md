# Continuous Development Roadmap

## Goal
Deliver the secure production control plane through small, isolated, evidence-backed changes that can be planned, implemented, verified, recovered, and merged by automation.

## Current Baseline
The repository contains the Phase 1 policy foundation, PostgreSQL migrations through 016, authenticated API foundations, durable worker/checkpoint contracts, provider routing, and bounded Jules recovery workflows. Live providers, accounts, publishing, and production credentials remain intentionally unavailable.

## Tasks
- [x] PLAN-1: Define a machine-validated Markdown task contract
- [ ] PLAN-2: Validate task issues before implementation starts (depends on: PLAN-1)
- [ ] EXEC-1: Add a governed implementation trigger for approved task issues (depends on: PLAN-2)
- [ ] EXEC-2: Run unit, verification, integration, and policy checks on every pull request (depends on: EXEC-1)
- [ ] REC-1: Add bounded CI failure diagnosis and retry handoff (depends on: EXEC-2)
- [ ] MERGE-1: Enable auto-merge only for exact-head pull requests with required checks (depends on: EXEC-2, REC-1)
- [ ] API-1: Complete authenticated API and PostgreSQL repository wiring (depends on: MERGE-1)
- [ ] WORK-1: Add leased production workers with dead-letter recovery (depends on: API-1)
- [ ] MEDIA-1: Integrate verified media adapters and artifact validation (depends on: WORK-1)
- [ ] PUBLISH-1: Add owner-approved campaign publishing and receipt reconciliation (depends on: MEDIA-1)
- [ ] HARDEN-1: Complete staging, backup, restore, security, and rights verification (depends on: PUBLISH-1)

## Operating Rules

- Every task becomes one issue and one isolated pull request.
- Automated implementation may open or update a draft PR, but it may not bypass required checks, owner approval, or security policy.
- A failed dependency or provider is represented honestly and routed to bounded recovery or owner handoff; no fake success is emitted.
- The roadmap is valid only when `npm run plan:check` and the repository verification commands pass.
\n+## Governed Execution Matrix

The repository's detailed phase, lane, and acceptance matrix is maintained in the implementation roadmap and issue specifications. Each task remains isolated to one pull request, uses the repository's security contract, and must pass exact-head verification before merge.

This document serves as the single source of truth for the continuous, autonomous, and governed development lifecycle of ST Production House. It coordinates automated planning, task generation, three-lane parallel execution, self-healing test-fix loops, and exact-head merge gates.

---

## 1. Governed Three-Lane Execution Architecture

The autonomous pipeline executes across three strictly isolated lanes. Each lane allows at most one active task at any time, serialized through global merge referee gates:

| Lane | Domain Territory | Permitted Agent | Scope Boundary |
|---|---|---|---|
| `lane-1` | Core Infrastructure & Credential Broker | Jules | `src/broker/**`, `src/credentials/**`, `sql/*_credential_*.sql` |
| `lane-2` | Provider Routing, Quotas & Resilience | Jules | `src/providers/**`, `src/quotas/**`, `src/resilience/**`, `src/recovery/**` |
| `lane-3` | Control Plane, API, Workflows & Catalog | Night-shift | `src/api/**`, `src/catalog/**`, `src/orchestration/**`, `src/jarvis/**`, `src/workers/**` |

---

## 2. Phase Breakdown & Execution Matrix

### Phase 1 — Verified Foundation (Completed)
- [x] **TASK-1.1** `[lane-1]`: 20-agent canonical digital identity & connection isolation slots (`sql/001..003`).
- [x] **TASK-1.2** `[lane-3]`: Creative Charter, Universe hierarchy, & Reference Library (`sql/004..006`).
- [x] **TASK-1.3** `[lane-3]`: 22-section Owner-Agent Communication Studio & Blueprinting engine (`sql/007`).
- [x] **TASK-1.4** `[lane-1]`: Cryptographic Evidence Ledger with append-only SHA-256 hash chains.

### Phase 2 — Control Plane, Broker & Orchestration Pipeline (Active)
- [x] **TASK-2.1** `[lane-1]`: Opaque Credential Locator Engine (`src/broker/locator.js`, `specs/issue-01.md`).
- [x] **TASK-2.2** `[lane-2]`: Pure-function Provider Router & Zero-Cost Chain Resolver (`src/providers/`, `specs/issue-02.md`).
- [x] **TASK-2.3** `[lane-1]`: Durable Credential Metadata & Audit PostgreSQL Repositories (`sql/011`, `specs/issue-03.md`).
- [x] **TASK-2.4** `[lane-3]`: Authenticated Owner API, Argon2id auth, session tokens & CSRF (`src/catalog/server.js`, `specs/issue-04.md`).
- [x] **TASK-2.5** `[lane-2]`: Provider Quota Windows, Cooldowns & Recovery Engine (`src/quotas/`, `sql/013`, `specs/issue-05.md`).
- [x] **TASK-2.6** `[lane-2]`: Provider Circuit Breaker, Quarantine & Emergency Pause (`src/resilience/`, `sql/014`, `specs/issue-06.md`).
- [x] **TASK-2.7** `[lane-3]`: Continuous Development Pipeline & Automated Test-Fix Orchestrator (`src/orchestration/`, `ROADMAP.md`).
- [ ] **TASK-2.8** `[lane-1]`: Adversarial fuzzing, security review & production runbook (`specs/issue-07.md`).

### Phase 3 — Media Production & Deterministic Workers (Upcoming)
- [ ] **TASK-3.1** `[lane-3]`: ViMax Motion Adapter & deterministic frame interpolation worker.
- [ ] **TASK-3.2** `[lane-3]`: Story Continuity Worker & scene beat planner.
- [ ] **TASK-3.3** `[lane-2]`: Voice & TTS adapters with pronunciation validation.
- [ ] **TASK-3.4** `[lane-3]`: MoneyPrinterTurbo assembly adapter, FFmpeg sandboxing & FFprobe verification.

### Phase 4 — Promotion & Publishing Gateway (Upcoming)
- [ ] **TASK-4.1** `[lane-3]`: Campaign Intake, affiliate disclosure validation & link scanner.
- [ ] **TASK-4.2** `[lane-1]`: Social platform token broker (YouTube, Instagram, Facebook, Snapchat).
- [ ] **TASK-4.3** `[lane-3]`: Postiz AGPL adapter & durable publishing receipt ledger.

### Phase 5 — Hardening & Release Gate (Upcoming)
- [ ] **TASK-5.1** `[lane-1]`: Disaster recovery drill & migration rollback safety.
- [ ] **TASK-5.2** `[lane-2]`: Rate-limiting & load stress suite.
- [ ] **TASK-5.3** `[lane-3]`: Final SBOM compliance & release certification.

---

## 3. Autonomous Task Definition & Parsing Schema

Tasks declared in this roadmap or generated via `.github/ISSUE_TEMPLATE/` conform to the following JSON-compatible specification:

```json
{
  "taskId": "TASK-2.7",
  "lane": "lane-3",
  "title": "Continuous Development Pipeline & Automated Test-Fix Orchestrator",
  "status": "in-progress",
  "assignee": "night-shift",
  "dependencies": ["TASK-2.4", "TASK-2.6"],
  "territory": ["src/orchestration/**", ".github/**"],
  "deliverables": [
    "src/orchestration/roadmapParser.js",
    "src/orchestration/taskEnvelope.js",
    "src/orchestration/testFixLoop.js",
    "src/orchestration/pipelineController.js",
    "tests/orchestration.test.js"
  ],
  "acceptanceCriteria": [
    "Roadmap markdown is machine-parseable into isolated task envelopes",
    "Strict lane concurrency: at most 1 task per lane",
    "Self-healing test-fix loop enforces max 3 retry attempts per Rule R9",
    "Zero-runtime-dependency rule strictly adhered to",
    "npm test and npm run verify pass cleanly"
  ]
}
```

---

## 4. Engineering Contract Hard Rules (Summary)

1. **Zero Runtime Dependencies**: Standard Node.js APIs for the development planner.
2. **Immutable Migrations**: Append-only `sql/NNN_name.sql`; never edit applied migrations.
3. **Safe DTO Serialization**: Outbound data excludes internal names and secrets.
4. **Governed Merge Order**: Pull requests pass `npm run plan:check`, `npm test`, `npm run verify`, and integration checks where PostgreSQL is available.
