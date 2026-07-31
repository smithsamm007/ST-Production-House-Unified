# Implementation Roadmap

This repository is the verified secure foundation, not a claim that every live provider and platform is already connected.

## Phase 1 — Foundation (included)

- **Owner Authentication and Secure Control Plane API (Task 2)**:
  - Additive migrations 009 and 010.
  - Asynchronous, native Argon2id password authentication with timing leak protections.
  - Opake, database-hashed secure session tokens.
  - Multi-tier state machines, fixation prevention, sliding idle and absolute expiration.
  - Strict 30-minute CSRF token persistence, rotation, and revocation.
  - Direct database-backed TOTP MFA enrollment and elevation with anti-replay used code reservation.
  - Atomic single-use recovery code consumption.
  - Complete, transaction-safe API endpoints with explicit repository dependency injection.
  - Sanitize unhandled API errors returning Generic Error Code with Correlation IDs.
  - Complete live PostgreSQL 15 integration lifecycle test suite under a custom schema.
- **Agent Creative Charter and Channel Universe System**:
  - Relational schema tables added for `creative_universes`, `creative_charters`, `creative_charter_versions`, `agent_charter_assignments`, and hierarchy/entity registries.
  - Dynamic snapshot validation, immutable version control, and owner-approval state machine.
  - Only JARVIS and LAKME are initially active. The remaining 18 agents are inactive and unassigned.
  - LAKME mythology lazy hierarchy supporting 8,000+ episodes without database row explosion.
  - Internal names (JARVIS, LAKME, VEDA) strictly stripped from public brand attribution outputs.
- **Niche Reference and Visual Reference Library**:
  - Relational schema tables added for `creative_references`, `niche_reference_profiles`, `visual_reference_profiles`, `reference_scope_assignments`, `reference_analysis_attempts`, and approvals.
  - Separate Niche and Visual properties with dynamic URL verification, canonical duplicate detection, and sanitized context extraction.
- **Owner-Agent Communication Studio and Blueprinting**:
  - Relational schema tables added for `communication_sessions`, `communication_messages`, `blueprint_drafts`, `blueprint_versions`, `blueprint_decisions`, `blueprint_suggestions`, `blueprint_unresolved_questions`, `blueprint_validation_results`, and `blueprint_owner_approvals`.
  - Exactly 22 preloaded interactive interview catalog sections spanning Brand Voice, Aspect Ratios, CTA Styles, Soundscapes, and Parallel Job options.
  - Interactive Messaging Engine validating message types (`owner_decision`, `owner_question`, `agent_question`, `agent_suggestion`, `agent_explanation`, `validation_warning`, `system_status`) and strict sender matrices.
  - Unresolved question blockades that prevent blueprint draft versioning until addressed by the owner.
  - Automated 22-section validation and brand safety scanning (blocking words like 'unsafe' or 'unfiltered').
  - Recursive secret-leak sanitization on generated blueprint version snapshots.
  - Immutable Owner approvals that permanently lock the blueprint and deactivate edits.
- Canonical 20-agent registry with 50-agent cap.
- Three private remote providers plus local emergency policy.
- One-Reel product identity policy and independent main-video placement.
- **Agent Digital Identity and Connection Isolation**:
  - `agent_public_profiles`, `agent_email_connections`, and `agent_social_accounts` schema definitions.
  - Seeds 5 unconfigured slots (1 email, 4 social) for all 20 preloaded agents without fake credentials or addresses.
  - **Important Notice**: No real email addresses, live OAuth connections, or live social accounts are active yet. Live OAuth, SMTP, and social publishing remain pending.
- Affiliate URL/disclosure policy.
- Owner-approval and non-fabricated publishing receipt policy.
- PostgreSQL schema for durable jobs, leases, evidence, and receipts.
- Integration contracts and repository reuse/licensing decisions.

## Phase 2 — Runnable control plane (estimated 2–3 weeks)

- API, owner dashboard, Redis or PostgreSQL workers with leases, concurrency, and observability.
- Vault/KMS credential broker and per-agent task-provider configuration.

## Phase 3 — Real media workers (estimated 5–9 weeks)

- ViMax motion adapter with real provider contract tests.
- Story/continuity worker based on validated JARVIS concepts.
- Voice adapters for real Sarvam/Edge/local TTS with pronunciation review.
- MoneyPrinterTurbo-derived assembly, subtitles, music-rights registry, FFmpeg sandboxing, artifact storage, and FFprobe verification.

## Phase 4 — Promotion and publishing (estimated 3–5 weeks)

- Campaign intake, affiliate link security scanner, and disclosure templates.
- YouTube/Instagram/Facebook/Telegram/Snapchat destination configuration.
- Separate Postiz deployment and verified receipt reconciliation.
- Signed partner/catalog gateways, approval snapshots, and scheduling.

## Phase 5 — Hardening and release (estimated 3–5 weeks)

- End-to-end and failure-injection tests, provider sandboxes, load testing.
- Backups, restore drills, dead-letter recovery, cost/rate controls.
- Security review, dependency/SBOM scan, license and asset-rights review.
- Staging burn-in before controlled live publishing.

With two experienced engineers plus focused AI assistance, a credible production release is approximately 14–24 weeks. AI can reduce drafting and test-writing time, but provider approvals, security review, platform behavior, media quality evaluation, and staging cannot be safely compressed away.
