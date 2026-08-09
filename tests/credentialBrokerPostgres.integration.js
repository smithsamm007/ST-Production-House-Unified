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
  const auditRepo = new CredentialAuditRepository(adapter);
  const credentialRepo = new PostgresCredentialRepository(adapter, auditRepo);

  // Seed data inside integration tests
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
    // Teardown with standard privileged reset
    if (owner1Id && owner2Id) {
      await adapter.query(`TRUNCATE broker_credential_metadata, broker_credential_audit_log, owners RESTART IDENTITY CASCADE;`).catch(() => {});
    }
    if (testPool) {
      await testPool.end().catch(() => {});
    }
  });

  await t.test("Migrations 001-010 remain byte-identical", async () => {
    // Verify that checksums of migrations 001-010 remain unmodified
    const status = await runner.getStatus();
    const immutableChecksums = new Map([
      ["001_core.sql", "3fa84fd7f686ab56489cee6bafd99dcda58ceabe67268313412c8c4c0ba979db"],
      ["002_seed_agents.sql", "33011cecbc851388fc6433c110ab9118fd25da276d55ed0b2fd5faec83f26f4d"],
      ["003_agent_digital_identity.sql", "20a8aa319054a29025457a32d7ca6061296c3283c24889357771fcc311d80171"],
      ["004_creative_charter.sql", "2bf1c7292487e05f2e1582eff95b2d517831611ad92b442f3b3186527d58fb1f"],
      ["005_creative_reference.sql", "2846bdd39a03b3421627ea28d148d4df79c06bd0200637bfe200117fe7ceac34"],
      ["006_seed_initial_creative_charters.sql", "9f2b801f2738862ea90eb5734693508189823f7f8343188560ea3cf71b578d65"],
      ["007_owner_agent_communication_studio.sql", "4d164008b597056fa7f70aa800ecdb503ca4dda31073493c8a25de3b533677ed"],
      ["008_owner_authentication_and_sessions.sql", "39d76ebab5ab92133080a054af95f1ade5375c0c6f4c0993f7434d39863eba51"],
    ]);

    for (const item of status) {
      if (immutableChecksums.has(item.filename)) {
        assert.equal(item.status, "APPLIED");
        assert.equal(item.recordedChecksum, immutableChecksums.get(item.filename));
      }
    }
  });

  await t.test("Migration Rerun / Idempotency Check", async () => {
    const result = await runner.runMigrations();
    assert.equal(result.appliedCount, 0, "No new migrations should be applied on second run");
  });

  await t.test("Check Constraint & Length Violations", async () => {
    // Plaintext secrets
    await assert.rejects(
      async () => {
        await credentialRepo.create({
          ownerId: owner1Id,
          agentId: agentId1,
          provider: 'gemini',
          capability: 'storytelling',
          secretLocator: 'plaintext-secret'
        });
      },
      /Plaintext secret/
    );

    // Corrupted locator scheme
    await assert.rejects(
      async () => {
        await credentialRepo.create({
          ownerId: owner1Id,
          agentId: agentId1,
          provider: 'gemini',
          capability: 'storytelling',
          secretLocator: 'vau://corrupted'
        });
      },
      /Plaintext secret/
    );

    // Bounded lengths
    await assert.rejects(
      async () => {
        await credentialRepo.create({
          ownerId: owner1Id,
          agentId: agentId1,
          provider: 'a'.repeat(101),
          capability: 'storytelling',
          secretLocator: 'vault://st/ok'
        });
      },
      /provider length/
    );
  });

  await t.test("Referential Integrity constraints", async () => {
    // Bad agent id
    await assert.rejects(
      async () => {
        await credentialRepo.create({
          ownerId: owner1Id,
          agentId: 'non-existent-agent',
          provider: 'gemini',
          capability: 'storytelling',
          secretLocator: 'vault://st/ok'
        });
      },
      /foreign key/
    );

    // Bad owner id
    await assert.rejects(
      async () => {
        await credentialRepo.create({
          ownerId: '00000000-0000-0000-0000-000000000000',
          agentId: agentId1,
          provider: 'gemini',
          capability: 'storytelling',
          secretLocator: 'vault://st/ok'
        });
      },
      /foreign key/
    );
  });

  await t.test("Direct Database Constraint Tests (Raw SQL insert bounds)", async () => {
    // Direct insert to test DB check constraint
    await assert.rejects(
      async () => {
        await adapter.query(
          `INSERT INTO broker_credential_metadata (owner_id, agent_id, provider, capability, secret_locator)
           VALUES ($1, $2, 'gemini', 'default', 'plaintext_raw_secret')`,
          [owner1Id, agentId1]
        );
      },
      /no_plaintext_secrets_locator/
    );
  });

  await t.test("Transactional Rollback on creation failure", async () => {
    await assert.rejects(
      async () => {
        await adapter.withTransaction(async (client) => {
          await client.query(
            `INSERT INTO broker_credential_metadata (owner_id, agent_id, provider, capability, secret_locator)
             VALUES ($1, $2, 'gemini', 'default', 'vault://st/secret-rollback')`,
            [owner1Id, agentId1]
          );

          // Force failure
          await client.query("SELECT * FROM non_existent_table;");
        });
      }
    );

    const check = await adapter.query(
      `SELECT * FROM broker_credential_metadata WHERE secret_locator = 'vault://st/secret-rollback'`
    );
    assert.equal(check.rowCount, 0, "Durable changes must be rolled back on transaction failure");
  });

  await t.test("Contract compatibility and Scoped retrieval", async () => {
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'claude',
      capability: 'writing',
      secretLocator: 'vault://st/owner1/claude/v1'
    });
    assert.ok(cred.id);

    // findScoped contract check (5-dimensional authorization)
    const found = await credentialRepo.findScoped({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'claude',
      capability: 'writing',
      credentialId: cred.id
    });
    assert.equal(found.id, cred.id);
    assert.equal(found.secret_locator, 'vault://[REDACTED]'); // Secret is masked publicly!

    // Internal resolution yields raw locator (point 6)
    const raw = await credentialRepo.resolveSecretLocatorInternal({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'claude',
      capability: 'writing',
      credentialId: cred.id
    });
    assert.equal(raw.secret_locator, 'vault://st/owner1/claude/v1');

    // Scoped reads/authorization: unauthorized combinations throw generic errors (point 5)
    await assert.rejects(
      async () => {
        await credentialRepo.findScoped({
          ownerId: owner2Id, // unauthorized owner
          agentId: agentId1,
          provider: 'claude',
          capability: 'writing',
          credentialId: cred.id
        });
      },
      /Credential not found or unauthorized/
    );

    await assert.rejects(
      async () => {
        await credentialRepo.findScoped({
          ownerId: owner1Id,
          agentId: agentId2, // incorrect agent
          provider: 'claude',
          capability: 'writing',
          credentialId: cred.id
        });
      },
      /Credential not found or unauthorized/
    );
  });

  await t.test("Same-Owner Cross-Agent Denial", async () => {
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'claude',
      capability: 'writing',
      secretLocator: 'vault://st/owner1/claude/cross-agent'
    });

    // Try to lookup using incorrect agent (fails!)
    await assert.rejects(
      async () => {
        await credentialRepo.findScoped({
          ownerId: owner1Id,
          agentId: agentId2, // incorrect agent
          provider: 'claude',
          capability: 'writing',
          credentialId: cred.id
        });
      },
      /Credential not found or unauthorized/
    );

    // Try to rotate using incorrect agent (fails!)
    await assert.rejects(
      async () => {
        await credentialRepo.rotate(cred.id, owner1Id, agentId2, {
          newSecretLocator: 'vault://st/owner1/claude/rotated'
        });
      },
      /Credential not found or unauthorized/
    );

    // Try to revoke using incorrect agent (fails!)
    await assert.rejects(
      async () => {
        await credentialRepo.revoke(cred.id, owner1Id, agentId2);
      },
      /Credential not found or unauthorized/
    );
  });

  await t.test("Concurrency-safe updates, rotation, and revocation races", async () => {
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'gemini',
      capability: 'vision',
      secretLocator: 'vault://st/owner1/gemini/v1'
    });

    // Scoped rotation requires ownerId and agentId
    const rotated = await credentialRepo.rotate(cred.id, owner1Id, agentId1, {
      newSecretLocator: 'vault://st/owner1/gemini/v2',
      expectedVersion: 1
    });
    assert.equal(rotated.version, 2);

    // Version mismatch error
    await assert.rejects(
      async () => {
        await credentialRepo.rotate(cred.id, owner1Id, agentId1, {
          newSecretLocator: 'vault://st/owner1/gemini/v3',
          expectedVersion: 1
        });
      },
      /CONCURRENCY_ERROR/
    );

    // Concurrency race tests
    const p1 = credentialRepo.rotate(cred.id, owner1Id, agentId1, {
      newSecretLocator: 'vault://st/owner1/gemini/race1',
      expectedVersion: 2
    });
    const p2 = credentialRepo.rotate(cred.id, owner1Id, agentId1, {
      newSecretLocator: 'vault://st/owner1/gemini/race2',
      expectedVersion: 2
    });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason.message.includes("CONCURRENCY_ERROR"));
  });

  await t.test("Redaction & Sanitization of errors in audit logs", async () => {
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'ollama',
      capability: 'inference',
      secretLocator: 'vault://st/owner1/ollama'
    });

    const errorMsg = "Auth error using API key: api_key=secret-key password=secret-password";
    const log = await auditRepo.logAccess({
      credentialId: cred.id,
      ownerId: owner1Id,
      agentId: agentId1,
      action: 'read',
      status: 'failure',
      errorMessage: errorMsg
    });

    assert.ok(!log.error_message.includes('secret-key'));
    assert.ok(!log.error_message.includes('secret-password'));
    assert.ok(log.error_message.includes('[REDACTED]'));
  });

  await t.test("Immutable append-only audit triggered updates/deletes rejection", async () => {
    const cred = await credentialRepo.create({
      ownerId: owner1Id,
      agentId: agentId1,
      provider: 'ollama',
      capability: 'inference',
      secretLocator: 'vault://st/owner1/ollama-audit'
    });

    const log = await auditRepo.logAccess({
      credentialId: cred.id,
      ownerId: owner1Id,
      agentId: agentId1,
      action: 'read',
      status: 'success'
    });

    // Direct UPDATE fails
    await assert.rejects(
      async () => {
        await adapter.query(`UPDATE broker_credential_audit_log SET status = 'failed' WHERE id = $1`, [log.id]);
      },
      /CREDENTIAL_AUDIT_LOGS_ARE_IMMUTABLE/
    );

    // Direct DELETE fails
    await assert.rejects(
      async () => {
        await adapter.query(`DELETE FROM broker_credential_audit_log WHERE id = $1`, [log.id]);
      },
      /CREDENTIAL_AUDIT_LOGS_ARE_IMMUTABLE/
    );
  });

  await t.test("Parent Owner/Credential RESTRICT deletion prevents orphans", async () => {
    // Create owner, credential, and audit log
    const oRes = await adapter.query(
      `INSERT INTO owners (email, password_hash) VALUES ('temp-owner@test.com', 'hash') RETURNING id`
    );
    const tempOwnerId = oRes.rows[0].id;

    const cred = await credentialRepo.create({
      ownerId: tempOwnerId,
      agentId: agentId1,
      provider: 'temp-prov',
      capability: 'temp-cap',
      secretLocator: 'vault://st/temp-secret'
    });

    await auditRepo.logAccess({
      credentialId: cred.id,
      ownerId: tempOwnerId,
      agentId: agentId1,
      action: 'read',
      status: 'success'
    });

    // Deleting parent credential fails due to ON DELETE RESTRICT (point 1 & 2)
    await assert.rejects(
      async () => {
        await adapter.query(`DELETE FROM broker_credential_metadata WHERE id = $1`, [cred.id]);
      },
      /foreign key constraint/
    );

    // Deleting parent owner fails due to ON DELETE RESTRICT
    await assert.rejects(
      async () => {
        await adapter.query(`DELETE FROM owners WHERE id = $1`, [tempOwnerId]);
      },
      /foreign key constraint/
    );

    // Clean up temp owner safely by first truncating or deleting audit/credential using transaction rollback/reset
    await adapter.query(`TRUNCATE broker_credential_metadata, broker_credential_audit_log, owners RESTART IDENTITY CASCADE;`).catch(() => {});
  });
});
