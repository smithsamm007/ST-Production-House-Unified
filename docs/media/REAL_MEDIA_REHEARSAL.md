# Real-Media Rehearsal (repeatable, all three episode targets)

> Status: implemented (`npm run real-media-rehearsal`). The runner executes real
> binaries, but **no CI run has yet retained a passing artifact**. Cloud runs
> `43921087702` and `44066920506` both failed the delivered-file audio QC, and
> the sanitized bundle was honestly skipped in each. Any number in this document
> without an artifact name beside it is an author-local measurement from a
> media-capable workspace — not independently inspectable evidence.

## What one run proves

```bash
node scripts/real_media_rehearsal.mjs --target=1800   # or 2400 / 3000; default writes evidence under artifacts/rehearsal/<target>/
npm run real-media-rehearsal                          # omit --target for the documented 2400 s default
```

Chain, with REAL binaries at every step:

| Step | Tool | Honesty label |
|---|---|---|
| Narration script | `src/pipeline/narrationScript.js` (1800/2400/3000 s) | `generationMode: deterministic_local`, `editorialStatus: deterministic_planning_text` |
| Speech synthesis | **espeak-ng** — the local open-source emergency slot; zero credentials | real audio; rate auto-calibrated against real measurements |
| Assembly | **ffmpeg** (libx264 veryfast crf20, aac 128k, 16:9) | real rendered bytes; the visual is a LABELLED flat-colour placeholder, never story footage |
| Inspection | **ffprobe** on the rendered file | real measured per-stream durations |
| Gate | `evaluateEpisodeCompleteness` (S-M41-01) | the ONLY authority on whether the render is a complete episode |
| Evidence | `artifacts/rehearsal/<target>/rehearsal-evidence.json` | git-ignored: evidence is produced by running tools, never committed as a claim |
| CI evidence | `Rehearsal Evidence` workflow → artifact `rehearsal-evidence-<target>` (Issue #264) | sanitized bundle only; the raw record stays git-ignored |

## Rate auto-calibration (measured, not assumed)

Speech duration is a function of the synthesis rate; no fixed constant is
trusted. The runner starts at the provider's own default, measures with real
ffprobe, and — while the audio sits outside the completeness gate's window
`[target − tolerance, target + 1]` — multiplies the rate by measure/target
(bounded to 4 attempts). On this workspace, from a cold start:

```
175 wpm → 1173 s measured vs 1800 s target   (why calibration is needed)
 114 wpm → ~1850 s                            (iterate 2)
 117 wpm → 1795 s / 2395 s / 2993 s           (settled: in-window for ALL targets)
```

Because every script is word-sized for the same planning density, one settled
rate covers 30, 40 and 50 minutes; each settling measurement is always fresh.

## Reported local measurements (2026-10-29/30, NOT artifact-backed)

These are the author's local runs in a media-capable workspace. They are
reported here as claims to be re-verified by a retained artifact, not as
inspected evidence: the raw evidence JSON is git-ignored, so nothing in this
table can be re-checked from the repository.

| Target | Gate (local claim) | Coverage ratio | Settled rate | Iterations |
|---|---|---|---|---|
| 1800 s (30 min) | PASS | ≈ 0.997 | 117 wpm setting | 3 (cold start) |
| 2400 s (40 min) | PASS | ≈ 0.998 | 117 | 3 |
| 3000 s (50 min) | PASS | ≈ 0.999 | 117 | 3 |

## Delivered-file audio QC (measured on the runner)

The completeness gate is fed the measurement of the **encoded, muxed file**,
never the intermediate WAV. Two cloud runs show why that distinction matters:

| Run | Delivered measurement | Gate result |
|---|---|---|
| `43921087702` | true peak **+2.04 dBTP**, −15.91 LUFS, clipping 1 | `QC_AUDIO_CLIPPING_DETECTED` |
| `44066920506` | after −4.74 dB broadband gain: **−2.29 dBTP**, then **−21.06 LUFS** | `QC_LOUDNESS_OUT_OF_RANGE` |

Peak and loudness are jointly reachable only by reducing crest factor. The
corrective pass therefore normalizes dynamically, iterates the peak ceiling
from each encoded file's own true peak, records every round, and fails with the
measured numbers when a target cannot be reached. No QC limit is relaxed: the
published ceiling stays −1.0 dBTP and the delivery target stays −2.5 dBTP at
−14 LUFS.

## Artifact contract (Issue #264)

`Rehearsal Evidence` uploads the sanitized bundle as
`rehearsal-evidence-<target>` (30-day retention) only when the run produced
real evidence; otherwise it reports `EVIDENCE_SKIPPED_NO_EVIDENCE` and uploads
nothing. A passing claim about this runner is valid only for a run whose
artifact can be opened and read.

Long-form assembly/QC was additionally verified by
`npm run media:smoke --stage=all` (real): genuine 1890 s render
(`descriptorVerificationState: VERIFIED`), three genuinely distinct real
renders for the canonical reels, and a negative render correctly rejected
with `QC_DURATION_OUT_OF_RANGE`.

## Honest limits

- The placeholder visual and the planning narration prove the **pipeline**
  (assembly, inspection, coverage, QC) — never editorial quality or provider
  receipts. Nothing is published; the owner approval gate (Rule 7) is untouched.
- `ffmpeg`, `ffprobe` and `espeak-ng` must exist on the host; a missing binary
  fails with `REHEARSAL_DEPENDENCY_MISSING` instead of being skipped silently.
- Rate auto-calibration is not runner-only: the production executor carries the
  measured audio-rate calibration loop (Issue #257,
  `src/pipeline/productionExecutorRunner.js`), and this runner drives the same
  measured approach for rehearsal evidence. An earlier revision of this
  document described the production wiring as a pending follow-up; that was
  out of date and is corrected here (Issue #264).
