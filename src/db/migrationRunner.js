import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeError } from './postgresAdapter.js';

// Fixed 64-bit equivalent tuple keys for PostgreSQL advisory lock (889900, 112233)
const MIGRATION_ADVISORY_LOCK_KEY_1 = 889900;
const MIGRATION_ADVISORY_LOCK_KEY_2 = 112233;

export class MigrationChecksumMismatchError extends Error {
  constructor(filename, expectedChecksum, recordedChecksum) {
    super(
      `Migration checksum mismatch for file '${filename}'. ` +
      `Recorded checksum in schema_migrations: '${recordedChecksum}', ` +
      `Current file checksum: '${expectedChecksum}'. ` +
      `Applied migration files must not be modified.`
    );
    this.name = 'MigrationChecksumMismatchError';
    this.filename = filename;
    this.expectedChecksum = expectedChecksum;
    this.recordedChecksum = recordedChecksum;
  }
}

export class MigrationExecutionError extends Error {
  constructor(filename, originalError) {
    const sanitized = sanitizeError(originalError);
    super(`Migration failed on file '${filename}': ${sanitized.message}`);
    this.name = 'MigrationExecutionError';
    this.filename = filename;
    this.originalError = sanitized;
    this.code = originalError?.code ?? sanitized?.code ?? null;
  }
}

/**
 * Raised when a migration references an object by an unqualified name that is
 * visible to the catalog but unreachable through the effective search_path.
 *
 * This is the failure mode of a guard written as
 * `IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'x')`: the check is
 * catalog-global, while `... x` resolves through search_path, so a leftover
 * copy of the object in another schema suppresses creation and the reference
 * then fails with `type "x" does not exist`.
 *
 * The applied migration itself must never be edited to work around this; the
 * caller must migrate into `public` or include the owning schema in
 * search_path.
 */
export class MigrationSearchPathMismatchError extends MigrationExecutionError {
  constructor(filename, originalError, { objectName, existingSchemas, searchPath }) {
    super(filename, originalError);
    this.name = 'MigrationSearchPathMismatchError';
    this.objectName = objectName;
    this.existingSchemas = existingSchemas;
    this.searchPath = searchPath;
    this.message =
      `Migration failed on file '${filename}': ` +
      `${objectName ? `type "${objectName}"` : 'a required object'} exists in schema(s) [${existingSchemas.join(', ')}] ` +
      `but none of them is on the effective search_path "${searchPath}". ` +
      `A catalog-global existence check inside the migration therefore skipped creation ` +
      `while the unqualified reference could not be resolved. ` +
      `Migrate into public, or set search_path to include the owning schema. ` +
      `Applied migration files must not be modified.`;
  }
}

/**
 * Calculates SHA-256 checksum of UTF-8 text content.
 *
 * @param {string} content
 * @returns {string} Hex string SHA-256 hash
 */
export function calculateChecksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Strips exact leading outer `BEGIN;` / `BEGIN TRANSACTION;` and trailing outer `COMMIT;` / `COMMIT TRANSACTION;`
 * commands from migration SQL content so MigrationRunner retains single transaction ownership.
 * Checks original raw content for checksum calculations while stripping outer transaction wrappers for execution.
 *
 * @param {string} sqlContent
 * @returns {string} Executable SQL content
 */
export function stripOuterTransactionWrapper(sqlContent) {
  if (!sqlContent) return '';

  let executionSql = sqlContent;

  // Match leading outer BEGIN; / BEGIN TRANSACTION; ignoring leading comments/whitespace
  executionSql = executionSql.replace(/^\s*(?:--(?:[^\n]*\n|\n)|\/\*[\s\S]*?\*\/\s*)*\s*\bBEGIN(?:\s+TRANSACTION)?\s*;/i, (match) => {
    const commentsOnly = match.replace(/\bBEGIN(?:\s+TRANSACTION)?\s*;/i, '');
    return commentsOnly;
  });

  // Match trailing outer COMMIT; / COMMIT TRANSACTION; ignoring trailing comments/whitespace
  executionSql = executionSql.replace(/\s*\b(?:COMMIT|COMMIT\s+TRANSACTION)\s*;\s*(?:--(?:[^\n]*\n|\n)|\/\*[\s\S]*?\*\/\s*)*\s*$/i, (match) => {
    const commentsOnly = match.replace(/\s*\b(?:COMMIT|COMMIT\s+TRANSACTION)\s*;/i, '');
    return commentsOnly;
  });

  return executionSql;
}

export class MigrationRunner {
  /**
   * @param {Object} adapter - PostgresAdapter instance or compatible interface
   * @param {Object} [options={}]
   * @param {string} [options.migrationsDir] - Directory containing .sql migration files
   */
  constructor(adapter, options = {}) {
    if (!adapter || typeof adapter.query !== 'function') {
      throw new Error('MigrationRunner requires a valid PostgresAdapter instance.');
    }
    this.adapter = adapter;
    this.migrationsDir = options.migrationsDir || path.join(process.cwd(), 'sql');
  }

  /**
   * Discovers migration SQL files in the migrations directory in deterministic order.
   *
   * @returns {Promise<Array<{filename: string, fullPath: string, content: string, checksum: string}>>}
   */
  async discoverMigrations() {
    try {
      const files = await fs.readdir(this.migrationsDir);
      const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

      const migrations = [];
      for (const filename of sqlFiles) {
        const fullPath = path.join(this.migrationsDir, filename);
        const content = await fs.readFile(fullPath, 'utf8');
        const checksum = calculateChecksum(content);
        migrations.push({ filename, fullPath, content, checksum });
      }

      return migrations;
    } catch (err) {
      throw sanitizeError(new Error(`Failed to discover migrations in '${this.migrationsDir}': ${err.message}`));
    }
  }

  /**
   * Ensures schema_migrations tracking table exists.
   *
   * @param {import('pg').PoolClient|Object} clientOrAdapter
   * @returns {Promise<void>}
   */
  async ensureSchemaMigrationsTable(clientOrAdapter) {
    const sql = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        execution_time_ms INTEGER NOT NULL
      );
    `;
    await clientOrAdapter.query(sql);
  }

  /**
   * Returns current status of all discovered migrations (APPLIED, PENDING, CHECKSUM_MISMATCH).
   *
   * @returns {Promise<Array<Object>>}
   */
  async getStatus() {
    const discovered = await this.discoverMigrations();
    await this.ensureSchemaMigrationsTable(this.adapter);

    const res = await this.adapter.query('SELECT filename, checksum, applied_at, execution_time_ms FROM schema_migrations ORDER BY filename ASC');
    const appliedMap = new Map();
    for (const row of res.rows) {
      appliedMap.set(row.filename, row);
    }

    const statusList = [];
    for (const mig of discovered) {
      const applied = appliedMap.get(mig.filename);
      let status = 'PENDING';
      if (applied) {
        if (applied.checksum === mig.checksum) {
          status = 'APPLIED';
        } else {
          status = 'CHECKSUM_MISMATCH';
        }
      }

      statusList.push({
        filename: mig.filename,
        checksum: mig.checksum,
        status,
        appliedAt: applied ? applied.applied_at : null,
        executionTimeMs: applied ? applied.execution_time_ms : null,
        recordedChecksum: applied ? applied.checksum : null,
      });
    }

    return statusList;
  }

  /**
   * Runs all pending migrations sequentially inside a single transaction with advisory locking.
   *
   * @returns {Promise<{appliedCount: number, status: Array<Object>}>}
   */
  /**
   * Explains a `type "…" does not exist` failure when the object exists in a
   * schema the session cannot see. Returns null for every other failure (or when
   * any diagnostic probe fails) so genuine errors keep their original shape.
   *
   * Runs after the caller's transaction has rolled back and released its client,
   * so it cannot depend on an aborted session.
   *
   * @param {Error} error
   * @returns {Promise<null|{objectName: string, existingSchemas: Array<string>, searchPath: string}>}
   */
  async diagnoseUnreachableObject(error) {
    const code = error?.code ?? null;
    if (code !== '42704') return null;

    const match = /type "([^"]+)" does not exist/.exec(error?.message ?? '');
    if (!match) return null;
    const objectName = match[1];

    try {
      // Only user-owned schemas can be "misplaced"; pg_catalog and the
      // information schema are always implicitly reachable, so they must never
      // be reported as the owner of an unreachable object.
      const schemasRes = await this.adapter.query(
        `SELECT n.nspname
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = $1
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg\_%'
          ORDER BY n.nspname`,
        [objectName]
      );
      const existingSchemas = schemasRes.rows.map((row) => row.nspname);
      if (existingSchemas.length === 0) return null;

      // `current_schemas(true)` is the RESOLVED path for this session: it expands
      // "$user", keeps pg_catalog, and drops schemas that do not exist. `SHOW
      // search_path` cannot do any of that, so it would mis-report reachability.
      //
      // Unnested into rows on purpose: the array type can come back through the
      // adapter as a raw array literal string, and treating that as a list
      // silently produced a null diagnosis (caught by the acceptance test).
      const pathRes = await this.adapter.query(
        'SELECT unnest(current_schemas(true)) AS schema_name'
      );
      const onPath = pathRes.rows.map((row) => row.schema_name).filter((name) => typeof name === 'string');
      if (onPath.length === 0) return null;
      const searchPath = onPath.join(', ');

      // Reachable from this session: the failure has some other cause.
      if (existingSchemas.some((schema) => onPath.includes(schema))) return null;

      return { objectName, existingSchemas, searchPath };
    } catch {
      return null;
    }
  }

  async runMigrations() {
    const discovered = await this.discoverMigrations();

    try {
      return await this.runPendingMigrations(discovered);
    } catch (error) {
      const diagnosis = await this.diagnoseUnreachableObject(error);
      if (diagnosis) {
        throw new MigrationSearchPathMismatchError(error.filename ?? 'unknown', error, diagnosis);
      }
      throw error;
    }
  }

  /**
   * Applies pending migrations inside one advisory-locked transaction.
   *
   * @param {Array<Object>} discovered
   * @returns {Promise<{appliedCount: number, status: Array<Object>}>}
   */
  async runPendingMigrations(discovered) {
    return await this.adapter.withTransaction(async (client) => {
      // 1. Acquire advisory lock to prevent concurrent migrations across multiple instances/workers
      await client.query(
        'SELECT pg_advisory_xact_lock($1, $2)',
        [MIGRATION_ADVISORY_LOCK_KEY_1, MIGRATION_ADVISORY_LOCK_KEY_2]
      );

      // 2. Ensure schema_migrations table exists
      await this.ensureSchemaMigrationsTable(client);

      // 3. Fetch already applied migrations
      const res = await client.query('SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC');
      const appliedMap = new Map();
      for (const row of res.rows) {
        appliedMap.set(row.filename, row.checksum);
      }

      let appliedCount = 0;

      // 4. Verify checksums of applied migrations and apply pending migrations
      for (const mig of discovered) {
        const recordedChecksum = appliedMap.get(mig.filename);

        if (recordedChecksum !== undefined) {
          // Verify checksum match
          if (recordedChecksum !== mig.checksum) {
            throw new MigrationChecksumMismatchError(mig.filename, mig.checksum, recordedChecksum);
          }
          // Already applied & verified, skip
          continue;
        }

        // Apply new migration
        const startTime = Date.now();
        try {
          // Strip outer transaction wrappers so MigrationRunner retains transaction ownership
          const executionContent = stripOuterTransactionWrapper(mig.content);
          await client.query(executionContent);

          const executionTimeMs = Date.now() - startTime;

          // Record in schema_migrations table
          await client.query(
            `INSERT INTO schema_migrations (filename, checksum, execution_time_ms) VALUES ($1, $2, $3)`,
            [mig.filename, mig.checksum, executionTimeMs]
          );

          appliedCount++;
        } catch (err) {
          throw new MigrationExecutionError(mig.filename, err);
        }
      }

      const statusRes = await client.query('SELECT filename, checksum, applied_at, execution_time_ms FROM schema_migrations ORDER BY filename ASC');

      return {
        appliedCount,
        status: statusRes.rows,
      };
    });
  }
}

/**
 * Convenience function to execute migrations on a given adapter.
 *
 * @param {Object} adapter
 * @param {Object} [options={}]
 * @returns {Promise<{appliedCount: number, status: Array<Object>}>}
 */
export async function runMigrations(adapter, options = {}) {
  const runner = new MigrationRunner(adapter, options);
  return await runner.runMigrations();
}

/**
 * Convenience function to check migration status on a given adapter.
 *
 * @param {Object} adapter
 * @param {Object} [options={}]
 * @returns {Promise<Array<Object>>}
 */
export async function getMigrationStatus(adapter, options = {}) {
  const runner = new MigrationRunner(adapter, options);
  return await runner.getStatus();
}
