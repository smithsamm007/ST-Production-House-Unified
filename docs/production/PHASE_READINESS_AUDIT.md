# Phase Readiness Audit (Production Foundation → Launch)

> Date: 2026-10-12 · Workspace: Freebuff cloud sandbox (Node v22.23.2,
> ffmpeg/ffprobe 4.4.2, 1 CPU, PostgreSQL client only) · Providers contacted:
> **0** · Uploads performed: **0** · Secrets used: **0**
>
> This audit separates what was **executed and observed** from what remains
> **contract-only** or **owner-gated**. Nothing below is aspirational; each
> claim names the command or artifact that produced it (AGENTS.md Rules 1–3).

## Evidence index

| Command | Result |
|---|---|
| `npm test` (no database configured) | 1257 tests, 1257 pass, 0 fail, 0 skipped (~93 s) |
| `npm test` (live PostgreSQL configured) | **1265 tests**, 1265 pass, 0 fail, 0 skipped — 8 previously dormant live-PostgreSQL subtests activate |
| `npm run migrate` against live PostgreSQL | `MIGRATIONS_COMPLETE appliedCount: 28`; `migrate:status` reports 28/28 `APPLIED` |
| `npm run test:integration` (fresh test DB) | 31 tests, 31 pass, 0 fail |
| `node --test tests/*.integration.js` (all 18 integration files, clean DB) | 73 tests, 73 pass, 0 fail |
| Live server boot (`node server.js`) | `/api/health` → `storage: postgres`, `isDemoStorage: false`; `/api/ready` → **HTTP 200** `{"status":"ready"}` |
| `npm run verify` | exit 0 |
| `npm run lint` | PASSED — 259 JS/ESM files, 28 SQL migrations |
| `npm run plan:check` | `DEVELOPMENT_PLAN_VALID` (11 tasks) |
| `npm run media:smoke` (stages run separately) | real renders + QC evidence in `artifacts/real-media-smoke/*.json` |
| `node scripts/real_provider_episode.mjs --stage=providers` | `PROVIDER_EPISODE_STAGE_PROVIDERS_VERIFIED` — real narration (`espeak-ng`) + real visuals (`pollinations`) both `verified` |
| `node scripts/real_provider_episode.mjs --stage=reels` | `PROVIDER_EPISODE_STAGE_REELS_VERIFIED` — 2 content reels + 1 brand reel assembled from the release's own real artifacts |
| `node --test tests/workerLeaseContention.integration.js` (live PG) | `LEASE_PROOF claimants=8 winners=1 recoveries=1 terminalReclaim=0 idempotencyKeying=unique checkpointResume=durable` |
| `freebuff-deploy check` | `deployable: true`, install `npm install`, build `npm run build`, 0 problems |
| `freebuff-deploy status` | no deployment yet (first deploy is the owner's Deploy button) |

---

## Phase 1 — Production foundation (audit, blockers, provider + job contracts)

### Verified

- **Suite health.** The repository is green: 1257/1257 tests, `verify`, `lint`,
  and `plan:check` all pass on a clean tree (18 of those tests are new: 14
transport, 4 runner-wiring; the executor's mapped-label invariant test was
added alongside the argv fix).
- **Provider contracts (fail-closed).** Observed through the real executors
  (`artifacts/real-media-smoke/provider-capacity.json`):
  - no declared provider capacity → durable wait `WAITING_FOR_QUOTA`
    (`failureCode: QUOTA_EXHAUSTED`, `mediaStatus: unverified`);
  - declared capacity but the binary is absent → `TTS_SPAWN_FAILED` /
    `VISUAL_SPAWN_FAILED` with `mediaStatus: unverified`;
  - a provider "success" is never sufficient on its own: `mediaStatus:
    verified` requires a matching-hash inspection of the real output bytes.
  Provider selection itself (tier order, capability/locator gating) is
  covered by the passing suite (`tests/ttsExecutor.test.js`,
  `tests/visualExecutor.test.js`, `tests/providerRouter.test.js`).
- **Job orchestration.** Durable leases, bounded retries, checkpoints,
  dead-letter/wait re-queue, and Director isolation exist and are covered by
  the passing suite: `src/jobs/lifecycle/jobLifecycle.js`,
  `src/jobs/retry/retryManager.js`, `src/workers/workerRuntime.js`,
  `src/checkpoints/checkpointStore.js`,
  `tests/productionExecutorRunner.test.js` (wait re-queue +
  `WORKER_JOB_WAIT_BUDGET_EXHAUSTED`), `docs/RUNBOOK.md`.

### Blockers found and fixed

| # | Blocker (real, reproducible) | Resolution |
|---|---|---|
| 1 | **No production media transport existed.** Every executor required injected `spawnImpl`/`readFileImpl`; nothing in `src/` supplied them (the only `child_process` use was the linter's `spawnSync`). `STPH_ENABLE_REAL_MEDIA=1` was therefore unreachable — every real stage failed closed with `<STAGE>_SPAWN_FAILED`. | Added `src/media/nodeMediaTransport.js` (14 tests) and bound it via `createRealMediaRunnerFactory` in `src/catalog/server.js` (4 wiring tests), with a real, created media root (`STPH_MEDIA_ROOT`, default `<cwd>/artifacts/media`). |
| 2 | **Invalid ffmpeg argv for narration segments.** `buildRenderPlan` emitted `-map [N:a]`, an undefined filtergraph label. Real ffmpeg aborts: *"Output with label '1:a' does not exist in any defined filter graph"*. This is the exact shape produced by `buildLongformAssemblyPlan` and `reelsStage`, so every real long-form/reel render failed with `FFMPEG_EXIT_NONZERO`. | Audio segments now define a real label (`[N:a]anull[asegN]`); stale test assertion corrected (it encoded the broken argv) and a new invariant test added: *every mapped label must be defined by the filtergraph*. Details: `docs/media/REAL_MEDIA_SMOKE.md`. |

### Closed since the first pass: PostgreSQL runtime

- **Verified against real storage.** A local cluster was bound with **no
  credential at all**: a login role matching the sandbox OS user plus
  `local` `peer` authentication, addressed over the unix socket —
  `DATABASE_URL=postgresql:///stproduction?host=/var/run/postgresql` and
  `POSTGRES_TEST_URL=postgresql:///st_production_test?host=/var/run/postgresql`
  (both set as non-secret configuration in `.env.local`; the app uses
  `stproduction`, the suites use the disposable `st_production_test`).
- All 28 migrations apply cleanly and report `APPLIED`; the full integration
  matrix (all 18 `*.integration.js` files, 73 tests) passes on a freshly
  created database, and the documented `npm run test:integration` (31 tests)
  passes on a clean test database.
- The server boots against that storage with `storage: postgres` and answers
  `GET /api/ready` with **200 ready** and a healthy database probe.
- Version caveat, stated honestly: the sandbox cluster is **PostgreSQL
  14.24** while the engineering contract asks for **15+**. The schema and all
  suites pass here, but 15+ remains the supported target and must be what
  production runs. The integration tests are not idempotent against a database
  that already holds a bootstrapped owner (`OWNER_BOOTSTRAP_ALREADY_COMPLETED`
  by design), which is why they belong on a disposable test database — the
  `POSTGRES_TEST_URL` seam exists for exactly that.

---

## Phase 2 — Real media generation

### Verified with real binaries and real bytes

Covered in full by `docs/media/REAL_MEDIA_SMOKE.md`. Summary:

- long-form assembly: exit 0, ffprobe-measured **1890 s** (inside the
  [1800, 3000] s policy window), `main_video_runtime` QC **passed**,
  descriptor **VERIFIED**, real SHA-256 recorded, 905,917 bytes on disk;
- short-form: three canonical targets (`content_reel_1`, `content_reel_2`,
  `brand_reel`) rendered, measured 30 s each, `short_form_runtime` **passed**,
  descriptors **VERIFIED**;
- negative control: a real 30 s render bound to a long-form plan is honestly
  **rejected** (`QC_DURATION_OUT_OF_RANGE`) with no descriptor promoted;
- transports: real subprocess proof for stdin delivery, literal hostile
  arguments (no shell), non-zero exit, timeout kill, ENOENT, and
  hash-matching file reads.

### Not verified (contract-only)

- **TTS.** `edge-tts`/`piper` absent; no speech generated. Piper additionally
  needs model weights whose licence must be documented first (Rule 12).
- **Visual generation.** `visual-pollinations`/`visual-local` are contract
  command names only; no adapter executable ships in this repository.
- **Worker-driven real media.** `src/catalog/server.js` binds the runner with
  real transports but **no capacity registry** — nothing derives
  `binding.tts.registry` / `binding.visual.registry` from an owner's onboarded
  connections, so the worker records the truthful durable wait. The exact
  seam to close is `bindProductionRunner({ agentId, tts: { registry },
  visual: { registry } })` fed by a governed capacity source
  (`src/catalog/providerCatalog.js` + the Secrets & Connections boundary,
  `sql/022`).

**Phase 2 status: assembly + QC + inspection + transport verified; provider
generation (voice/visual) still contract-only and owner-gated.**

---

## Phase 3 — Autonomous production

### Dormant live-PostgreSQL tests now confirmed running

Wiring `DATABASE_URL` activates 8 subtests that had been silently not running
(all passing): genuinely simultaneous `Promise.all` concurrent-claim on real
PostgreSQL, idempotent job creation in real PG, `migration 010` rerun
idempotency, **reclaims expired leases in real PG**, `renewLease` rejecting
already-expired leases, **respects concurrency limits and concurrent claims**,
**retry limits and dead-lettering in real PG**, and the strict database-level
job-status-transition trigger verification. These are pre-existing repository
tests — they simply needed a database to execute.

### Verified on live PostgreSQL

`tests/workerLeaseContention.integration.js` (now part of
`npm run test:integration`) proves against a real database, not a fake:

- **8 concurrent claimants, exactly 1 winner** on a single job —
  `FOR UPDATE SKIP LOCKED` claiming cannot double-lease, and a claim
  increments the durable attempt counter;
- **lease-expiry recovery**: after a simulated worker loss the expired lease
  is re-claimed by a different worker (no lost job);
- **idempotency-key uniqueness** makes a duplicate enqueue impossible
  (`23505`), so a retried request cannot create a second logical job (Rule 13);
- **database-enforced transitions**: `leased → running → succeeded` succeeds,
  reopening a terminal job is refused by the trigger (Rule 5);
- **checkpoints resume durably** from a restarted store, and a terminal job is
  never re-claimed.
  Observed verdict line: `LEASE_PROOF claimants=8 winners=1 recoveries=1
  terminalReclaim=0 idempotencyKeying=unique checkpointResume=durable`.

### Present and tested

- Opt-in durable worker (`STPH_ENABLE_WORKERS=1`), lease-based claiming,
  bounded concurrency, checkpoints, wait re-queue with retry budget, and
  dead-letter/wait accounting (`src/pipeline/workerLoop.js`,
  `src/pipeline/episodePipeline.js`, `src/jobs/**`, `src/checkpoints/**`).
- Canonical short-form package: two content reels + one brand reel with
  database-enforced one-release-per-slot (Rule 8) and per-reel distinct
  renders (`src/pipeline/reelsStage.js`, `sql/025_reels_stage.sql`).
- Director isolation: `RUNNER_AGENT_MISMATCH` for a wrong-Director
  invocation; per-Director binding carries its own profile/paths.
- All three reel targets and the long-form target really rendered in this
  audit (Phase 2 evidence).

### 2026-10-12: free-first provider capacity wired and VERIFIED

- **TTS provider chosen and configured.** The single local open-source
  emergency slot (Rule 5) is `espeak-ng`: a GPL-3.0 tool with NO model weights
  to license (Rule 12), provisioned by the deployment environment exactly like
  ffmpeg, speaking Hindi + English, narration via stdin. Piper was NOT adopted
  (undocumented ONNX-voice commercial licensing + pip provisioning).
- **Visual generation operational.** `scripts/providers/visual-pollinations.mjs`
  implements the visual executor's tier-1 free primary (keyless HTTPS), bound
  via the new registry `command` + `argvPrefix` adapter invocation.
- **Wired into production.** `createRealMediaRunnerFactory` now binds
  per-Director `espeak-ng` + `pollinations` capacity, so the durable worker
  reaches providers instead of the durable wait.
- **Executed evidence** (`node scripts/real_provider_episode.mjs`, driving the
  production factory for ONE Director): real narration and real visuals both
  `mediaStatus: verified` from real bytes + ffprobe; Director style continuity
  across stages confirmed; the two canonical content Reels and the brand Reel
  REALLY assembled from that release's own narration + visual artifacts with
  short-form QC passing. Details: `BUILD_VERIFICATION.md` (2026-10-12 Phase 3)
  and the git-ignored `artifacts/provider-episode/`.

### Open gates

- **Long-form main video from provider assets**: the 1890 s `main_longform`
  render exceeded this 1-CPU sandbox's bounded command window (a still-image
  program is encoded at 25 fps ≈ 47,000 frames). The assembly executor and the
  `main_video_runtime` QC gate are proven at 1890 s by `npm run media:smoke`;
  what is not yet reproduced here is that specific render on real provider
  stills. A production host needs the throughput, not new code.
- **`edge-tts` free primary** is unreachable from this environment (`403`); the
  local emergency engine carried narration honestly. A host that can reach it
  uses it automatically via the existing chain order. Re-probed 2026-10-14:
  the `edge-tts` binary is now INSTALLED here (uv tools), but the official
  endpoint still refuses the workspace egress
  (`WSServerHandshakeError: 403`, `speech.platform.bing.com`), producing
  0-byte outputs — binary presence is not provider reachability, and the
  honest-unavailable behavior of the frozen chain is confirmed by a live
  attempt.
- `STPH_ENABLE_WORKERS=1` was deliberately **not** left enabled in the running
  dev server, so no worker has yet claimed a job in this workspace; the lease
  semantics above are verified directly against the same repository code.

---

## Phase 4 — Launch readiness

### Present

- Owner-gated publishing adapters behind one `publish()` contract (YouTube,
  Meta, Snapchat, Bilibili) with exact-artifact approval binding, receipt
  honesty, and zero-network idempotent replay; destination router fails closed
  (`PUBLISHER_NOT_WIRED_FOR_DESTINATION` → honest `503
  PUBLISHING_TRANSPORT_UNAVAILABLE`).
- Opaque-secret custody: locators only (`vault://`/`opaque://`), DTO
  allowlists, audit rows without secrets.
- Deployment configuration is ready per `freebuff-deploy check`
  (`npm install` → `npm run build`, 0 problems); no deployment has been
  created yet.

### Verified

- The API boots against real PostgreSQL storage and reports
  `/api/ready` → **200 ready** with `storage: postgres` (no demo fallback), so
  the deployment target and the storage path are exercised, not assumed.
- `.env.local` carries only non-secret configuration (socket URLs, test
  database name). No credential value was created, invented, or stored anywhere.

### Open gates (owner action required)

1. **Media tooling on the production host.** The managed hosting image is
   Node-only and must not run apt/pip steps, so a production worker with
   `STPH_ENABLE_REAL_MEDIA=1` needs `ffmpeg`/`ffprobe` supplied by the
   deployment target (custom worker host/volume), not by the build command.
2. **Credentials.** Live TTS/visual/image providers, YouTube/Meta/Snapchat/
   Bilibili OAuth, Vault-style secret manager, SMTP — all still unconfigured
   by design (Rule 16). The owner must provision locators before any live
   call.
3. **PostgreSQL.** Production durability (leases, checkpoints, receipts,
   analytics) requires a provisioned database and applied migrations.
4. **First deployment** is the owner's Deploy button; after that,
   `freebuff-deploy start` can redeploy.

---

## Recommended next increments (in dependency order)

1. ~~Configure `DATABASE_URL`, migrate, and run the integration suite.~~ Done:
   28/28 migrations `APPLIED`, integration matrix 73/73, `/api/ready` 200.
   Remaining sub-item: run against PostgreSQL **15+** (this sandbox has 14.24).
2. ~~Wire a governed provider-capacity source into
   `bindProductionRunner` (from the Secrets & Connections boundary) so the
   worker can reach real TTS/visual stages once binaries exist.~~ Done
   (2026-10-14): `createRealMediaRunnerFactory` now accepts an injected
   async `capacitySource({ agentId })` that pushes validated quota state to
   the keyless free-first chain at binding time; the seam is keyless-only,
   `quotaExhausted`-boolean-only, fail-closed on malformed input
   (`RUNNER_CAPACITY_INVALID`), and covered by the capacity tests in
   `tests/realMediaRunnerWiring.test.js`. Connecting a concrete deployment
   source (quota metadata from Secrets & Connections) remains the operator's
   wiring choice; owner-gated credentials are unchanged.
3. Install a real TTS provider adapter (`edge-tts`) and a documented visual
   adapter, then re-run `npm run media:smoke` to convert Phase 2's
   contract-only rows into executed ones.
4. Provision production media tooling + credentials, then run the first
   owner-approved private upload as the publishing end-to-end test.
