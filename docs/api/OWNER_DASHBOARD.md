# Owner Dashboard (static console) — `public/`

The unified control plane serves a static owner dashboard from `public/`:

- `GET /index.html` — the dashboard shell (also the SPA fallback for any
  non-API path).
- `GET /dashboard.js` — the dashboard runtime (vanilla, zero-dependency).
- `GET /styles.css` — the dashboard stylesheet.

The service descriptor (`GET /`) advertises `dashboard: "/index.html"`.

The dashboard ships in the same CSP regime as the API:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'
```

so the runtime is an external script (no inline `<script>`), with no external
fonts, CDNs, or image assets.

## What each panel shows

Every panel renders only what the corresponding API route actually returns.
Loading, error, and empty states are explicit; nothing is simulated
(Rule 1). The current panels:

| Sidebar item | Data source (all under `/api`, session-authenticated) |
|---|---|
| Command Center | `/api/health`, `/api/metrics`, `/api/channels`, `/api/productions`, real artifact rows |
| Directors | `/api/channels` + `/api/channels/:id` (public branding + releases + destinations) |
| Director Communication | `/api/directors/:agentId/conversation` (GET + POST) |
| Director Memory | `/api/directors/:agentId/memory` |
| Production | `/api/productions` (GET/POST), `/api/productions/:id` (+`/run`, `/publish`) |
| Active Jobs | `/api/metrics` counters + `/api/content-runs` |
| Provider Status | `/api/providers/catalog` (governed catalog, official credential URLs) |
| Quotas | honest note: no quota read route exists on this server; real queue counters from `/api/metrics` |
| Secrets & Connections | `/api/connections/directors/:agentId` (field KEYS only, Rule 17) |
| Publishing Accounts | `/api/channels/:id/destinations` (GET + POST) |
| Approvals | `/api/control/approvals` |
| Analytics | operational counters from `/api/metrics` (sql/027 records live in the owner-operations service; not exposed here) |
| Hermes Decisions | `/api/hermes/overview`, `/api/hermes/authority`, `/api/hermes/decisions` |
| Evidence | `/api/evidence` (append-only, hash-chained) |
| Alerts | honest note: no alert feed is mounted on this server yet |
| Settings | `/api/auth/me`, `/api/auth/sessions` (+ per-session revoke) |

The production-pipeline strip renders exactly the durable stage enum from
`pipeline_events` (sql/020 + 024 + 025): `story → visual → audio → assembly →
reels → packaging → qc → complete`. No fabricated stages are displayed.

## Security posture

- Sessions: the login form posts to `/api/auth/login`; the session is an
  HttpOnly cookie (`SameSite=Strict`). Mutations made by the UI carry the
  login-issued CSRF token via `x-csrf-token` (server-enforced).
- Rule 15: internal director names are never fetched or rendered. Director
  selectors label entries as `Director <agentId> · <public channel name>`;
  panels show only public channel branding.
- Rule 17: the connections panel lists secret field KEYS only; locator
  values never serialize to the client.
- Publishing: the UI records publish intent only (Rule 7 gate is enforced
  server-side); live platform calls remain pending.

## Honest gaps (deliberate)

- Quotas and Alerts panels display a truthful "not exposed by this server"
  note instead of invented numbers.
- Artifacts are shown with their real generation mode and
  `ffprobe_verified` state; releases without runs show "No media yet —
  ffprobe verification pending."

## Tests

`tests/staticDashboard.test.js` verifies the served files, SPA fallback,
descriptor, and scans the public assets for Rule 15 name leakage and
secret-shaped literals.
