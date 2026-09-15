# NEWTON Catalog Registration (S-M02-01, issue #131)

NEWTON — the owner's canonical **Indian Current Affairs & Opportunities**
division — is now registered in the ST Production House agent catalog. This is
an **additive** registration only: existing migrations, agent rows, charters,
and DTO allowlists are untouched.

## What changed

| Layer | Change |
|---|---|
| `src/catalog/agents.js` | `PRELOADED_AGENTS` extended 20 → **21** with `agent-21 / NEWTON / st.agent.newton` |
| `sql/018_newton_catalog_registration.sql` | New additive migration (never edits 001–017) |
| `tests/newtonCatalog.test.js` | 16 new tests pinning every invariant below |
| Count-pin tests | Governed updates 20 → 21 in `tests/agents.test.js`, `tests/agentDigitalIdentity.test.js`, `tests/creativeCharter.test.js` |

## Invariants preserved

1. **50-agent hard cap** — enforced twice, unchanged:
   - DB: `agents_max_50` trigger in `sql/001_core.sql` (before-insert, count >= 50 raises `AGENT_CAP_REACHED`).
   - App: `AgentRegistry.add` throws `AGENT_CAP_REACHED` at `MAX_AGENTS = 50`.
2. **Connection-slot invariants (Rule 16)** — NEWTON receives exactly the
   migration-003 shape: one unconfigured primary **email** slot and one
   unconfigured primary **social** slot per platform
   (`youtube, instagram, facebook, snapchat`). Slots are seeded without any
   identity fields, so they stay `unconfigured`; the
   `social_connection_state_check` / `email_connection_state_check` constraints
   in 003 reject any seeded identity. Re-runs cannot duplicate slots
   (per-slot `WHERE NOT EXISTS` + the existing primary partial unique indexes).
3. **Identity isolation** — NEWTON's charter, connections, credentials, and
   jobs are bound to `agent-21` only. Charter binding requires the exact
   owner-approval flow; cross-owner binding is rejected. No existing agent row
   is altered (migration verifies name+namespace and raises
   `NEWTON_AGENT_IDENTITY_CONFLICT` on divergence instead of adopting it).
4. **Rule 15 (internal-only names)** — protection is **derived**, not
   enumerated: `resolvePublicAttribution` → `isInternalAgentName` normalizes
   the *agent's own* name/namespace, and `WorkEnvelope.scanForInternalAgentNames`
   blocks every `PRELOADED_AGENTS` name. Because NEWTON is now preloaded, all
   of this applies to NEWTON automatically — no allowlist edits, no DTO
   changes. A public brand like `Agent NEWTON` fails with
   `PUBLIC_PUBLISHING_IDENTITY_REQUIRED`.
5. **Fail-closed provisioning** — the migration asserts the final slot
   inventory (exactly 1 email + 4 social slots) and raises
   `NEWTON_SLOT_INVARIANT_VIOLATION` rather than leaving a half-provisioned
   agent.

## Why there is no charter seed in 018

Charters are **owner-bound** records (`creative_charters.owner_id` references a
real owner uuid; migration 006 fails without an explicit owner id). Seeding a
NEWTON charter without an owner would fabricate ownership, so the migration
provisions the agent identity and its unconfigured connection slots only. The
NEWTON charter scaffolding is exercised end-to-end in
`tests/newtonCatalog.test.js` through the governed
draft → version → approval → assignment lifecycle, exactly as an owner would
do it.

## PostgreSQL integration coverage

`tests/postgresIntegration.integration.js` gained a live-PG subtest that, on a
real PostgreSQL 15 instance:

1. Runs all migrations (001–018) through the real `MigrationRunner`.
2. Asserts the NEWTON row exists with the canonical name/namespace and did not
   duplicate the 20 original rows.
3. Asserts the exact slot inventory: 1 unconfigured primary email slot and 4
   unconfigured primary social slots (one per platform), with **no** identity
   fields seeded (Rule 16) and **no** secret locators (Rule 17).
4. Asserts idempotency: running migration 018 a second time changes nothing.
5. Asserts the 50-cap trigger still fires: 30 synthetic inserts
   (agent-22 … agent-51) raise `AGENT_CAP_REACHED` in a rolled-back
   transaction, leaving the DB untouched.

This gate runs in CI (`PostgreSQL Integration Tests` on postgres:15-alpine)
and remains mandatory for merge.

## Truthfulness

No public profile, brand, connection, credential, or charter is created for
NEWTON by this slice. NEWTON is an internal identifier only (Rule 15) until
the owner explicitly configures a public profile and connections. Live
OAuth/social publishing remains pending (Rule 16), and no provider capacity is
implied by this registration.
