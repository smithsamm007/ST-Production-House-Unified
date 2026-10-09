# Bilibili Publishing Adapter — Research and Feasibility Contract

> Status: **RESEARCH COMPLETE / ADAPTER NOT IMPLEMENTED / PUBLISH BLOCKED (owner-gated).**
> This document records the official Bilibili (哔哩哔哩开放平台) API boundary
> discovered from official documentation, and the honest feasibility analysis
> for an ST publisher adapter. It is the §-order follow-up to the Meta adapter
> (Issue #219) and the Snapchat adapter (Issue #221). No adapter code, no
> account, no app registration, and no platform call exists today.

Research date: 2026-10. Sources are the official open-platform documentation,
fetched live during this research (not invented):

- Portal: `https://open.bilibili.com/` / `https://openhome.bilibili.com/doc`
  (Official open-platform portals; the doc site exposes the "视频稿件管理 /
  服务端视频稿件投递" section)
- Official OpenAPI mirror: `https://bilibili.apifox.cn/` — including the
  machine-readable spec for `POST /video/v2/part/upload`
  (`https://bilibili.apifox.cn/api-23701336.md`) and the OAuth walkthrough
  (`https://bilibili.apifox.cn/doc-7492454.md`).
- Signed-request/error-code reference:
  `https://open.bilibili.com/doc/4/8673959e-f7bb-56e6-6e68-d225f971b81b`.

> Note: the official doc pages are client-rendered SPA screenshots behind
> JS (`window._BiliGreyResult` shell), so the readable content was extracted
> from the official OpenAPI mirror pages above, which render server-side.

## 1. What the officially documented integration actually is

The official surface for server-side video submission ("服务端视频稿件投递")
is a four-stage flow on the host `member.bilibili.com`, with OAuth on
`api.bilibili.com`:

### 1.1 OAuth 2.0 (official)

- Onboarding prerequisites: open-platform registration → 资质认证
  (qualification certification) → app creation, which yields a `client_id`
  and a `secret`. Per-interface permission must then be applied for and
  granted by Bilibili.
- Token exchange (official):
  `POST https://api.bilibili.com/x/account-oauth2/v1/token`
  (form-encoded; `client_id`, `client_secret`,
  `grant_type=authorization_code`, `code`) — response carries
  `access_token`, `refresh_token`, `expires_in`, `scopes[]`.
- Renewal (official): `POST https://api.bilibili.com/x/account-oauth2/v1/refresh_token`
  — **each `refresh_token` is single-use**; a rotation-aware custody design
  (like the existing YouTube OAuth lifecycle, Issue #206) is required so a
  consumed refresh token cannot be reused.
- Scope model: scopes granted at authorization time are fixed per app's
  approved permission set; new interface permissions require the user to
  re-authorize.

### 1.2 Server-side video submission (official, host `member.bilibili.com`)

Per the officially published interface list
(`https://open.bilibili.com/doc/4/8243399e-50e3-4058-7f01-1ebe4c632cf8`):

1. **File upload preprocessing** (文件上传预处理,
   `https://openhome.bilibili.com/doc/4/0c532c6a-e6fb-0aff-8021-905ae2409095`)
   — initializes the upload; the response supplies the parameters needed by
   the upload and submission stages (`upload_token`). Files ≤100 MB may use
   the single-small-file flow instead of chunking.
2. **Chunked upload** (文件分片上传) — official OpenAPI spec:
   `POST /video/v2/part/upload` on `member.bilibili.com`, query params
   `part_number` (1-based) + `upload_token`; recommended chunk size is a
   fixed 8 MB (last chunk may be smaller). Response is the platform's
   `{code, message}` envelope.
3. **Chunk merge** (文件分片合片,
   `https://open.bilibili.com/doc/4/0828e499-38d8-9e58-2a70-a7eaebf9dd64`)
   — notifies the server that all parts are uploaded; success means the
   physical file is complete, after which submission is allowed.
4. **Cover upload** (封面上传) — separate official interface.
5. **Archive submission** (视频稿件提交,
   `https://open.bilibili.com/doc/4/f7fc57dd-55a1-5cb1-cba4-61fb2994bf0f`)
   — completes the submission. Requires video + cover upload finished first.
   Additional documented facts: submission requires a partition id (`tid`,
   from the official 分区查询 interface); **after submission the archive
   enters a platform review process and is not public during review**.

Query side: single-archive detail / user archive listing interfaces exist
under 视频稿件查询 (`https://openhome.bilibili.com/doc/4/d9554788-dcef-f139-6217-b487d41c3826`).

### 1.3 Access gating is real and documented

The signed-request/error reference documents:

- `127304`: 接口访问受限 — the app has not been granted the interface
  permission (and/or the authorized account status is not normal).
- `127305`: 白名单限制 — **whitelist restriction**. The 投稿 interfaces sit
  behind the 接口权限白名单 (permission whitelist), i.e. Bilibili must
  approve the app for these capabilities after application.

## 2. Honest receipt analysis (what an ST adapter could truthfully claim)

| Event | Officially confirmable? | Honest receipt content |
|---|---|---|
| Chunk upload/merge success | Yes — platform `{code,message}` envelope | attempt evidence only (no public artifact) |
| Archive submission accepted | Yes — real response envelope | submission id / real response payload as evidence; the archive is in review |
| Archive **published** | Only via platform review completion | NOT claimable at submit time — submission ≠ publication |
| Public URL | Only after review completes with a real `bvid`/URL | canonical URL shape may be constructed ONLY from a real platform-issued id (same precedent as the YouTube `watch?v=` construction) |

Therefore an ST adapter's receipt would carry `platformPostId` = the real
platform-issued archive identifier from the submission/query response and
`platformUrl` only when derived from a real id — and this repository would
additionally need a documented truthfulness rule for the review-pending
state (a "submitted, in review" status, never "published"). This mirrors the
Snapchat decision to leave story posting unwired: the honest-receipt boundary
must exist BEFORE adapter code is written.

## 3. Eligibility and owner-action gates (why there is no adapter today)

Implementing the adapter needs, in order:

1. **Owner**: register on the open platform and complete 资质认证
   (qualification certification) — a legal/identity process ST cannot perform.
2. **Owner**: create an app → obtain `client_id`/`secret` (custody: opaque
   `vault://` locators via the existing secret-manager boundary, Rule 17).
3. **Platform**: Bilibili grants the app's interface permission — the video
   投稿 interfaces are whitelist-gated (errors 127304/127305). This is a
   third-party approval that cannot be guaranteed or simulated.
4. **Owner**: connect the Director's Bilibili account via the official
   OAuth 2.0 flow (parallel to the YouTube lifecycle, Issue #206), including
   single-use refresh-token rotation custody.
5. Additional honest-limit factors: non-official-membership accounts are
   documented to have a daily submission quota (documented as 5/day), and
   the archive stays non-public during platform review — both must surface
   as truthful quota/state in any adapter.

## 4. Contract decisions recorded before any future implementation

- Same `publisher.publish()` contract as YouTube/Meta/Snapchat; artifact
  SHA-256 re-verified from real bytes before any credential resolution;
  unexpired Rule-7 approval binding re-checked inside the adapter; Rule-15
  catalog-derived name suppression; Rule-17 token containment.
- Official-host HTTPS allowlist: `api.bilibili.com` (OAuth) +
  `member.bilibili.com` (upload/submission). Any URL supplied by the
  platform (e.g. per-part upload endpoints) must be validated as official
  HTTPS study before use (SSRF defense).
- Single-use `refresh_token` rotation custody (never persist a raw token;
  opaque locators only), reusing the YouTube OAuth lifecycle pattern (#206).
- Receipt honesty per §2: submission evidence + review state; publication
  claims only from real post-review platform responses.
- Error mapping: `127304` → `BILIBILI_PERMISSION_NOT_GRANTED` (fail closed,
  no retry storm), `127305` → `BILIBILI_WHITELIST_RESTRICTED` (fail closed),
  documented daily-quota states surfaced truthfully as wait/recover states.

## 5. What is NOT claimed

No Bilibili account, app registration, qualification certification, whitelist
grant, token, upload, submission, or receipt exists. No request was ever sent
to any Bilibili endpoint. `bilibili` remains **excluded** from
`destinationPublisherRouter`'s supported destination set (`youtube`,
`instagram`, `facebook`, `snapchat`) until an adapter is actually implemented
and owner-gated live access exists (Issue #118 / S-M24-LIVE). This document
changes documentation only — no behavior, no dependencies, no network.
