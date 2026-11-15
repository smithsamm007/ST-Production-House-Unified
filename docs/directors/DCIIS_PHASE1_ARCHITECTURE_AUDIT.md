# DCIIS — Phase 1 Read-Only Architecture Audit & Implementation Design

**Mode:** read-only audit. No source, schema, backlog or Director changes were made.
**Companion:** `docs/directors/DCIIS_IMPLEMENTATION_PLAN.md` (earlier plan; this document supersedes its findings).

## 1. Baseline (observed facts)

| Item | Value |
|---|---|
| Repository root | `/workspace/chats/667cb2f7559fb89f55d7382a` |
| Remote | `https://github.com/smithsamm007/ST-Production-House-Unified.git` (single remote `origin`, fetch+push) |
| Branch | `repair/279-current-main` |
| HEAD SHA | `8a5c9bfd8088cfe939bbbf51ab3cb446cd16009d` (docs: DCIIS plan) |
| Working tree | one Owner-owned modification: ` M automation/backlog/lifecycle.json` (blob `d20b7ab`, never staged) |
| Local `origin/main` | `0b73d940e6cf9482812a898475c5f34ac15855b0` (10 Nov) — **stale**; the audited baseline is `a593bfa` (13 Nov, per Owner report) |
| Open PRs | **unavailable from this environment**: `gh` is installed but unauthenticated (`gh auth login` required), and no token is provided. Owner report states 0 open PRs |
| Base commits | `a593bfa` (#279 registry), `080c54d` (#278 publishing refusal) |
| Local commits on branch | `4e7de81` merge-gate/F1/D1, `46b1f2d` rehearsal, `8a5c9bf` plan — unpushed, no PR (single-PR rule respected) |
| Backlog | `automation/backlog/slices.json`: 28 slices, `lifecycle.json` promotes **24**; open = 4 owner-gated LIVE slices only |

Assumption stated explicitly: the Owner report's `a593bfa` is treated as current `main`; this environment cannot verify the remote head.

## 2. Architecture discovered (confirmed against source)

```
Owner (dashboard / Android, session + CSRF)
  → src/catalog/server.js  (express, authenticateOwner, requireCsrf, audit)
      → /api/directors/:agentId/(conversation|roadmap|memory)   sql/021
      → /api/scheduling, /api/connections, /api/social, /api/youtube
  → Hermes: src/manager/hermesManager.js, hermesJobBridge.js, hermes_decisions (sql/023)
      → production.start → production_releases + job (durable lease)
  → Pipeline: src/pipeline/* (stage handlers), src/orchestration/pipelineController.js
  → Media: src/media/* adapters + executors (TTS, visual, motion, FFmpeg, FFprobe)
  → Packaging/QC: src/pipeline/packagingQc.js (versioned gates)
  → Evidence: src/evidence/evidenceLedger.js (append-only hash chain)
  → Publishing: src/publishing/* (destination router; unwired platforms refuse)
```

Creative-intent layer, which DCIIS must extend rather than duplicate:

- `src/catalog/creativeCharter.js` — **in-memory** versioned charter registry:
  `createDraftCharter`, `createNewCharterVersion`, `submitCharterForOwnerApproval`,
  `approveExactImmutableVersion`, `activateApprovedVersion`, `assignCharterToInternalAgent`,
  `updateAssignment`, `retrieveActiveCharter`, `generateSanitizedWorkerContext`,
  `computeSnapshotHash`, `initializeSeedState`.
- `sql/004_creative_charter.sql` — `creative_charters`, `creative_charter_versions`
  (`version_no`, `snapshot jsonb`, `snapshot_hash char(64)`, unique active index),
  `agent_charter_assignments` (`revision`, unique active per agent), `owner_charter_approvals`.
  **No source file queries these tables** — the schema is unwired; the registry is a Map.

## 3. DCIIS capability inventory

Legend: I+V = implemented and verified · I-NV = implemented, not verified · PARTIAL · BLOCKED · NONE.

| # | Capability | Status | Evidence |
|---|---|---|---|
| 1 | Director identity & universe config | PARTIAL (I-NV) | `creativeCharter.js:67` `createDraftCharter(ownerId,{name,vision,defaultLanguage,secondaryLanguage})`; `agent_charter_assignments` (sql/004:47); seeds only `agent-01`, `agent-03` (`initializeSeedState:337`, `ownerServer.js:153`); no create/edit API (only `GET /charters`) |
| 2 | Creative mission & specialization | PARTIAL | `vision` free text only; no mission/specialization field in `creative_charters` (sql/004:14-27) |
| 3 | Genre catalogue & assignments | NONE | No table/route; only free-text `genresAndThemes` inside the snapshot (`creativeCharter.js:349`, `sql/006:61`) |
| 4 | Primary / secondary genres | NONE | no column, no validation |
| 5 | Niche catalogue & assignments | NONE | `niche_reference_profiles` (sql/005:68) is *evidence about references*, not a taxonomy; no `niche_id` anywhere in `src/` |
| 6 | Sub-niche / micro-niche hierarchy | NONE | absent |
| 7 | Custom genres / niches | NONE | absent |
| 8 | Themes & attributes | PARTIAL | `genresAndThemes` free-text array; no categories, no attribute model |
| 9 | Award metadata & evidence | NONE | `grep -ri award src sql` → **zero** results |
| 10 | Content formats & platform profiles | PARTIAL | `ASPECT_RATIOS` (`assemblyPlan.js:56`), `REEL_ASPECT_RATIOS` (`reelPlan.js:46`), `VISUAL_ASPECT_RATIOS` (`visualAdapter.js:65`), `SUBTITLE_FORMATS`/`METADATA_KINDS` (`packagingQc.js:78-81`), `publish_destinations` (sql/020); no Director-level format assignment |
| 11 | Language catalogue & locale ids | NONE | `channels.language text ≤80` (sql/019), charter `default_language`/`secondary_language` (sql/004:8-9) as free text ("Hindi","Hinglish"); `grep bcp47\|locale` → **zero** |
| 12 | Independent language roles | NONE | `grep dubbing` → zero; no role model |
| 13 | Primary language validation | PARTIAL | `default_language` exists but no configured set to validate membership against, and no API |
| 14 | Independent multilingual productions | NONE | `channels.language` is single-valued; one release → one language today |
| 15 | Original + dubbing workflow | NONE | absent (also no dubbing provider adapter) |
| 16 | Hybrid mode | NONE | absent |
| 17 | Regional / cultural localisation | NONE | absent |
| 18 | Audience configuration | PARTIAL | `director_memory_entries.category='audience_insights'` jsonb (sql/021:66-71; `directorWorkspaceRepository.js:34`) — unstructured |
| 19 | Production standards & boundaries | PARTIAL | memory categories `visual_identity`/`voice_identity`/`music_identity`; versioned `PACKAGING_VERSION`, `QC_GATE_VERSION` (`packagingQc.js:54-55`); nothing configurable per Director |
| 20 | Hermes identity retrieval | NONE | `hermesJobBridge.js:63` allowlist `channelId,title,season,episode,episodeDurationSeconds`; only `directorScheduleProvider` is injected (`:101`) |
| 21 | Team-level config consumption | PARTIAL | `generateSanitizedWorkerContext` (`creativeCharter.js:275`) exposes vision + languages + `{universeType,narrator,sourceCategories,lazyHierarchy,bibleSummary}`; **not** called by stage execution (`createStageExecutionContext({release,stage,stageInputs})`, `executorIntegration.js:50`); `genresAndThemes` excluded from the allowlist |
| 22 | Production-level overrides | NONE | no override table/route; `production_releases` has no creative columns |
| 23 | Configuration inheritance | NONE | only precedent is schedule fallback (`directorScheduleProvider`) |
| 24 | Configuration version history | I-NV (in-memory) | `createNewCharterVersion`, `approveExactImmutableVersion`, `snapshot_hash` + unique-active index (sql/004:29-47), `assignment.revision`; tests in `tests/creativeCharter.test.js` (233 lines); **no DB persistence path** |
| 25 | Analytics by genre/niche/language | PARTIAL | `AnalyticsService` (`analyticsService.js:45`) + `owner_analytics_records` (sql/027); no creative dimensions |

**Design consequence:** the only real foundation is the charter lifecycle (versioning, owner approval, per-agent assignment, sanitised context). DCIIS must add the taxonomy + language model + production overrides and wire the existing charter snapshot to structured rows — not build a second identity system.

## 4. Existing Director compatibility

| Director | Key | Active charter | Languages stored | Notes |
|---|---|---|---|---|
| JARVIS | `agent-01` | yes (seeded) | Hindi (default), Hinglish (secondary) | `genresAndThemes`: horror, suspense, thriller, supernatural mystery, curses, crime, emotion, entertainment |
| SHERLOCK | `agent-02` | none | — | no creative config |
| LAKME | `agent-03` | yes (seeded) | Hindi | mythology snapshot, `sacredTerminology` text |
| COSMOS…BUTTERFLY, agent-04…agent-20, agent-21 | — | none | — | 21 agents total in `agents`; only 2 have charters |

Hardcoded assumptions found: `generatedWorkerContext` allowlist; `initializeSeedState` hardcodes "Hindi"/"Hinglish"; `ownerServer.js:153-154` reads exactly `agent-01` and `agent-03`; canonical registry (sql/032) has **0 rows**, so canonical codes cannot key anything yet.

**Adoption strategy (backward compatible):** identity rows are created lazily per agent; existing charter `vision` → `creative_mission`; `default_language`/`secondary_language` → language rows + roles `original`/`publishing`; `genresAndThemes` free text → **proposed** genre assignments surfaced for Owner confirmation (never auto-mapped as fact). No rename, retire, reactivate or remap of any Director; no change to `lifecycle.json`.

## 5. Proposed database design (no migration created)

Numbering: **033/034 stay reserved** for registry legacy-retirement and seed. DCIIS = **035** (taxonomy) + **036** (identity/overrides).

`sql/035_creative_taxonomy.sql`
```
languages(id, bcp47 UNIQUE, display_name, native_name, script, status)
language_locales(id, language_id FK, bcp47_locale UNIQUE, region, status)
creative_genres(id, slug UNIQUE, name, category, description, is_system, status, owner_id NULL)
creative_niches(id, parent_id FK NULL, genre_id FK NULL, slug UNIQUE, name, category,
                depth SMALLINT CHECK (depth BETWEEN 1 AND 3), is_system, status, owner_id NULL)
creative_attributes(id, slug UNIQUE, kind CHECK IN ('emotional','storytelling','descriptive','award'),
                    name, description, is_system, status, owner_id NULL)
creative_formats(id, slug UNIQUE, name, aspect_ratio, default_duration_seconds, is_system, status)
```
Indexes: `creative_niches(parent_id)`, `creative_genres(category)`, `languages(status)`.
Seeds idempotent (`ON CONFLICT DO NOTHING`); system rows immutable via API.

`sql/036_director_creative_identity.sql`
```
director_creative_identities(id, owner_id FK owners ON DELETE CASCADE,
  agent_id FK agents, canonical_director_code NULL, universe_id NULL,
  creative_mission, specialization, production_mode CHECK IN
  ('independent','original_plus_dubbing','hybrid'),
  primary_language_id FK languages NULL, primary_genre_id, primary_niche_id,
  standards JSONB DEFAULT '{}', config_version INT DEFAULT 1, status,
  created_at, updated_at, UNIQUE(owner_id, agent_id))
director_identity_genres(identity_id, genre_id, PK(identity_id,genre_id))
director_identity_niches(identity_id, niche_id, PK(...))
director_identity_attributes(identity_id, attribute_id, PK(...))
director_identity_formats(identity_id, format_id, PK(...))
director_identity_languages(identity_id, language_id, role, locale_id NULL,
  PK(identity_id, language_id, role))
  role CHECK IN ('original','independent','dubbing','subtitle','scriptwriting','dialogue',
                 'narration','voice','thumbnail_text','metadata','publishing')
director_identity_regions(identity_id, country_code, region_code NULL, cultural_context JSONB,
  PK(identity_id, country_code, region_code))
director_identity_audiences(identity_id, audience_code, maturity_rating, notes,
  priority CHECK IN ('primary','secondary'), UNIQUE(identity_id, audience_code))
director_identity_versions(id, identity_id, version, snapshot JSONB, snapshot_hash,
  changed_by, created_at, UNIQUE(identity_id, version))
production_creative_overrides(id, owner_id, production_release_id FK,
  identity_id FK, overrides JSONB, original_language_id, target_language_ids JSONB,
  config_version, created_at, UNIQUE(production_release_id))
production_localisations(id, override_id FK, language_id FK, status CHECK IN
  ('requested','blocked','in_progress','complete','failed'), evidence_ref NULL,
  UNIQUE(override_id, language_id))
```
Ownership: `owner_id` on identity/override; every child row reachable only through its identity.
Audit: version snapshot + hash on every mutation (same pattern as `creative_charter_versions`);
`changed_by` = owner id. Rollback: each migration wrapped in `BEGIN/COMMIT`; 036 is additive only,
and dropping 036 restores the 035 state with no data loss to pre-existing tables.

**Migration conflict:** the `pg_type` lookup in `sql/032:44` is not schema-qualified, so any
database that already owns `canonical_director_status` in another schema fails 032
(reproduced locally on PG 15.20; fix proven, not applied — awaiting Owner decision). DCIIS
migrations cannot be validated on a chain that fails multi-schema restore.

## 6. Proposed API contracts (extend `src/catalog/server.js` conventions)

| Method | Route | Auth | Notes |
|---|---|---|---|
| GET | `/api/directors/:agentId/identity` | session | 404 `DIRECTOR_IDENTITY_NOT_FOUND` |
| PUT | `/api/directors/:agentId/identity` | session+CSRF | full replace, `expectedConfigVersion` optimistic lock |
| GET | `/api/directors/:agentId/identity/versions` | session | history |
| GET | `/api/taxonomy/{genres\|niches\|attributes\|formats\|languages}` | session | `?q=` search, `?category=`, system+custom |
| POST | `/api/taxonomy/{genres\|niches\|attributes}` | session+CSRF | custom only; system rows → `SYSTEM_ENTRY_IMMUTABLE` |
| PUT | `/api/directors/:agentId/identity/languages` | session+CSRF | role matrix |
| PUT | `/api/productions/:id/creative-override` | session+CSRF | rejects protected keys |
| GET | `/api/productions/:id/effective-configuration` | session | resolved + provenance |

Validation (server-side): BCP-47 shape `^[a-z]{2,3}(-[A-Z]{2})?$`; primary ∈ configured genres/niches/
languages; niche depth ≤ 3 with existing parent; duplicates rejected by PK; `owner_id` from session
only; stable error codes; audit event on each mutation.

## 7. Proposed setup wizard (new UI; none exists today)

Ten-step panel inside `public/dashboard.js` (steps 1–10 as specified), searchable multi-selects,
primary selectors, expandable niche tree, language-role matrix, custom-entry dialogs, unsaved-change
guard, optimistic-concurrency error handling, review step renders the **server-resolved** config.
Android summary deferred to #258.

## 8. Hermes & team integration (smallest safe changes)

1. `createHermesJobBridge({ directorIdentityProvider, effectiveConfigProvider })` — same pattern as
   the existing `directorScheduleProvider`; no I/O inside the bridge.
2. Allowlisted `creativeContext` in the decision payload, validated by `assertDecisionPayloadSafe`.
3. Language-role tasks are queued only for roles configured **and** backed by a provider entry in
   `src/providers/**`; otherwise `CAPABILITY_UNAVAILABLE` (no silent skip).
4. Stage plumbing: `createStageExecutionContext({..., creativeContext})` (additive field); each
   stage stamps `configVersion` into its artifact/evidence record.
5. Localisation completion only on durable artifact verification (`evidence_ref`), per language.

## 9. Backlog mapping

No READY slice covers DCIIS (28 slices; 24 promoted; open = `S-M20-LIVE`, `S-M19-LIVE`,
`S-M24-LIVE`, `S-M26-LIVE`, all owner-gated). **Recommendation: one new canonical slice**
`S-M21-…`/`S-M22-…` (owner to assign the id) titled *"Director Creative Identity & multilingual
configuration"*, lane-3, `ownerGated: false`, depending on the registry cutover. Backlog files were
**not modified**; the slice record must be added by the Owner or a governed feed step.

## 10. Dependency-aware roadmap

| Phase | Scope | DB | API | UI | Hermes | Teams | Stop condition |
|---|---|---|---|---|---|---|---|
| D0 | Decide 032 remediation; settle identity key (agent_id) and numbering 035/036 | — | — | — | — | — | Owner approval |
| D1 | 035 taxonomy + seeds | ✓ | — | — | — | — | PG 15 apply/re-apply/rollback green |
| D2 | 036 identity/overrides + repository | ✓ | — | — | — | — | PG integration green |
| D3 | API + validation + audit | — | ✓ | — | — | — | auth/isolation tests green |
| D4 | Dashboard wizard | — | ✓ | ✓ | — | — | build + manual smoke note |
| D5 | Hermes context + routing | — | ✓ | — | ✓ | — | no false capability/localisation |
| D6 | Stage context plumbing | — | — | — | ✓ | ✓ | pipeline tests green |
| D7 | Overrides + localisation tracking | ✓ | ✓ | ✓ | ✓ | ✓ | inheritance + protected-key tests |
| D8 | Verification | — | — | — | — | — | `npm test`, `lint`, `verify`, `plan:check`, `test:integration` |
| D9 | Docs (R7) | — | — | — | — | — | docs updated in same PR |

Readiness vs operation: D1–D8 make the capability **implemented and verified** as configuration and
orchestration. Provider availability (dubbing, voice, translation, publishing) stays **unverified**
and is reported per language, never inferred.

## 11. Risks / blockers

1. **032 multi-schema defect** — blocks migration verification; decision pending.
2. **In-memory charter registry** — persistence gap means version history is not durable; DCIIS
   must not assume charter durability until sql/004 is wired (separate slice or D2 extension).
3. **Canonical registry empty** — identity cannot key on canonical codes today.
4. **Single-PR-in-flight** — this branch already carries three unpushed commits; DCIIS work should
   not start until they are pushed/merged or explicitly branched.
5. **No wizard, vanilla-JS SPA** — UI cost is higher than the brief assumes.
6. **No open-PR visibility** from this environment (unauthenticated `gh`).

## 12. Files expected to change (when approved)

New: `sql/035_creative_taxonomy.sql`, `sql/036_director_creative_identity.sql`,
`src/catalog/creativeTaxonomy.js`, `src/catalog/directorCreativeIdentity.js`,
`src/catalog/directorCreativeIdentityRepository.js`, `src/api/directorIdentityRouter.js`,
`src/api/taxonomyRouter.js`, `tests/creativeTaxonomy.test.js`,
`tests/directorCreativeIdentity.test.js`, `tests/directorIdentityApi.test.js`,
`tests/directorIdentityPostgres.integration.js`, `samples`/seed data module,
docs updates (`docs/directors/CANONICAL_DIRECTOR_REGISTRY.md`, new `DCIIS.md`).
Modified: `src/catalog/server.js` (mount), `public/index.html`, `public/dashboard.js`,
`public/styles.css`, `src/manager/hermesJobBridge.js`, `src/pipeline/executorIntegration.js`,
`package.json` (`test:integration` list), `ROADMAP.md` (task line, if Owner approves a new task).

## 13. Verification plan

`npm test` · `npm run lint` · `npm run verify` · `npm run plan:check` · `npm run test:integration`
against the disposable PG 15.20 (already running) · new migration apply/re-apply/rollback ·
two-schema isolation regression (once 032 is fixed) · authorization/isolation matrix ·
negative capability tests (no provider ⇒ `CAPABILITY_UNAVAILABLE`) · no external calls in tests.

## 14. Audit boundary

Nothing was implemented, executed, migrated, published or called. `sql/`, `src/`, `tests/`,
`public/`, `automation/` are unchanged. The only untracked addition is this report (committed with
`8a5c9bf` for the plan and this file).
