# Implementation Roadmap

This repository is the verified secure foundation, not a claim that every live
provider and platform is already connected.

## Phase 1 — Foundation (included)

- Canonical 20-agent registry with 50-agent cap.
- Three private remote providers plus local emergency policy.
- One-Reel product identity policy and independent main-video placement.
- Affiliate URL/disclosure policy.
- Owner-approval and non-fabricated publishing receipt policy.
- PostgreSQL schema for durable jobs, leases, evidence, and receipts.
- Integration contracts and repository reuse/licensing decisions.

## Phase 2 — Runnable control plane (estimated 3–5 weeks)

- API, owner dashboard, Argon2id/passkey authentication, CSRF, RBAC.
- PostgreSQL repositories and migrations wired to domain policies.
- Redis or PostgreSQL workers with leases, concurrency and observability.
- Vault/KMS credential broker and per-agent task-provider configuration.

## Phase 3 — Real media workers (estimated 5–9 weeks)

- ViMax motion adapter with real provider contract tests.
- Story/continuity worker based on validated JARVIS concepts.
- Voice adapters for real Sarvam/Edge/local TTS with pronunciation review.
- MoneyPrinterTurbo-derived assembly, subtitles, music-rights registry,
  FFmpeg sandboxing, artifact storage and FFprobe verification.

## Phase 4 — Promotion and publishing (estimated 3–5 weeks)

- Campaign intake, affiliate link security scanner and disclosure templates.
- YouTube/Instagram/Facebook/Telegram destination configuration.
- Separate Postiz deployment and verified receipt reconciliation.
- Signed partner/catalog gateways, approval snapshots and scheduling.

## Phase 5 — Hardening and release (estimated 3–5 weeks)

- End-to-end and failure-injection tests, provider sandboxes, load testing.
- Backups, restore drills, dead-letter recovery, cost/rate controls.
- Security review, dependency/SBOM scan, license and asset-rights review.
- Staging burn-in before controlled live publishing.

With two experienced engineers plus focused AI assistance, a credible
production release is approximately 14–24 weeks. AI can reduce drafting and
test-writing time, but provider approvals, security review, platform behavior,
media quality evaluation, and staging cannot be safely compressed away.
