# Real-executor pipeline integration (Issue #183)

> Status: implemented. `runEpisodePipeline` now drives the REAL media
> executors (TTS #179, visual #181, FFmpeg assembly #175) through ONE
> injected, Director-scoped stage runner and records every result through
> the #182 artifact-recording bridge. Without an injected runner the
> historical deterministic path runs unchanged.

## Architecture

    runEpisodePipeline({ ..., executorRunner })
      ├── executorRunner injected? → runEpisodePipelineWithExecutors()
      │     ├── audio    → executeTtsGeneration      (#177/#179)
      │     ├── visual   → executeVisualGeneration   (#181)
      │     ├── assembly → executeAssemblyPlan       (#174/#175)
      │     │     (consumes the release's OWN verified artifacts via
      │     │      sha256 descriptor bindings built by the runner)
      │     ├── every result → evaluateExecutorArtifact (#182 bridge)
      │     ├── recorded verdict → recordExecutorArtifact (idempotent)
      │     └── story stage stays deterministic (plan document, not media)
      └── no runner → deterministic stages exactly as before (#183 is additive)

`src/pipeline/executorIntegration.js` is the module boundary:
`createStageExecutionContext` (per-call, release-bound context),
`runStageWithExecutor` (runner invocation + bridge evaluation), and
`classifyExecutorWait` (fail-closed wait vs failure classification,
`EXECUTOR_WAIT_CODES` owned by the bridge module).

## Director isolation (Master Prompt §3/§4)

- The runner is invoked with `release.agentId` ONLY — the binding resolved
  durably through release → channel → agent in `ProductionRepository.getRelease`
  (second honest read; the channel itself is never serialized onto the DTO).
- Every profile, request, and plan is built per-call from that agent id;
  this module caches nothing across releases. A multi-Director worker keeps
  runtime state, provider slots, credentials, and asset paths Director-scoped
  on its side of the boundary.
- Any executor result whose descriptor was produced by a different Director
  fails closed through the bridge's `EXECUTOR_AGENT_SCOPE_MISMATCH` gate —
  cross-Director media can never record under another Director's release.
- The release's durable job link is resolved via the Rule-13 idempotency key
  (`production-<releaseId>`), so worker/retry paths carry job identity
  without a new migration.

## Honest outcome semantics (Rules 1–3)

| Executor result | Pipeline behavior |
|---|---|
| verified media (matching inspection) | artifact recorded `provider_generated`, `ffprobe_verified=true`; stage succeeded |
| unverified (ran, inspection failed) | truthful stage failure with the executor's stable code; release → `planned`; job marked failed; no artifact |
| `WAITING_FOR_QUOTA` / `CREDENTIAL_MISSING` / `PROVIDER_UNAVAILABLE` | DURABLE WAIT: release → `planned` for scheduler resume, `pipeline_stage_waiting` evidence, wait code attached to the job WITHOUT changing its status (R5) |
| forged / cross-Director / malformed | bridge gate throws; stage failed; release → `planned` |

Stage-failure ordering guarantees: failure at stage N preserves recorded
stages 1..N-1 (same contract as the deterministic path). The pipeline never
marks a stage successful without bridge-verified evidence.

## Tests

`tests/executorPipelineIntegration.test.js` (9 tests): end-to-end real
executor run recording verified narration/visual/assembled-episode artifacts
hash-anchored to the REAL bytes; persistence with honest provenance;
durable-wait semantics (release re-planned, job metadata, no fabricated
artifact); truthful unverified failure (job failed, nothing recorded);
gate-error propagation; cross-Director fail-closed; per-stage Director
binding assertions; wait/failure classification closure; stage-context
binding.

## Non-goals

No provider calls inside the pipeline module itself (transports stay with
the worker's runner); no publishing; no new SQL migration (job link via
idempotency key); no new job-status states (R5).
