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
   - Tier 4 `espeak-ng` (local open-source emergency provider, authType
     `none`, narration text via stdin, voice via `-v`, WAV output via `-w`).
     Chosen over piper because it needs no model weights to license (Rule 12)
     and no Python/pip provisioning (see `docs/media/TTS_EXECUTOR.md`).
   - No paid provider is ever auto-selected (Rule 35).
3. **Visual provider capacity** (owner-gated): without a declared provider
   registry entry the visual stage returns the truthful wait state and the
   job re-queues.

## Honest outcome matrix (what job states mean)

| Outcome in logs/artifacts | Meaning | Operator action |
|---|---|---|
| `WAITING_FOR_QUOTA` (re-queued) | No provider remained for a needed stage | Install/provision the missing provider; job resumes automatically |
| `PROVIDER_UNAVAILABLE` | No provider slot could serve the request (selection layer: unregistered slot, undeclared capabilities, or no binary at all) | Install/provision the provider, verify `which <binary>` |
| `TTS_SPAWN_FAILED` / `VISUAL_SPAWN_FAILED` / `FFMPEG_SPAWN_FAILED` / `FFPROBE_VERSION_SPAWN_FAILED` | The executor reached a real spawn and the binary could not start (typically `ENOENT`), or the transport refused the request shape | Install the binary (`which ffmpeg ffprobe edge-tts espeak-ng`); these are the executor-layer spellings of "provider unavailable" — verified in `artifacts/real-media-smoke/provider-capacity.json` |
| `CREDENTIAL_MISSING` | A non-`none` authType provider lacks a locator | Owner adds the credential via Secrets & Connections (stored only as `vault://`/`opaque://` locator) |
| `QC_DURATION_*` fail | Rendered duration outside policy window (short-form [3,90] s / longform [1800,3000] s) | The render is real but fails the gate; adjust plan durations |
| `RUNNER_AGENT_MISMATCH` | Job routed to the wrong Director's runner | Tenancy bug — stop and investigate; never shared state |
| `mediaStatus:"verified"` + `ffprobe_verified:true` | Real bytes hashed + probed + descriptor promoted | Success — only this proves media exists |

An exit-0 provider call alone is NOT success. `mediaStatus` derives only from
a matching-hash inspection of the actual file bytes (S-M30-01 / #170).

## Production transports and media root

The executors never spawn or read files themselves: they require injected
`spawnImpl` / `readFileImpl`. Production now binds
`src/media/nodeMediaTransport.js` (array args, `shell:false`, bounded capture,
real timeout kill, real bytes for hashing) in the `STPH_ENABLE_REAL_MEDIA=1`
factory inside `src/catalog/server.js`. Output roots default to
`<cwd>/artifacts/media` and are created at boot; set `STPH_MEDIA_ROOT` to
place them elsewhere (e.g. a mounted volume).

## Verification commands

```bash
which ffmpeg ffprobe espeak-ng edge-tts   # capacity check
node scripts/real_provider_episode.mjs --stage=providers   # real provider evidence
npm test                              # includes productionExecutorRunner tests
npm run media:smoke                   # REAL render + QC evidence (see docs/media/REAL_MEDIA_SMOKE.md)
curl -s localhost:3000/api/health     # storage !== "demo"
```

Real-media evidence from an executed smoke run — including the ffmpeg argv
defect it exposed and the honest TTS/visual gaps — is recorded in
`docs/media/REAL_MEDIA_SMOKE.md`.

### Governed provider-capacity seam

`createRealMediaRunnerFactory` accepts an optional async
`capacitySource({ agentId })` so a deployment can push VALIDATED quota state
from Secrets & Connections into provider selection at binding time:

- Only the frozen keyless free-first chain ids may be touched
  (`edge-tts`, `espeak-ng`, `pollinations`, `local-sd`); unknown ids are
  ignored, never invented.
- The ONLY honored field is `quotaExhausted: boolean` — the selector skips an
  exhausted free provider honestly and falls through the frozen chain; no
  declared capability can be forged and no credential material can cross the
  seam (unknown fields fail closed with `RUNNER_CAPACITY_INVALID`).
- A source that cannot resolve must throw/return a malformed snapshot: the
  binding fails loudly at startup, never silently without capacity.
- `STPH_ENABLE_REAL_MEDIA` bindings without a `capacitySource` behave exactly
  as before (keyless defaults, truthful durable waits).
- Worker wiring (`src/pipeline/workerLoop.js`) awaits both sync and async
  factories, so this is backward-compatible.

Artifacts land in the canonical `artifacts` table with real SHA-256 hashes;
evidence rows append to the ledger. Nothing is ever fabricated on any path.
