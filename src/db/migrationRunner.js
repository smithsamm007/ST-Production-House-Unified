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
  executionSql = executionSql.replace(/^\s*(?:--(?:[^\n]*\n|\n)|\/\*[\s\S]*?\*\/\s*)*\bBEGIN(?:\s+TRANSACTION)?\s*;/i, (match) => {
    const commentsOnly = match.replace(/\bBEGIN(?:\s+TRANSACTION)?\s*;/i, '');
    return commentsOnly;
  });

  // Match trailing outer COMMIT; / COMMIT TRANSACTION; ignoring trailing comments/whitespace
  executionSql = executionSql.replace(/\s*\b(?:COMMIT|COMMIT\s+TRANSACTION)\s*;\s*(?:--(?:[^\n]*\n|\n)|\/\*[\s\S]*?\*\/\s*)*$/i, (match) => {
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
  async runMigrations() {
    const discovered = await this.discoverMigrations();

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
