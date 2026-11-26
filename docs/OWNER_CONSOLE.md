# Owner Console — authenticated API connectivity (FORGE Day 2)

The Owner Console is a React client served by the **same Express process** as the
API (`node server.js`). It holds no demo fixtures and makes no claim it cannot
back with a real request. This document is the contract for what is connected,
what is not, and how each state is shown.

## 1. Running the full stack

```bash
npm ci                 # from the lockfile only
npm run build          # Vite → dist/ (the console the API serves)
npm start              # node server.js → dist/ + /api on 0.0.0.0:3000
```

Development with hot reload (`vite` on 5173, `/api` proxied to 3000):

```bash
npm run dev            # console with HMR
npm run dev:api        # control plane on 3000
```

Storage is chosen at boot: PostgreSQL via `DATABASE_URL`/`PG*`, or the
explicitly non-durable `STPH_DEMO_STORAGE=1` adapter (refused when
`NODE_ENV=production`). `/api/health` reports which one is live; the console
displays that value verbatim, and a demo adapter is shown as
`YES (non-durable)` — never as production storage.

## 2. Authentication flow

| Step | Request | Notes |
|---|---|---|
| Session restore (every page load) | `GET /api/auth/me` | The **only** authority on identity. 401 → login screen. |
| Sign in | `POST /api/auth/login` | Sets the `HttpOnly; SameSite=Strict` session cookie and returns the per-session CSRF token. |
| MFA challenge | `POST /api/auth/mfa/verify` | Only when the Owner has MFA enabled and the session assurance is not `high_assurance`. |
| Sign out | `POST /api/auth/logout` | Requires `x-csrf-token`; revokes the server session and clears the cookie. |
| Bootstrap | `POST /api/auth/register` | First Owner only; the backend refuses later registration. |

Session rules enforced by the client:

- The CSRF token lives **in memory** (`OwnerApiClient.csrfToken`). It is never
  written to `localStorage`, `sessionStorage`, a cookie, or a log.
- No password, session token, CSRF token or Owner identity is persisted in the
  browser. Only one key is written: `stph_owner_console_prefs_v1`
  (`{ defaultPublishingMode }`), a non-sensitive display preference that cannot
  authorize a publish.
- A 401 from any request clears the client-side session and returns the console
  to the login screen. A local flag can never make the console look signed in.

## 3. Shared API client

`src/api/client.js` is the only HTTP path used by console screens
(`src/api/ownerConsoleApi.js` maps it to the mounted routes).

It handles same-origin routing, `credentials: "same-origin"`, JSON
serialization, the `x-csrf-token` header on mutations, and the server's
structured error contract (`{error: "CODE"}` or `{code, message}`).

| Failure | Kind | UI behaviour |
|---|---|---|
| 401 | `unauthorized` | session-expired notice, back to login |
| 403 | `forbidden` | refusal shown; `MFA_ASSURANCE_REQUIRED` explained |
| 404 | `not_found` | record does not exist |
| 409 | `conflict` | state conflict, manual reload |
| 400/413/422 | `validation` | payload rejected, backend code shown |
| 429 | `rate_limited` | manual retry only |
| 501/503 | `unavailable` | capability unavailable |
| 5xx | `server` | server error |
| no response | `network` / `offline` | OFFLINE state |
| `AbortError` | `aborted` | request cancelled |

**Nothing is retried automatically.** `get()` accepts an explicit `{retry: 1}`
for read-only refreshes only; publishing, approvals, connection writes, job
transitions and Director messages are never retried.

## 4. Data-source semantics

Every screen shows a badge: `LIVE`, `LOADING`, `STALE`, `OFFLINE`, `DEMO`,
`UNAVAILABLE`, `UNAUTHORIZED`, `ERROR`.

- `LIVE` carries the last successful read time.
- `STALE` means older data is on screen and the latest refresh failed.
- `UNAVAILABLE` means the backend capability does not exist; the screen states
  the gap instead of rendering a plausible substitute.
- A screen with no data shows an explanatory empty state, never fixture rows.

## 5. Screen → API matrix

| Screen | Read | Write | Status |
|---|---|---|---|
| Login | `GET /api/auth/me` | `POST /api/auth/login`, `/mfa/verify` | connected |
| Command Center | `/api/metrics`, `/api/health`, `/api/ready`, `/api/agents`, `/api/channels`, `/api/productions`, `/api/publishing-approvals/requests`, `/api/hermes/overview` | — | connected |
| Directors | `/api/agents`, `/api/channels` | `POST /api/channels` | connected (search, status/channel filters, pagination) |
| Schedule | `/api/scheduling/directors` | `PUT /api/scheduling/directors/:id`, `POST …/:id/run` | connected |
| Production | `/api/productions` | `POST /api/productions`, `POST /api/productions/:id/run` | connected |
| Jobs | `/api/metrics` (counts) | — | **UNAVAILABLE** — no job collection route |
| Approvals | `GET /api/publishing-approvals/requests` | — | read-only; keeps the full HERMES decision record, 5-hour response window, notification ledger and the 11-check scorecard **when the API returns one**. Decision controls (approve / request changes / reject, HERMES deadline cycle) are deliberately not rendered: the routes exist but the durable decision workflow is not yet separately accepted |
| Connections | `GET /api/connections/directors/:id` | — | read-only; OAuth/secret-manager writes not performed |
| Providers | `GET /api/providers/catalog` | — | connected (metadata only) |
| Evidence | `GET /api/evidence` | — | connected |
| HERMES | `/api/hermes/overview`, `/api/hermes/decisions` | — | connected (delegation matrix is a read-only blueprint) |
| Memory | `GET /api/directors/:id/memory` | — | connected; charters are not persisted |
| Communication | `GET /api/director-comm/:id/messages` | `POST /api/director-comm/:id/messages` | connected; provider failure stays 503 |
| Settings | `/api/auth/me`, `/api/health`, `/api/ready`, `/api/auth/sessions` | `POST /api/auth/logout` | connected |
| Fleet | existing `/api/fleet` | existing routes | connected (now via the shared client) |
| Inbox & Reports | existing `/api/notifications`, `/api/forge-reports` | existing routes | connected (now via the shared client) |

## 6. Known backend gaps (stated in the UI, never invented)

- **Job list & controls** — no `GET /api/jobs` collection route; queue control
  lives behind `/api/control/*`. Pause/resume/cancel are not rendered.
- **Publishing approvals** — returns `503 PUBLISHING_APPROVALS_UNAVAILABLE`
  without durable PostgreSQL; decision actions are Day 3/Day 4 scope.
- **Approval evidence** — no route returns the 11-check breakdown, so it is not
  displayed.
- **Provider quota/latency** — no telemetry route exists; the catalog shows
  metadata only.
- **Owner availability & delegation policies** — not persisted by any route; the
  HERMES screen shows them as UNAVAILABLE rather than as decided state.
- **Media slots / creative charters** — console-only demo constructs with no
  backend record; both were removed from the screens.
- **Connections writes** — need an OAuth flow plus an opaque secret-manager
  locator; Day 2 performs neither.

## 7. Demo-data behaviour

There is no demo dataset in the console. `STPH_DEMO_STORAGE=1` is a labelled,
non-durable backend adapter used for local review; `/api/health` reports
`isDemoStorage: true` and the console renders that value. Because the demo
adapter does not implement PostgreSQL aggregates, `/api/metrics` counters read
0; the Command Center therefore counts Directors and channels from the records
it actually received, and the Job Queue strip is annotated as a metrics read.

## 8. Code splitting

Screens are loaded with `React.lazy` + `Suspense`; the login screen and shell
stay in the entry chunk. Measured bundle change (Vite production build):

Main's vendor split (`react-vendor`, `icons`) is kept; the per-screen `React.lazy`
imports live in `src/App.tsx`. Measured on the integrated branch (`npm run build`):

| Chunk | Size | gzip |
|---|---|---|
| `index-*.js` (shell + login) | 266.43 kB | 81.66 kB |
| `icons-*.js` (vendor) | 21.32 kB | 6.26 kB |
| per-screen chunks | 4.24 – 17.92 kB each | 1.66 – 6.01 kB each |

No browser performance measurement was performed; this is a size measurement
only.

## 9. Test evidence

Executed on the integrated branch (main `1e1044c` + this console work):

| Command | Result |
|---|---|
| `npm test` | exit 0 — 1730 tests, 1730 pass, 0 fail, 0 skipped (48.1 s) |
| `npm run lint` | exit 0 — tsc clean; 394 JS/ESM files, 47 SQL migrations, HEALTHY |
| `npm run verify` | exit 0 |
| `npm run plan:check` | exit 0 — `DEVELOPMENT_PLAN_VALID`, 11 tasks |
| `npm run build` | exit 0 (2.94 s) |
| `npm run test:integration` | **not run** — no PostgreSQL 15 instance in this environment |

`npm ci` cannot run against current main: its `package-lock.json` is out of sync
with `package.json` (the `@google/genai` dependency tree is missing from the
lock). Dependencies were therefore installed with `npm install --no-package-lock`
so that no tracked file changed. Repairing the lockfile is a separate change.
No PostgreSQL-backed behaviour (login, session, CSRF, persistence, durability)
was exercised; that evidence is still owed.

Day 2 tests: `tests/ownerApiClient.test.js` (23 assertions incl. CSRF, no
auto-retry, 401/403/409/422/429/503 mapping), `tests/consoleApiContract.test.js`
(unauthenticated Owner routes/mutations, login validation, JSON 404, headers),
`tests/consoleSessionHonesty.test.js` (no persisted session, no demo login, no
invented slot/quota/approval data).
