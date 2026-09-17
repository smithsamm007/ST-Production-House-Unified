# Visual-generation adapter contract (S-M35-01)

> Status: implemented (deterministic, offline, purely additive). This module
> produces CONTRACT RECORDS ONLY. No image/video generation, provider call,
> render, upload, or publishing is performed or claimed.

## Purpose

`src/media/visualAdapter.js` is the truthful contract the future real visual
workers implement against, mirroring the proven TTS contract (S-M32-01) and
integrating with the artifact descriptor (S-M30-01):

- **Capability declarations** (`declareVisualProviderCapabilities`): what an
  adapter CLAIMS it can do — modalities (`image`, `video_clip`, `animation`,
  `still_acquisition`), aspect ratios, max clip seconds, character-continuity
  support. Claims are routing metadata, never evidence of generation.
- **Free-first routing chain** (`VISUAL_PROVIDER_TIERS`): approved free
  primary → secondary → tertiary → local open-source emergency. No paid tier
  exists; paid/unknown provider roles fail closed
  (`VISUAL_PROVIDER_ROLE_INVALID`).
- **Director-scoped style/continuity profile** (`createVisualStyleProfile`):
  style summary, framing, palette, aspect ratio, and continuity hints bound
  to exactly one registered Director. Locator-free; no credential material.
- **Generation request** (`createVisualGenerationRequest`): binds profile +
  modality + provider slot + scene-plan reference. Paths and shell
  metacharacters cannot be expressed (`VISUAL_SCENE_REF_INVALID`); clip
  durations only exist for motion modalities (1–600 s) and are rejected on
  stills (`VISUAL_CLIP_SECONDS_INVALID`).
- **Generation outcome** (`recordVisualGenerationOutcome`): the fail-closed
  core.

## Outcome truthfulness (the core guarantee)

| Provider call claims | Descriptor state | Recorded media | generationMode |
|---|---|---|---|
| `succeeded` | `UNVERIFIED` | `unverified` | `not_evidenced` |
| `succeeded` | `VERIFIED` (real inspection only) | `verified` | `provider_generated` |
| `quota_exhausted` | any | `unverified` | quotaState = `WAITING_FOR_QUOTA` |
| `failed` | any | `unverified` | `not_evidenced` |

A succeeded provider call is a CLAIM, never evidence. `mediaStatus` derives
exclusively from the S-M30-01 verification state machine — reachable only
through a real matching inspection. `WAITING_FOR_QUOTA` is a durable,
resumable waiting state, never a success. Publication is always
`not_requested`.

Scoping gates: the request must be tamper-free and bound to the profile's
Director (`VISUAL_REQUEST_TAMPERED`, `VISUAL_REQUEST_SCOPE_MISMATCH`); the
descriptor must match the request's modality (`VISUAL_DESCRIPTOR_INVALID`),
carry a plausible inspection trail when VERIFIED (unknown inspector tools and
reason-carrying states are rejected — hand-forged verification blocks fail),
and belong to the same Director (`VISUAL_AGENT_SCOPE_MISMATCH`); the provider
call must match the request's provider slot (`VISUAL_PROVIDER_MISMATCH`).

## Determinism and serialization

All records (capabilities, profiles, requests, outcomes) are frozen,
byte-identical for identical inputs, with recomputed SHA-256 ids and
truthful verdict functions (`verifyVisualStyleProfile`, `verifyVisualOutcome`)
that never repair. `serializeVisualOutcome` is a strict Rule-17 allowlist in
fixed order: polluted keys are dropped and can never leak; secrets and
internal agent names are rejected in every string (Rules 15/17).

## Error codes

`VISUAL_CAPABILITY_INVALID`, `VISUAL_ADAPTER_ID_INVALID`,
`VISUAL_MODALITY_INVALID`, `VISUAL_ASPECT_INVALID`, `VISUAL_BOUNDS_INVALID`,
`VISUAL_PROFILE_INVALID` / `_MALFORMED` / `_TAMPERED`,
`VISUAL_STYLE_INVALID`, `VISUAL_FRAMING_INVALID`, `VISUAL_PALETTE_INVALID`,
`VISUAL_CONTINUITY_INVALID`, `VISUAL_REQUEST_INVALID` / `_TAMPERED` /
`_SCOPE_MISMATCH`, `VISUAL_SCENE_REF_INVALID`,
`VISUAL_CLIP_SECONDS_INVALID`, `VISUAL_PROVIDER_INVALID` /
`_ROLE_INVALID` / `_CALL_INVALID` / `_MISMATCH`, `VISUAL_MODEL_INVALID`,
`VISUAL_DESCRIPTOR_INVALID`, `VISUAL_AGENT_INVALID`,
`VISUAL_AGENT_SCOPE_MISMATCH`, `VISUAL_INPUT_INVALID`,
`VISUAL_SECRET_REJECTED`, `VISUAL_INTERNAL_NAME_REJECTED`,
`VISUAL_OUTCOME_MALFORMED` / `_TAMPERED`.

## Non-goals

No actual generation, no provider HTTP calls, no storage, no scheduling. The
execution adapter (future slice) consumes this contract plus real provider
responses and real inspections.
