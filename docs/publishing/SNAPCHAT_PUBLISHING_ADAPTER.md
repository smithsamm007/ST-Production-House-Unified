# Snapchat Publishing Adapter (Issue #221)

`src/publishing/snapchatPublisher.js` is the OFFICIAL Snapchat Public Profile
API boundary behind the same `publisher.publish(request) →
{ platformPostId, platformUrl, rawResponse }` contract as the YouTube
(`youtubePublisher.js`, Issue #215) and Meta (`metaPublisher.js`, Issue #219)
adapters.

## Official flow (fetched from developers.snap.com — never invented)

Source pages (fetched 2026-10): *Public Profile API → Profile Asset
Management* and *Public Profile API → Get Started*. The Public Profile API is
**allowlist-only** (Snap must approve the OAuth client before any call can
succeed) — a live-publishing custody fact, owner-gated via Issue #118.

1. **Create media container**
   `POST https://businessapi.snapchat.com/v1/public_profiles/{profile_id}/media`
   body `{ type: "VIDEO", name, key, iv }` — `key`/`iv` are the base64
   32-byte AES-256-CBC key and 16-byte IV the adapter generates fresh per
   publish, because the official protocol requires the media to be encrypted
   client-side before upload.
   Response: `{ request_id, request_status, media_id, add_path, finalize_path }`.
   A media object stays active for 24 hours.
2. **Encrypted multipart upload**
   `POST https://businessapi.snapchat.com{add_path}` (multipart/form-data):
   `action=ADD`, `file` (encrypted chunk ≤ 32 MB), `part_number` (1..35);
   then `action=FINALIZE` at `{finalize_path}`. Total file ≤ 1 GB.
3. **Post Spotlight**
   `POST https://businessapi.snapchat.com/v1/public_profiles/{profile_id}/spotlights`
   body `{ media_id, description, locale }` — description ≤ 160 characters
   (official constraint; hashtags allowed), locale required (e.g. `en_US`).
   Response: `{ request_id, spotlight_id, request_status }`.

### Why Spotlight and not Story

The Spotlight post response carries a REAL platform-issued `spotlight_id`,
which makes an honest receipt possible. The Story post response carries only
a `request_id` — no story identifier — so no honest
`platformPostId`-bound-to-content receipt is possible for stories. Story
posting is therefore deliberately NOT wired; that is a fail-closed choice,
not a missing feature.

## Receipt honesty (Rules 1–3)

- `platformPostId` is ONLY the real `spotlight_id` returned by the platform
  (`SNAP_RECEIPT_INVALID` otherwise — never fabricated, never guessed).
- `platformUrl` is the canonical Spotlight URL shape built from that real id
  via the pinned constant `SNAP_SPOTLIGHT_URL_BASE =
  https://www.snapchat.com/spotlight/`. Snap's post response returns no
  permalink field; building the canonical URL from the real platform-issued
  id follows the same precedent as the YouTube adapter's
  `https://www.youtube.com/watch?v=` construction.
- `rawResponse` is the platform's verbatim response body;
  `PublishingService.dispatch` hashes it into `providerResponseSha256`.

## Safety contract (identical family contract as YouTube/Meta)

- **Artifact binding**: the file's SHA-256 is streamed from the REAL bytes
  and compared to the approved `artifactSha256` BEFORE any credential
  resolution or network call (`SNAP_MEDIA_HASH_MISMATCH`).
- **Rule 7 defense-in-depth**: an unexpired owner approval bound to the SAME
  artifact hash and destination `snapchat` is re-checked inside the adapter
  (`APPROVAL_EXPIRED`, `APPROVAL_ARTIFACT_MISMATCH`,
  `APPROVAL_DESTINATION_MISMATCH`).
- **Rule 15**: internal agent names from the canonical catalog are rejected
  in public metadata before any network call
  (`AGENT_NAME_LEAKAGE_DENIED`). The official "human readable" media name is
  derived from the artifact hash (`stph-<hash16>`) — never from captions —
  so no internal name can leak through it.
- **Rule 17**: the Bearer access token appears ONLY in Authorization headers;
  the ephemeral media key/iv appear ONLY in the official create-media body.
  Neither is ever logged, stored, or echoed in receipts or errors.
- **SSRF / HTTPS-only (R3)**: every URL is HTTPS on
  `businessapi.snapchat.com`. Platform-provided `add_path`/`finalize_path`
  are validated as bounded relative official paths (no scheme, host,
  traversal, or injection characters) and the full URL is rebuilt on the
  official host only.
- **Retry**: 429/5xx/network failures retry with bounded backoff honoring
  `Retry-After`; 401/403/other 4xx fail closed and are never retried.
- **Official logical errors fail closed**: `MEDIA_EXPIRED`
  (`SNAP_MEDIA_EXPIRED`) and `MEDIA_POSTING_ALREADY_IN_PROGRESS`
  (`SNAP_MEDIA_POSTING_IN_PROGRESS`) are never auto-retried or auto-recreated
  — the official resolution is manual, and an automatic re-create/retry
  could double-publish. The Spotlight post itself is a single attempt.
- **Idempotency**: an identical (owner, director, destination, artifact,
  description, locale) request replays the stored receipt with ZERO network
  calls (`duplicate: true`).
- **Bounded memory**: encryption streams 4 MB plaintext blocks through the
  cipher and uploads ≤32 MB encrypted chunks; the file is never fully loaded
  into memory.
- **Metadata bounds**: Spotlight description ≤ 160 characters
  (`SNAP_DESCRIPTION_TOO_LONG`); locale must match the official shape
  (`SNAP_LOCALE_INVALID`).

## Wiring

The adapter plugs into `src/api/ownerOperationsRouter.js`'s existing
server-side `publishingPublisher` option (the transport is NEVER
client-selectable; a client-supplied publisher is rejected with
`CLIENT_TRANSPORT_FORBIDDEN`). It is destination-strict: only `snapchat` is
accepted. Credentials are resolved per (owner, agent, destination) through
the injected resolver — production resolves opaque `vault://`/`opaque://`
locators (`accessToken`, `profileId` UUID) via the existing secret-manager
boundary; an unconfigured custody fails closed with a stable code — never a
fake receipt.

## Verification (offline, no network)

`tests/snapchatPublisher.test.js` scripts the injected transport (21 tests):
official request shapes, multipart ADD/FINALIZE structure, encryption
protocol fields, ≤32 MB chunking of a 33 MB media into parts 1..2, approval
binding, Rule 15 leakage denial, artifact-hash substitution, credential
scoping, retry matrix (429 `Retry-After`, 5xx, network), official logical
error codes, receipt validation, idempotent replay, media-source guards
including a sparse >1 GB file, and token containment.

## What is NOT claimed

- No live Snapchat upload has ever been performed by this repository; offline
  tests script the transport only.
- Live Snapchat publishing requires the owner to connect real accounts,
  provision credentials, and obtain Snap's allowlist approval for the OAuth
  client (owner-gated, Issue #118).
- Story and Saved Story posting are not wired (see "Why Spotlight and not
  Story"). Bilibili remains `CAPABILITY_UNAVAILABLE`
  (`docs/publishing/META_PUBLISHING_ADAPTER.md`).
