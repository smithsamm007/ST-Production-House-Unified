import test from "node:test";
import assert from "node:assert/strict";
import {
  CredentialBroker,
  SecurityViolationError,
  sanitizeErrorMessage,
  CredentialLease
} from "../src/credentials/credentialBroker.js";
import { TestOnlyInMemoryCredentialRepository } from "../src/credentials/credentialRepository.js";

test("Credential Broker - Constructor prevents implicit in-memory fallback", () => {
  assert.throws(() => {
    new CredentialBroker({ resolver: () => {} });
  }, /REPOSITORY_REQUIRED/);
});

test("Credential Broker - Registration and scheme allowlist validation", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const broker = new CredentialBroker({ repository: repo });

  const ownerId = "owner-123";

  // 1. Success with allowlisted schemes
  const valid1 = await broker.register(ownerId, {
    id: "cred-1",
    agentId: "agent-abc",
    provider: "gemini",
    capability: "text-generation",
    locator: "vault://production/gemini-api-key",
    metadata: { env: "prod" }
  });
  assert.equal(valid1.id, "cred-1");
  assert.equal(valid1.ownerId, ownerId);

  const valid2 = await broker.register(ownerId, {
    id: "cred-2",
    agentId: "agent-abc",
    provider: "claude",
    capability: "text-generation",
    locator: "opaque://production/claude-api-key",
    metadata: { env: "prod" }
  });
  assert.equal(valid2.id, "cred-2");

  // 2. Failure with non-allowlisted schemes
  await assert.rejects(async () => {
    await broker.register(ownerId, {
      id: "cred-3",
      agentId: "agent-abc",
      provider: "gemini",
      capability: "text-generation",
      locator: "plain://production/gemini-api-key",
      metadata: {}
    });
  }, SecurityViolationError);

  await assert.rejects(async () => {
    await broker.register(ownerId, {
      id: "cred-4",
      agentId: "agent-abc",
      provider: "gemini",
      capability: "text-generation",
      locator: "raw_api_key_value_without_scheme",
      metadata: {}
    });
  }, SecurityViolationError);
});

test("Credential Broker - Recursive plaintext secret rejection", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const broker = new CredentialBroker({ repository: repo });
  const ownerId = "owner-123";

  // 1. Reject plain text secrets in sensitive keys (root level)
  await assert.rejects(async () => {
    await broker.register(ownerId, {
      id: "cred-fail",
      agentId: "agent-abc",
      provider: "gemini",
      capability: "text-generation",
      locator: "vault://production/api-key",
      apiKey: "raw_plaintext_api_key_123" // Sensitive key has plaintext
    });
  }, SecurityViolationError);

  // 2. Reject plain text secrets in sensitive keys (nested level inside metadata)
  await assert.rejects(async () => {
    await broker.register(ownerId, {
      id: "cred-fail-nested",
      agentId: "agent-abc",
      provider: "gemini",
      capability: "text-generation",
      locator: "vault://production/api-key",
      metadata: {
        config: {
          privateKey: "raw_private_key_material" // Nested sensitive key has plaintext
        }
      }
    });
  }, SecurityViolationError);

  // 3. Accepts allowed locator scheme strings even in nested/sensitive keys
  const validNested = await broker.register(ownerId, {
    id: "cred-ok-nested",
    agentId: "agent-abc",
    provider: "gemini",
    capability: "text-generation",
    locator: "vault://production/api-key",
    metadata: {
      config: {
        privateKey: "vault://production/nested-private-key" // Valid scheme!
      }
    }
  });
  assert.equal(validNested.id, "cred-ok-nested");
});

test("Credential Broker - Multi-dimensional authorization binding (fails closed)", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const resolver = async (loc) => `secret-for-${loc}`;
  const broker = new CredentialBroker({ repository: repo, resolver });

  const ownerId = "owner-123";
  const agentId = "agent-abc";
  const provider = "gemini";
  const capability = "text-generation";
  const credentialId = "cred-secure";

  await broker.register(ownerId, {
    id: credentialId,
    agentId,
    provider,
    capability,
    locator: "vault://path/to/gemini"
  });

  // 1. Successful resolution
  const lease = await broker.resolve({
    ownerId,
    agentId,
    provider,
    capability,
    credentialId
  });
  assert.ok(lease);
  assert.equal(lease.getSecret(), "secret-for-vault://path/to/gemini");

  // 2. Fail closed on owner mismatch
  await assert.rejects(async () => {
    await broker.resolve({
      ownerId: "wrong-owner",
      agentId,
      provider,
      capability,
      credentialId
    });
  }, /ACCESS_DENIED/);

  // 3. Fail closed on agent mismatch
  await assert.rejects(async () => {
    await broker.resolve({
      ownerId,
      agentId: "wrong-agent",
      provider,
      capability,
      credentialId
    });
  }, /ACCESS_DENIED/);

  // 4. Fail closed on provider mismatch
  await assert.rejects(async () => {
    await broker.resolve({
      ownerId,
      agentId,
      provider: "wrong-provider",
      capability,
      credentialId
    });
  }, /ACCESS_DENIED/);

  // 5. Fail closed on capability mismatch
  await assert.rejects(async () => {
    await broker.resolve({
      ownerId,
      agentId,
      provider,
      capability: "wrong-capability",
      credentialId
    });
  }, /ACCESS_DENIED/);

  // 6. Fail closed on credentialId mismatch / non-existence
  await assert.rejects(async () => {
    await broker.resolve({
      ownerId,
      agentId,
      provider,
      capability,
      credentialId: "wrong-cred-id"
    });
  }, /ACCESS_DENIED/);
});

test("Credential Lease - Lifecyle, manual revocation, auto-expiration, serialization protection, and zeroization", async () => {
  // 1. Manual Revocation and Zeroization (Buffer secret)
  const bufSecret = Buffer.from("super-secret-buffer-material");
  const leaseBuf = new CredentialLease(bufSecret, 5000);
  assert.equal(leaseBuf.getSecret().toString(), "super-secret-buffer-material");

  leaseBuf.revoke();
  assert.throws(() => {
    leaseBuf.getSecret();
  }, /LEASE_EXPIRED_OR_REVOKED/);
  // Verify zeroization: the buffer should have been filled with 0s
  assert.equal(bufSecret.every(byte => byte === 0), true);

  // 2. Manual Revocation and Zeroization (Object secret)
  const buf1 = Buffer.from("nested-buf");
  const objSecret = {
    key1: buf1,
    key2: "nested-string"
  };
  const leaseObj = new CredentialLease(objSecret, 5000);
  leaseObj.revoke();
  assert.throws(() => {
    leaseObj.getSecret();
  }, /LEASE_EXPIRED_OR_REVOKED/);
  assert.equal(buf1.every(byte => byte === 0), true);
  assert.equal(objSecret.key2, null);

  // 3. Automatic Expiration
  const leaseShort = new CredentialLease("instant-secret", 10);
  assert.equal(leaseShort.getSecret(), "instant-secret");

  // Wait for the lease to expire
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(leaseShort.isExpired, true);
  assert.throws(() => {
    leaseShort.getSecret();
  }, /LEASE_EXPIRED_OR_REVOKED/);

  // 4. Non-serializable protection
  const leaseSafe = new CredentialLease("my-safe-secret", 5000);
  const serialized = JSON.stringify(leaseSafe);
  assert.equal(serialized, undefined);

  const wrapper = { handle: leaseSafe };
  const serializedWrapper = JSON.stringify(wrapper);
  assert.equal(serializedWrapper, "{}");
});

test("Credential Broker - Redacted logs, errors, and error sanitization", async () => {
  const repo = new TestOnlyInMemoryCredentialRepository();
  const broker = new CredentialBroker({ repository: repo });
  const ownerId = "owner-123";

  // 1. Scheme validation error does not include the raw bad locator
  await assert.rejects(async () => {
    await broker.register(ownerId, {
      id: "cred-bad",
      agentId: "agent-abc",
      provider: "gemini",
      capability: "text-generation",
      locator: "unsupported://secrets/private-api-key"
    });
  }, (err) => {
    assert.equal(err.message.includes("unsupported://secrets/private-api-key"), false);
    return true;
  });

  // 2. Check general error message sanitization
  const rawErr = "Failed to load locator vault://production-vault/secret-key-path from secret vault.";
  const cleanErr = sanitizeErrorMessage(rawErr);
  assert.equal(cleanErr.includes("vault://production-vault/secret-key-path"), false);
  assert.equal(cleanErr.includes("[REDACTED_VAULT_LOCATOR]"), true);
});

test("Credential Broker - Failure injection (Repository and Resolver failures fail closed)", async () => {
  // 1. Repository failure injection
  const failingRepo = {
    findById: async () => {
      throw new Error("CRITICAL_DATABASE_CONN_LOSS: vault://db-loc/password");
    },
    save: async () => {
      throw new Error("CRITICAL_DATABASE_CONN_LOSS");
    }
  };

  const brokerFailRepo = new CredentialBroker({ repository: failingRepo, resolver: () => {} });

  await assert.rejects(async () => {
    await brokerFailRepo.resolve({
      ownerId: "owner-1",
      agentId: "agent-1",
      provider: "gemini",
      capability: "cap-1",
      credentialId: "cred-1"
    });
  }, (err) => {
    // Assert error is sanitized and does not leak the database password vault locator
    assert.equal(err.message.includes("vault://db-loc/password"), false);
    assert.equal(err.message.includes("[REDACTED_VAULT_LOCATOR]"), true);
    return true;
  });

  // 2. Resolver failure injection
  const repo = new TestOnlyInMemoryCredentialRepository();
  const failingResolver = async () => {
    throw new Error("NETWORK_TIMEOUT: Could not contact vault://prod-secrets/api-key");
  };
  const brokerFailResolver = new CredentialBroker({ repository: repo, resolver: failingResolver });

  await repo.save({
    id: "cred-1",
    ownerId: "owner-1",
    agentId: "agent-1",
    provider: "gemini",
    capability: "cap-1",
    locator: "vault://prod-secrets/api-key"
  });

  await assert.rejects(async () => {
    await brokerFailResolver.resolve({
      ownerId: "owner-1",
      agentId: "agent-1",
      provider: "gemini",
      capability: "cap-1",
      credentialId: "cred-1"
    });
  }, (err) => {
    // Assert error is sanitized and fails closed
    assert.equal(err.message.includes("vault://prod-secrets/api-key"), false);
    assert.equal(err.message.includes("[REDACTED_VAULT_LOCATOR]"), true);
    return true;
  });
});
