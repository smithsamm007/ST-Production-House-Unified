import test from "node:test";
import assert from "node:assert/strict";
import { PostgresCredentialRepository } from "../../src/credentials/postgresCredentialRepository.js";
import { CredentialAuditRepository } from "../../src/credentials/credentialAuditRepository.js";

/**
 * Adversarial SQL-injection matrix.
 *
 * Every user-controlled value that flows into the credential repositories must be
 * passed as a bound parameter ($n) and must NEVER appear verbatim inside the SQL
 * text. This suite drives every public method with hostile payloads through a
 * recording fake adapter and asserts:
 *   1. The payload never appears in any SQL string.
 *   2. The payload DOES appear in the bound-params array of some query.
 *   3. Secret locator payloads are redacted from audit rows / error messages.
 *   4. Enum-validated fields reject hostile values cleanly before reaching SQL.
 */

/** Records every query (sql + params) and returns scripted rows. */
class RecordingAdapter {
  constructor() {
    this.queries = [];
    this.row = {
      id: 1,
      version: 1,
      revoked_at: null,
      rotation_status: "stable",
      expires_at: null,
      last_health_status: "healthy",
      secret_locator: "vault://genuine-locator",
    };
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    return { rows: [this.row], rowCount: 1 };
  }

  async withTransaction(fn) {
    // The fake client is the adapter itself; every query is still recorded.
    return fn(this);
  }

  reset() {
    this.queries = [];
  }
}

const HOSTILE_PAYLOADS = [
  "x' OR '1'='1",
  "'; DROP TABLE broker_credential_metadata;--",
  "' UNION SELECT secret_locator FROM broker_credential_metadata--",
  "admin'--",
  "x'; COPY (SELECT '') TO PROGRAM 'cat /etc/passwd';--",
  "1; SELECT pg_sleep(5);--",
  "%27%20OR%201%3D1--",
  "\" OR \"1\"=\"1",
  "\\'; DROP TABLE broker_credential_audit_log;--",
  "0x3a;DELETE FROM broker_credential_metadata;--",
  "$1; DROP TABLE x;--",
  "<script>alert(1)</script>",
  "..\\..\\etc\\passwd",
  // Locator-schema payloads must carry the opaque prefix to pass validation;
  // the hostile tail must still never reach SQL text.
  "vault://x' OR '1'='1",
  "opaque://'; DROP TABLE broker_credential_metadata;--",
  "vault://1' UNION SELECT secret_locator FROM broker_credential_metadata--",
];

const PAYLOAD_SET = new Set(HOSTILE_PAYLOADS);

/** A run is { name, run(repo, auditRepo, payload) } — one hostile value per run. */
const MATRIX = [
  // ---- PostgresCredentialRepository ----
  {
    name: "create(provider)",
    run: (repo, _audit, p) =>
      repo.create({ ownerId: "owner-1", agentId: "agent-01", provider: p, capability: "text_generation", secretLocator: "vault://ok", lastHealthStatus: "healthy" }),
  },
  {
    name: "create(capability)",
    run: (repo, _audit, p) =>
      repo.create({ ownerId: "owner-1", agentId: "agent-01", provider: "gemini_free", capability: p, secretLocator: "vault://ok", lastHealthStatus: "healthy" }),
  },
  {
    name: "create(ownerId)",
    run: (repo, _audit, p) =>
      repo.create({ ownerId: p, agentId: "agent-01", provider: "gemini_free", capability: "text_generation", secretLocator: "vault://ok", lastHealthStatus: "healthy" }),
  },
  {
    name: "create(agentId)",
    run: (repo, _audit, p) =>
      repo.create({ ownerId: "owner-1", agentId: p, provider: "gemini_free", capability: "text_generation", secretLocator: "vault://ok", lastHealthStatus: "healthy" }),
  },
  {
    name: "create(secretLocator)",
    run: (repo, _audit, p) =>
      repo.create({ ownerId: "owner-1", agentId: "agent-01", provider: "gemini_free", capability: "text_generation", secretLocator: p, lastHealthStatus: "healthy" }),
  },
  {
    name: "findLocatorScoped(provider)",
    run: (repo, _audit, p) =>
      repo.findLocatorScoped({ ownerId: "owner-1", agentId: "agent-01", provider: p, capability: "text_generation", credentialId: "42" }),
  },
  {
    name: "findLocatorScoped(credentialId)",
    run: (repo, _audit, p) =>
      repo.findLocatorScoped({ ownerId: "owner-1", agentId: "agent-01", provider: "gemini_free", capability: "text_generation", credentialId: p }),
  },
  {
    name: "listByAgent(agentId)",
    run: (repo, _audit, p) => repo.listByAgent(p, "owner-1"),
  },
  {
    name: "listByAgent(ownerId)",
    run: (repo, _audit, p) => repo.listByAgent("agent-01", p),
  },
  {
    name: "listAll(ownerId)",
    run: (repo, _audit, p) => repo.listAll(p),
  },
  {
    name: "rotate(newSecretLocator)",
    run: (repo, _audit, p) =>
      repo.rotate("7", "owner-1", "agent-01", { newSecretLocator: p, nextExpiresAt: null, expectedVersion: 1 }),
  },
  {
    name: "rotate(id)",
    run: (repo, _audit, p) =>
      repo.rotate(p, "owner-1", "agent-01", { newSecretLocator: "vault://ok", nextExpiresAt: null, expectedVersion: 1 }),
  },
  {
    name: "rotate(ownerId)",
    run: (repo, _audit, p) =>
      repo.rotate("7", p, "agent-01", { newSecretLocator: "vault://ok", nextExpiresAt: null, expectedVersion: 1 }),
  },
  {
    name: "revoke(id)",
    run: (repo, _audit, p) => repo.revoke(p, "owner-1", "agent-01"),
  },
  {
    name: "updateMetadataScoped(id)",
    run: (repo, _audit, p) =>
      repo.updateMetadataScoped(p, "owner-1", "agent-01", { rotationStatus: "rotating" }),
  },
  // ---- CredentialAuditRepository ----
  {
    name: "logAccess(ownerId)",
    run: (_repo, audit, p) =>
      audit.logAccess({ credentialId: "1", ownerId: p, agentId: "agent-01", action: "read", status: "success" }),
  },
  {
    name: "logAccess(agentId)",
    run: (_repo, audit, p) =>
      audit.logAccess({ credentialId: "1", ownerId: "owner-1", agentId: p, action: "read", status: "success" }),
  },
  {
    name: "logAccess(provider)",
    run: (_repo, audit, p) =>
      audit.logAccess({ credentialId: "1", ownerId: "owner-1", agentId: "agent-01", provider: p, capability: "text_generation", action: "read", status: "success" }),
  },
  {
    name: "logAccess(errorMessage)",
    run: (_repo, audit, p) =>
      audit.logAccess({ credentialId: "1", ownerId: "owner-1", agentId: "agent-01", action: "read", status: "failure", errorMessage: p }),
  },
  {
    name: "logAccess(clientIp)",
    run: (_repo, audit, p) =>
      audit.logAccess({ credentialId: "1", ownerId: "owner-1", agentId: "agent-01", action: "read", status: "success", clientIp: p }),
  },
  {
    name: "logAccess(userAgent)",
    run: (_repo, audit, p) =>
      audit.logAccess({ credentialId: "1", ownerId: "owner-1", agentId: "agent-01", action: "read", status: "success", userAgent: p }),
  },
  {
    name: "listLogsByOwner(ownerId)",
    run: (_repo, audit, p) => audit.listLogsByOwner(p, "agent-01"),
  },
  {
    name: "listLogsByCredential(credentialId)",
    run: (_repo, audit, p) => audit.listLogsByCredential(p, "owner-1", "agent-01"),
  },
];

function isLocatorPayload(p) {
  return p.startsWith("vault://") || p.startsWith("opaque://");
}

const adapter = new RecordingAdapter();
const auditRepo = new CredentialAuditRepository(adapter);
const repo = new PostgresCredentialRepository(adapter, auditRepo);

test("every matrix row reaches a clean outcome for every hostile payload", async () => {
  // "Clean" means: either the call completes, or it throws an error whose
  // message never echoes the payload (no SQL error, no reflection of input).
  for (const row of MATRIX) {
    for (const payload of HOSTILE_PAYLOADS) {
      adapter.reset();
      try {
        await row.run(repo, auditRepo, payload);
      } catch (err) {
        const message = String(err?.message ?? "");
        assert.ok(
          !message.includes(payload),
          `${row.name}: error message reflected hostile payload ${JSON.stringify(payload)}: ${message}`
        );
      }
    }
  }
});

test("hostile payloads never appear in SQL text and always travel as bound params", async () => {
  const allSql = [];
  for (const row of MATRIX) {
    for (const payload of HOSTILE_PAYLOADS) {
      adapter.reset();
      try {
        await row.run(repo, auditRepo, payload);
      } catch {
        // error expected; we only care about what reached the adapter
      }

      for (const { sql, params } of adapter.queries) {
        allSql.push(sql);
        assert.ok(
          !sql.includes(payload),
          `${row.name}: payload ${JSON.stringify(payload)} leaked into SQL: ${sql.trim().slice(0, 120)}`
        );
        // Every query must use positional placeholders.
        assert.match(sql, /\$\d+/, `${row.name}: query has no bound-parameter placeholders`);
      }

      // The payload must have been passed as a value somewhere — unless the call
      // was rejected before any SQL (e.g. locator or field-length validation),
      // in which case a failure audit row is written, or no query runs at all.
      const reachedParams = adapter.queries.some(({ params }) =>
        params.some((v) => typeof v === "string" && v.includes(payload))
      );
      if (!reachedParams) {
        const auditInserted = adapter.queries.some(({ sql }) => sql.includes("broker_credential_audit_log"));
        assert.ok(
          auditInserted || adapter.queries.length === 0,
          `${row.name}: payload ${JSON.stringify(payload)} neither bound nor rejected pre-SQL`
        );
      }
    }
  }

  // Global invariant: no hostile payload appears in any SQL observed across the matrix.
  for (const payload of HOSTILE_PAYLOADS) {
    for (const sql of allSql) {
      assert.ok(!sql.includes(payload), `payload ${JSON.stringify(payload)} found in SQL globally`);
    }
  }
});

test("secret locator payloads are redacted from stored audit error messages", async () => {
  for (const payload of HOSTILE_PAYLOADS.filter(isLocatorPayload)) {
    adapter.reset();
    const dto = await auditRepo.logAccess({
      credentialId: "1",
      ownerId: "owner-1",
      agentId: "agent-01",
      action: "read",
      status: "failure",
      errorMessage: `failed while resolving ${payload}`,
    });
    assert.ok(dto, "audit row should be returned");
    const message = dto.error_message ?? "";
    assert.ok(
      !message.includes(payload),
      `audit error_message leaked locator payload: ${message}`
    );
  }
});

test("enum-validated fields reject hostile values cleanly before any data SQL", async () => {
  const hostileEnums = [
    ["rotationStatus", "rotating' OR '1'='1", () => repo.updateMetadataScoped("7", "owner-1", "agent-01", { rotationStatus: "rotating' OR '1'='1" })],
    ["rotationStatus", "'; DROP TABLE broker_credential_metadata;--", () => repo.updateMetadataScoped("7", "owner-1", "agent-01", { rotationStatus: "'; DROP TABLE broker_credential_metadata;--" })],
    ["lastHealthStatus", "healthy;--", () => repo.updateMetadataScoped("7", "owner-1", "agent-01", { lastHealthStatus: "healthy;--" })],
    ["action", "read' OR '1'='1", () => auditRepo.logAccess({ credentialId: "1", ownerId: "owner-1", agentId: "agent-01", action: "read' OR '1'='1", status: "success" })],
    ["status", "success; DROP TABLE x;--", () => auditRepo.logAccess({ credentialId: "1", ownerId: "owner-1", agentId: "agent-01", action: "read", status: "success; DROP TABLE x;--" })],
  ];

  for (const [field, payload, run] of hostileEnums) {
    adapter.reset();
    let threw = false;
    try {
      await run();
    } catch {
      threw = true;
    }
    assert.ok(threw, `${field}: hostile value ${JSON.stringify(payload)} was accepted`);

    // A clean validation rejection must not issue any data query on the tables.
    for (const { sql } of adapter.queries) {
      assert.ok(!sql.includes(payload), `${field}: payload leaked into SQL: ${sql.trim().slice(0, 120)}`);
    }
  }
});