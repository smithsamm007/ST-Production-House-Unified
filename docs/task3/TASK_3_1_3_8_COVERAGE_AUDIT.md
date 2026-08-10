# Task 3.1–3.8 Formal Coverage Audit

Audit date: 2026-08-10  
Authoritative baseline: `main@5787f3412d3e50ed0e9f23f5ed9d27c8226110dc`  
Roadmap authority: ST Production House Master Execution Plan v1.4 (2026-08-09)

## Purpose

This gate explicitly audits every original Task 3 functional slice after Task 4.1–4.3 merged. Bundling prior implementation work does not waive any original acceptance criterion. This PR changes documentation only and exists to run the exact combined verification and PostgreSQL 15 integration gate on current `main`.

## Coverage matrix

| Slice | Original scope | Evidence on baseline | Result |
|---|---|---|---|
| 3.1 | Lifecycle schema, states, priorities, dependencies and idempotency | Migration 010, `jobLifecycle.js`, database transition trigger, idempotent creation and lifecycle tests | Verified |
| 3.2 | PostgreSQL durable queue, atomic claiming, leases and concurrency | Transactional claims, `FOR UPDATE SKIP LOCKED`, bounded leases, per-agent concurrency and PostgreSQL tests | Verified |
| 3.3 | Worker runtime, heartbeats, graceful shutdown and agent isolation | `WorkerRuntime`, `WorkEnvelope`, durable idempotency requirement, heartbeat/cancellation and isolation tests | Verified |
| 3.4 | Checkpoints, resumable execution and artifact/evidence tracking | Durable `CheckpointStore`, deep-frozen state, resume/idempotency contracts and tests | Verified for the current contract |
| 3.5 | Retry/backoff, expired-lease recovery and dead-letter queue | Retry classification, expired-lease reclamation and dead-letter transitions exist; durable scheduled backoff/jitter policy does not | Partial — corrective slice required |
| 3.6 | Per-agent/provider quotas, cooldowns and approved fallback routing | Zero-cost routing and fail-closed injection contracts exist; quota/cooldown persistence is test-memory only and no production PostgreSQL implementation is supplied | Partial — corrective slice required |
| 3.7 | Circuit breakers, quarantine, owner alerts and emergency pause | Circuit-breaker contract exists; durable state, quarantine workflow, owner alerts and emergency-pause enforcement do not | Partial — corrective slice required |
| 3.8 | End-to-end integration, failure injection, CI and operational documentation | CI, PostgreSQL 15 gates and component failure tests exist; final acceptance remains open until 3.5–3.7 corrections merge and a new combined gate passes | Partial — closes after corrective slices |

## Security and architecture findings

1. `src/recovery/zeroCostRouter.js` remains a legacy path that constructs test-only in-memory quota/recovery defaults and routes complete secret locators. It must not be treated as a production entry point. The corrected provider path is `ProviderConfigurationRouter` plus the production `CredentialBroker` lease contract.
2. `QuotaLedger` and `RecoveryContractManager` compatibility aliases resolve to explicitly test-only in-memory implementations. Production callers fail closed only when they use the newer injected interfaces; durable implementations remain missing.
3. Expired leases can be reclaimed and jobs can enter dead letter, but retry timing is immediate. There is no durable next-attempt timestamp, bounded exponential backoff, jitter contract or atomic scheduled-retry claim predicate.
4. No durable quarantine record, owner-alert outbox, or owner emergency-pause gate currently prevents new claims/executions.

## Required corrective sequence

One branch and one canonical PR per slice; no duplicate or replacement PRs.

1. **Task 3.5 corrective slice** — durable retry scheduling/backoff, expired-lease recovery and dead-letter evidence.
2. **Task 3.6 corrective slice** — PostgreSQL quota/cooldown reservations and production adapters for the already-merged provider router.
3. **Task 3.7 corrective slice** — durable circuit breaker, quarantine, owner alerts and emergency pause.
4. **Task 3.8 final gate** — combined failure injection, PostgreSQL/security CI and operational runbook.

Each dependent slice starts from the required merged baseline, uses additive migrations only, preserves migrations 001–011 byte-for-byte, and must pass exact-head CI before merge.

## Dynamic acceptance gate for this audit

- `npm run verify`
- `npm test`
- `npm run test:integration`
- PostgreSQL 15 required; zero required skips
- No live provider, secret-manager, publishing or paid-service calls

## Decision

Task 4 credential/provider implementation is merged, but the wave is not declared terminally complete until this audit PR is green. Phase B Module 15 must not begin before corrective Tasks 3.5–3.8 are merged and verified.
