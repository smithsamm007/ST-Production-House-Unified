# ST Production House — Unified Continuous Development Roadmap

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

1. **Zero Runtime Dependencies**: Standard Node.js (`node:test`, `node:crypto`, `node:http`, `node:fs`).
2. **Immutable Migrations**: Append-only `sql/NNN_name.sql`. Never edit applied migrations.
3. **Safe DTO Serialization**: All outbound data scrubbed of internal agent names (Rule 15) and secrets (Rule 17).
4. **Governed Merge Order**: All PRs must pass `npm test`, `npm run verify`, and the Autonomous Merge Referee.
