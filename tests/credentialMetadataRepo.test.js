import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCredentialMetadata,
  getCredentialMetadata,
  updateCredentialStatus,
  rotateCredentialMetadata,
  listCredentialMetadata,
  appendAuditLog,
  getAuditLogsByLocator,
  validateLocatorId,
  CredentialMetadataRepository,
} from '../src/repos/credential-metadata.js';

/**
 * In-memory Fake Query Client
 * Simulates a PostgreSQL client query interface without needing a database connection.
 */
function createFakeClient() {
  const executedQueries = [];
  const metadataStore = new Map();
  const auditLogsStore = [];
  let nextAuditId = 1;

  return {
    executedQueries,
    metadataStore,
    auditLogsStore,
    async query(sql, params = []) {
      executedQueries.push({ sql, params: [...params] });

      const normalizedSql = sql.trim().replace(/\s+/g, ' ');

      // INSERT INTO credential_metadata
      if (normalizedSql.startsWith('INSERT INTO credential_metadata')) {
        const [locator_id, provider_id, status, scope_label, expires_at, created_by, created_at] = params;
        const row = {
          locator_id,
          provider_id,
          status,
          scope_label,
          expires_at: expires_at ? new Date(expires_at) : null,
          created_by,
          created_at: created_at ? new Date(created_at) : new Date(),
          rotated_at: null,
        };
        metadataStore.set(locator_id, row);
        return { rows: [row], rowCount: 1 };
      }

      // SELECT * FROM credential_metadata WHERE locator_id = $1
      if (normalizedSql.startsWith('SELECT * FROM credential_metadata WHERE locator_id = $1')) {
        const locatorId = params[0];
        const row = metadataStore.get(locatorId);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // UPDATE credential_metadata SET status = $2 WHERE locator_id = $1
      if (normalizedSql.startsWith('UPDATE credential_metadata SET status = $2 WHERE locator_id = $1')) {
        const [locatorId, newStatus] = params;
        const row = metadataStore.get(locatorId);
        if (!row) return { rows: [], rowCount: 0 };
        row.status = newStatus;
        return { rows: [row], rowCount: 1 };
      }

      // UPDATE credential_metadata SET rotated_at =
      if (normalizedSql.startsWith('UPDATE credential_metadata SET rotated_at =')) {
        const [locatorId, rotatedAt, expiresAt, status] = params;
        const row = metadataStore.get(locatorId);
        if (!row) return { rows: [], rowCount: 0 };
        row.rotated_at = rotatedAt || new Date();
        if (expiresAt !== null) row.expires_at = expiresAt;
        if (status !== null) row.status = status;
        return { rows: [row], rowCount: 1 };
      }

      // SELECT * FROM credential_metadata (with optional filters)
      if (normalizedSql.startsWith('SELECT * FROM credential_metadata')) {
        let results = Array.from(metadataStore.values());
        if (normalizedSql.includes('provider_id =')) {
          const providerId = params[0];
          results = results.filter(r => r.provider_id === providerId);
        }
        if (normalizedSql.includes('status =')) {
          const statusVal = params[params.length - 1];
          results = results.filter(r => r.status === statusVal);
        }
        return { rows: results, rowCount: results.length };
      }

      // INSERT INTO credential_audit_log
      if (normalizedSql.startsWith('INSERT INTO credential_audit_log')) {
        const [locator_id, event, actor, detailJson] = params;
        const row = {
          id: String(nextAuditId++),
          locator_id,
          event,
          actor,
          detail: JSON.parse(detailJson),
          occurred_at: new Date(),
        };
        auditLogsStore.push(row);
        return { rows: [row], rowCount: 1 };
      }

      // SELECT * FROM credential_audit_log WHERE locator_id = $1
      if (normalizedSql.startsWith('SELECT * FROM credential_audit_log WHERE locator_id = $1')) {
        const locatorId = params[0];
        const results = auditLogsStore.filter(a => a.locator_id === locatorId);
        return { rows: results, rowCount: results.length };
      }

      return { rows: [], rowCount: 0 };
    },
  };
}

describe('Credential Metadata Repository (DB-free offline unit tests)', () => {

  describe('Secret Prohibition & Locator Format Validation', () => {
    test('validateLocatorId accepts vault:// and opaque:// locators', () => {
      assert.equal(validateLocatorId('vault://st-production/openai-key'), 'vault://st-production/openai-key');
      assert.equal(validateLocatorId('opaque://st-production/anthropic-token'), 'opaque://st-production/anthropic-token');
    });

    test('validateLocatorId rejects raw secret values and non-opaque handles', () => {
      assert.throws(
        () => validateLocatorId('sk-proj-1234567890abcdef'),
        /Forbidden locatorId format/
      );
      assert.throws(
        () => validateLocatorId('my-secret-key-value'),
        /Forbidden locatorId format/
      );
      assert.throws(
        () => validateLocatorId('https://vault.internal/secret'),
        /Forbidden locatorId format/
      );
      assert.throws(
        () => validateLocatorId(''),
        /Invalid locatorId/
      );
      assert.throws(
        () => validateLocatorId(null),
        /Invalid locatorId/
      );
    });

    test('createCredentialMetadata rejects raw plaintext secrets', async () => {
      const client = createFakeClient();
      await assert.rejects(
        () => createCredentialMetadata(client, {
          locatorId: 'sk-live-supersecretvalue12345',
          providerId: 'openai',
          scopeLabel: 'production',
          createdBy: 'admin',
        }),
        /Forbidden locatorId format/
      );
    });
  });

  describe('SQL Injection Prevention Tests', () => {
    test('malicious locator string arrives strictly as bound parameter $1', async () => {
      const client = createFakeClient();
      const maliciousLocator = "vault://st/key'; DROP TABLE credential_metadata; --";

      const created = await createCredentialMetadata(client, {
        locatorId: maliciousLocator,
        providerId: "openai'; DELETE FROM credential_metadata; --",
        scopeLabel: "prod' OR '1'='1",
        createdBy: "user'; TRUNCATE TABLE credential_audit_log; --",
      });

      assert.equal(created.locator_id, maliciousLocator);

      const lastQuery = client.executedQueries[0];
      assert.ok(lastQuery, 'A query should have been executed');

      // Assert no string interpolation happened in SQL string
      assert.ok(!lastQuery.sql.includes(maliciousLocator), 'SQL string must NOT contain user string interpolation');
      assert.ok(!lastQuery.sql.includes('DROP TABLE'), 'SQL string must NOT contain injected commands');
      assert.ok(lastQuery.sql.includes('$1'), 'SQL query must use $1 bound parameter');
      assert.ok(lastQuery.sql.includes('$2'), 'SQL query must use $2 bound parameter');

      // Assert malicious string is passed safely in params array
      assert.equal(lastQuery.params[0], maliciousLocator);
      assert.equal(lastQuery.params[1], "openai'; DELETE FROM credential_metadata; --");
      assert.equal(lastQuery.params[3], "prod' OR '1'='1");
      assert.equal(lastQuery.params[5], "user'; TRUNCATE TABLE credential_audit_log; --");
    });

    test('getCredentialMetadata passes malicious locator as parameter $1', async () => {
      const client = createFakeClient();
      const maliciousLocator = "opaque://st/token' OR '1'='1";

      await getCredentialMetadata(client, maliciousLocator);

      const lastQuery = client.executedQueries[0];
      assert.ok(lastQuery.sql.includes('WHERE locator_id = $1'));
      assert.ok(!lastQuery.sql.includes("'1'='1"));
      assert.equal(lastQuery.params[0], maliciousLocator);
    });
  });

  describe('Credential Metadata Lifecycle Operations', () => {
    test('creates, reads, updates status, and rotates metadata', async () => {
      const client = createFakeClient();
      const locatorId = 'vault://st-production/gemini-api-key';

      // 1. Create metadata
      const created = await createCredentialMetadata(client, {
        locatorId,
        providerId: 'google-gemini',
        status: 'provisioned',
        scopeLabel: 'agent-01-vision',
        createdBy: 'owner-admin',
      });

      assert.equal(created.locator_id, locatorId);
      assert.equal(created.provider_id, 'google-gemini');
      assert.equal(created.status, 'provisioned');
      assert.equal(created.scope_label, 'agent-01-vision');
      assert.equal(created.created_by, 'owner-admin');

      // 2. Read metadata
      const read = await getCredentialMetadata(client, locatorId);
      assert.deepEqual(read, created);

      // 3. Update status to active
      const updatedStatus = await updateCredentialStatus(client, locatorId, 'active');
      assert.equal(updatedStatus.status, 'active');

      // 4. Rotate metadata
      const rotatedAt = new Date();
      const expiresAt = new Date(Date.now() + 86400000);
      const rotated = await rotateCredentialMetadata(client, locatorId, {
        rotatedAt,
        expiresAt,
        status: 'active',
      });

      assert.equal(rotated.status, 'active');
      assert.equal(rotated.rotated_at.getTime(), rotatedAt.getTime());

      // 5. List metadata
      const list = await listCredentialMetadata(client, { providerId: 'google-gemini' });
      assert.equal(list.length, 1);
      assert.equal(list[0].locator_id, locatorId);
    });

    test('rejects invalid status transitions and values', async () => {
      const client = createFakeClient();
      const locatorId = 'vault://st/test-key';

      await assert.rejects(
        () => createCredentialMetadata(client, {
          locatorId,
          providerId: 'test',
          status: 'INVALID_STATUS',
          scopeLabel: 'test',
          createdBy: 'admin',
        }),
        /Invalid status/
      );

      await assert.rejects(
        () => updateCredentialStatus(client, locatorId, 'SUPER_ACTIVE'),
        /Invalid status/
      );
    });
  });

  describe('Immutable Audit Log Operations (Append-Only)', () => {
    test('appends audit log entries and retrieves them', async () => {
      const client = createFakeClient();
      const locatorId = 'opaque://st-production/elevenlabs-voice';

      // Seed metadata first
      await createCredentialMetadata(client, {
        locatorId,
        providerId: 'elevenlabs',
        scopeLabel: 'audio-synthesis',
        createdBy: 'system',
      });

      // Append audit logs
      const log1 = await appendAuditLog(client, {
        locatorId,
        event: 'created',
        actor: 'system',
        detail: { reason: 'Initial provisioning' },
      });

      assert.equal(log1.locator_id, locatorId);
      assert.equal(log1.event, 'created');
      assert.equal(log1.actor, 'system');
      assert.deepEqual(log1.detail, { reason: 'Initial provisioning' });

      const log2 = await appendAuditLog(client, {
        locatorId,
        event: 'accessed',
        actor: 'agent-02',
        detail: { slot: 'primary' },
      });

      assert.equal(log2.event, 'accessed');
      assert.equal(log2.actor, 'agent-02');

      // Fetch audit trail
      const logs = await getAuditLogsByLocator(client, locatorId);
      assert.equal(logs.length, 2);
      assert.equal(logs[0].event, 'created');
      assert.equal(logs[1].event, 'accessed');
    });

    test('verifies audit rows are append-only by construction (no update/delete path in repo)', () => {
      import('../src/repos/credential-metadata.js').then((repoModule) => {
        // Assert no functions for updating or deleting audit entries exist in exports
        const exportedKeys = Object.keys(repoModule);

        assert.ok(!exportedKeys.includes('updateAuditLog'), 'No updateAuditLog path should exist');
        assert.ok(!exportedKeys.includes('deleteAuditLog'), 'No deleteAuditLog path should exist');
        assert.ok(!exportedKeys.includes('updateAudit'), 'No updateAudit path should exist');
        assert.ok(!exportedKeys.includes('deleteAudit'), 'No deleteAudit path should exist');
        assert.ok(!exportedKeys.includes('removeAuditLog'), 'No removeAuditLog path should exist');

        const repoClassPrototype = Object.getOwnPropertyNames(CredentialMetadataRepository.prototype);
        assert.ok(!repoClassPrototype.includes('updateAudit'), 'No updateAudit method on class prototype');
        assert.ok(!repoClassPrototype.includes('deleteAudit'), 'No deleteAudit method on class prototype');
      });
    });

    test('rejects invalid audit log events', async () => {
      const client = createFakeClient();
      const locatorId = 'vault://st/test-key';

      await assert.rejects(
        () => appendAuditLog(client, {
          locatorId,
          event: 'MALICIOUS_EVENT',
          actor: 'attacker',
        }),
        /Invalid audit event/
      );
    });
  });

  describe('CredentialMetadataRepository Class Interface', () => {
    test('works with class instance wrapping injected client', async () => {
      const client = createFakeClient();
      const repo = new CredentialMetadataRepository(client);
      const locatorId = 'vault://st/class-test-key';

      const created = await repo.createMetadata({
        locatorId,
        providerId: 'openai',
        scopeLabel: 'text-gen',
        createdBy: 'admin',
      });
      assert.equal(created.locator_id, locatorId);

      const fetched = await repo.getMetadata(locatorId);
      assert.equal(fetched.locator_id, locatorId);

      const updated = await repo.updateStatus(locatorId, 'active');
      assert.equal(updated.status, 'active');

      const audit = await repo.appendAudit({
        locatorId,
        event: 'status_changed',
        actor: 'admin',
        detail: { status: 'active' },
      });
      assert.equal(audit.event, 'status_changed');

      const logs = await repo.getAuditLogs(locatorId);
      assert.equal(logs.length, 1);
    });
  });

  describe('Injected Client Validation', () => {
    test('throws error if client is missing or invalid', async () => {
      await assert.rejects(
        () => createCredentialMetadata(null, { locatorId: 'vault://st/k', providerId: 'p', scopeLabel: 's', createdBy: 'u' }),
        /Injected client interface/
      );
      await assert.rejects(
        () => getCredentialMetadata({}, 'vault://st/k'),
        /Injected client interface/
      );
    });
  });

});
