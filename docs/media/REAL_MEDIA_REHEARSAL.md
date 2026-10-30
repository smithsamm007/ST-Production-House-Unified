# Real-Media Rehearsal (repeatable, all three episode targets)

> Status: implemented (`npm run real-media-rehearsal`) and **executed with
> evidence in this workspace**: all three Director-configured targets
> (1800 / 2400 / 3000 s) pass the S-M41-01 completeness gate with real bytes.

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

## Executed evidence (2026-10-29/30, this workspace)

| Target | Gate | Coverage ratio | Settled rate | Iterations |
|---|---|---|---|---|
| 1800 s (30 min) | PASS | ≈ 0.997 | 117 wpm setting | 3 (cold start) |
| 2400 s (40 min) | PASS | ≈ 0.998 | 117 | 3 |
| 3000 s (50 min) | PASS | ≈ 0.999 | 117 | 3 |

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
- Rate auto-calibration lives in this runner today; wiring the measured loop
  into the production audio stage is the governed follow-up so scheduled
  episodes land in-window without operator calibration.
