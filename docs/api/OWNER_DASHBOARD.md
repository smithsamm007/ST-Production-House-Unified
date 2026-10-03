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
| Command Center | `/api/health`, `/api/metrics`, `/api/channels`, `/api/productions`, real artifact rows; channel cards with destination chips + media-slot grid |
| Directors | `/api/channels` + `/api/channels/:id` (public branding + releases + destinations); same channel cards |
| Director Communication | `/api/directors/:agentId/conversation` (GET + POST) |
| Director Memory | `/api/directors/:agentId/memory` |
| Production | `/api/productions` (GET/POST), `/api/productions/:id` (+`/run`, `/publish`) |
| Active Jobs | `/api/metrics` counters + `/api/content-runs` |
| Provider Status | `/api/providers/catalog` (governed catalog, official credential URLs) |
| Quotas | honest note: no quota read route exists on this server; real queue counters from `/api/metrics` |
| Secrets & Connections | `/api/providers/catalog`; `/api/connections/directors/:agentId` (list/upsert/delete/test; secret field KEYS only, Rule 17) |
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

### Channel cards (Command Center + Directors)

Each channel card renders only real, durable data:

- **Platform chips** — the channel's configured publishing destinations from
  `/api/channels/:id` (platform + primary marker). No destinations → an
  explicit "no destinations configured" chip; a failed lookup → an explicit
  "destination lookup failed" chip. Unconfigured platforms are never shown as
  if connected.
- **Media-slot grid** — bound to the channel's most recent release
  (`/api/productions/:id`). The four canonical slots (S-M34-01):
  - `Main Video` — filled only by an artifact with kind `video` recorded at
    the `assembly` stage.
  - `Short 1` / `Short 2` / `Brand Reel` — filled only by a `reels` stage
    pipeline event with status `succeeded` whose `detail.reel` is
    `content_reel_1` / `content_reel_2` / `brand_reel` (the canonical
    identities from `src/pipeline/reelsStage.js`), matched to its artifact by
    sha256.
  - A slot without that evidence shows "no media yet — ffprobe verification
    pending"; a channel without releases shows "no release planned yet"; a
    failed detail lookup shows an explicit error note. No thumbnails,
    durations, dates, or engagement numbers are ever invented (Rule 1).
- **Footer** — the channel tagline, plus release count, slug, language and
  director-slot rows.

## Security posture

- Sessions: the login form posts to `/api/auth/login`; the session is an
  HttpOnly cookie (`SameSite=Strict`). Mutations made by the UI carry the
  login-issued CSRF token via `x-csrf-token` (server-enforced).
- Rule 15: internal director names are never fetched or rendered. Director
  selectors label entries as `Director <agentId> · <public channel name>`;
  panels show only public channel branding.
- Rule 17: the connections panel builds fields from the safe provider catalog,
  accepts only opaque secret-manager locators for secret references, clears
  them after saving, and lists secret field KEYS only; saved locator values
  never serialize back to the client. Existing owner-scoped routes enforce
  CSRF, validation, audit, and deletion scoping.
- Connection tests display the API's real outcome. Without a configured live
  test transport, the result is `unverified`, never success. Saving a binding
  does not perform OAuth or prove provider connectivity.
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
descriptor, the pipeline stage enum, the canonical media-slot identities
(against `CANONICAL_REELS`), and scans the public assets for Rule 15 name
leakage and secret-shaped literals.
