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
| `tests/motionAdapter.test.js` | 12 offline contract tests (determinism, bounds, secrets, internal names, UNVERIFIED default). |
| `tests/motionInterpolationWorker.test.js` | 8 tests: argv safety, honest failure matrix (ENOENT → `MOTION_SPAWN_FAILED`, non-zero → `MOTION_CALL_FAILED`, timeout → `MOTION_TIMEOUT`, unreadable output → `INSPECTION_FAILED`), plus ONE real execution test (real ffmpeg + real ffprobe). |

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

## Real-execution evidence

The real-render test generates two distinct 64×64 frames with real ffmpeg
`lavfi` sources, interpolates them through the production worker with the
real transports (`createNodeMediaTransports`), and asserts the resulting
descriptor reaches `VERIFIED` keyed on the ffprobe-measured bytes. Where
ffmpeg is absent the test skips honestly with a diagnostic — no fake claim
is produced either way (Rule 1).
