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
| `audio` | `executeTtsGeneration` (#179) + measured rate calibration (Issue #257, see below) | `WAITING_FOR_QUOTA` / `CREDENTIAL_MISSING` |
| `visual` | `executeVisualGeneration` (#181) | durable wait, never a fake still |
| `packaging` | visual chain (thumbnail key art) | durable wait |
| `assembly` | `executeAssemblyPlan` (#175) via `buildLongformAssemblyPlan` | honest failure on unresolvable bindings |
| `qc` | returns the binding's policy checks | optional; gate stays authoritative |

## Narration ⇄ duration alignment (audio stage)

The audio stage narrates the **complete script** built for the run's
configured duration — never the episode title alone.

```bash
# pipeline builds it once per run, from the resolved target:
stageInputs.narrationScript = buildNarrationScript({ title, season, episode,
                                                      targetDurationSeconds })
# the runner hands that text to the executor:
scriptText = stageInputs.narrationScript.text
```

- `src/pipeline/narrationScript.js` plans five beat segments (hook →
  discovery → escalation → reversal → cliffhanger) that sum **exactly** to
  1800 / 2400 / 3000 s (30 / 40 / 50 minutes). Any other target fails closed
  with `NARRATION_TARGET_UNSUPPORTED`; an omitted target means the documented
  2400 s default, matching `resolveEpisodeTargetDuration`.
- The word budget is sized at a documented **2.2 words/second** planning rate
  and aimed inside the completeness gate's own acceptance window
  (`[target − tolerance, video + 1]`), so plan and QC describe the same
  program length.
- `generationMode: "deterministic_local"`, `editorialStatus:
  "deterministic_planning_text"` — this is deterministic planning narration,
  never a claim of editorial or provider output. An approved script can
  replace it without touching this module.
- The only authority on a RENDERED duration remains the post-render FFprobe
  inspection consumed by `evaluateEpisodeCompleteness` (S-M41-01).
- Regression coverage: `tests/narrationDurationAlignment.test.js` binds
  builder → `stageInputs` → runner → executor → completeness gate, and proves
  the legacy title-only line still fails `QC_AUDIO_COVERAGE_INSUFFICIENT`.

### Measured narration-rate calibration (audio stage)

The audio stage consumes MEASURED durations, not planning assumptions:

1. It requests synthesis at the narration plan's declared words-per-minute
   (`stageInputs.narrationScript.wordsPerMinute`), or at the provider default
   when no plan is supplied. No rate argument is invented elsewhere.
2. It reads the REAL post-render inspection's audio duration and compares it
   against EXACTLY the window the S-M41-01 completeness gate enforces for this
   run's target: `[target − audioCoverageToleranceSeconds(target), target + 1]`.
3. While the measurement sits outside that window and the selected provider
   accepts a documented absolute-rate argument (espeak-ng `-s <wpm>`), it
   re-requests synthesis with `rate × measured/target`, bounded to
   `MAX_AUDIO_CALIBRATION_ATTEMPTS` (3) — every attempt recorded in
   `result.calibration.attempts` as evidence, and the settled request
   re-measured. The proportional rule converges from the measured rehearsal
   physics (175 → 114 → 117) and never trusts a hardcoded answer.
4. Honest exits:
      - out-of-window measurement on a provider without rate control →
        `NARRATION_RATE_UNCONTROLLED` — fail closed BEFORE spending an
        assembly render the gate would mathematically reject;
      - window unreachable within the bound (or the adjusted rate outside
        the provider's supported range) → `NARRATION_CALIBRATION_EXHAUSTED`;
      - executor failure or durable wait → returned UNCHANGED, never retried
        blindly (quota/credential resumption stays the scheduler's job);
      - no target or unmeasurable inspection → behave exactly as before;
        the completeness gate remains the only duration authority.

Offline, injected-transport tests: `tests/audioRateCalibration.test.js`.
Executed measured rehearsal for all three targets: `npm run real-media-rehearsal`
(`docs/media/REAL_MEDIA_REHEARSAL.md`).

## 30–50 minute long-form policy (Director-configured target)

`buildLongformAssemblyPlan` renders `main_longform` at the episode duration the
run RESOLVED — the Director's persisted schedule (sql/029) → the duration
stamped on the queued job → the documented 2400 s default. An explicit
duration that is not one of the selectable targets (1800/2400/3000) is refused
with `RUNNER_REQUEST_INVALID`; a run whose assembly QC block does not report the
configured target fails closed (`EXECUTOR_TARGET_DURATION_NOT_APPLIED`) rather
than silently rendering a different length.

The #175 executor measures the REAL rendered duration via ffprobe and fails the
QC duration gate against that target (and, for an unconfigured run, the
canonical [1800, 3000] s window) — a 17m42s render can never pass as a
40-minute episode.

See `docs/production/DIRECTOR_EPISODE_SCHEDULE.md` §8 for the full resolution
order and its consumers.

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
