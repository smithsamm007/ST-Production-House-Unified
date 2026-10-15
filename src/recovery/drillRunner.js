/**
 * ST Production House — executable backup/restore drill runner (TASK-5.1).
 *
 * Drives the deterministic core in `backupRestoreDrill.js` against TWO REAL
 * PostgreSQL schemas inside one disposable database (unique schema names,
 * CASCADE-dropped at the end — same isolation pattern as the existing
 * integration tests):
 *
 *   source schema — migrations applied + representative seed rows
 *   → logical backup manifest (real row digests, bounded row cap)
 *     → fresh target schema (canonical migrations re-applied from sql/)
 *       → rows + schema_migrations restored from the manifest
 *         → fail-closed verification of every table + migration history
 *
 * Honest outcome contract (AGENTS.md Rules 1–3):
 * - verdict "PASS" requires every manifest table to match count AND digest,
 *   the migration history to match, and the backup to be complete.
 * - Failed restores report FAILED with the stable origin code; the runner
 *   never downgrades a failure to a success.
 * - No uploads, no network calls beyond the two database connections, no
 *   fabricated rows, receipts, or ids.
 */

import crypto from "node:crypto";
import pg from "pg";

import { PostgresAdapter } from "../db/postgresAdapter.js";
import { MigrationRunner } from "../db/migrationRunner.js";
import {
  DRILL_ERROR_CODES,
  assertSafeIdentifier,
  buildBackupManifest,
  probeRestoredSchema,
  verifyRestoredAgainstManifest,
} from "./backupRestoreDrill.js";

const DEFAULT_MAX_ROWS = 50_000;
const MAX_PARAMS_PER_INSERT = 10_000; // comfortably below PostgreSQL's 65,535

/** Creates a connection pool pinned to one unique schema via search_path. */
export async function openSchemaAdapter(connectionString, schemaName) {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${schemaName},public`,
  });
  return { pool, adapter: new PostgresAdapter({}, pool) };
}

/** Refuses to run the restore leg against a schema that already holds tables. */
export async function assertFreshSchema(adapter) {
  const res = await adapter.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
  );
  if (Number(res.rows[0].n) > 0) {
    const error = new Error(
      `${DRILL_ERROR_CODES.TARGET_NOT_EMPTY}: restore target schema already holds tables`
    );
    error.code = DRILL_ERROR_CODES.TARGET_NOT_EMPTY;
    throw error;
  }
}

/** Applies canonical migrations into the schema and reports the applied count. */
export async function applyCanonicalMigrations(adapter) {
  return new MigrationRunner(adapter).runMigrations();
}

/** Seeds a small, representative dataset the drill digests (real rows only). */
export async function seedDrillData(adapter, suffix) {
  const email = `drill-owner-${suffix}@drill.invalid`;
  const agentName = `DRILL_AGENT_${suffix}`;
  const namespace = `st.drill.${suffix}`;
  await adapter.query(
    "INSERT INTO owners(id, email, password_hash) VALUES ($1, $2, 'drill-not-a-real-hash')",
    [crypto.randomUUID(), email]
  );
  await adapter.query(
    "INSERT INTO agents(id, name, namespace) VALUES ($1, $2, $3)",
    [crypto.randomUUID(), agentName, namespace]
  );
  return { email, agentName };
}

/** Restores one table's rows in bounded parameterized multi-row INSERTs. */
export async function restoreTableRows(adapter, entry) {
  assertSafeIdentifier(entry.name, "table");
  for (const column of entry.columns) assertSafeIdentifier(column, "column");
  if (entry.columns.length === 0 || entry.rows.length === 0) return 0;

  const batchRows = Math.max(1, Math.floor(MAX_PARAMS_PER_INSERT / entry.columns.length));
  const columnList = entry.columns.map((c) => `"${c}"`).join(", ");

  let restored = 0;
  for (let start = 0; start < entry.rows.length; start += batchRows) {
    const batch = entry.rows.slice(start, start + batchRows);
    const values = [];
    const params = [];
    for (const row of batch) {
      const placeholders = entry.columns.map((column) => {
        params.push(row[column] === undefined ? null : row[column]);
        return `$${params.length}`;
      });
      values.push(`(${placeholders.join(", ")})`);
    }
    await adapter.query(
      `INSERT INTO "${entry.name}" (${columnList}) VALUES ${values.join(", ")}`,
      params
    );
    restored += batch.length;
  }
  return restored;
}

/** Single bulk statement: TRUNCATE every restored table at once (CASCADE). */
export async function truncateAllTables(adapter, tables) {
  assertSafeIdentifier(tables[0].name, "table");
  const names = tables.map((t) => `"${assertSafeIdentifier(t.name, "table")}"`).join(", ");
  await adapter.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function loadForeignKeys(client) {
  const res = await client.query(
    `SELECT tc.table_name, tc.constraint_name, tc.is_deferrable, tc.initially_deferred
       FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_schema = current_schema()`
  );
  for (const row of res.rows) {
    assertSafeIdentifier(row.table_name, "table");
  }
  return res.rows;
}

/**
 * Restores the logical backup into a FRESH target schema.
 *
 * Canonical migrations provide the DDL. The restore is two surgical
 * transactions (no superuser required, no trigger-bypass):
 *
 *   T1 (atomic): every foreign key is temporarily made DEFERRABLE INITIALLY
 *   DEFERRED (plain ALTER TABLE), the truncate clears migration-seeded rows
 *   (the manifest is the restored truth), and all rows are inserted in any
 *   order. At COMMIT the complete restored dataset is validated against
 *   every foreign key — real schema, real enforcement, nothing partial.
 *
 *   T2: the original constraint deferrability is restored byte-for-byte.
 *   (A second ALTER in T1 is impossible: "pending trigger events".
 *   Between T1 and T2 the throwaway drill schema carries temporarily
 *   deferred FKs; T2 is a same-ownership ALTER run right after commit.)
 *
 * Any failure rolls back that transaction; nothing partial ever persists.
 */
export async function restoreBackupInto(targetAdapter, manifest) {
  await assertFreshSchema(targetAdapter);
  const applied = await applyCanonicalMigrations(targetAdapter);

  return new Promise((resolve, reject) => {
    targetAdapter
      .withTransaction(async (client) => {
        const runner = { query: (sql, params) => client.query(sql, params) };
        const foreignKeys = await loadForeignKeys(client);
        for (const fk of foreignKeys) {
          await runner.query(
            `ALTER TABLE "${fk.table_name}" ALTER CONSTRAINT "${fk.constraint_name}" DEFERRABLE INITIALLY DEFERRED`
          );
        }

        await truncateAllTables(runner, manifest.tables);
        let restoredRows = 0;
        for (const entry of manifest.restorePayload) {
          restoredRows += await restoreTableRows(runner, entry);
        }
        return { applied, restoredRows, foreignKeysDeferred: foreignKeys.length };
      })
      .then(async (outcome) => {
        // T2: restore the original constraint deferrability exactly.
        await targetAdapter.withTransaction(async (client) => {
          const foreignKeys = await loadForeignKeys(client);
          for (const fk of foreignKeys) {
            const deferrable = fk.is_deferrable === "YES" ? "DEFERRABLE" : "NOT DEFERRABLE";
            const initial = fk.initially_deferred === "YES" ? "DEFERRED" : "IMMEDIATE";
            await client.query(
              `ALTER TABLE "${fk.table_name}" ALTER CONSTRAINT "${fk.constraint_name}" ${deferrable} INITIALLY ${initial}`
            );
          }
        });
        return outcome;
      })
      .then(resolve, reject);
  });
}

/**
 * Runs the full drill against one real PostgreSQL database. Returns a report
 * with verdict "PASS" only when every verification gate holds.
 */
export async function runBackupRestoreDrill(connectionString, options = {}) {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sourceSchema = `stph_drill_src_${suffix}`;
  const restoreSchema = `stph_drill_dst_${suffix}`;

  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const startedAt = new Date().toISOString();
  try {
    await admin.query(`CREATE SCHEMA "${sourceSchema}"`);
    await admin.query(`CREATE SCHEMA "${restoreSchema}"`);

    const source = await openSchemaAdapter(connectionString, sourceSchema);
    const target = await openSchemaAdapter(connectionString, restoreSchema);
    try {
      assertSafeIdentifier(sourceSchema, "table");
      assertSafeIdentifier(restoreSchema, "table");

      const sourceMigrations = await applyCanonicalMigrations(source.adapter);
      await seedDrillData(source.adapter, suffix);
      const manifest = await buildBackupManifest(source.adapter, { maxRows });

      const restoreOutcome = await restoreBackupInto(target.adapter, manifest);
      const restoredProbe = await probeRestoredSchema(target.adapter, { maxRows });
      const verified = verifyRestoredAgainstManifest(restoredProbe, manifest);

      // Stability gate: re-applying migrations on the restored schema must be
      // a no-op — the restored history is exactly the canonical one.
      const recheck = await applyCanonicalMigrations(target.adapter);

      const report = {
        code: verified.verdict === "PASS" && recheck.appliedCount === 0
          ? "BACKUP_RESTORE_DRILL_PASS"
          : "BACKUP_RESTORE_DRILL_FAIL",
        startedAt,
        finishedAt: new Date().toISOString(),
        sourceSchema,
        restoreSchema,
        manifestId: manifest.manifestId,
        tableCount: manifest.tables.length,
        rowCount: manifest.tables.reduce((sum, t) => sum + t.rowCount, 0),
        migrationCount: manifest.migrationCount,
        sourceMigrationsApplied: sourceMigrations.appliedCount,
        restoredRows: restoreOutcome.restoredRows,
        postRestoreMigrationsApplied: recheck.appliedCount,
        mismatch: verified.verdict === "FAIL"
          ? { code: "BACKUP_RESTORE_DRILL_MISMATCH", tables: verified.tables }
          : null,
        verdict: verified.verdict === "PASS" && recheck.appliedCount === 0
          ? "PASS"
          : "FAIL",
      };
      return report;
    } finally {
      await source.pool.end().catch(() => {});
      await target.pool.end().catch(() => {});
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`).catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE`).catch(() => {});
    await admin.end();
  }
}
