# Backup / Restore Drill (TASK-5.1, HARDEN-1)

Executable evidence for the RUNBOOK §7 rollback policy, which requires a
**verified, active** backup procedure. This drill is real end-to-end work with
real PostgreSQL bytes — no simulated media, receipts, or rows (AGENTS.md
Rules 1–3).

## What the drill proves

`node scripts/backup_restore_drill.mjs` (or `npm run drill:backup-restore`)
creates two uniquely-named throwaway **databases** on the addressed PostgreSQL
instance (see "Isolation model" below for why databases, not schemas) and:

1. **Source leg** — applies the canonical migration sequence, seeds a small
   representative dataset, and builds a logical backup manifest: catalog-derived
   user tables (injection-validated identifiers), per-table row counts and
   order-independent digests (SHA-256 over sorted per-row hashes of canonical
   row serializations), and the exact `schema_migrations` history.
2. **Restore leg (fresh database, two surgical transactions)** — canonical
   migrations provide the DDL; every foreign key is temporarily made
   `DEFERRABLE INITIALLY DEFERRED` (plain ALTER TABLE, table-owner privilege,
   fully transactional); the truncate clears migration-seeded rows (the
   manifest is the restored truth); all rows are re-inserted; COMMIT validates
   the full dataset against every FK. A second transaction restores each
   constraint's original deferrability byte-for-byte. Nothing partial ever
   persists.
3. **Verification (fail-closed)** — every table must match count AND digest,
   the migration history must match, migration re-application on the restored
   database must be a no-op, and the backup must be complete. `verdict: "PASS"`
   exit 0 only when all gates hold; otherwise a stable mismatch code and
   exit 1.
4. **Tamper detection is part of the contract** (`tests/backupRestoreDrill.integration.js`):
   a substituted restored row fails verification
   (`DRILL_VERIFY_DIGEST_MISMATCH`); a tampered applied migration file raises
   `MigrationChecksumMismatchError` with no partial apply
   (`schema_migrations` untouched), and `getMigrationStatus` reports
   `CHECKSUM_MISMATCH` — the RUNBOOK stop-ship gate, executed.

Executed evidence (2026-10-15, disposable test database): 84 tables, 158 rows,
30 migrations restored, `BACKUP_RESTORE_DRILL_PASS`, exit 0; evidence JSON
under git-ignored `artifacts/backup-restore-drill/`.

## Honest scope and limitations

- **Node-only logical backup, not pg_dump.** For production-scale grading the
  operator should still schedule a native backup tool; this drill proves the
  restore-verification contract and the migration-history custody chain.
- **Bounded rows** (`DRILL_MAX_ROWS`, default 50,000 per table). A backup that
  truncates records it honestly (`recordsComplete:false / ROW_CAP_EXCEEDED`)
  and verification then REFUSES `PASS` — an incomplete backup can never claim
  success.
- **Sequence values (nextval states) are not part of a logical data backup**;
  the drill verifies data integrity and migration custody, not sequence
  positions.
- **The ephemeral deferrability window.** Between the restore commit and the
  second transaction, the throwaway schema carries temporarily deferred FKs —
  at most milliseconds, inside the drill's own discarded schemas.
- **Real FK cycles** (present in this schema, e.g. blueprint tables) are not a
  blocker: the deferred-FK transaction makes insert order irrelevant; the
  manifest records `fkCycleDetected` honestly and advisory topological order
  (`foreignKeyRestoreOrder`) still fails closed on unsatisfiable cycles when
  ordering is required by a caller.

## Commands

```sh
npm run drill:backup-restore          # real drill against DRILL_DATABASE_URL ? POSTGRES_TEST_URL
node --test tests/backupRestoreDrill.test.js                 # offline contracts (8 tests)
node --test tests/backupRestoreDrill.integration.js          # live-PostgreSQL drill + tamper matrix
```

Integration subtests skip honestly when no `POSTGRES_TEST_URL` is configured,
and run for real in CI and under `npm run test:integration`.

## Isolation model — databases, not schemas

Each drill leg runs in its own disposable database (`stph_drill_src_*`,
`stph_drill_dst_*`, dropped with `WITH (FORCE)` afterwards). This replaced the
earlier two-schema-per-database design after a real failure:

`sql/032_canonical_director_mappings.sql` guards `CREATE TYPE canonical_director_status`
with `SELECT 1 FROM pg_type WHERE typname = 'canonical_director_status'`. `pg_type` is
database-global and is **not** filtered by `search_path`, so as soon as *any* schema in
that database already owned the type — a leftover drill schema, or a `public` schema
migrated by an earlier test in the same database — 032 skipped `CREATE TYPE` and then
failed on the per-schema `search_path`:

```
Migration failed on file '032_canonical_director_mappings.sql':
type "canonical_director_status" does not exist
```

That made the drill fail on any reused database while passing on a fresh one. Per-database
isolation removes the condition entirely: no other schema can exist in a database that was
just created. Migration 032 itself is **unmodified**; the defect is diagnosed and tracked
separately.

Requirements and honesty notes:

- The drill now needs the **CREATEDB** privilege. If it is refused, the runner raises
  `DRILL_REQUIRES_CREATEDB` with the underlying error instead of silently falling back to
  the schema mode that 032 cannot survive.
- A database that cannot create databases should point `DATABASE_URL` at a dedicated
  instance, not at a shared one.
- `report.isolation === "database"`, plus `sourceDatabase` / `restoreDatabase`, record the
  legs; residue is detectable with
  `SELECT datname FROM pg_database WHERE datname LIKE 'stph_%'` (must be empty after a run).

## Cleanup guarantees (tested, not assumed)

- Both legs are dropped in a `finally` block, so a **failed** drill cleans up too.
  Regression: *"a failed drill still drops its disposable databases (failure-path
  cleanup)"* calls the drill with `maxRows: -1` so the manifest stage fails after the
  source database exists, then asserts the `stph_%` set is unchanged.
- `dropDisposableDatabase` refuses any name that does not match
  `stph_(drill|tamper|checksum)_*`, so the source or an unrelated database can never be
  dropped by the drill. Regression: *"the drill refuses to drop a database it did not
  create"*.
- A drop that does not verify returns `false`; the runner prints
  `DRILL_CLEANUP_INCOMPLETE: <names>` and records `report.cleanup.residue` instead of
  claiming success.
