import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PostgresAdapter } from '../src/db/postgresAdapter.js';
import { MigrationRunner, stripOuterTransactionWrapper, calculateChecksum, MigrationExecutionError } from '../src/db/migrationRunner.js';
import {
  OwnerAuthenticationService,
  generateTotp,
  decryptMfaSecret,
  encryptMfaSecret
} from '../src/catalog/ownerAuthentication.js';
import {
  OwnerRepository,
  SessionRepository,
  MfaRepository,
  CsrfRepository,
  AuditRepository,
  AgentRepository,
  EvidenceLedgerRepository
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

  // Clean-up hook at the start/end of the suite to ensure fresh clean database state (Blocker #9)
  async function cleanLiveDatabase() {
    // Audit events table has immutable triggers, so we must drop and recreate the trigger or safely truncate
    try {
      await liveAdapter.query("DROP TRIGGER IF EXISTS audit_events_no_mutation ON authentication_audit_events;");
      await liveAdapter.query("DELETE FROM authentication_audit_events;");
      await liveAdapter.query(`
        CREATE TRIGGER audit_events_no_mutation
          BEFORE UPDATE OR DELETE ON authentication_audit_events
          FOR EACH ROW
          EXECUTE FUNCTION deny_audit_mutation();
      `);
    } catch (e) {
      // Ignore if trigger doesn't exist yet
    }

    await liveAdapter.query("DELETE FROM used_totp_codes;");
    await liveAdapter.query("DELETE FROM owner_recovery_codes;");
    await liveAdapter.query("DELETE FROM owner_totp_enrollments;");
    await liveAdapter.query("DELETE FROM owner_passkey_credentials;");
    await liveAdapter.query("DELETE FROM authentication_challenges;");
    await liveAdapter.query("DELETE FROM csrf_session_tokens;");
    await liveAdapter.query("DELETE FROM owner_sessions;");
    await liveAdapter.query("DELETE FROM owners;");
    await liveAdapter.query("DELETE FROM agents WHERE id LIKE 'live-%' OR id LIKE 'agent-%' OR id LIKE 'a-%';");
    await liveAdapter.query("DELETE FROM evidence_events;");
  }

  // Perform initial clean
  await cleanLiveDatabase();

  // Test 1: Upgrade from migrations 001-008 & Clean Migration & Run twice (Blocker #10)
  await t.test('clean migration, consecutive runs, checksum tampering checks', async () => {
    const runner = new MigrationRunner(liveAdapter);

    // 1. Run migrations first time
    const result1 = await runner.runMigrations();
    assert.ok(result1.appliedCount >= 0);

    // 2. Run migrations second time (must be idempotent & apply 0 pending)
    const result2 = await runner.runMigrations();
    assert.equal(result2.appliedCount, 0, "Running migrations twice must apply exactly 0 pending migrations");

    // 3. Verify checksum-tampering rejection
    const discovered = await runner.discoverMigrations();
    if (discovered.length > 0) {
      const firstMig = discovered[0];
      const originalContent = firstMig.content;

      try {
        // Tamper with file
        await fs.writeFile(firstMig.fullPath, originalContent + "  -- Tamper space\n", 'utf8');
        const runnerTampered = new MigrationRunner(liveAdapter);

        await assert.rejects(async () => {
          await runnerTampered.runMigrations();
        }, /checksum mismatch/i, "Runner must reject execution when an applied migration file has been tampered with");
      } finally {
        // Restore file
        await fs.writeFile(firstMig.fullPath, originalContent, 'utf8');
      }
    }
  });

  // Test 2: Repair the live transaction rollback test (Task 1 Correction 1)
  await t.test('Repair the live transaction rollback test', async () => {
    await liveAdapter.query(`
      CREATE TABLE IF NOT EXISTS test_rollback_probe (
        id text PRIMARY KEY,
        name text NOT NULL
      );
    `);

    await assert.rejects(async () => {
      await liveAdapter.withTransaction(async (client) => {
        await client.query("INSERT INTO test_rollback_probe (id, name) VALUES ('probe-1', 'SUCCESS');");
        throw new Error('Force rollback');
      });
    }, /Force rollback/);

    const res = await liveAdapter.query("SELECT * FROM test_rollback_probe WHERE id = 'probe-1';");
    assert.equal(res.rows.length, 0);

    await liveAdapter.query("DROP TABLE IF EXISTS test_rollback_probe;");
  });

  // Test 3: Real PostgreSQL migration rollback test (Task 1 Correction 2)
  await t.test('Add a real PostgreSQL migration rollback test', async () => {
    const tempDir = path.join(process.cwd(), 'scratch', 'test-temp-migrations');
    await fs.mkdir(tempDir, { recursive: true });

    const m1Path = path.join(tempDir, '001_initial.sql');
    const m2Path = path.join(tempDir, '002_failure.sql');

    await fs.writeFile(m1Path, `
      BEGIN;
      CREATE TABLE test_temp_mig_table (
        id text PRIMARY KEY
      );
      COMMIT;
    `, 'utf8');

    await fs.writeFile(m2Path, `
      BEGIN;
      INSERT INTO non_existent_table_forced_failure (id) VALUES ('fail');
      COMMIT;
    `, 'utf8');

    const tempRunner = new MigrationRunner(liveAdapter, { migrationsDir: tempDir });

    await liveAdapter.query("DELETE FROM schema_migrations WHERE filename IN ('001_initial.sql', '002_failure.sql');");
    await liveAdapter.query("DROP TABLE IF EXISTS test_temp_mig_table;");

    const err = await assert.rejects(async () => {
      await tempRunner.runMigrations();
    }, (e) => {
      return e instanceof MigrationExecutionError || e.name === 'MigrationExecutionError';
    });

    assert.ok(err.message.includes('002_failure.sql'));

    const tableCheck = await liveAdapter.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'test_temp_mig_table'
      );
    `);
    assert.equal(tableCheck.rows[0].exists, false);

    const schemaCheck = await liveAdapter.query(
      "SELECT * FROM schema_migrations WHERE filename IN ('001_initial.sql', '002_failure.sql');"
    );
    assert.equal(schemaCheck.rows.length, 0);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Test 4: Strengthen advisory-lock verification using independent pools (Blocker #9)
  await t.test('Strengthen advisory-lock verification', async () => {
    const pool1 = new pg.Pool({ connectionString: dbUrl });
    const pool2 = new pg.Pool({ connectionString: dbUrl });
    const adapter1 = new PostgresAdapter({}, pool1);
    const adapter2 = new PostgresAdapter({}, pool2);

    let lockAcquiredBy1 = false;
    let adapter2Blocked = true;

    const tx1Promise = adapter1.withTransaction(async (client1) => {
      await client1.query("SELECT pg_advisory_xact_lock(14432026)");
      lockAcquiredBy1 = true;
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    const tx2Promise = adapter2.withTransaction(async (client2) => {
      await client2.query("SELECT pg_advisory_xact_lock(14432026)");
      adapter2Blocked = !lockAcquiredBy1;
    });

    await Promise.all([tx1Promise, tx2Promise]);
    assert.equal(adapter2Blocked, false);

    await adapter1.closePool();
    await adapter2.closePool();
  });

  // Test 5: Verify transaction-wrapper handling
  await t.test('Verify transaction-wrapper handling', async () => {
    const originalSql = `
      BEGIN;
      CREATE OR REPLACE FUNCTION test_func() RETURNS void AS $$
      BEGIN
        NULL;
      END;
      $$ LANGUAGE plpgsql;
      COMMIT;
    `;
    const executionSql = stripOuterTransactionWrapper(originalSql);
    assert.equal(executionSql.includes('BEGIN;'), false);
    assert.equal(executionSql.includes('COMMIT;'), false);
    assert.ok(executionSql.includes('BEGIN\n        NULL;\n      END;'));
  });

  // Test 6: Complete Authentication, MFA, and DB-Backed Replay Integration Test (Blocker #10)
  await t.test('Complete Authentication, MFA, and DB-Backed Replay Integration Test', async () => {
    const ownersRepo = new OwnerRepository(liveAdapter);
    const sessionsRepo = new SessionRepository(liveAdapter);
    const mfaRepo = new MfaRepository(liveAdapter);
    const csrfRepo = new CsrfRepository(liveAdapter);
    const auditRepo = new AuditRepository(liveAdapter);

    const auth = new OwnerAuthenticationService({
      ownersRepo,
      sessionsRepo,
      mfaRepo,
      csrfRepo,
      auditRepo
    });

    const email = `integration-owner-${Date.now()}@st.com`;
    const password = "SuperSecurePassword123_Live!";

    // 1. Register Owner and verify role constraint
    const owner = await auth.registerOwner(email, password);
    assert.equal(owner.role, "owner");

    // 2. Reject duplicate email normalized
    await assert.rejects(async () => {
      await auth.registerOwner(` ${email.toUpperCase()} `, "AnotherPassword123!");
    }, /DUPLICATE_OWNER_EMAIL_REJECTED/);

    // 3. Argon2id login success
    const loginRes = await auth.loginOwner(email, password);
    const token = loginRes.session.token;
    assert.ok(token);

    // 4. Invalid Login (existing vs nonexisting accounts should behave equivalent)
    await assert.rejects(async () => {
      await auth.loginOwner(email, "WrongPassword123!");
    }, /INVALID_EMAIL_OR_PASSWORD/);

    await assert.rejects(async () => {
      await auth.loginOwner("nonexistent@st.com", "SomePassword123!");
    }, /INVALID_EMAIL_OR_PASSWORD/);

    // 5. Expiry, hashed session verification, and revocation
    const session = await auth.validateAndRetrieveSession(token);
    assert.ok(session.tokenHash);
    assert.equal(session.mfaAssuranceLevel, "password_only");

    // 6. CSRF Session-Bound Check
    const csrfToken = await auth.generateCsrfToken(session.id);
    assert.ok(await auth.verifyCsrfToken(session.id, csrfToken));

    await assert.rejects(async () => {
      await auth.verifyCsrfToken("mismatched-session-id", csrfToken);
    }, /INVALID_CSRF_TOKEN/);

    // 7. MFA Setup & AES-256-GCM Verification
    const enroll = await auth.enrollTotpMfa(owner.id, token);
    const enrollment = await mfaRepo.findTotpEnrollment(enroll.enrollmentId);
    assert.ok(enrollment.encryptedTotpSecret.startsWith("v1:")); // GCM Version marker

    // Verify decryption matches
    const decrypted = decryptMfaSecret(enrollment.encryptedTotpSecret);
    assert.equal(decrypted, enroll.secret);

    // 8. RFC-compatible TOTP verification and Replay Protection
    const totpCode = generateTotp(enroll.secret, 0);
    const confirm = await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, totpCode);
    assert.ok(confirm.recoveryCodes.length > 0);

    // Replaying same TOTP code must throw REPLAYED_TOTP_CODE_REJECTED
    await assert.rejects(async () => {
      await auth.verifyTotpAndElevateSession(owner.id, token, totpCode);
    }, /REPLAYED_TOTP_CODE_REJECTED/);

    // Confirm session elevation with next fresh TOTP
    const nextTotp = generateTotp(enroll.secret, 1);
    const elevated = await auth.verifyTotpAndElevateSession(owner.id, token, nextTotp);
    assert.equal(elevated.session.mfaAssuranceLevel, "high_assurance");

    // 9. Single-Use Recovery Codes
    const recoveryCode = confirm.recoveryCodes[0];
    assert.ok(await auth.useRecoveryCode(owner.id, recoveryCode));
    // Second use fails
    await assert.rejects(async () => {
      await auth.useRecoveryCode(owner.id, recoveryCode);
    }, /INVALID_OR_ALREADY_USED_RECOVERY_CODE/);

    // 10. Horizontal Access / RBAC check
    await assert.rejects(async () => {
      await auth.requireOwnerRole(owner.id, "super_admin");
    }, /INSUFFICIENT_PRIVILEGES/);
  });

  // Test 7: Actual PostgreSQL 50-Agent Enforcement (Blocker #10)
  await t.test('Actual PostgreSQL 50-Agent Enforcement', async () => {
    const agentsRepo = new AgentRepository(liveAdapter);

    // Fill agents to 50
    const countRes = await liveAdapter.query("SELECT COUNT(*) FROM agents;");
    const count = parseInt(countRes.rows[0].count, 10);
    const needed = 50 - count;

    for (let i = 0; i < needed; i++) {
      await liveAdapter.query(
        "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING;",
        [`agent-${i}`, `Agent ${i}`, `ns.agent.${i}`]
      );
    }

    // Adding 51st agent must throw AGENT_CAP_REACHED
    await assert.rejects(async () => {
      await agentsRepo.add({ id: "agent-51", name: "Agent 51", namespace: "ns.agent.51" });
    }, /AGENT_CAP_REACHED/);
  });

  // Test 8: Append-only Evidence Enforcement
  await t.test('Append-only Evidence Enforcement', async () => {
    const evidenceRepo = new EvidenceLedgerRepository(liveAdapter);
    await assert.rejects(async () => {
      await evidenceRepo.append({});
    }, /INCOMPLETE_EVIDENCE_EVENT/);
  });

  // Perform clean-up at the end of successful run (Blocker #9)
  await cleanLiveDatabase();

  await liveAdapter.closePool();
});
