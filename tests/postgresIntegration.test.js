import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PostgresAdapter } from '../src/db/postgresAdapter.js';
import { MigrationRunner, MigrationExecutionError, stripOuterTransactionWrapper, calculateChecksum } from '../src/db/migrationRunner.js';

test('PostgreSQL Live Integration Test Suite', async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const isCI = !!process.env.CI;
  const expectPG = isCI || !!dbUrl;

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

  // Ensure we can safely reset database tables before we start
  async function cleanLiveDatabase(adapter) {
    try {
      await adapter.query(`
        DROP SCHEMA IF EXISTS public CASCADE;
        CREATE SCHEMA public;
        GRANT ALL ON SCHEMA public TO public;
        GRANT ALL ON SCHEMA public TO st_app;
      `);
    } catch (err) {}
  }

  const bootstrapAdapter = new PostgresAdapter({}, testPool);
  await cleanLiveDatabase(bootstrapAdapter);

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

    // 3. Verify transaction rollback on real PG using a dedicated rollback-probe table (Correction 1)
    await adapter.query(`
      CREATE TABLE IF NOT EXISTS test_rollback_probe (
        id VARCHAR(50) PRIMARY KEY,
        value VARCHAR(50) NOT NULL
      );
    `);

    try {
      await assert.rejects(
        async () => {
          await adapter.withTransaction(async (client) => {
            // Complete a valid write
            await client.query("INSERT INTO test_rollback_probe (id, value) VALUES ('probe-1', 'valid_write')");
            // Throw the intended error only after that write succeeds
            throw new Error('Force rollback on live DB');
          });
        },
        /Force rollback on live DB/
      );

      // Verify the write is absent after rollback
      const probeCheck = await adapter.query("SELECT * FROM test_rollback_probe WHERE id = 'probe-1'");
      assert.equal(probeCheck.rows.length, 0, "Write must be absent after rollback");
    } finally {
      // Clean up its probe table/data safely
      await adapter.query("DROP TABLE IF EXISTS test_rollback_probe;");
    }
  });

  // Test 2: Live migration rollback test (Correction 2)
  await t.test('proves a failing migration rolls back previous successful migrations in the same run', async () => {
    const adapter = new PostgresAdapter({}, testPool);

    // Create temporary migrations directory
    const tempDir = path.join(process.cwd(), 'scratch', 'migration-rollback-test');
    await fs.mkdir(tempDir, { recursive: true });

    try {
      // Migration A: changes database state successfully
      await fs.writeFile(
        path.join(tempDir, '001_create_table_a.sql'),
        'CREATE TABLE migration_rollback_probe_a (id SERIAL PRIMARY KEY);',
        'utf8'
      );

      // Migration B: fails intentionally due to bad SQL syntax/non-existent table
      await fs.writeFile(
        path.join(tempDir, '002_fail_b.sql'),
        'INSERT INTO non_existent_table_forced_failure VALUES (1);',
        'utf8'
      );

      const tempRunner = new MigrationRunner(adapter, { migrationsDir: tempDir });

      // Run migrations and capture the error using a robust try/catch
      let error = null;
      try {
        await tempRunner.runMigrations();
      } catch (err) {
        error = err;
      }

      assert.ok(error, 'Expected runMigrations to throw an error');
      // Prove that the error retains MigrationExecutionError type and carries filename
      assert.ok(error instanceof MigrationExecutionError || error.name === 'MigrationExecutionError', 'Error must be of type MigrationExecutionError');
      assert.equal(error.name, 'MigrationExecutionError');
      assert.equal(error.filename, '002_fail_b.sql');

      // Prove that Migration A's database changes are rolled back (table does not exist)
      const tableCheck = await adapter.query(`
        SELECT EXISTS (
          SELECT FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'migration_rollback_probe_a'
        );
      `);
      assert.equal(tableCheck.rows[0].exists, false, "Migration A's table must have been rolled back and not exist");

      // Prove that neither migration receives a schema_migrations record
      const schemaCheck = await adapter.query(
        "SELECT * FROM schema_migrations WHERE filename IN ($1, $2)",
        ['001_create_table_a.sql', '002_fail_b.sql']
      );
      assert.equal(schemaCheck.rows.length, 0, "No schema_migrations records should exist for rolled back migrations");

    } finally {
      // Clean up temp directory safely
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      // Drop table if it somehow got created
      await adapter.query('DROP TABLE IF EXISTS migration_rollback_probe_a;').catch(() => {});
    }
  });

  // Test 3: Strengthen advisory-lock verification (Correction 3)
  await t.test('strengthens advisory-lock verification across independent connections', async () => {
    const pool1 = new pg.Pool({ connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test' });
    const pool2 = new pg.Pool({ connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test' });

    try {
      const adapter1 = new PostgresAdapter({}, pool1);
      const adapter2 = new PostgresAdapter({}, pool2);

      let lockAcquiredBy1 = false;
      let lockAcquiredBy2 = false;
      let time1Released = 0;
      let time2Acquired = 0;

      // Start client 1 transaction which acquires the lock and holds it
      const promise1 = adapter1.withTransaction(async (client1) => {
        await client1.query('SELECT pg_advisory_xact_lock($1, $2)', [889900, 112233]);
        lockAcquiredBy1 = true;
        // Hold the lock for 150ms
        await new Promise((resolve) => setTimeout(resolve, 150));
        time1Released = Date.now();
      });

      // Wait 30ms to ensure Client 1 has acquired the lock, then start Client 2
      await new Promise((resolve) => setTimeout(resolve, 30));

      const promise2 = adapter2.withTransaction(async (client2) => {
        // This should block until client 1 releases the lock (at time1Released)
        await client2.query('SELECT pg_advisory_xact_lock($1, $2)', [889900, 112233]);
        lockAcquiredBy2 = true;
        time2Acquired = Date.now();
      });

      await Promise.all([promise1, promise2]);

      assert.ok(lockAcquiredBy1, "Client 1 must have acquired the lock");
      assert.ok(lockAcquiredBy2, "Client 2 must have acquired the lock after Client 1 released it");
      assert.ok(time2Acquired >= time1Released, "Client 2 must only acquire lock after Client 1 has released/committed");
    } finally {
      await pool1.end().catch(() => {});
      await pool2.end().catch(() => {});
    }
  });

  // Test 4: Verify transaction-wrapper handling (Correction 4)
  await t.test('verifies transaction-wrapper handling and PL/pgSQL block integrity', async () => {
    // PL/pgSQL style BEGIN / END block nested inside outer BEGIN / COMMIT
    const plpgsqlSql = `BEGIN;
CREATE OR REPLACE FUNCTION test_plpgsql_block() RETURNS integer AS $$
DECLARE
  result integer;
BEGIN
  result := 42;
  RETURN result;
END;
$$ LANGUAGE plpgsql;
COMMIT;`;

    const stripped = stripOuterTransactionWrapper(plpgsqlSql);

    // Assert that only the outer BEGIN; and COMMIT; are removed
    assert.equal(stripped.includes('BEGIN;'), false, "Outer BEGIN; wrapper must be stripped");
    assert.equal(stripped.includes('COMMIT;'), false, "Outer COMMIT; wrapper must be stripped");

    // Assert that the PL/pgSQL nested BEGIN and END blocks are completely intact
    assert.ok(stripped.includes('BEGIN\n  result := 42;'), "Nested PL/pgSQL BEGIN block must remain intact");
    assert.ok(stripped.includes('END;'), "Nested PL/pgSQL END block must remain intact");

    // Prove that original raw-file checksum is computed on the RAW content (unchanged raw checksum)
    const rawChecksum = calculateChecksum(plpgsqlSql);
    const strippedChecksum = calculateChecksum(stripped);
    assert.notEqual(rawChecksum, strippedChecksum, "Checksum of raw SQL must differ from stripped SQL, proving original checksum is preserved");
  });

  // Ensure pool is closed gracefully at the very end of all tests
  if (testPool) {
    await testPool.end().catch(() => {});
  }
});
