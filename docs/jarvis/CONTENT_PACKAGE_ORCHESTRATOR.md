# JARVIS Deterministic Content Package Orchestrator

> Status: implemented (deterministic, offline). This slice produces PLANS ONLY.
> No provider call, media generation, rendering, upload, publishing, or deployment
> is performed or claimed by this document.

## Purpose

`src/jarvis/contentPackageOrchestrator.js` produces ONE original content package
by running the repository's REAL deterministic JARVIS workflow stages in
dependency order through the production `WorkerRuntime` (heartbeats,
checkpoints, idempotency, fail-closed error sanitization) and a durable
`CheckpointStore` supplied by the caller.

This is the first vertical slice that chains the previously independent
deterministic stages into a single owner-triggered package workflow.

## Stage chain (all real, pre-existing modules)

| # | Stage | Module | Output contract |
|---|---|---|---|
| 1 | `outline` | `deterministicContentWorkflow.js` | `jarvis_mvp_story_outline` (`outline_only`) |
| 2 | `narration_plan` | `deterministicNarrationPlan.js` | `narration_audio_plan` (voice profiles, beat timing; no audio) |
| 3 | `continuity_plan` | `deterministicContinuityPlan.js` | `jarvis_mvp_continuity_plan` (beat order, spoiler safety, concept fidelity) |
| 4 | `script_plan` | `deterministicScriptPlan.js` | `jarvis_mvp_script_plan` (per-beat sections, writing direction) |
| 5 | `visual_scene_plan` | `deterministicVisualScenePlanner.js` | `visual_scene_plan_v1` (16:9 + 9:16 scene specs only) |
| 6 | `shorts_plan` | `deterministicShortsPlan.js` | `shorts_plan_v1` (exactly hook / high-tension / cliffhanger; no ending reveal) |
| 7 | `metadata_thumbnail_plan` | `deterministicMetadataThumbnailPlan.js` | `metadata_thumbnail_plan` (title/description/hashtag drafts, thumbnail brief) |
| 8 | `subtitle_plan` | `deterministicSubtitlePlan.js` | `subtitle_plan_v1` (SRT/VTT-ready cues) — derived from the package's narration script, or owner-supplied segments |

## Duration contract (Issue #262)

Every stage of this chain validates `targetMinutes` against ONE closed set:
**30 / 40 / 50 minutes** (1800 / 2400 / 3000 s). The set is imported from
`src/scheduling/directorSchedule.js` through `src/jarvis/targetDuration.js`, so
a JARVIS plan can never describe a program length the production pipeline and
its QC gates would refuse to measure. Any other value (including the
previously accepted 25–30 range, e.g. 27) fails closed with the stage's own
`*_DURATION_INVALID` code.

## Narration script and measured narration audio (Issue #262)

The orchestrator now resolves ONE narration script per package through
`src/jarvis/jarvisNarrationScript.js`, which calls the SAME
duration-aligned builder (`src/pipeline/narrationScript.js`) the production
pipeline hands to its audio stage. `narrationScript` and
`narrationScriptStatus` are part of the package result.

- `narrationScriptStatus: "planned"` — a complete script sized to the target.
  It is deterministic PLANNING text, not editorial output.
- `narrationScriptStatus: "unavailable_for_language"` — the repository's
deterministic script builder emits Hindi only, so Hinglish packages keep
requiring owner-supplied timed narration. Nothing is mislabelled.

When the caller binds `narrationStage` (see
`src/jarvis/measuredNarration.js`), the complete script is narrated by the
REAL TTS executor (`src/media/ttsExecutor.js`) and judged by the measured
completeness gate (`src/media/episodeCompleteness.js`) — the same two
contracts the production runner uses, with no second executor and no second
gate. The executor's documented words-per-minute is passed as input; only the
MEASURED result decides, and this stage does not re-run the production
runner's calibration loop.

`narrationAudio` is always present and carries one of:

| status | meaning |
|---|---|
| `measured_verified` | real provider audio + gate-verified measured coverage |
| `measured_out_of_window` | real audio, measured rejection (gate reason code + measured seconds) |
| `not_generated` | provider wait/failure; the executor's own code is kept |
| `skipped_pending_runtime` | no `narrationStage` bound — nothing was generated |
| `skipped_pending_input` | no script exists for this language |

`provenance.generatedMediaCount` / `mediaStatus` / `providerCalls` are derived
from that record; a verified narration is the only path that reports one
generated medium. A `measured_verified` record is reused from the durable
`<taskId>#narration_audio` checkpoint, so a restart does not re-call a provider;
unverified attempts are never cached.

## Truthfulness boundaries

1. **No media, ever, at this layer.** `provenance.generatedMediaCount` is 0 and
   `mediaStatus` is `not_generated`. Narration text, audio, images, BGM, and
   rendering require approved free providers (quota-gated) or owner-supplied
   input and are separate future slices.
2. **No invented narration.** Subtitle cues are derived from the package's own
   narration script: contiguous slices of the script's words, with timings
   labelled `narration_script_planned_seconds` (planned, never measured).
   Hinglish packages (no script builder exists) still record
   `skipped_pending_input` / `NARRATION_SEGMENTS_REQUIRED` unless the owner
   supplies `timedNarrationSegments`; derived cues without a valid `ownerId`
   record `OWNER_SCOPE_REQUIRED`. No text or timing is ever fabricated.
3. **No publication.** `publication.status` stays `not_requested` on every stage
   output and on the package; `assertContract` rejects any stage that claims
   otherwise.
4. **No provider calls.** Every stage output is verified post-run:
   `generationMode === "deterministic_local"` and empty `providerCalls`, or the
   orchestrator fails closed.
5. **Stage failure is honest.** A failing stage produces a
   `content_package_stage_failed` checkpoint (resumable, no execution started),
   a `jarvis_content_package_failed` evidence event, and a rethrown error.

## Scope and safety

- Agent is pinned to `agent-01`; stage job types are the canonical
  `jarvis.content.*.v1` identifiers enforced by each handler.
- Stage task ids are `<packageTaskId>#<stage>`, so checkpoints and runtime
  idempotency are restart-safe per stage and per package.
- The subtitle stage requires an `ownerId` matching
  `^[a-zA-Z0-9_-]{3,80}$` for scope-isolated cue planning.
- Internal agent names remain rejected inside every stage (Rule 15); secret-like
  inputs are rejected by every stage validator (Rule 17).

## Verification

`tests/jarvisTargetDuration.test.js` (Issue #262) covers: the canonical
30/40/50 set matching the Director schedule options, consistent plans across
every stage for all three targets, fail-closed non-canonical durations, the
shared narration script, derived cue provenance (words == script words,
contiguous planned timings), and the measured narration gate verdicts
(in-window, short, unmeasurable, provider wait) plus checkpoint reuse.
`tests/jarvisContentPackageOrchestrator.test.js` covers: the full stage chain,
deterministic artifact identity across task ids, distinct concepts producing
distinct outline ids, restart-safe rerun, durable checkpoints for package and
stages, evidence-ledger receipts (and operation without a ledger), owner-scoped
subtitle completion, timed-narration fail-closed validation, constructor
requirements, and honest failure checkpointing.
