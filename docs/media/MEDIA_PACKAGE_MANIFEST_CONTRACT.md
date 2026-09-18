# Complete media-package manifest (S-M37-01, Issue #152)

> Status: implemented (deterministic, offline, purely additive). This module
> produces a MANIFEST ONLY — a truthful index of one run's package. It performs
> no media generation, inspection, provider call, render, upload, or publishing,
> and never claims any of them. Publication is always `not_requested`.
> `planned != generated`, `generated != verified`, `verified != published`.

## Purpose

`src/production/mediaPackageManifest.js` binds **one production run's complete
output set** into a single verifiable manifest:

- exactly **1 main long-form video** + the **2 independent content Reels** +
  the **1 standalone brand Reel** from the run's S-M34-01 reel package;
- the optional **run-authorized main-video integration**;
- optional **subtitles / thumbnail plans / metadata entries**.

Every bound entry is anchored to a REAL S-M30-01 artifact descriptor identity
(`sha256:<64-hex>` content hash) and a **derived** verification state — the
verification state is never accepted from the caller. The manifest is the layer
that can truthfully answer "is this run's package complete, and has every bound
artifact actually passed inspection?" It is the trustworthy package boundary
that future real workers populate; it is not itself a worker.

## Canonical package structure

Exactly (structural, not merely integrity-gated):

| Slot | Cardinality | Descriptor type |
|---|---|---|
| `mainVideo` | 1 | `video` |
| `contentReelArtifacts` | 2, distinct | `video` |
| `brandReelArtifact` | 1, distinct from both Reels | `video` |
| `mainVideoIntegration` | 0 or 1 (authority-gated) | `video` |
| `subtitles` | ≤ 12, labeled | `subtitle` |
| `thumbnailPlans` | ≤ 12, labeled | `thumbnail` |
| `metadataEntries` | ≤ 12, labeled | `metadata` |

No additional package types exist. Optional lists are type-bound: a video can
never masquerade as a subtitle/thumbnail/metadata entry, and a second main
video cannot be smuggled in through any other field (top-level fields are
allowlisted).

## Artifact binding and verification

- The bound `descriptor` must be a real `st_media_artifact_descriptor`; its
  `contentSha256` must form a valid `sha256:<64-hex>` reference. Hand-forged
  refs, hand-forged verification states (anything other than
  `UNVERIFIED`/`VERIFIED`), and `VERIFIED` records that still carry a
  `reasonCode` fail closed (`MANIFEST_*_BINDING_INVALID`).
- Each entry's `verificationState` is derived only from the descriptor's real
  verification state. A worker "success" without a real inspection result
  stays `UNVERIFIED` and the manifest truthfully reports
  `partial_unverified` — it can never read as verified (Rule 1).
- Every binding carries the descriptor's own fingerprint
  (`descriptorFingerprint`), so a mutated descriptor is visible even when its
  content hash is unchanged.

## Director isolation and foreign-run protection (fail closed)

Every bound descriptor's producer must be the manifest's own Director and the
manifest's own production run:

- known other-Director producer → `MANIFEST_ARTIFACT_CROSS_DIRECTOR`
- foreign-run producer → `MANIFEST_ARTIFACT_RUN_MISMATCH`

Isolation checks take precedence over shape checks: a foreign-run or
cross-Director binding always fails with its isolation code, whatever its
artifact type. Nothing is silently substituted, normalized, or repaired.
Foreign artifacts are never adopted (`run-A manifest + run-B artifact = REJECT`).

## Truthful media status

`mediaStatus` derives ONLY from the bound verification states:

| Status | Meaning |
|---|---|
| `no_media` | zero bound artifacts verified (fully planned package) |
| `partial_unverified` | some but not all bound artifacts verified |
| `verified` | every bound artifact verified |

The serialized form of a partially verified package never contains
`"verified"`. No `generated` / `published` / `uploaded` claims exist anywhere
in the contract.

### Production-ready gate

`isMediaPackageProductionReady(manifest)` returns a truthful verdict:

- recomputed identity intact (`MANIFEST_ID_MISMATCH` / `MANIFEST_TYPE_MISMATCH`);
- brand mode is one of `STANDALONE_ONLY` / `INTEGRATED` /
  `OWNER_DECISION_REQUIRED` (`BRAND_MODE_INVALID`);
- publication is still `not_requested` (`PUBLICATION_STATE_INVALID`);
- every bound artifact `VERIFIED` and `mediaStatus === "verified"`
  (`MEDIA_STATUS_NOT_VERIFIED`).

A planned or partially verified package is never production-ready.

## Brand integration (S-M34-01 authority)

The manifest requires the run's intact S-M34-01 reel package (recomputed
integrity gate) and mirrors its `brandIntegrationMode` truthfully:

- tampered package → `MANIFEST_REEL_PACKAGE_TAMPERED`
- coherent package from another Director/run → `MANIFEST_REEL_PACKAGE_SCOPE_MISMATCH`
- `STANDALONE_ONLY`: no integration entry may exist; supplied integration
  material fails (`MANIFEST_INTEGRATION_CONFLICT`)
- `INTEGRATED`: the integration must be bound to the package's authorized
  artifact reference exactly (`MANIFEST_INTEGRATION_BINDING_REQUIRED` /
  `MANIFEST_INTEGRATION_ARTIFACT_MISMATCH`) and must be a distinct artifact
  (`MANIFEST_INTEGRATION_ARTIFACT_DUPLICATE`)
- `OWNER_DECISION_REQUIRED`: recorded truthfully; no decision is invented

Authorization material never appears on the manifest (it stays on the S-M34-01
package control plane) and is never serialized.

## Identity, tamper detection, serialization

- Manifest identity is a **recomputed SHA-256** over a canonical serialization
  with **sorted object keys** (`canonicalJson`): a record rebuilt with its
  keys in a different insertion order has the SAME identity, while array
  order (e.g. Reel #1 vs Reel #2) stays significant. A caller-supplied `id`
  must match the recomputation exactly (`MANIFEST_ID_MISMATCH`) — it is never
  trusted or silently adopted.
- `verifyMediaPackageManifest` returns a truthful verdict and never repairs;
  `detectMediaPackageManifestTampering` flags any addition, removal, or
  substitution of bound artifacts and any field mutation (artifact refs,
  fingerprints, verification states, notes, run/agent scope, mediaStatus,
  publication).
- `serializeMediaPackageManifest` is a strict Rule-17 allowlist in fixed
  order. Each bound entry is re-projected through its own explicit allowlist
  (`artifactRef`, `descriptorFingerprint`, `verificationState`, `entryNote`,
  optional `label`), so polluted inner fields can never leak. Extra top-level
  keys are dropped; deletion/mutation of an allowlisted field fails the
  recomputed-id gate; secrets, raw filesystem paths, shell metacharacters, and
  internal agent names are re-scanned and rejected (Rules 15/17).
- Free text anywhere (run ids, notes, labels) rejects secret-like content,
  raw paths (`/etc/...`, `../`), and shell metacharacters (`;`, backticks,
  `$(...)`, `&&`) with `MANIFEST_SECRET_REJECTED` /
  `MANIFEST_UNSAFE_TEXT_REJECTED`.

## Error codes

`MANIFEST_INPUT_INVALID`, `MANIFEST_FIELD_UNKNOWN`, `MANIFEST_TYPE_MISMATCH`,
`MANIFEST_ID_MISMATCH`, `MANIFEST_AGENT_INVALID`, `MANIFEST_RUN_INVALID`,
`MANIFEST_SECRET_REJECTED`, `MANIFEST_UNSAFE_TEXT_REJECTED`,
`MANIFEST_INTERNAL_NAME_REJECTED`, `MANIFEST_BINDING_MALFORMED`,
`MANIFEST_REEL_PACKAGE_INVALID` / `_TAMPERED` / `_SCOPE_MISMATCH`,
`MANIFEST_MAIN_VIDEO_BINDING_INVALID`, `MANIFEST_CONTENT_REEL_COUNT`,
`MANIFEST_CONTENT_REEL_BINDING_INVALID`, `MANIFEST_CONTENT_REEL_DUPLICATE`,
`MANIFEST_BRAND_REEL_BINDING_INVALID`, `MANIFEST_BRAND_REEL_DUPLICATE`,
`MANIFEST_MAIN_VIDEO_FIELD_UNKNOWN` / `MANIFEST_SUBTITLE_FIELD_UNKNOWN` /
`MANIFEST_THUMBNAIL_FIELD_UNKNOWN` / `MANIFEST_METADATA_FIELD_UNKNOWN`,
`MANIFEST_ARTIFACT_CROSS_DIRECTOR`, `MANIFEST_ARTIFACT_RUN_MISMATCH`,
`MANIFEST_ARTIFACT_TYPE_MISMATCH`, `MANIFEST_INTEGRATION_BINDING_REQUIRED`,
`MANIFEST_INTEGRATION_BINDING_INVALID`,
`MANIFEST_INTEGRATION_ARTIFACT_MISMATCH`,
`MANIFEST_INTEGRATION_ARTIFACT_DUPLICATE`, `MANIFEST_INTEGRATION_CONFLICT`,
`MANIFEST_SUBTITLE_BINDING_INVALID`, `MANIFEST_THUMBNAIL_BINDING_INVALID`,
`MANIFEST_METADATA_BINDING_INVALID`, `MANIFEST_NOTE_INVALID`,
`BRAND_MODE_INVALID`, `PUBLICATION_STATE_INVALID`, `MEDIA_STATUS_NOT_VERIFIED`.

## Example (deterministic, offline)

```js
import { createMediaPackageManifest, serializeMediaPackageManifest,
         isMediaPackageProductionReady } from "../src/production/mediaPackageManifest.js";

const manifest = createMediaPackageManifest({
  agentId: "agent-01",
  productionRunId: "run-2026-001-x",
  reelPackage, // intact S-M34-01 package for the same agent + run
  mainVideo: { descriptor: verifiedVideoDescriptor },
  contentReelArtifacts: [{ descriptor: reel1Descriptor }, { descriptor: reel2Descriptor }],
  brandReelArtifact: { descriptor: brandDescriptor },
  // optional: subtitles / thumbnailPlans / metadataEntries / mainVideoIntegrationArtifact
});

manifest.mediaStatus;          // "verified" only if every bound inspection passed
isMediaPackageProductionReady(manifest); // { ready: true, reason: null } or a truthful reason
serializeMediaPackageManifest(manifest); // strict allowlist DTO, frozen
```

## Verification

```bash
node --test tests/mediaPackageManifest.test.js   # 28 tests pass
```

Coverage: canonical package construction, derived media status (including the
"worker success without inspection stays UNVERIFIED" rule), cardinality and
descriptor fail-closed gates (including second-main and optional-entry type
binding), cross-Director/foreign-run/type gates, reel package integrity +
scope, integration authority matrix, optional-entry limits/scoping,
determinism (including key-order invariance and array-order sensitivity), the
tamper matrix (main/Reel/brand/thumbnail/integration substitutions, state
mutations, note mutations, run/agent mutation), unsafe-text rejection, the
production-ready gate, and allowlist serialization (including polluted inner
fields).

## Limitations and non-goals

- No DB persistence (a later slice mirrors these invariants as constraints).
- No FFprobe execution: inspection results arrive through the descriptor's own
  verification state (S-M30-01). This slice performs no real provider calls,
  no TTS/visual/audio generation, no OAuth, no publishing, no analytics.
- The manifest is an index of real, independently verified artifacts — never a
  substitute for them, and never evidence that media was generated.
