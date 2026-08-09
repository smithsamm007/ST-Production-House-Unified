import test from "node:test";
import assert from "node:assert/strict";
import {
  CredentialBroker,
  SecurityViolationError,
  sanitizeErrorMessage,
  CredentialLease
} from "../src/credentials/credentialBroker.js";
import { TestOnlyInMemoryCredentialRepository } from "../src/credentials/credentialRepository.js";

// Mock audit repository for testing
class MockAuditRepository {
  constructor() {
    this.events = [];
    this.shouldFail = false;
  }
  async recordEvent(ownerId, eventType, payload) {
    if (this.shouldFail) {
      throw new Error("AUDIT_DB_DOWN");
    }
    this.events.push({ ownerId, eventType, payload });
  }
}

test("Credential Broker - Constructor requires strict interfaces", () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const resolver = () => {};
  const audit = new MockAuditRepository();

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
  const audit = new MockAuditRepository();
  const broker = new CredentialBroker({ repository: repo, resolver: () => {}, auditRepository: audit });

  const ownerId = "owner-1";

  // Success with allowed schemes
  const ok1 = await broker.register(ownerId, {
    id: "cred-1",
    agentId: "agent-1",
    provider: "gemini",
    capability: "cap-1",
    locator: "vault://loc"
  });
  assert.equal(ok1.id, "cred-1");

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
  const okCyclic = await broker.register(ownerId, {
    id: "cred-5",
    agentId: "agent-1",
    provider: "gemini",
    capability: "cap-1",
    locator: "vault://loc",
    metadata: cyclic
  });
  assert.equal(okCyclic.id, "cred-5");

  // Prototype pollution safety guard: secret carried on prototype chain must be blocked
  await assert.rejects(async () => {
    const maliciousPayload = JSON.parse('{"id": "cred-proto", "agentId": "a", "provider": "p", "capability": "c", "locator": "vault://ok", "__proto__": {"apiKey": "plaintext"}}');
    await broker.register(ownerId, maliciousPayload);
  }, SecurityViolationError);
});

test("Credential Broker - Resolution multi-dimensional isolation and generic error normalization", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const resolver = async (loc) => `resolved-secret-for-${loc}`;
  const audit = new MockAuditRepository();
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
  assert.equal(lease.getSecret(), "resolved-secret-for-vault://secrets/gemini");
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].payload.outcome, "success");

  // Every mismatch returns the exact same generic ACCESS_DENIED error without detailing which parameter failed
  await assert.rejects(async () => {
    await broker.resolve({ ownerId: "wrong", agentId, provider, capability, credentialId });
  }, (err) => {
    assert.equal(err.message, "ACCESS_DENIED");
    return true;
  });

  await assert.rejects(async () => {
    await broker.resolve({ ownerId, agentId: "wrong", provider, capability, credentialId });
  }, (err) => {
    assert.equal(err.message, "ACCESS_DENIED");
    return true;
  });

  await assert.rejects(async () => {
    await broker.resolve({ ownerId, agentId, provider: "wrong", capability, credentialId });
  }, (err) => {
    assert.equal(err.message, "ACCESS_DENIED");
    return true;
  });

  await assert.rejects(async () => {
    await broker.resolve({ ownerId, agentId, provider, capability: "wrong", credentialId });
  }, (err) => {
    assert.equal(err.message, "ACCESS_DENIED");
    return true;
  });
});

test("Credential Broker - Strict lease lifetime limits", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const resolver = async (loc) => "secret";
  const audit = new MockAuditRepository();
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

test("Credential Broker - Resolver returns invalid/DTO secret structures", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const audit = new MockAuditRepository();

  const ownerId = "owner-1";
  const agentId = "agent-1";
  const provider = "gemini";
  const capability = "cap-1";
  const credentialId = "cred-secure";

  await repo.save({
    id: credentialId,
    ownerId,
    agentId,
    provider,
    capability,
    locator: "vault://secrets/gemini"
  });

  // 1. Resolver returns empty string
  const brokerEmpty = new CredentialBroker({ repository: repo, resolver: async () => "", auditRepository: audit });
  await assert.rejects(async () => {
    await brokerEmpty.resolve({ ownerId, agentId, provider, capability, credentialId });
  }, /ACCESS_DENIED/);

  // 2. Resolver returns null
  const brokerNull = new CredentialBroker({ repository: repo, resolver: async () => null, auditRepository: audit });
  await assert.rejects(async () => {
    await brokerNull.resolve({ ownerId, agentId, provider, capability, credentialId });
  }, /ACCESS_DENIED/);
});

test("Credential Lease - Safe consumption, revocation on downstream failure and zeroization", async () => {
  const buf = Buffer.from("temp-secret");
  const lease = new CredentialLease(buf, 1000);

  // Explicit consumption semantics
  const result = await lease.consume(async (secret) => {
    assert.equal(secret.toString(), "temp-secret");
    return "processed-data";
  });
  assert.equal(result, "processed-data");

  // Guarantee revocation after consume completed
  assert.equal(lease.isRevoked, true);
  assert.throws(() => {
    lease.getSecret();
  });
  // Confirm Buffer zeroization
  assert.equal(buf.every(byte => byte === 0), true);
});

test("Credential Broker - Audit failure fails closed", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const audit = new MockAuditRepository();
  const broker = new CredentialBroker({ repository: repo, resolver: async () => "secret", auditRepository: audit });

  const ownerId = "owner-1";
  const agentId = "agent-1";
  const provider = "gemini";
  const capability = "cap-1";
  const credentialId = "cred-secure";

  await repo.save({ id: credentialId, ownerId, agentId, provider, capability, locator: "vault://loc" });

  audit.shouldFail = true; // Trigger audit repository failure

  await assert.rejects(async () => {
    await broker.resolve({ ownerId, agentId, provider, capability, credentialId });
  }, (err) => {
    assert.equal(err.message, "AUDIT_PERSISTENCE_FAILURE");
    return true;
  });
});
