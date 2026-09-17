# Independent content-Reel planning and brand-integration modes (S-M34-01)

> Status: implemented (deterministic, offline, purely additive). This module
> produces PLANS ONLY. No media generation, provider call, render, upload, or
> publishing is performed or claimed. Publication is never requested here.

## Purpose

`src/production/reelPlan.js` composes the canonical short-form package for one
production run — exactly **2 genuinely independent content Reels + 1
standalone brand-promotion Reel** — with an explicit, fail-closed
`brandIntegrationMode`. It uses the S-M23-01 package-destination allowlist as
the single canonical destination source.

## Independence enforcement (anti-duplication)

Two content Reels must differ in **hook**, **objective**, AND **segment plan**
(`assertReelIndependence`). Comparison is punctuation/whitespace/case-
insensitive, so "the same hook with different subtitles" cannot pass. Stable
codes: `REEL_HOOK_NOT_INDEPENDENT`, `REEL_OBJECTIVE_NOT_INDEPENDENT`,
`REEL_SEGMENT_PLAN_NOT_INDEPENDENT`. Each Reel carries an independent
recomputed SHA-256 identity — duplicate exports cannot share identity.

## Reel plan fields

- `role`: `content_reel | brand_reel`
- `hook` ≤ 200, `objective` ≤ 300, `captionConcept` ≤ 300 (Rules 15/17 scanned)
- `aspectRatio`: `9:16 | 1:1 | 4:5` (long-form 16:9 is not a Reel)
- `durationSeconds`: [5, 180] planning bound (QC still measures real files)
- `segments` ≤ 12: artifact references (`sha256:<64-hex>`) + bounded kind/duration
- `destinations`: unique, from `REEL_DESTINATIONS` ⊆ `PACKAGE_DESTINATIONS`
  (`youtube_shorts`, `bilibili` where appropriate, `instagram_reels`,
  `facebook_reels`, `snapchat_spotlight`) — `youtube` (long-form) is invalid
- `productIdentityKey` (brand_reel only): locator-free normalized identity
- `paidCampaign` (brand_reel only): boolean

## brandIntegrationMode

| Mode | Behavior |
|---|---|
| `STANDALONE_ONLY` | `mainVideoIntegration` is always `null`; supplying integration material fails (`REEL_INTEGRATION_CONFLICT`) |
| `INTEGRATED` | Requires `ownerAuthorization { authorizationRef, boundRunId }` **bound to the exact run** (`REEL_OWNER_AUTHORIZATION_REQUIRED` / `REEL_AUTHORIZATION_RUN_MISMATCH`); the integration artifact must differ from every brand-Reel segment artifact (`REEL_INTEGRATION_ARTIFACT_REUSE`) |
| `OWNER_DECISION_REQUIRED` | Records `ownerDecision { status: "pending", decidedBy: null }` — the decision is never invented; authorization material on a pending package fails (`REEL_MODE_CONFLICT`) |

Paid/sponsored standalone campaigns record
`ownerDecision { status: "owner_action_required" }` truthfully instead of
inventing approval (the live authorization itself is S-M24-LIVE, owner-gated).

The standalone Brand Reel and the integrated main-video segment are always
DIFFERENT artifacts — silent reuse fails closed.

## Identity, tamper detection, serialization

- Recomputed SHA-256 ids for reels and the package (`computeReelPlanId`,
  `computeReelPackagePlanId`); integrity gates return stable
  `REEL_ID_MISMATCH` / `REEL_PACKAGE_ID_MISMATCH` reasons and never repair.
- `detectReelPackagePlanTampering` fingerprints package content (authorization
  reference excluded from identity).
- `serializeReelPackagePlan` is a strict Rule-17 allowlist in fixed order:
  extra keys are dropped (can never leak), allowlisted-field deletion/mutation
  fails the integrity gate, and the owner-authorization reference is **never
  serialized**. Secrets and internal agent names are rejected everywhere
  (Rules 15/17).

## Error codes

`REEL_PLAN_INVALID`, `REEL_FIELD_UNKNOWN`, `REEL_AGENT_INVALID`,
`REEL_RUN_INVALID`, `REEL_ROLE_INVALID`, `REEL_HOOK_INVALID`,
`REEL_OBJECTIVE_INVALID`, `REEL_CAPTION_INVALID`, `REEL_ASPECT_INVALID`,
`REEL_DURATION_INVALID`, `REEL_SEGMENT_LIMIT` / `_INVALID` /
`_FIELD_UNKNOWN` / `_KIND_INVALID` / `_DURATION_INVALID`,
`REEL_ARTIFACT_REF_INVALID`, `REEL_DESTINATION_INVALID` / `_DUPLICATE`,
`REEL_PRODUCT_IDENTITY_INVALID`, `REEL_SECRET_REJECTED`,
`REEL_INTERNAL_NAME_REJECTED`, `REEL_HOOK_NOT_INDEPENDENT`,
`REEL_OBJECTIVE_NOT_INDEPENDENT`, `REEL_SEGMENT_PLAN_NOT_INDEPENDENT`,
`REEL_PACKAGE_INVALID` / `_FIELD_UNKNOWN` / `_CONTENT_COUNT` /
`_SCOPE_MISMATCH` / `_TYPE_MISMATCH` / `_ID_MISMATCH`,
`REEL_BRAND_MODE_INVALID`, `REEL_OWNER_AUTHORIZATION_REQUIRED`,
`REEL_AUTHORIZATION_FIELD_UNKNOWN` / `_RUN_MISMATCH`,
`REEL_INTEGRATION_INVALID` / `_FIELD_UNKNOWN` / `_ARTIFACT_REUSE` /
`_CONFLICT`, `REEL_MODE_CONFLICT`, `REEL_PLAN_TYPE_MISMATCH`.

## Non-goals

No DB persistence (a later slice mirrors these invariants as constraints),
no media execution (S-M33-01 assembly plans consume verified artifacts), no
publishing (owner-gated), no invented products, sponsors, or approvals.
