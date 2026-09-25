# Production executor runner (Issue #187)

> Status: implemented. The durable worker loop can now drive the REAL media
> executors end to end: Hermes `production.start` → queued
> `episode_production` job → lease claim → **this runner** →
> `runEpisodePipeline(executorRunner)` → real TTS/visual/FFmpeg → #182
> bridge → #186 packaging + QC → owner-approval `review`.

## Activation (explicit, default OFF)

```bash
STPH_ENABLE_WORKERS=1 STPH_ENABLE_REAL_MEDIA=1 npm start
```

- Without `STPH_ENABLE_REAL_MEDIA=1`, the worker runs the historical
  deterministic pipeline exactly as before (byte-identical behavior; all
  pre-existing tests unchanged).
- With it, `createProductionBootstrap` binds
  `bindProductionRunner({ agentId })` per claimed job. No env defaults to a
  fake-capability registry: without configured provider capacity the runner
  returns the truthful durable wait — never fabricated media.

## The runner binding (`bindProductionRunner`)

One binding serves exactly ONE Director (`agentId`); any invocation for a
different Director throws `RUNNER_AGENT_MISMATCH` (§3/§4 isolation). The
binding carries:

- `tts`: `{ profile, registry }` — Director voice profile + DECLARED
  provider capabilities (edge-tts primary by default)
- `visual`: `{ profile, registry }` — style profile + declared capabilities
  (pollinations primary by default)
- `paths`: media output roots + run prefix (release-id-keyed file names)
- injectable `spawnImpl`/`readFileImpl`/clock for offline contract tests;
  production uses the executors' node:child_process/node:fs defaults
- `qcChecks`: optional automated policy checks feeding the #186 QC gate

Per stage:

| Stage | Executor | Honesty behavior without capacity |
|---|---|---|
| `audio` | `executeTtsGeneration` (#179) | `WAITING_FOR_QUOTA` / `CREDENTIAL_MISSING` |
| `visual` | `executeVisualGeneration` (#181) | durable wait, never a fake still |
| `packaging` | visual chain (thumbnail key art) | durable wait |
| `assembly` | `executeAssemblyPlan` (#175) via `buildLongformAssemblyPlan` | honest failure on unresolvable bindings |
| `qc` | returns the binding's policy checks | optional; gate stays authoritative |

## 30–50 minute long-form policy

`buildLongformAssemblyPlan` plans `main_longform` at 1890 s (inside the
1800–3000 s window). The #175 executor measures the REAL rendered duration
via ffprobe and fails the QC duration gate on out-of-range output — a
17m42s render can never pass as a 40-minute episode.

## Durable waits in the worker loop

A waited pipeline result re-queues the job for scheduler resume — bounded by
the job's retry budget (`attempts` vs `max_attempts`); an exhausted budget
fails the job honestly (`WORKER_JOB_WAIT_BUDGET_EXHAUSTED`). The release
stays `planned` with the wait recorded on the job metadata, pipeline events,
and evidence; nothing is ever marked successful by the wait path.

## Tests

`tests/productionExecutorRunner.test.js` (10): real TTS/visual/thumbnail/
assembly executions verified against injected bytes; truthful wait without
capacity; per-Director binding refusal; long-form plan policy; full worker
run producing verified media + packaging + QC reaching `review`;
deterministic default without the factory; wait re-queue + budget
exhaustion; factory receives the claimed job's own agent id.
