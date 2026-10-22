# Motion Executor (S-M40-01, Issue #236)

Local-only motion interpolation stage: a deterministic contract plus a real
FFmpeg `minterpolate` fallback over existing artifacts. Remote motion
providers (ViMax etc.) are deliberately out of scope — live provider work
stays owner-gated; nothing in this slice contacts a network, downloads
models, or bundles weights/beof-weights/assets (Rules 5/12).

## Components

| Module | Role |
|---|---|
| `src/media/motionAdapter.js` | Pure contract: bounded request vocabulary, deterministic SHA-256 identity, truthful outcome recording (descriptor decides), Rule 15/17 guards. |
| `src/media/motionInterpolationWorker.js` | Executor boundary: argv construction (array args ONLY), local ffmpeg run through `nodeMediaTransport`, real post-render inspection, descriptor promotion. |
| `src/pipeline/motionStage.js` | Pipeline binding (Issue #241): opt-in gate, verified-source prerequisites, bounded concat frame list, worker invocation, executor-result mapping. |
| `tests/motionAdapter.test.js` | 12 offline contract tests (determinism, bounds, secrets, internal names, UNVERIFIED default). |
| `tests/motionInterpolationWorker.test.js` | 8 tests: argv safety, honest failure matrix (ENOENT → `MOTION_SPAWN_FAILED`, non-zero → `MOTION_CALL_FAILED`, timeout → `MOTION_TIMEOUT`, unreadable output → `INSPECTION_FAILED`), plus ONE real execution test (real ffmpeg + real ffprobe). |
| `tests/motionPipelineBinding.test.js` | 11 tests: gate parsing, frame-list determinism/path safety, fail-closed prerequisites, worker verdict → #182 bridge mapping, runner stage branch, and assembly consuming the motion clip. |

## Request vocabulary (contract)

`createMotionRequest` binds ONE registered Director to one interpolation job
over explicit `sha256:`-prefixed source frame bindings with bounded params
(`sourceFps`/`fps` 1..120 integers — `fps` must exceed `sourceFps`,
`mbSize` in {8,16,32}, `searchParam` 4..64, `frameCount` 1..20000). Paths are
never expressible in the contract; real paths are worker-local operational
inputs, path-validated the same way as the #170 inspection runner. Secrets
and internal agent names are rejected in every free-text field.

## Honesty contract

- **Exit 0 is not evidence.** `mediaStatus: "verified"` requires a real
  matching-hash inspection of the actual rendered bytes; the descriptor stays
  `UNVERIFIED` otherwise (the S-M30-01 state machine is the only promotion
  path).
- **Missing binary is a truthful failure** (`MOTION_SPAWN_FAILED`), never a
  disguised wait — the local slot has no provider quota.
- **A stale file is not this run's render.** When the spawn did not run (or
  exited non-zero), an inspectable file already at the output path is a
  previous attempt's bytes: the descriptor stays `UNVERIFIED`
  (`RENDER_NOT_EXECUTED`) and `success` stays false. This matters because the
  pipeline's motion output paths are deterministic per release, so a retry
  lands on the same path (Issue #241).
- **Degradation labeling:** successful local renders record
  `generationMode: "local_interpolation"`; anything unverified records
  `not_evidenced`. Rotation/realism quality is NEVER asserted; what is
  asserted is only what ffprobe measured on the real bytes.
- **Quota honesty:** `quotaState` is the constant `"OK"` — there is no
  remote provider quota in this slice.

## Argv shape (frozen array, never a shell string)

```
ffmpeg -y -f concat -safe 0 -i <frameList> \
  -vf minterpolate=fps=<fps>:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:mb_size=<mb>:search_param=<n> \
  -r <fps> -frames:v <frameCount> -c:v libx264 -pix_fmt yuv420p <output>
```

Every token maps to a documented ffmpeg/minterpolate option (no invented
flags). The output path is always the LAST argument; hostile paths are
rejected before any spawn (`PATH_UNSAFE` / `MOTION_EXECUTOR_INVALID`).

## Pipeline binding (Issue #241 — opt-in)

`runEpisodePipeline` runs `audio → visual → assembly` unless the deployment
opts in with `STPH_ENABLE_LOCAL_MOTION=1`, in which case the local stage runs
between visual and assembly:

```
audio → visual → motion → assembly
                     │         └── consumes the motion clip as its visual
                     │             program (video_clip, planned duration)
                     └── local ffmpeg minterpolate over the release's OWN
                         recorded, VERIFIED visual artifact
```

The flag is resolved once in `src/catalog/server.js` and passed to the worker
(`ProductionWorkerLoop({ motionEnabled })` → `runEpisodePipeline`). It is only
meaningful together with `STPH_ENABLE_REAL_MEDIA=1`: the deterministic path
has no motion stage, and that combination is reported at boot as
`MOTION_STAGE_IGNORED_WITHOUT_REAL_MEDIA` instead of silently doing nothing.

### Prerequisites (checked before any spawn)

| Requirement | Failure when absent |
|---|---|
| The release recorded a `visual` artifact in this run | `MOTION_SOURCE_UNAVAILABLE` |
| That artifact carries a `sha256:` content hash, a real storage path, and a VERIFIED descriptor for the SAME hash | `MOTION_SOURCE_UNAVAILABLE` |
| The descriptor's producer is this release's own Director | `MOTION_AGENT_MISMATCH` |
| The path can be embedded literally in a concat list (no quotes/newlines/NUL/leading dash/`..`) | `MOTION_SOURCE_PATH_UNSAFE` |
| The bounded operational writer can create the frame list | `MOTION_FRAME_LIST_WRITE_FAILED` |
| `ffmpeg` and `ffprobe` exist on the host | `MOTION_SPAWN_FAILED` (the stage fails; nothing is recorded) |

A failed prerequisite or render is a truthful stage failure: the release
returns to `planned`, the job carries the stable code, and earlier stages stay
recorded. Nothing falls back to the old visual silently.

### What the stage actually renders

- Params are the frozen `MOTION_STAGE_PARAMS` (`sourceFps: 1`, `fps: 24`,
  `frameCount: 24`, `mbSize: 16`, `search: 8`): one second of real
  interpolation from the recorded frame, a bounded reviewable increment.
- The frame list is the validated visual path repeated `frameCount` times at a
  one-second cadence; the worker resamples it with `minterpolate`.
- Assembly consumes the recorded clip as `video_clip` for the planned episode
  duration. A real clip shorter than its slot is **looped**
  (`-stream_loop -1 -t <duration>`) rather than silently truncated; the
  still-image `-loop 1` path is unchanged when motion is off.
- Provenance stays truthful: the artifact records
  `generationMode: "local_interpolation"` (verified local work), never
  `provider_generated`, and `ffprobe_verified` only when the real
  matching-hash inspection promoted the descriptor.

### What this does NOT prove

A 24-frame interpolation of one still is a real, verified local render, but it
is not cinematic motion and does not exercise a remote motion provider. A full
long-form episode rehearsal on a media-capable host (with real runtime and
resource measurements) remains an operator step — see
`docs/media/REAL_MEDIA_ENABLEMENT.md`.

## Real-execution evidence

The real-render test generates two distinct 64×64 frames with real ffmpeg
`lavfi` sources, interpolates them through the production worker with the
real transports (`createNodeMediaTransports`), and asserts the resulting
descriptor reaches `VERIFIED` keyed on the ffprobe-measured bytes. Where
ffmpeg is absent the test skips honestly with a diagnostic — no fake claim
is produced either way (Rule 1).
