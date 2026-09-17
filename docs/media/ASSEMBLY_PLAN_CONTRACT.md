# FFmpeg assembly-plan contract and main-video runtime QC gate (S-M33-01)

> Status: implemented (deterministic, offline, purely additive). This module
> produces ASSEMBLY PLANS AND QC VERDICTS ONLY. No FFmpeg/FFprobe execution,
> no binaries, no media generation, upload, or publishing is performed or
> claimed.

## Purpose

`src/media/assemblyPlan.js` is the deterministic contract between planning and
the future real assembly workers. It defines:

- **Ordered segments** — each segment references an artifact by descriptor
  identity (`sha256:<64-hex>`), with a bounded `kind`
  (`video_clip | still_image | title_card | voice | bgm | sfx`), optional
  bounded duration (0.1–7200 s), and a `transitionIn` from
  `cut | fade | dissolve | wipe`.
- **Audio mix plan** — bounded tracks (≤ 40) with `role`
  (`voice | bgm | sfx`), gain in [−60, +6] dB, and ducking flag.
- **Subtitle track** — optional; `srt` or `vtt`, artifact reference only.
- **Output target + aspect ratio** — `main_longform | content_reel_1 |
  content_reel_2 | brand_reel` and `16:9 | 9:16 | 1:1 | 4:5`.

## Sandbox safety by construction

Inputs are **artifact references only** — the single accepted shape is
`sha256:<64 hex>`. Raw paths cannot be expressed, so path traversal,
absolute paths, `file://` URLs, and shell metacharacters are structurally
impossible (regex fail-closed, `ASSEMBLY_ARTIFACT_REF_INVALID`). All other
values are allowlisted enums or bounded numbers. Unknown top-level fields
throw `ASSEMBLY_FIELD_UNKNOWN`; unknown segment/audio/subtitle fields throw
`ASSEMBLY_*_FIELD_UNKNOWN`. There is no argument-string builder in this
module and no execution path — the future worker maps allowlisted values to
spawn-array arguments only (CONVENTIONS rule 2).

## Main-video runtime QC gate (fail-closed)

`evaluateMainVideoRuntimeGate(descriptor, inspection)` decides whether a
main video may be represented as COMPLETE. It never trusts a caller claim:

1. The artifact descriptor must be `VERIFIED` via the S-M30-01 state machine
   (real matching inspection by `ffprobe`/equivalent). Otherwise
   `QC_DESCRIPTOR_NOT_VERIFIED` with the upstream `reasonCode` surfaced.
2. The **measured** duration must come from the inspection payload
   (`format.duration`, number or numeric string). Missing ⇒
   `QC_INSPECTION_DURATION_MISSING`.
3. A claimed `durationSeconds` on the descriptor contradicting the measured
   duration by > 1 s fails closed with `QC_DURATION_CONFLICT`.
4. The measured duration must lie inside **[1800, 3000] seconds** (30–50
   minutes of ACTUAL media time) ⇒ else `QC_DURATION_OUT_OF_RANGE`.

Boundary values pass; everything outside fails. The gate never mutates
inputs and never fabricates a pass.

## Determinism and integrity

Plans are frozen, byte-identical for identical inputs, with recomputed
SHA-256 ids (`computeAssemblyPlanId`), an integrity gate
(`verifyAssemblyPlanIntegrity` — stable `ASSEMBLY_ID_MISMATCH` /
`ASSEMBLY_PLAN_TYPE_MISMATCH` codes), fingerprints, and tamper detection
(`detectAssemblyPlanTampering`). Serialization is a strict allowlist in
fixed order: unknown keys are dropped (and can never leak), while mutation
or deletion of allowlisted fields fails the recomputed-id check. Secrets and
internal agent names are rejected in every string (Rules 15/17).

## Error codes

`ASSEMBLY_PLAN_INVALID`, `ASSEMBLY_FIELD_UNKNOWN`,
`ASSEMBLY_AGENT_INVALID`, `ASSEMBLY_RUN_INVALID`, `ASSEMBLY_NOTE_INVALID`,
`ASSEMBLY_OUTPUT_TARGET_INVALID`, `ASSEMBLY_ASPECT_INVALID`,
`ASSEMBLY_SEGMENT_LIMIT` / `_INVALID` / `_FIELD_UNKNOWN`,
`ASSEMBLY_ARTIFACT_REF_INVALID`, `ASSEMBLY_SEGMENT_KIND_INVALID`,
`ASSEMBLY_SEGMENT_DURATION_INVALID`, `ASSEMBLY_TRANSITION_INVALID`,
`ASSEMBLY_AUDIO_LIMIT` / `_INVALID` / `_FIELD_UNKNOWN`,
`ASSEMBLY_AUDIO_ROLE_INVALID`, `ASSEMBLY_AUDIO_GAIN_INVALID`,
`ASSEMBLY_SUBTITLE_INVALID` / `_FIELD_UNKNOWN` / `_FORMAT_INVALID`,
`ASSEMBLY_ID_MISMATCH`, `ASSEMBLY_PLAN_TYPE_MISMATCH`,
`ASSEMBLY_SECRET_REJECTED`, `ASSEMBLY_INTERNAL_NAME_REJECTED`,
`QC_DESCRIPTOR_NOT_VERIFIED`, `QC_INSPECTION_DURATION_MISSING`,
`QC_DURATION_CONFLICT`, `QC_DURATION_OUT_OF_RANGE`.

## Non-goals

No FFmpeg execution, no filesystem access, no storage layout, no platform
upload. The Reel/brand package layer (S-M34-01) composes multiple plans; the
execution adapter (future slice) consumes verified plans and real inspected
artifacts only.
