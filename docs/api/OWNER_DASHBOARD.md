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
| Secrets & Connections | `/api/providers/catalog`; `/api/connections/directors/:agentId` (list/upsert/delete/test; secret field KEYS only, Rule 17); YouTube OAuth status/connect/revoke via `/api/youtube/*` (below) |
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

### YouTube account (official OAuth, Issue #206)

The Secrets & Connections panel includes an owner-scoped YouTube OAuth
lifecycle per Director (`/api/youtube`, session-authenticated; mutations
carry the CSRF token):

- `POST /api/youtube/directors/:agentId/oauth/start` — mints a
  cryptographically random single-use state (stored ONLY as a SHA-256 hash,
  bound to owner + director + provider + the server-controlled HTTPS redirect
  URI, expiring after 10 minutes) and returns the official
  `accounts.google.com` authorization URL. Requires operator-configured
  Google OAuth client credentials; otherwise an honest 503
  `OAUTH_NOT_CONFIGURED`.
- `GET /api/youtube/callback` — Google returns the owner's browser here; the
  state is atomically consumed (replay/expiry/mismatch → an honest
  `oauth=failed&code=…` redirect), the authorization code is exchanged at the
  official token endpoint server-side, and the YouTube channel is verified
  via the official API. The authorization code never appears in any redirect
  or response.
- `GET /api/youtube/directors/:agentId/status` — honest Director-scoped
  status from real rows: `unconfigured | connected | expired | disconnected`
  (the existing sql/003 enum), verified channel identity, token expiry,
  pending authorization, and whether the OAuth client and the external
  secret manager are configured. Nothing claims connectivity without a
  verified channel row.
- `POST /api/youtube/directors/:agentId/revoke` — owner-authorized
  revocation at the official Google endpoint plus secret-manager cleanup,
  reported as separate honest facts; a failed provider revocation keeps the
  account connected and records the error code.

Token storage: access/refresh tokens are handed ONLY to the injected external
secret-manager adapter; PostgreSQL persists the returned opaque `vault://` /
`opaque://` locator (sql/028) and nothing secret-shaped. Raw tokens never
serialize through any DTO, redirect, audit payload, or error message.

Honest gap: production wiring is intentionally not connected yet. The server
ships no secret-manager adapter, so until an operator wires one (via the
service runtime registry) and configures the Google OAuth client env vars,
connect attempts return an explicit 503 instead of pretending to connect.

### Operator secret-manager wiring (Issue #208)

The code-side wiring surface for the token-custody boundary above is now
implemented. At boot, `configureRuntime()` resolves the operator-declared
adapter and binds it to the OAuth runtime:

- `STPH_SECRET_MANAGER_ADAPTER=builtin-env` — zero-infrastructure adapter.
  Locators live in a process-local, NON-DURABLE map (optionally seeded from
  locator-shaped references in the env vars named by
  `STPH_SECRET_MANAGER_ENV_SEED`). Honest trade-off, surfaced in `/api/health`
  (`oauthSecretManager.nonDurable: true`): a process restart drops held token
  bundles and connected YouTube grants must be re-connected. Durable custody
  requires the `custom` kind.
- `STPH_SECRET_MANAGER_ADAPTER=custom` + `STPH_SECRET_MANAGER_ADAPTER_MODULE`
  — dynamic import of an operator factory module exporting a default async
  function returning `{ writeSecret, readSecret, deleteSecret }`. The module
  is the trust boundary; the supplied adapter must return locator-shaped
  values and may expose stable `code`-carrying errors.

Fail-closed guarantees (verified by tests): an unknown adapter kind wires
nothing; a declared adapter that fails to load is a LOUD boot error, never
silent degradation; a labeled in-memory placeholder supplied by an operator is
rejected (`SECRET_MANAGER_ADAPTER_PLACEHOLDER_REJECTED`, Rule 3); unexpected
adapter errors are sanitized (locators/secret-shaped strings redacted) and
normalized to stable codes; `writeSecret` results that are not locator-shaped
are structurally rejected before reaching the OAuth service.

#### Durable custody: built-in Vault adapter (Issue #210)

`STPH_SECRET_MANAGER_ADAPTER=vault-http` selects the built-in adapter for the
**official HashiCorp Vault KV v2 HTTP API** — DURABLE external custody, the
recommended production choice over the `builtin-env` stopgap:

- `STPH_SECRET_MANAGER_VAULT_ADDRESS` — Vault base URL. HTTPS required
  (plain http is accepted only for `localhost`/`127.0.0.1`/`[::1]` local
  development). Credentials and query strings in the address are rejected.
- `STPH_SECRET_MANAGER_VAULT_TOKEN` or `STPH_SECRET_MANAGER_VAULT_TOKEN_FILE`
  — the Vault token (the file form suits container/secret-volume deploys).
  The token is never logged, serialized, or included in error details.
- `STPH_SECRET_MANAGER_VAULT_MOUNT` — KV v2 mount (default `secret`).

Behavior: OAuth token bundles are written under
`stph/{ownerId}/{agentId}/{providerKey}/{unique}` in the Vault namespace —
Director + owner scoping is structural — and PostgreSQL persists only the
returned opaque `vault://{mount}/…` locator (existing CHECK constraints
already accept the scheme). A locator whose mount does not match the
configured mount is never resolved (confused-deputy fail-closed); raw `.`/`..`
traversal in a locator is rejected before any request. Vault 403/401 →
`SECRET_MANAGER_AUTH_FAILED`, 404 → `SECRET_MANAGER_ENTRY_NOT_FOUND`,
network failure → `SECRET_MANAGER_UNREACHABLE`; no error is ever translated
into success. `/api/health` reports `nonDurable: false` for this adapter.

OWNER ACTION REQUIRED for live operation: deploy/choose the Vault server,
provision a KV v2 mount, and issue a token whose policy grants create/read/
delete on `/{mount}/data/stph/**` and `/{mount}/metadata/stph/**`; then set
the env vars above. Until then the adapter wiring is code-complete but no
live custody occurs (tests inject the transport; no Vault is contacted).

Remaining operator steps for live YouTube connection (owner-gated, unchanged):
provide the Google OAuth client credentials (`STPH_YOUTUBE_OAUTH_CLIENT_ID`,
`STPH_YOUTUBE_OAUTH_CLIENT_SECRET`, `STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL`)
and a durable secret-manager adapter. Until both are present, the routes keep
returning honest 503s.

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
- YouTube OAuth (Issue #206) uses only official Google endpoints over HTTPS
  with a server-controlled redirect URI; the state token is stored only as a
  hash and is single-use; every start/callback/revoke writes an audit event
  carrying only agentId/providerKey/error-code facts.
- Publishing: the Rule 7 gate is enforced server-side. YouTube destinations
  execute the wired private-first upload and return a real durable receipt
  (or an honest stable failure code — never a fabricated platform ID); other
  platforms record intent only. Live uploads remain unverified until the
  owner provisions Vault + Google OAuth credentials (Issue #217).

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
