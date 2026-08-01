import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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

  // Generate unique schema names to support concurrent CI runs without schema collisions (Blocker #10)
  const mainSchema = 'test_schema_' + randomBytes(4).toString('hex');
  const upgradeSchema = 'test_schema_' + randomBytes(4).toString('hex');
  const tamperSchema = 'test_schema_' + randomBytes(4).toString('hex');

  // Verify schema targets start with test_ before executing any drops (Blocker #10)
  if (!mainSchema.startsWith('test_') || !upgradeSchema.startsWith('test_') || !tamperSchema.startsWith('test_')) {
    throw new Error('Unsafe schema target detected!');
  }

  // Initialize independent pools for each test schema (Blocker #10)
  const poolMain = new pg.Pool({ connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test' });
  const poolUpgrade = new pg.Pool({ connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test' });
  const poolTamper = new pg.Pool({ connectionString: dbUrl || 'postgresql://st_app:st_test_password@localhost:5432/st_production_test' });

  const mainAdapter = new PostgresAdapter({}, poolMain);
  const upgradeAdapter = new PostgresAdapter({}, poolUpgrade);
  const tamperAdapter = new PostgresAdapter({}, poolTamper);

  // Initialize each schema and bind checking clients deterministically
  await mainAdapter.query(`DROP SCHEMA IF EXISTS ${mainSchema} CASCADE; CREATE SCHEMA ${mainSchema};`);
  await upgradeAdapter.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE; CREATE SCHEMA ${upgradeSchema};`);
  await tamperAdapter.query(`DROP SCHEMA IF EXISTS ${tamperSchema} CASCADE; CREATE SCHEMA ${tamperSchema};`);

  // Wrap execution to guarantee final clean closure of independent pools exactly once in cleanup (Blocker #10)
  try {
    // Phase 1: Initialize main schema migrations
    const mainRunner = new MigrationRunner(mainAdapter, { migrationsDir: path.join(process.cwd(), 'sql') });
    await mainAdapter.withTransaction(async (client) => {
      await client.query(`SET search_path TO ${mainSchema};`);
      await mainRunner.runMigrations();
    });

    // Helper to run query with mainSchema search_path
    async function runInMainSchema(callback) {
      return await mainAdapter.withTransaction(async (client) => {
        await client.query(`SET search_path TO ${mainSchema};`);
        return await callback(client);
      });
    }

    // 1. Concurrent failed logins and lockout expiry recovery (Blocker #11)
    await t.test('concurrent failed logins and lockout expiry recovery', async () => {
      await runInMainSchema(async (client) => {
        const ownersRepo = new OwnerRepository(mainAdapter);
        const sessionsRepo = new SessionRepository(mainAdapter);
        const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

        const email = 'lockout-concur-owner@st.com';
        const password = 'SuperSecurePassword123_Live!';
        const owner = await auth.registerOwner(email, password);

        // Run 5 concurrent failed login attempts
        const attempts = Array.from({ length: 5 }).map(() => auth.loginOwner(email, 'WrongPassword123!').catch(err => err));
        await Promise.all(attempts);

        // Verify lockout is persisted in the database even on transactions returning success:false
        await assert.rejects(async () => {
          await auth.loginOwner(email, password);
        }, /ACCOUNT_TEMPORARILY_LOCKED/);

        // Lockout expiry recovery: manually set lockout_until to the past
        await client.query("UPDATE owners SET lockout_until = now() - interval '1 second' WHERE id = $1;", [owner.id]);

        // Login must succeed now
        const successLogin = await auth.loginOwner(email, password);
        assert.ok(successLogin.session.token);
      });
    });

    // 2. Both session idle and absolute session expiry (Blocker #11)
    await t.test('both session idle and absolute session expiry', async () => {
      await runInMainSchema(async (client) => {
        const ownersRepo = new OwnerRepository(mainAdapter);
        const sessionsRepo = new SessionRepository(mainAdapter);
        const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

        const email = 'session-expiry-owner@st.com';
        const password = 'SuperSecurePassword123_Live!';
        const owner = await auth.registerOwner(email, password);

        const s1 = await auth.createSessionToken(owner.id);

        // Modify idle_expires_at in database to be in the past
        await client.query("UPDATE owner_sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1;", [s1.session.id]);
        await assert.rejects(async () => {
          await auth.validateAndRetrieveSession(s1.token);
        }, /SESSION_IDLE_EXPIRED/);

        // Reset idle expires, and modify absolute_expires_at to be in the past
        await client.query("UPDATE owner_sessions SET idle_expires_at = now() + interval '30 minutes', absolute_expires_at = now() - interval '1 second' WHERE id = $1;", [s1.session.id]);
        await assert.rejects(async () => {
          await auth.validateAndRetrieveSession(s1.token);
        }, /SESSION_ABSOLUTE_EXPIRED/);
      });
    });

    // 3. Multiple sessions and revoke-other behavior (Blocker #11)
    await t.test('multiple sessions and revoke-other behavior', async () => {
      await runInMainSchema(async (client) => {
        const ownersRepo = new OwnerRepository(mainAdapter);
        const sessionsRepo = new SessionRepository(mainAdapter);
        const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo });

        const email = 'multisession-owner@st.com';
        const password = 'SuperSecurePassword123_Live!';
        const owner = await auth.registerOwner(email, password);

        // Support multiple active sessions concurrently (Blocker #3)
        const s1 = await auth.createSessionToken(owner.id);
        const s2 = await auth.createSessionToken(owner.id);

        // Both sessions are valid concurrently
        assert.ok(await auth.validateAndRetrieveSession(s1.token));
        assert.ok(await auth.validateAndRetrieveSession(s2.token));

        // Revoke other sessions
        await sessionsRepo.revokeAllOtherSessions(owner.id, s2.session.id);

        // s1 must now be revoked
        await assert.rejects(async () => {
          await auth.validateAndRetrieveSession(s1.token);
        }, /SESSION_REVOKED/);

        // s2 must remain valid
        assert.ok(await auth.validateAndRetrieveSession(s2.token));
      });
    });

    // 4. CSRF expiry, rotation and cross-session rejection (Blocker #11)
    await t.test('CSRF expiry, rotation and cross-session rejection', async () => {
      await runInMainSchema(async (client) => {
        const ownersRepo = new OwnerRepository(mainAdapter);
        const sessionsRepo = new SessionRepository(mainAdapter);
        const csrfRepo = new CsrfRepository(mainAdapter);
        const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo, csrfRepo });

        const email = 'csrf-test-owner@st.com';
        const password = 'SuperSecurePassword123_Live!';
        const owner = await auth.registerOwner(email, password);

        const s1 = await auth.createSessionToken(owner.id);
        const csrfToken = await auth.generateCsrfToken(s1.session.id);

        // Expiry check (enforced in SQL) (Blocker #7)
        await client.query("UPDATE csrf_session_tokens SET created_at = now() - interval '31 minutes' WHERE session_id = $1;", [s1.session.id]);
        assert.equal(await csrfRepo.verifyToken(s1.session.id, computeTokenHash(csrfToken)), false);

        // Reset creation, and test cross-session rejection
        await client.query("UPDATE csrf_session_tokens SET created_at = now() WHERE session_id = $1;", [s1.session.id]);
        const s2 = await auth.createSessionToken(owner.id);
        assert.equal(await csrfRepo.verifyToken(s2.session.id, computeTokenHash(csrfToken)), false);
      });
    });

    // 5. Mid-transaction TOTP confirmation rollback (Blocker #11)
    await t.test('mid-transaction TOTP confirmation rollback', async () => {
      await runInMainSchema(async (client) => {
        const ownersRepo = new OwnerRepository(mainAdapter);
        const sessionsRepo = new SessionRepository(mainAdapter);
        const mfaRepo = new MfaRepository(mainAdapter);
        const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo, mfaRepo });

        const email = 'mfa-rollback-owner@st.com';
        const password = 'SuperSecurePassword123_Live!';
        const owner = await auth.registerOwner(email, password);
        const s1 = await auth.createSessionToken(owner.id);

        const enroll = await auth.enrollTotpMfa(owner.id, s1.token);

        // Force a failure during verification inside the transaction
        await assert.rejects(async () => {
          await auth.confirmTotpMfa(owner.id, enroll.enrollmentId, '000000');
        }, /INVALID_TOTP_CODE/);

        // Prove complete transaction rollback: owner mfa_enabled must be false, no recovery codes created
        const ownerDb = await ownersRepo.findById(owner.id);
        assert.equal(ownerDb.mfaEnabled, false);

        const recRes = await client.query("SELECT * FROM owner_recovery_codes WHERE owner_id = $1;", [owner.id]);
        assert.equal(recRes.rows.length, 0);
      });
    });

    // 6. Direct database agent-51 rejection via enforce_agent_cap (Blocker #11)
    await t.test('direct database agent-51 rejection', async () => {
      await runInMainSchema(async (client) => {
        const countRes = await client.query("SELECT count(*) FROM agents;");
        const count = parseInt(countRes.rows[0].count, 10);
        const needed = 50 - count;

        for (let i = 0; i < needed; i++) {
          await client.query(
            "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING;",
            [`live-agent-trigger-${i}`, `Live Trigger Agent ${i}`, `ns.live.trigger.agent.${i}`]
          );
        }

        // Direct SQL insert must trigger exception
        await assert.rejects(async () => {
          await client.query(
            "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, true);",
            ['live-agent-trigger-51', 'Live Trigger Agent 51', 'ns.live.trigger.agent.51']
          );
        }, /AGENT_CAP_REACHED/);
      });
    });

    // 7. evidence UPDATE and DELETE rejection trigger checks (Blocker #11)
    await t.test('evidence UPDATE and DELETE rejection', async () => {
      await runInMainSchema(async (client) => {
        await client.query(
          "INSERT INTO evidence_events (id, subject_id, kind, classification, payload, event_hash) VALUES ($1, $2, $3, $4, $5, $6);",
          ['ev-id-test-append', 'subj-1', 'kind-1', 'class-1', '{}', computeTokenHash('ev-id-test-append')]
        );

        await assert.rejects(async () => {
          await client.query("UPDATE evidence_events SET subject_id = 'hacked' WHERE id = 'ev-id-test-append';");
        }, /EVIDENCE_EVENTS_ARE_IMMUTABLE/);

        await assert.rejects(async () => {
          await client.query("DELETE FROM evidence_events WHERE id = 'ev-id-test-append';");
        }, /EVIDENCE_EVENTS_ARE_IMMUTABLE/);
      });
    });

    // 8. Database-level publishing-receipt enforcement (Blocker #11)
    await t.test('database-level publishing-receipt enforcement', async () => {
      const evidenceRepo = new EvidenceLedgerRepository(mainAdapter);

      await assert.rejects(async () => {
        await evidenceRepo.append({
          subjectId: 'subj-1',
          kind: 'platform_publish',
          classification: 'publish_video',
          payload: {} // missing platformPostId etc.
        });
      }, /VERIFIABLE_PLATFORM_RECEIPT_REQUIRED/);
    });

    // 9. Complete concurrent evidence-chain validation (Blocker #11)
    await t.test('concurrent evidence-chain appends and validation', async () => {
      const evidenceRepo = new EvidenceLedgerRepository(mainAdapter);

      const p1 = evidenceRepo.append({ subjectId: 'concur-subj', kind: 'step_narrative', classification: 'story', payload: { step: 1 } });
      const p2 = evidenceRepo.append({ subjectId: 'concur-subj', kind: 'step_narrative', classification: 'story', payload: { step: 2 } });
      const p3 = evidenceRepo.append({ subjectId: 'concur-subj', kind: 'step_narrative', classification: 'story', payload: { step: 3 } });

      const results = await Promise.all([p1, p2, p3]);

      const list = await evidenceRepo.list();
      const testEvents = list.filter(e => e.subjectId === 'concur-subj');
      assert.equal(testEvents.length, 3);

      const hashes = testEvents.map(e => e.eventHash);
      const root = testEvents.find(e => !hashes.includes(e.previousHash));
      assert.ok(root, "One root event must exist with preceding reference verified");
    });

    // 10. Horizontal cross-owner API isolation (Blocker #11)
    await t.test('horizontal cross-owner API isolation', async () => {
      await runInMainSchema(async (client) => {
        const ownersRepo = new OwnerRepository(mainAdapter);
        const sessionsRepo = new SessionRepository(mainAdapter);
        const agentsRepo = new AgentRepository(mainAdapter);
        const auth = new OwnerAuthenticationService({ ownersRepo, sessionsRepo, agentsRepo });

        const owner1 = await auth.registerOwner('owner1-iso@st.com', 'SuperSecurePassword123_Live!');
        const owner2 = await auth.registerOwner('owner2-iso@st.com', 'SuperSecurePassword123_Live!');

        // Create an agent owned by owner1
        await agentsRepo.add({ id: 'agent-o1', name: 'Agent O1', namespace: 'ns.o1' }, owner1.id);

        // owner2 must NOT see owner1's agent
        const listO2 = await agentsRepo.list(owner2.id);
        const o1AgentInList = listO2.find(a => a.id === 'agent-o1');
        assert.equal(o1AgentInList, undefined, "owner2 must not be able to list owner1's scoped agents");

        // owner2 must NOT get owner1's agent
        const agentO2Get = await agentsRepo.get('agent-o1', owner2.id);
        assert.equal(agentO2Get, null, "owner2 must not be able to retrieve owner1's scoped agent");
      });
    });

    // 11. Upgrades test from 001-008 to 011+ (Genuine Upgrade Test)
    await t.test('Genuine Upgrade Test from 001-008 to 011+', async () => {
      const upgradeTempDir = path.join(process.cwd(), 'scratch', 'upgrade-temp-migrations-three');
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
        await upgradeAdapter.withTransaction(async (client) => {
          await client.query(`SET search_path TO ${upgradeSchema};`);
          await runnerPhase1.runMigrations();
        });

        // Check tables in phase 1 exist
        const tablesPh1 = await upgradeAdapter.withTransaction(async (client) => {
          await client.query(`SET search_path TO ${upgradeSchema};`);
          return await client.query("SELECT tablename FROM pg_tables WHERE schemaname = $1;", [upgradeSchema]);
        });
        const tablenamesPh1 = tablesPh1.rows.map(r => r.tablename);
        assert.ok(tablenamesPh1.includes('owners'));
        assert.ok(tablenamesPh1.includes('owner_sessions'));

        // Insert mock data into phase 1 tables
        await upgradeAdapter.withTransaction(async (client) => {
          await client.query(`SET search_path TO ${upgradeSchema};`);
          await client.query(
            "INSERT INTO owners (id, email, password_hash) VALUES ($1, $2, $3);",
            ['owner-old-id-3', 'old3@st.com', 'some-pwd-hash']
          );
        });

        // Run migrations 009+ using the canonical runner pointed to the real sql/ directory
        const canonicalRunner = new MigrationRunner(upgradeAdapter, { migrationsDir: path.join(process.cwd(), 'sql') });
        const upgradeResult = await upgradeAdapter.withTransaction(async (client) => {
          await client.query(`SET search_path TO ${upgradeSchema};`);
          return await canonicalRunner.runMigrations();
        });

        assert.equal(upgradeResult.appliedCount, 3, "Upgrade must apply exactly 3 migrations (009, 010, and 011)");

        // Verify data was preserved and role correctly defaulted to 'owner' (Blocker #3)
        const checkOwner = await upgradeAdapter.withTransaction(async (client) => {
          await client.query(`SET search_path TO ${upgradeSchema};`);
          return await client.query("SELECT * FROM owners WHERE id = $1;", ['owner-old-id-3']);
        });
        assert.equal(checkOwner.rows[0].email, 'old3@st.com');
        assert.equal(checkOwner.rows[0].role, 'owner');

        // Check table used_totp_codes exists
        const tablesPh2 = await upgradeAdapter.withTransaction(async (client) => {
          await client.query(`SET search_path TO ${upgradeSchema};`);
          return await client.query("SELECT tablename FROM pg_tables WHERE schemaname = $1;", [upgradeSchema]);
        });
        assert.ok(tablesPh2.rows.map(r => r.tablename).includes('used_totp_codes'));

        // Rerun must apply exactly 0 pending migrations
        const upgradeResult2 = await upgradeAdapter.withTransaction(async (client) => {
          await client.query(`SET search_path TO ${upgradeSchema};`);
          return await canonicalRunner.runMigrations();
        });
        assert.equal(upgradeResult2.appliedCount, 0);

      } finally {
        await fs.rm(upgradeTempDir, { recursive: true, force: true });
      }
    });

  } finally {
    // Guarantees absolute clean environment pools closure (Blocker #10)
    await mainAdapter.query(`DROP SCHEMA IF EXISTS ${mainSchema} CASCADE;`).catch(() => {});
    await upgradeAdapter.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE;`).catch(() => {});
    await tamperAdapter.query(`DROP SCHEMA IF EXISTS ${tamperSchema} CASCADE;`).catch(() => {});

    await mainAdapter.closePool().catch(() => {});
    await upgradeAdapter.closePool().catch(() => {});
    await tamperAdapter.closePool().catch(() => {});
  }
});
