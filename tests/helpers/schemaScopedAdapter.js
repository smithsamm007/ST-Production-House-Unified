/**
 * Test-only helper: a pool whose sessions resolve unqualified names through one
 * isolated schema first.
 *
 * It lives under `tests/` deliberately. The production backup/restore drill no
 * longer uses schema isolation — it isolates each leg in its own database,
 * because `sql/032` cannot be applied twice in one database (see
 * docs/production/BACKUP_RESTORE_DRILL.md). Keeping this helper in `src/` would
 * suggest a supported schema-scoped deployment mode that does not exist.
 */
import pg from "pg";
import { PostgresAdapter } from "../../src/db/postgresAdapter.js";

export async function openSchemaAdapter(connectionString, schemaName, extraOptions = {}) {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${schemaName},public`,
    ...extraOptions,
  });
  return { pool, adapter: new PostgresAdapter({}, pool) };
}
