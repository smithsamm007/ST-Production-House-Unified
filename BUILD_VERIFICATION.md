# Build Verification

Date: 2026-07-29  
Environment: local scratch workspace  
Live providers contacted: none  
Publishing actions performed: none  
Secrets used: none

## Branch Synchronization Info

- Final PR Head SHA: recorded on final commit push
- Origin/Main SHA: 57f9ae8fc6b0523cce460c4e64127477c47be938
- Merge-Base SHA: 5136ea0d44164a9255a2c823d46d893e8af13ec9
- Ahead By: 5 commits (locally updated)
- Behind By: 2 commits (stale remote fetch, reported STALE_REMOTE_CHECKOUT)

## Result

- JavaScript syntax checks: passed
- Test files: 9
- Unit Tests: 113 passed, 0 failed, 0 skipped
- Task 8 unit-tests count: 32 passed (exactly present in `tests/ownerAgentCommunicationStudio.test.js`)
- Task 9 unit-tests count: 35 passed (exactly present in `tests/ownerAuthentication.test.js`)
- PostgreSQL integration-test count: 0 (POSTGRESQL_RUNTIME_NOT_VERIFIED)
- PostgreSQL runtime status: POSTGRESQL_RUNTIME_NOT_VERIFIED
- Duration reported by Node test runner: 638.822977 ms
- Verified source commit: recorded on final commit push
- Included main commit: 57f9ae8fc6b0523cce460c4e64127477c47be938
- GitHub Actions run: Run #18
- GitHub Actions conclusion: success

## Verified policies

- Canonical 20-agent preload and 50-agent cap.
- Cross-agent credential access rejection.
- Sequential three-provider fallback to a keyless local emergency provider.
- Provider success evidence requirements.
- Product/service identity normalization.
- Owner permission for duplicate campaigns.
- One standalone Reel per normalized product/service.
- Independent, explicit main-video promotion.
- Affiliate HTTPS, disclosure, and domain allowlist requirements.
- Rejection of fabricated publishing receipts.
- Dry-run publishing without fake platform IDs or URLs.
- **Agent Digital Identity and Account Isolation (Task 6)**:
  - Supported platforms: youtube, instagram, facebook, snapchat.
  - Safe dashboard DTO/allowlist serialization (zero credentials or secret locator leakages).
  - Public attribution strictly rejects internal agent names (JARVIS, LAKME, VEDA).
- **Agent Creative Charter and Channel Universe System (Task 7)**:
  - Additive migrations for creative universes, charters, assignments, entities, claim classifications, and approvals.
  - JARVIS initial active Hindi/Hinglish connected horror cinematic universe charter vision.
  - LAKME initial active Hindu Mythology universe charter vision (Samay as narrator, claim safety classifications).
  - LAKME lazy hierarchy resolving node paths dynamically without database row explosion.
  - Immutable version snapshots, dynamic approval SHA-256 hash checks, and duplicate activation block rules.
- **Niche Reference and Visual Reference Library (Correction Upgrade)**:
  - Additive migrations for creative_references, niche/visual profiles, scope assignments, and approval references.
  - YouTube allowlist verification and unsafe URL parsing blocks (rejections of non-standard ports, credentials, localhost, private IPs, unapproved domains).
  - Canonicalization of equivalent YouTube URLs to detect and prevent duplicates.
  - Manual profiles requiring owner approval bound to SHA-256 hashes.
  - Verification that niche characteristics do not alter visuals, and visual characteristics do not alter story or narration.
  - Verification of recursive secret/credential removal.
- **Owner-Agent Communication Studio and Blueprinting (Task 8)**:
  - Additive migrations for communication sessions, messages, drafts, versions, decisions, suggestions, unresolved questions, validation results, and owner approvals.
  - Exactly 22 specific Interactive Interview Catalog sections.
  - Zero-trust message sender authentication and message matrix structure.
  - Optimistic concurrency control via revision counts and stale write checks.
  - Automated 22-section validation and brand safety scanning (blocking words 'unsafe' or 'unfiltered').
  - Active question session locks (only one active interview question at a time per session).
  - Version comparison tool highlighting diffs between blueprint version snapshots.
  - Previews of sanitized worker contexts (stripping secrets).
  - Immutable Owner approvals that permanently lock the blueprint and deactivate draft edits.
  - Absolute scope-binding trigger constraints preventing mismatched owner/agent/universe fields.
  - Transaction-safe advisory locking and uniqueness index over (owner, agent, universe) scope to prevent duplicate active approved blueprint versions.
- **Owner Authentication and Secure Sessions (Task 9)**:
  - Additive migration for owner authentication, sessions, TOTP MFA, recovery codes, passkey WebAuthn challenge contracts, CSRF session tokens, and security audits.
  - Configurable password validation strength and generic auth failure lockouts.
  - Cryptographically random session tokens with persistent SHA-256 hashing.
  - Fixation prevention via login and MFA completion session rotation.
  - Multi-tier states (anonymous, mfa_pending, authenticated, locked, disabled, expired, revoked).
  - Server-authoritative session identity mapping for all mutation routes.
  - Safe audit events scrubbing sensitive fields recursively.

---

# 2026-10-12 Verification Run (Phase 1 → Phase 3 evidence)

Environment: Freebuff cloud sandbox · Node v22.23.2 · ffmpeg/ffprobe 4.4.2
(installed with apt for this run) · PostgreSQL 14.24 local cluster · 1 CPU
Live providers contacted: none · Uploads performed: none · Credentials created: none

## Commands and results

- `npm test` — 1257 tests, 1257 passed, 0 failed, 0 skipped without a database;
  **1265 passed** with live PostgreSQL configured, because 8 dormant live-PG
  subtests activate (concurrent claims, expired-lease reclaim, lease renewal,
  retry limits + dead-lettering, idempotent job creation, migration 010
  idempotency, status-transition trigger).
- `npm run verify` — passed (syntax checks for entrypoint + catalog modules).
- `npm run lint` — PASSED (259 JS/ESM files, 28 SQL migrations, contract rules clean).
- `npm run plan:check` — `DEVELOPMENT_PLAN_VALID`, 11 tasks.
- `npm run migrate` — `MIGRATIONS_COMPLETE appliedCount: 28`; status 28/28 `APPLIED`.
- `npm run test:integration` — 31 tests, 31 passed, 0 failed (fresh test database).
- `node --test --test-concurrency=1 tests/*.integration.js` — 73 tests, 73 passed, 0 failed.
- Live server: `/api/health` → `storage: postgres`, `isDemoStorage: false`;
  `/api/ready` → HTTP 200 `{"status":"ready"}`.
- `npm run media:smoke` (stages run separately; real renders, no providers):
  long-form assembly exit 0, ffprobe-measured 1890 s inside the [1800, 3000] s
  window, `main_video_runtime` QC passed, descriptor VERIFIED (sha256
  `404970241788158568a95b74a7544bb1c50fb5f719655b9aed8b506391e51c18`, 905,917
  bytes); three canonical short-form targets rendered at 30 s each with the
  `short_form_runtime` gate passed; negative control (real 30 s render on a
  long-form plan) honestly rejected with `QC_DURATION_OUT_OF_RANGE`.
- Durable-queue proof on live PostgreSQL (`tests/workerLeaseContention.integration.js`):
  `LEASE_PROOF claimants=8 winners=1 recoveries=1 terminalReclaim=0
  idempotencyKeying=unique checkpointResume=durable`.

## Defects found and fixed in this run

1. **No production media transport existed** — every executor required an
   injected `spawnImpl`/`readFileImpl` and nothing in `src/` supplied them, so
   `STPH_ENABLE_REAL_MEDIA=1` failed closed with `<STAGE>_SPAWN_FAILED` at
   every real stage. Fixed by `src/media/nodeMediaTransport.js` plus
   `createRealMediaRunnerFactory` wiring in `src/catalog/server.js`.
2. **Invalid ffmpeg argv for narration segments** — `buildRenderPlan` emitted
   `-map [N:a]`, an undefined filtergraph label; real ffmpeg aborts with
   *"Output with label '1:a' does not exist in any defined filter graph"*.
   Fixed by defining a real `[N:a]anull[asegN]` label, with the stale
   assertion corrected and a new mapped-label invariant test added.

## Not verified (stated, not implied)

- Provider-backed TTS and visual generation: `edge-tts`, `piper`,
  `visual-pollinations`, `visual-local` are absent in this environment and no
  adapter executable ships in the repository. The executors report the
  truthful `WAITING_FOR_QUOTA` / `<STAGE>_SPAWN_FAILED` states instead.
- PostgreSQL 15+: this sandbox cluster is 14.24 (supported target is 15+).
- Deployment: no deployment exists yet (`freebuff-deploy check` reports
  `deployable: true`; the first deploy is the owner's Deploy button).

Full analysis: `docs/production/PHASE_READINESS_AUDIT.md` and
`docs/media/REAL_MEDIA_SMOKE.md`.

---

# 2026-10-12 Phase 3 — REAL free-first provider generation (evidence)

Environment: Freebuff cloud sandbox · Node v22 · ffmpeg/ffprobe 4.4.2 ·
PostgreSQL 14.24 local cluster · 1 CPU · `espeak-ng` 1.50 installed via apt
Uploads performed: none · Publishing receipts created: none · Credentials created: none
External providers contacted: **pollinations** (keyless HTTPS image) · Local engines run: **espeak-ng**

## What changed this run

- **TTS provider chosen and configured.** The single local open-source
  emergency slot (Rule 5) is now `espeak-ng` (GPL-3.0 tool, NO model weights to
  license, Hindi + English, narration via stdin). Piper was rejected on the
  record: ONNX voice weights with undocumented commercial licensing (Rule 12)
  and a pip provisioning path the Node-only production host forbids.
  Measured provider availability on this host: `edge-tts` installs but the
  Microsoft endpoint refuses this environment's connection (`403`
  WSServerHandshakeError), and the Pollinations text/audio tier returns `402`;
  `espeak-ng` synthesises locally and honestly.
- **Visual generation made operational.** The missing executable behind the
  tier-1 free primary now ships: `scripts/providers/visual-pollinations.mjs`,
  a keyless HTTPS adapter invoked as `node <script>` via the new registry
  `command` + `argvPrefix` binding (array args only, no shell, no exec bit).
- **Free-first capacity wired into production.** `createRealMediaRunnerFactory`
  (`src/catalog/server.js`) now binds per-Director `espeak-ng` voice +
  `pollinations` visual capacity, so `STPH_ENABLE_WORKERS=1
  STPH_ENABLE_REAL_MEDIA=1` reaches providers instead of the durable wait.
- **Descriptor/extension honesty.** The recorded `mimeType` and file extension
  follow the SELECTED provider's real container (`espeak-ng` → `audio/wav`,
  `pollinations` → `image/jpeg`/`.jpg`) instead of a hardcoded claim.

## Executed evidence — `node scripts/real_provider_episode.mjs`

Drives the production `createRealMediaRunnerFactory` for ONE Director
(agent-01), the same wire the durable worker uses.

- `--stage=providers` → `PROVIDER_EPISODE_STAGE_PROVIDERS_VERIFIED`
  - narration: `espeak-ng`, `mediaStatus: verified`, `generationMode:
    provider_generated`, `audio/wav`, real ffprobe `pcm_s16le` 3.838912 s,
    sha256 `8e4c30629a67a3e5a549d30a3ee9dd11dabbbeeb9e89866c877d162af4771d17`
  - visual: `pollinations`, `mediaStatus: verified`, `image/jpeg`, real
    ffprobe `mjpeg` 1024×576, sha256
    `b45793f925d026c118dce6e3ce41e1570b7cf6468ed8d9c6952fec113a37138c`
  - packaging (thumbnail) from the SAME Director style profile → verified;
    continuity `sameDirectorStyleAcrossStages: true` (visualProfileId
    `1f70e7cc…` identical across stages; voiceProfileId `7d1dc38e…`)
- `--stage=reels` → `PROVIDER_EPISODE_STAGE_REELS_VERIFIED`
  - `content_reel_1` 12 s, `content_reel_2` 12 s, `brand_reel` 10 s — each
    REALLY assembled from THIS release's own narration + visual artifacts,
    short-form QC `qcPassed: true`, `brandIntegrationMode: STANDALONE_ONLY`
  - `contentReelCount: 2`, `brandReelCount: 1`
- `--stage=assembly` → **NOT COMPLETED in-session.** The long-form main video
  (`main_longform`, 1890 s, medium/crf20 1080p) exceeded the sandbox's bounded
  command window (killed at 175 s) because a still-image program is encoded at
  25 fps (≈47,000 frames) on 1 CPU. This is a HOST THROUGHPUT limit, not a
  correctness failure: the same long-form assembly + `main_video_runtime` QC
  gate at 1890 s is independently proven by `npm run media:smoke`. The
  recorded evidence file is `artifacts/provider-episode/<stage>.json`.

## Regression + durable-queue checks on the final tree

- `npm test` — **1266 tests, 1266 passed, 0 failed, 0 skipped** (live
  PostgreSQL configured; the previously dormant live-PG subtests activate).
- `npm run verify` — passed · `npm run lint` — PASSED (263 JS/ESM files, 28
  SQL migrations).
- `node --test tests/workerLeaseContention.integration.js` —
  `LEASE_PROOF claimants=8 winners=1 recoveries=1 terminalReclaim=0
  idempotencyKeying=unique checkpointResume=durable`
  (durable lease, worker-loss reclaim, idempotency, terminal refusal,
  checkpoint resume — all against real PostgreSQL).

## Still not verified (stated, not implied)

- **Long-form main-video assembly from provider assets** — blocked by sandbox
  CPU throughput as noted above (the executor + QC contract itself is proven).
- **`edge-tts` free primary** — unreachable from this environment (`403`); the
  local emergency engine carried narration honestly instead.
- **Credentialed remote providers** (Gemini/Claude/OpenAI/ElevenLabs, OAuth
  publishing) — owner-gated (Rule 16); the worker never contacts them.
- **PostgreSQL 15+** and **the first deployment** — owner actions (Phase 4).
- **Publishing** — zero uploads; no platform receipt exists or was claimed.

## Issue #264 — durable sanitized rehearsal evidence (offline verification)

- `npm test` — **1526 tests, 1526 passed, 0 failed** measured on this branch at
  `f47f40f` (the merge of `main` @ `6a23fe2`; this documentation-only commit
  follows it and changes no code). The 5 new evidence-bundle tests cover
  allowlist copy, path/URL/token scrubbing, required-measurement refusal,
  invalid-shape codes, and the post-build leak assertion.
- Superseded figure: before that merge the same suite reported 1514/1514 against
  `main` @ `0b73d94`. That number described the pre-merge tree only and must not
  be quoted for this branch.
- `npm run lint` — PASSED · `npm run verify` — exit 0 · `npm run plan:check` —
  `DEVELOPMENT_PLAN_VALID`.
- The new workflow is registered in `automation/operations/health-manifest.json`,
  so the repository health coverage test still proves every workflow file is
  represented.
- **Not run: the `Rehearsal Evidence` workflow itself.** It needs GitHub Actions
  plus `ffmpeg`/`ffprobe`/`espeak-ng`; this worktree has neither the tooling nor
  dispatch credentials, so no CI artifact, retention check or real evidence
  bundle exists yet. What is proven is the sanitizer: it is exercised offline
  against a realistic evidence record and against deliberately leaky input.
---

# 2026-11-13 Release publish honesty — unwired platforms are refused, not "published"

Environment: Freebuff cloud worktree · Node v26.13.0 · PostgreSQL: not used by
this change (in-memory storage path) · Live providers contacted: none ·
Uploads: none

## What was wrong

`POST /api/productions/:id/publish` handled only `youtube` for real. Every other
destination fell through to an "intent" branch that called
`updateReleaseStatus(..., "published")`, wrote a `complete`-stage pipeline event
with `publishIntentRecorded: true`, and appended a `publish_intent_recorded`
evidence row — then returned `200` with `production.status === "published"`
while performing no platform call and producing no receipt.

The API therefore reported a publication that never happened (Rules 1, 2, 7).
The prior test suite ENCODED that behaviour as correct
("non-YouTube destinations keep the original intent-recording behavior").

## What changed

- `src/catalog/server.js` — the fallthrough branch is now a refusal:
  `501 PUBLISH_PLATFORM_NOT_WIRED` with `platform`, one
  `production_publish_rejected` audit row (outcome `platform_not_wired`), no
  receipt, no publishing evidence, no status change. The release stays
  `review` and remains publishable once a real publisher exists.
- `tests/youtubePublishRoute.test.js` — the misleading test is replaced by one
  that asserts the refusal, that no network call occurs, that the release is
  still `review`, and that no `publish_intent_recorded` evidence is appended.
- `docs/publishing/CROSS_PLATFORM_PUBLISHING_E2E.md` — documents the route's
  two real outcomes and points at `/ops/publishing/:agentId/private-test` for a
  genuine private-first platform test.

No status enum changed (R5): the published/unpublished vocabulary is untouched
and no migration was needed, because refusing is more honest than inventing a
state that still means "not published".

## Verification

- Focused: `tests/youtubePublishRoute.test.js` 13/13 pass.
- Mutation check: restoring the old fallthrough branch makes the new test fail
  (1 test, 0 pass, 1 fail); the new branch passes again.
- Full gates recorded in the PR body: `npm test`, `npm run lint`,
  `npm run verify`, `npm run plan:check`.
- **Not verified here:** any live platform upload for these destinations, which
  remains owner-gated (#118) and unreachable from this change.

---

# 2026-11-13 Real-media worker startup — async runner factory was not awaited

Environment: Freebuff cloud worktree · Node v26.13.0 · PostgreSQL: not used by
this change · Live providers contacted: none · Media generated: none

## What was wrong

`src/catalog/server.js` bound the real-media runner factory without `await`:

```js
executorRunnerFactory = createRealMediaRunnerFactory({ ... }); // Promise, not a function
```

`createRealMediaRunnerFactory` is `async` because it resolves per-Director
governed provider capacity at binding time. `ProductionWorkerLoop` accepts only
`null` or a function (`src/pipeline/workerLoop.js:54`), so the constructor threw
`WORKER_EXECUTOR_RUNNER_FACTORY_INVALID` inside the startup `try`, which
`logInternalError("WORKER_START_FAILED", ...)` swallowed. The observable effect:
with `STPH_ENABLE_REAL_MEDIA=1` **no production worker started at all** and the
leased queue stayed idle while the process reported healthy.

## What changed

- `src/catalog/server.js` — `await createRealMediaRunnerFactory(...)`, with a
  comment naming the failure mode so it is not re-simplified away.
- `tests/realMediaWorkerStartup.test.js` (new) — pins the consequence (a Promise
  bound as the factory is rejected) and the call site (the factory is awaited),
  so dropping the `await` fails in CI instead of silently in production.

## Verification

- Focused: 1/1 pass. Mutation check: removing the `await` fails that same test
  (0/1 pass), and restoring it passes again — it detects the exact defect.
- The test file was reduced to that single assertion. It is a source assertion
  because the binding lives inside `finalizeRuntimeStartup`, whose worker branch
  only runs when PostgreSQL storage is configured, so there is no offline call
  path to exercise. Two earlier behavioural tests were removed: they passed
  whether or not the `await` was present (they exercised `ProductionWorkerLoop`'s
  own `WORKER_EXECUTOR_RUNNER_FACTORY_INVALID` validation, which is not what
  regressed), so they documented the consequence without detecting the defect.
- Full gates recorded below in the PR body: `npm test`, `npm run lint`,
  `npm run verify`, `npm run plan:check`.
- **Not verified here:** a live worker run against PostgreSQL with real media
  tooling. The startup wiring is proven; an end-to-end production run is not.

---

# 2026-11-13 Rehearsal delivery loudness — real QC failure, two-pass fix

Environment: Freebuff cloud worktree · Node v26.13.0 · ffmpeg/ffprobe/espeak-ng:
NOT installed · Live providers contacted: none · Media generated locally: none ·
Publishing: none

## What the real run measured

The `Rehearsal Evidence` workflow ran on `main` @ `640ade7`
([run 43301281602](https://github.com/smithsamm007/ST-Production-House-Unified/actions/runs/43301281602))
and rendered a real 1800 s episode before the completeness gate rejected it:

```
REHEARSAL_GATE_FAILED_QC_AUDIO_CLIPPING_DETECTED
truePeakDbtp 0.14, clippingCount 1, integratedLufs -15.47, audioSeconds 1792.856
```

## What was actually wrong (traced, not assumed)

The gate was already receiving `measureLoudnessSync(videoPath)` — the delivered
MP4 — not a pre-normalization measurement. `loudnorm`'s JSON reports
`input_i`/`input_tp` for the file it measures and `output_i`/`output_tp` for its
own internal pass to the default -24 LUFS target; only `input_*` describes the
delivered file. So the file was genuinely over the contract, for two reasons:

1. The normalization was **single-pass dynamic** `loudnorm`, which missed its
target (-15.47 LUFS against -14.0) and only bounded the peak of the buffer it
   processed, not of the AAC encode that followed.
2. The **delivery peak target equalled the QC limit** (-1.0 dBTP), leaving zero
   headroom, so AAC intersample overshoot pushed the deliverable to +0.14 dBTP.

## What changed

- `src/media/loudnessNormalization.js` (new) — `buildMeasuredNormalizationFilter`
  (two-pass linear `loudnorm`), `requiresCorrectiveNormalization`,
  `selectGateLoudness`, plus the contract constants: QC stays
  `QC_MAX_TRUE_PEAK_DBTP = -1.0`, delivery aims at `-2.5` dBTP.
- `scripts/real_media_rehearsal.mjs` — two-pass normalization, delivery headroom,
  one corrective re-normalize + remux (`-c:v copy`) if the encoded file still
  breaches the contract, and the gate fed through `selectGateLoudness`.
- `tests/loudnessNormalization.test.js` (new) — pins that the gate receives the
  delivered-file measurement and never a pre-normalization value, that the
  applying pass is linear and measurement-driven, and that headroom sits below
  the QC limit.

**The QC contract was not relaxed.** The gate still rejects anything above
-1.0 dBTP; only the delivery target gained headroom.

## Verification

- `npm test` — **1535 tests, 1535 passed, 0 failed** (1529 before + 6 new).
- `npm run lint` — PASSED · `npm run verify` — exit 0 · `npm run plan:check` —
  `DEVELOPMENT_PLAN_VALID`.
- **Not run here:** the encoder itself. This worktree has no ffmpeg, so the
  aural proof must come from re-dispatching `Rehearsal Evidence`. No retained
  artifact exists yet and the two-pass behaviour is unverified until that run
  reports `REHEARSAL_COMPLETE`.

---

# 2026-11-07 Issue #262 — JARVIS 30/40/50-minute unification (offline)

Environment: Freebuff cloud worktree · Node v26.13.0 · ffmpeg/ffprobe: NOT
installed · PostgreSQL: not used by this change · Live providers contacted:
none · Media generated: none · Publishing: none

## What changed

- `src/jarvis/targetDuration.js` — the ONE planning-duration contract, derived
  from `EPISODE_DURATION_OPTIONS_SECONDS` (1800 / 2400 / 3000 s = 30/40/50 min).
- All eight JARVIS validators (outline, narration, continuity, script plan,
  script dispatch, audio dispatch, shorts, metadata/thumbnail) now fail closed
  through that contract. The old 25–30 range — and the 27-minute plans it
  allowed — is gone.
- `src/jarvis/jarvisNarrationScript.js` — builds the SAME duration-aligned
  script the production pipeline uses and derives subtitle segments from it
  (contiguous script words, `narration_script_planned_seconds` timings).
- `src/jarvis/measuredNarration.js` — narrates that script through the real
  `executeTtsGeneration` executor and judges the result with
  `evaluateEpisodeCompleteness`; no second executor, no second gate.
- `src/jarvis/contentPackageOrchestrator.js` — exposes `narrationScript`,
  `narrationAudio`, derived Hindi subtitles, `OWNER_SCOPE_REQUIRED` when owner
  scope is missing, and a `narrationStage` injection point whose
  `measured_verified` result is reused from the durable checkpoint.
- `deterministicSubtitlePlan.js` — total duration cap 1800 → 3000 s (50 min).

## Commands and results (this tree, this branch)

- `npm test` — 1497 tests, 1497 passed, 0 failed, 0 skipped (offline: no
  database, no ffmpeg, no provider contacted).
- `npm run lint` — PASSED (311 JS/ESM files, 31 SQL migrations).
- `npm run verify` — exit 0.
- `npm run plan:check` — `DEVELOPMENT_PLAN_VALID`, 11 tasks.
- Staged diff vs `main` (1cc5a5c) — 28 files changed, +1145/−60, of which four
  files are new.

## Not verified (stated, not implied)

- **No real narration audio was generated or measured.** This sandbox has no
  ffmpeg/ffprobe and no `espeak-ng`, and the PR is offline by scope. The
  measured-narration tests inject the executor's RECORD, so they prove the gate
  wiring and its fail-closed verdicts — not a real render.
- **No CI has run on this head.** The branch must be pushed and a PR opened for
  `pr-gate` to report.
- **Hinglish packages still require owner-supplied timed segments.** The
  repository ships no Hinglish narration-script builder, and Hindi cues are
  never mislabelled as Hinglish.
