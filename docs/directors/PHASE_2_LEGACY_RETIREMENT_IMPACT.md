# Phase 2 — legacy Director retirement (migrations 033/034): impact assessment

**Status: proposal only.** Nothing in `sql/` changed. Migrations 033 and 034 are
**not authorised and not created**; the drafts rehearsed below exist only as
throwaway SQL. Migration 032 is untouched (`sha256 c8def789…`), and its defect is
not repaired here.

## 1. What the two migrations would do

| Migration | Effect |
|---|---|
| 033 | adds `director_legacy_retirements`, retires the 17 historical identities (`agent-04`…`agent-20`) and guards seven new-work origin paths |
| 034 | creates 6 new agent rows and 10 canonical mappings, all `retired`; **activation is not part of the migration** |

No `agents` row is deleted, renamed, disabled or repurposed. Retirement is an
additive row plus insertion guards, exactly as migration 032 expressed canonical
retirement.

## 2. Guard coverage (gap closed during assessment)

The rehearsal found the original draft guarded only the three paths 032 guards
for *canonical* Directors, leaving two real origins open:

| Path | Table | Column | In draft v1 | Now |
|---|---|---|---|---|
| Production queue | `jobs` | `agent_id` | yes | yes |
| Schedule activation | `director_schedules` | `agent_id` (only when `schedule_enabled`) | yes | yes |
| Credential binding | `director_connections` | `agent_id` | yes | yes |
| **Channel creation** | `channels` | `agent_id` | **no** | yes |
| **Promotional campaign** | `promo_campaigns` | `owner_agent_id` | **no** | yes |
| YouTube authorization | `youtube_oauth_states` | `agent_id` | **no** | yes |
| Social authorization | `social_oauth_states` | `agent_id` | **no** | yes |

Leaving `channels`/`promo_campaigns` unguarded would have let a retired identity
start a brand-new universe and a promotional campaign while being refused a job —
an inconsistent policy that reads as a bug in production.

## 3. Measured evidence (disposable PostgreSQL 15 databases, all dropped)

| Check | Result |
|---|---|
| 033 draft applied twice | 17 retirement rows, second apply inserts 0; triggers created once |
| 034 draft applied twice | agents 21 → 27, mappings 0 → 10 (`retired`), no change on re-apply |
| Four preserved rows (`agent-01/02/03/21`) | identical `{id,name,namespace,enabled}` before, after seed, after activation |
| `channels` insert, `agent-07` | `ERROR: LEGACY_DIRECTOR_RETIRED` |
| `channels` insert, `agent-01` | accepted |
| `promo_campaigns` insert, `agent-07` | `ERROR: LEGACY_DIRECTOR_RETIRED` |
| `promo_campaigns` insert, `agent-01` | accepted |
| `youtube_oauth_states`, `agent-07` / `agent-01` | refused / guard did not fire (failed later on `expires_at`, i.e. passed the guard) |
| `social_oauth_states`, `agent-07` | refused |
| Duplicate retirement, unknown agent, unknown mapping target, 11th code, name collision | `23505`, `23503`, `23503`, `23514`, `23505` |
| Rollback (drop triggers/functions/table, delete rows) | back to 21 agents / 0 mappings; `agent-07` channel accepted again |
| Dump + restore of the post-033/034 shape | digest-identical (27 agents, 10 mappings, 17 retirements, 87 tables) |
| Activation through the cap-locked repository | 10 active, cap trigger intact |

## 4. Deliberately left writable

Retired identities can still be read, and their **conversation, memory and
message** tables stay writable, as does `UPDATE` on existing jobs. Those are
history surfaces, not new-work origins. This asymmetry is a policy decision for
the Owner, not an oversight.

## 5. Before applying in production

Run the inventory query in the decision package (`jobs`, enabled
`director_schedules`, `director_connections`, `channels`, `production_releases`
for the 17 identities). A non-zero **enabled schedule** is the one row this
design makes awkward: it stops being re-enableable, so it should be reviewed case
by case before the migration is authorised.

## 6. Acceptance criteria

- exactly 17 retirement rows, no others; four preserved agents bit-identical;
- all seven guarded paths refuse a retired identity with `LEGACY_DIRECTOR_RETIRED`
  and accept a preserved one;
- re-apply is a no-op; rollback returns to the post-032 shape;
- 034 creates 6 agents + 10 retired mappings and activates nothing;
- `npm test`, `npm run test:integration`, `lint`, `verify`, `plan:check` green.
