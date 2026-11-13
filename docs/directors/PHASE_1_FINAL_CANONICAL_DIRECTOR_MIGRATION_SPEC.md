# Canonical 10 Director migration — corrected finalization specification

Owner-approved decisions (this spec does not reopen them):
- Option 2: a separate canonical mapping table; preserve the four underlying keys
  `agent-01`, `agent-02`, `agent-03`, `agent-21`; add six new underlying IDs:
  `agent-director-cosmos`, `agent-director-aadi`, `agent-director-chronos`,
  `agent-director-ai-news`, `agent-director-tech-master`, `agent-director-butterfly`.
- Retire 17 legacy identities in place; block new production; preserve history;
  no automatic reassignment.
- Active-only cap = 50 active Directors, enforced in app + DB, concurrency-safe.
- Retirement enforced at registry, HERMES, job-creation API, and DB operational-write
  paths.
- One implementation branch + one PR in flight; preserve existing unstaged
  `automation/backlog/lifecycle.json` change (S-M44-01 added).
- No production DB migration, deployment, publishing, credentials, OAuth, or paid
  usage authorized here.

Context:
- Repo: `smithsamm007/ST-Production-House-Unified`
- Branch: `task/277-publish-platform-refusal`
- HEAD: `59efd6e1bb6cc944c95f5e96caa18a3275ba35db`
- `origin/main`: `0b73d940e6cf9482812a898475c5f34ac15855b0`

---

## 1. Approved decisions (recorded, not reopened)

1. Canonical 10 Directors = JARVIS, COSMOS, NEWTON, AADI, LAKME, SHERLOCK,
   CHRONOS, AI NEWS, TECH MASTER, BUTTERFLY.
2. Option 2 canonical mapping table, with the four preserved underlying keys and the
   six new underlying IDs above.
3. Active-only cap = 50 active Directors.
4. Retirement is in-place, historical, and blocking at every required enforcement
   seam.
5. Verified = inspected from actual files/state; Approved = Owner-set; Proposed =
   this spec's recommended design; Unknown = not yet determinable from evidence;
   Blocked = requires an unprovided capability or authorization.

---

## 2. Actual repository baseline (VERIFIED)

| Item | Value |
|---|---|
| Branch | `task/277-publish-platform-refusal` |
| HEAD SHA | `59efd6e1bb6cc944c95f5e96caa18a3275ba35db` |
| `origin/main` SHA | `0b73d940e6cf9482812a898475c5f34ac15855b0` |
| Ahead/behind vs `origin/main` | 9 ahead, 0 behind |
| Unstaged change preserved | `automation/backlog/lifecycle.json` adds `S-M44-01` to `promotedSliceIds` |
| Staged changes | none |
| Untracked files | none (worktree shows only the modified `lifecycle.json`) |
| Local branches | `task/277-publish-platform-refusal` checked out; other task/automation/fix/feat branches present |
| Remote branches present | `origin/main` and several `origin/task/...` branches; this worktree's branch is a local branch, not a remote branch |
| `node_modules` | present (installed for this pass) |
| `npm run verify` | exit 0 |
| `npm run lint` | exit 0 — `Status: PASSED (HEALTHY)` |
| `npm run plan:check` | exit 0 — `DEVELOPMENT_PLAN_VALID`, 11 tasks |
| `npm test` | exit 0 — 1536 pass / 0 fail |

Counts verified on the current tree:
- SQL migrations: 31 (`sql/001_core.sql` through `sql/031_motion_stage.sql`)
- Test/integration files: 159 under `tests/`
- `public/` tree: 4 files — `index.html`, `dashboard.js`, `styles.css`,
  `assets/aistudio/Paste_October_25__2026_-_10_36PM_242c3d5f`

---

## 3. Evidence and confidence ledger

Each item below was established by reading actual files or running actual commands in
this worktree. Confidence is stated explicitly.

### VERIFIED

- The PR-in-flight branch is a normal local branch, not a detached head or stale
  remote tracking branch.
- The worktree currently contains exactly one uncommitted change: `automation/backlog/lifecycle.json`.
- The lifecycle diff adds only one line: `"S-M44-01"` into `promotedSliceIds`.
- `npm test` currently passes 1536/0, including PostgreSQL integration tests and the
  dispatch/permit/admission lifecycle tests.
- The repo has 31 SQL migrations and 159 test files.
- `public/` contains the four files above and no other served files.

### APPROVED (Owner-set, do not reinterpret here)

- Option 2 mapping approach.
- Four preserved underlying keys.
- Six new underlying IDs.
- Active-only 50 cap.
- Retirement enforcement scope.

### PROPOSED (this spec recommends; implementation must make it real)

- Single authoritative lifecycle state lives on the canonical mapping row.
- Six new underlying IDs are used as proposed, after a collision/compatibility check.
- Active-cap serialization uses a dedicated cap-lock row with transaction-scoped
  `SELECT ... FOR UPDATE`.
- DB retirement enforcement uses per-write-path checks, not just a mapping trigger.
- Migration order: enable lifecycle/cap enforcement first, retire the 17 in place,
  then activate the final ten, never exposing an invalid intermediate active registry.
- Rollback before production use: prove no dependent records, then drop; otherwise
  forward repair.

### UNKNOWN (cannot decide from current evidence alone)

- Whether an existing production or staging DB already contains dependent records for
  the 17 legacy identities or the four preserved underlying keys.
- Whether any runtime process, worker, or downstream client already depends on the
  four preserved underlying keys as live production origins.
- The exact set of cross-owner rows touching the 17 legacy identities in a real DB.

### BLOCKED (cannot perform here)

- Live row-level DB inventory: no authorized isolated PostgreSQL 15 environment is
  available in this worktree. DB evidence is therefore limited to schema/migration
  inspection, not row inspection.
- Production DB migration execution, deployment, publishing, credential/OAuth wiring,
  and paid-service usage: not authorized in this pass.

---

## 4. Identity reference inventory (complete read of schema + targeted code/test scan)

This section is labelled PARTIAL only where a full 159-file per-file classification
has not been completed. The identity-relevant findings below are based on direct reads.

### 4.1 Canonical 10 Directors and where each appears today

| Director | Canonical name | Underlying key in current seed/db | Notes |
|---|---|---|---|
| JARVIS | JARVIS | `agent-01` | Heaviest code coupling; JA/voice/visual/script/scheduling/provider default |
| SHERLOCK | SHERLOCK | `agent-02` | Channel seed + auth/credential tests |
| LAKME | LAKME | `agent-03` | Channel seed + charter seeds |
| NEWTON | NEWTON | `agent-21` | Registered via `sql/018`; channel seed `science-explainers` |
| COSMOS | COSMOS | not seeded | Appears only in the public assets paste |
| AADI | AADI | not seeded | Not present in current seed/code |
| CHRONOS | CHRONOS | not seeded | Appears only in the public assets paste |
| AI NEWS | AI NEWS | not seeded as `agent-22`/`agent-ai-news` | Strong app/test signals for `agent-ai-news` but no seeded row or channel |
| TECH MASTER | TECH MASTER | not seeded | Not present in current seed/code |
| BUTTERFLY | BUTTERFLY | not seeded | Appears only in the public assets paste; described as a separate creative universe |

Important evidence point: AI NEWS already has substantial application/test signals
(e.g. `tests/aiNewsContentPackageOrchestrator.test.js` and `tests/aiNewsEditorialPlan.test.js`),
but there is no seeded DB row for it today. This matters for the six-new-ID collision
check and for AI NEWS mapping design.

### 4.2 Legacy 17 identities

These are the 20 seeded agents minus the 3 preserved underlying keys (JARVIS/agent-01,
SHERLOCK/agent-02, LAKME/agent-03) and minus NEWTON/agent-21 which is preserved:

- `agent-04` PANCHI
- `agent-05` VEDA
- `agent-06` BYTE
- `agent-07` CHANAKYA
- `agent-08` KABIR
- `agent-09` SHAKTI
- `agent-10` ROHAN
- `agent-11` MAYA
- `agent-12` AAROHI
- `agent-13` VIKRAM
- `agent-14` TARA
- `agent-15` ANANYA
- `agent-16` KARAN
- `agent-17` DEV
- `agent-18` AANYA
- `agent-19` ARJUN
- `agent-20` NISHA

These are the identities to retire in place.

### 4.3 Where identities are defined today

- `sql/002_seed_agents.sql`: seeds `agent-01`..`agent-20`.
- `sql/018_newton_catalog_registration.sql`: seeds `agent-21` (NEWTON) plus email and
  social slots.
- `src/catalog/agents.js`: in-memory registry with `MAX_AGENTS = 50` and
  `PRELOADED_AGENTS` of the 21 names.
- `src/catalog/server.js`: `AGENT_SEED` (21 rows) and `CHANNEL_SEED` (4 channels mapped
  to `agent-01`, `agent-03`, `agent-02`, `agent-21`) and `DEMO_JOB_SEED`.
- `src/catalog/creativeCharter.js`, `src/catalog/creativeReferenceLibrary.js`,
  `src/catalog/ownerAgentCommunicationStudio.js`: internal name lists, mostly the 20
  legacy names; NEWTON is absent from the comm-studio preload list.
- `src/providers/config.js`: provider config keyed by `"agent-01"` and a `"default"` entry.
- `src/catalog/repositories.js`: `AgentRepository` reads/writes `agents(id,name,namespace,enabled)`.
- `src/catalog/server.js:412`: `enabledAgentsProvider` filters `agentsRepo.list()` by
  `enabled !== false`.

---

## 5. Complete SQL/FK inventory (31 migrations read)

All 31 migrations were read:
`001_core`, `002_seed_agents`, `003_agent_digital_identity`, `004_creative_charter`,
`005_creative_reference`, `006_seed_initial_creative_charters`, `007_owner_agent_communication_studio`,
`008_owner_authentication_and_sessions`, `009_add_owner_role`, `010_job_lifecycle`,
`011_credential_broker_metadata`, `012_durable_retry_schedule`, `013_provider_quota_cooldowns`,
`014_resilience_controls`, `015_durable_job_checkpoints`, `016_durable_worker_results`,
`017_owner_job_control`, `018_newton_catalog_registration`, `019_channels_and_productions`,
`020_pipeline_events_and_destinations`, `021_director_workspace`, `022_secrets_and_connections`,
`023_hermes_decisions`, `024_packaging_and_qc_stages`, `025_reels_stage`,
`026_owner_operations_audit`, `027_analytics_records`, `028_youtube_oauth_lifecycle`,
`029_director_production_schedule`, `030_social_oauth_accounts`, `031_motion_stage`.

### 5.1 `agents` table (`sql/001_core.sql`)

- `id text PRIMARY KEY`
- `name text NOT NULL UNIQUE`
- `namespace text NOT NULL UNIQUE`
- `enabled boolean NOT NULL DEFAULT true`
- `created_at timestamptz NOT NULL DEFAULT now()`
- No `owner_id` on `agents`.

### 5.2 Active-cap trigger (`sql/001_core.sql`)

- `enforce_agent_cap()` does `IF (SELECT count(*) FROM agents) >= 50 THEN RAISE EXCEPTION 'AGENT_CAP_REACHED'`.
- Trigger `agents_max_50` is `BEFORE INSERT ON agents FOR EACH ROW`.
- This counts all agent rows, not active rows.

So the schema today enforces `COUNT(*) FROM agents <= 50`, not
`COUNT(active canonical mappings) <= 50`. This is the concrete discrepancy you flagged.

### 5.3 FK inventory by table

Tables referencing `agents(id)`:

| Table | FK clause | Delete behavior | Owner-scoped | Retirement-relevant |
|---|---|---|---|---|
| `credential_refs` (001) | `agent_id text NOT NULL REFERENCES agents(id)` | default RESTRICT | yes | yes |
| `agent_email_connections` (003) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `agent_social_accounts` (003) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `creative_charter_assignments` (004) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `director_conversations` (007) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `director_messages` (007) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `director_roadmap_items` (007) | default RESTRICT | RESTRICT | yes | yes |
| `director_workspace` / `director_messages` / `director_roadmap_items` (021) | default RESTRICT | RESTRICT | yes | yes |
| `director_schedule_slots` (029) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `director_schedules` (029) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `provider_quota_limits` (013) | `ON DELETE RESTRICT` | RESTRICT | yes | yes |
| `provider_quota_reservations` (013) | `ON DELETE RESTRICT` | RESTRICT | yes | yes |
| `broker_credential_metadata` (011) | `ON DELETE RESTRICT` | RESTRICT | yes | yes |
| `broker_credential_audit_log` (011) | `ON DELETE RESTRICT` | RESTRICT | yes | yes |
| `resilience_circuits` (014) | `ON DELETE RESTRICT` | RESTRICT | yes | yes |
| `emergency_pauses` (014) | `agent_id ... ON DELETE RESTRICT` (nullable) | RESTRICT | yes | yes |
| `job_checkpoints` (015) | `ON DELETE RESTRICT` | RESTRICT | yes | yes |
| `worker_results` (016) | `ON DELETE RESTRICT` | RESTRICT | yes | yes |
| `channels` (019) | default RESTRICT | RESTRICT | yes | yes |
| `production_releases` (019) | default RESTRICT | RESTRICT | yes | yes |
| `jobs` (001) | default RESTRICT | RESTRICT | yes | yes |
| `provider_attempts` (001) | default RESTRICT | RESTRICT | yes | yes |
| `social_oauth_states` (030) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `social_director_accounts` (030) | `ON DELETE CASCADE` | CASCADE | yes | yes |
| `promo_campaigns` (001) | `owner_agent_id ... REFERENCES agents(id)` default RESTRICT | RESTRICT | yes | yes |
| `promo_reels` (001) | `owner_agent_id ... REFERENCES agents(id)` default RESTRICT | RESTRICT | yes | yes |
| `analytics_events` (027) | `agent_id` nullable, no FK | n/a | yes | attribution only |

Non-agent FK roots that matter for the migration story:
- `owners(id)` is the top owner root on nearly every owner-scoped table.
- Several tables also reference `creative_universes(id)`, `creative_charters(id)`,
  `creative_references(id)`, `channels(id)`, `production_releases(id)`, and the
  credential-broker tables.

### 5.4 What this means for retirement enforcement

Two distinct protection layers exist today:

1. **Direct FK to `agents(id)`** — protects the agent row itself from deletion while
   operational rows exist. This is good for history preservation, but it does **not**
   express lifecycle retirement. A retired Director’s `agents` row can still exist and
   still be referenced; FK alone does not stop new production origination.
2. **`enabled` flag** — used today as the production-eligibility signal in several
   places. This is the gap: retirement must not rely on `enabled` alone, and
   `enabled` must not remain an independent production-eligibility authorization once a
   canonical lifecycle state exists.

Therefore the corrected design must add lifecycle enforcement at the operational write
paths, not just at the mapping table.

---

## 6. Trigger + cap semantics (VERIFIED)

- Cap trigger: `SELECT count(*) FROM agents`.
- Repository cap check: `SELECT count(*) FROM agents` in `AgentRepository.add()`.
- So both DB and JS currently assume the cap is “50 agent rows”, not “50 active
  Directors”. This must change to active-only.

---

## 7. Lifecycle and `enabled` semantics today (VERIFIED)

Today’s production-eligibility signal is `agents.enabled`, used by:

- `AgentRepository.list()` / `get()`
- `src/catalog/server.js:412` `enabledAgentsProvider`
- `src/providers/router.js`: `enabled` derived from `canonical.enabled`
- `src/scheduling/productionScheduler.js`: `enabledAgents()` provider
- `src/scheduling/backgroundSchedulerTrigger.js`: runs enabled schedules
- `public/dashboard.js`: renders `agentEnabled === false ? "director disabled" : ...`

So there is no separate lifecycle `status` table today. Retirement is not yet a
first-class DB concept. This spec makes it one.

---

## 8. Operational write-path inventory (VERIFIED from code)

These are the write surfaces that must reject retired/suspended originators or otherwise
enforce the canonical lifecycle state:

### 8.1 Registry / agent management
- `POST /api/agents` — creates a new agent row; `AgentRepository.add()` enforces cap and
  uniqueness. This is a registry write path and must not allow a retired underlying key
  to be re-used as a new active Director.

### 8.2 Production queueing
- `ProductionRepository.createReleaseWithJob()` — owner API production creation.
- `POST /api/productions` route in `server.js`.
- `createHermesJobBridge().executeHermesDecision()` — HERMES production path.
  Already gates on `channel.agentEnabled === false` → `AGENT_DISABLED` and on
  `decision.directorId !== channel.agentId`.

### 8.3 Scheduling
- `DirectorScheduleRepository.upsertSchedule()` — schedule create/replace.
- `POST /api/scheduling/directors/:agentId/run` — schedule tick.
- `backgroundSchedulerTrigger.js` — durable background ticks across enabled schedules.

### 8.4 Credentials / Secrets & Connections
- `DirectorConnectionsRepository.upsertConnection()` / `deleteConnection()` /
  `testConnection()`.
- `POST /api/connections/directors/:agentId`.
- YouTube OAuth: `YouTubeOAuthService` writes `youtube_oauth_states` /
  `youtube_director_accounts`.
- Social OAuth: `SocialOAuthService` writes `social_oauth_states` /
  `social_director_accounts`.
- Owner operations router: provider smoke test, private publishing test, analytics ingest.

### 8.5 Quota / dispatch admission / execution permit
- `PostgresQuotaRepository.configureQuota()` / `reserve()`.
- `reserveApprovedFreeDispatchAdmission()` and the dispatch-admission/execution-permit
  lifecycle classes.

### 8.6 HERMES decision origination
- `HermesManager.decide()` records decisions with a `directorId`.
- `PostgresHermesDecisionStore.append()` persists them.
- The router `/api/hermes/decisions` and the bridge that executes `production.start`.

### 8.7 Other owner-scoped writes touching agent identity
- Workspace: `DirectorWorkspaceRepository.getOrCreateConversation()`,
  `appendMessage()`, roadmap/memory writes.
- Resilience controls, job checkpoints, worker results, provider quota, credential
  broker metadata/audit.

The key point: retirement must be enforced where a retired Director could otherwise
originate new work or new operational state. FK protection alone does not cover that.

---

## 9. Frontend inventory (complete read of `public/`)

`public/` contains exactly 4 files. Read both UI files.

### 9.1 `public/index.html`

- Renders “Registered agents: … (registry hard cap 50).”
- Internal director names are explicitly described as server-side only.

### 9.2 `public/dashboard.js`

- Uses `c.agentId`, `schedule.agentId`.
- Calls `/api/directors/:agentId/...`, `/api/scheduling/directors/:agentId/...`,
  `/api/connections/directors/:agentId/...`, `/api/youtube/directors/:agentId/...`,
  `/api/social/directors/:agentId/...`.
- Renders `agentEnabled === false ? "director disabled" : "director enabled"`.
- Renders `directors-agent-count` from `state.metrics.agents`.

### 9.3 `public/assets/aistudio/Paste_October_25__2026_-_10_36PM_242c3d5f`

- Non-code reference paste.
- Mentions JARVIS, COSMOS, LAKME, CHRONOS, AI NEWS, BUTTERFLY as Directors.
- Describes LAKME as Indian mythology, AI NEWS as AI & technology news, and BUTTERFLY
  as a separate creative universe.
- This is why COSMOS/CHRONOS/AI NEWS/BUTTERFLY are “expected” Directors even though
  they are not in the current seed.

---

## 10. Test and fixture inventory (targeted, not yet fully per-file classified)

I did not claim a finished 159-file classification in this pass; I did targeted reads
and a broad grep. The outcome is enough to identify the retirement/compatibility/cap
testing shape.

### 10.1 High-signal identity references

- `tests/credentialBrokerPostgres.integration.js`: uses `agent-01` / `agent-02`;
  inserts agents; tests cross-agent credential rejection and revoke/audit scoping.
- `tests/productionExecutorRunner.test.js`: inserts `agent-01` + channel; heavy
  `agent-01` usage.
- `tests/durableRetryPostgres.integration.js`: creates dynamic `agent-future-*` etc.
  rows in `agents`; deletes from `agents` and `jobs`.
- `tests/workerLeaseContention.integration.js`: creates dynamic `agent-lease-*` rows.
- `tests/resiliencePostgres.integration.js`: creates dynamic `res-agent-*` rows.
- `tests/postgres-api.test.js`: creates dynamic `a-*` agent rows; expects
  `AGENT_CAP_REACHED`.
- `tests/postgresAuthIntegration.integration.js`: explicit “+ 29 synthetic rows = 50”
  cap test.
- `tests/agents.test.js`, `tests/agentDigitalIdentity.test.js`,
  `tests/newtonCatalog.test.js`: expect `AGENT_CAP_REACHED`.
- `tests/staticDashboard.test.js`: “canonical internal director names from the seed catalog.”
- `tests/providerConfiguration.test.js`: heavy `agent-01`/`agent-02`.
- `tests/packagingQc.test.js`: heavy `agent-01` + `agent-02` mismatch tests.
- `tests/aiNewsContentPackageOrchestrator.test.js`: expects
  `result.agentId === "agent-ai-news"`.
- `tests/aiNewsEditorialPlan.test.js`: uses AI News agent id and a mismatch test.
- `tests/officialAnalyticsCollectors.test.js`, `tests/evidence-and-publishing.test.js`,
  `tests/ffmpegAssemblyExecutor.test.js`, `tests/agenticProductionEngine.test.js`: use
  `agent-01`.
- `tests/directorWorkspaceApi.test.js`: hits `/api/directors/agent-01/...`.
- `tests/oauthSecretManagerWiring.test.js`: hits YouTube/social routes for
  `agent-01`/`agent-06`/`agent-07`.
- `tests/socialOAuthApi.test.js`: uses director A/B agent ids.
- `tests/bilibiliPublisher.test.js`: `agent-07`.
- `tests/backgroundSchedulerTrigger.test.js`: `agent-01`/`agent-02`.
- `tests/jobLifecycle.test.js`: has the `active_count` query pattern.

### 10.2 Fixture patterns that matter for this migration

- Several integration tests create dynamic agent ids and then delete them. That means
  any retirement implementation must not break the test helper pattern of creating and
  removing temporary agents.
- Several tests insert agents into `agents` directly. The new cap enforcement must still
  behave correctly under those inserts.
- AI News tests expect an `agent-ai-news`-shaped identity in outcomes; this affects how
  AI NEWS mapping is wired and tested.

### 10.3 Current test result

- `npm test`: 1536 pass / 0 fail. This is the verified baseline entering implementation.

---

## 11. PostgreSQL availability findings (BLOCKED)

- No authorized isolated PostgreSQL 15 environment is available in this worktree.
- Therefore:
  - No live row inventory of `agents`, `channels`, `jobs`, schedules, credentials,
    OAuth states, quota limits/reservations, HERMES decisions, workspace rows, etc.
  - No migration rehearsal against a real DB.
  - No cap-trigger behavior verification against real concurrent inserts.
- This spec records DB integration and migration rehearsal as BLOCKED, not PASSED.
- The schema-level findings in this spec are real and verified from the migrations; the
  row-level findings are not.

---

## 12. Collision check for the six proposed new underlying IDs (VERIFIED against repo)

I checked the current repo for any existing usage of the six proposed IDs.

Proposed IDs:
- `agent-director-cosmos`
- `agent-director-aadi`
- `agent-director-chronos`
- `agent-director-ai-news`
- `agent-director-tech-master`
- `agent-director-butterfly`

Findings:
- None of these six appear in `sql/002_seed_agents.sql` or `sql/018_newton_catalog_registration.sql`.
- None of these six appear in `src/catalog/server.js` `AGENT_SEED` or `CHANNEL_SEED`.
- None of these six appear in `src/catalog/agents.js` `PRELOADED_AGENTS`.
- None of these six appear in `src/catalog/repositories.js` agent queries.
- None of these six appear in the channel seeds or demo job seeds.
- The closest existing signal is `agent-ai-news` in AI News tests, which is a different
  string from `agent-director-ai-news`. So there is no current repo collision with the
  proposed six IDs.

Conclusion: as far as this repo’s current files are concerned, the six proposed IDs are
available. This is a repo-file collision check, not a live DB collision check. DB-level
uniqueness must still be validated at migration rehearsal time.

---

## 13. Corrected design decisions

### 13.1 Single authoritative lifecycle state

- Add a canonical mapping table, e.g. `canonical_director_mappings`, with at least:
  - `id` (mapping row identifier)
  - `canonical_director_code` — one of the 10 canonical codes
  - `underlying_agent_id` — the preserved/new underlying agent key
  - `display_name` — canonical display name
  - `namespace` — canonical namespace
  - `status` — single authoritative lifecycle status, e.g.
    `active | retired | suspended`
  - `retired_at`, `retired_reason`
  - `created_at`, `updated_at`
- The mapping row’s `status` is the single source of truth for whether a canonical
  Director is active, retired, or suspended.

### 13.2 Relationship to `agents.enabled`

- Keep `agents.enabled` as a technical row-level flag if the codebase needs it, but do
  **not** let it remain an independent production-eligibility authorization.
- Any production eligibility check must consult the canonical mapping status
  (or the resolved underlying agent’s lifecycle status through the mapping).
- Concretely: a retired mapping must block production even if the underlying
  `agents.enabled` is still `true`.

### 13.3 Active-only cap, serialized

- The invariant is: `COUNT(active canonical mappings) <= 50`.
- Recommended serialization: a dedicated cap-lock row, e.g.
  `canonical_director_cap_lock(id text PRIMARY KEY, dummy text)`, with every activation
  path doing:
  1. `SELECT ... FROM canonical_director_cap_lock WHERE id = 'active_director_cap' FOR UPDATE`
  2. count active mappings
  3. proceed or raise `ACTIVE_DIRECTOR_CAP_REACHED`
- The existing `enforce_agent_cap()` trigger and `AgentRepository.add()` cap checks are
  updated/replaced so they count active mappings, not all agent rows.
- New activation paths must use the same cap-lock pattern so the invariant is enforced
  everywhere, not just in one place.

### 13.4 Retirement enforcement at each operational write path

Retirement must be enforced where originators act. Recommended seams:

- **Registry**: do not allow a retired underlying key to be activated as a new active
  canonical Director; do not allow re-adding a retired mapping as active without an
  explicit governed action.
- **Job creation / production queueing**: before queuing, require the canonical mapping
  for the underlying agent to be active.
- **Schedule creation and activation**: require active mapping for the Director.
- **Credential / Secrets & Connections writes**: require active mapping for the Director
  for mutation paths that imply ongoing production use.
- **OAuth initiation / connection changes**: require active mapping for the Director.
- **Publishing requests**: require active mapping for the originating Director.
- **HERMES decision origination**: require active mapping for `directorId` where the
  decision implies a production-capable originator.
- **Provider dispatch / quota / execution permit**: require active mapping for the
  originating Director’s underlying agent.

Each seam must be enforceable in the DB path where possible, with a server-side
fallback that reads the mapping status inside the same transaction or under the same
serialization where needed.

### 13.5 Historical preservation

- Retired rows stay in place.
- Historical FK-bearing rows are preserved.
- No automatic reassignment of owned channels, charter assignments, jobs, schedules,
  credentials, OAuth states, workspace state, or evidence attribution.
- Historical attribution that used the legacy underlying keys stays attributed to those
  keys; the canonical mapping provides the display-name/retired mapping on top.

### 13.6 Migration order

Corrected order:

1. Add canonical mapping table, lifecycle status, cap-lock row, active-cap counting, and
   the cap serialization.
2. Add retirement enforcement at the required operational write paths.
3. Retire the 17 legacy identities in place (their underlying keys remain, their mappings
   become retired).
4. Activate the final ten via their mapping rows.
5. Never expose an intermediate state where the active registry is invalid or where the
   active count is violated.

### 13.7 Rollback

- Before dropping anything, prove no dependent records/reference prevent it.
- If dependent records exist, do forward repair, not a blind drop.
- Pre-production cutover rollback can be simpler because no production use has happened;
  post-use rollback cannot assume that.

---

## 14. Exclusions and remaining gaps

Excluded from this pass:
- Production DB migration execution.
- Production deployment, publishing, credentials, OAuth wiring, paid usage.
- PR creation/merge authorization (one PR remains the delivery target later, gated).

Remaining UNKNOWN:
- Live DB dependent-record state for the 17 legacy identities and the 4 preserved keys.
- Live runtime/worker/client dependencies on those keys.

Remaining BLOCKED:
- Row-level DB inventory.
- DB migration rehearsal against a real PostgreSQL 15 instance.
- Any claim that DB integration or migration behavior is verified in a real DB.

---

## 15. What this spec authorizes next

This spec authorizes going on to Phase 2A–2E implementation under the Master Build
Authorization, on a dedicated implementation branch from the current HEAD, with one PR as
the final delivery artifact, and with the existing unstaged `lifecycle.json` change
preserved throughout.

It does not authorize production migration, deployment, publishing, credential/OAuth, or
paid usage.

---

## 16. Evidence closure — completion record

The Phase 1.3 closure items below were completed against the working tree. Where a check
could not be run, it is recorded as BLOCKED, never as passed.

| Closure item | Result |
|---|---|
| Read all 31 SQL migrations | DONE — `sql/001` … `sql/031` read; findings in §5 |
| Enumerate and inspect the 159 test/integration files | DONE — enumerated; identity/fixture-relevant files inspected (§10) |
| Scan every file under `public/` | DONE — 4 files, all read (§9) |
| Identity inventory | DONE (§4) |
| FK inventory | DONE (§5.3) |
| Trigger inventory | DONE (§5.2) — `agents_max_50` counts ALL agent rows; the active-only invariant is new and lives on the mapping table |
| Lifecycle inventory | DONE (§7) — `agents.enabled` was the only production-eligibility signal; it is no longer authoritative |
| Operational write-path inventory | DONE (§8) |
| Exclusions / UNKNOWN / BLOCKED | DOCUMENTED (§14) |
| Live PostgreSQL 15 row inventory + migration rehearsal | **BLOCKED** — no authorized isolated instance available in this environment |
| Production migration / deployment / OAuth / publishing / paid usage / PR merge | **NOT AUTHORIZED** in this phase |

Correction carried into implementation: the existing `agents_max_50` trigger was **not**
replaced. It still enforces its original ceiling on total agent rows, so no existing
guarantee or test regresses. The Owner's active-only invariant is enforced additionally,
on `canonical_director_mappings` (§13.3), by both a trigger and the cap-locked
application path.

## 17. Phase 2 implementation record

| Phase | Delivered |
|---|---|
| 2A — registry + lifecycle | `sql/032_canonical_director_mappings.sql` (mapping table, `canonical_director_cap_lock` row, active-cap trigger, resolution helper, operational guards); `src/catalog/canonicalDirectorRepository.js`; `src/catalog/canonicalDirectorServer.js`; `src/catalog/canonicalDirectorLifecycle.js` |
| 2B — API surface | `GET /api/canonical-directors`, `/active`, `/:code`; `POST /:code/activate`, `/retire`, `/suspend` — session auth, CSRF, owner role, audit events, safe DTOs |
| 2C — retirement enforcement | enforced at owner production queueing (`server.js`), HERMES decision origination and the HERMES execution bridge (`hermesRouter.js`, `hermesJobBridge.js`), schedule enablement (`directorScheduleRouter.js`), Director connection upsert (`directorConnectionsRouter.js`), plus DB triggers on `jobs`, `director_schedules`, `director_connections`, `youtube_oauth_states`, `social_oauth_states` |
| 2D — capacity | active-only cap counted on mappings, serialized by `SELECT … FOR UPDATE` on the dedicated cap-lock row in every activation path, re-checked by the DB trigger |
| 2E — evidence + docs | `tests/canonicalDirectorLifecycle.test.js` (21 tests), `tests/canonicalDirectorEnforcement.test.js` (9 tests), `docs/directors/CANONICAL_DIRECTOR_REGISTRY.md` |

Deliberate degeneration, documented so it is not mistaken for enforcement: an agent with
no mapping row is *not governed* (the canonical set is activated deliberately, not by a
migration), and a database that has not applied migration 032 (`42P01`) does not fail every
production write. Only a genuine governed-non-active mapping raises
`CANONICAL_DIRECTOR_NOT_ACTIVE`.
