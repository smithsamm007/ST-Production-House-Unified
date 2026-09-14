# AI News Content Package Orchestrator

> Status: implemented (deterministic, offline). This slice ORCHESTRATES
> existing stage modules through the real worker machinery. No provider call,
> narration synthesis, media generation, upload, publishing, or deployment is
> performed or claimed by this document.

## Purpose

`src/aiNews/contentPackageOrchestrator.js` generalizes the proven JARVIS
content-package pattern (`src/jarvis/contentPackageOrchestrator.js`) to the
AI News pipeline. It runs ONE news package through the REAL deterministic AI
News stages in dependency order, using the production `WorkerRuntime`
(heartbeats, checkpoints, idempotency, fail-closed errors) and a durable
`CheckpointStore`:

```
research brief -> editorial plan -> metadata/thumbnail plan
               -> subtitle plan (requires owner-supplied timed narration)
```

This is backlog slice S-M27-01 (Module 27), the AI News counterpart of the
JARVIS orchestrator (PR #107).

## Stage chain and bindings

| Stage | Job type | Module | Contract |
|---|---|---|---|
| `research_brief` | `ai-news.research-brief.v1` | `deterministicResearchBrief.js` | `ai_news_research_brief` |
| `editorial_plan` | `ai-news.editorial-plan.v1` | `deterministicEditorialPlan.js` | `ai_news_editorial_plan` |
| `metadata_thumbnail_plan` | `ai-news.metadata-plan.v1` | `deterministicMetadataPlan.js` | `ai_news_metadata_thumbnail_plan` |
| `subtitle_plan` | `ai-news.subtitle-plan.v1` | `deterministicSubtitlePlan.js` | `ai_news_subtitle_plan` |

Bindings are asserted BEFORE the next stage runs (fail closed):

- The editorial plan must carry the research brief's `briefId`.
- The metadata plan must carry the brief's `briefId` and the editorial plan's
  `planId`.
- The subtitle plan must carry the brief's `briefId`, the editorial plan's
  `planId`, and a narration registry id (recomputed by the subtitle module).
- `AI_NEWS_PACKAGE_BRIEF_PLAN_MISMATCH`,
  `AI_NEWS_PACKAGE_PLAN_ID_MISMATCH`,
  `AI_NEWS_PACKAGE_METADATA_BRIEF_MISMATCH`,
  `AI_NEWS_PACKAGE_SUBTITLE_PLAN_MISMATCH`,
  `AI_NEWS_PACKAGE_SUBTITLE_BRIEF_MISMATCH` on any drift.

Every stage output is contract-asserted (`assertContract`): deterministic
local generation, zero provider calls (top-level `providerCalls: []` or
`provenance.providerCalls: 0`), and `publication.status: "not_requested"`.

## Honest states (never fabricated)

- **Blocked propagation.** A blocked upstream stage stops the chain: the
  package reports `readiness: "blocked"` with the ORIGINAL upstream reason
  code (`INSUFFICIENT_CORROBORATION`, `BRIEF_CONTRACTIONS_UNRESOLVED` — see
  stage contracts — `NO_ELIGIBLE_CLAIMS`, `NO_SAFE_CLAIM_TEXT`, …), and every
  downstream stage is recorded `not_run` with `UPSTREAM_BLOCKED`. Nothing is
  generated from unverified claims.
- **Pending narration.** Without owner-supplied timed narration the subtitle
  stage is truthfully `skipped_pending_input` with
  `NARRATION_REGISTRY_REQUIRED`, a resumable checkpoint
  (`subtitle_waiting_for_narration_input`) is written, and the package
  reports `package_incomplete_pending_narration_input` — mirroring the JARVIS
  orchestrator's contract.
- **Complete.** With narration supplied and validated, all four stages
  complete and the package reports `deterministic_package_complete`.

## Provenance and durability

- `provenance`: `providerCalls: 0`, `networkCalls: 0`,
  `generatedMediaCount: 0`, `mediaStatus: "not_generated"`.
- Deterministic SHA-256 `packageId` over the stage ids and readiness;
  identical inputs produce the identical package on any task id.
- Checkpoints: per-stage (via `WorkerRuntime` + `CheckpointStore`) and a
  package-level `content_package_ready` (progress 100) or
  `content_package_stage_failed` (resumable) checkpoint.
- Evidence ledger (optional): `ai_news_stage_completed`,
  `ai_news_stage_skipped`, `ai_news_content_package_completed`,
  `ai_news_content_package_failed`.
- Constructor and input validation fail closed with stable codes
  (`AI_NEWS_PACKAGE_ORCHESTRATOR_RUNTIME_REQUIRED`,
  `AI_NEWS_PACKAGE_ORCHESTRATOR_CHECKPOINT_STORE_REQUIRED`,
  `AI_NEWS_PACKAGE_TASK_ID_INVALID`, `AI_NEWS_PACKAGE_OWNER_ID_INVALID`,
  `AI_NEWS_PACKAGE_TIMED_NARRATION_INVALID`).

## Truthfulness boundaries

1. **No narration, media, or facts are generated.** All content echoes
   owner/agent-supplied input through the stage contracts.
2. **No provider or network calls.** Provenance counters stay zero; any
   non-deterministic stage output fails the package.
3. **No publication.** `publication.status` stays `not_requested`; publishing
   requires separate owner approval (Rules 7/16).
4. **No scope drift.** The package pins `agent-ai-news` and validates the
   owner scope before any stage runs.

## Verification

`tests/aiNewsContentPackageOrchestrator.test.js` (15 tests) covers: the full
chain with per-stage contract fields, subtitle completion with timed
narration, fail-closed narration validation, determinism/idempotency across
reruns and task ids, distinct sources yielding distinct ids, honest blocking
with original reason codes and `not_run` downstream stages, stage-failure
checkpointing and evidence, secrets rejection in the research stage, durable
checkpoints, evidence-ledger classifications, ledger-less operation,
constructor fail-closed requirements, and input validation.

Evidence from this slice: `npm test` 497/497 passing (15 new),
`npm run verify`, `npm run lint`, and `npm run plan:check` all pass on the
slice branch.
