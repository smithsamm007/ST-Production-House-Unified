# Task 3.6 — Durable provider quotas, cooldowns and approved fallback routing

Canonical tracking issue: #36
Base: `main@12ad2cfa9629e4f8b9012c5001c360c42e9f21d0`
Reserved migration: `013_provider_quota_cooldowns.sql`

This branch and its single draft PR are the only implementation path for Task 3.6. Implement the complete issue #36 acceptance contract here. Corrections must update this same branch and PR.

## Owned files

- `sql/013_provider_quota_cooldowns.sql`
- production additions under `src/quotas/**`
- minimal integration changes to `src/providers/providerConfiguration.js`
- focused Task 3.6 unit and PostgreSQL integration tests
- this slice document
- `package.json` only to include required live integration coverage

Do not edit migrations 001–012. Keep `src/recovery/zeroCostRouter.js` test-only/legacy. Do not use live providers, credentials, secret managers, paid services, billing, publishing, public deployment, destructive operations, or placeholders.

## Required evidence

Run and report the exact head for:

- `npm ci`
- `npm run verify`
- `npm test`
- `npm run test:integration` against PostgreSQL 15

Zero required skips. Include migration forward/rerun/rollback safety, concurrency/failure-injection results, changed files, and the CI URL. Do not mark ready or merge.
