# Media Artifact Descriptor & Verification Contract (S-M30-01, issue #135)

The offline foundation of ST's real media layer: a pure, deterministic,
fail-closed contract for describing produced artifacts and their truthful
verification state. `src/media/artifactDescriptor.js` performs **no media
generation, no provider calls, no filesystem access, and no clock reads**.

## Why this exists

The blueprint's QC gate requires that the 30–50 minute runtime is measured on
the **final media file** — never script length, planned duration, or
estimates. Before any worker claims success, the artifact it produced must be
described by a descriptor whose identity is the SHA-256 of the actual content
bytes, and whose verification state can only become `VERIFIED` through a real
inspection result. A worker "success" without a passing inspection is
representable — as `UNVERIFIED` — never as valid (AGENTS.md Rules 1–3).

## Contract

### Identity
- `contentSha256` — the SHA-256 of the artifact's content bytes. Hex case is
  normalized to lowercase. This is the identity anchor; two descriptors with
  different hashes are different artifacts.

### Creation (`createArtifactDescriptor`)
Validated fields (fail-closed, stable error codes):

| Field | Rule | Error |
|---|---|---|
| `contentSha256` | 64-char hex (case-normalized) | `ARTIFACT_HASH_INVALID` |
| `artifactType` | one of `audio, image, video, subtitle, thumbnail, metadata` | `ARTIFACT_TYPE_INVALID` |
| `mimeType` | bounded, regex-checked, allowlisted | `ARTIFACT_MIME_INVALID` |
| `producer.{agentId,runId,stageId,providerId}` | required, bounded strings | `ARTIFACT_PRODUCER_INVALID` |
| `producer.note` | optional; secrets/internal names rejected | `ARTIFACT_SECRET_REJECTED` / `ARTIFACT_INTERNAL_NAME_REJECTED` |
| `durationSeconds` | optional; finite, >= 0 | `ARTIFACT_DURATION_INVALID` |
| `dimensions` | optional; positive integer width/height | `ARTIFACT_DIMENSIONS_INVALID` |

The created descriptor is frozen and starts `verification.state =
"UNVERIFIED"` with `reasonCode: "NO_INSPECTION_RESULT"`. There is **no**
construction path that yields `VERIFIED`.

### Verification state machine (`verifyArtifactDescriptor`)
Exactly one promotion path `UNVERIFIED → VERIFIED`, requiring **all** of:

1. inspection `tool` is `ffprobe` (or explicitly `equivalent`);
2. inspection `success === true`;
3. inspection `contentSha256` **matches** the descriptor's identity anchor;
4. the inspection actually inspected content (non-empty `format` object or
   `streams` array — an empty payload is "missing inspection").

Every failure returns a **new frozen UNVERIFIED descriptor** with a stable
`reasonCode` (`INSPECTION_HASH_MISMATCH`, `INSPECTION_NOT_SUCCESSFUL`,
`INSPECTION_HASH_MISSING`, `INSPECTION_TOOL_UNKNOWN`,
`INSPECTION_PAYLOAD_MISSING`, `NO_INSPECTION_RESULT`) — it never throws away
the artifact and never fabricates success. The input descriptor is never
mutated. `null`/`undefined` inspection results return the descriptor
unchanged (truthful "worker reported success, nothing was inspected"
representation). A malformed inspection input (`42`, arrays, strings) throws
`ARTIFACT_INSPECTION_INVALID` — that is a programming error, not an
inspection outcome.

`revokeVerification(descriptor, reasonCode)` demotes a verified descriptor
back to `UNVERIFIED` — verification is never sticky against contradicting
evidence (tamper scans, failed re-inspection).

### Tamper detection
`descriptorFingerprint(descriptor)` — SHA-256 over the canonical allowlisted
serialization **excluding the verification block**, so verification
transitions never change identity. `detectTampering(original, candidate)`
reports `tampered: true` when any identity/provenance field (content hash,
type, MIME, duration, dimensions, producer fields) differs. Verified via 25
tests including six distinct tamper mutations.

### Serialization (Rules 15/17)
`serializeArtifactDescriptor` / `canonicalSerialize` emit a strict field
allowlist in fixed key order:

- Unknown fields on the descriptor object are **dropped**, never serialized.
- Every serialized string is re-scanned: secret-like content (`vault://`,
  `opaque://`, `api_key`, `bearer`, tokens, passwords, `authorization`) is
  rejected (`ARTIFACT_SECRET_REJECTED_AT_*`).
- Internal agent names (all 21 registered agents, including NEWTON) are
  rejected outside the `producer.agentId` field
  (`ARTIFACT_INTERNAL_NAME_REJECTED_AT_*`).
- Output and all nested objects are frozen. Identical inputs produce
  byte-identical output — no timestamps in the identity, no nondeterministic
  key order.

## Truthfulness boundaries

This module does **not**:
- generate, read, hash, or transport media content (the caller supplies the
  content hash and inspection results from the real inspection tooling);
- call FFprobe (an execution slice will spawn it per CONVENTIONS rule 2 —
  array-arg spawn only — and feed the result here);
- issue receipts, URLs, or publication state.

The first real end-to-end exercise of this contract (hash computed from an
actual rendered file, actual FFprobe JSON supplied) will be recorded in the
evidence ledger by the execution slice that performs it. Until then no
verification claim is made.
