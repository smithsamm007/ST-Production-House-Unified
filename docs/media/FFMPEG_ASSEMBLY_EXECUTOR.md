# FFmpeg Assembly Executor (Issue #174)

The media-chain continuation from validated plans to actual media
processing. S-M33-01 (assembly plan) validates `media_assembly_plan_v1`
objects and defines the fail-closed main-video runtime gate; S-M30-01
(artifact descriptor) anchors artifact identity to content hashes; the
S-M30 runner (Issue #170) performs real inspections. Until now NO component
executed FFmpeg. This module is the executor boundary:

```
validated plan (media_assembly_plan_v1)
  └── executeAssemblyPlan()
        ├── verifyAssemblyPlanIntegrity() — tamper gate (S-M33-01)
        ├── resolvePlanInputs()           — artifactRefs → descriptor-bound paths
        ├── buildRenderPlan()             — ARRAY ARGS ONLY (CONVENTIONS Rule 2)
        ├── runFfmpeg()                   — injectable spawn, no shell
        ├── inspectMediaFile()            — real bytes → hash + ffprobe (Issue #170)
        └── evaluateMainVideoRuntimeGate() /
            evaluateShortFormDurationGate() — QC duration policy
```

## Safety: references, paths, and array args

- **ArtifactRefs resolve ONLY through descriptors.** The caller supplies a
  map `sha256:<64-hex> → { descriptor, path }`; a ref whose descriptor hash
  does not equal the ref fails closed (`EXEC_DESCRIPTOR_MISMATCH`), and a ref
  with no binding fails closed (`EXEC_REF_UNBOUND`). A plan can never direct
  execution to a raw, un-vetted filesystem location — the plan layer's
  `sha256:`-only regex stays the structural defense; binding is enforced here.
- **Path validation before argv derivation** (both inputs and output):
  non-empty, ≤4096 chars, no NUL, no leading dash (option injection), no `..`
  traversal segments.
- **Array arguments only.** `buildRenderPlan` returns a frozen argv array;
  paths appear as argv values (inputs after their own `-i`, output LAST) and
  are never interpolated into a shell string. The filtergraph uses ffmpeg's
  own `,`/`;` separators, which are inert without a shell.
- **Deterministic builds**: identical plan + bindings produce identical argv.

## Render policy (what the command actually does)

- Visual segments (`video_clip`/`still_image`/`title_card`) form the video
  program: per-segment aspect normalization (`scale`+`pad`+`setsar` per the
  plan's aspectRatio), `concat` across segments; stills enter via `-loop 1`
  with an optional `-t` duration.
- Program audio = concatenated audio-kind segments (`voice`/`bgm`/`sfx`)
  `amix`ed with `audioMix` tracks (`volume=<gainDb>dB`, `normalize=0`).
  Embedded audio of visual segments is intentionally not used.
- Transitions: `cut` → none; `fade`/`dissolve` → real in/out fades of
  `TRANSITION_FADE_SECONDS`; `wipe` → **rendered as a fade with a labeled
  degradation** (`wipe_rendered_as_fade:segment_N`) — honest approximation,
  never silent (Rule 3).
- Ducking: `sidechaincompress` against the first voice source; without one,
  static gain with a labeled degradation.
- Subtitles burned via the `subtitles` filter when video exists; subtitle
  without video is dropped with a labeled degradation.
- Codecs are explicit, never defaults: libx264 + yuv420p (preset/CRF per
  target), AAC at the target bitrate, `+faststart`.

## Honesty matrix (nothing is ever fabricated)

| Condition | Result |
|---|---|
| Plan tampered / id mismatch | `ASSEMBLY_ID_MISMATCH` — no argv is ever derived |
| Plan type wrong | `ASSEMBLY_PLAN_TYPE_MISMATCH` |
| Ref unbound / path hostile | `EXEC_REF_UNBOUND` / `PATH_UNSAFE` / `EXEC_OUTPUT_PATH_UNSAFE` |
| ffprobe/ffmpeg binary absent | `FFPROBE_VERSION_SPAWN_FAILED` at pre-flight — the truthful state of environments without media tooling |
| Timeout | `FFMPEG_TIMEOUT` / `FFPROBE_VERSION_TIMEOUT` |
| Non-zero exit | `FFMPEG_EXIT_NONZERO` (+ exitCode + bounded stderrTail) |
| Rendered file unreadable / probe fails | `QC_DESCRIPTOR_NOT_VERIFIED` (inspection reason surfaced verbatim, e.g. `INSPECTION_SOURCE_UNREADABLE`) |
| Measured duration missing | `QC_INSPECTION_DURATION_MISSING` |
| Claimed vs measured conflict > 1 s | `QC_DURATION_CONFLICT` |
| Duration outside the policy window | `QC_DURATION_OUT_OF_RANGE` |

A success result requires ALL of: real command execution, a real inspection
of the rendered bytes (hash computed from the actual file, ffprobe payload
present), and a passing QC duration gate. The returned descriptor is
`VERIFIED` only through the existing S-M30-01 promotion, anchored to the
REAL rendered content hash — the executor asserts no claimed duration on it.

## QC duration policy (defined and enforced here)

- **`main_longform`** → `main_video_runtime` policy: reuses the S-M33-01
  gate unchanged — descriptor must be VERIFIED by a real matching inspection,
  measured duration must exist, claimed-vs-measured conflict > 1 s fails,
  and the measured duration must lie inside **[1800, 3000] s** (30–50 min).
- **`content_reel_1`, `content_reel_2`, `brand_reel`** →
  `short_form_runtime` policy (new `evaluateShortFormDurationGate`, same
  fail-closed structure) with the reel window **[3, 90] s**.
- The gate consumes the POST-RENDER inspection of the rendered file — never
  a caller's claim — so the policy is evidence-based end to end.

## Injected transports (offline testability)

`spawnImpl` (`{ command, args, timeoutMs }` → `{ exitCode, stdout, stderr,
timedOut }`), `readFileImpl` (file bytes), and the clock are injectable, so
the suite proves the full contract offline — including tamper gates, every
failure code, and the QC matrix — without an ffmpeg binary or real media.
Production binds `node:child_process.spawn` (array args, `shell: false`,
timeout kill, bounded output) and `node:fs/promises`.

## Deliberate non-goals (this slice)

- No worker/queue wiring: callers (the assembly worker slice) invoke
  `executeAssemblyPlan` with descriptor bindings and record the returned
  evidence object through the existing ledger append path.
- No progress streaming or cancellation UI; timeouts are the executor's
  only time bound.
- No xfade cross-fades (they require overlapping inputs and a timeline
  model); fades are self-contained in/out transitions today, with `wipe`
  labeled as degraded.
