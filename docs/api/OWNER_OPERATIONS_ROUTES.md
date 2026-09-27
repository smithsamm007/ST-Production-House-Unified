# Owner API — Live-Operations Routes (Issue #192)

Wires the PR #191 live-operations services into the authenticated owner API so
the owner can actually operate them. Mounted at `/ops` behind `requireAuth` in
`src/api/ownerServer.js`; implementation: `src/api/ownerOperationsRouter.js`.

## Routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/ops/providers/:agentId/smoke-test` | Configured-provider smoke test with receipt verification |
| POST | `/ops/publishing/:agentId/private-test` | Private-first publishing test (owner approval + genuine platform receipt) |
| POST | `/ops/analytics/ingest` | Record genuine external platform analytics |
| GET | `/ops/analytics?limit=` | Owner-scoped analytics records (read-only) |

## Security contract

- Every mutation requires a valid session (`requireAuth`) **and** a per-session
  CSRF token via the `x-csrf-token` header (the S-M18-02 mechanism). Sessions
  without CSRF material fail closed.
- Identity is server-authoritative: the session's `ownerId` scopes every
  query and every audit row. A client-supplied `ownerId` mismatch → `403
  SCOPE_MISMATCH`.
- Every mutation writes an `owner_control_audit` row (Rule 6) using the
  actions widened additively by `sql/026_owner_operations_audit.sql`
  (`provider_smoke_test`, `private_publishing_test`, `analytics_ingest`).
  A missing/unavailable audit adapter degrades honestly with `503
  DATABASE_ADAPTER_UNAVAILABLE` — the mutation is never silently skipped.
- Responses use strict field allowlists (Rule 17). Error bodies use a fixed
  public error-code allowlist; Rule 15/17 leakage denials from the services
  surface as clean `422` responses with no echo of the offending material.

## Server-side transports only (no client-driven execution)

- **Provider smoke test**: the request body may never carry `slots`,
  `executor`, `transport`, or `credentialRef` (`400
  CLIENT_TRANSPORT_FORBIDDEN`). The slots come from a server-side
  `providerSmokeTransport` (wired at boot from the owner's per-Director
  Secrets & Connections configuration) implementing
  `getTaskProviderSlots({ ownerId, agentId })` + `execute(args)`; the broker
  delivers secret locators straight to the executor (locators never
  serialize). The 4-slot provider policy (3 private remote + 1 local
  open-source emergency, cross-agent slots rejected) is enforced by the
  existing `validateTaskProviderPolicy` gate — a violation surfaces as
  `422 INVALID_PROVIDER_POLICY` with no configuration oracle.
- **Private-first publishing test**: the publisher transport and the public
  identity are resolved server-side (`publishingPublisher`,
  `resolvePublishingIdentity`). The request can never supply attribution —
  identity comes from the owner's configured digital identity for the agent;
  an unresolvable identity fails `422 PUBLIC_PUBLISHING_IDENTITY_REQUIRED`.
  Only `private` and `draft` modes are permitted (`PRIVATE_FIRST_MODE_REQUIRED`
  otherwise). Genuine platform receipts are mandatory; a publisher response
  missing `platformPostId`/`platformUrl`/`rawResponse` fails honestly.
- **Analytics**: metrics must be non-negative integers (no invented or
  fractional numbers), URLs must be HTTPS-only, and platforms are the four
  supported allowlisted destinations.

## Durable analytics storage (Issue #194)

Analytics records persist in PostgreSQL (`sql/027 owner_analytics_records`)
through `src/analytics/postgresAnalyticsRepository.js` whenever the owner API
is constructed with a database adapter. Storage properties:

- **Append-only** (Rule 1): rows are immutable — a mutation-blocking trigger
  rejects UPDATE/DELETE (`APPEND_ONLY_VIOLATION`). A later collection for the
  same post is a NEW snapshot row; history is never rewritten.
- **Owner-scoped**: every read is bound to the session owner;
  cross-owner reads are indistinguishable from not-found.
- **DB-enforced bounds**: non-negative integer metrics are enforced by CHECK
  constraints (defense in depth behind the service gates).
- **Honest degradation**: without a database adapter the service falls back
  to its labeled in-memory DEMO transport (non-durable, process-lifetime);
  a storage failure surfaces as a clean 4xx/5xx — never a fabricated write.

Verification: offline unit tests run the repository over the labeled demo
adapter (`tests/postgresAnalyticsRepository.test.js`); the real-PostgreSQL
integration (`tests/analyticsPostgres.integration.js`, part of
`npm run test:integration`) proves restart durability, append-only
enforcement, owner isolation, and DB-level bounds on live PostgreSQL.

## Honest degradation

| Condition | Response |
|---|---|
| Smoke transport unconfigured or failing slot resolution | `503 PROVIDER_SMOKE_TRANSPORT_UNAVAILABLE` |
| Publisher transport unconfigured | `503 PUBLISHING_TRANSPORT_UNAVAILABLE` |
| Audit adapter unavailable | `503 DATABASE_ADAPTER_UNAVAILABLE` |
| All providers fail the smoke test | `422 ALL_PROVIDERS_FAILED` (attempts are evidence, nothing fabricated) |
| Provider/publishing/analitics domain rejection | `422 <stable service code>` |

## Tests

`tests/ownerOperationsRouter.test.js` covers: authentication, CSRF, owner
scoping, DTO allowlists, audit + evidence rows, honest 503s, provider-policy
fail-closed behavior, private-first mode gating, and Rule 15/17 leakage gates.
