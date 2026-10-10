# Real Media Enablement (Issue #187 operator guide)

How to switch the production worker from deterministic plan artifacts to the
REAL media executor chain (TTS → visual → FFmpeg assembly → QC), and what
each outcome honestly means.

## The enablement flag stack

| Flag | Effect | Without it |
|---|---|---|
| `STPH_ENABLE_WORKERS=1` | Starts the durable `ProductionWorkerLoop` (lease-claimed `episode_production` jobs, bounded concurrency) | Server starts but no jobs ever run |
| `STPH_ENABLE_REAL_MEDIA=1` | Worker claims route through the **real executor runner** (`src/pipeline/productionExecutorRunner.js`) instead of the deterministic pipeline | Only deterministic (plan-level) artifacts are produced — `mediaStatus: not_generated` |

Wiring lives in `src/catalog/server.js` (see `STPH_ENABLE_REAL_MEDIA` gate):
when the flag is on, each claimed job runs through a per-Director runner
binding (`bindProductionRunner`); any invocation for a different Director
fails closed with `RUNNER_AGENT_MISMATCH`.

## What the real chain needs on the host

1. **`ffmpeg` and `ffprobe` on PATH** — executors spawn array-arg processes
   (no shell). Missing binaries produce honest `PROVIDER_UNAVAILABLE` /
   inspection failure codes, never fabricated success.
2. **A TTS provider** from the free-first chain (`src/media/ttsExecutor.js`):
   - Tier 1 `edge-tts` (free network provider, authType `none`), or
   - Tier 4 `piper` (local open-source emergency provider, authType `none`,
     narration text via stdin, model path via `--model`, output via
     `--output_file`).
   - No paid provider is ever auto-selected (Rule 35).
3. **Visual provider capacity** (owner-gated): without a declared provider
   registry entry the visual stage returns the truthful wait state and the
   job re-queues.

## Honest outcome matrix (what job states mean)

| Outcome in logs/artifacts | Meaning | Operator action |
|---|---|---|
| `WAITING_FOR_QUOTA` (re-queued) | No provider remained for a needed stage | Install/provision the missing provider; job resumes automatically |
| `PROVIDER_UNAVAILABLE` | Binary absent or spawn failed | Install the binary (ffmpeg/piper/edge-tts), verify `which <binary>` |
| `CREDENTIAL_MISSING` | A non-`none` authType provider lacks a locator | Owner adds the credential via Secrets & Connections (stored only as `vault://`/`opaque://` locator) |
| `QC_DURATION_*` fail | Rendered duration outside policy window (short-form [3,90] s / longform [1800,3000] s) | The render is real but fails the gate; adjust plan durations |
| `RUNNER_AGENT_MISMATCH` | Job routed to the wrong Director's runner | Tenancy bug — stop and investigate; never shared state |
| `mediaStatus:"verified"` + `ffprobe_verified:true` | Real bytes hashed + probed + descriptor promoted | Success — only this proves media exists |

An exit-0 provider call alone is NOT success. `mediaStatus` derives only from
a matching-hash inspection of the actual file bytes (S-M30-01 / #170).

## Verification commands

```bash
which ffmpeg ffprobe piper edge-tts   # capacity check
npm test                              # includes productionExecutorRunner tests
curl -s localhost:3000/api/health     # storage !== "demo"
```

Artifacts land in the canonical `artifacts` table with real SHA-256 hashes;
evidence rows append to the ledger. Nothing is ever fabricated on any path.
