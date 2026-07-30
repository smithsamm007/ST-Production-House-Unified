import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  MigrationRunner,
  calculateChecksum,
  stripOuterTransactionWrapper,
  MigrationChecksumMismatchError,
  MigrationExecutionError,
} from '../src/db/migrationRunner.js';
import { sanitizeError } from '../src/db/postgresAdapter.js';

class MockPostgresAdapter {
  constructor() {
    this.tables = new Map(); // table_name -> rows
    this.executedQueries = [];
    this.advisoryLocksHeld = new Set();
  }

  async query(text, params = []) {
    this.executedQueries.push({ text, params });
    const trimmed = text.trim();

    if (trimmed.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      if (!this.tables.has('schema_migrations')) {
        this.tables.set('schema_migrations', []);
      }
      return { rows: [] };
    }

    if (trimmed.includes('SELECT pg_advisory_xact_lock')) {
      this.advisoryLocksHeld.add(`${params[0]}:${params[1]}`);
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }

    if (trimmed.includes('SELECT filename, checksum') && trimmed.includes('FROM schema_migrations')) {
      const rows = this.tables.get('schema_migrations') || [];
      return { rows: JSON.parse(JSON.stringify(rows)) };
    }

    if (trimmed.includes('INSERT INTO schema_migrations')) {
      const rows = this.tables.get('schema_migrations') || [];
      rows.push({
        filename: params[0],
        checksum: params[1],
        applied_at: new Date().toISOString(),
        execution_time_ms: params[2],
      });
      this.tables.set('schema_migrations', rows);
      return { rowCount: 1 };
    }

    if (trimmed === 'FAIL_MIGRATION_SQL') {
      throw new Error('Database syntax error in migration file password=secret123');
    }

    return { rows: [] };
  }

  async withTransaction(callback) {
    this.executedQueries.push({ text: 'BEGIN', params: [] });
    // Save table snapshots for in-memory rollback simulation
    const snapshot = new Map();
    for (const [k, v] of this.tables.entries()) {
      snapshot.set(k, JSON.parse(JSON.stringify(v)));
    }

    try {
      const result = await callback(this);
      this.executedQueries.push({ text: 'COMMIT', params: [] });
      return result;
    } catch (err) {
      this.tables = snapshot;
      this.executedQueries.push({ text: 'ROLLBACK', params: [] });
      throw err;
    }
  }
}

test('MigrationRunner - Transaction Stripping & Safety', async (t) => {
  await t.test('strips top-level BEGIN and COMMIT while preserving PL/pgSQL function blocks', () => {
    const rawSql = `BEGIN;\nCREATE OR REPLACE FUNCTION test_func() RETURNS void AS $$\nBEGIN\n  NULL;\nEND;\n$$ LANGUAGE plpgsql;\nCOMMIT;`;
    const stripped = stripOuterTransactionWrapper(rawSql);

    assert.ok(!stripped.startsWith('BEGIN;'));
    assert.ok(!stripped.endsWith('COMMIT;'));
    assert.ok(stripped.includes('BEGIN\n  NULL;\nEND;'));
  });

  await t.test('preserves raw file SHA-256 checksum despite outer transaction stripping', async () => {
    const rawSql = `BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;`;
    const expectedChecksum = calculateChecksum(rawSql);
    const stripped = stripOuterTransactionWrapper(rawSql);

    // Checksum of raw file on disk matches calculateChecksum(rawSql)
    assert.equal(calculateChecksum(rawSql), expectedChecksum);
    assert.notEqual(calculateChecksum(stripped), expectedChecksum);
  });
});

test('MigrationRunner - Custom Error Type Integrity', async (t) => {
  await t.test('MigrationChecksumMismatchError retains class type and properties after sanitization', () => {
    const origErr = new MigrationChecksumMismatchError(
      '001_core.sql',
      'abc_expected_hash',
      'xyz_recorded_hash_password=secret123'
    );
    const sanitized = sanitizeError(origErr);

    assert.ok(sanitized instanceof MigrationChecksumMismatchError);
    assert.equal(sanitized.filename, '001_core.sql');
    assert.equal(sanitized.expectedChecksum, 'abc_expected_hash');
    assert.ok(!sanitized.message.includes('secret123'));
    assert.ok(sanitized.message.includes('[REDACTED]'));
  });

  await t.test('MigrationExecutionError retains class type and properties after sanitization', () => {
    const origErr = new MigrationExecutionError(
      '008_owner_auth.sql',
      new Error('Failed connection postgresql://user:pass123@host:5432/db')
    );
    const sanitized = sanitizeError(origErr);

    assert.ok(sanitized instanceof MigrationExecutionError);
    assert.equal(sanitized.filename, '008_owner_auth.sql');
    assert.ok(!sanitized.message.includes('pass123'));
    assert.ok(sanitized.message.includes('[REDACTED]'));
  });
});

test('MigrationRunner - Discovery & Ordering', async (t) => {
  await t.test('discovers migration files in deterministic alphabetical order', async () => {
    const adapter = new MockPostgresAdapter();
    const runner = new MigrationRunner(adapter, {
      migrationsDir: path.join(process.cwd(), 'sql'),
    });

    const discovered = await runner.discoverMigrations();
    assert.ok(discovered.length >= 8);

    const filenames = discovered.map((m) => m.filename);
    const sorted = [...filenames].sort();
    assert.deepEqual(filenames, sorted);
    assert.equal(filenames[0], '001_core.sql');
    assert.equal(filenames[1], '002_seed_agents.sql');
  });
});

test('MigrationRunner - Execution, Idempotency & Locking', async (t) => {
  await t.test('runs first-time migrations and applies advisory lock', async () => {
    const adapter = new MockPostgresAdapter();
    const runner = new MigrationRunner(adapter, {
      migrationsDir: path.join(process.cwd(), 'sql'),
    });

    const result = await runner.runMigrations();
    assert.ok(result.appliedCount >= 8);
    assert.ok(adapter.advisoryLocksHeld.has('889900:112233'));

    const rows = adapter.tables.get('schema_migrations');
    assert.equal(rows.length, result.appliedCount);
    assert.equal(rows[0].filename, '001_core.sql');

    // Verify outer BEGIN/COMMIT from SQL file 001_core.sql were stripped so client did not receive extra BEGIN/COMMIT
    const clientQueries = adapter.executedQueries.map((q) => q.text);
    const beginCount = clientQueries.filter((q) => q === 'BEGIN').length;
    const commitCount = clientQueries.filter((q) => q === 'COMMIT').length;
    assert.equal(beginCount, 1);
    assert.equal(commitCount, 1);
  });

  await t.test('repeated migration run is idempotent (0 newly applied)', async () => {
    const adapter = new MockPostgresAdapter();
    const runner = new MigrationRunner(adapter, {
      migrationsDir: path.join(process.cwd(), 'sql'),
    });

    const firstRun = await runner.runMigrations();
    assert.ok(firstRun.appliedCount >= 8);

    const secondRun = await runner.runMigrations();
    assert.equal(secondRun.appliedCount, 0);
  });
});

test('MigrationRunner - Checksum Verification & Tamper Detection', async (t) => {
  await t.test('rejects execution if an applied migration file was modified', async () => {
    const adapter = new MockPostgresAdapter();
    const runner = new MigrationRunner(adapter, {
      migrationsDir: path.join(process.cwd(), 'sql'),
    });

    // Seed schema_migrations with a modified checksum for 001_core.sql
    adapter.tables.set('schema_migrations', [
      {
        filename: '001_core.sql',
        checksum: 'TAMPERED_FAKE_CHECKSUM_1234567890',
        applied_at: new Date().toISOString(),
        execution_time_ms: 10,
      },
    ]);

    await assert.rejects(
      async () => {
        await runner.runMigrations();
      },
      (err) => {
        assert.ok(err instanceof MigrationChecksumMismatchError);
        assert.equal(err.filename, '001_core.sql');
        assert.equal(err.recordedChecksum, 'TAMPERED_FAKE_CHECKSUM_1234567890');
        return true;
      }
    );
  });
});

test('MigrationRunner - Error Rollback & Status Reporting', async (t) => {
  await t.test('rolls back transaction on migration failure and stops remaining', async () => {
    // Create temporary directory with a valid migration and a failing migration
    const tmpDir = path.join(process.cwd(), 'scratch', 'test_migrations_tmp');
    await fs.mkdir(tmpDir, { recursive: true });

    await fs.writeFile(path.join(tmpDir, '001_valid.sql'), 'SELECT 1;');
    await fs.writeFile(path.join(tmpDir, '002_broken.sql'), 'FAIL_MIGRATION_SQL');

    try {
      const adapter = new MockPostgresAdapter();
      const runner = new MigrationRunner(adapter, { migrationsDir: tmpDir });

      await assert.rejects(
        async () => {
          await runner.runMigrations();
        },
        (err) => {
          assert.ok(err instanceof MigrationExecutionError);
          assert.equal(err.filename, '002_broken.sql');
          assert.ok(!err.message.includes('secret123'));
          return true;
        }
      );

      // Verify ROLLBACK was executed
      const queries = adapter.executedQueries.map((q) => q.text);
      assert.ok(queries.includes('BEGIN'));
      assert.ok(queries.includes('ROLLBACK'));

      // Verify zero migrations recorded in table due to rollback
      const rows = adapter.tables.get('schema_migrations') || [];
      assert.equal(rows.length, 0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('reports migration status accurately', async () => {
    const adapter = new MockPostgresAdapter();
    const runner = new MigrationRunner(adapter, {
      migrationsDir: path.join(process.cwd(), 'sql'),
    });

    const initialStatus = await runner.getStatus();
    assert.ok(initialStatus.length >= 8);
    assert.equal(initialStatus[0].status, 'PENDING');

    await runner.runMigrations();

    const postRunStatus = await runner.getStatus();
    assert.equal(postRunStatus[0].status, 'APPLIED');
    assert.ok(postRunStatus.every((s) => s.status === 'APPLIED'));
  });
});
