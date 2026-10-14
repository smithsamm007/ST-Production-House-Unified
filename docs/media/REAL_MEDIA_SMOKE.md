# Real Media Smoke Verification (Phase 2 evidence)

> Status: **executed**. This document records what the shipped executors did
> when driven against real `ffmpeg`/`ffprobe` binaries and the real
> filesystem, and what they did **not** do. Every number below comes from a
> run of `scripts/real_media_smoke.mjs` in this repository; the raw evidence
> JSON is written to `artifacts/real-media-smoke/` (git-ignored — evidence is
> produced by running the tools, never committed as a claim).

## Why the harness exists

The media executors shipped with injectable `spawnImpl` / `readFileImpl`
transports and *no* production implementation anywhere in `src/`. A worker
started with `STPH_ENABLE_WORKERS=1 STPH_ENABLE_REAL_MEDIA=1` therefore
reached every real stage with `spawnImpl === undefined` and failed closed with
`<STAGE>_SPAWN_FAILED`. Two blockers were fixed before this smoke run could
mean anything:

| Blocker | Fix |
|---|---|
| No production transport existed (`spawnImpl` / `readFileImpl` undefined in every real stage) | `src/media/nodeMediaTransport.js` — array-args `spawn` with `shell:false`, bounded stdout/stderr capture, real timeout kill, real file bytes for hashing; wired into the real-media worker factory in `src/catalog/server.js` (media root: `STPH_MEDIA_ROOT`, default `<cwd>/artifacts/media`, directories created at boot) |
| A narration (`voice`) **segment** produced an ffmpeg command real ffmpeg rejects | `src/media/ffmpegAssemblyExecutor.js` now defines a real filtergraph label (`[N:a]anull[asegN]`) instead of mapping the raw input specifier `-map [N:a]` |

### The argv defect, verbatim

Real ffmpeg 4.4.2 refused the longform command with:

```
Output with label '1:a' does not exist in any defined filter graph, or was already used elsewhere.
```

`buildRenderPlan` pushed the raw input specifier `[N:a]` into the audio mixer
list and then emitted `-map [N:a]`. ffmpeg reads `[N:a]` as a *filtergraph
output label*, not an input stream specifier, so every plan containing an
audio **segment** (which is exactly what `buildLongformAssemblyPlan` and
`reelsStage` produce for narration) failed with `FFMPEG_EXIT_NONZERO` on a
real render. The offline suite never caught it because the injected spawn
accepts any argv. Fix + a new invariant test
(`every mapped label is defined by the filtergraph`) close it:
`tests/ffmpegAssemblyExecutor.test.js`.

## What was verified (real binaries, real bytes)

Environment: Node v22.23.2, ffmpeg/ffprobe 4.4.2, 1 CPU, no provider
credentials, no network provider calls.

| Check | Result |
|---|---|
| Long-form assembly through `executeAssemblyPlan` (`main_longform`, 16:9, libx264 medium/crf20) | exit code 0; ffprobe measured **1890 s** (inside the [1800, 3000] s window); QC policy `main_video_runtime` **passed**; descriptor state **VERIFIED**; real SHA-256 `404970241788158568a95b74a7544bb1c50fb5f719655b9aed8b506391e51c18`; 905,917 bytes on disk; wall time ≈ 25 s |
| Short-form renders through the same executor (`content_reel_1`, `content_reel_2`, `brand_reel`) | all exit 0; ffprobe measured **30 s** each (inside [3, 90] s); QC policy `short_form_runtime` **passed**; descriptors **VERIFIED**; no labelled degradations; wall time ≈ 37 s for all three |
| Negative control: a real 30 s render bound to a `main_longform` plan | `success: false`, `failureCode: QC_DURATION_OUT_OF_RANGE`, measured 30 s — the gate is not a rubber stamp, and no descriptor is promoted |
| Direct gate call on a real 30 s inspection | `evaluateMainVideoRuntimeGate` → `passed: false`, `QC_DURATION_OUT_OF_RANGE` |
| Transport contract (`tests/nodeMediaTransport.test.js`, 14 tests) | 14/14 pass; includes real-subprocess proofs of stdin delivery, literal hostile arguments (no shell), non-zero exit, timeout kill, ENOENT, and hash-matching file reads |

Render geometry note (stated plainly): the long-form visual input is a real
1 fps flat-colour video of the full planned runtime, and the audio input is a
**silent** placeholder track. They exist so the mandated encoder profile can
produce a genuine 30–50 minute file inside a bounded CPU budget. They are
labelled placeholders in every descriptor (`local_ffmpeg_placeholder_signal`)
and are never presented as narration or as story footage.

## What was NOT verified (honest gaps)

1. **Text-to-speech.** `edge-tts` and `piper` are both ABSENT in this
   workspace. With no declared capacity the executor returns the durable
   `WAITING_FOR_QUOTA` wait; with declared capacity it returns
   `TTS_SPAWN_FAILED` and `mediaStatus: unverified`. No speech was generated
   and none is claimed. Installing Piper also requires model weights whose
   licence and commercial-use rights must be documented first (AGENTS.md
   Rule 12), so the harness deliberately does not fetch them.
2. **Visual generation.** `visual-pollinations` / `visual-local` are contract
   command names only — no adapter executable ships in this repository, so a
   declared-capacity run returns `VISUAL_SPAWN_FAILED` /
   `mediaStatus: unverified`. Real image generation needs a deployment-supplied
   adapter (or a documented local model).
3. **Provider-backed stages through the worker loop.** Nothing yet derives
   `binding.tts.registry` / `binding.visual.registry` from an owner's onboarded
   connections, so `src/catalog/server.js` still binds the runner without a
   capacity registry and the worker records the truthful durable wait. See
   `docs/production/PHASE_READINESS_AUDIT.md` §Phase 2 for the exact seam.

## Running it

```bash
which ffmpeg ffprobe                      # capacity check (both required)
node scripts/real_media_smoke.mjs --stage=inputs
node scripts/real_media_smoke.mjs --stage=provider-capacity
node scripts/real_media_smoke.mjs --stage=longform
node scripts/real_media_smoke.mjs --stage=reels
node scripts/real_media_smoke.mjs --stage=negative
# or: npm run media:smoke        (all stages)
```

Each stage is separately bounded; evidence lands in
`artifacts/real-media-smoke/<stage>.json`. `--reel=<target>` restricts the
reels stage to one canonical target.
