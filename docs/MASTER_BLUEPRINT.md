# ST Production House — Master Blueprint

> Source: the owner's master vision statement (2026-09). This document is the
> single organized specification derived from it, mapped against the repository's
> VERIFIED state. Claims are separated into **Delivered (verified)**,
> **In progress**, and **Not started**. Nothing is marked delivered without a
> merged implementation and passing tests.

## 1. Ultimate vision (one sentence)

ST Production House is a secure, quota-aware, owner-governed autonomous AI
studio that manages multiple independent content brands, produces and publishes
media using free capacity where available, and safely waits, recovers, and
resumes when resources are unavailable.

## 2. Core objective

Operate multiple digital content brands autonomously — research → script →
voice → visuals → edit → thumbnail → SEO → publish → analytics — while the
owner's laptop is off, with durable jobs, checkpoints, provider failover,
evidence, and owner approval at every legally/technically sensitive boundary.

## 3. Status map (vision → repository reality)

| Vision area | Status | Verified evidence on main |
|---|---|---|
| 20-agent catalog, 50-agent cap, per-agent identity & isolation | **Delivered** | `src/catalog/agents.js`, migrations 001–003, identity/connection-slot tests |
| Creative charters, universes, lazy hierarchy | **Delivered** | migrations 004–006, `src/catalog/creativeCharter.js` + tests |
| Niche/visual reference library, HTTPS allowlist | **Delivered** | migrations 005, reference library tests |
| Owner-agent communication studio, blueprinting | **Delivered** | migration 007, 22-section engine + tests |
| Owner auth: Argon2id, sessions, TOTP MFA, CSRF, lockouts | **Delivered** | migrations 008–009, `src/catalog/ownerAuthentication.js`, `src/api/ownerServer.js` |
| Durable job lifecycle, queue, leases, DLQ | **Delivered** | migration 010, `src/jobs/**`, integration tests |
| Credential broker, opaque locators, per-agent scoping | **Delivered** | migration 011, `src/credentials/**`, `src/broker/locator.js` |
| Durable retry/backoff, expired-lease recovery | **Delivered** | migration 012, `src/jobs/retry/retryManager.js` |
| Provider quotas, cooldowns, approved-free routing | **Delivered** | migration 013, `src/quotas/**`, `src/providers/providerRouter.js` |
| Circuit breakers, quarantine, emergency pause, owner alerts | **Delivered** | migration 014, `src/resilience/**` |
| Durable checkpoints and worker results | **Delivered** | migrations 015–016, `src/checkpoints/**`, `src/workers/**` |
| Deterministic JARVIS stage planners (outline → subtitles) | **Delivered** | `src/jarvis/deterministic*.js` + tests |
| Full deterministic content package through real workflow | **Delivered** | `src/jarvis/contentPackageOrchestrator.js` (PR #107) |
| AI News provenance-first research briefs | **Delivered** | `src/aiNews/deterministicResearchBrief.js` (PR #106) |
| AI News deterministic editorial plans from verified briefs | **Delivered** | `src/aiNews/deterministicEditorialPlan.js` + `docs/aiNews/EDITORIAL_PLAN_CONTRACT.md` |
| AI News deterministic metadata & thumbnail plans | **Delivered** | `src/aiNews/deterministicMetadataPlan.js` + `docs/aiNews/METADATA_PLAN_CONTRACT.md` |
| Evidence ledger (append-only, hash-chained) | **Delivered** | `src/evidence/evidenceLedger.js` |
| Promotion policy: one-Reel identity, main-video independence, affiliate rules | **Delivered** | `src/promotion/promotionPolicy.js` + tests |
| Publishing service (receipt verification, no fake IDs) | **Delivered** | `src/publishing/publishingService.js` + tests |
| Adversarial hardening: fuzzing, SQLi matrix, runbook | **Delivered** | `tests/adversarial/**`, `docs/RUNBOOK.md` (PR #105) |
| Media generation via approved free providers | **Not started** | Requires owner-configured provider capacity + secret-manager locators; routing/gating contracts are merged and ready |
| Live OAuth and platform publishing | **Not started** | Per Contract Rule 16: slots exist, all unconfigured; official-API adapter pending |
| Analytics ingestion and automatic optimization | **Not started** | Depends on live publishing |
| Comments/community management | **Not started** | Depends on live accounts |
| Postiz integration | **Not started** | AGPL; separate deployment + API adapter (Rule 11) |

## 4. Provider and fallback architecture (from the vision, enforced in code)

Sequence per task: cache/deterministic → approved free primary → secondary →
tertiary → local open-source emergency → truthful `WAITING_FOR_QUOTA`
checkpoint → scheduler resume. Enforced by `src/providers/**`, `src/quotas/**`,
`src/recovery/**`, and the dispatch admission/permit lifecycle under
`src/jarvis/*Dispatch*` + `docs/jarvis/*`. Hard constraints baked in: no
billing, no overage, no account rotation, no unofficial browser automation.

## 5. Publishing and monetization rules (owner-gated)

- Publishing requires an unexpired owner approval bound to the exact artifact
  hash, destination, caption, affiliate links, and disclosure (Rule 7).
- One standalone Reel per product/service identity; failures create versions,
  not duplicates (Rule 8). Main-video promotion is a separate owner decision
  (Rule 9). Affiliate links: HTTPS, disclosed, allowlisted domains.
- Private-first uploads; receipts are stored only from real platform responses.

## 6. What must never happen (standing prohibitions)

Fake media/receipts/IDs/analytics · placeholder passing verification ·
plaintext secrets in DB/code/logs · cross-agent credential sharing ·
internal agent names in public output (Rule 15) · billing/paid overages ·
unofficial platform automation · editing applied migrations (R1) ·
claiming verification without durable evidence (Rule 1).

## 7. Roadmap from current state to fully operational ST

1. **Owner secret-manager + provider capacity onboarding** — configure the
   three private provider slots per agent with `vault://`-style locators;
   wire live quota snapshots into the dispatch admission path.
2. **Media adapters** — TTS (Edge-TTS/Piper class), image, and FFmpeg assembly
   behind the worker contracts; FFprobe-verified artifacts only.
3. **Owner dashboard completion** — surface the catalog, charters, package
   runs, approvals, and evidence timeline through the authenticated API.
4. **Publishing path** — owner-configured OAuth via official APIs/Postiz;
   private-first first, live only after explicit owner approval.
5. **Analytics + optimization loop** — real platform analytics ingestion;
   no locally invented metrics, ever.
6. **Scale-out** — proven JARVIS workflow templates are reused per-agent
   (the orchestrator pattern generalizes); 20 → 50 agents by catalog design.

## 8. Operating model (who does what)

- **Owner**: approvals, credentials, publishing authorization, policy changes.
- **Coding agents (Jules / night-shift / Freebuff)**: governed slices via
  issues + lanes, tests + docs + CI evidence, one PR in flight, serialized merges.
- **CI / referee**: exact-head verification, independent merge gating.
- **Autopilot runtime (future)**: scheduler + workers on cloud compute,
  resuming from checkpoints; never bypasses owner gates.
