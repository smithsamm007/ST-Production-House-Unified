import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PostgresAdapter } from '../src/db/postgresAdapter.js';
import { MigrationRunner, MigrationExecutionError, calculateChecksum } from '../src/db/migrationRunner.js';

test('PostgreSQL Live Integration Test Suite', async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const isCI = !!process.env.CI;
  const isIntegrationCmd = process.env.npm_lifecycle_event === 'test:integration';
  const expectPG = isCI || !!dbUrl || isIntegrationCmd;

  // Probe live PG connection
  let pgAvailable = false;
  let testPool = null;
  let lastConnectError = null;

  if (dbUrl || process.env.PGHOST || isCI) {
    try {
      testPool = new pg.Pool({
        connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test',
        host: process.env.PGHOST,
        port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        connectionTimeoutMillis: 5000,
      });
      const client = await testPool.connect();
      await client.query('SELECT 1');
      client.release();
      pgAvailable = true;
    } catch (err) {
      pgAvailable = false;
      lastConnectError = err;
      if (testPool) {
        await testPool.end().catch(() => {});
        testPool = null;
      }
    }
  }

  if (!pgAvailable) {
    if (expectPG) {
      assert.fail(
        `PostgreSQL 15 instance was expected in CI/integration test environment but could not be reached: ${lastConnectError ? lastConnectError.message : 'Connection failed'}`
      );
    } else {
      t.diagnostic(
        '[POSTGRESQL_INTEGRATION_TEST] NOTICE: Live PostgreSQL 15+ instance is not configured locally. ' +
        'Unit tests passed. Run with POSTGRES_TEST_URL=... to execute live integration tests.'
      );
      return;
    }
  }

  // Live PostgreSQL integration verification
  await t.test('verifies live PostgreSQL adapter query and migrations 001-008', async () => {
    const adapter = new PostgresAdapter({}, testPool);
    const runner = new MigrationRunner(adapter);

    // 1. Run migrations
    const migrationResult = await runner.runMigrations();
    assert.ok(migrationResult.appliedCount >= 0);

    // 2. Verify canonical seed agents table in real PG
    const agentRes = await adapter.query('SELECT COUNT(*) as cnt FROM agents');
    const agentCount = parseInt(agentRes.rows[0].cnt, 10);
    assert.ok(agentCount >= 20, `Expected at least 20 canonical agents in PG database, got ${agentCount}`);

    // 3. Verify transaction rollback on real PG using a dedicated rollback-probe table
    await adapter.query("DROP TABLE IF EXISTS test_rollback_probe");
    await adapter.query("CREATE TABLE test_rollback_probe (val text)");

    try {
      await assert.rejects(
        async () => {
          await adapter.withTransaction(async (client) => {
            // Complete a valid write inside PostgresAdapter.withTransaction()
            await client.query("INSERT INTO test_rollback_probe (val) VALUES ('PROBE_VAL')");
            // Throw the intended error only after that write succeeds
            throw new Error('Force rollback on live DB');
          });
        },
        /Force rollback on live DB/
      );

      // Verify the write is absent after rollback
      const tempCheck = await adapter.query("SELECT COUNT(*) as cnt FROM test_rollback_probe");
      const cnt = parseInt(tempCheck.rows[0].cnt, 10);
      assert.equal(cnt, 0, "Write should be rolled back and absent");
    } finally {
      // Clean up its probe table/data safely
      await adapter.query("DROP TABLE IF EXISTS test_rollback_probe");
    }
  });

  // Teardown pool at the end of the suite
  t.after(async () => {
    if (testPool) {
      await testPool.end().catch(() => {});
    }
  });

  await t.test('verifies live PostgreSQL migration transaction rollback', async () => {
    const adapter = new PostgresAdapter({}, testPool);

    // Ensure clean state before starting
    await adapter.query("DROP TABLE IF EXISTS test_mig_rollback_a_unique");
    await adapter.query("DELETE FROM schema_migrations WHERE filename IN ('001_mig_a_unique.sql', '002_mig_b_unique.sql')");

    // Create temporary migrations directory
    const tmpDir = path.join(process.cwd(), 'scratch_mig_rollback_test');
    await fs.mkdir(tmpDir, { recursive: true });

    // 001_mig_a_unique.sql creates table test_mig_rollback_a_unique
    await fs.writeFile(
      path.join(tmpDir, '001_mig_a_unique.sql'),
      'CREATE TABLE test_mig_rollback_a_unique (val text);'
    );
    // 002_mig_b_unique.sql fails intentionally
    await fs.writeFile(
      path.join(tmpDir, '002_mig_b_unique.sql'),
      'SELECT * FROM non_existent_table_for_rollback_test;'
    );

    const runner = new MigrationRunner(adapter, { migrationsDir: tmpDir });

    try {
      // Run migrations and expect MigrationExecutionError
      await assert.rejects(
        async () => {
          await runner.runMigrations();
        },
        (err) => {
          assert.equal(err.name, 'MigrationExecutionError', "Should retain MigrationExecutionError type");
          assert.equal(err.filename, '002_mig_b_unique.sql', "Error should point to the failing migration file");
          return true;
        }
      );

      // Verify Migration A's database changes are rolled back (table should not exist)
      const checkTable = await adapter.query(
        "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'test_mig_rollback_a_unique') as ex"
      );
      assert.equal(checkTable.rows[0].ex, false, "Table created by Migration A should be rolled back and not exist");

      // Verify neither migration receives a schema_migrations record
      const checkRecord = await adapter.query(
        "SELECT COUNT(*) as cnt FROM schema_migrations WHERE filename IN ('001_mig_a_unique.sql', '002_mig_b_unique.sql')"
      );
      assert.equal(parseInt(checkRecord.rows[0].cnt, 10), 0, "No records should exist in schema_migrations for either migration");

    } finally {
      // Clean up files safely
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await adapter.query("DROP TABLE IF EXISTS test_mig_rollback_a_unique").catch(() => {});
      await adapter.query("DELETE FROM schema_migrations WHERE filename IN ('001_mig_a_unique.sql', '002_mig_b_unique.sql')").catch(() => {});
    }
  });

  await t.test('verifies live advisory lock concurrency protection', async () => {
    const clientA = await testPool.connect();
    let clientAActive = true;

    try {
      // 1. Client A acquires transaction-level advisory lock
      await clientA.query('BEGIN');
      await clientA.query('SELECT pg_advisory_xact_lock(889900, 112233)');

      // 2. Concurrently attempt to run migrations using MigrationRunner on Client B
      const adapterB = new PostgresAdapter({}, testPool);
      const runnerB = new MigrationRunner(adapterB);

      let runnerBCompleted = false;
      let runnerBError = null;

      const runnerBPromise = runnerB.runMigrations()
        .then(() => {
          runnerBCompleted = true;
        })
        .catch((err) => {
          runnerBError = err;
          runnerBCompleted = true;
        });

      // 3. Sleep for 200ms and prove that Client B remains blocked (cannot enter section)
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(runnerBCompleted, false, "Client B migration runner must be blocked while Client A holds advisory lock");

      // 4. Client A releases lock by ending its transaction
      await clientA.query('ROLLBACK');
      clientAActive = false;

      // 5. Wait for Client B to unblock and complete successfully
      await runnerBPromise;

      if (runnerBError) {
        throw runnerBError;
      }
      assert.equal(runnerBCompleted, true, "Client B should successfully complete after lock is released");

    } finally {
      if (clientAActive) {
        await clientA.query('ROLLBACK').catch(() => {});
      }
      clientA.release();
    }
  });

  await t.test('verifies live transaction-wrapper handling and PL/pgSQL preservation', async () => {
    const adapter = new PostgresAdapter({}, testPool);

    // Ensure clean state before starting
    await adapter.query("DROP FUNCTION IF EXISTS test_wrapper_func_preservation_unique()");
    await adapter.query("DELETE FROM schema_migrations WHERE filename = '001_plpgsql_unique.sql'");

    const tmpDir = path.join(process.cwd(), 'scratch_mig_wrapper_test');
    await fs.mkdir(tmpDir, { recursive: true });

    // File with outer transaction wrapper, comments, and a PL/pgSQL function with internal BEGIN/END
    const rawSql = `
      -- Test Comment
      BEGIN;
      CREATE OR REPLACE FUNCTION test_wrapper_func_preservation_unique() RETURNS integer AS $$
      BEGIN
        RETURN 42;
      END;
      $$ LANGUAGE plpgsql;
      COMMIT;
      -- Trailing Comment
    `;

    const filepath = path.join(tmpDir, '001_plpgsql_unique.sql');
    await fs.writeFile(filepath, rawSql);

    // Get expected raw file checksum before runner execution
    const expectedChecksum = calculateChecksum(rawSql);

    const runner = new MigrationRunner(adapter, { migrationsDir: tmpDir });

    try {
      // Run the migration
      await runner.runMigrations();

      // 1. Prove that the PL/pgSQL function works on live PG (internal BEGIN/END remained intact)
      const res = await adapter.query("SELECT test_wrapper_func_preservation_unique() as val");
      assert.equal(parseInt(res.rows[0].val, 10), 42, "PL/pgSQL function should execute and return 42");

      // 2. Prove that raw-file on disk remains completely unchanged (its checksum is unchanged)
      const rawOnDisk = await fs.readFile(filepath, 'utf8');
      assert.equal(rawOnDisk, rawSql, "Raw file content on disk must remain identical");
      assert.equal(calculateChecksum(rawOnDisk), expectedChecksum, "SHA-256 of raw file must remain unchanged");

      // 3. Clean up database function and migration record
      await adapter.query("DROP FUNCTION IF EXISTS test_wrapper_func_preservation_unique()");
      await adapter.query("DELETE FROM schema_migrations WHERE filename = '001_plpgsql_unique.sql'");

    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await adapter.query("DROP FUNCTION IF EXISTS test_wrapper_func_preservation_unique()").catch(() => {});
      await adapter.query("DELETE FROM schema_migrations WHERE filename = '001_plpgsql_unique.sql'").catch(() => {});
    }
  });
});
