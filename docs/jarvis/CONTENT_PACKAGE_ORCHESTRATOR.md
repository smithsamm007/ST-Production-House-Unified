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
| 8 | `subtitle_plan` | `deterministicSubtitlePlan.js` | `subtitle_plan_v1` (SRT/VTT-ready cues) — **requires owner-supplied timed narration** |

## Truthfulness boundaries

1. **No media, ever, at this layer.** `provenance.generatedMediaCount` is 0 and
   `mediaStatus` is `not_generated`. Narration text, audio, images, BGM, and
   rendering require approved free providers (quota-gated) or owner-supplied
   input and are separate future slices.
2. **No invented narration.** No in-repo stage can synthesize speech. If the
   caller does not supply `timedNarrationSegments`, the subtitle stage is
   recorded as `skipped_pending_input` with reason `NARRATION_SEGMENTS_REQUIRED`
   and a resumable checkpoint — never fabricated text or timings.
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

`tests/jarvisContentPackageOrchestrator.test.js` covers: the full stage chain,
deterministic artifact identity across task ids, distinct concepts producing
distinct outline ids, restart-safe rerun, durable checkpoints for package and
stages, evidence-ledger receipts (and operation without a ledger), owner-scoped
subtitle completion, timed-narration fail-closed validation, constructor
requirements, and honest failure checkpointing.
