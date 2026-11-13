# Canonical Director registry

Status: implemented in `sql/032_canonical_director_mappings.sql`, `src/catalog/canonicalDirectorRepository.js`,
`src/catalog/canonicalDirectorLifecycle.js`, `src/catalog/canonicalDirectorServer.js`.
Production migration and cutover remain **gated** and are not part of this change.

## What the registry is

`canonical_director_mappings` holds exactly one row per canonical Director and carries the
**single authoritative lifecycle state** for that Director:

| Canonical code | Underlying `agents(id)` key | Origin |
|---|---|---|
| `JARVIS` | `agent-01` | preserved |
| `SHERLOCK` | `agent-02` | preserved |
| `LAKME` | `agent-03` | preserved |
| `NEWTON` | `agent-21` | preserved |
| `COSMOS` | `agent-director-cosmos` | new |
| `AADI` | `agent-director-aadi` | new |
| `CHRONOS` | `agent-director-chronos` | new |
| `AI NEWS` | `agent-director-ai-news` | new |
| `TECH MASTER` | `agent-director-tech-master` | new |
| `BUTTERFLY` | `agent-director-butterfly` | new |

`status` is `active`, `retired`, or `suspended`, and it — not `agents.enabled` — decides
whether a Director may originate new work.

## Invariants

1. **Active-only cap.** `COUNT(status = 'active') <= 50`. Enforced twice:
   - application: every activation runs inside a transaction that takes
     `SELECT ... FOR UPDATE` on the single `canonical_director_cap_lock` row
     (`id = 'active_director_cap'`), recounts, then activates;
   - database: `canonical_director_active_cap` trigger re-checks under the same lock row,
     so a writer that bypasses the repository cannot exceed the cap.
2. **Retirement is in place.** Retiring a Director updates the mapping status. The
   `agents` row, channels, releases, jobs, schedules, credentials, OAuth rows and evidence
   keep their original attribution. Nothing is reassigned.
3. **Retired/suspended blocks new work.** `enforceOperationalActive()` and the sql/032
   triggers refuse a governed non-active Director at: job creation, schedule enablement,
   Director connection upsert, YouTube/social OAuth start, owner production queueing and
   HERMES production decisions.
4. **Ungoverned agents keep working.** An agent with no mapping row is *not* blocked: the
   canonical set is activated deliberately, not by running a migration. A database that has
   not applied migration 032 (`42P01`) also degrades to "not governed" instead of failing
   every production write.

## API (owner session required; mutations also require CSRF + owner role)

| Route | Effect |
|---|---|
| `GET /api/canonical-directors` | every mapping, active first, plus the cap and identifier sets |
| `GET /api/canonical-directors/active` | active mappings and the current count |
| `GET /api/canonical-directors/:code` | one mapping by canonical code |
| `POST /api/canonical-directors/:code/activate` | cap-locked activation |
| `POST /api/canonical-directors/:code/retire` | retire in place (`retiredReason`) |
| `POST /api/canonical-directors/:code/suspend` | suspend (`suspendedNote`) |

Refusals map to stable codes: `409 CANONICAL_DIRECTOR_NOT_ACTIVE`,
`409 ACTIVE_DIRECTOR_CAP_REACHED`, `404` for unknown codes, `403 INSUFFICIENT_PRIVILEGES`.

## Cutover sequence (production, separately authorized)

1. Apply migration 032.
2. Create mappings for all ten canonical Directors in `retired` status (preserved keys are
   reused as-is; the six new underlying IDs must exist in `agents` first).
3. Activate the ten via the cap-locked activation path.
4. Retire the 17 legacy identities by leaving them without an active mapping.

Step 4 preserves history automatically: a legacy identity with no mapping row is
"ungoverned", so existing rows stay valid while new work is driven only by the ten active
canonical Directors.
