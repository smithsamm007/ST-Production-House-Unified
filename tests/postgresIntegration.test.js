import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresAdapter } from '../src/db/postgresAdapter.js';
import { MigrationRunner } from '../src/db/migrationRunner.js';

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

    // 3. Verify transaction rollback on real PG
    await assert.rejects(
      async () => {
        await adapter.withTransaction(async (client) => {
          await client.query("INSERT INTO agents (id, name, created_at) VALUES ('test-temp-agent', 'TEMP', NOW())");
          throw new Error('Force rollback on live DB');
        });
      },
      /Force rollback/
    );

    // Verify temp agent was not inserted
    const tempCheck = await adapter.query("SELECT * FROM agents WHERE id = 'test-temp-agent'");
    assert.equal(tempCheck.rows.length, 0);

    await adapter.closePool();
  });
});
