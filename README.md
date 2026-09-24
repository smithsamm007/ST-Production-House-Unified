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
  - Publish gate enforces Rule 7: release must be in `review`, destination configured, non-empty public attribution. Publishing records intent + evidence only; live platform calls remain pending.

- **Media Inspection Runner (real FFprobe verification boundary)**:
  - Callable executor a real assembly worker invokes: SHA-256 over the ACTUAL file bytes + ffprobe via validated array arguments (never shell strings, no path traversal/option injection), feeding the existing artifact-descriptor promotion.
  - Real tamper detection: a substituted on-disk file fails the descriptor hash check (`INSPECTION_HASH_MISMATCH`) even when ffprobe succeeds on it.
  - Honest failure matrix — absent binary, timeout, non-zero exit, unparseable/empty output all yield truthful failure codes; the descriptor stays `UNVERIFIED` (`ffprobe_verified:false`). Nothing is fabricated.

- **Hermes Manager Layer (decision authority without secret access)**:
  - Frozen authority matrix: autonomous production/scheduling/provider decisions; owner-policy-controlled publishing/deletion/spending; structurally prohibited secret access, control disabling, and ledger modification. Unknown actions fail closed; refusals are recorded as audit evidence.
  - Append-only, auditable decision history with honest outcomes — `EXECUTED` only with a ledger-verified evidence receipt; completions supersede, never mutate.
  - Secret-free by construction: payloads are server-side gated against secret-shaped fields/values; credentials are addressed by REFERENCE (`agent-01 / gemini / production`) and delivered by the broker straight to the adapter — Hermes never sees key material.
  - Command-center API (`/api/hermes/*`) + dashboard panel rendering only real decision data.
  - **Execution bridge**: `production.start` decisions queue REAL episodes through the same transactional release+job path as the owner API (durable `episode_production` job, one release per channel/season/episode slot), with director↔channel tenant isolation, honest evidence receipts, and ledger-verified `EXECUTED` completion.

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

Snapchat is supported as an account configuration type, but live Snapchat publishing remains pending.

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
