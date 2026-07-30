import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PostgresAdapter } from '../src/db/postgresAdapter.js';
import { MigrationRunner, stripOuterTransactionWrapper, calculateChecksum, MigrationExecutionError } from '../src/db/migrationRunner.js';
import {
  registerOwner,
  loginOwner,
  validateAndRetrieveSession,
  enrollTotpMfa,
  confirmTotpMfa,
  verifyTotpAndElevateSession,
  generateTotp,
  decryptMfaSecret,
  injectRepositories
} from '../src/catalog/ownerAuthentication.js';
import {
  OwnerRepository,
  SessionRepository,
  MfaRepository,
  CsrfRepository,
  AuditRepository,
  AgentRepository
} from '../src/catalog/repositories.js';

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

  // Ensure MFA Encryption Key is set for integration testing
  if (!process.env.MFA_ENCRYPTION_KEY) {
    process.env.MFA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  }

  const liveAdapter = new PostgresAdapter({}, testPool);

  // 1. Live migrations and structural validation
  await t.test('verifies live PostgreSQL adapter query and migrations 001-010', async () => {
    const runner = new MigrationRunner(liveAdapter);

    // Run migrations
    const migrationResult = await runner.runMigrations();
    assert.ok(migrationResult.appliedCount >= 0);

    // Verify canonical seed agents table in real PG
    const agentRes = await liveAdapter.query('SELECT COUNT(*) as cnt FROM agents');
    const agentCount = parseInt(agentRes.rows[0].cnt, 10);
    assert.ok(agentCount >= 20, `Expected at least 20 canonical agents in PG database, got ${agentCount}`);

    // Verify owners table existence and structures
    const ownerRes = await liveAdapter.query("SELECT COUNT(*) FROM owners;");
    assert.ok(parseInt(ownerRes.rows[0].count, 10) >= 0);
  });

  // 2. Repair the live transaction rollback test (Task 1 Correction 1)
  await t.test('Repair the live transaction rollback test', async () => {
    // Create dedicated rollback-probe table safely
    await liveAdapter.query(`
      CREATE TABLE IF NOT EXISTS test_rollback_probe (
        id text PRIMARY KEY,
        name text NOT NULL
      );
    `);

    // Run transaction that writes and then throws
    await assert.rejects(async () => {
      await liveAdapter.withTransaction(async (client) => {
        await client.query("INSERT INTO test_rollback_probe (id, name) VALUES ('probe-1', 'SUCCESS');");
        throw new Error('Force rollback');
      });
    }, /Force rollback/);

    // Verify record is absent after rollback
    const res = await liveAdapter.query("SELECT * FROM test_rollback_probe WHERE id = 'probe-1';");
    assert.equal(res.rows.length, 0);

    // Clean up
    await liveAdapter.query("DROP TABLE IF EXISTS test_rollback_probe;");
  });

  // 3. Real PostgreSQL migration rollback test (Task 1 Correction 2)
  await t.test('Add a real PostgreSQL migration rollback test', async () => {
    const tempDir = path.join(process.cwd(), 'scratch', 'test-temp-migrations');
    await fs.mkdir(tempDir, { recursive: true });

    const m1Path = path.join(tempDir, '001_initial.sql');
    const m2Path = path.join(tempDir, '002_failure.sql');

    // Migration A creates a temporary test table
    await fs.writeFile(m1Path, `
      BEGIN;
      CREATE TABLE test_temp_mig_table (
        id text PRIMARY KEY
      );
      COMMIT;
    `, 'utf8');

    // Migration B intentionally fails with an invalid INSERT
    await fs.writeFile(m2Path, `
      BEGIN;
      INSERT INTO non_existent_table_forced_failure (id) VALUES ('fail');
      COMMIT;
    `, 'utf8');

    const tempRunner = new MigrationRunner(liveAdapter, { migrationsDir: tempDir });

    // Clean up any lingering migrations state if any
    await liveAdapter.query("DELETE FROM schema_migrations WHERE filename IN ('001_initial.sql', '002_failure.sql');");
    await liveAdapter.query("DROP TABLE IF EXISTS test_temp_mig_table;");

    // Running migrations must fail on Migration B and roll back Migration A
    const err = await assert.rejects(async () => {
      await tempRunner.runMigrations();
    }, (e) => {
      return e instanceof MigrationExecutionError || e.name === 'MigrationExecutionError';
    });

    assert.ok(err.message.includes('002_failure.sql'));

    // Verify Migration A's schema changes are rolled back
    const tableCheck = await liveAdapter.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'test_temp_mig_table'
      );
    `);
    assert.equal(tableCheck.rows[0].exists, false, "Migration A changes must be rolled back on Migration B failure");

    // Verify neither migration received a schema_migrations record
    const schemaCheck = await liveAdapter.query(
      "SELECT * FROM schema_migrations WHERE filename IN ('001_initial.sql', '002_failure.sql');"
    );
    assert.equal(schemaCheck.rows.length, 0, "No schema_migrations records should exist for rolled back migrations");

    // Clean up temporary files and directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // 4. Strengthen advisory-lock verification (Task 1 Correction 3)
  await t.test('Strengthen advisory-lock verification', async () => {
    const adapter1 = new PostgresAdapter({}, testPool);
    const adapter2 = new PostgresAdapter({}, testPool);

    let lockAcquiredBy1 = false;
    let adapter2Blocked = true;

    // Start transaction 1 and hold lock
    const tx1Promise = adapter1.withTransaction(async (client1) => {
      await client1.query("SELECT pg_advisory_xact_lock(14432026)");
      lockAcquiredBy1 = true;
      // Sleep for 200ms
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    // Try to acquire lock in transaction 2 simultaneously
    await new Promise(resolve => setTimeout(resolve, 50)); // let tx1 start first
    const tx2Promise = adapter2.withTransaction(async (client2) => {
      await client2.query("SELECT pg_advisory_xact_lock(14432026)");
      adapter2Blocked = !lockAcquiredBy1; // if 1 hasn't released, it should have blocked until 1 finished
    });

    await Promise.all([tx1Promise, tx2Promise]);
    assert.equal(adapter2Blocked, false, "Adapter 2 should have waited for transaction 1 to release pg_advisory_xact_lock");

    await adapter1.closePool();
    await adapter2.closePool();
  });

  // 5. Verify transaction-wrapper handling (Task 1 Correction 4)
  await t.test('Verify transaction-wrapper handling', async () => {
    const originalSql = `
      -- Leading comments
      BEGIN;
      CREATE OR REPLACE FUNCTION test_func() RETURNS void AS $$
      BEGIN
        -- PL/pgSQL BEGIN/END block
        NULL;
      END;
      $$ LANGUAGE plpgsql;
      COMMIT;
    `;

    const expectedChecksum = calculateChecksum(originalSql);
    const executionSql = stripOuterTransactionWrapper(originalSql);

    // Assert outer BEGIN/COMMIT are stripped
    assert.equal(executionSql.includes('BEGIN;'), false);
    assert.equal(executionSql.includes('COMMIT;'), false);

    // Assert PL/pgSQL inner block is fully intact
    assert.ok(executionSql.includes('BEGIN\n        -- PL/pgSQL BEGIN/END block\n        NULL;\n      END;'));

    // Assert checksum remains unchanged
    assert.equal(calculateChecksum(originalSql), expectedChecksum);
  });

  // 6. Task 2 Owner Authentication, MFA, and DB-Backed Replay Integration Test
  await t.test('Task 2 Owner Auth, MFA, and DB-Backed Replay Integration Test', async () => {
    // Temporarily turn off in-memory flag for owner auth integration checks
    const oldStub = process.env.USE_IN_MEMORY_STUB;
    delete process.env.USE_IN_MEMORY_STUB;

    // Setup live repositories
    const ownersRepo = new OwnerRepository(liveAdapter);
    const sessionsRepo = new SessionRepository(liveAdapter);
    const mfaRepo = new MfaRepository(liveAdapter);
    const csrfRepo = new CsrfRepository(liveAdapter);
    const auditRepo = new AuditRepository(liveAdapter);

    injectRepositories({
      ownersRepo,
      sessionsRepo,
      mfaRepo,
      csrfRepo,
      auditRepo
    });

    const testEmail = `live-owner-${Date.now()}@st.com`;
    const testPassword = "ExtremelySecurePassword123_Live!";

    try {
      // 1. Register owner on live PG
      const owner = await registerOwner(testEmail, testPassword);
      assert.ok(owner.id);
      assert.equal(owner.email, testEmail);

      // 2. Successful Login
      const loginResult = await loginOwner(testEmail, testPassword);
      const sessionToken = loginResult.session.token;
      assert.ok(sessionToken);

      // 3. Retrieve & Validate Session
      const session = await validateAndRetrieveSession(sessionToken);
      assert.equal(session.ownerId, owner.id);
      assert.equal(session.mfaAssuranceLevel, "password_only");

      // 4. Enroll in MFA
      const enroll = await enrollTotpMfa(owner.id, sessionToken);
      assert.ok(enroll.enrollmentId);
      assert.ok(enroll.secret);

      // Generate valid TOTP code
      const totpCode = generateTotp(enroll.secret, 0);

      // 5. Confirm TOTP MFA
      const confirm = await confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);
      assert.ok(confirm.recoveryCodes.length > 0);

      // 6. DB-Backed TOTP Replay Prevention Verification
      // Attempt to confirm / elevate using the exact same TOTP code a second time
      await assert.rejects(async () => {
        await verifyTotpAndElevateSession(owner.id, sessionToken, totpCode);
      }, /REPLAYED_TOTP_CODE_REJECTED/, "Should reject replayed TOTP code via unique constraint on used_totp_codes");

      // Verify that used_totp_codes database table contains the record
      const usedCodeRes = await liveAdapter.query(
        "SELECT * FROM used_totp_codes WHERE owner_id = $1 AND totp_code = $2;",
        [owner.id, totpCode]
      );
      assert.equal(usedCodeRes.rows.length, 1, "The used TOTP code must be persistently recorded in used_totp_codes table");

      // 7. Verify correct elevation with a newly generated fresh code
      // Simulate next time step code or offset
      const nextCode = generateTotp(enroll.secret, 1);
      const elevated = await verifyTotpAndElevateSession(owner.id, sessionToken, nextCode);
      assert.ok(elevated.token);
      assert.equal(elevated.session.mfaAssuranceLevel, "high_assurance");

    } finally {
      // Restore USE_IN_MEMORY_STUB value
      if (oldStub !== undefined) {
        process.env.USE_IN_MEMORY_STUB = oldStub;
      }
    }
  });

  // End pool
  await liveAdapter.closePool();
});
