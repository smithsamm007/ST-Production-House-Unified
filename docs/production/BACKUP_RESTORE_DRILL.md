# Backup / Restore Drill (TASK-5.1, HARDEN-1)

Executable evidence for the RUNBOOK §7 rollback policy, which requires a
**verified, active** backup procedure. This drill is real end-to-end work with
real PostgreSQL bytes — no simulated media, receipts, or rows (AGENTS.md
Rules 1–3).

## What the drill proves

`node scripts/backup_restore_drill.mjs` (or `npm run drill:backup-restore`)
creates two uniquely-named throwaway schemas in the addressed database and:

1. **Source leg** — applies the canonical migration sequence, seeds a small
   representative dataset, and builds a logical backup manifest: catalog-derived
   user tables (injection-validated identifiers), per-table row counts and
   order-independent digests (SHA-256 over sorted per-row hashes of canonical
   row serializations), and the exact `schema_migrations` history.
2. **Restore leg (fresh schema, two surgical transactions)** — canonical
   migrations provide the DDL; every foreign key is temporarily made
   `DEFERRABLE INITIALLY DEFERRED` (plain ALTER TABLE, table-owner privilege,
   fully transactional); the truncate clears migration-seeded rows (the
   manifest is the restored truth); all rows are re-inserted; COMMIT validates
   the full dataset against every FK. A second transaction restores each
   constraint's original deferrability byte-for-byte. Nothing partial ever
   persists.
3. **Verification (fail-closed)** — every table must match count AND digest,
   the migration history must match, migration re-application on the restored
   schema must be a no-op, and the backup must be complete. `verdict: "PASS"`
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
