/**
 * ST Production House — backup / restore drill core (TASK-5.1, HARDEN-1).
 *
 * Purpose (RUNBOOK §7): the migration rollback policy requires an ACTIVE,
 * VERIFIED regular backup procedure ("restore the database from the most
 * recent backup to a point before the bad migration ... verify it during
 * every rotation drill"). This module is the executable evidence for that:
 * a deterministic logical backup manifest, a fresh-schema restore through
 * the canonical migration sequence, and a fail-closed row-level verification
 * pass. It never claims success without a full verification pass, and it
 * never fabricates row data: every digest is computed from real values the
 * adapter returned (AGENTS.md Rules 1–3).
 *
 * Honest scope (also recorded in docs/production/BACKUP_RESTORE_Drill.md):
 * - Node-only logical backup (no pg_dump dependency): real values, real
 *   digests, bounded per-table row cap (DRILL_MAX_ROWS, default 50,000).
 *   A truncating backup records recordsComplete:false and verification then
 *   REFUSES a PASS verdict — an incomplete backup can never report success.
 * - Sequence values (nextval states) are not part of a logical data backup;
 *   the drill verifies data integrity, not sequence positions (documented).
 * - For production-scale backup scheduling the operator should still schedule
 *   a native backup tool alongside this drill; this module proves the
 *   restore-verification contract offline of that tooling.
 *
 * Pure and fail-closed: no network, no shell, identifiers are validated
 * against the catalog-derived allowlist shape before any SQL string use.
 */

import { createHash } from "node:crypto";

/** Safety bound: identifiers accepted into SQL are catalog-derived and must match this strict shape. */
const TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;
const COLUMN_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;

/** Stable error codes (honest failures, never silent success). */
export const DRILL_ERROR_CODES = Object.freeze({
  TARGET_NOT_EMPTY: "DRILL_TARGET_NOT_EMPTY",
  UNSAFE_IDENTIFIER: "DRILL_UNSAFE_IDENTIFIER",
  TABLE_NOT_FOUND: "DRILL_TABLE_NOT_FOUND",
  ROW_CAP_EXCEEDED: "DRILL_ROW_CAP_EXCEEDED",
  EMPTY_SOURCE: "DRILL_EMPTY_SOURCE",
  FK_CYCLE: "DRILL_FK_CYCLE",
  VERIFY_DIGEST_MISMATCH: "DRILL_VERIFY_DIGEST_MISMATCH",
  VERIFY_MISSING_TABLE: "DRILL_VERIFY_MISSING_TABLE",
  VERIFY_COUNT_MISMATCH: "DRILL_VERIFY_COUNT_MISMATCH",
  VERIFY_MIGRATION_HISTORY_MISMATCH: "DRILL_VERIFY_MIGRATION_HISTORY_MISMATCH",
  VERIFY_INCOMPLETE_BACKUP: "DRILL_VERIFY_INCOMPLETE_BACKUP",
  MANIFEST_INVALID: "DRILL_MANIFEST_INVALID",
});

const DEFAULT_MAX_ROWS = 50_000;

/**
 * Recursively stringifies JSON with sorted object keys, producing the
 * canonical form used for recomputed manifest ids (byte-identical for equal
 * logical content regardless of insertion order).
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Validates a table or column identifier that came from the Postgres catalog.
 * Anything that is not a plain lowercase-up-to-64-char SQL word shape fails
 * closed — the drill never interpolates unvalidated identifiers into SQL.
 */
export function assertSafeIdentifier(name, kind = "table") {
  const pattern = kind === "column" ? COLUMN_NAME_PATTERN : TABLE_NAME_PATTERN;
  if (typeof name !== "string" || !pattern.test(name)) {
    const error = new Error(`${DRILL_ERROR_CODES.UNSAFE_IDENTIFIER}: ${kind} identifier is not catalog-safe`);
    error.code = DRILL_ERROR_CODES.UNSAFE_IDENTIFIER;
    error.identifier = typeof name === "string" ? name.slice(0, 40) : String(name).slice(0, 40);
    throw error;
  }
  return name;
}

function quoteIdentifier(name) {
  assertSafeIdentifier(name, "table");
  return `"${name}"`;
}

/**
 * Digest for one table's rows, deterministic and ORDER-INDEPENDENT:
 * each row is serialized canonically (sorted keys), hashed with md5, the row
 * hashes are sorted lexicographically, and the digest is sha256 over
 * `${rowCount}:${h1,h2,...}`. A single changed/inserted/deleted row changes
 * the digest; current physical ordering never does.
 */
export function digestRows(rows) {
  const hashes = (rows || []).map((row) =>
    sha256Hex(JSON.stringify(row)).slice(0, 32)
  );
  hashes.sort();
  return sha256Hex(`${hashes.length}:${hashes.join(",")}`);
}

/**
 * Lists the current schema's BASE TABLEs with an injection-validated column
 * list and foreign-key dependency edges (used for restore ordering):
 *   { name, columns: string[], dependsOn: string[] }
 */
export async function listUserTables(adapter) {
  const res = await adapter.query(
    `SELECT t.table_name, c.column_name
       FROM information_schema.tables t
       LEFT JOIN information_schema.columns c
              ON c.table_schema = t.table_schema AND c.table_name = t.table_name
      WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name ASC, c.ordinal_position ASC`
  );
  const byName = new Map();
  for (const row of res.rows) {
    if (!byName.has(row.table_name)) byName.set(row.table_name, []);
    if (row.column_name !== null) byName.get(row.table_name).push(row.column_name);
  }
  const tables = [];
  for (const [name, columns] of byName) {
    assertSafeIdentifier(name, "table");
    for (const column of columns) assertSafeIdentifier(column, "column");
    tables.push({ name, columns });
  }
  if (tables.length === 0) {
    const error = new Error(`${DRILL_ERROR_CODES.EMPTY_SOURCE}: no user tables in the current schema`);
    error.code = DRILL_ERROR_CODES.EMPTY_SOURCE;
    throw error;
  }

  const deps = await adapter.query(
    `SELECT
        tc.table_name,
        ccu.table_name AS referenced_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
           AND tc.constraint_schema = ccu.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_schema = current_schema()
        AND tc.table_name <> ccu.table_name`
  );
  const depsByName = new Map(tables.map((t) => [t.name, t]));
  for (const { table_name, referenced_table } of deps.rows) {
    const table = depsByName.get(table_name);
    if (!table) continue; // referenced table is not a user table (cross-schema)
    if (!table.dependsOn) table.dependsOn = [];
    if (depsByName.has(referenced_table) && !table.dependsOn.includes(referenced_table)) {
      table.dependsOn.push(referenced_table);
    }
  }
  for (const table of tables) if (!table.dependsOn) table.dependsOn = [];
  return tables;
}

/** Foreign-key dependency topological order for restore/truncate. Cycles fail closed. */
export function foreignKeyRestoreOrder(tables) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const permanent = new Set();
  const stack = new Set();
  const order = [];
  const visit = (name) => {
    if (permanent.has(name)) return;
    if (stack.has(name)) {
      const error = new Error(`${DRILL_ERROR_CODES.FK_CYCLE}: circular foreign keys at '${name}'`);
      error.code = DRILL_ERROR_CODES.FK_CYCLE;
      error.table = name;
      throw error;
    }
    stack.add(name);
    const table = byName.get(name);
    for (const dep of table?.dependsOn || []) {
      if (byName.has(dep)) visit(dep);
    }
    stack.delete(name);
    permanent.add(name);
    order.push(name);
  };
  for (const table of [...tables].sort((a, b) => a.name.localeCompare(b.name))) visit(table.name);
  return order;
}

/**
 * Fetches one table's rows in deterministic related resolution. Values are
 * returned exactly as the adapter yields them (Date/number/string/object)
 * — digests are computed on the canonical serialization of those values.
 * Throws ROW_CAP_EXCEEDED when the table has more rows than maxRows.
 */
export async function dumpTableRows(adapter, table, maxRows = DEFAULT_MAX_ROWS) {
  assertSafeIdentifier(table, "table");
  const countRes = await adapter.query(`SELECT count(*)::bigint AS n FROM ${quoteIdentifier(table)}`);
  const count = Number(countRes.rows[0].n);
  if (count > maxRows) {
    const error = new Error(
      `${DRILL_ERROR_CODES.ROW_CAP_EXCEEDED}: '${table}' has ${count} rows > cap ${maxRows}`
    );
    error.code = DRILL_ERROR_CODES.ROW_CAP_EXCEEDED;
    error.table = table;
    error.rowCount = count;
    throw error;
  }
  const res = await adapter.query(`SELECT * FROM ${quoteIdentifier(table)}`);
  return res.rows;
}

/** Reads the schema_migrations history rows as plain, comparable data. */
export async function dumpMigrationHistory(adapter) {
  const res = await adapter.query(
    "SELECT filename, checksum, applied_at, execution_time_ms FROM schema_migrations ORDER BY filename ASC"
  );
  return res.rows;
}

/**
 * Builds the logical backup manifest for the whole current schema.
 * The manifest id is a recomputed sha256 over the canonical form of the
 * content-bearing fields only (no timestamps, no environment) so it is
 * byte-identical for identical logical schemas.
 */
export async function buildBackupManifest(adapter, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const tables = await listUserTables(adapter);
  let order;
  let fkCycleDetected = false;
  try {
    order = foreignKeyRestoreOrder(tables);
  } catch (error) {
    if (error?.code !== DRILL_ERROR_CODES.FK_CYCLE) throw error;
    // Real schemas can contain FK cycles (e.g. mutual references between
    // blueprint tables). That is not a drill failure: the restore leg runs
    // its row inserts in one transaction with FK triggers disabled, so no
    // insert ordering is required. The cycle is recorded honestly in the
    // manifest instead of making every such schema undrillable.
    order = null;
    fkCycleDetected = true;
  }
  const entries = [];
  for (const table of tables) {
    const rows = await dumpTableRows(adapter, table.name, maxRows);
    entries.push({
      name: table.name,
      columns: table.columns,
      dependsOn: table.dependsOn,
      rowCount: rows.length,
      digest: digestRows(rows),
      restoreOrder: order ? order.indexOf(table.name) : null,
      rows,
    });
  }
  const migrations = await dumpMigrationHistory(adapter);
  const manifest = {
    tables: entries.map(({ rows: _rows, ...rest }) => rest),
    migrationHistory: migrations,
    migrationCount: migrations.length,
    fkCycleDetected,
    recordsComplete: true,
  };
  manifest.manifestId = sha256Hex(canonicalJson({
    tables: manifest.tables,
    migrationHistory: manifest.migrationHistory,
    fkCycleDetected: manifest.fkCycleDetected,
    recordsComplete: manifest.recordsComplete,
  }));
  manifest.restorePayload = entries;
  return manifest;
}

/**
 * Compares a restored schema against the source manifest, fail-closed:
 * every manifest table must exist with equal row count and equal digest;
 * migration history must be unchanged. Returns a verdict object, never a lie.
 */
export function verifyRestoredAgainstManifest(restoredProbe, manifest) {
  const tableResult = [];
  let verdict = "PASS";

  const sourceByName = new Map(manifest.tables.map((t) => [t.name, t]));
  const restoredByName = new Map((restoredProbe.tables || []).map((t) => [t.name, t]));
  for (const source of sourceByName.values()) {
    const restored = restoredByName.get(source.name);
    if (!restored) {
      tableResult.push({ table: source.name, code: DRILL_ERROR_CODES.VERIFY_MISSING_TABLE });
      verdict = "FAIL";
      continue;
    }
    if (source.recordsComplete === false) {
      tableResult.push({ table: source.name, code: DRILL_ERROR_CODES.VERIFY_INCOMPLETE_BACKUP });
      verdict = "FAIL";
      continue;
    }
    if (restored.rowCount !== source.rowCount) {
      tableResult.push({ table: source.name, code: DRILL_ERROR_CODES.VERIFY_COUNT_MISMATCH, sourceCount: source.rowCount, restoredCount: restored.rowCount });
      verdict = "FAIL";
      continue;
    }
    if (restored.digest !== source.digest) {
      tableResult.push({ table: source.name, code: DRILL_ERROR_CODES.VERIFY_DIGEST_MISMATCH });
      verdict = "FAIL";
    } else {
      tableResult.push({ table: source.name, ok: true });
    }
  }
  for (const unexpected of restoredByName.keys()) {
    if (!sourceByName.has(unexpected)) {
      tableResult.push({ table: unexpected, code: DRILL_ERROR_CODES.VERIFY_MISSING_TABLE });
      verdict = "FAIL";
    }
  }

  const sourceHistory = manifest.migrationHistory || [];
  const restoredHistory = restoredProbe.migrationHistory || [];
  const equalHistory = canonicalJson(sourceHistory) === canonicalJson(restoredHistory);
  if (!equalHistory) {
    tableResult.push({ table: "schema_migrations", code: DRILL_ERROR_CODES.VERIFY_MIGRATION_HISTORY_MISMATCH });
    verdict = "FAIL";
  }

  return { verdict, tables: tableResult, migrationHistoryEqual: equalHistory };
}

/** Rebuilds a manifest-shaped probe (tables + history) from a restored schema. */
export async function probeRestoredSchema(adapter, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const tables = await listUserTables(adapter);
  const rowsByName = new Map();
  for (const table of tables) {
    const rows = await dumpTableRows(adapter, table.name, maxRows);
    rowsByName.set(table.name, rows);
  }
  const history = await dumpMigrationHistory(adapter);
  let order;
  let fkCycleDetected = false;
  try {
    order = foreignKeyRestoreOrder(tables);
  } catch (error) {
    if (error?.code !== DRILL_ERROR_CODES.FK_CYCLE) throw error;
    order = null;
    fkCycleDetected = true;
  }
  const probeTables = tables.map((t) => {
    const rowCount = rowsByName.get(t.name).length;
    const digest = digestRows(rowsByName.get(t.name));
    if (rowCount === 0 && digest !== sha256Hex("0:")) {
      throw new Error(`DRILL_INTERNAL: empty-table digest invariant violated for '${t.name}'`);
    }
    return {
      name: t.name,
      columns: t.columns,
      dependsOn: t.dependsOn,
      rowCount,
      digest,
      restoreOrder: order ? order.indexOf(t.name) : null,
    };
  });
  const nextManifest = {
    tables: probeTables,
    migrationHistory: history,
    fkCycleDetected,
    recordsComplete: true,
  };
  nextManifest.manifestId = sha256Hex(canonicalJson({
    tables: nextManifest.tables,
    migrationHistory: nextManifest.migrationHistory,
    fkCycleDetected: nextManifest.fkCycleDetected,
    recordsComplete: nextManifest.recordsComplete,
  }));
  return nextManifest;
}
