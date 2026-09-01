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
