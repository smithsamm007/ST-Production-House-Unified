# Meta (Instagram/Facebook) Publishing Adapter — Issue #219

## Purpose

`src/publishing/metaPublisher.js` is the OFFICIAL Meta Graph API boundary behind
the existing publisher contract `PublishingService.dispatch` already consumes:

```
publisher.publish(request) → { platformPostId, platformUrl, rawResponse }
```

It serves the two Meta destinations the publishing test allowlist already
carries (`instagram`, `facebook`) — mirroring the proven YouTube publisher
(`src/publishing/youtubePublisher.js`, Issue #215) without duplicating it.

## Official API flows (no invented endpoints)

The Graph API version is pinned in ONE exported constant, `META_GRAPH_VERSION`
(currently `25.0`). All flows were taken from official Meta documentation
(developers.facebook.com) at implementation time (2026-10).

### Instagram Reels (Instagram API with Facebook Login)

1. `POST https://graph.facebook.com/v25.0/{ig_user_id}/media`
   body: `{ media_type: "REELS", upload_type: "resumable", caption }` → `{ id }`
2. `POST https://rupload.facebook.com/ig-api-upload/v25.0/{container_id}`
   headers: `Authorization: OAuth <token>`, `offset: 0`, `file_size`
   binary body = the artifact bytes → `{ success: true }`
3. `GET https://graph.facebook.com/v25.0/{container_id}?fields=status_code`
   polled a bounded number of times: `FINISHED` proceeds; `EXPIRED`/`ERROR`
   and unknown codes fail closed; timeout is a stable failure, never success.
4. `POST …/{ig_user_id}/media_publish` body `{ creation_id }` → `{ id }`
5. `GET …/{media_id}?fields=permalink` → the REAL permalink (never derived).

### Facebook Page video (Resumable Upload API)

1. `POST https://graph.facebook.com/v25.0/{app_id}/uploads`
   body `{ file_name, file_length, file_type: "video/mp4" }` → `{ id: "upload:<session>" }`
2. `POST https://graph.facebook.com/v25.0/upload:<session>`
   headers: `Authorization: OAuth <token>`, `file_offset: 0`
   binary body = the artifact bytes → `{ h: "2:<token>" }` (official handle)
3. `POST https://graph-video.facebook.com/v25.0/{page_id}/videos`
   form fields `title`, `description`, `fbuploader_video_file_chunk` → `{ id }`
4. `GET …/{video_id}?fields=permalink` → the REAL permalink.

## Honesty + safety contract (AGENTS.md)

- **No invented APIs / R3 SSRF**: official endpoints only; every URL must be
  HTTPS on one of `graph.facebook.com`, `graph-video.facebook.com`,
  `rupload.facebook.com`; provider-supplied ids (container, session, handle)
  are strictly pattern-validated before any URL is built from them.
- **Receipt honesty (Rules 1/2)**: `platformPostId`/`platformUrl` come only
  from real response bodies (`id`, `permalink`). Missing/unparseable →
  `META_RECEIPT_INVALID` / `META_PERMALINK_UNAVAILABLE`. Nothing is derived
  locally or fabricated.
- **Rule 7 defense-in-depth**: an unexpired owner approval bound to the SAME
  artifact hash and destination is re-validated inside the adapter even though
  `PublishingService` checks it first.
- **Artifact binding**: the file's SHA-256 is streamed and compared with the
  approved hash BEFORE any credential resolution or network call; a tampered
  on-disk artifact fails `META_MEDIA_HASH_MISMATCH` with zero network traffic.
- **Director isolation / Rule 17**: credentials resolve per
  (ownerId, agentId, destination) via the injected `resolveCredentials`;
  production wires this through the existing secret-manager locator path.
  Tokens appear only in Authorization headers and never in receipts, errors,
  or serialized output.
- **Rule 15**: internal agent names, derived from the canonical agent catalog,
  are denied in metadata before any network call (case-insensitive).
- **Retry**: 429 honors `Retry-After`; 429/5xx/transport failures retry with
  bounded backoff; 401/403 and other 4xx fail closed, never retried.
- **Idempotency**: an identical (owner, director, destination, artifact,
  caption) request replays the stored receipt with ZERO network calls, so a
  retry can never double-publish.
- **Private-first boundary**: the adapter offers no public-visibility switch;
  visibility is governed by the connected professional account/Page settings,
  and live connection custody remains owner-gated.

## Wiring

The adapter plugs into `src/api/ownerOperationsRouter.js`'s existing
server-side `publishingPublisher` option (the transport is NEVER
client-selectable; a client-supplied publisher is rejected with
`CLIENT_TRANSPORT_FORBIDDEN`). A publishing test to `instagram`/`facebook`
with a real connected account uses real credentials through the secret
manager; without one it fails closed with a stable code — never a fake
receipt.

## What is NOT claimed

- No live Meta upload has ever been performed by this repository; offline
  tests script the transport (`tests/metaPublisher.test.js`, 20 tests).
- Live Instagram/Facebook publishing requires the owner to connect real
  accounts and provision credentials (owner-gated, Issue #118).
- Snapchat is now covered by its own official-API adapter
  (`src/publishing/snapchatPublisher.js`, Issue #221 — Spotlight via the
  Public Profile API; see `SNAPCHAT_PUBLISHING_ADAPTER.md`).
- Bilibili remains `CAPABILITY_UNAVAILABLE` here; it needs its own
  official-API research slice (§24 of the master completion prompt).
