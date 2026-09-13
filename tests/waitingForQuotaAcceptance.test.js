import test from "node:test";
import assert from "node:assert/strict";

import { QuotaLedger } from "../src/quotas/quotaLedger.js";
import { RecoveryContractManager } from "../src/recovery/recoveryContract.js";
import { TestOnlyInMemoryCredentialHealthRegistry } from "../src/providers/credentialHealth.js";
import { CredentialBroker } from "../src/credentials/credentialBroker.js";
import { ProviderConfigurationRouter } from "../src/providers/providerConfiguration.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import {
  persistScriptWaitingForQuota,
  resumeScriptDispatch
} from "../src/jarvis/durableScriptDispatchCheckpoint.js";

const hash = "b".repeat(64);

class TestCheckpointAdapter {
  constructor() {
    this.name = "TestCheckpointAdapter";
    this.values = new Map();
  }

  async get(id) {
    return this.values.get(id) ?? null;
  }

  async set(id, value) {
    this.values.set(id, value);
  }
}

class MockCredentialBroker {
  constructor() {
    this.credentials = new Map();
  }

  register({ ownerId, agentId, provider, capability, credentialId, secret }) {
    const key = `${ownerId}:${agentId}:${provider}:${capability}:${credentialId}`;
    this.credentials.set(key, secret);
  }

  async resolve({ ownerId, agentId, provider, capability, credentialId }) {
    if (ownerId === "owner-forged" || agentId === "agent-forged") {
      throw new Error("CROSS_AGENT_CREDENTIAL_ACCESS_DENIED");
    }
    const key = `${ownerId}:${agentId}:${provider}:${capability}:${credentialId}`;
    const lease = {
      secret: this.credentials.get(key) || "mock-secret",
      revoked: false,
      async consume(callback) {
        if (this.revoked) throw new Error("LEASE_EXPIRED_OR_REVOKED");
        return callback(this.secret);
      },
      async revoke() {
        this.revoked = true;
        this.secret = null;
      }
    };
    return lease;
  }
}

const createValidSlots = (ownerId = "owner-01", agentId = "agent-01") => [
  {
    slot: "primary",
    kind: "remote",
    provider: "gemini",
    tier: "free",
    limit: 10,
    credentialRef: { ownerId, agentId, slot: "primary", credentialId: "cred-gemini-01", capability: "story.universe_and_continuity" }
  },
  {
    slot: "secondary",
    kind: "remote",
    provider: "claude",
    tier: "free",
    limit: 10,
    credentialRef: { ownerId, agentId, slot: "secondary", credentialId: "cred-claude-01", capability: "video.ai_motion" }
  },
  {
    slot: "tertiary",
    kind: "remote",
    provider: "sarvam",
    tier: "free",
    limit: 10,
    credentialRef: { ownerId, agentId, slot: "tertiary", credentialId: "cred-sarvam-01", capability: "video.stock_assembly" }
  },
  { slot: "emergency_1", kind: "local_open_source", provider: "ollama", credentialRef: null },
  { slot: "emergency_2", kind: "local_open_source", provider: "llama3", credentialRef: null }
];

const dispatchRequest = (ownerId = "owner-01") => ({
  taskId: `dispatch-${"a".repeat(64)}`,
  agentId: "agent-01",
  payload: {
    readiness: "dispatch_ready_only",
    capability: "text_generation",
    sourcePlanId: "c".repeat(64),
    dispatchId: "d".repeat(64)
  },
  context: { ownerId, capacityPolicy: "approved_free_only" }
});

test("acceptance: exhaustion checkpoint, WAITING_FOR_QUOTA, scheduler resume, single generation", { timeout: 15000 }, async () => {
  const calls = { gemini: 0, claude: 0, sarvam: 0, ollama: 0, llama3: 0 };
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new TestOnlyInMemoryCredentialHealthRegistry();
  const credentialBroker = new MockCredentialBroker();

  // Primary is quota-exhausted until a near-future reset window (the ledger's
  // real reset mechanism). This is the "provider unavailable / quota exhausted"
  // leg; the window arriving later is the "capacity restored" leg.
  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "cred-gemini-01", {
    limit: 5,
    usageCount: 5,
    resetTimestamp: new Date(Date.now() + 50)
  });
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "cred-claude-01", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "tertiary", "sarvam", "cred-sarvam-01", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "emergency_1", "ollama", null, { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "emergency_2", "llama3", null, { limit: 5 });

  const executors = {
    gemini: async () => {
      calls.gemini += 1;
      return { output: "gemini script", evidence: { providerResponseId: "g1" } };
    },
    claude: async () => {
      calls.claude += 1;
      throw new Error("TIMEOUT");
    },
    sarvam: async () => {
      calls.sarvam += 1;
      throw new Error("429 TOO_MANY_REQUESTS");
    },
    ollama: async () => {
      calls.ollama += 1;
      throw new Error("LOCAL_DISK_FULL");
    },
    llama3: async () => {
      calls.llama3 += 1;
      throw new Error("LOCAL_MODEL_LOAD_FAILED");
    }
  };

  const router = new ProviderConfigurationRouter(executors, {
    quotaLedger,
    recoveryManager,
    credentialHealthRegistry,
    credentialBroker
  });

  // --- Phase 1: every compliant option unavailable -------------------------
  let failure;
  try {
    await router.execute({
      ownerId: "owner-01",
      agentId: "agent-01",
      taskId: "task-acceptance-1",
      slots: createValidSlots(),
      input: "episode brief"
    });
    assert.fail("expected ALL_CONFIGURED_PROVIDERS_FAILED");
  } catch (err) {
    failure = err;
  }
  assert.equal(failure.message, "ALL_CONFIGURED_PROVIDERS_FAILED");
  assert.equal(failure.attempts.length, 5);

  // Primary attempted and refused by quota, secondary and tertiary attempted
  // and failed, both open-source workers attempted and failed.
  const byProvider = new Map(failure.attempts.map((a) => [a.provider, a]));
  assert.match(byProvider.get("gemini").errorCode, /QUOTA_EXCEEDED/);
  assert.equal(byProvider.get("gemini").outcome, "skipped");
  assert.equal(byProvider.get("claude").outcome, "failed");
  assert.equal(byProvider.get("sarvam").outcome, "failed");
  assert.equal(byProvider.get("ollama").outcome, "failed");
  assert.equal(byProvider.get("llama3").outcome, "failed");

  // --- Phase 2: checkpoint committed as WAITING_FOR_QUOTA ------------------
  const store = new CheckpointStore(new TestCheckpointAdapter());
  const checkpoint = await persistScriptWaitingForQuota({
    checkpointStore: store,
    ownerId: "owner-01",
    dispatchRequest: dispatchRequest()
  });

  assert.equal(checkpoint.data.state, "WAITING_FOR_QUOTA");
  assert.equal(checkpoint.data.reasonCode, "APPROVED_FREE_CAPACITY_UNAVAILABLE");
  assert.equal(checkpoint.data.resumable, true);
  assert.equal(checkpoint.data.executionStarted, false);
  assert.equal(checkpoint.data.providerSelection, "not_performed");
  assert.equal(checkpoint.data.ownerId, "owner-01");
  assert.equal(checkpoint.data.agentId, "agent-01");
  assert.equal(checkpoint.data.capacityPolicy, "approved_free_only");

  // Re-persisting is idempotent: the checkpoint never drifts or duplicates.
  const again = await persistScriptWaitingForQuota({
    checkpointStore: store,
    ownerId: "owner-01",
    dispatchRequest: dispatchRequest()
  });
  assert.deepEqual(again, checkpoint);

  // --- Phase 3: scheduler detects restored capacity (quota reset window) ---
  // The wait crosses the primary's reset boundary: the window has arrived by
  // the time the scheduler resumes, so the next attempt is legitimately
  // "within_quota" — not a bypass of the exhausted state.
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Resume detects the durable checkpoint and its scope before any execution.
  const resumed = await resumeScriptDispatch({
    checkpointStore: store,
    ownerId: "owner-01",
    dispatchRequest: dispatchRequest()
  });
  assert.deepEqual(resumed, checkpoint);

  // --- Phase 4: execution resumes and produces the artifact exactly once ---
  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-acceptance-2",
    slots: createValidSlots(),
    input: "episode brief"
  });

  assert.equal(result.selectedProvider, "gemini");
  assert.equal(result.output, "gemini script");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, "verified_success");
  assert.equal(result.attempts[0].evidence.providerResponseId, "g1");

  // No duplicate generation: each provider's executor ran at most once across
  // the entire lifecycle, and the restored primary ran exactly once.
  assert.deepEqual(calls, { gemini: 1, claude: 1, sarvam: 1, ollama: 1, llama3: 1 });

  // The checkpoint itself never claimed execution or a provider selection:
  // resume consumers can trust it without regenerating anything.
  assert.equal(resumed.data.executionStarted, false);
  assert.equal(resumed.data.providerSelection, "not_performed");
});

test("acceptance: resume rejects scope drift so foreign owners cannot replay checkpoints", async () => {
  const store = new CheckpointStore(new TestCheckpointAdapter());
  await persistScriptWaitingForQuota({
    checkpointStore: store,
    ownerId: "owner-01",
    dispatchRequest: dispatchRequest()
  });

  await assert.rejects(
    resumeScriptDispatch({
      checkpointStore: store,
      ownerId: "owner-02",
      dispatchRequest: dispatchRequest("owner-02")
    }),
    /SCOPE_MISMATCH/
  );
});
