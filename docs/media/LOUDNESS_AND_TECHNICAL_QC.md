# Measured Loudness & Technical Conformance (Issue #263)

> Status: implemented contracts (`src/media/loudnessMeasurement.js`,
> `src/media/technicalConformance.js`) and wired into the rehearsal runner.
> **No new real-media run is claimed by this document.** Every number in a
> rehearsal evidence file comes from FFmpeg/FFprobe stderr for the bytes on
> disk in that run.

## What was not measured before

The rehearsal rendered H.264/AAC and the S-M41-01 gate checked stream presence
and measured audio coverage. It did not apply `loudnorm`, and it did not parse
loudness, true peak, clipping, sample rate or frame rate. Any statement like
“exactly −14 LUFS / 60 fps / 48 kHz” was therefore **not evidence-backed** by
this repository; only the coverage ratio was.

## Loudness and clipping (measured)

| Measured value | FFmpeg source | Meaning |
|---|---|---|
| `integratedLufs` | `ebur128=peak=true` → `I:` in the last summary | integrated programme loudness |
| `loudnessRangeLu` | `ebur128` → `LRA:` | loudness range |
| `truePeakDbtp` | `ebur128` → `Peak:` (dBFS true peak) | inter-sample peak |
| `thresholdLufs` | `ebur128` → `Threshold:` | gating threshold (needed by loudnorm pass 2) |
| `peakLevelDbfs` | `astats` → `Peak level dB` (Overall) | sample peak |
| `peakLevelSampleCount` | `astats` → `Peak count` (Overall) | samples at that peak |
| `clippedSampleCount` | derived | the peak sample count when the sample peak reaches full scale (≥ 0 dBFS), else 0 |
| `clippingBasis` | constant label | `astats_peak_level_and_peak_sample_count` — so the count is never mistaken for a different measurement |

House target (`HOUSE_LOUDNESS_TARGET`): integrated **−14 LUFS ± 1 LU**, true
peak **≤ −1 dBTP**, **0** clipped samples. Silence (`-inf`) is reported as
`null` with `LOUDNESS_UNMEASURABLE`, never coerced to a finite value.

## Normalization (real, two-pass, gated on re-measurement)

`normalizeLoudness()` remuxes the artifact (`-c:v copy`) and applies:

```
loudnorm=I=-14:TP=-1:LRA=11:measured_I=…:measured_TP=…:measured_LRA=…:measured_thresh=…:offset=0:linear=true
```

The measured input values are required: a missing/incomplete measurement throws
`LOUDNESS_NORMALIZATION_INVALID` rather than guessing. The runner then
**re-measures the normalized file** and only that measurement may pass the
conformance gate. If either the raw or the normalized measurement is
unmeasurable, the rehearsal fails — it never records a pass it did not measure.

## Technical conformance (measured)

`evaluateTechnicalConformance({ inspection, profile })` reads the artifact's own
FFprobe record:

| Profile | Resolution | Min frame rate | Audio sample rate | Delivery? |
|---|---|---|---|---|
| `long_form_1080p` | 1920×1080 | 24 | 48 000 Hz | yes |
| `vertical_9_16` | 1080×1920 | 24 | 48 000 Hz | yes |
| `placeholder_rehearsal` | 1920×1080 | 1 | 48 000 Hz | **no** (labelled placeholder) |

Frame rate is parsed from `avg_frame_rate` (falling back to `r_frame_rate`),
including rational values such as `30000/1001`. Codec names are recorded and a
missing codec name fails closed. The rehearsal's colour plate declares the
`placeholder_rehearsal` profile, so a 2 fps placeholder can never be presented
as the 24+ fps delivery profile (Rule 3).

The canonical package's brand promo Reel is **9:16**; the smoke runner's
`brand_reel` plan now uses that aspect ratio (it was 1:1).

## Fail-closed matrix

| Condition | Code |
|---|---|
| No parseable ebur128 summary | `LOUDNESS_UNMEASURABLE` |
| `ffmpeg` absent (ENOENT) | `LOUDNESS_SPAWN_FAILED` |
| Analysis killed by timeout | `LOUDNESS_TIMEOUT` |
| Non-zero analysis exit | `LOUDNESS_ANALYSIS_FAILED` |
| Integrated outside ±1 LU | `LOUDNESS_INTEGRATED_OUT_OF_RANGE` |
| True peak above −1 dBTP | `LOUDNESS_TRUE_PEAK_EXCEEDED` |
| Any clipped sample | `LOUDNESS_CLIPPING_DETECTED` |
| Resolution differs from profile | `TECH_RESOLUTION_MISMATCH` |
| Frame rate unmeasurable / below profile | `TECH_FRAME_RATE_UNMEASURABLE` / `TECH_FRAME_RATE_BELOW_MINIMUM` |
| Sample rate differs from profile | `TECH_SAMPLE_RATE_MISMATCH` |
| Codec name absent | `TECH_CODEC_UNMEASURABLE` |

## Honest limits

- **No real-media run is claimed here.** This worktree has no `ffmpeg`/
  `ffprobe`/`espeak-ng`, so the rehearsal could not be executed; the offline
  suite proves the parsers, argv builders, verdicts and fail-closed paths
  against real-shaped FFmpeg output, not a render.
- `clippedSampleCount` is the `astats` peak sample count at full scale. It is a
  real measured count with a stated basis, not a sample-accurate limiter audit.
- Loudness normalization currently lives in the rehearsal runner. Wiring the
  same measured pass into the production assembly stage is a separate,
  governed change.
- The rehearsal's placeholder visual stays 2 fps and `delivery: false`; it
  exercises the pipeline, never editorial output.
