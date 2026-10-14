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
