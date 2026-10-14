# Cross-Platform Publishing Dry-Run End-to-End Validation (S-M38-01)

> Status: **offline-verified**. This documents the cross-platform publishing
> proof shipped in `tests/crossPlatformPublishingE2e.test.js`: the REAL owner
> publish boundary (POST `/ops/publishing/:agentId/private-test`) driven in
> destination-router mode across `youtube`, `instagram`, `facebook`, and
> `snapchat` with scripted per-destination publishers. No network call, no
> real platform upload, no real account — every "receipt" is a fixed scripted
> response recorded as a **private-first dry-run** receipt only.

## What the validation proves

1. **Exact destination dispatch.** When a deployment wires a
   `publishersByDestination` registry, a request for one destination reaches
   ONLY that destination's publisher: each recording publisher receives
   exactly one dispatch per request carrying its own `destination`, the
   requested `mode` (private or draft), the verified `artifactSha256`, and the
   server-bound attribution snapshot. A destination is never silently served
   by another platform's publisher.

2. **Honest receipts, per destination.** The route returns
   `status: "platform_verified"` with `platformPostId`/`platformUrl` strictly
   taken from the scripted publisher response, hashed into
   `providerResponseSha256` over the raw response body, serialized through the
   allowlisted DTO (no approval internals, no credentials, no internal agent
   names — Rules 15/17).

3. **Durable evidence per destination.** One `private_publishing_test` audit
   row per successful destination (Rule 6) and one `platform_publish`
   evidence-ledger entry per destination, classified `private_first`, carrying
   owner/agent/destination/mode/artifact hash/receipt — never credential
   material.

4. **Fail-closed matrix.**
   - A *supported-but-unwired* destination (e.g. a deployment without a
     snapchat publisher) returns honest `503 PUBLISHING_TRANSPORT_UNAVAILABLE`
     with **zero** publisher invocations, no audit success, and no evidence;
     wired destinations keep working on the same deployment.
   - A *failing destination publisher* yields a truthful non-2xx with no
     `platform_verified` status, no invented platform id or URL, and no
     `platform_publish` evidence (Rules 1 and 2) — while other destinations
     remain unaffected in the same session.
   - A *request-supplied* `publisher` is structurally rejected
     (`400 CLIENT_TRANSPORT_FORBIDDEN`): transport selection is server-side
     only, in router mode exactly as in legacy single-publisher mode.

5. **Mode honesty.** Draft and private modes both record their mode honestly
   in audit rows and evidence payloads; the action is always the private-first
   publishing test, never a claim of public publishing (Rule 7).

## Deployment wiring (operator reference)

The registry is a server-side deployment option on the owner app — never a
request body field:

- `publishersByDestination` maps destination keys to adapters implementing the
  shared `publisher.publish()` contract: `youtube` → `youtubePublisher`,
  `instagram`/`facebook` → `metaPublisher`, `snapchat` → `snapchatPublisher`,
  `bilibili` → `bilibiliPublisher` (unwired by default). Omitted or unresolvable
  keys degrade to the honest 503 above.

Per-Director credentials for these adapters resolve through the vault
boundary — the built-in secret-manager adapters are configured with:

- `STPH_SECRET_MANAGER_ADAPTER` (`builtin-env` | `vault-http` | `custom`)
- `STPH_SECRET_MANAGER_VAULT_ADDRESS`, `STPH_SECRET_MANAGER_VAULT_MOUNT`,
  `STPH_SECRET_MANAGER_VAULT_TOKEN` or `STPH_SECRET_MANAGER_VAULT_TOKEN_FILE`
- Developer-app OAuth configuration is named per provider:
  `STPH_SOCIAL_OAUTH_REDIRECT_BASE_URL` + `STPH_<PROVIDER>_OAUTH_CLIENT_ID` /
  `STPH_<PROVIDER>_OAUTH_CLIENT_SECRET` (exact names from
  `src/catalog/socialOAuthProviders.js`).

## What is NOT proven here (honest scope)

- No live platform upload, no public publishing, no real receipts: live
  publishing requires explicit, unexpired owner approval bound to the exact
  artifact hash, destination, caption, affiliate links, and disclosure
  (Rule 7; owner-gated issue #118).
- Per-platform adapter behavior beyond the boundary (chunked uploads,
  resumable sessions, platform-side idempotency/receipt replay) is covered by
  the dedicated adapter test suites (`tests/youtubePublisher.test.js`,
  `tests/metaPublisher.test.js`, `tests/snapchatPublisher.test.js`,
  `tests/bilibiliPublisher.test.js`); those run against scripted transports
  too, and live platform validation remains pending owner action.
