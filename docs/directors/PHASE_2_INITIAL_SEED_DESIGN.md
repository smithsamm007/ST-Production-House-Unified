# Phase 2 — Initial ten-Director seed (DESIGN ONLY, NOT A MIGRATION)

**Status:** design + rehearsal plan. Nothing here has been applied to any database, and
nothing here is a migration file.

**Do not copy this SQL into `sql/` until the Owner authorizes production execution.** When
authorized it becomes a **new** file (`sql/033_…`), never an edit to `sql/032`
(AGENTS.md R1). Placing it in `sql/` today would let the migration runner apply it on the
next `npm run migrate`.

## 1. Why a seed step exists at all

`sql/032_canonical_director_mappings.sql` is deliberately additive schema only: it creates
`canonical_director_mappings`, the cap-lock row, the cap trigger and the operational
triggers, and **inserts no mapping rows**. The owner API exposes no create route
(`GET`/`activate`/`retire`/`suspend` only), so after 032 every `POST …/activate` answers
`404 CANONICAL_DIRECTOR_NOT_FOUND`.

Two facts make the "ten active" state unreachable without this seed:

1. No mapping row exists for any canonical code.
2. The six new underlying keys do not exist in `agents`. Only `sql/002` (20 rows) and
   `sql/018` (`agent-21`) insert agents, and
   `canonical_director_mappings.underlying_agent_id REFERENCES agents(id)` rejects them.

This matches the documented cutover sequence in `docs/directors/CANONICAL_DIRECTOR_REGISTRY.md`
("create mappings for all ten … the six new underlying IDs must exist in `agents` first").

## 2. Order of operations (fixed)

1. Apply migrations `001…032` (repository procedure: `npm run migrate`).
2. **Agents first** — insert the six new `agent-director-*` rows (step A below).
3. **Mappings second** — insert the ten rows in `retired` status (step B below).
4. **Activation last** — through the cap-locked path only (repository / owner API). Never
   by a raw `UPDATE … SET status = 'active'`, which would bypass the 50-active serialization
   the cap exists for (the trigger still refuses an over-cap write, but the lock ordering is
   what makes the invariant race-free).

Reversing 2 and 3 fails on the foreign key. Reversing 3 and 4 leaves nine Directors of new
work blocked while the tenth is activated.

## 3. Step A — the six new underlying agent records

```sql
-- Additive, idempotent, never touches agent-01/02/03/21 or any historical row.
-- agents_max_50 (sql/001) still applies: 21 existing + 6 = 27 rows, well under the ceiling.
INSERT INTO agents (id, name, namespace)
SELECT v.id, v.name, v.namespace
  FROM (VALUES
    ('agent-director-cosmos',      'COSMOS',      'st.agent.cosmos'),
    ('agent-director-aadi',        'AADI',        'st.agent.aadi'),
    ('agent-director-chronos',     'CHRONOS',     'st.agent.chronos'),
    ('agent-director-ai-news',     'AI NEWS',     'st.agent.ai-news'),
    ('agent-director-tech-master', 'TECH MASTER', 'st.agent.tech-master'),
    ('agent-director-butterfly',   'BUTTERFLY',   'st.agent.butterfly')
  ) AS v(id, name, namespace)
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = v.id);
```

`name` and `namespace` are `UNIQUE` in `agents`; a partial re-run therefore cannot duplicate
a row, but it can still collide if another agent already owns one of these names — that is a
hard failure by design (`23505`), not something to paper over.

## 4. Step B — the ten mappings, created retired

```sql
-- One row per canonical code. Created retired so activation stays a separate,
-- cap-locked, audited decision. Idempotent on the canonical code.
INSERT INTO canonical_director_mappings
  (canonical_director_code, underlying_agent_id, display_name, namespace,
   status, retired_at, retired_reason)
SELECT v.code, v.agent_id, v.display_name, v.namespace,
       'retired', now(), 'pre-cutover seed'
  FROM (VALUES
    -- Four preserved identifiers: reuse the existing keys as-is.
    ('JARVIS',      'agent-01', 'JARVIS',      'st.agent.jarvis'),
    ('SHERLOCK',    'agent-02', 'SHERLOCK',    'st.agent.sherlock'),
    ('LAKME',       'agent-03', 'LAKME',       'st.agent.lakme'),
    ('NEWTON',      'agent-21', 'NEWTON',      'st.agent.newton'),
    -- Six new identifiers created in step A.
    ('COSMOS',      'agent-director-cosmos',      'COSMOS',      'st.agent.cosmos'),
    ('AADI',        'agent-director-aadi',        'AADI',        'st.agent.aadi'),
    ('CHRONOS',     'agent-director-chronos',     'CHRONOS',     'st.agent.chronos'),
    ('AI NEWS',     'agent-director-ai-news',     'AI NEWS',     'st.agent.ai-news'),
    ('TECH MASTER', 'agent-director-tech-master', 'TECH MASTER', 'st.agent.tech-master'),
    ('BUTTERFLY',   'agent-director-butterfly',   'BUTTERFLY',   'st.agent.butterfly')
  ) AS v(code, agent_id, display_name, namespace)
 WHERE NOT EXISTS (
   SELECT 1 FROM canonical_director_mappings m WHERE m.canonical_director_code = v.code
 );
```

Both `canonical_director_code` and `underlying_agent_id` are `UNIQUE`, so a second run is a
no-op and an ambiguous double-mapping cannot be created by accident.

## 5. Step C — activation (never raw SQL)

Ten activations through `CanonicalDirectorRepository.activateMapping()` (or
`POST /api/canonical-directors/:code/activate` with an owner session + CSRF), one
transaction each, all contending on the single `canonical_director_cap_lock` row:

`BEGIN → SELECT … FOR UPDATE (cap lock) → count(active) → UPDATE … status = 'active'`.

The repository clears `retired_at`/`retired_reason`/`suspended_note` on activation, so the
`canonical_director_active_has_no_retirement` check keeps holding.

## 6. What must not change (acceptance assertions)

- `agent-01`, `agent-02`, `agent-03`, `agent-21` keep their existing `name`, `namespace`,
  `enabled` and every dependent row (jobs, schedules, connections, OAuth state,
  evidence) — the seed never updates or deletes an agent row.
- The 17 historical identities (`agent-04` … `agent-20`) keep working as **ungoverned**
  agents: no mapping row, no reassignment, existing history readable.
- No canonical code is mapped twice; no underlying key is mapped twice.
- `SELECT count(*) FROM canonical_director_mappings WHERE status = 'active'` = 10 after
  step C, and the active cap stays an *additional* invariant on top of `agents_max_50`.

## 7. Verification queries (run after each step)

```sql
-- A: exactly six new records, all enabled, none replacing an existing key
SELECT count(*) FROM agents WHERE id LIKE 'agent-director-%';                    -- 6
SELECT count(*) FROM agents;                                                     -- 27

-- B: ten mappings, all retired, four preserved keys present, six new keys present
SELECT status, count(*) FROM canonical_director_mappings GROUP BY status;        -- retired 10
SELECT count(*) FROM canonical_director_mappings
 WHERE underlying_agent_id IN ('agent-01','agent-02','agent-03','agent-21');      -- 4

-- C: ten active, four preserved rows byte-identical to their pre-seed values
SELECT count(*) FROM canonical_director_mappings WHERE status = 'active';        -- 10
SELECT a.id, a.name, a.namespace, a.enabled FROM agents a
 WHERE a.id IN ('agent-01','agent-02','agent-03','agent-21') ORDER BY a.id;

-- History: the 17 retired identities remain, ungoverned
SELECT count(*) FROM agents WHERE id BETWEEN 'agent-04' AND 'agent-20';          -- 17
SELECT count(*) FROM canonical_director_mappings m
  JOIN agents a ON a.id = m.underlying_agent_id WHERE a.id < 'agent-21';         -- 4
```

## 8. Rollback

1. `UPDATE canonical_director_mappings SET status = 'retired', retired_at = now(),
   retired_reason = 'seed rollback' WHERE canonical_director_code IN (…ten codes…)` —
   retire first; retirement never invalidates history.
2. Only if the rows must disappear: `DELETE FROM canonical_director_mappings WHERE
   underlying_agent_id IN (…six new keys…)` (the four preserved rows reference historical
   agents and should stay retired rather than be deleted).
3. The six `agent-director-*` rows may be deleted only while nothing references them
   (`REFERENCES … ON DELETE RESTRICT` will refuse while a mapping or job still points at
   them). Deleting an agent row is a last resort, not a rollback default.

## 9. Rehearsal plan (needs the disposable PostgreSQL 15)

Blocked today: no PostgreSQL 15 is reachable from this workspace, so none of steps A–C has
been executed. On an approved DSN / pre-started instance:

1. Fresh database → `npm run migrate` (001…032) → `npm run migrate:status` shows 32 applied.
2. Apply step A, then step B. Run **each twice** to prove idempotence (second run must
   insert 0 rows and change nothing).
3. Assert every query in §7 for A and B.
4. Activate all ten through the repository; assert 10 active and the four preserved agent
   rows unchanged.
5. Cap rehearsal: activate 41 synthetic mappings up to exactly 50, then prove the 51st is
   refused (`ACTIVE_DIRECTOR_CAP_REACHED`) and that a raw `INSERT … status='active'`
   is refused by the trigger as well.
6. Retirement rehearsal: retire one Director and prove jobs/schedules/connections/OAuth
   starts for it are refused while its history stays readable; prove the other nine and the
   ungoverned historical agents still work.
7. Roll back per §8 and confirm the database returns to the post-032 shape.

Promotion of this design into `sql/033_…` is a separate Owner decision, and production
execution is a further separate approval.
