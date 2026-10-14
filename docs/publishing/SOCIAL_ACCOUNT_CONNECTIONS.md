# Per-Director social account connections (sql/030)

> Section 6 of the master contract: **Independent social-media accounts for
> every Director.** Issue #206 built the YouTube lifecycle; this is the generic
> engine that gives every other supported platform the identical security
> contract, so a new Director (or a newly approved platform) needs no bespoke
> source changes.

Everything below is offline-verifiable: no network call is made by the test
suite, no live provider account is contacted, and no real credential exists
anywhere in the repository.

## 1. The owner workflow

1. Open **Secrets & Connections** in the dashboard and pick a Director.
2. In the **Social accounts** panel, pick a platform.
3. **Connect account** → the server mints a single-use state and returns the
   OFFICIAL provider authorization URL; the browser navigates there.
4. The owner authorizes; the provider redirects back to
   `/api/social/<provider>/callback?code&state`.
5. The server consumes the state atomically, exchanges the code at the official
   token endpoint, verifies the account through the official identity API, hands
   the tokens to the external secret manager, and stores the opaque locator.
6. The panel shows the honest Director-scoped status; **Revoke access** runs the
   owner-authorized revocation.

The authorization `code` is never rendered, logged, or put in a redirect URL.

## 2. Supported platforms and their official endpoints

Each entry is frozen in `src/catalog/socialOAuthProviders.js`, HTTPS-only, on an
explicit official-host allowlist (`assertOfficialEndpoint`). Nothing is invented.

| Provider | Authorize | Token | Identity | PKCE |
|---|---|---|---|---|
| facebook | `https://www.facebook.com/v26.0/dialog/oauth` | `GET https://graph.facebook.com/v26.0/oauth/access_token` | `GET https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token,instagram_business_account` | — |
| instagram | same Meta authorize | same Meta token | same `/me/accounts` (linked Instagram professional account) | — |
| snapchat | `https://accounts.snapchat.com/login/oauth2/authorize` | `POST https://accounts.snapchat.com/login/oauth2/access_token` | `GET https://businessapi.snapchat.com/v1/public_profiles/my_profile` | S256 |
| bilibili | `https://account.bilibili.com/pc/account-pc/auth/oauth` (callback param `gourl`) | `POST https://api.bilibili.com/x/account-oauth2/v1/token` | **unconfirmed — none invented** | — |

Notes, taken from the official documentation at the time of writing:

- Meta documents the code exchange **without** a `grant_type` parameter and with
  the user token on `GET`; the adapter matches that shape.
- Meta's plain code flow does not use PKCE; the documented PKCE flow is OIDC-only
  and in testing, so it is not used here.
- Snap's server-side example uses PKCE `S256`; the adapter does.
- Bilibili's official authorized-user identity endpoint could not be confirmed
  from accessible documentation, so **no identity URL is invented**. Bilibili is
  therefore registered, disclosed as `connectable: false`, and `start()` refuses
  it with `OAUTH_PROVIDER_IDENTITY_UNCONFIRMED`. It becomes connectable the day
  the official endpoint is confirmed.

## 3. Security contract

- **Session + CSRF + audit.** Routes mount at `/api/social` behind
  `authenticateOwner`; every mutation additionally requires the per-session CSRF
  token (`x-csrf-token`), and every state change writes an audit event whose
  payload carries only `agentId`/`providerKey`/`errorCode`/`accountId`.
- **Server-authoritative owner + Director scoping.** `req.ownerId` comes from
  the session; every read/write is scoped by BOTH `owner_id` and `agent_id`, so
  a cross-owner or cross-director access is indistinguishable from a missing row.
- **Hashed, single-use, expiring state.** The state token is 32 crypto-random
  bytes; the DB stores ONLY its SHA-256 hash. Consumption is one conditional
  `UPDATE ... WHERE consumed_at IS NULL`, so a replayed callback matches zero
  rows (`OAUTH_STATE_REPLAYED`). Binding checks (owner, provider, expiry) run
  BEFORE the claim so a mismatched callback never burns the state.
- **PKCE without extra secrets.** Where a provider documents PKCE, the
  `code_verifier` is the base64url SHA-256 of `stph-social-pkce:<state>` and the
  `code_challenge` is S256 over it. The callback receives the state in plaintext
  and rebuilds the same verifier — nothing extra is persisted.
- **Opaque custody only.** Tokens go ONLY to the injected external
  secret-manager adapter; PostgreSQL stores an opaque `vault://`/`opaque://`
  locator (enforced by a DB CHECK **and** repository re-validation). No token,
  client secret, locator, or authorization code ever appears in a DTO, log,
  audit payload, or error message (Rule 17).
- **Fail closed.** Missing app configuration → `OAUTH_NOT_CONFIGURED` (503).
  Missing secret-manager adapter → `SECRET_MANAGER_NOT_CONFIGURED` (503).
  Unsupported provider → 404. Unconfirmed identity → 501.
- **No new states.** Account status uses the existing `sql/003` enum values
  (`unconfigured | connected | expired | disconnected`); a missing row is
  `unconfigured`.

## 4. Configuration (operator-level, never per Director)

Application-wide developer credentials are configured centrally, once:

| Env var | Meaning |
|---|---|
| `STPH_SOCIAL_OAUTH_REDIRECT_BASE_URL` | HTTPS base used to derive each callback URI (never taken from request headers) |
| `STPH_<PROVIDER>_OAUTH_CLIENT_ID` | e.g. `STPH_FACEBOOK_OAUTH_CLIENT_ID` |
| `STPH_<PROVIDER>_OAUTH_CLIENT_SECRET` | e.g. `STPH_SNAPCHAT_OAUTH_CLIENT_SECRET` |

The secret-manager adapter is the SAME one YouTube uses
(`STPH_SECRET_MANAGER_ADAPTER`, `src/credentials/oauthSecretManagerAdapter.js`):
one custody boundary for every platform.

## 5. Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/api/social/providers` | safe provider metadata (no secret-shaped fields) |
| GET | `/api/social/directors/:agentId/accounts` | every platform's status for one Director |
| GET | `/api/social/directors/:agentId/:providerKey/status` | one provider's honest status |
| POST | `/api/social/directors/:agentId/:providerKey/oauth/start` | CSRF; returns the official authorization URL |
| GET | `/api/social/:providerKey/callback` | provider redirect; session-authenticated |
| POST | `/api/social/directors/:agentId/:providerKey/revoke` | CSRF; honest revocation facts |

## 6. Publishing credentials

`SocialOAuthService.getPublishingCredential({ ownerId, agentId, providerKey })`
resolves the connected account's access token ONLY through the secret-manager
boundary and returns `{ accessToken, accountId, accountName }` for a single
publish invocation. It fails closed with `OAUTH_ACCOUNT_NOT_FOUND` /
`OAUTH_ACCOUNT_NOT_CONNECTED` / `OAUTH_SECRET_READ_FAILED`.

## 7. Tests

- `tests/socialOAuthLifecycle.test.js` — registry safety, state crypto,
  PKCE derivation, per-provider URL/param shapes, identity parsers, the full
  offline lifecycle through the demo adapter, replay/expiry/mismatch, honest
  status and revocation.
- `tests/socialOAuthApi.test.js` — the real express routes over demo storage:
  session auth, CSRF, provider catalog, unconfirmed/unknown provider handling,
  a full connect round-trip through the callback redirect, replay, revoke, and
  Director isolation.

Run: `node --test tests/socialOAuthLifecycle.test.js tests/socialOAuthApi.test.js`

## 8. Remaining owner actions

1. Apply `sql/030_social_oauth_accounts.sql` via `npm run migrate` on a real
   PostgreSQL (the demo adapter exercises the same statements in-memory).
2. Register the developer apps with each platform, obtain client IDs/secrets,
   configure the redirect URIs, and set the env vars above.
3. Wire a durable secret-manager adapter (`STPH_SECRET_MANAGER_ADAPTER`).
4. Confirm Bilibili's official identity endpoint to make it connectable.

Live OAuth, real accounts, and live publishing remain owner-gated (Rule 16 /
Issue #118). This document claims no live connection, upload, or receipt.
