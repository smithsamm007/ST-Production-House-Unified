import test from "node:test";
import assert from "node:assert/strict";
import { QuotaLedger } from "../src/quotas/quotaLedger.js";
import { RecoveryContractManager } from "../src/recovery/recoveryContract.js";
import { CredentialHealthRegistry } from "../src/providers/credentialHealth.js";
import {
  ProviderConfigurationRouter,
  validateTaskProviderConfiguration,
  SUPPORTED_SLOTS
} from "../src/providers/providerConfiguration.js";

const hash = "a".repeat(64);

const createValidSlots = (agentId = "agent-01") => [
  {
    slot: "primary",
    kind: "remote",
    provider: "gemini",
    credentialRef: { agentId, slot: "primary", secretLocator: "vault://a/gemini" }
  },
  {
    slot: "secondary",
    kind: "remote",
    provider: "claude",
    credentialRef: { agentId, slot: "secondary", secretLocator: "vault://a/claude" }
  },
  {
    slot: "tertiary",
    kind: "remote",
    provider: "sarvam",
    credentialRef: { agentId, slot: "tertiary", secretLocator: "vault://a/sarvam" }
  },
  {
    slot: "emergency_1",
    kind: "local_open_source",
    provider: "ollama",
    credentialRef: null
  },
  {
    slot: "emergency_2",
    kind: "local_open_source",
    provider: "llama3",
    credentialRef: null
  }
];

// --- 1. Validation & Layout Tests ---

test("validateTaskProviderConfiguration - validates correct 5-slot layout", () => {
  const slots = createValidSlots("agent-01");
  const ordered = validateTaskProviderConfiguration("agent-01", slots);
  assert.equal(ordered.length, 5);
  assert.deepEqual(ordered.map(s => s.slot), SUPPORTED_SLOTS);
});

test("validateTaskProviderConfiguration - rejects if agentId is missing", () => {
  const slots = createValidSlots("agent-01");
  assert.throws(() => validateTaskProviderConfiguration("", slots), /AGENT_ID_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if layout has incorrect number of slots", () => {
  const slots = createValidSlots("agent-01").slice(0, 4);
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots), /EXACTLY_FIVE_PROVIDER_SLOTS_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if slot names are invalid", () => {
  const slots = createValidSlots("agent-01");
  slots[4].slot = "emergency_3"; // invalid slot name
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots), /INVALID_PROVIDER_SLOT_LAYOUT/);
});

test("validateTaskProviderConfiguration - rejects cross-agent credential sharing", () => {
  const slots = createValidSlots("agent-01");
  slots[0].credentialRef.agentId = "agent-02"; // mismatched agent
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots), /CROSS_AGENT_CREDENTIAL_ACCESS_DENIED/);
});

test("validateTaskProviderConfiguration - rejects if credential slot mismatched", () => {
  const slots = createValidSlots("agent-01");
  slots[1].credentialRef.slot = "primary"; // mismatched slot
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots), /CREDENTIAL_SLOT_MISMATCH/);
});

test("validateTaskProviderConfiguration - rejects if remote slot has no credentialRef", () => {
  const slots = createValidSlots("agent-01");
  slots[0].credentialRef = null;
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots), /REMOTE_SLOT_CONFIGURATION_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if remote slot has invalid kind", () => {
  const slots = createValidSlots("agent-01");
  slots[0].kind = "local_open_source";
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots), /REMOTE_SLOT_CONFIGURATION_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if emergency slot has credentialRef", () => {
  const slots = createValidSlots("agent-01");
  slots[3].credentialRef = { agentId: "agent-01", slot: "emergency_1", secretLocator: "vault://a/ollama" };
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots), /EMERGENCY_SLOT_MUST_BE_LOCAL_AND_KEYLESS/);
});

test("validateTaskProviderConfiguration - rejects duplicate providers across slots", () => {
  const slots = createValidSlots("agent-01");
  slots[1].provider = "gemini"; // duplicate with slot 0
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots), /PROVIDERS_MUST_BE_DISTINCT/);
});

test("validateTaskProviderConfiguration - rejects paid/overage/automatic billing configuration during validation", () => {
  const slots1 = createValidSlots("agent-01");
  slots1[0].tier = "paid";
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots1), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);

  const slots2 = createValidSlots("agent-01");
  slots2[1].isPaid = true;
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots2), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);

  const slots3 = createValidSlots("agent-01");
  slots3[2].billingModel = "automatic";
  assert.throws(() => validateTaskProviderConfiguration("agent-01", slots3), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);
});


// --- 2. Execution, Routing & Failover Tests ---

test("ProviderConfigurationRouter - executes and routes successfully to primary", async () => {
  const quotaLedger = new QuotaLedger();
  // Configure quotas
  quotaLedger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });

  const executors = {
    gemini: async () => ({ output: "gemini success", evidence: { providerResponseId: "g1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger });
  const result = await router.execute({
    agentId: "agent-01",
    taskId: "task-1",
    slots: createValidSlots("agent-01"),
    input: "test prompt"
  });

  assert.equal(result.selectedProvider, "gemini");
  assert.equal(result.output, "gemini success");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, "verified_success");
});

test("ProviderConfigurationRouter - fails over through remote slots to emergency_1 and emergency_2", async () => {
  const quotaLedger = new QuotaLedger();
  // Configure quotas for all slots
  quotaLedger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 5 });
  quotaLedger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });
  quotaLedger.configureQuota("agent-01", "tertiary", "sarvam", "vault://a/sarvam", { limit: 5 });
  quotaLedger.configureQuota("agent-01", "emergency_1", "ollama", null, { limit: 5 });
  quotaLedger.configureQuota("agent-01", "emergency_2", "llama3", null, { limit: 5 });

  const executors = {
    gemini: async () => { throw new Error("TIMEOUT"); },
    claude: async () => { throw new Error("429 TOO_MANY_REQUESTS"); },
    sarvam: async () => { throw new Error("503 SERVICE_UNAVAILABLE"); },
    ollama: async () => { throw new Error("LOCAL_DISK_FULL"); },
    llama3: async () => ({ output: "local llama success", evidence: { artifactSha256: hash } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger });
  const result = await router.execute({
    agentId: "agent-01",
    taskId: "task-2",
    slots: createValidSlots("agent-01"),
    input: "prompt"
  });

  assert.equal(result.selectedProvider, "llama3");
  assert.equal(result.attempts.length, 5);
  assert.equal(result.attempts[4].outcome, "verified_success");
});

test("ProviderConfigurationRouter - complete bounded failover throwing when all 5 slots fail", async () => {
  const quotaLedger = new QuotaLedger();
  quotaLedger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 5 });
  quotaLedger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });
  quotaLedger.configureQuota("agent-01", "tertiary", "sarvam", "vault://a/sarvam", { limit: 5 });
  quotaLedger.configureQuota("agent-01", "emergency_1", "ollama", null, { limit: 5 });
  quotaLedger.configureQuota("agent-01", "emergency_2", "llama3", null, { limit: 5 });

  const executors = {
    gemini: async () => { throw new Error("FAIL"); },
    claude: async () => { throw new Error("FAIL"); },
    sarvam: async () => { throw new Error("FAIL"); },
    ollama: async () => { throw new Error("FAIL"); },
    llama3: async () => { throw new Error("FAIL"); }
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger });

  await assert.rejects(
    () => router.execute({
      agentId: "agent-01",
      taskId: "task-3",
      slots: createValidSlots("agent-01"),
      input: "prompt"
    }),
    (err) => {
      assert.equal(err.message, "ALL_CONFIGURED_PROVIDERS_FAILED");
      assert.equal(err.attempts.length, 5);
      assert.equal(err.attempts.every(a => a.outcome === "failed"), true);
      return true;
    }
  );
});


// --- 3. Fail-Closed on Missing Quota / Expired Trial Tests ---

test("ProviderConfigurationRouter - fails closed on missing quota configuration", async () => {
  const quotaLedger = new QuotaLedger();
  // Do NOT configure quota for primary slot (gemini)
  quotaLedger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });

  const executors = {
    gemini: async () => ({ output: "gemini", evidence: { providerResponseId: "g1" } }),
    claude: async () => ({ output: "claude success", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger });
  const result = await router.execute({
    agentId: "agent-01",
    taskId: "task-4",
    slots: createValidSlots("agent-01"),
    input: "prompt"
  });

  // Gemini should have been skipped due to "quota_not_configured"
  assert.equal(result.selectedProvider, "claude");
  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.outcome, "skipped");
  assert.equal(geminiAttempt.errorCode.includes("quota_not_configured"), true);
});

test("ProviderConfigurationRouter - fails closed on expired trial quota", async () => {
  const quotaLedger = new QuotaLedger();
  const pastDate = new Date(Date.now() - 5000).toISOString();

  // Primary slot (gemini) has an expired trial
  quotaLedger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", {
    limit: 10,
    trialExpiryTimestamp: pastDate,
    tier: "trial"
  });
  quotaLedger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });

  const executors = {
    gemini: async () => ({ output: "gemini", evidence: { providerResponseId: "g1" } }),
    claude: async () => ({ output: "claude success", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger });
  const result = await router.execute({
    agentId: "agent-01",
    taskId: "task-5",
    slots: createValidSlots("agent-01"),
    input: "prompt"
  });

  // Gemini should be skipped due to "trial_expired"
  assert.equal(result.selectedProvider, "claude");
  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.outcome, "skipped");
  assert.equal(geminiAttempt.errorCode.includes("trial_expired"), true);
});


// --- 4. Unhealthy Credentials Failure Closed ---

test("ProviderConfigurationRouter - fails closed on unhealthy credentials", async () => {
  const quotaLedger = new QuotaLedger();
  const healthRegistry = new CredentialHealthRegistry();

  quotaLedger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });
  quotaLedger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", { limit: 10 });

  // Mark Gemini's credential as unhealthy
  healthRegistry.markUnhealthy("vault://a/gemini");

  const executors = {
    gemini: async () => ({ output: "gemini", evidence: { providerResponseId: "g1" } }),
    claude: async () => ({ output: "claude success", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, credentialHealthRegistry: healthRegistry });
  const result = await router.execute({
    agentId: "agent-01",
    taskId: "task-6",
    slots: createValidSlots("agent-01"),
    input: "prompt"
  });

  // Gemini is skipped because credential is unhealthy
  assert.equal(result.selectedProvider, "claude");
  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.outcome, "skipped");
  assert.equal(geminiAttempt.errorCode, "UNHEALTHY_CREDENTIAL");

  // Re-enable/mark healthy
  healthRegistry.markHealthy("vault://a/gemini");
  const result2 = await router.execute({
    agentId: "agent-01",
    taskId: "task-7",
    slots: createValidSlots("agent-01"),
    input: "prompt"
  });
  assert.equal(result2.selectedProvider, "gemini");
});


// --- 5. Circuit Breaker / Cooldown Failures Closed ---

test("ProviderConfigurationRouter - fails closed on cooldown / circuit-breaker OPEN", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager({ cooldownDurationMs: 1000, maxConsecutiveFailures: 1 });

  quotaLedger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });
  quotaLedger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", { limit: 10 });

  const executors = {
    gemini: async () => { throw new Error("TRANSIENT TIMEOUT"); },
    claude: async () => ({ output: "claude success", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager });

  // Run first execution: Gemini fails and gets placed on circuit-breaker cooldown
  const result1 = await router.execute({
    agentId: "agent-01",
    taskId: "task-8",
    slots: createValidSlots("agent-01"),
    input: "prompt"
  });
  assert.equal(result1.selectedProvider, "claude");

  // Run second execution: Gemini should be skipped immediately due to "PROVIDER_IN_COOLDOWN"
  const result2 = await router.execute({
    agentId: "agent-01",
    taskId: "task-9",
    slots: createValidSlots("agent-01"),
    input: "prompt"
  });
  assert.equal(result2.selectedProvider, "claude");
  const geminiAttempt2 = result2.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt2.outcome, "skipped");
  assert.equal(geminiAttempt2.errorCode, "PROVIDER_IN_COOLDOWN");
});


// --- 6. Deterministic Isolation and Secret Protection ---

test("ProviderConfigurationRouter - state is isolated by agent, slot, provider, and locator", async () => {
  const ql = new QuotaLedger();
  // Configure isolation key elements
  ql.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 1 });
  ql.configureQuota("agent-02", "primary", "gemini", "vault://a/gemini", { limit: 5 });

  const q1 = ql.getQuota("agent-01", "primary", "gemini", "vault://a/gemini");
  const q2 = ql.getQuota("agent-02", "primary", "gemini", "vault://a/gemini");

  assert.notEqual(q1, q2);
  assert.equal(q1.limit, 1);
  assert.equal(q2.limit, 5);
});

test("ProviderConfigurationRouter - never leaks or resolves plaintext credentials in logs or errors", async () => {
  const quotaLedger = new QuotaLedger();
  quotaLedger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 5 });
  quotaLedger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });

  const executors = {
    // Throws an error containing an API key
    gemini: async () => { throw new Error("FAIL with api_key=super_secret_value"); },
    claude: async () => ({ output: "claude", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger });
  const result = await router.execute({
    agentId: "agent-01",
    taskId: "task-10",
    slots: createValidSlots("agent-01"),
    input: "prompt"
  });

  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.errorCode.includes("super_secret_value"), false);
  assert.equal(geminiAttempt.errorCode.includes("api_key:[REDACTED]"), true);
});
