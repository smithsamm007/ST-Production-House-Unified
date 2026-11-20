# Durable Notifications & Daily FORGE Report (D6)

Migration `sql/044_durable_notifications_and_daily_reports.sql` (rollback in
`sql/rollback/044_durable_notifications_and_daily_reports_rollback.sql`).
Additive only: 001–043 are untouched, including the D5 approval outbox.

## Why

D5 proves HERMES can decide a five-hour Owner window durably, but it only had
one narrow notification table (`forge_approval_notifications`). The Owner also
needs one truthful transport for every operational event, and an autonomous
daily report that describes what actually happened — including what did not
happen.

## Tables

| Table | Purpose |
|---|---|
| `forge_notification_events` | One row per logical notification: type, priority, recipient (`OWNER` or `director:<id>`), Owner scope, task reference, idempotency key, sanitized JSON payload, read state. |
| `forge_notification_deliveries` | Per-channel delivery state machine, attempts, bounded retry time, error classification, lease owner/expiry, fencing token, channel reference. |
| `forge_notification_channels` | Deployment truth (`runtime_configured`, transport) separated from the Owner's `owner_enabled` decision. `owner_inbox` can never be disabled. |
| `forge_daily_reports` | Exactly one report per reporting date, canonical payload, SHA-256 evidence hash, evidence references, generation lease/fencing, notification link. Completed payloads are immutable (trigger). |
| `forge_report_schedule` | Single durable schedule row: timezone, local hour/minute, missed-run policy, last run, next run. |

## Event taxonomy and priority

CRITICAL: `HERMES_DECISION`, `APPROVAL_DEADLINE_OUTCOME`, `PUBLISHING_FAILED`,
`SECURITY_ALERT`, `AUTHORIZATION_ALERT`.
HIGH: `OWNER_APPROVAL_REQUEST`, `FORGE_TASK_FAILED`, `WORKER_CRASH`,
`WORKER_RETRY_EXHAUSTED`, `DIRECTOR_PRODUCTION_FAILED`,
`PROVIDER_QUOTA_EXHAUSTED`, `DELIVERY_ALERT`.
NORMAL: `FORGE_TASK_COMPLETED`.
LOW: `DAILY_FORGE_REPORT`.

Priority is a property of the event class. A caller may escalate but never
downgrade a CRITICAL class.

## Delivery state machine

```
created → queued → attempted → delivered
                    attempted → failed → retry_scheduled → attempted
                               failed → dead_letter        (exhausted / permanent)
created → unconfigured                                     (no transport)
```

- `delivered` requires a real adapter confirmation and a `delivered_at`.
- A database insert alone is never "delivered".
- Backoff: `min(3600s, 30s × 2^(attempt-1))` ±20 % jitter, computed on database
  time (`clock_timestamp() + interval`), never a JS timer.
- `PERMANENT`/`UNCONFIGURED` failures dead-letter immediately; `TRANSIENT`,
  `RATE_LIMITED` and `AUTHENTICATION` retry up to `max_attempts` (default 5).
- Every dead letter creates a `DELIVERY_ALERT` notification in the Owner inbox;
  a CRITICAL event that fails twice also raises one. Alerts are idempotent per
  `(delivery, reason)`.
- Claims use `FOR UPDATE SKIP LOCKED` plus a monotonic `fencing_token`; a stale
  worker is refused with `DELIVERY_FENCING_STALE`.
- Restart recovery requeues `attempted` rows whose lease expired
  (`WORKER_LEASE_EXPIRED`); the attempt already counted, so retries stay bounded.
- Manual Owner retry is bounded by `attempts < 20` and scoped to the Owner.

## Channels

| Channel | Configuration source | Honest default |
|---|---|---|
| `owner_inbox` | Always available (durable custody row) | configured |
| `email` | Injected Owner transport (`STPH_EMAIL_TRANSPORT` locator); none ships | unconfigured |
| `webhook` | `STPH_NOTIFICATION_WEBHOOK_URL` (https only) | unconfigured |
| `push` | `STPH_PUSH_WEBHOOK_URL` (https only); no provider SDK | unconfigured |

Unconfigured channels are stored as durable `unconfigured` deliveries with
0 attempts. They are never counted as deliveries, and no code claims a message
was sent. Notification payloads are allowlist-sanitized (`sanitizeNotificationPayload`):
secret-looking keys are dropped, URL userinfo and bearer strings are redacted,
strings are truncated and structures bounded before storage, transport or log.

## Daily report

Default schedule: **08:00 `Asia/Kolkata`**, Owner-configurable (hour, minute,
IANA zone, enabled, missed-run policy). The single schedule row is created
idempotently by the report repository on first use, with the local instant
computed from the runtime IANA database. The durable `next_run_at` is the
authority; the timer only triggers a cycle.

Generation:

1. Lock the single schedule row, compare `next_run_at` with `clock_timestamp()`.
2. Reporting date = the local date of the *scheduled* run (not the wake-up day).
3. `INSERT … ON CONFLICT (report_date) DO NOTHING` — one report per date.
4. Advance `next_run_at` durably, generate outside the lock under a lease and
   fencing token, then complete the row (payload + evidence hash + refs).
5. Missing/crashed runs: `RUN_ONCE_ON_RECOVERY` (default) generates the one
   missed report; `SKIP` records the skip and advances without generating.
6. A `generating` row whose lease expired is re-claimed after a restart.
7. Deliver a `DAILY_FORGE_REPORT` notification to the Owner inbox; the report is
   already durable, so an external channel failure cannot destroy it.

Every section is assembled from persisted records. Accuracy states:
`IMPLEMENTED`, `UNIT_TESTED`, `INTEGRATION_TESTED`, `CI_VERIFIED`,
`PROVIDER_VERIFIED`, `PRODUCTION_VERIFIED`, `BLOCKED`, `NOT_RUN`.

Examples of honest labelling in the current report:

- Git start/end SHAs: `CI_VERIFIED` from `forge_ci_results` when recorded, else
  `NOT_RUN`.
- Issues, file diffs, research, scripts, characters, voice, music, renders,
  final packages, backups, storage and cloud runtime: `NOT_RUN` — no durable
  source exists, so nothing is claimed.
- Artifacts recorded but not `ffprobe_verified`: `BLOCKED`.
- Uploads: attempted (`INTEGRATION_TESTED`) vs confirmed (`PROVIDER_VERIFIED`
  from `publishing_receipts`); approved-without-receipt is `NOT_RUN`.
- Notification delivery: per-channel state; an outbox row is never external
  delivery.

`evidence_hash = sha256(canonicalJson(payload without evidenceHash))`, stable
across runs for identical records; `verifyReportEvidenceHash` recomputes it.
Completed payloads cannot be rewritten (database trigger).

## Owner API

Mounted in `src/catalog/server.js` behind `authenticateOwner` +
`createForgeOwnerSessionGate` + `forgeCsrfGuard`; 503 without durable PostgreSQL.

`/api/notifications`: `GET /inbox`, `GET /inbox/unread-count`,
`POST /inbox/read-all`, `GET /inbox/:id`, `POST /inbox/:id/read`,
`GET /deliveries/dead-letter`, `POST /deliveries/:id/retry`, `POST /run`,
`GET /channels`, `PATCH /channels/:channel`, `GET /status`.

`/api/forge-reports`: `GET /reports`, `GET /reports/latest`, `GET /reports/:id`,
`POST /reports/run`, `GET /schedule`, `PATCH /schedule`, `GET /status`.

Owner console: **Inbox & Reports** (`src/screens/NotificationsScreen.tsx`) shows
unread/critical counters, priority, timestamps, task references, real per-channel
delivery state, dead-letter retry, report history, full report view with the
evidence hash and references, generation status, last/next run, channel toggles
and the schedule form. Report payloads and audit evidence are read-only.

## Worker configuration

| Env | Default | Meaning |
|---|---|---|
| `STPH_NOTIFICATION_WORKER` | enabled | `disabled` stops the delivery worker |
| `STPH_NOTIFICATION_WORKER_INTERVAL_MS` | 15000 | cycle trigger only |
| `STPH_REPORT_SCHEDULER` | enabled | `disabled` stops the report scheduler |
| `STPH_REPORT_SCHEDULER_INTERVAL_MS` | 60000 | cycle trigger only |

## Verification

- `tests/notificationPolicy.test.js` — 8 unit tests (priority, backoff, error
  classification, sanitizer, timezone/DST schedule, canonical hash).
- `tests/durableNotificationsDailyReport.integration.js` — scenarios A–T against
  a disposable PostgreSQL database using the canonical migrations, including
  two-worker contention, restart recovery, deadline-free scheduler idempotency,
  missed-run policy, report/record reconciliation and HTTP authorization.

## Limits

- No email/push provider is configured in this repository; those channels remain
  `unconfigured` until a deployment supplies a transport/URL.
- GitHub issues, CI run identity, backups, storage and cloud runtime have no
  durable server-side source; the report labels them `NOT_RUN`.
- Reports are FORGE-wide operational reports; the Owner notification is scoped
  to the first Owner row in this single-Owner deployment.
