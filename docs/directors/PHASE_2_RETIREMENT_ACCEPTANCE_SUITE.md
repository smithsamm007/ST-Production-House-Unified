# Phase 2 — Director lifecycle acceptance suite

Superseded name: this suite now covers the **canonical** migrations 033/034, not the
rejected drafts. The lifecycle contract itself lives in
[DIRECTOR_LIFECYCLE.md](./DIRECTOR_LIFECYCLE.md).

## What runs

`tests/directorLifecycleAcceptance.integration.js` (registered in
`npm run test:integration`). It is opt-out-safe: it requires a disposable database
URL (`POSTGRES_TEST_URL` or `DATABASE_URL`) only when it runs as part of
`test:integration`; in a plain unit run without PostgreSQL the case is skipped with
a true `skip` status, never counted as a pass.

```bash
DATABASE_URL=postgresql://… npm run test:integration
node --test tests/directorLifecycleAcceptance.integration.js
```

## How a case is built

1. Create a disposable database named `stph_acceptance_<random>`; assert the name
   matches that pattern and is not the source database.
2. Stage the pre-cutover schema: migrations **001..032 only** (copied to a temp
   directory, applied by the real `MigrationRunner`).
3. Seed production-shaped history through the real schema — owners, product
   identities, channels, a release, legacy and preserved jobs, schedules,
   connections, OAuth states, a promo campaign.
4. Apply `sql/033_legacy_director_retirement.sql` and
   `sql/034_canonical_director_seed.sql` **verbatim** from the repository.
5. Assert lifecycle behaviour (SQLSTATE `P0001` + domain error for every rejected
   write).
6. Drop the database in `finally` and assert the drop returned `true`.

Staging at 032 is what makes the historical rows realistic: today's database has
legacy jobs and channels that were created *before* the cutover, and the suite must
prove those rows survive it.

## Coverage

| # | Scenario | Case |
|---|---|---|
| 1 | All ten canonical seed identities | `034 classifies all ten …` |
| 2 | Preserved operational Directors stay active | same |
| 3 | All seven guarded write origins | `seven guarded paths …` |
| 4-5 | Legacy refusal / preserved acceptance | `seven guarded paths …` |
| 6-8 | Pending refusal, active acceptance, retired refusal | `seven guarded paths …`, `application guard …` |
| 9 | Activation authorization (pending → active) | `activation is explicit …` |
| 10 | Capacity enforcement and cap lock | `activation is explicit …` |
| 11 | Tenant isolation | `tenant isolation …` |
| 12 | Unknown Director identity (`23503`) | `tenant isolation …` |
| 13 | Historical reads | `OAuth and provider connections …` |
| 14 | Historical updates (disable, in-flight transitions) | `rite schedules …`, `in-flight work …` |
| 15-16 | Enabled / disabled schedule behaviour | `rite schedules …` |
| 17 | In-flight job behaviour | `in-flight work …` |
| 18 | Retry behaviour | `in-flight work …` (queued→leased→failed→queued) |
| 19 | OAuth and provider connection behaviour | `OAuth and provider connections …` |
| 20 | Idempotent migration application | re-applied in the acceptance run; `ON CONFLICT DO NOTHING` |
| 21 | Partial-failure atomicity | observed: a failing 034 leaves no tables behind |
| 22 | Concurrent migration attempts | `concurrent migration attempts serialise …` |
| 23 | Concurrent activation attempts | `activation is explicit …` (parallel `Promise.all`) |
| 24-26 | Rollback before / after activation / after activity | `rollback before activation …`, `rollback after activation …` |
| 27 | Migration 032 checksum preserved | `migration 032 is untouched …` |
| 28 | Default opt-out safety | `requireDatabase` skip path |
| 29 | Disposable database cleanup | `withDisposable` `finally` + post-run check |
| 30 | Production-shaped dataset rehearsal | `seedProductionShape` in every fixture case |

## Evidence expectations

* Failed guards must be `P0001` with the exact domain error
  (`LEGACY_DIRECTOR_RETIRED`, `CANONICAL_DIRECTOR_NOT_ACTIVE`). A foreign-key or
  unique violation is never accepted as proof of a guard.
* `AGENT_CAP_REACHED` padding in `tests/postgresAuthIntegration.integration.js`
  derives the seeded agent count, because 034 adds six registry rows.
* After a run, `SELECT datname FROM pg_database WHERE datname LIKE 'stph_%'` must
  return no rows.
