# ST Production House Unified (Android)

Android Owner Console and Control Plane for ST Production House, written in Kotlin with Jetpack Compose and Material Design 3.

## Repository architecture (two coexisting territories)

This repository hosts:

1. **The Android owner console** (`app/**`, Kotlin/Jetpack Compose, Material 3) — restored as an intentional pivot in October 2026. It currently renders the owner-console surfaces over local demo fixtures and is being wired to the Node control plane below as its authenticated backend.
2. **The Node.js control plane** (`src/`, `tests/`, `sql/001–031`, `server.js`, `public/` dashboard, `scripts/`, `automation/`, root manifests) — the production backend with PostgreSQL migrations, authenticated owner API (Argon2id + sessions + CSRF), leased workers, deterministic media pipeline, publisher adapters, and the autonomous backlog lifecycle. Recovered in the Phase-0 regression recovery (issue #245) after an AI-Studio sync accidentally deleted the backend, and now preserved by an automated repository-territory guard (`docs/TERRITORY_GUARD.md`) that fails CI on unapproved backend deletions.

The two territories are kept separate in CI: Android app syncs must not delete backend paths, and backend changes must not touch the app tree.

## Overview

ST Production House Unified is the secure, multi-director control plane for managing an autonomous AI-powered animation and episodic production house. It consolidates creative charters, channels, media pipelines, scheduling, provider slots, and publishing gates with strict zero-trust honesty.

### Key Capabilities

1. **Command Center (Overview)**:
   - Live metrics: active jobs, live channels, registered directors, and storage status.
   - 8-stage production pipeline visualization (`story` → `visual` → `audio` → `assembly` → `reels` → `packaging` → `qc` → `complete`).
   - Active production releases with real-time stage progress and stage advance triggers.
   - Director channels summary with the 4 canonical media slots (`main_video`, `content_reel_1`, `content_reel_2`, `brand_reel`).

2. **Director Channels Registry**:
   - Public channel branding (Midnight Horror Studios, Epic Mythology Labs, Case Notes Anime, Newton Explains).
   - Agent Name Internal-Only Rule (Rule 15): Internal director identifiers (JARVIS, LAKME, SHERLOCK, NEWTON, etc.) stay strictly internal and never leak into public branding.
   - Registered agent capacity tracking (21 registered out of hard cap 50).
   - Add new channels with custom slugs, languages, and launch titles.

3. **Episode & Production Scheduling (sql/029)**:
   - Per-director schedule management:
     - Main episode duration (30m, 40m, 50m).
     - Episodes per day (1 to 6).
     - Production days configuration with presets ("Every day", "Mon–Fri").
     - Preferred start time and IANA timezone (`Asia/Kolkata`, `UTC`, `America/New_York`, etc.).
     - Enabled / Paused status toggle.
   - Plan Preview (dry-run without creating jobs).
   - "Run Scheduler Now" to queue the next due episode slot respecting quotas.

4. **Director Communication Studio**:
   - Dedicated communication window per director.
   - Semantic message categorization: `conversation`, `proposal`, `instruction`, `decision`.
   - Sender attribution (`owner` vs `director`).
   - Real-time message thread with audit event generation.

5. **Director Memory & Creative Charters**:
   - Logline, universe premise, visual style, pacing, and target audience.
   - Non-negotiable character continuity rules.

6. **Production Pipeline & QC Gate**:
   - Step-by-step pipeline execution through all 8 stages.
   - Launch new production releases with channel, season, and episode.
   - Quality gate verification before release certification.

7. **Active Jobs & Lifecycle Control (sql/010 + 017)**:
   - Full lifecycle states: `queued`, `running`, `waiting_for_quota`, `waiting_for_approval`, `succeeded`, `failed`.
   - Real-time job controls: Pause, Resume, and Cancel.

8. **Provider Status & Quotas (Rule 5)**:
   - 3 private remote slots + 1 local open-source emergency slot per task policy.
   - Visual, Narration, Assembly, and Publisher monitoring with latencies and quota usage.

9. **Publishing Approvals (Rule 7)**:
   - Live publishing requires explicit owner approval bound to the exact artifact SHA-256 hash, destination, caption, disclosure, and affiliate links.
   - Approve & Reject actions.

10. **Evidence Ledger (Rules 1 & 2)**:
    - Immutable audit trail of every inspection, synthesis, assembly, approval, and channel registration.
    - Real verification receipts and cryptographic hashes.

11. **Hermes AI Manager**:
    - AI Manager decisions and Authority Matrix (Tier 1 Autonomous, Tier 2 Policy Governed, Tier 3 Owner Required).

12. **Settings & Opaque Secrets (Rule 4 & 17)**:
    - Session management, demo storage mode, and secret manager locators (`vault://...`).

## Tech Stack

- **Platform**: Android SDK 36, Min SDK 26, JDK 21
- **UI Framework**: Jetpack Compose with Material Design 3 (M3)
- **Language**: Kotlin 2.2.21
- **Build System**: Gradle 9.3.1 with Android Gradle Plugin 9.1.1
- **Secrets Management**: Secrets Gradle Plugin reading `.env` / `.env.example`
