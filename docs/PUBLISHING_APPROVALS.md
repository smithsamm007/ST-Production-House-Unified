# Five-hour Owner publishing approvals (D5)

> Status: implemented, durable and fail-closed. Real PostgreSQL 15 acceptance
> runs in CI on disposable databases; **no migration has been applied to any
> persistent or production database**, and no live platform upload exists.

## The policy in one paragraph

A Director's live publishing request creates a durable approval request bound to
an exact artifact SHA-256 and an exact destination list. The Owner is notified.
**Five hours start at confirmed notification delivery — not at request
creation.** If the Owner does not respond, HERMES evaluates that one request
against the active, versioned delegated publishing policy and every mandatory
evidence check, then records an explicit `APPROVE` or `REJECT`. Silence is never
consent; an expired window is never an approval.

## State machine

```
PENDING_NOTIFICATION ──delivery confirmed──▶ AWAITING_OWNER ──deadline──▶ HERMES_APPROVED | HERMES_REJECTED
        │                                        │
        └──delivery failed (clock not started)    ├── Owner APPROVE ──▶ OWNER_APPROVED
                                                 ├── Owner REJECT  ──▶ OWNER_REJECTED  (final)
                                                 ├── Owner changes ──▶ CHANGES_REQUESTED
                                                 └── invalidated   ──▶ publishing_authorized = false
```

`SUPERSEDED` / `WITHDRAWN` exist for artifact replacement and Owner withdrawal.
Every terminal row keeps its decision, reason codes, evaluated checks, evidence
hash and decision timestamp.

## Deadline semantics (database time only)

* `deadline_at = notified_at + interval '5 hours'` is a **database CHECK
  constraint** — no code path can create a different window.
* The worker leases expired rows with `FOR UPDATE SKIP LOCKED` and re-reads
  `deadline_at <= clock_timestamp()` inside the finalizing transaction.
* JavaScript timers only *trigger* a cycle. A missed tick, a restart or two
  instances change nothing: the row is still expired, and whoever commits first
  owns the single decision.
* Owner responses and HERMES decisions serialize on the approval row. The first
  committed transition wins; the loser receives `OWNER_RESPONSE_WON` or
  `OWNER_RESPONSE_TOO_LATE` and writes nothing.

## HERMES authority (and its hard limits)

Allowed: `APPROVE`/`REJECT` **one** publishing request, for **one** artifact
hash, for **its** destinations, under an active delegated policy whose version
matches the request.

Never allowed, regardless of elapsed time: credentials or account connections,
spending, global governance, MFA/RBAC/security changes, policy changes,
Owner-reserved restrictions, other artifacts/destinations, data deletion,
production deploys, or overriding an explicit Owner rejection. The evaluator
returns these as `authority` flags set to `false` and `classifyDelegatedAction()`
denies them structurally.

Mandatory checks (`DELEGATED_PUBLISHING_CHECKS`): artifact integrity, production
QC, media integrity (ffprobe), copyright/licensing, rights clearance, privacy,
platform policy, advertising/sponsorship disclosure, metadata, duplicate
protection, Owner restrictions. A missing entry, `passed:false` or empty evidence
is a REJECT. The platform currently holds durable evidence for artifact
integrity and ffprobe verification only, so a delegated approval requires those
plus every other check to be supplied with evidence by an authorized producer —
otherwise HERMES rejects. That is the intended behaviour, not a stub.

## Persistence (migration 043, additive)

| Table | Purpose |
|---|---|
| `forge_publishing_approvals` | one row per request: binding, window, response, decision, authorization |
| `forge_approval_notifications` | outbox: `created → queued → attempted → delivered | failed`, one row per (approval, kind) |
| `forge_approval_deadline_leases` | worker lease + monotonic fencing token (one row per approval) |
| `forge_publishing_decisions` | append-only decision ledger (UPDATE/DELETE rejected by trigger) |
| `forge_delegation_policies` (038) | extended with `policy_version`, `permits_live_publishing`, `revoked_at` |

Policy registration only accepts `category = publishing` and the single action
`publishing.publish_publicly`; revocation sets `active = false` and
`revoked_at`. The finalizing transaction re-reads the policy `FOR SHARE` and
re-validates it against **database time**, so a revocation during evaluation
turns an intended APPROVE into a recorded REJECT (`POLICY_NOT_ACTIVE_AT_DECISION`).

## Publishing gate

`verifyAuthorization({approvalId, artifactSha256, destination})` revalidates, at
execution time: terminal approved status, `publishing_authorized`, authorization
expiry, exact artifact hash, destination membership, supersession/invalidation
and — for HERMES approvals — the live delegation policy. Any mismatch returns
`authorized:false` with a stable code (`ARTIFACT_HASH_MISMATCH`,
`DESTINATION_NOT_AUTHORIZED`, `AUTHORIZATION_EXPIRED`,
`DELEGATION_POLICY_NOT_ACTIVE`, `APPROVAL_REQUEST_SUPERSEDED`, …).

Owner authorizations expire one hour after the decision, mirroring the existing
owner-approval window cap (`ownerOperationsRouter` ≤ 1h). No code path can
publish without a passing gate result.

## Notifications — what is actually delivered

The configured channel is **`owner_inbox`**: the durable notification row,
readable by the Owner through `GET /api/publishing-approvals/requests/:id`.
Delivery is recorded only after the row is confirmed readable after commit.
No email, SMS or push transport is configured; when one is wired, a failing
transport must call `markNotificationFailed` and the five-hour clock stays
stopped. The outbox state is reported truthfully as
created/queued/attempted/delivered/failed — a row's existence is never reported
as delivery.

## HTTP surface

Mounted at `/api/publishing-approvals` behind the Owner session gate, Owner-role
check and CSRF guard used by the FORGE control plane. Owner identity comes only
from the authenticated session; a client-supplied `ownerId` is refused.

```
POST /requests                      submit (idempotent by idempotencyKey)
GET  /requests                      Owner-scoped list
GET  /requests/:id                  request + notifications + decisions
POST /requests/:id/notify           bounded delivery retry
POST /requests/:id/owner-decision   APPROVE | REJECT | CHANGES_REQUESTED
POST /requests/:id/invalidate       artifact change / withdrawal
GET  /requests/:id/authorization    publishing gate revalidation
POST /deadline/run                  run one durable deadline cycle
POST /policies                      register a delegated publishing policy
POST /policies/:policyId/revoke     revoke it
```

In production a missing PostgreSQL pool returns `503
PUBLISHING_APPROVALS_UNAVAILABLE`; there is no memory fallback. Demo mode has no
approval store at all (the mount answers 503 there too) because a non-durable
approval store would be a false authorization claim.

## Worker

`PublishingApprovalDeadlineWorker.runOnce()` claims expired requests, gathers
evidence (`checksProvider`), evaluates, finalizes under the lease, and queues +
attempts the decision notification. `start({intervalMs})` runs it on an
`unref`'d interval; it is disabled with `STPH_APPROVAL_WORKER=disabled` and the
interval is configurable via `STPH_APPROVAL_WORKER_INTERVAL_MS`.

## Tests

* `tests/publishingApprovalPolicy.test.js` — pure evaluator and authority tests.
* `tests/hermesPublishingApproval.integration.js` — PostgreSQL 15 scenarios A–O
  (five-hour clock, delivery failure, Owner approve/reject, HERMES approve/reject,
  missing policy, restart recovery, two workers, Owner/deadline race, artifact
  change, revoked policy, duplicate processing, Owner-reserved authority, and
  the mounted HTTP router with the real repository and worker).

## Rollback

`sql/rollback/043_hermes_publishing_approvals_rollback.sql` drops the four new
objects and the three additive policy columns. Existing `forge_delegation_policies`
rows are preserved. Migration `sql/047_five_platform_support.sql` (with rollback
`sql/rollback/047_five_platform_support_rollback.sql`) extends the destination
bounds and allowlists across `publish_destinations`, `owner_analytics_records`,
and `forge_publishing_approvals` to support all five canonical platforms
(`youtube`, `instagram`, `facebook`, `snapchat`, `bilibili`).

