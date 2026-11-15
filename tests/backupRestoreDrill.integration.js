import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, copyFile, writeFile, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { MigrationRunner, MigrationChecksumMismatchError } from "../src/db/migrationRunner.js";
import {
  DRILL_ERROR_CODES,
  buildBackupManifest,
  probeRestoredSchema,
  verifyRestoredAgainstManifest,
} from "../src/recovery/backupRestoreDrill.js";
import {
  createDisposableDatabase,
  dropDisposableDatabase,
  openDatabaseAdapter,
  restoreBackupInto,
  runBackupRestoreDrill,
  seedDrillData,
} from "../src/recovery/drillRunner.js";

test("backup/restore drill restores digest-identically through canonical migrations", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL 15 URL is mandatory for the backup/restore drill acceptance");
    t.diagnostic("PostgreSQL is not configured; live backup/restore drill is not run by the unit command");
    return;
  }

  const report = await runBackupRestoreDrill(dbUrl);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.code, "BACKUP_RESTORE_DRILL_PASS");
  assert.equal(report.postRestoreMigrationsApplied, 0, "migrations re-apply as a no-op on the restored schema");
  assert.ok(report.tableCount > 0);
  assert.ok(report.manifestId, "manifest id recomputed from real content");
});

test("tamper detection: a substituted restored row fails the drill verification", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL 15 URL is mandatory for tamper detection");
    t.diagnostic("PostgreSQL is not configured; skipped by the unit command");
    return;
  }

  const suffix = `${process.pid}_${Date.now()}`;
  // Each leg gets its own database: sql/032 resolves its enum through a
  // database-global pg_type lookup, so a second schema in the same database can
  // make it skip CREATE TYPE and then fail to resolve the type.
  const sourceDatabase = await createDisposableDatabase(dbUrl, `stph_tamper_src_${suffix}`);
  let restoreDatabase;
  try {
    const source = await openDatabaseAdapter(sourceDatabase.connectionString);
    let target;
    try {
      await new MigrationRunner(source.adapter).runMigrations();
      await seedDrillData(source.adapter, suffix);
      const manifest = await buildBackupManifest(source.adapter);

      restoreDatabase = await createDisposableDatabase(dbUrl, `stph_tamper_dst_${suffix}`);
      target = await openDatabaseAdapter(restoreDatabase.connectionString);

      await restoreBackupInto(target.adapter, manifest);
      const ownersEntry = manifest.restorePayload.find((e) => e.name === "owners");
      assert.ok(ownersEntry && ownersEntry.rows.length > 0, "seed data present in the manifest");
      const victim = ownersEntry.rows[0];
      await target.adapter.query(
        `UPDATE owners SET password_hash = 'tampered' WHERE id = $1`,
        [victim.id]
      );

      const probe = await probeRestoredSchema(target.adapter);
      const verified = verifyRestoredAgainstManifest(probe, manifest);
      assert.equal(verified.verdict, "FAIL");
      assert.ok(
        verified.tables.some((r) => r.table === "owners" && r.code === DRILL_ERROR_CODES.VERIFY_DIGEST_MISMATCH)
      );
    } finally {
      await source.pool.end().catch(() => {});
      if (target) await target.pool.end().catch(() => {});
    }
  } finally {
    await dropDisposableDatabase(dbUrl, sourceDatabase.name);
    if (restoreDatabase) await dropDisposableDatabase(dbUrl, restoreDatabase.name);
  }
});

test("rollback safety: a tampered applied migration fails closed with no partial apply", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL 15 URL is mandatory for the checksum-gate acceptance");
    t.diagnostic("PostgreSQL is not configured; skipped by the unit command");
    return;
  }

  // Same isolation reason as the tamper leg: one disposable database per leg.
  const checksumDatabase = await createDisposableDatabase(dbUrl, "stph_checksum");
  const tamperDir = path.join(os.tmpdir(), `stph_tampered_migrations_${process.pid}_${Date.now()}`);
  let pool;
  try {
    const opened = await openDatabaseAdapter(checksumDatabase.connectionString);
    const { adapter } = opened;
    pool = opened.pool;

    // 1. Apply the intact migration set; record the schema_migrations rows.
    const first = await new MigrationRunner(adapter).runMigrations();
    assert.ok(first.appliedCount > 0);
    const before = await adapter.query("SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC");

    // 2. Simulate disk drift: a copy of the sql tree with one applied file edited.
    await mkdir(tamperDir, { recursive: true });
    const sqlDir = path.join(process.cwd(), "sql");
    const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql"));
    const tamperedFile = "005_creative_reference.sql";
    for (const file of files) {
      if (file === tamperedFile) {
        const content = await readFile(path.join(sqlDir, file), "utf8");
        await writeFile(path.join(tamperDir, file), content + "\n-- tampered copy\n", "utf8");
      } else {
        await copyFile(path.join(sqlDir, file), path.join(tamperDir, file));
      }
    }

    // 3. The runner must raise the checksum mismatch instead of proceeding.
    await assert.rejects(
      () => new MigrationRunner(adapter, { migrationsDir: tamperDir }).runMigrations(),
      (error) => error instanceof MigrationChecksumMismatchError
    );

    // 4. Nothing was additionally applied: applied count and history unchanged.
    const after = await adapter.query("SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC");
    assert.deepEqual(
      after.rows.map((r) => `${r.filename}:${r.checksum}`),
      before.rows.map((r) => `${r.filename}:${r.checksum}`)
    );
    const status = await new MigrationRunner(adapter, { migrationsDir: tamperDir }).getStatus();
    const flagged = status.find((s) => s.filename === tamperedFile);
    assert.equal(flagged.status, "CHECKSUM_MISMATCH");
  } finally {
    if (pool) await pool.end().catch(() => {});
    await rm(tamperDir, { recursive: true, force: true }).catch(() => {});
    await dropDisposableDatabase(dbUrl, checksumDatabase.name);
  }
});
