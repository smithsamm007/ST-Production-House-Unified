import test from "node:test";
import assert from "node:assert/strict";
import {
  CredentialBroker,
  SecurityViolationError,
  sanitizeErrorMessage,
  CredentialLease
} from "../src/credentials/credentialBroker.js";
import { TestOnlyInMemoryCredentialRepository } from "../src/credentials/credentialRepository.js";

// PostgreSQL-shaped strict Audit Repository Fake (enforces Foreign Key constraints)
class PostgresStrictAuditRepositoryFake {
  constructor(existingCredentialIds = new Set()) {
    this.existingCredentialIds = existingCredentialIds;
    this.events = [];
    this.shouldFail = false;
  }

  async recordEvent(payload) {
    if (this.shouldFail) {
      throw new Error("AUDIT_DB_DOWN");
    }

    // Emulate strict database constraint behavior
    if (payload.credentialId !== null && typeof payload.credentialId === "string") {
      if (!this.existingCredentialIds.has(payload.credentialId)) {
        // FK Violation!
        throw new Error("FOREIGN_KEY_VIOLATION: credential_id does not exist in credentials table");
      }
    }

    this.events.push(payload);
  }
}

test("Credential Broker - Constructor requires strict interfaces", () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const resolver = () => {};
  const audit = new PostgresStrictAuditRepositoryFake();

  // Missing repository
  assert.throws(() => {
    new CredentialBroker({ resolver, auditRepository: audit });
  }, /INVALID_REPOSITORY/);

  // Missing resolver
  assert.throws(() => {
    new CredentialBroker({ repository: repo, auditRepository: audit });
  }, /INVALID_RESOLVER/);

  // Missing audit repository
  assert.throws(() => {
    new CredentialBroker({ repository: repo, resolver });
  }, /INVALID_AUDIT_REPOSITORY/);

  // Valid constructor succeeds
  const broker = new CredentialBroker({ repository: repo, resolver, auditRepository: audit });
  assert.ok(broker);
});

test("Credential Broker - Registration, scheme allowlist, and recursive scanning", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const audit = new PostgresStrictAuditRepositoryFake();
  const broker = new CredentialBroker({ repository: repo, resolver: () => {}, auditRepository: audit });

  const ownerId = "owner-1";

  // Success with allowed schemes
  const okId = await broker.register(ownerId, {
    id: "cred-1",
    agentId: "agent-1",
    provider: "gemini",
    capability: "cap-1",
    locator: "vault://loc"
  });
  assert.equal(okId, "cred-1");

  // Rejects unallowlisted scheme
  await assert.rejects(async () => {
    await broker.register(ownerId, {
      id: "cred-2",
      agentId: "agent-1",
      provider: "gemini",
      capability: "cap-1",
      locator: "http://raw-url"
    });
  }, SecurityViolationError);

  // Strengthened plaintext checking on arrays and nested structures
  await assert.rejects(async () => {
    await broker.register(ownerId, {
      id: "cred-3",
      agentId: "agent-1",
      provider: "gemini",
      capability: "cap-1",
      locator: "vault://loc",
      metadata: {
        apiKeyList: ["vault://ok", "plain_un_opaque_secret"] // Contains plaintext inside array on secret-bearing key
      }
    });
  }, SecurityViolationError);

  // Strengthened checking for non-string primitives under sensitive keys
  await assert.rejects(async () => {
    await broker.register(ownerId, {
      id: "cred-4",
      agentId: "agent-1",
      provider: "gemini",
      capability: "cap-1",
      locator: "vault://loc",
      apiKey: 12345 // Non-string primitive on secret-bearing key
    });
  }, SecurityViolationError);

  // Strengthened checking for circular structures
  const cyclic = { a: "vault://ok" };
  cyclic.self = cyclic;
  const okCyclicId = await broker.register(ownerId, {
    id: "cred-5",
    agentId: "agent-1",
    provider: "gemini",
    capability: "cap-1",
    locator: "vault://loc",
    metadata: cyclic
  });
  assert.equal(okCyclicId, "cred-5");

  // Prototype pollution safety guard: custom getters/setters are blocked
  await assert.rejects(async () => {
    const badObject = {};
    Object.defineProperty(badObject, "apiKey", {
      get: () => "plaintext",
      enumerable: true
    });
    await broker.register(ownerId, {
      id: "cred-bad-get",
      agentId: "a",
      provider: "p",
      capability: "c",
      locator: "vault://ok",
      metadata: badObject
    });
  }, SecurityViolationError);
});

test("Credential Broker - Scoped database lookups, multi-dimensional isolation and generic normalization", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const resolver = async (loc) => `resolved-secret-for-${loc}`;
  const audit = new PostgresStrictAuditRepositoryFake(new Set(["cred-secure"]));
  const broker = new CredentialBroker({ repository: repo, resolver, auditRepository: audit });

  const ownerId = "owner-1";
  const agentId = "agent-1";
  const provider = "gemini";
  const capability = "cap-1";
  const credentialId = "cred-secure";

  await broker.register(ownerId, {
    id: credentialId,
    agentId,
    provider,
    capability,
    locator: "vault://secrets/gemini"
  });

  // Successful resolution
  const lease = await broker.resolve({ ownerId, agentId, provider, capability, credentialId });
  assert.ok(lease);
  await lease.consume((secret) => {
    assert.equal(secret, "resolved-secret-for-vault://secrets/gemini");
  });
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].status, "success");
  assert.equal(audit.events[0].errorCode, null);

  // Every mismatch returns the exact same generic ACCESS_DENIED error without detailing which parameter failed
  const mismatchParams = [
    { ownerId: "wrong", agentId, provider, capability, credentialId },
    { ownerId, agentId: "wrong", provider, capability, credentialId },
    { ownerId, agentId, provider: "wrong", capability, credentialId },
    { ownerId, agentId, provider, capability: "wrong", credentialId },
  ];

  for (const params of mismatchParams) {
    await assert.rejects(async () => {
      await broker.resolve(params);
    }, (err) => {
      assert.equal(err.message, "ACCESS_DENIED");
      return true;
    });
  }
});

test("Credential Broker - Strict lease lifetime limits", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const resolver = async (loc) => "secret";
  const audit = new PostgresStrictAuditRepositoryFake(new Set(["cred-secure"]));
  const broker = new CredentialBroker({ repository: repo, resolver, auditRepository: audit });

  const ownerId = "owner-1";
  const agentId = "agent-1";
  const provider = "gemini";
  const capability = "cap-1";
  const credentialId = "cred-secure";

  await broker.register(ownerId, {
    id: credentialId,
    agentId,
    provider,
    capability,
    locator: "vault://secrets/gemini"
  });

  const invalidLifetimes = [Infinity, -100, 0, NaN, "30000", 300001];

  for (const lt of invalidLifetimes) {
    await assert.rejects(async () => {
      await broker.resolve({ ownerId, agentId, provider, capability, credentialId, lifetimeMs: lt });
    }, (err) => {
      assert.equal(err.message, "INVALID_LEASE_LIFETIME");
      return true;
    });
  }
});

test("Credential Broker - Resolver output validation", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const audit = new PostgresStrictAuditRepositoryFake(new Set(["cred-secure"]));

  const ownerId = "owner-1";
  const agentId = "agent-1";
  const provider = "gemini";
  const capability = "cap-1";
  const credentialId = "cred-secure";

  await repo.save({
    ownerId,
    agentId,
    provider,
    capability,
    credentialId,
    locator: "vault://secrets/gemini"
  });

  // Rejects invalid types: Array, Date, Function, Proxies/getters, and object containing Promises
  const badSecrets = [
    ["plain-secret"],
    new Date(),
    () => "secret",
    Object.create({ apiKey: "proto" }), // Custom prototype
    { api: Promise.resolve("secret") } // Object containing Promise
  ];

  for (const bs of badSecrets) {
    const brokerBad = new CredentialBroker({ repository: repo, resolver: async () => bs, auditRepository: audit });
    await assert.rejects(async () => {
      await brokerBad.resolve({ ownerId, agentId, provider, capability, credentialId });
    }, /ACCESS_DENIED/);
  }
});

test("Credential Broker - Locator revalidation immediately before resolution", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const resolver = async (loc) => "resolved-secret";
  const audit = new PostgresStrictAuditRepositoryFake(new Set(["cred-corrupt"]));
  const broker = new CredentialBroker({ repository: repo, resolver, auditRepository: audit });

  const ownerId = "owner-1";
  const agentId = "agent-1";
  const provider = "gemini";
  const capability = "cap-1";
  const credentialId = "cred-corrupt";

  // Stored credential locator gets corrupted or loaded maliciously with an unsupported scheme
  await repo.save({
    ownerId,
    agentId,
    provider,
    capability,
    credentialId,
    locator: "unsupported://secrets/private-api-key"
  });

  await assert.rejects(async () => {
    await broker.resolve({ ownerId, agentId, provider, capability, credentialId });
  }, (err) => {
    assert.equal(err.message, "ACCESS_DENIED");
    return true;
  });
});

test("Credential Lease - Safe consumption, revocation on downstream failure and zeroization", async () => {
  const buf = Buffer.from("temp-secret");
  const lease = new CredentialLease(buf, 1000);

  // Proving non-serializable
  assert.equal(JSON.stringify(lease), undefined);

  // Explicit consumption semantics
  const result = await lease.consume(async (secret) => {
    assert.equal(secret.toString(), "temp-secret");
    return "processed-data";
  });
  assert.equal(result, "processed-data");

  // Guarantee revocation after consume completed
  assert.equal(lease.isRevoked, true);
  await assert.rejects(async () => {
    await lease.consume(() => {});
  }, /LEASE_EXPIRED_OR_REVOKED/);
  // Confirm Buffer zeroization
  assert.equal(buf.every(byte => byte === 0), true);
});

test("Credential Broker - Audit failure fails closed", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const audit = new PostgresStrictAuditRepositoryFake(new Set(["cred-secure"]));
  const broker = new CredentialBroker({ repository: repo, resolver: async () => "secret", auditRepository: audit });

  const ownerId = "owner-1";
  const agentId = "agent-1";
  const provider = "gemini";
  const capability = "cap-1";
  const credentialId = "cred-secure";

  await repo.save({ ownerId, agentId, provider, capability, credentialId, locator: "vault://loc" });

  audit.shouldFail = true; // Trigger audit repository failure

  await assert.rejects(async () => {
    await broker.resolve({ ownerId, agentId, provider, capability, credentialId });
  }, (err) => {
    assert.equal(err.message, "AUDIT_PERSISTENCE_FAILURE");
    return true;
  });
});

test("Credential Broker - Non-existent ID maps to null to avoid Foreign Key violations in audit logs", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  // Existing Set is empty -> emulates zero rows in credential table
  const audit = new PostgresStrictAuditRepositoryFake(new Set());
  const broker = new CredentialBroker({ repository: repo, resolver: async () => "secret", auditRepository: audit });

  const ownerId = "owner-1";
  const agentId = "agent-1";
  const provider = "gemini";
  const capability = "cap-1";
  const nonExistentCredentialId = "cred-non-existent-uuid-12345";

  // Attempting to resolve non-existent credentialId
  await assert.rejects(async () => {
    await broker.resolve({ ownerId, agentId, provider, capability, credentialId: nonExistentCredentialId });
  }, (err) => {
    assert.equal(err.message, "ACCESS_DENIED");
    return true;
  });

  // Verify that audit log succeeded and didn't fail with FK Violation, because credentialId was logged as null!
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].credentialId, null);
  assert.equal(audit.events[0].status, "failed");
  assert.equal(audit.events[0].errorCode, "ACCESS_DENIED");
});
