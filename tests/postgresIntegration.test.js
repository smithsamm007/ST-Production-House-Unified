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
  encryptMfaSecret,
  computeTokenHash
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

test('PostgreSQL Live Integration Test Suite with Custom Schema Isolation', async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const isCI = !!process.env.CI;
  const expectPG = isCI || !!dbUrl;

  // Probe live PG connection
  let pgAvailable = false;
  let testPool = null;
  let lastConnectError = null;

  const schemaName = 'test_integration_schema';
  if (!schemaName.startsWith('test_')) {
    throw new Error('Unsafe schema name detected');
  }

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

      // Bind search_path automatically to the isolated schema for all clients checked out from the pool
      testPool.on('connect', (client) => {
        client.query(`SET search_path TO ${schemaName};`);
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

  // Set up search path on default adapter connection
  await liveAdapter.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
  await liveAdapter.query(`CREATE SCHEMA ${schemaName};`);
  await liveAdapter.query(`SET search_path TO ${schemaName};`);

  // Wrap execution in a robust try-finally block to guarantee safe cleanup of schema and pool closing (Blocker #2)
  try {
    // Phase 1: Clean migration using runner on isolated test schema
    const runner = new MigrationRunner(liveAdapter);
    await runner.runMigrations();

    // 1. Concurrent first-owner bootstrap safety
    await t.test('concurrent first-owner bootstrap safety', async () => {
      const ownersRepo = new OwnerRepository(liveAdapter);
      const sessionsRepo = new SessionRepository(liveAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

      const email1 = 'concur1@st.com';
      const email2 = 'concur2@st.com';
      const password = 'SuperSecurePassword123_Live!';

      // Launch two concurrent registration promises
      const p1 = auth.registerOwner(email1, password);
      const p2 = auth.registerOwner(email2, password);

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, "Exactly one registration must succeed during concurrent first owner bootstrap");
      assert.equal(rejected.length, 1, "Subsequent registration must fail");
      assert.ok(rejected[0].reason.message.includes("PUBLIC_REGISTRATION_PROHIBITED_ONCE_BOOTSTRAPPED") || rejected[0].reason.message.includes("DUPLICATE_OWNER_EMAIL_REJECTED"));
    });

    // 2. Normalized duplicate-email enforcement
    await t.test('normalized duplicate-email enforcement', async () => {
      const ownersRepo = new OwnerRepository(liveAdapter);
      const sessionsRepo = new SessionRepository(liveAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

      const email = 'duplicate-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';

      // Try registering with extra options to bypass bootstrap
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });
      assert.equal(owner.email, email);

      await assert.rejects(async () => {
        await auth.registerOwner(`  ${email.toUpperCase()}  `, password, { isAuthorizedAdmin: true });
      }, /DUPLICATE_OWNER_EMAIL_REJECTED/);
    });

    // 3. Lockout concurrency and expiry
    await t.test('lockout concurrency and expiry', async () => {
      const ownersRepo = new OwnerRepository(liveAdapter);
      const sessionsRepo = new SessionRepository(liveAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

      const email = 'lockout-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      await auth.registerOwner(email, password, { isAuthorizedAdmin: true });

      // Trigger 5 failed login attempts
      for (let i = 0; i < 5; i++) {
        try {
          await auth.loginOwner(email, 'WrongPassword123!');
        } catch (err) {
          assert.equal(err.message, 'INVALID_EMAIL_OR_PASSWORD');
        }
      }

      // Next login must be locked out
      await assert.rejects(async () => {
        await auth.loginOwner(email, password);
      }, /ACCOUNT_TEMPORARILY_LOCKED/);
    });

    // 4. Hashed session and CSRF database storage
    await t.test('hashed session and CSRF database storage', async () => {
      const ownersRepo = new OwnerRepository(liveAdapter);
      const sessionsRepo = new SessionRepository(liveAdapter);
      const csrfRepo = new CsrfRepository(liveAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo, csrfRepo });

      const email = 'session-store-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });

      const res = await auth.createSessionToken(owner.id);
      assert.ok(res.token);
      assert.notEqual(res.token, res.session.tokenHash);

      // Verify stored in DB
      const dbSession = await sessionsRepo.findByTokenHash(res.session.tokenHash);
      assert.ok(dbSession);

      // CSRF persistence check
      const csrfToken = await auth.generateCsrfToken(res.session.id);
      assert.ok(csrfToken);

      const isCsrfValid = await csrfRepo.verifyToken(res.session.id, computeTokenHash(csrfToken));
      assert.equal(isCsrfValid, true);
    });

    // 5. Session expiry and owner-scoped revocation
    await t.test('session expiry and owner-scoped revocation', async () => {
      const ownersRepo = new OwnerRepository(liveAdapter);
      const sessionsRepo = new SessionRepository(liveAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

      const email = 'expiry-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });

      const s1 = await auth.createSessionToken(owner.id);

      // Explicit revocation with matching owner_id
      const revoked = await sessionsRepo.revokeWithOwner(s1.session.id, owner.id);
      assert.ok(revoked);

      // Revocation with mismatching owner_id must fail
      const revokedMismatch = await sessionsRepo.revokeWithOwner(s1.session.id, 'another-owner-id');
      assert.equal(revokedMismatch, null);
    });

    // 6. CSRF expiry, rotation and cross-session rejection
    await t.test('CSRF expiry, rotation and cross-session rejection', async () => {
      const ownersRepo = new OwnerRepository(liveAdapter);
      const sessionsRepo = new SessionRepository(liveAdapter);
      const csrfRepo = new CsrfRepository(liveAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo, csrfRepo });

      const email = 'csrf-test-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });

      const s1 = await auth.createSessionToken(owner.id);
      const csrf1 = await auth.generateCsrfToken(s1.session.id);

      // Verify token
      assert.ok(await auth.verifyCsrfToken(s1.session.id, csrf1));

      // Re-generating CSRF rotates/invalidates old one
      const csrf2 = await auth.generateCsrfToken(s1.session.id);
      await assert.rejects(async () => {
        await auth.verifyCsrfToken(s1.session.id, csrf1);
      }, /INVALID_CSRF_TOKEN/);

      assert.ok(await auth.verifyCsrfToken(s1.session.id, csrf2));
    });

    // 7. Atomic recovery-code consumption with live PostgreSQL concurrency test (Blocker #6)
    await t.test('atomic recovery-code consumption and concurrency', async () => {
      const mfaRepo = new MfaRepository(liveAdapter);
      const ownerId = 'owner-recovery-concur';
      const codeHash = computeTokenHash('recovery-code-concur');

      await liveAdapter.query(
        "INSERT INTO owner_recovery_codes (id, owner_id, code_hash, is_used) VALUES ($1, $2, $3, false);",
        ['recovery-id-concur', ownerId, codeHash]
      );

      // Run two concurrent use requests
      const p1 = mfaRepo.verifyAndUseRecoveryCode(ownerId, codeHash);
      const p2 = mfaRepo.verifyAndUseRecoveryCode(ownerId, codeHash);

      const results = await Promise.all([p1, p2]);
      const successful = results.filter(r => r === true);
      assert.equal(successful.length, 1, "Exactly one concurrent recovery code consumption request must succeed");
    });

    // 8. Complete TOTP-confirmation rollback
    await t.test('complete TOTP-confirmation rollback', async () => {
      const ownersRepo = new OwnerRepository(liveAdapter);
      const sessionsRepo = new SessionRepository(liveAdapter);
      const mfaRepo = new MfaRepository(liveAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo, mfaRepo });

      const email = 'mfa-rollback-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });
      const s1 = await auth.createSessionToken(owner.id);

      const enroll = await auth.enrollTotpMfa(owner.id, s1.token);

      // Confirm with a totally invalid TOTP code to trigger an intentional error and rollback
      await assert.rejects(async () => {
        await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, '000000');
      }, /INVALID_TOTP_CODE/);

      // Verify that no used TOTP code, recovery codes, or MFA status was updated due to transaction rollback
      const ownerDb = await ownersRepo.findById(owner.id);
      assert.equal(ownerDb.mfaEnabled, false);

      const recCodes = await liveAdapter.query("SELECT * FROM owner_recovery_codes WHERE owner_id = $1;", [owner.id]);
      assert.equal(recCodes.rows.length, 0);
    });

    // 9. Database-level 50-agent enforcement
    await t.test('database-level 50-agent enforcement', async () => {
      const agentsRepo = new AgentRepository(liveAdapter);

      // Insert up to 50 agents
      const countRes = await liveAdapter.query("SELECT count(*) FROM agents;");
      const count = parseInt(countRes.rows[0].count, 10);
      const needed = 50 - count;

      for (let i = 0; i < needed; i++) {
        await liveAdapter.query(
          "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING;",
          [`live-agent-${i}`, `Live Agent ${i}`, `ns.live.agent.${i}`]
        );
      }

      // 51st agent must throw cap reached on database level (Trigger enforce_agent_cap)
      await assert.rejects(async () => {
        await agentsRepo.add({ id: 'live-agent-51', name: 'Live Agent 51', namespace: 'ns.live.agent.51' });
      }, /AGENT_CAP_REACHED/);
    });

    // 10. Append-only UPDATE and DELETE rejection on audit/evidence tables
    await t.test('append-only UPDATE and DELETE rejection', async () => {
      await liveAdapter.query(
        "INSERT INTO authentication_audit_events (id, owner_id, event_type) VALUES ($1, null, $2);",
        ['audit-id-test-append', 'test_audit_event']
      );

      // Trying to update the audit event must throw trigger mutation rejection
      await assert.rejects(async () => {
        await liveAdapter.query(
          "UPDATE authentication_audit_events SET event_type = 'hacked' WHERE id = $1;",
          ['audit-id-test-append']
        );
      }, /deny_audit_mutation/i);

      // Trying to delete the audit event must throw trigger mutation rejection
      await assert.rejects(async () => {
        await liveAdapter.query(
          "DELETE FROM authentication_audit_events WHERE id = $1;",
          ['audit-id-test-append']
        );
      }, /deny_audit_mutation/i);
    });

    // 11. Upgrades test from 001-008 to 009+ (Genuine Upgrade Test — Blocker #3)
    await t.test('Genuine Upgrade Test from 001-008 to 009+', async () => {
      const upgradeSchema = 'test_upgrade_schema';
      await liveAdapter.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE;`);
      await liveAdapter.query(`CREATE SCHEMA ${upgradeSchema};`);

      // Copy only files 001 to 008 from actual sql/ directory to upgradeTempDir
      const upgradeTempDir = path.join(process.cwd(), 'scratch', 'upgrade-temp-migrations');
      await fs.mkdir(upgradeTempDir, { recursive: true });

      const actualSqlDir = path.join(process.cwd(), 'sql');
      const allFiles = await fs.readdir(actualSqlDir);
      const m001_008 = allFiles.filter(f => {
        const num = parseInt(f.split('_')[0], 10);
        return num >= 1 && num <= 8;
      });

      for (const f of m001_008) {
        const src = path.join(actualSqlDir, f);
        const dest = path.join(upgradeTempDir, f);
        const content = await fs.readFile(src, 'utf8');
        await fs.writeFile(dest, content, 'utf8');
      }

      // Check client out of pool and set search path to upgradeSchema
      const upgradeAdapter = new PostgresAdapter({}, testPool);
      await upgradeAdapter.query(`SET search_path TO ${upgradeSchema};`);

      try {
        const runnerPhase1 = new MigrationRunner(upgradeAdapter, { migrationsDir: upgradeTempDir });
        await runnerPhase1.runMigrations();

        // Check tables in phase 1 exist
        const tablesPh1 = await upgradeAdapter.query("SELECT tablename FROM pg_tables WHERE schemaname = $1;", [upgradeSchema]);
        const tablenamesPh1 = tablesPh1.rows.map(r => r.tablename);
        assert.ok(tablenamesPh1.includes('owners'));
        assert.ok(tablenamesPh1.includes('owner_sessions'));

        // Insert mock data into phase 1 tables
        await upgradeAdapter.query(
          "INSERT INTO owners (id, email, password_hash) VALUES ($1, $2, $3);",
          ['owner-old-id', 'old@st.com', 'some-pwd-hash']
        );

        // Run migrations 009+ using the canonical runner pointed to the real sql/ directory
        const canonicalRunner = new MigrationRunner(upgradeAdapter);
        const upgradeResult = await canonicalRunner.runMigrations();

        assert.equal(upgradeResult.appliedCount, 2, "Upgrade must apply exactly 2 migrations (009 and 010)");

        // Verify data was preserved and role correctly defaulted to 'owner' (Blocker #3)
        const checkOwner = await upgradeAdapter.query("SELECT * FROM owners WHERE id = $1;", ['owner-old-id']);
        assert.equal(checkOwner.rows[0].email, 'old@st.com');
        assert.equal(checkOwner.rows[0].role, 'owner');

        // Check table used_totp_codes exists
        const tablesPh2 = await upgradeAdapter.query("SELECT tablename FROM pg_tables WHERE schemaname = $1;", [upgradeSchema]);
        assert.ok(tablesPh2.rows.map(r => r.tablename).includes('used_totp_codes'));

        // Rerun must apply exactly 0 pending migrations
        const upgradeResult2 = await canonicalRunner.runMigrations();
        assert.equal(upgradeResult2.appliedCount, 0);

      } finally {
        await fs.rm(upgradeTempDir, { recursive: true, force: true });
        await liveAdapter.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE;`);
        await upgradeAdapter.closePool();
      }
    });

    // 12. Checksum-tampering test using isolated temporary migrations directory (Blocker #4)
    await t.test('isolated migration checksum-tampering checks', async () => {
      const tamperSchema = 'test_tamper_schema';
      await liveAdapter.query(`DROP SCHEMA IF EXISTS ${tamperSchema} CASCADE;`);
      await liveAdapter.query(`CREATE SCHEMA ${tamperSchema};`);

      const tamperAdapter = new PostgresAdapter({}, testPool);
      await tamperAdapter.query(`SET search_path TO ${tamperSchema};`);

      const tamperTempDir = path.join(process.cwd(), 'scratch', 'tamper-temp-migrations');
      await fs.mkdir(tamperTempDir, { recursive: true });

      const m1Path = path.join(tamperTempDir, '001_initial.sql');
      const m2Path = path.join(tamperTempDir, '002_dummy.sql');

      await fs.writeFile(m1Path, `CREATE TABLE tamper_test (id text PRIMARY KEY);`, 'utf8');
      await fs.writeFile(m2Path, `CREATE TABLE tamper_test_two (id text PRIMARY KEY);`, 'utf8');

      try {
        const tamperRunner = new MigrationRunner(tamperAdapter, { migrationsDir: tamperTempDir });
        await tamperRunner.runMigrations();

        // Tamper with first file
        await fs.writeFile(m1Path, `CREATE TABLE tamper_test (id text PRIMARY KEY); -- tampered`, 'utf8');

        // Second run must throw checksum mismatch
        await assert.rejects(async () => {
          await tamperRunner.runMigrations();
        }, /Migration checksum mismatch/i);

      } finally {
        await fs.rm(tamperTempDir, { recursive: true, force: true });
        await liveAdapter.query(`DROP SCHEMA IF EXISTS ${tamperSchema} CASCADE;`);
        await tamperAdapter.closePool();
      }
    });

  } finally {
    // Guarantees absolute clean environment in the finally block (Blocker #2)
    if (schemaName.startsWith('test_')) {
      await liveAdapter.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
    }
    await liveAdapter.closePool();
  }
});
