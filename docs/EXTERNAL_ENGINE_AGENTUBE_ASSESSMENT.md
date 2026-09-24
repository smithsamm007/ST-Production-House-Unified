# Assessment & Integration Record: AgentTube (darkzOGx/youtube-automation-agent)

Assessment date: **2026-09-24**. All claims below were verified directly
against the GitHub API for the repository — not from its README alone.

## Ground-truthed repository facts

| Fact | Verified value | Source |
|---|---|---|
| Repository | `darkzOGx/youtube-automation-agent` | GitHub API `repos/...` |
| Default branch | `master` | GitHub API |
| License | **MIT** ("Copyright (c) 2025 YouTube Automation Agent Contributors") | `LICENSE` file |
| Version | v2.10.0 (`package.json`) | contents API |
| Last push | 2026-09-21 | GitHub API |
| Stars | 3,709 | GitHub API |
| PR #40 "fix: bind dashboard to loopback by default" | **OPEN / unmerged** — its own body states the dashboard binds `0.0.0.0` with no auth middleware | pulls API |

## Assessment

The external engine is a serious, production-oriented **single-channel**
YouTube automation application (research → script → thumbnail → SEO →
production → upload → analytics, approval-gated publishing, checkpoints,
provider fallback). But:

- **It is not a multi-director production house.** Its architecture centers
  on ONE autonomous channel; ST requires up to 50 independent Directors each
  owning brand, universe, memory, queue, publishing, and analytics (Master
  Blueprint §§1–12). It cannot replace ST.
- **Its master is not fully hardened.** The dashboard-binding and dashboard
  auth concerns are still open work upstream (PR #40 open at assessment).
- **Its CI is minimal** (`npm ci; npm run lint; npm test`) — it does not
  establish live-provider, 24/7, or multi-channel production claims.
- **ST's own evidence bar is stricter than upstream's.** ST Rule 1 requires
  durable evidence for every provider/render/upload/publish claim; the engine
  cannot self-certify its results.

**Verdict: reference implementation and optionally an external production
engine behind an adapter — never a replacement for the ST control plane.**

## ST integration (what this repo now contains)

Per AGENTS.md Rule 10 (third-party projects behind adapters; never paste whole
repositories) and `docs/REPOSITORY_AUDIT_AND_REUSE.md`, the integration is a
**pure boundary module** — no upstream source was copied
(`AGENTUBE_PROVENANCE.copiedSourceFiles === 0`):

- `src/integrations/agenticProductionEngine.js`
  - Frozen provenance record (repo, license, version, date, zero copied files).
  - Capability catalog mirroring the upstream pipeline stages
    (`research.strategy` … `shorts.repurposing`), including the approval gate.
  - Job envelope validation requiring full tenant isolation (agentId,
    agentName, namespace, channelSlug, channelDisplayName) — fail-closed.
  - Immutable adapter registry (registration returns a NEW frozen registry).
  - Evidence-gated execution (`runAgenticProductionEngineJob`): an engine run
    counts as `succeeded` ONLY when the ST evidence ledger confirms the
    receipt, and the result must pass the existing `validateWorkerResult`
    contract (artifact URI + SHA-256). No new status states (R5), no secrets
    (Rule 17), no network I/O in the module itself.
- `tests/agenticProductionEngine.test.js` — 17 offline unit tests covering
  envelope validation, tenant-field isolation, registry immutability, the
  evidence gate (missing/unverified/failed lookups), and artifact-hash
  enforcement.

## What was NOT done, deliberately

- No upstream code, agents, or runtime was merged into ST.
- No network calls were added (verified by the repo lint/audit suite).
- No new dependencies, no migrations, no status-enum changes.
- No live provider, upload, or publishing behavior is claimed or enabled —
  live publishing remains pending per contract Rules 7/11/16.
