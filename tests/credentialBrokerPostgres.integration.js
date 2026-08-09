import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { PostgresCredentialRepository } from "../src/credentials/postgresCredentialRepository.js";
import { CredentialAuditRepository } from "../src/credentials/credentialAuditRepository.js";

test("Credential Broker PostgreSQL Durable Metadata and Audit Log Integration Tests", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const isCI = !!process.env.CI;
  const isIntegrationCmd = process.env.npm_lifecycle_event === 'test:integration';
  const expectPG = isCI || !!dbUrl || isIntegrationCmd;

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
        `PostgreSQL 15 instance was expected but could not be reached: ${lastConnectError ? lastConnectError.message : 'Connection failed'}`
      );
    } else {
      t.diagnostic(
        'NOTICE: Live PostgreSQL instance is not configured. Skipping Credential Broker integration tests.'
      );
      return;
    }
  }

  const adapter = new PostgresAdapter({}, testPool);
  const runner = new MigrationRunner(adapter);

  // Apply migrations
  await runner.runMigrations();

  // Create clean repositories
  const credentialRepo = new PostgresCredentialRepository(adapter);
  const auditRepo = new CredentialAuditRepository(adapter);

  // Clean up helper
  const uniqueId = Date.now();
  const testOwnerEmail1 = `owner-cb-1-${uniqueId}@test.com`;
  const testOwnerEmail2 = `owner-cb-2-${uniqueId}@test.com`;
  let owner1Id, owner2Id;

  // Let's seed two test owners
  const o1Res = await adapter.query(
    `INSERT INTO owners (email, password_hash) VALUES ($1, 'fake_hash') RETURNING id`,
    [testOwnerEmail1]
  );
  owner1Id = o1Res.rows[0].id;

  const o2Res = await adapter.query(
    `INSERT INTO owners (email, password_hash) VALUES ($1, 'fake_hash') RETURNING id`,
    [testOwnerEmail2]
  );
  owner2Id = o2Res.rows[0].id;

  // We have 20 preloaded agents. Let's use 'agent-01' (JARVIS) and 'agent-02' (SHERLOCK)
  const agentId1 = 'agent-01';
  const agentId2 = 'agent-02';

  t.after(async () => {
    // Teardown
    await adapter.query(`DELETE FROM broker_credential_metadata WHERE owner_id IN ($1, $2)`, [owner1Id, owner2Id]).catch(() => {});
    await adapter.query(`DELETE FROM owners WHERE id IN ($1, $2)`, [owner1Id, owner2Id]).catch(() => {});
    if (testPool) {
      await testPool.end().catch(() => {});
    }
  });

  await t.test("Migration Rerun / Idempotency Check", async () => {
    // Verify that running migrations again works perfectly and appliedCount is 0
    const result = await runner.runMigrations();
    assert.equal(result.appliedCount, 0, "No new migrations should be applied on second run");
  });

  await t.test("Block plaintext secrets check constraint", async () => {
    // Attempting to create with plain text secret should fail constraint
    await assert.rejects(
      async () => {
        await credentialRepo.create({
          ownerId: owner1Id,
          agentId: agentId1,
          provider: 'gemini',
          secretLocator: 'my-super-secret-plaintext-key-123'
        });
      },
      /Plaintext secret detected/
    );

    // Direct insert to test DB check constraint
    await assert.rejects(
      async () => {
        await adapter.query(
          `INSERT INTO broker_credential_metadata (owner_id, agent_id, provider, secret_locator)
           VALUES ($1, $2, 'gemini', 'plaintext_raw_secret')`,
          [owner1Id, agentId1]
        );
      },
      /no_plaintext_secrets_locator/
    );
  });

  await t.test("Transactional Rollback on creation failure", async () => {
    // Verify rollback inside a transaction
    await assert.rejects(
      async () => {
        await adapter.withTransaction(async (client) => {
          // Valid creation of a credential
          await client.query(
            `INSERT INTO broker_credential_metadata (owner_id, agent_id, provider, secret_locator)
             VALUES ($1, $2, 'gemini', 'vault://st/secret1')`,
            [owner1Id, agentId1]
          );

          // Now force a syntax/constraint error to rollback
          await client.query(
            `INSERT INTO broker_credential_metadata (owner_id, agent_id, provider, secret_locator)
             VALUES ($1, $2, 'gemini', 'plaintext_secret')`,
            [owner1Id, agentId1]
          );
        });
      }
    );

    // Verify that the first insert was rolled back completely
    const check = await adapter.query(
      `SELECT * FROM broker_credential_metadata WHERE secret_locator = 'vault://st/secret1'`
    );
    assert.equal(check.rowCount, 0, "Durable changes must be rolled back on transaction failure");
  });

  await t.test("Owner-scoped isolation and Cross-Agent Denial", async () => {
    // 1. Create credential for Owner 1 / Agent 1
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'gemini',
      secretLocator: 'vault://st/owner1/gemini'
    });
    assert.ok(cred.id);

    // 2. Owner 2 should NOT be able to find it by ID
    const foundByO2 = await credentialRepo.findById(cred.id, owner2Id);
    assert.equal(foundByO2, null, "Owner 2 must not access Owner 1's credential");

    // 3. Owner 2 should NOT be able to find it by locator
    const foundByLocatorO2 = await credentialRepo.findByLocator('vault://st/owner1/gemini', owner2Id);
    assert.equal(foundByLocatorO2, null, "Owner 2 must not access Owner 1's credential by locator");

    // 4. Owner 2 should NOT be able to list it by Agent 1
    const listO2 = await credentialRepo.listByAgent(agentId1, owner2Id);
    const hasCred = listO2.some(c => c.id === cred.id);
    assert.equal(hasCred, false, "Owner 2 listing Agent 1 credentials must not contain Owner 1's credential");

    // 5. Owner 2 should NOT be able to rotate it
    await assert.rejects(
      async () => {
        await credentialRepo.rotate(cred.id, owner2Id, {
          newSecretLocator: 'vault://st/owner1/gemini-rotated'
        });
      },
      /Credential not found or unauthorized/
    );

    // 6. Owner 2 should NOT be able to revoke it
    await assert.rejects(
      async () => {
        await credentialRepo.revoke(cred.id, owner2Id);
      },
      /Credential not found or unauthorized/
    );
  });

  await t.test("Concurrency-safe updates, rotation, and revocation races", async () => {
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'claude',
      secretLocator: 'vault://st/owner1/claude'
    });

    // 1. Successful rotation incrementing version and setting metadata
    const rotated = await credentialRepo.rotate(cred.id, owner1Id, {
      newSecretLocator: 'vault://st/owner1/claude/v2',
      expectedVersion: 1
    });
    assert.equal(rotated.version, 2);
    assert.equal(rotated.secret_locator, 'vault://st/owner1/claude/v2');

    // 2. Outdated version rotation attempt should fail (optimistic lock test)
    await assert.rejects(
      async () => {
        await credentialRepo.rotate(cred.id, owner1Id, {
          newSecretLocator: 'vault://st/owner1/claude/v3',
          expectedVersion: 1 // actual is 2
        });
      },
      /CONCURRENCY_ERROR/
    );

    // 3. Simulating actual concurrent race condition using SELECT FOR UPDATE
    const p1 = credentialRepo.rotate(cred.id, owner1Id, {
      newSecretLocator: 'vault://st/owner1/claude/race1',
      expectedVersion: 2
    });
    const p2 = credentialRepo.rotate(cred.id, owner1Id, {
      newSecretLocator: 'vault://st/owner1/claude/race2',
      expectedVersion: 2
    });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, "Exactly one concurrent rotation should succeed");
    assert.equal(rejected.length, 1, "Exactly one concurrent rotation should fail with version mismatch");
    assert.ok(rejected[0].reason.message.includes("CONCURRENCY_ERROR"), "Should fail due to concurrency version check");

    // 4. Revocation prevents future rotations
    await credentialRepo.revoke(cred.id, owner1Id);
    await assert.rejects(
      async () => {
        await credentialRepo.rotate(cred.id, owner1Id, {
          newSecretLocator: 'vault://st/owner1/claude/after-revoke'
        });
      },
      /Cannot rotate a revoked credential/
    );
  });

  await t.test("Sanitization of errors and messages in audit logging", async () => {
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'sarvam',
      secretLocator: 'vault://st/owner1/sarvam'
    });

    // Log an access event with an error containing a plaintext password/api key
    const rawErrorMsg = "Failed connection to provider: api_key=supersecret1234 password=unsafe_password";
    const log = await auditRepo.logAccess({
      credentialId: cred.id,
      ownerId: owner1Id,
      agentId: agentId1,
      action: 'read',
      status: 'failure',
      errorMessage: rawErrorMsg
    });

    assert.ok(!log.error_message.includes('supersecret1234'), "Secrets must be redacted in the error message column");
    assert.ok(!log.error_message.includes('unsafe_password'), "Password must be redacted in the error message column");
    assert.ok(log.error_message.includes('[REDACTED]'), "Redaction placeholders must be present");
  });

  await t.test("Append-only audit enforcement via DB Trigger", async () => {
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'ollama',
      secretLocator: 'vault://st/owner1/ollama'
    });

    const log = await auditRepo.logAccess({
      credentialId: cred.id,
      ownerId: owner1Id,
      agentId: agentId1,
      action: 'read',
      status: 'success'
    });
    assert.ok(log.id);

    // Attempting to UPDATE the audit record must fail at the database level
    await assert.rejects(
      async () => {
        await adapter.query(
          `UPDATE broker_credential_audit_log SET status = 'failed' WHERE id = $1`,
          [log.id]
        );
      },
      /CREDENTIAL_AUDIT_LOGS_ARE_IMMUTABLE/
    );

    // Attempting to DELETE the audit record must fail at the database level
    await assert.rejects(
      async () => {
        await adapter.query(
          `DELETE FROM broker_credential_audit_log WHERE id = $1`,
          [log.id]
        );
      },
      /CREDENTIAL_AUDIT_LOGS_ARE_IMMUTABLE/
    );
  });
});
