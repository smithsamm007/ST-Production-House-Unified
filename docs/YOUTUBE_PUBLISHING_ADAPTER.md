# YouTube Upload Publisher Adapter (Issue #215)

Status: **delivered offline / code-side** — contract-tested with a scripted
transport. **No live upload has ever been performed**; live operation is
owner-gated (Issue #118: real Google OAuth connection + real approved
artifact + real transport).

## What this is

`src/publishing/youtubePublisher.js` implements the publisher contract that
`src/publishing/publishingService.js` already consumes:

```js
const publisher = createYouTubePublisher({
  resolveAccessToken: async ({ ownerId, agentId }) => "...", // injected
  transport: async (call) => ({ status, headers, body }),    // injected (mock in tests)
  mediaResolver: async (scope) => ({ filePath }),            // optional
});

const receipt = await publisher.publish(request);
// → { platform, platformPostId, platformUrl, rawResponse, visibility, duplicate }
```

`PublishingService.dispatch(requestId, publisher, { dryRun: false })` consumes
that receipt and stores `providerResponseSha256 = sha256(rawResponse)`.

## Official flow (YouTube Data API v3, resumable)

1. `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
   with the metadata JSON (`snippet.title/description/tags/categoryId`,
   `status.privacyStatus`) and `X-Upload-Content-Type` /
   `X-Upload-Content-Length` headers → `2xx` + `Location` upload session.
2. `PUT` the media bytes to that `Location` → `2xx` + resource JSON.

The default `fetch` transport is only used when no transport is injected;
tests inject a scripted transport and never touch the network.

## Guardrails (stable error codes)

| Code | Meaning | Retried? |
|---|---|---|
| `OWNER_APPROVAL_REQUIRED` / `APPROVAL_EXPIRED` | Missing/unexpired owner approval (Rule 7, defense-in-depth) | no |
| `APPROVAL_ARTIFACT_MISMATCH` / `APPROVAL_DESTINATION_MISMATCH` | Approval bound to a different artifact/destination — a changed artifact can never reuse an approval | no |
| `YOUTUBE_MEDIA_SOURCE_INVALID` / `YOUTUBE_MEDIA_SOURCE_UNREADABLE` | Missing, unsafe (`..`, NUL, > 4096 chars), or unreadable media file | no |
| `YOUTUBE_MEDIA_HASH_MISMATCH` | File bytes do not hash to the approved `artifactSha256` — checked **before** token resolution | no |
| `AGENT_NAME_LEAKAGE_DENIED` | Internal agent name in title/description/tags (Rule 15; catalog-derived, case-insensitive, fails closed) | no |
| `YOUTUBE_PUBLIC_UPLOAD_FORBIDDEN` | `visibility` other than `private` (default) / `unlisted` | no |
| `YOUTUBE_AUTH_TOKEN_UNAVAILABLE` | Token resolver returned no token | no |
| `YOUTUBE_AUTH_FAILED` (401) | Provider rejected the token | no |
| `YOUTUBE_UPLOAD_FORBIDDEN` (403) | Provider refused (permission/quota) | no |
| `YOUTUBE_UPLOAD_REJECTED` (other 4xx) | Provider rejected the request | no |
| `YOUTUBE_UPLOAD_SESSION_REJECTED` | No `Location`, or the session URL is not HTTPS on a `*.googleapis.com` host (SSRF/R3) | no |
| `YOUTUBE_UPLOAD_RECEIPT_INVALID` | Response body has no usable `id` — **never** fabricated (Rule 2) | no |
| `YOUTUBE_UPLOAD_RATE_LIMITED` (429) | Rate limited; bounded backoff honoring `Retry-After` (capped 60 s) | yes |
| `YOUTUBE_UPLOAD_UNAVAILABLE` (5xx / network) | Provider/transport failure; bounded exponential backoff | yes |
| `YOUTUBE_TRANSPORT_RESPONSE_INVALID` | Transport returned a malformed response | no |

Retries are bounded (`maxAttempts`, default 3, hard cap 5). Exhausting the
budget throws the last retryable error — an error is never converted into a
success.

## Director isolation and idempotency

- The access token is resolved per `(ownerId, agentId)` and only ever appears
  in the `Authorization` header. Receipts, errors, and serialized output never
  contain it (Rule 17; asserted by tests).
- Idempotency key = `sha256(ownerId, agentId, artifactSha256, visibility,
  title)`. An identical repeat **replays the stored receipt with zero network
  calls** (`duplicate: true`), and keys are Director-scoped: another Director
  with the same artifact uploads independently.

## What this does NOT claim

- No live upload, no real Google credentials, no real video ID exists.
- Not wired into the owner routes yet (the server-side `publishingPublisher`
  option stays owner-configured — follow-up slice).
- No `public` visibility, no other platforms (Bilibili/Meta/Snapchat are
  later slices), no caption/thumbnail sub-uploads yet.
- Live enablement requires Issue #118 owner action: Google OAuth client,
  connected YouTube channel, and Vault-held token custody.

## Tests

`tests/youtubePublisher.test.js` — 22 deterministic tests covering the happy
path request shapes, approval/artifact binding, media hashing, Rule 15,
private-first enforcement, retry policy (429 `Retry-After`, 5xx budget,
network errors), session-Location hardening, receipt honesty, idempotent
replay, Director isolation, and an end-to-end `PublishingService.dispatch`
run — all against a scripted transport, with no network access.
