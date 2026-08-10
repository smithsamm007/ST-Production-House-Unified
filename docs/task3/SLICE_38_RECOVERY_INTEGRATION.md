# Task 3.8 — Recovery-stack integration and operational closure

Canonical issue: #39  
Dependencies: Task 3.6 PR #37 and Task 3.7 PR #40  
Stacked base: Task 3.7 frozen head `39559efd5ccbaaa594ead761d39a2a5ed3fd30b5`

## Owned scope

- Integration wiring through the public contracts delivered by Tasks 3.1–3.7.
- Focused end-to-end and PostgreSQL 15 failure-injection tests.
- Operator runbook, recovery matrix, requirement-to-evidence ledger, and rollback procedure.
- Migration 015 is reserved but must not be created unless an independently proven additive schema gap requires it.
- CI/package changes only when required to execute mandatory gates.

## Required behavior

Prove the complete isolated recovery path from job claim and credential lease through quota reservation, provider attempt, retry or success, circuit/quarantine/pause enforcement, durable owner alert, and append-only evidence. All unknown, malformed, unavailable-audit, cross-tenant, paid, unapproved, revoked, paused, open-circuit, quarantined, or exhausted routes fail closed.

Prove crash/restart recovery, multi-worker concurrency safety, database-time ordering, idempotent side effects, and transaction rollback when evidence fails. Never persist or expose credentials, tokens, locators, unsafe raw output, arbitrary provider errors, fabricated evidence, or live-service receipts.

## Verification

PostgreSQL 15 coverage must include the full migration chain on clean and upgraded schemas, concurrent workers, transaction failure injection, retry/cooldown/circuit/lease/pause clock boundaries, cross-owner and cross-agent denial, alert/evidence exactly-once behavior, and rollback safety.

Required exact-head commands:

- `npm ci`
- `npm run verify`
- `npm test`
- `npm run test:integration`
- all repository security and policy gates

Zero required skips. Keep the PR draft. Do not merge until PRs #37 and #40 are merged, this branch is refreshed onto verified `main`, and independent exact-head review plus every required gate passes.
