# Canonical Package Production — Reels Stage, S-M37 Manifest & QC (Issue #189)

Extends the executor-driven episode pipeline (see
`PRODUCTION_EXECUTOR_RUNNER.md`) so one production run yields the canonical
ST package: **1 main long-form video + 2 independent content Reels + 1 brand
Reel + packaging + QC**, all bound in the S-M37
`media_package_manifest_v1`.

## Pipeline stage order (executor path)

```
audio → visual → assembly → reels → packaging → qc
```

`sql/025_reels_stage.sql` additively extends the `pipeline_events.stage`
CHECK with `reels` (drop + re-add, idempotent, per the sql/009/024
precedent — R1: existing migrations never edited).

## The reels stage (`src/pipeline/reelsStage.js`)

- `buildCanonicalReelPackagePlan` builds the reel plan through the S-M34-01
  contract (`src/production/reelPlan.js`), then runs
  `assertReelIndependence`: the two content reels must differ in **hook,
  objective, and segment plan** — structurally identical plans are rejected
  with `REEL_NOT_INDEPENDENT` (genuine independence, not duplicated media).
- `brandIntegrationMode` is `STANDALONE_ONLY` by default; integration into
  the main video remains owner-gated (Rule 9 — never silent).
- `buildReelAssemblyPlans` converts each reel into a REAL `createAssemblyPlan`
  (canonical id recomputed, #175 preflight re-verifies integrity) with
  `outputTarget` `content_reel_1` / `content_reel_2` / `brand_reel`,
  9:16 aspect, bound to the release's OWN verified narration + visual
  artifacts via `sha256:` descriptor refs. Reel 2 uses a two-beat visual
  pacing structure distinct from reel 1 (independence by construction).
- Output paths are release-keyed: `<episode-dir>/<runId>-<key>.mp4`.

## Runner support (`src/pipeline/productionExecutorRunner.js`)

- `reels:init` → builds the frozen `{ reelPackage, reelPlans }` through the
  binding's own Director scope.
- `reels` → executes ONE reel plan through the real FFmpeg executor with a
  unified per-pass `productionRunId` supplied by the pipeline (one run
  identity across every stage).
- The executor's `TARGET_KIND` maps reel targets to `short` encoding and the
  **short-form duration QC ([3, 90] s)** on the REAL ffprobe-measured render;
  out-of-range renders fail `QC_DURATION_OUT_OF_RANGE` truthfully (§5: never
  a fabricated pass on requested duration).

## Recording through the #182 bridge

Every verified reel is evaluated by `evaluateExecutorArtifact` (stage
`assembly` semantics: video artifact, forged-VERIFIED rejection, cross-Agent
scope check) and recorded via `recordExecutorArtifact` as
`provider_generated` + `ffprobe_verified=true`. Waits (`quotaState ===
WAITING_FOR_QUOTA` / credential waits) re-plan the release durably with the
wait code on the job — no fabricated artifact. A reel failing its real QC is
a truthful stage failure; earlier stages remain recorded.

## Canonical manifest + QC gate (`src/pipeline/packagingQc.js`)

- `buildEpisodePackageManifest` now assembles the **canonical S-M37
  `media_package_manifest_v1`** via `createMediaPackageManifest` when reel
  artifacts are present: `mainVideo` descriptor (from the real assembled
  episode) + `contentReels` (independence asserted at plan time) +
  `brandReel` with `brandIntegrationMode: "STANDALONE_ONLY"`. Reels are
  scope-checked against the release's agentId before inclusion (Director
  isolation), and every binding must be `VERIFIED` with hashes matching the
  recorded artifacts.
- Thumbnails/visuals are re-promoted to the manifest's typed
  `thumbnail`/`still_image` descriptors from the same REAL inspection
  (identical hash — no second generation, no fabricated type).
- QC gate extension: `isMediaPackageProductionReady` (all bindings VERIFIED,
  valid brand mode, `publication: not_requested`) feeds the episode QC gate.
  Verdicts stay `approved` / `rejected` / `needs_human` (→ durable `review`
  state); human QC decisions remain `recordHumanQcDecision`, bound to the
  manifest id + principal.

## Director isolation invariants

- Reel plans, artifacts, and manifest bindings all carry the release's own
  `agentId`; any cross-Director descriptor fails closed
  (`EXECUTOR_AGENT_SCOPE_MISMATCH`).
- The per-Director runner binding (#188) refuses a foreign agentId for the
  reels stages exactly as for audio/visual/assembly.
- Manifest ids are recomputed at record time; stored-document hashes are
  recomputable from the exact recorded bytes.

## Worker-level acceptance (`tests/productionExecutorRunner.test.js`)

`worker loop with runner factory: claimed job produces the CANONICAL package`
asserts, from the DB only: audio/visual/assembly `provider_generated` +
ffprobe-verified; exactly 3 reel artifacts (2 content + 1 brand), all
verified, all **distinct hashes** (independence as recorded evidence);
thumbnail + packaging + QC recorded; release lands in `review` (QC-approved
owner gate).

Also covered: `REEL_NOT_INDEPENDENT` enforcement, brand-mode gating,
short-form duration QC failure, cross-Director manifest rejection, and the
deterministic default path untouched without the runner.
