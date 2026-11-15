# DCIIS — Director Creative Identity & Intelligence System

**Status:** Phase 1 discovery complete. **Plan only — no code changed.**
**Branch:** `repair/279-current-main` @ `46b1f2d` (based on `a593bfa`).

## 1. What the repository actually contains (inspected, not assumed)

| Area | Reality | Consequence for DCIIS |
|---|---|---|
| Director registry | `canonical_director_mappings` + `canonical_director_cap_lock` (`sql/032`), 10 frozen codes, **0 rows** — the seed is not implemented | A identity keyed on canonical codes cannot exist today |
| Agent identities | `agents` (`sql/001`, `sql/002`, `sql/018`): 21 rows, `agents_max_50` | The only key that exists for every Director right now |
| Creative charter | `creative_charters` (`sql/004`): `vision`, `default_language`, `secondary_language`, `revision`, `owner_charter_approvals` | Existing creative-intent store: **two** languages, no genres/niches, not per Director |
| Reference library | `niche_reference_profiles` (`sql/005`) | Niche *evidence*, not a niche taxonomy — do not overload |
| Director memory | `director_memory_entries` (`sql/021`): jsonb `visual_identity`, `voice_identity`, `music_identity`, `audience_insights` | Free-form context today; keep, and let identity be the typed source of truth |
| Channels | `channels.agent_id`, `channels.language` (single value) | Productions are single-language today; multilingual needs the identity model |
| Productions | `production_releases`, `pipeline_events`, `production_schedules` | The correct parent for production-level overrides |
| Hermes | `HermesManager`, `hermes_decisions` (`sql/023`), `hermesJobBridge.validateProductionStartPayload` accepts only `channelId/title/season/episode/episodeDurationSeconds` | No creative context reaches Hermes today; there is a clean injection precedent (`directorScheduleProvider`) |
| Owner API | `/api/directors/:agentId/(conversation\|roadmap\|memory)` in `src/catalog/server.js`, all behind `authenticateOwner` (+`requireCsrf` on writes) | Extend this surface; do not add a second server |
| Web UI | `public/index.html` + `public/dashboard.js` (1,928 lines, vanilla JS SPA), no router | **No Director setup wizard exists**; the wizard is new UI inside the existing dashboard |
| Android | `DirectorsScreen.kt` (264 lines, read-only channel list) | Out of scope here; tracked by #258 |
| Backlog | 28 slices, 24 promoted; open = the 4 owner-gated LIVE slices only | **No ready slice covers DCIIS** → this is a new slice (requirement 16 has no match) |

## 2. Design decisions this plan depends on (need Owner sign-off)

**D1 — Identity is keyed on `agent_id`, with canonical code as an optional binding.**
`director_creative_identities.agent_id REFERENCES agents(id)` plus nullable
`canonical_director_code`. Rationale: the canonical registry has no rows, so keying on it makes the
feature unshippable; `agents` exists for all 21 identities today. When the ten-Director cutover
lands, identity rows bind to their canonical codes without data migration.

**D2 — Migration numbering is a single ordered chain.** The registry work still owns
`033` (legacy retirement) and `034` (seed). DCIIS therefore starts at `035` and must not be
renumbered later; migrations 033/034 remain unstarted pending your decision on the 032 defect.

**D3 — Catalogues are data, not code.** Genres, niches, attributes, formats, languages and
locales are rows seeded idempotently, so new entries need no code change (request §4/§5/§9).
System rows are immutable through the API; custom rows are owner-scoped.

**D4 — No capability inference.** A configured dubbing/voice language is a *request*, never a
claim. Availability is read from `src/providers/**` + `src/credentials/**` and reports
`CAPABILITY_UNAVAILABLE` honestly. Localisation status is per language, per production, and only
becomes `complete` on a durable artifact.

## 3. Data model (proposed, additive, after 033/034)

`sql/035_creative_taxonomy.sql`

```
languages(id, bcp47, display_name, native_name, script, status)
language_locales(id, language_id FK, bcp47_locale, region, status)          UNIQUE(bcp47_locale)
creative_genres(id, slug UNIQUE, name, category, description, is_system, status, owner_id NULL)
creative_niches(id, parent_id FK NULL, genre_id FK NULL, slug, name, category,
                depth SMALLINT CHECK (depth BETWEEN 1 AND 3), is_system, status, owner_id NULL)
                -- depth 1 niche, 2 sub-niche, 3 micro-niche; CHECK prevents depth>3
creative_attributes(id, slug, kind CHECK (kind IN ('emotional','storytelling','descriptive','award')),
                    name, description, is_system, status, owner_id NULL)
creative_formats(id, slug, name, aspect_ratio, default_duration_seconds NULL, is_system, status)
```

`sql/036_director_creative_identity.sql`

```
director_creative_identities(
  id, owner_id FK owners, agent_id FK agents, canonical_director_code NULL,
  universe_id FK creative_universes NULL, creative_mission, specialization,
  production_mode CHECK IN ('independent','original_plus_dubbing','hybrid'),
  primary_language_id FK languages NULL, primary_genre_id, primary_niche_id,
  standards JSONB NOT NULL DEFAULT '{}',          -- visual/audio/video/research/boundaries
  config_version INT NOT NULL DEFAULT 1, status, created_at, updated_at,
  UNIQUE(owner_id, agent_id))
director_identity_genres(identity_id, genre_id, PRIMARY KEY(identity_id, genre_id))
director_identity_niches(identity_id, niche_id, PRIMARY KEY(identity_id, niche_id))
director_identity_attributes(identity_id, attribute_id, PRIMARY KEY(...))
director_identity_formats(identity_id, format_id, PRIMARY KEY(...))
director_identity_languages(identity_id, language_id, role, locale_id NULL,
  PRIMARY KEY(identity_id, language_id, role))      -- roles are independent (request §10)
director_identity_regions(identity_id, country_code, region_code NULL, cultural_context JSONB)
director_identity_audiences(identity_id, audience_code, priority CHECK IN ('primary','secondary'),
  maturity_rating, notes, UNIQUE(identity_id, audience_code))
director_identity_versions(id, identity_id, version, snapshot JSONB, changed_by, created_at)
production_creative_overrides(id, owner_id, production_release_id FK, identity_id FK,
  overrides JSONB, original_language_id FK languages, target_language_ids JSONB,
  config_version INT, created_at, UNIQUE(production_release_id))
production_localisations(id, override_id FK, language_id FK, status CHECK IN
  ('requested','blocked','in_progress','complete','failed'), evidence_ref NULL,
  UNIQUE(override_id, language_id))
```

Roles: `original, independent, dubbing, subtitle, scriptwriting, dialogue, narration,
voice, thumbnail_text, metadata, publishing`.

Guarantees: FK integrity, `UNIQUE` on every relationship (no duplicate assignments),
`owner_id` on every owner-visible row (tenant isolation), indexes on
`(owner_id, agent_id)`, `(identity_id, role)`, `creative_niches(parent_id)`; version bump and
snapshot written in the same transaction as any identity mutation.

## 4. Resolution / inheritance (pure, fail-closed)

`resolveEffectiveConfiguration(globalPolicies, directorIdentity, productionOverride)` in
`src/catalog/directorCreativeIdentity.js`:

- scalar precedence: production → Director → global default;
- set-valued fields (genres/niches/themes/formats/languages) replace rather than merge, and the
  result records which layer supplied each value;
- protected keys (`publishing_approval`, `security`, `qc_gates`, `ownership`, `credentials`)
  **cannot be overridden** — attempting it returns `OVERRIDE_NOT_PERMITTED`;
- every resolved object carries `configVersion` so artifacts can cite it.

## 5. API (extend existing routers and mounting conventions)

| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/api/directors/:agentId/identity` | PUT requires CSRF; validates primary ∈ configured, roles, hierarchy |
| GET | `/api/directors/:agentId/identity/versions` | history |
| GET | `/api/taxonomy/genres\|niches\|attributes\|formats\|languages` | search + category filter, system+custom |
| POST | `/api/taxonomy/genres\|niches\|attributes` | custom entries; `is_system` rows rejected |
| PUT | `/api/productions/:id/creative-override` | production-level override |
| GET | `/api/productions/:id/effective-configuration` | resolved view with layer provenance |

All: `authenticateOwner`, ownership check on every row, server-side validation (BCP-47 shape,
depth ≤ 3, duplicate rejection, enum closure), audit event per mutation, errors as stable codes.

## 6. Hermes and team integration

- Inject `directorIdentityProvider` into `createHermesJobBridge` (same shape as the existing
  `directorScheduleProvider`), plus `effectiveConfigProvider` for production overrides.
- Decision payload gains an allowlisted `creativeContext` (genres, niches, themes, formats,
  languages by role, mode, audience, configVersion) validated by `assertDecisionPayloadSafe`.
- Routing: niche → research brief; language roles → script/narration/subtitle/metadata tasks;
  provider support checked in `src/providers/**` before a language task is queued; unavailable
  capability ⇒ `CAPABILITY_UNAVAILABLE`, never a silent skip.
- Teams stamp `configVersion` + role/language into artifacts so QC and evidence can prove what was
  produced.

## 7. UI (new, inside the existing dashboard)

Steps 1–10 from the request as a tabbed panel in `public/dashboard.js`, reusing `styles.css`
conventions: searchable multi-selects, primary pickers, expandable niche tree, language-role
matrix, custom-entry dialogs, unsaved-change guard, explicit empty/loading/error states, keyboard
accessible. Review step renders the resolved configuration from the backend, not local state.

## 8. Tests (node:test, matching repo style)

Unit: taxonomy validation, custom-entry rules, hierarchy depth, BCP-47 rejection, duplicate
prevention, primary-language membership, role independence, override resolution + protected keys,
authorization/tenant isolation, version snapshot/history, Hermes context injection, capability
reporting. PG integration (`*.integration.js`, disposable PG 15): migrations 035/036 apply and
re-apply as no-op, constraints enforce, rollback leaves prior schema intact, identity CRUD +
history round-trip, override inheritance end-to-end.

## 9. Phases and gates

| Phase | Deliverable | Gate |
|---|---|---|
| 2 | 035/036 + seeds | PG 15 apply, re-apply, rollback |
| 3 | repository + API + validation | unit + PG integration |
| 4 | dashboard identity panel | build + manual smoke note |
| 5 | Hermes provider injection | unit tests, no false localisation |
| 6 | team context plumbing | pipeline tests |
| 7 | overrides + localisation status | inheritance tests |
| 8 | full verification | `npm test`, `lint`, `verify`, `plan:check`, `test:integration` |
| 9 | docs | R7 satisfied |

## 10. Open decisions before Phase 2

1. **032 defect**: approve amending 032 (schema-qualified `pg_type` check) or isolate the drill.
   DCIIS migrations cannot be validated against a migration chain that fails on multi-schema
   restore.
2. **D1**: accept `agent_id` as the identity key (recommended) or block until the canonical seed
   exists.
3. **D2**: confirm 035/036 numbering after the reserved 033/034.
4. **Scope**: Phase 2–3 (schema + API + tests) first as one reviewable unit, with the dashboard and
   Hermes wiring as follow-ups, or all phases in one branch.
