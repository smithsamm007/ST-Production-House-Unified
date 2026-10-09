# ST Production House Unified

This is a clean, ST-owned secure foundation for consolidating the strongest ideas from the supplied repositories without merging their vulnerabilities, simulations, duplicate pipelines, or legally uncertain assets.

## What is implemented

- **Agent Creative Charter and Channel Universe System**:
  - Supports versioned, owner-controlled Creative Charters and Channel Universe registries.
  - Keeps the internal agent names (e.g. JARVIS, LAKME, PANCHI, VEDA) strictly separated from public channel brands, creative universes, narrator identities, and public attribution.
  - Internal names are strictly blocked from public exposure.
  - Initially, only JARVIS and LAKME possess active owner-approved Creative Charters. The remaining 18 preloaded agents remain unassigned and inactive, ensuring no fake details are generated.
  - LAKME's Hindu Mythology universe implements a highly performant **Lazy Hierarchy** (Universe → Era or Yuga → Source Collection → Series → Season → Story Arc → Episode), allowing more than 8,000 episodes to be resolved on demand without pre-creating millions of empty database rows.
- **Niche Reference and Visual Reference Library**:
  - Supports separate, owner-controlled Niche and Visual references.
  - Controls audience, storytelling, pacing, structure, and tone independently from art direction, lighting, composition, or subtitle styling. Niche settings never silently alter visuals, and visual settings never silently alter story/narration.
  - Includes safe HTTPS-only URL parsing and a YouTube host allowlist. Rejects unsafe localhost, private IPs, credentials, or non-standard ports.
  - Classifies references strictly into: `youtube_channel`, `youtube_video`, `youtube_playlist`, `written_brief`, `authorized_image`, `uploaded_asset_metadata`.
  - Enforces the 10 approved lifecycle statuses exactly: `submitted`, `validation_failed`, `awaiting_analysis`, `analysis_in_progress`, `analysis_failed`, `draft_profile_ready`, `awaiting_owner_review`, `approved`, `rejected`, `inactive`.
  - Restricts scope assignments cleanly (preventing crossover of niche references into visual profiles).
- **Owner-Agent Communication Studio and Blueprinting**:
  - Collaboratively refines Agent parameters across exactly 22 Interactive Interview Catalog sections spanning Brand Voice, Framing, CTA, Soundscapes, and Parallelism.
  - Interactive Messaging Engine validating message types and enforcing zero-trust sender-to-thread authorization.
  - Unresolved question blockades that prevent blueprint versioning until resolved by the owner.
  - Automated 22-section validation, brand safety checks (e.g. blocking terms like 'unsafe' and 'unfiltered'), and recursive snapshot secret-leak scanning.
  - Permanent lock upon owner approval, deactivating edits and freezing the blueprint draft.
- **Agent Digital Identity and Account Isolation**:
  - Every agent name is used as an internal identifier only. Public publishing strictly uses the connected channel/account brand.
  - Every agent possesses unconfigured account slots for emails, YouTube, Instagram, Facebook, and Snapchat.
  - **Important Notice**: Real email addresses, live OAuth connections, and active social accounts are NOT connected or configured yet in this Phase-1 foundation. Live OAuth, SMTP, and social publishing remain pending.
  - Safe dashboard serialization uses an explicit safe DTO/allowlist to ensure secret keys and locators are never serialized.
- Owner-controlled canonical agent catalog (20 original divisions + NEWTON = 21 registered), with a hard maximum of 50.
- Strict per-agent provider policy: three private remote providers and one keyless local open-source emergency provider.
- Evidence-bearing failover that rejects unverified "success".
- Persistent PostgreSQL design for credentials, jobs, leases, provider attempts, artifacts, campaigns, approvals, affiliate links, and receipts.
- One standalone promotional Reel per normalized product/service identity.
- Explicit duplicate-campaign authorization and independent main-video choice.
- Affiliate HTTPS/domain/disclosure policy.
- Owner-approved publishing snapshots with cryptographically hashed snapshots to prevent post-approval mutations.
- Isolated worker contracts for story, motion, assembly, and Postiz publishing.
- Automated policy tests requiring no package installation.

- **Multi-Channel Anime Production House (channels → episodes → pipeline → publish gate)**:
  - Owner-scoped channels carry public branding only; internal agent names never serialize to the dashboard (Rule 15).
  - One planned release per (channel, season, episode) slot — database-enforced; a failed attempt creates a new job, never a second logical Reel/release (Rule 8).
  - Deterministic four-stage pipeline (story → visual → audio → assembly) with real SHA-256 artifact hashes in the canonical `artifacts` table, durable `pipeline_events`, and evidence-ledger rows. Artifacts are labeled `deterministic_local` with `ffprobe_verified:false` — no fabricated media or receipts.
  - Opt-in durable worker (`STPH_ENABLE_WORKERS=1`) with bounded concurrency and lease-based claiming; owner-triggered runs use the same legal job transitions and fail closed against double-runs.
  - Publish gate enforces Rule 7: release must be in `review`, destination configured, non-empty public attribution. `youtube` destinations now execute the wired private-first upload through the existing `youtubePublisher` (Issue #217): FFprobe-verified assembly artifact with a durable media path, owner approval bound to the exact artifact hash, Director-scoped OAuth token resolved only through the secret-manager boundary, durable `publishing_receipts` + `platform_publish` evidence + audit, and zero-network replay when a receipt already exists — never a fabricated platform ID. Other platforms still record intent + evidence only; real uploads remain pending owner-provisioned Vault + Google OAuth credentials.
- **Meta (Instagram/Facebook) publisher adapter (Issue #219)**:
  - `src/publishing/metaPublisher.js` implements the OFFICIAL Meta Graph API boundary behind the same `publisher.publish()` contract as YouTube: Instagram Reels via container creation (`media_type=REELS`, `upload_type=resumable`) → `rupload.facebook.com` resumable upload → bounded `status_code` polling → `media_publish`; Facebook Page videos via the Resumable Upload API (`/{app-id}/uploads` → binary upload → `/{page-id}/videos`), with Graph API version pinned in one constant (`v25.0`) and all endpoints taken from official Meta documentation — no invented APIs.
  - Same honesty/safety contract as the YouTube adapter: exact artifact SHA-256 re-verified from the real file bytes BEFORE any credential resolution or network call, unexpired owner approval bound to the exact artifact hash and destination inside the adapter (Rule 7 defense-in-depth), Rule 15 internal-name suppression built from the canonical agent catalog, Rule 17 token containment (credentials only in Authorization headers and never in receipts/errors), official-host HTTPS allowlist (`graph.facebook.com`, `graph-video.facebook.com`, `rupload.facebook.com`), bounded retry honoring `Retry-After` (429/5xx/network retried; 401/403/4xx fail closed), zero-network idempotent receipt replay, and receipts (`platformPostId`/`platformUrl`) only from real platform response ids + real permalinks — nothing fabricated.
  - Director-scoped credentials are resolved per (owner, agent, destination) through the injected resolver — production wiring resolves opaque `vault://`/`opaque://` locators via the existing secret-manager boundary. Offline tests script the transport; live Meta publishing remains owner-gated (Issue #118).

- **Snapchat (Spotlight) publisher adapter (Issue #221)**:
  - `src/publishing/snapchatPublisher.js` implements the OFFICIAL Snapchat Public Profile API boundary behind the same `publisher.publish()` contract as YouTube/Meta: AES-256-CBC client-side media encryption (fresh 32-byte key + 16-byte IV per publish, per official protocol) → create-media container (`POST /v1/public_profiles/{profile_id}/media`, carrying the base64 key/iv) → encrypted multipart upload (`action=ADD`, ≤32 MB chunks, `part_number` 1..35, ≤1 GB, bounded-memory chunking) → `action=FINALIZE` → Spotlight post (`POST /v1/public_profiles/{profile_id}/spotlights` with `media_id`, `description` ≤160, `locale`). All endpoints taken from official Snap documentation — no invented APIs.
  - Receipt honesty: `platformPostId` is ONLY the real `spotlight_id` from the platform's post response; `platformUrl` is the canonical Spotlight URL shape (`https://www.snapchat.com/spotlight/`, pinned constant) built from that real id — the same precedent as the YouTube adapter's `watch?v=` construction. Story posting is deliberately NOT wired: the official post-story response returns no story identifier, so no honest receipt is possible.
  - Same fail-closed contract as the other adapters: exact artifact SHA-256 re-verified from real file bytes BEFORE any credential resolution or network call, in-adapter Rule-7 approval binding (unexpired, same artifact hash, destination `snapchat`), Rule 15 internal-name suppression from the canonical catalog, Rule 17 token containment (Bearer token only in Authorization headers; ephemeral media keys never logged/echoed), official-host HTTPS allowlist (`businessapi.snapchat.com`) with platform-provided `add_path`/`finalize_path` validated as bounded relative paths (SSRF defense), bounded `Retry-After`-honoring retry (429/5xx/network only), official logical errors `MEDIA_EXPIRED` / `MEDIA_POSTING_ALREADY_IN_PROGRESS` fail closed with no auto re-create (an automatic retry could double-publish), zero-network idempotent receipt replay, and Spotlight media-name derived from the artifact hash — never from public metadata.
  - Offline tests script the transport (`tests/snapchatPublisher.test.js`, 21 tests); live Snapchat publishing remains owner-gated (Issue #118 — the Public Profile API is allowlist-only and requires real credentials + accounts).

- **Destination-aware publisher routing (Issue #223)**:
  - `src/publishing/destinationPublisherRouter.js` is the explicit selection seam between the owner publishing boundary and the per-platform adapters: a deployment-wired `publishersByDestination` registry maps `youtube` → youtubePublisher, `instagram`/`facebook` → metaPublisher, and `snapchat` → snapchatPublisher.
  - Selection is exact and fail-closed: an unknown destination key, a registry entry without a `publish` function, or a supported-but-unwired destination throws a stable code (`DESTINATION_PUBLISHER_*` / `PUBLISHER_NOT_WIRED_FOR_DESTINATION`) and the owner route returns an honest `503 PUBLISHING_TRANSPORT_UNAVAILABLE` — a destination can never silently reach another platform's publisher.
  - The legacy single-`publishingPublisher` mode is preserved unchanged when no registry is wired. Pure and offline: no clocks, no network, no secrets (Rule 17); live publishing remains owner-gated (Issue #118).

- **Bilibili publishing research (Issue #225)**:
  - The canonical long-form secondary destination is documented as research-complete but NOT implemented: `docs/publishing/BILIBILI_PUBLISHING_ADAPTER.md` records the officially observed 哔哩哔哩开放平台 flow (OAuth 2.0 token exchange/renewal on `api.bilibili.com` with single-use refresh tokens; server-side video submission on `member.bilibili.com`: preprocessing → 8 MB chunked upload → chunk merge → cover upload → archive submission), the real permission/whitelist gates (documented error codes 127304/127305), and the honest-receipt boundary — a submission is in platform review and NOT public, so "published" status can only ever come from post-review platform responses.
  - Fail-closed by test: `bilibili` is rejected by the destination publisher router (`DESTINATION_PUBLISHER_UNKNOWN_DESTINATION` at construction; `PUBLISHER_NOT_WIRED_FOR_DESTINATION` at resolve) until a real adapter is implemented behind owner-gated platform access (Issue #118 / S-M24-LIVE). No Bilibili account, app, whitelist grant, or upload exists.

- **Media Inspection Runner (real FFprobe verification boundary)**:
  - Callable executor a real assembly worker invokes: SHA-256 over the ACTUAL file bytes + ffprobe via validated array arguments (never shell strings, no path traversal/option injection), feeding the existing artifact-descriptor promotion.
  - Real tamper detection: a substituted on-disk file fails the descriptor hash check (`INSPECTION_HASH_MISMATCH`) even when ffprobe succeeds on it.
  - Honest failure matrix — absent binary, timeout, non-zero exit, unparseable/empty output all yield truthful failure codes; the descriptor stays `UNVERIFIED` (`ffprobe_verified:false`). Nothing is fabricated.

- **FFmpeg Assembly Executor (validated plan → real media processing)**:
  - Callable boundary from `media_assembly_plan_v1` to actual rendering: plan-integrity gate → artifactRefs resolved ONLY through descriptor bindings (`sha256:` ↔ content hash) → FFmpeg argv built as frozen ARRAY ARGS (no shell, paths validated, output path last) → injectable spawn → post-render re-probe of the rendered bytes → QC duration gate.
  - QC duration policy enforced on the REAL post-render inspection: `main_longform` inside [1800, 3000] s via the S-M33-01 gate; short-form reels inside [3, 90] s via the new short-form gate — claimed-vs-measured conflicts and missing durations fail closed.
  - Honest outcomes only: absent ffmpeg, timeout, non-zero exit, unreadable render, or out-of-window duration each produce a stable failure code; success requires real execution + a matching-hash inspection of the rendered file + a passing QC gate. Approximations (e.g. `wipe` rendered as fade) are labeled degradations, never silent.

- **Real TTS Execution Worker (voice: profile → provider → verified audio)**:
  - Callable boundary from the S-M32-01 voice-continuity profile + script to real audio: profile integrity gate → free-first provider selection over DECLARED capabilities (Edge-TTS free primary, Piper local emergency — ElevenLabs never in the automatic chain, Rule 35) → array-args spawn (Piper text via stdin, no shell) → real SHA-256 + FFprobe of the written audio → S-M30-01 descriptor promotion → S-M32-01 truthful outcome.
  - Quota- and credential-honest: quota-exhausted slots are skipped, missing owner credentials surface `CREDENTIAL_MISSING`, and when no provider remains the durable `WAITING_FOR_QUOTA` state is returned — never a disguised failure.
  - A provider exit 0 is NOT success: `mediaStatus: "verified"` requires a real matching-hash inspection of the actual audio bytes; every failure (binary absent, timeout, call failure, unreadable output) is truthful and stable-coded.

- **Hermes Manager Layer (decision authority without secret access)**:
  - Frozen authority matrix: autonomous production/scheduling/provider decisions; owner-policy-controlled publishing/deletion/spending; structurally prohibited secret access, control disabling, and ledger modification. Unknown actions fail closed; refusals are recorded as audit evidence.
  - Append-only, auditable decision history with honest outcomes — `EXECUTED` only with a ledger-verified evidence receipt; completions supersede, never mutate.
  - Secret-free by construction: payloads are server-side gated against secret-shaped fields/values; credentials are addressed by REFERENCE (`agent-01 / gemini / production`) and delivered by the broker straight to the adapter — Hermes never sees key material.
  - Command-center API (`/api/hermes/*`) + dashboard panel rendering only real decision data.
  - **Execution bridge**: `production.start` decisions queue REAL episodes through the same transactional release+job path as the owner API (durable `episode_production` job, one release per channel/season/episode slot), with director↔channel tenant isolation, honest evidence receipts, and ledger-verified `EXECUTED` completion.
  - **Durable decision store (sql/023)**: append-only `hermes_decisions` table (mutation-blocking trigger) with advisory-locked monotonic numbering — decision history and numbering survive restarts; the manager routes through `PostgresHermesDecisionStore` by default and degrades with honest 503s when storage is unconfigured.

- **Secrets & Connections (per-Director provider bindings, owner dashboard)**:
  - Provider catalog (Gemini, Claude, OpenAI, ElevenLabs, Piper, Edge-TTS, YouTube, Instagram, Facebook, Snapchat, Bilibili, SMTP, custom) with official HTTPS-only credential URLs and per-field schemas; owners extend it via validated custom-provider registration without mutating the governed catalog.
  - One connection per (owner, director, provider, kind); secret fields are stored ONLY as opaque `vault://`/`opaque://` locators — plaintext secrets are structurally impossible to persist (DB trigger + repository re-validation).
  - Locators never serialize: API/DTO expose field KEYS only. Configuration fields are non-secret, bounded, and cannot smuggle locator-shaped values.
  - Connection tests are honest by construction: no live transport → `unverified`, never `success`; append-only test history (mutation-blocking trigger) with sanitized failure details.

- **Director Workspace (persistent communication window, roadmap, isolated memory)**:
  - One persistent owner↔director conversation per director — lazily created, so Director #50 gets the same window as Director #01 (Blueprint §7–§9).
  - Messages carry explicit execution semantics (`conversation | proposal | instruction | decision`); recording never triggers production or publishing — conversation is not execution (§10).
  - Per-director roadmap in four buckets (`now | next | future | ideas`) with an owner-driven lifecycle (§11).
  - Isolated memory: one JSON entry per category (universe bible, characters, locations, story rules, visual/voice/music identity, audience insights, owner decisions, production history); every read is scoped by owner AND director — no cross-director or cross-owner leakage (§12).

## What is deliberately not claimed

Live Gemini, Claude, Sarvam, Veo, social-network, Snapchat, or Postiz calls are not enabled in this foundation. Those require the owner's accounts, secret-manager references, provider sandbox verification, and platform approval. No uploads or provider calls were made while building this repository.

Snapchat is supported as an account configuration type and now has an official-API Spotlight publisher adapter (`src/publishing/snapchatPublisher.js`, Issue #221), but live Snapchat publishing remains pending (owner-gated: the Public Profile API is allowlist-only, Issue #118).

All email and social connection slots are currently unconfigured and seeded with null identifiers in the database.

No actual episodes, characters, stories, platform accounts, or public channel names are generated in this task. We implement only the secure foundation and initial owner-approved charter records.

## Verify

Requirements: Node.js 20 or newer.

```bash
npm test
npm run verify
```

## Next steps

Read:

- `docs/MASTER_BLUEPRINT.md`
- `docs/ARCHITECTURE.md`
- `docs/REPOSITORY_AUDIT_AND_REUSE.md`
- `docs/SECURITY.md`
- `docs/IMPLEMENTATION_ROADMAP.md`
- `AGENTS.md`

Apply `sql/001_core.sql`, `sql/002_seed_agents.sql`, `sql/003_agent_digital_identity.sql`, `sql/004_creative_charter.sql`, `sql/005_creative_reference.sql`, `sql/006_seed_initial_creative_charters.sql`, and `sql/007_owner_agent_communication_studio.sql` to a new PostgreSQL database only after replacing the example credentials and adding backups.

The recommended first implementation increment is the authenticated API, PostgreSQL repositories, durable worker leases, and a secret-manager broker.
