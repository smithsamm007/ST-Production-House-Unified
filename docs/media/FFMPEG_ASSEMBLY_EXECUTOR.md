# FFmpeg Assembly Executor (Issue #174, #243, #263)

The media-chain continuation from validated plans to actual media
processing. S-M33-01 (assembly plan) validates `media_assembly_plan_v1`
objects and defines the fail-closed main-video runtime gate; S-M30-01
(artifact descriptor) anchors artifact identity to content hashes; the
S-M30 runner (Issue #170) performs real inspections. This module is the
executor boundary:

```
validated plan (media_assembly_plan_v1)
  └── executeAssemblyPlan()
        ├── verifyAssemblyPlanIntegrity() — tamper gate (S-M33-01)
        ├── resolvePlanInputs()           — artifactRefs → descriptor-bound paths
        ├── buildRenderPlan()             — ARRAY ARGS ONLY (CONVENTIONS Rule 2)
        ├── runFfmpeg()                   — injectable spawn, no shell
        ├── inspectMediaFile()            — real bytes → hash + ffprobe (Issue #170)
        ├── evaluateMainVideoRuntimeGate() /
        │   evaluateShortFormDurationGate() — QC duration policy
        └── evaluateEpisodeCompleteness()  — required streams + measured
                                             audio coverage + technical
                                             conformance (S-M41-01, S-M43-01)
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
  plan's aspectRatio), `concat` across segments; stills enter via `-framerate 1
  -loop 1` with an optional `-t` duration — real time mapping, so a
  duration-second still is exactly that many frames at 1 fps instead of
  ffmpeg's default 25×duration duplicated frames (same content and measured
  duration; bounded CPU budget for full-length renders).
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
| ffprobe/ffmpeg binary absent | `FFPROBE_VERSION_SPAWN_FAILED` at pre-flight — truthful state of environments without media tooling |
| Timeout | `FFMPEG_TIMEOUT` / `FFPROBE_VERSION_TIMEOUT` |
| Non-zero exit | `FFMPEG_EXIT_NONZERO` (+ exitCode + bounded stderrTail) |
| Rendered file unreadable / probe fails | `QC_DESCRIPTOR_NOT_VERIFIED` (inspection reason surfaced verbatim, e.g. `INSPECTION_SOURCE_UNREADABLE`) |
| Measured duration missing | `QC_INSPECTION_DURATION_MISSING` |
| Claimed vs measured conflict > 1 s | `QC_DURATION_CONFLICT` |
| Duration outside the policy window | `QC_DURATION_OUT_OF_RANGE` |
| Required stream absent | `QC_STREAM_MISSING_VIDEO` / `QC_STREAM_MISSING_AUDIO` |
| Per-stream duration absent | `QC_STREAM_DURATION_MISSING` |
| Audio does not cover the program | `QC_AUDIO_COVERAGE_INSUFFICIENT` |
| Audio runs past the picture | `QC_AUDIO_EXTENDS_BEYOND_VIDEO` |
| Video resolution / aspect ratio mismatch | `QC_RESOLUTION_MISMATCH` |
| Audio sample rate not 48 kHz (or mismatch) | `QC_SAMPLE_RATE_INVALID` |
| Video frame rate below minimum | `QC_FRAME_RATE_INVALID` |
| Loudness outside target [-16, -12] LUFS or true peak > -1.0 dBTP | `QC_LOUDNESS_OUT_OF_RANGE` |
| Audio clipping detected (> 0 dBTP) | `QC_AUDIO_CLIPPING_DETECTED` |

A success result requires ALL of: real command execution, a real inspection
of the rendered bytes (hash computed from the actual file, ffprobe payload
present), a passing QC duration gate, and a passing completeness & technical
conformance gate. The returned descriptor is `VERIFIED` only through the existing
S-M30-01 promotion, anchored to the REAL rendered content hash — the executor
asserts no claimed duration on it.

## QC duration policy (defined and enforced here)

- **`main_longform`** → `main_video_runtime` policy: reuses the S-M33-01
  gate unchanged — descriptor must be VERIFIED by a real matching inspection,
  measured duration must exist, claimed-vs-measured conflict > 1 s fails,
  and the measured duration must lie inside **[1800, 3000] s** (30–50 min).
- **`content_reel_1`, `content_reel_2`, `brand_reel`** →
  `short_form_runtime` policy (fail-closed structure) with the reel window **[3, 90] s**.
- The gate consumes the POST-RENDER inspection of the rendered file — never
  a caller's claim — so the policy is evidence-based end to end.

## Episode completeness & technical conformance gate (S-M41-01, S-M43-01)

Duration alone does not make an episode. `src/media/episodeCompleteness.js`
evaluates the SAME post-render inspection and must pass before a render is
recorded:

| Check | Rule |
|---|---|
| Required streams | both `video` and `audio` streams present in the probe |
| Measured durations | per-stream `duration` present and parseable; no default pass |
| Audio coverage | `audioSeconds + tolerance >= referenceSeconds`; reference is configured main target when supplied, otherwise measured video duration |
| A/V sync | `audioSeconds <= videoSeconds + 1 s` (an audio tail with no picture is a broken render) |
| Coverage Tolerance | `min(15 s, max(1 s, 0.5 % of the reference))` — a 30-minute program may end at most 9 s before its planned length; a 6 s Reel gets a 1 s allowance |
| Resolution / Geometry | Main longform must be 1920x1080 (16:9); standalone brand Reel and content Shorts must be 1080x1920 (9:16) |
| Audio Sample Rate | Verified as 48 kHz (48000 Hz) |
| Loudness & True Peak | Post-render loudnorm analysis measured against -14.0 LUFS target (±2.0 LUFS tolerance window) and true peak ≤ -1.0 dBTP |
| Zero Clipping | clippingCount must equal 0 (true peak must not exceed 0.0 dBTP) |

The QC record carries the measured evidence (`qc.completeness.videoSeconds`,
`audioSeconds`, `referenceSeconds`, `coverageToleranceSeconds`,
`audioCoverageRatio`, `technical`, `reasonCode`), so a rejection states
truthfully what failed.

## Rehearsal & Smoke evidence runner

- `scripts/real_media_smoke.mjs`:
  Verifies the canonical 1+2+1 package (1 long-form 16:9 1920x1080 + 2 content Shorts 9:16 1080x1920 + 1 brand promo Reel 9:16 1080x1920).
- `scripts/real_media_rehearsal.mjs`:
  Executes real speech synthesis rate auto-calibration, a real loudness normalization pass (`-af loudnorm=I=-14:TP=-1.0:LRA=7 -ar 48000`), real 1920x1080 long-form assembly, real 9:16 1080x1920 brand Reel assembly, real ffprobe inspection, real loudness analysis (integrated LUFS, true peak dBTP, clipping count), and records measured evidence in `artifacts/rehearsal/`. Visual placeholders are explicitly labeled as placeholders per AGENTS.md Rule 3.
