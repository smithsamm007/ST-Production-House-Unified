import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { MigrationRunner, MigrationExecutionError, MigrationSearchPathMismatchError } from "../src/db/migrationRunner.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";
import { openSchemaAdapter } from "./helpers/schemaScopedAdapter.js";

// Reproduces the guard pattern used by sql/032: the existence check is
// catalog-global (`FROM pg_type`) while the reference below is resolved through
// search_path. A leftover copy of the type in an unreachable schema therefore
// suppresses creation and the reference fails with `type "…" does not exist`.
const TRAP_SQL = `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'probe_status') THEN
    CREATE TYPE probe_status AS ENUM ('active', 'retired');
  END IF;
END
$$;
CREATE TABLE IF NOT EXISTS probe_widget (status probe_status NOT NULL DEFAULT 'active');
`;

const ORPHAN_SQL = `CREATE TABLE IF NOT EXISTS probe_orphan (status missing_probe_status NOT NULL);
`;

const requireDatabase = (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL 15 URL is mandatory for the migration diagnostic acceptance");
    t.diagnostic("PostgreSQL is not configured; skipped by the unit command");
    return null;
  }
  return dbUrl;
};

const withMigrations = async (sqlByFile) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migration-diag-"));
  for (const [name, sql] of Object.entries(sqlByFile)) {
    await fs.writeFile(path.join(dir, name), sql);
  }
  return dir;
};

test("migration runner explains a type that exists only outside search_path", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;

  let disposable;
  try {
    disposable = await createDisposableDatabase(dbUrl, "stph_checksum_schema_trap");
  } catch (error) {
    if (error.code === "DRILL_REQUIRES_CREATEDB") {
      t.diagnostic(`CREATEDB is unavailable, so the disposable database could not be created: ${error.message}`);
      return;
    }
    throw error;
  }

  const dirs = [];
  const admin = new pg.Pool({ connectionString: disposable.connectionString, connectionTimeoutMillis: 5000 });
  try {
    const trapDir = await withMigrations({ "001_probe_guard.sql": TRAP_SQL });
    dirs.push(trapDir);

    await admin.query("CREATE SCHEMA stale_owner");
    await admin.query("CREATE TYPE stale_owner.probe_status AS ENUM ('active', 'retired')");
    await admin.query('CREATE SCHEMA "target_scope"');

    const { pool, adapter } = await openSchemaAdapter(disposable.connectionString, "target_scope");
    try {
      await assert.rejects(
        () => new MigrationRunner(adapter, { migrationsDir: trapDir }).runMigrations(),
        (error) => {
          assert.equal(error.name, "MigrationSearchPathMismatchError");
          assert.ok(error instanceof MigrationSearchPathMismatchError, "diagnostic keeps the execution-error contract");
          assert.ok(error instanceof MigrationExecutionError);
          assert.equal(error.objectName, "probe_status");
          assert.deepEqual(error.existingSchemas, ["stale_owner"]);
          assert.match(error.searchPath, /target_scope/, "the effective search_path is reported");
          assert.match(error.message, /none of them is on the effective search_path/);
          assert.match(error.message, /must not be modified/);
          return true;
        }
      );
    } finally {
      await pool.end().catch(() => {});
    }

    // A genuinely absent object must keep the ordinary error, not the diagnostic.
    await admin.query("DROP SCHEMA stale_owner CASCADE");
    await admin.query('DROP SCHEMA "target_scope" CASCADE');
    await admin.query('CREATE SCHEMA "target_scope"');
    const orphanDir = await withMigrations({ "001_probe_orphan.sql": ORPHAN_SQL });
    dirs.push(orphanDir);

    const second = await openSchemaAdapter(disposable.connectionString, "target_scope");
    try {
      await assert.rejects(
        () => new MigrationRunner(second.adapter, { migrationsDir: orphanDir }).runMigrations(),
        (error) => {
          assert.equal(error.name, "MigrationExecutionError");
          assert.equal(error instanceof MigrationSearchPathMismatchError, false);
          assert.match(error.message, /missing_probe_status/);
          return true;
        }
      );
    } finally {
      await second.pool.end().catch(() => {});
    }

    // Nothing was committed by either failed run: the transaction is atomic.
    const leftovers = await admin.query("SELECT to_regclass('target_scope.schema_migrations') AS t");
    assert.equal(leftovers.rows[0].t, null, "a failed migration transaction leaves no partial state");
  } finally {
    await admin.end().catch(() => {});
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
    await dropDisposableDatabase(dbUrl, disposable.name);
  }
});
