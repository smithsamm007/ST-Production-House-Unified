import test from "node:test";
import assert from "node:assert/strict";
import { runProviderSmokeTest, ProviderSmokeTestError } from "../src/providers/providerSmokeTest.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

function buildValidSlots(agentId = "agent-01") {
  return [
    { slot: "primary", kind: "remote", provider: "p_remote_1", credentialRef: { agentId, slot: "primary", secretLocator: "vault://secret1" } },
    { slot: "secondary", kind: "remote", provider: "p_remote_2", credentialRef: { agentId, slot: "secondary", secretLocator: "vault://secret2" } },
    { slot: "tertiary", kind: "remote", provider: "p_remote_3", credentialRef: { agentId, slot: "tertiary", secretLocator: "opaque://secret3" } },
    { slot: "open_source_emergency", kind: "local_open_source", provider: "p_local_fallback", credentialRef: null }
  ];
}

test("provider smoke test: succeeds on primary remote provider with genuine receipt and records evidence", async () => {
  const ledger = new EvidenceLedger();
  const slots = buildValidSlots("agent-01");

  const executor = async ({ slot, provider }) => {
    if (slot === "primary") {
      return {
        providerResponseId: "pr_resp_12345",
        providerResponseSha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        output: "SMOKE_OK"
      };
    }
    throw new Error("UNEXPECTED_CALL");
  };

  const result = await runProviderSmokeTest({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-smoke-01",
    slots,
    executor,
    evidenceLedger: ledger
  });

  assert.equal(result.status, "verified_success");
  assert.equal(result.selectedProvider, "p_remote_1");
  assert.equal(result.selectedSlot, "primary");
  assert.equal(result.receipt.providerResponseId, "pr_resp_12345");
  assert.equal(result.attempts.length, 1);

  const events = ledger.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "provider_smoke_test");
  assert.equal(events[0].payload.selectedProvider, "p_remote_1");
});

test("provider smoke test: fails over to local emergency provider when remote providers fail", async () => {
  const ledger = new EvidenceLedger();
  const slots = buildValidSlots("agent-01");

  const executor = async ({ kind }) => {
    if (kind === "remote") {
      throw new Error("REMOTE_UNAVAILABLE");
    }
    return {
      artifactSha256: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
      output: "LOCAL_EMERGENCY_OK"
    };
  };

  const result = await runProviderSmokeTest({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-smoke-02",
    slots,
    executor,
    evidenceLedger: ledger
  });

  assert.equal(result.status, "verified_success");
  assert.equal(result.selectedProvider, "p_local_fallback");
  assert.equal(result.selectedSlot, "open_source_emergency");
  assert.equal(result.attempts.length, 4);
  assert.equal(result.attempts[0].outcome, "failed");
  assert.equal(result.attempts[3].outcome, "verified_success");
});

test("provider smoke test: fails closed when all configured providers fail", async () => {
  const slots = buildValidSlots("agent-01");
  const executor = async () => {
    throw new Error("PROVIDER_DOWN");
  };

  await assert.rejects(
    async () => {
      await runProviderSmokeTest({
        ownerId: "owner-01",
        agentId: "agent-01",
        taskId: "task-smoke-03",
        slots,
        executor
      });
    },
    (err) => {
      assert.equal(err.code, "ALL_PROVIDERS_FAILED");
      assert.equal(err.details.attempts.length, 4);
      return true;
    }
  );
});

test("provider smoke test: rejects invalid locator scheme", async () => {
  const slots = buildValidSlots("agent-01");
  slots[0].credentialRef.secretLocator = "plaintext-api-key-12345";

  await assert.rejects(
    async () => {
      await runProviderSmokeTest({
        ownerId: "owner-01",
        agentId: "agent-01",
        slots,
        executor: async () => ({})
      });
    },
    (err) => {
      assert.equal(err.code, "INVALID_SECRET_LOCATOR");
      return true;
    }
  );
});

test("provider smoke test: rejects internal agent name in input metadata", async () => {
  const slots = buildValidSlots("agent-01");

  await assert.rejects(
    async () => {
      await runProviderSmokeTest({
        ownerId: "JARVIS",
        agentId: "agent-01",
        slots,
        executor: async () => ({})
      });
    },
    (err) => {
      assert.equal(err.code, "AGENT_NAME_LEAKAGE_DENIED");
      return true;
    }
  );
});
