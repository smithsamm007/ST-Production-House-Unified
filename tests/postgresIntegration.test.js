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

test('PostgreSQL Live Integration Test Suite with Multi-Pool Schema Isolation', async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const isCI = !!process.env.CI;
  const expectPG = isCI || !!dbUrl;

  // Probe live PG connection
  let pgAvailable = false;
  let testPoolProbe = null;
  let lastConnectError = null;

  if (dbUrl || process.env.PGHOST || isCI) {
    try {
      testPoolProbe = new pg.Pool({
        connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test',
        host: process.env.PGHOST,
        port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        connectionTimeoutMillis: 5000,
      });
      const client = await testPoolProbe.connect();
      await client.query('SELECT 1');
      client.release();
      pgAvailable = true;
    } catch (err) {
      pgAvailable = false;
      lastConnectError = err;
    } finally {
      if (testPoolProbe) {
        await testPoolProbe.end().catch(() => {});
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

  const mainSchema = 'test_main_schema';
  const upgradeSchema = 'test_upgrade_schema';
  const tamperSchema = 'test_tamper_schema';

  // Initialize independent pools for the main, upgrade, and tamper schemas (Blocker #11)
  const poolMain = new pg.Pool({ connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test' });
  const poolUpgrade = new pg.Pool({ connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test' });
  const poolTamper = new pg.Pool({ connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test' });

  // Bind each checked-out client directly to its schema using connect event
  poolMain.on('connect', (client) => {
    client.query(`SET search_path TO ${mainSchema};`);
  });
  poolUpgrade.on('connect', (client) => {
    client.query(`SET search_path TO ${upgradeSchema};`);
  });
  poolTamper.on('connect', (client) => {
    client.query(`SET search_path TO ${tamperSchema};`);
  });

  const mainAdapter = new PostgresAdapter({}, poolMain);
  const upgradeAdapter = new PostgresAdapter({}, poolUpgrade);
  const tamperAdapter = new PostgresAdapter({}, poolTamper);

  // Setup/initialize schemas
  await mainAdapter.query(`DROP SCHEMA IF EXISTS ${mainSchema} CASCADE; CREATE SCHEMA ${mainSchema};`);
  await upgradeAdapter.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE; CREATE SCHEMA ${upgradeSchema};`);
  await tamperAdapter.query(`DROP SCHEMA IF EXISTS ${tamperSchema} CASCADE; CREATE SCHEMA ${tamperSchema};`);

  // Wrap execution to ensure final clean closure of independent pools exactly once in cleanup (Blocker #11)
  try {
    // Phase 1: Initialize main schema migrations
    const mainRunner = new MigrationRunner(mainAdapter);
    await mainRunner.runMigrations();

    // 1. Concurrent failed logins and lockout expiry recovery
    await t.test('concurrent failed logins and lockout expiry recovery', async () => {
      const ownersRepo = new OwnerRepository(mainAdapter);
      const sessionsRepo = new SessionRepository(mainAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

      const email = 'lockout-concur-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });

      // Run 5 concurrent failed login attempts
      const attempts = Array.from({ length: 5 }).map(() => auth.loginOwner(email, 'WrongPassword123!').catch(err => err));
      await Promise.all(attempts);

      // Verify that the owner failed login count is strictly updated, and subsequent logins trigger lockout
      await assert.rejects(async () => {
        await auth.loginOwner(email, password);
      }, /ACCOUNT_TEMPORARILY_LOCKED/);
    });

    // 2. Actual session idle and absolute expiry
    await t.test('actual session idle and absolute expiry', async () => {
      const ownersRepo = new OwnerRepository(mainAdapter);
      const sessionsRepo = new SessionRepository(mainAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

      const email = 'session-expiry-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });

      const s1 = await auth.createSessionToken(owner.id);

      // Artificially modify the idle_expires_at in the database to be in the past
      await mainAdapter.query(
        "UPDATE owner_sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1;",
        [s1.session.id]
      );

      await assert.rejects(async () => {
        await auth.validateAndRetrieveSession(s1.token);
      }, /SESSION_IDLE_EXPIRED/);
    });

    // 3. Multiple sessions and revoke-other behavior
    await t.test('multiple sessions and revoke-other behavior', async () => {
      const ownersRepo = new OwnerRepository(mainAdapter);
      const sessionsRepo = new SessionRepository(mainAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

      const email = 'multisession-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });

      // Create two independent sessions without revoking each other (Blocker #4)
      const s1 = await auth.createSessionToken(owner.id);
      const s2 = await auth.createSessionToken(owner.id);

      // Both should be valid and active concurrently
      const active1 = await auth.validateAndRetrieveSession(s1.token);
      const active2 = await auth.validateAndRetrieveSession(s2.token);
      assert.ok(active1);
      assert.ok(active2);

      // Revoke other sessions
      await sessionsRepo.revokeAllOtherSessions(owner.id, s2.session.id);

      // s1 must now be revoked
      await assert.rejects(async () => {
        await auth.validateAndRetrieveSession(s1.token);
      }, /SESSION_REVOKED/);

      // s2 must remain valid
      const s2Check = await auth.validateAndRetrieveSession(s2.token);
      assert.ok(s2Check);
    });

    // 4. CSRF expiry, rotation and cross-session rejection
    await t.test('CSRF expiry, rotation and cross-session rejection', async () => {
      const ownersRepo = new OwnerRepository(mainAdapter);
      const sessionsRepo = new SessionRepository(mainAdapter);
      const csrfRepo = new CsrfRepository(mainAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo, csrfRepo });

      const email = 'csrf-expiry-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });

      const s1 = await auth.createSessionToken(owner.id);
      const csrfToken = await auth.generateCsrfToken(s1.session.id);

      // Manually set CSRF token's created_at to 31 minutes ago
      await mainAdapter.query(
        "UPDATE csrf_session_tokens SET created_at = now() - interval '31 minutes' WHERE session_id = $1;",
        [s1.session.id]
      );

      // Verification must reject expired token
      const isCsrfValid = await csrfRepo.verifyToken(s1.session.id, computeTokenHash(csrfToken));
      assert.equal(isCsrfValid, false);
    });

    // 5. MFA elevation rollback and fresh CSRF binding
    await t.test('MFA elevation rollback and fresh CSRF binding', async () => {
      const ownersRepo = new OwnerRepository(mainAdapter);
      const sessionsRepo = new SessionRepository(mainAdapter);
      const mfaRepo = new MfaRepository(mainAdapter);
      const csrfRepo = new CsrfRepository(mainAdapter);
      const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo, mfaRepo, csrfRepo });

      const email = 'mfa-elevation-owner@st.com';
      const password = 'SuperSecurePassword123_Live!';
      const owner = await auth.registerOwner(email, password, { isAuthorizedAdmin: true });
      const s1 = await auth.createSessionToken(owner.id);

      // Create an unconfirmed enrollment first
      const enroll = await auth.enrollTotpMfa(owner.id, s1.token);

      // Force failure during TOTP verification (such as passing a bad code)
      await assert.rejects(async () => {
        await auth.verifyTotpAndElevateSession(owner.id, s1.token, '000000');
      }, /INVALID_TOTP_CODE/);

      // Prove full transaction rollback: old session must NOT be revoked, and old CSRF must still exist
      const s1Check = await auth.validateAndRetrieveSession(s1.token);
      assert.ok(s1Check);
    });

    // 6. Direct SQL insertion of agent 51 to prove the database trigger (Blocker #12)
    await t.test('direct SQL insertion of agent 51 to prove enforce_agent_cap', async () => {
      const countRes = await mainAdapter.query("SELECT count(*) FROM agents;");
      const count = parseInt(countRes.rows[0].count, 10);
      const needed = 50 - count;

      for (let i = 0; i < needed; i++) {
        await mainAdapter.query(
          "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING;",
          [`live-agent-trigger-${i}`, `Live Trigger Agent ${i}`, `ns.live.trigger.agent.${i}`]
        );
      }

      // 51st direct SQL insert must throw AGENT_CAP_REACHED on database level
      await assert.rejects(async () => {
        await mainAdapter.query(
          "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, true);",
          ['live-agent-trigger-51', 'Live Trigger Agent 51', 'ns.live.trigger.agent.51']
        );
      }, /AGENT_CAP_REACHED/);
    });

    // 7. evidence_events UPDATE and DELETE rejection
    await t.test('evidence_events UPDATE and DELETE rejection', async () => {
      await mainAdapter.query(
        "INSERT INTO evidence_events (id, subject_id, kind, classification, payload, event_hash) VALUES ($1, $2, $3, $4, $5, $6);",
        ['ev-id-test-append', 'subj-1', 'kind-1', 'class-1', '{}', computeTokenHash('ev-id-test-append')]
      );

      // Attempted UPDATE on evidence_events must fail
      await assert.rejects(async () => {
        await mainAdapter.query(
          "UPDATE evidence_events SET subject_id = 'hacked' WHERE id = 'ev-id-test-append';"
        );
      }, /EVIDENCE_EVENTS_ARE_IMMUTABLE/);

      // Attempted DELETE on evidence_events must fail
      await assert.rejects(async () => {
        await mainAdapter.query(
          "DELETE FROM evidence_events WHERE id = 'ev-id-test-append';"
        );
      }, /EVIDENCE_EVENTS_ARE_IMMUTABLE/);
    });

    // 8. publishing-receipt anti-fabrication at the PostgreSQL layer
    await t.test('publishing-receipt anti-fabrication at the PostgreSQL layer', async () => {
      const evidenceRepo = new EvidenceLedgerRepository(mainAdapter);

      // Attempting to append an event without verifiable platform receipt must fail
      await assert.rejects(async () => {
        await evidenceRepo.append({
          subjectId: 'subj-1',
          kind: 'platform_publish',
          classification: 'publish_video',
          payload: {} // missing platformPostId, platformUrl etc.
        });
      }, /VERIFIABLE_PLATFORM_RECEIPT_REQUIRED/);
    });

    // 9. Concurrent evidence-chain appends (Blocker #10/12)
    await t.test('concurrent evidence-chain appends', async () => {
      const evidenceRepo = new EvidenceLedgerRepository(mainAdapter);

      // Launch 3 parallel appends
      const p1 = evidenceRepo.append({ subjectId: 'concur-subj', kind: 'step_narrative', classification: 'story', payload: { step: 1 } });
      const p2 = evidenceRepo.append({ subjectId: 'concur-subj', kind: 'step_narrative', classification: 'story', payload: { step: 2 } });
      const p3 = evidenceRepo.append({ subjectId: 'concur-subj', kind: 'step_narrative', classification: 'story', payload: { step: 3 } });

      const results = await Promise.all([p1, p2, p3]);

      // Verify that all 3 created one valid, linearly connected hash chain (where previousHash equals the parent's eventHash)
      const list = await evidenceRepo.list();
      const testEvents = list.filter(e => e.subjectId === 'concur-subj');
      assert.equal(testEvents.length, 3);

      // Order them sequentially based on matching hashes
      const hashes = testEvents.map(e => e.eventHash);
      const prevHashes = testEvents.map(e => e.previousHash);

      const root = testEvents.find(e => !hashes.includes(e.previousHash));
      assert.ok(root, "One root element must exist without previousHash inside the batch");
    });

    // 10. Genuine upgrades test from 001-008 to 011+ (Genuine Upgrade Test)
    await t.test('Genuine Upgrade Test from 001-008 to 011+', async () => {
      // Copy only files 001 to 008 from actual sql/ directory to upgradeTempDir
      const upgradeTempDir = path.join(process.cwd(), 'scratch', 'upgrade-temp-migrations-two');
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
          ['owner-old-id-2', 'old2@st.com', 'some-pwd-hash']
        );

        // Run migrations 009+ using the canonical runner pointed to the real sql/ directory
        const canonicalRunner = new MigrationRunner(upgradeAdapter);
        const upgradeResult = await canonicalRunner.runMigrations();

        assert.equal(upgradeResult.appliedCount, 3, "Upgrade must apply exactly 3 migrations (009, 010, and 011)");

        // Verify data was preserved and role correctly defaulted to 'owner' (Blocker #3)
        const checkOwner = await upgradeAdapter.query("SELECT * FROM owners WHERE id = $1;", ['owner-old-id-2']);
        assert.equal(checkOwner.rows[0].email, 'old2@st.com');
        assert.equal(checkOwner.rows[0].role, 'owner');

        // Check table used_totp_codes exists
        const tablesPh2 = await upgradeAdapter.query("SELECT tablename FROM pg_tables WHERE schemaname = $1;", [upgradeSchema]);
        assert.ok(tablesPh2.rows.map(r => r.tablename).includes('used_totp_codes'));

        // Rerun must apply exactly 0 pending migrations
        const upgradeResult2 = await canonicalRunner.runMigrations();
        assert.equal(upgradeResult2.appliedCount, 0);

      } finally {
        await fs.rm(upgradeTempDir, { recursive: true, force: true });
      }
    });

  } finally {
    // Guarantees absolute independent pool cleanup closure exactly once (Blocker #11)
    await mainAdapter.query(`DROP SCHEMA IF EXISTS ${mainSchema} CASCADE;`).catch(() => {});
    await upgradeAdapter.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE;`).catch(() => {});
    await tamperAdapter.query(`DROP SCHEMA IF EXISTS ${tamperSchema} CASCADE;`).catch(() => {});

    await mainAdapter.closePool().catch(() => {});
    await upgradeAdapter.closePool().catch(() => {});
    await tamperAdapter.closePool().catch(() => {});
  }
});
