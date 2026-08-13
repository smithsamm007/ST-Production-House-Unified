# Task 3.7 — Durable resilience controls

Canonical issue: #38
Dependency: Task 3.6 canonical PR #37 at frozen head `0008b14fc01342459868d6e5ee3621d249a9e15e`
Reserved migration: `sql/014_resilience_controls.sql`

## Owned scope

- Additive migration 014 only.
- Production additions under `src/resilience/**`, `src/quarantine/**`, and `src/alerts/**`.
- Minimal integration at existing job/provider boundaries.
- Focused unit and PostgreSQL 15 integration tests.
- Package/CI edits only when required to execute the live suite.

## Required behavior

Implement durable, owner-and-agent isolated circuit breakers, immutable output quarantine, deduplicated owner alerts, and global-owner/agent/operation emergency pause. Circuit transitions and probe claims must be atomic, bounded, database-time based, restart-safe, and concurrency-safe. Quarantine release/retry and pause recovery require explicit owner authorization. Unknown classifications, malformed policy, cross-tenant identifiers, and unavailable evidence storage fail closed.

Every protected transition and denial must append bounded, allowlisted, secret-safe canonical evidence in the same transaction. No raw output, credentials, tokens, locators, arbitrary provider errors, paid/overage routing, or live external side effects may enter persistence, DTOs, evidence, or tests.

Integrate only through the public Task 3.5 retry/dead-letter and frozen Task 3.6 quota/cooldown contracts. Do not bypass retry, quota, credential, fallback, pause, circuit, quarantine, or audit gates.

## Verification

PostgreSQL 15 coverage must include concurrent final probes, crash/restart durability, database-clock boundaries, transaction/evidence rollback, alert deduplication, quarantine authorization, pause precedence, hostile values, and owner/agent/provider isolation. Migration 014 must be transactional, MigrationRunner-compatible, forward/rerun/rollback-safe, and preserve migrations 001–013 byte-for-byte.

Required exact-head commands:

- `npm ci`
- `npm run verify`
- `npm test`
- `npm run test:integration`

Zero required skips. Keep the PR draft. Do not merge until Task 3.6 is merged, the PR is refreshed onto verified `main`, and independent exact-head review plus all required gates pass.
