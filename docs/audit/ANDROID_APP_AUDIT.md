# Android Control-Plane Prototype — Audit (2026-10-25)

Scope: `app/**` on `main` at `5ba62d9` (the Google AI Studio sync, committed in
`6161dd8`). Read-only audit; no code changed by this document. The Node
production engine (schemas 001–031, executors, publisher adapters, QC gates)
is preserved in git history up to `59a2a5f` (+ PR #244).

## Verdict

The app is a **vision-faithful UI prototype over a 100% in-memory mock data
layer**. It renders every major surface of the owner console (13 sections) and
its MVVM structure is sound — but **every value it displays is a hardcoded
fixture**, several fixtures **fabricate provider receipts and verification
states that never existed**, and the app **cannot make a single network call**
(no `INTERNET` permission, no HTTP/OAuth/persistence dependency).

Its own login screen claims "zero simulated mock data." That claim is false
and must be corrected before this app is presented as anything more than a
design mockup (AGENTS.md Rule 1/2 apply to every artifact representing system
state, including UI).

## Architecture as found

| Layer | File | Assessment |
|---|---|---|
| Data model | `data/model/Models.kt` | Mirrors vision entities: Owner, Agent (cap 50), Channel + 4 canonical MediaSlot entries (1 main + reel_1 + reel_2 + brand), ProductionRelease (8-stage enum), DirectorSchedule (30/40/50 min, sql/029-shaped), DirectorMessage, CreativeCharter, ProductionJob (queued/running/waiting_for_quota/waiting_for_approval/succeeded/failed/paused), ProviderSlot (4-slot policy shape), PlatformConnection (vault-locator shape), ApprovalItem (Rule-7 shape), EvidenceEvent, HermesDecision |
| Repository | `data/repository/ProductionHouseRepository.kt` | All state = `MutableStateFlow` seeded from `getInitial*()` hardcoded fixtures; real SHA-256 utility; **no persistence, no network, no auth check** |
| ViewModel | `ui/viewmodel/ProductionViewModel.kt` | Clean flows + testTags; hardcoded demo password in state (`demo-production-house-2026`) |
| UI | 13 screens + components + theme | Compose drawer + bottom nav; screens render the mock flows |
| Tests | `ProductionHouseTest.kt` (7 JUnit tests) | Internally coherent but test **claims about Rules 15/8/7 are about fixtures**, not enforced rules |

## Findings

### F1 — Fabricated verification states and receipts (Rule 1/2 — the critical one)

`getInitialEvidence()` seeds evidence rows with plausible receipts for actions
that never occurred: `receipt://ffmpeg/exit0?duration=1800s&vcodec=h264`,
`receipt://qc-gate/pass?...ffprobe=1080p60`, "NARRATION_SYNTHESIZED …
snr=38db". `MediaSlot` fixtures assert `status="verified"`, `lufs="-14.2
LUFS"`, codec strings, and `sha256:` strings **truncated to 47 hex chars**
(invalid, not real hashes) for media that was never rendered.
`getInitialProviders()` labels YouTube/Meta/Snapchat publisher slots "OAuth
Verified" and connections `sandbox_verified` with `vault://stph-secrets/...`
locators — real the platform connections are unconfigured (Record 16/17 truth
in the Node seed). `ProductionRelease.executionLog` claims provider work
("12 keyframe scenes synthesized via Pollinations", "Kokoro TTS …").
`advancePipelineStage()` fabricates execution logs per stage ("FFmpeg video
encoding rendered 1080p60 H.264") and auto-creates a Rule-7 ApprovalItem whose
`artifactHash` is a SHA-256 of nothing real.

### F2 — Authentication is a string-exists check

`repository.login()` succeeds for any non-blank email/password; the demo
password sits in ViewModel state AND on the login screen. No session, no
server auth, no token boundary (Rule 17).

### F3 — No persistence: every owner action is lost on process death

`addChannel`, `saveSchedule`, `decideApproval`, `updateConnectionSlot` mutate
in-memory only. No Room/DataStore/SharedPrefs.

### F4 — No connectivity at all

Manifest has no `INTERNET` permission; no Retrofit/OkHttp/Firebase
dependencies; the AI-Studio `secrets` plugin scaffolding (`.env` → BuildConfig)
exists but **no Kotlin code reads any API key** — the Gemini wiring is config
plumbing without a client.

### F5 — Secrets UX without enforcement

`ConnectionsScreen → updateConnectionSlot(connectionId, status, locator)`
accepts any typed string as a "locator" with `lastVerified` stamped — the UI
would let a real secret be typed into state with no vault enforcement once a
real backend exists; the contract (Rule 17) must be reintroduced at the API
layer and mirrored in the app.

### F6 — Good, reusable scaffolding

- 21-agent catalog matches the Node seed; cap-50 asserted; format `agent-NN`.
- Stage enum, job statuses, provider-slot policy shape (3 remote + 1 local
  emergency), approval/caption/disclosure/affiliate fields, and the 4-slot
  package all mirror the preserved Node contracts — the UI vocabulary needs
  no redesign to bind to the real API.
- `computeSha256()` is correctly implemented and correctly formatted.
- MVVM + StateFlow + testTags are clean and test-covered.

## Screen → (Node-era) API contract mapping for Phase 0

| Screen | Should bind to (Node owner routes, preserved in history) | Honesty requirement |
|---|---|---|
| Overview | `/api/control` summary + evidence ledger tail | show only bridge-recorded data |
| Directors / add channel | `/api/catalog` channels CRUD (audit events) | Rule 8 slot integrity |
| Schedule | `/api/scheduling` (auth + CSRF) | scheduler truth codes, no fake "Slot queued successfully" |
| Communication | Director Workspace routes (conversation ≠ execution) | no fabricated director auto-replies |
| Memory / charters | Director workspace memory + charter lock | charter lock lifecycle |
| Production | `/api/control/jobs/:id/retry`, release+job start | stage truth only from pipeline events |
| Jobs | job repository truth (leases, waits, dead-letters) | WAITING states surface real quota codes |
| Providers & Quota | provider capacity/quota sources | no "OAuth Verified" without real capability |
| Connections | `/api/social/*` + connection tests | locator KEYS only, never values |
| Approvals | Rule-7 approval records bound to real hashes | binding requires real artifact + expiry |
| Evidence | evidence ledger (append-only, hash-chained) | never render fabricated receipts |
| Hermes | `/api/hermes/*` decision matrix | authority tier from the frozen matrix |

## Recommended remediation order (for the Phase-0 decision paper)

1. **Correct honesty labels in-app now** (cheap, no backend): change the login
   screen's false claim to "UI prototype — all data is demo fixtures"; mark
   every screen as `mock` until a backend binds; stop generating fake
   EvidenceEvents for UI actions that happened only on-device; stop
   auto-creating approvals with fabricated hashes; remove stored demo
   password.
2. **Phase 0 architecture decision** (owner): Android = native client over the
   resurrected Node control plane (Option A) vs native re-implementation
   (Option B) — see the companion decision paper.
3. **Phase A wiring (Option A):** INTERNET permission + Retrofit/OkHttp,
   auth/session against the Node owner API (Argon2id-backed), real
   persistence, safe-DTO serialization only (mirroring GREST allowlist), and
   a territory rule for AI-Studio syncs (app/ UI vs engine paths).
