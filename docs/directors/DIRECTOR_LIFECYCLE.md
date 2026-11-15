# Director lifecycle — states, transitions, activation and rollback

Authoritative implementation: `sql/032_canonical_director_mappings.sql` (status enum),
`sql/033_legacy_director_retirement.sql`, `sql/034_canonical_director_seed.sql`,
`src/catalog/directorLifecycle.js`, `src/catalog/canonicalDirectorLifecycle.js`.

## 1. One authority, four business states

`sql/032` owns the only lifecycle column: `canonical_director_mappings.status`
(`canonical_director_status` = `active | retired | suspended`). No parallel status
system exists. `src/catalog/directorLifecycle.js` derives the four states the
product needs from that one column:

| Lifecycle | Stored row | New work | History | Schedules |
|---|---|---|---|---|
| `pending` | `status='suspended'` + `suspended_note='PENDING_OWNER_ACTIVATION'` | refused (`CANONICAL_DIRECTOR_PENDING_ACTIVATION`) | readable/writable | cannot be enabled |
| `active` | `status='active'` | allowed | readable/writable | allowed |
| `suspended` | `status='suspended'`, note is anything else | refused (`CANONICAL_DIRECTOR_NOT_ACTIVE`) | readable/writable | cannot be enabled |
| `retired` | `status='retired'` | refused (`CANONICAL_DIRECTOR_NOT_ACTIVE`) | readable/writable | cannot be enabled |

`pending` is separate from `suspended` because "seeded but never approved" and
"approved but paused" need different operator actions, even though both block work.

## 2. Canonical Director inventory (migration 034)

| Code | Underlying agent | Seeded lifecycle | Why |
|---|---|---|---|
| `JARVIS` | `agent-01` | active | operational today |
| `SHERLOCK` | `agent-02` | active | operational today |
| `LAKME` | `agent-03` | active | operational today |
| `NEWTON` | `agent-21` | active | operational today |
| `COSMOS` | `agent-director-cosmos` | pending | new, needs Owner activation |
| `AADI` | `agent-director-aadi` | pending | new, needs Owner activation |
| `CHRONOS` | `agent-director-chronos` | pending | new, needs Owner activation |
| `AI NEWS` | `agent-director-ai-news` | pending | new, needs Owner activation |
| `TECH MASTER` | `agent-director-tech-master` | pending | new, needs Owner activation |
| `BUTTERFLY` | `agent-director-butterfly` | pending | new, needs Owner activation |

Four active Directors is below the Owner-configured cap (`ACTIVE_DIRECTOR_CAP`,
50). No migration ever activates a new Director; seeding and activation are
deliberately separate steps.

### Defect D-1 (resolved)

The rejected draft of 034 seeded all ten mappings as `retired`. Because `sql/032`
refuses new work for any non-active mapping, seeding alone would have disabled
`JARVIS`, `SHERLOCK`, `LAKME` and `NEWTON` — Directors that are operational in
production — until someone manually reactivated them. Migration 034 now seeds
those four as `active` (the status quo) and the six new ones as `pending`.

## 3. Transitions

`LIFECYCLE_TRANSITIONS` (src/catalog/directorLifecycle.js):

```
pending   -> active | retired
active    -> suspended | retired
suspended -> active | retired
retired   -> active
```

Every transition is an explicit, audited call on
`CanonicalDirectorRepository` (`activateMapping`, `suspendMapping`,
`retireMapping`), never a side effect of seeding. `assertLifecycleTransition`
rejects any pair outside the table (for example `retired -> suspended`), and
activation is cap-locked and idempotent: re-activating an active Director does not
change the active count.

### Owner authorization requirements

* **Activation of a `pending` Director** requires explicit Owner approval. It is
  performed through `activateMapping`, which also respects `ACTIVE_DIRECTOR_CAP`.
* **Retirement** of a canonical Director requires Owner approval; it preserves all
  history.
* **Suspension** is an operator action for a temporary pause and is reversible.
* Migrations never perform any of the three for a *new* Director.

## 4. Write origins and guards

`sql/032` guards: `jobs`, `director_schedules`, `director_connections`,
`youtube_oauth_states`, `social_oauth_states`. It never covered `channels` or
`promo_campaigns`; migration 034 closes that gap with
`enforce_canonical_director_active_origin` + two triggers, using the same rule and
the same public error code. `sql/032` is not modified.

`sql/033` guards seven origins for the 17 legacy identities
(`agent-04` .. `agent-20`): `jobs`, `director_schedules` (only while
`schedule_enabled`), `director_connections`, `channels`, `promo_campaigns`,
`youtube_oauth_states`, `social_oauth_states`.

### Policy per object (D-3)

| Object | Retirement / suspension policy |
|---|---|
| New job | refused (`LEGACY_DIRECTOR_RETIRED` / `CANONICAL_DIRECTOR_NOT_ACTIVE`) |
| Queued / leased / running job | proceeds; status transitions (`queued→leased→failed→queued`, dead-letter) still work |
| Existing schedule | can be disabled; cannot be re-enabled while blocked |
| Existing connection | read-only: `INSERT`/`UPDATE` refused (a connection write re-grants provider capability) |
| OAuth state | existing rows readable and expirable; new rounds refused |
| Channel, release, promo campaign | existing rows preserved and readable; new channels/campaigns refused |
| Jobs rows | never deleted or reassigned by any lifecycle change |

In-flight work therefore *completes or fails honestly*; nothing is silently
killed, and nothing is misreported as completed.

## 5. Error surface

| Situation | SQLSTATE | Domain error |
|---|---|---|
| Legacy identity originates new work | `P0001` | `LEGACY_DIRECTOR_RETIRED` |
| Canonical Director is `pending` (app layer) | — | `CANONICAL_DIRECTOR_PENDING_ACTIVATION` |
| Canonical Director is suspended/retired (app + DB) | `P0001` | `CANONICAL_DIRECTOR_NOT_ACTIVE` |
| Unknown canonical code | — | `CANONICAL_DIRECTOR_NOT_FOUND` |
| Illegal lifecycle transition | — | `DIRECTOR_LIFECYCLE_TRANSITION_REJECTED` |
| Cap reached on activation | — | `ACTIVE_DIRECTOR_CAP_REACHED` |

Callers map `CANONICAL_DIRECTOR_*` / `LEGACY_DIRECTOR_RETIRED` to a 409 and never
queue the work. Nothing logs credentials, tokens or payloads.

## 6. Migration ordering

`sql/001..034` must stay contiguous (enforced by `src/orchestration/repoLinter.js`
and `npm run lint`). 033 (legacy retirement) precedes 034 (canonical seed) because
034's guards assume the retirement table exists. `npm run migrate` applies all
pending migrations in one transaction using an advisory lock, so concurrent
attempts serialise: one applies, the other reports `appliedCount: 0`.

## 7. Rollback

Artefact: `sql/rollback/033_034_rollback.sql`. It lives outside the numbered
sequence on purpose (the linter only reads `sql/*.sql`), so it can never be
mistaken for migration 035.

Run it as an authorised operator:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/rollback/033_034_rollback.sql
```

It removes: the seven legacy guard triggers, their functions and
`director_legacy_retirements`; the two canonical `channels`/`promo_campaigns`
guards and their function; all ten canonical mappings; and the six new agent rows
**only when nothing references them**.

It refuses (raising, changing nothing) when:

* a new canonical Director already produced rows (`ROLLBACK_REFUSED_NEW_DIRECTOR_HAS_*`), or
* a mapping no longer matches the seeded state, i.e. lifecycle decisions were made
  after the migration (`ROLLBACK_REFUSED_LIFECYCLE_CHANGED_AFTER_MIGRATION`).

Override after Owner review with
`BEGIN; SET LOCAL app.rollback_force = 'on'; \i sql/rollback/033_034_rollback.sql; COMMIT;`.

It never deletes `jobs`, `channels`, `production_releases`, schedules,
connections, OAuth rows or campaigns. It is idempotent, tolerates partial
deployment (033 without 034 and vice versa), and works both before and after
activation and after production activity.

**What it does not restore:** lifecycle decisions taken by an operator after the
migration, and any work produced afterwards. Rolling back also removes the
*navigation* guards, so a former legacy identity becomes able to originate new
work again — quiesce the service before rolling back.

## 8. Recovery after rollback

1. Quiesce scheduling (stop the worker) so no new work is queued.
2. Roll back per §7.
3. Restore the previous application build (the lifecycle module expects
   `canonical_director_mappings`).
4. Re-apply `npm run migrate` to return to 034 when the incident is resolved; the
   seed is idempotent and will not change an already-approved state.

## 9. Monitoring and audit

* `director_legacy_retirements` rows are the audit record of the legacy cutover
  (`retired_at`, `retired_reason`, `retired_by`).
* Canonical lifecycle changes go through `CanonicalDirectorRepository`, which
  writes `previous state -> new state` with the acting owner and reason; alert on
  any activation that was not preceded by an Owner-approved request.
* Alert on `LEGACY_DIRECTOR_RETIRED` / `CANONICAL_DIRECTOR_NOT_ACTIVE` spikes:
  they indicate a stale worker or a Director still wired into schedules.
* `activeCount()` should be monitored against `ACTIVE_DIRECTOR_CAP`.

## 10. Acceptance tests

```bash
npm run test:integration          # includes tests/directorLifecycleAcceptance.integration.js
node --test tests/directorLifecycleAcceptance.integration.js
```

Each test creates a disposable `stph_acceptance_*` PostgreSQL database, stages the
pre-cutover schema (001..032), seeds production-shaped history, applies 033/034
verbatim, asserts lifecycle behaviour and drops the database in `finally`. The
suite also verifies that `sql/032` is byte-identical (sha256
`c8def789fa311702…`) and that no disposable database survives.

## 11. Known limitations

* 033 cannot protect a table that does not exist in a database created before that
  table's migration; the guards are installed on the canonical 001..034 shape.
* The lifecycle is enforced per write origin, not per capability: a *new* capability
  table must add its own guard (034 added two such gaps).
* Activation is audited through the repository; a direct `UPDATE` by a DBA bypasses
  the audit trail (the cap lock and CHECK constraints still apply).
* HERMES refuses new work for blocked Directors; it does not migrate or cancel
  work already handed to a provider before retirement.
