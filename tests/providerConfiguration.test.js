import test from "node:test";
import assert from "node:assert/strict";
import { QuotaLedger } from "../src/quotas/quotaLedger.js";
import { RecoveryContractManager } from "../src/recovery/recoveryContract.js";
import { CredentialHealthRegistry } from "../src/providers/credentialHealth.js";
import {
  ProviderConfigurationRouter,
  validateTaskProviderConfiguration,
  SUPPORTED_SLOTS,
  getEnumErrorCode
} from "../src/providers/providerConfiguration.js";

const hash = "a".repeat(64);

const createValidSlots = (ownerId = "owner-01", agentId = "agent-01") => [
  {
    slot: "primary",
    kind: "remote",
    provider: "gemini",
    tier: "free",
    limit: 10,
    credentialRef: { ownerId, agentId, slot: "primary", secretLocator: "vault://a/gemini" }
  },
  {
    slot: "secondary",
    kind: "remote",
    provider: "claude",
    tier: "free",
    limit: 10,
    credentialRef: { ownerId, agentId, slot: "secondary", secretLocator: "vault://a/claude" }
  },
  {
    slot: "tertiary",
    kind: "remote",
    provider: "sarvam",
    tier: "free",
    limit: 10,
    credentialRef: { ownerId, agentId, slot: "tertiary", secretLocator: "vault://a/sarvam" }
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
  const slots = createValidSlots("owner-01", "agent-01");
  const ordered = validateTaskProviderConfiguration("owner-01", "agent-01", slots);
  assert.equal(ordered.length, 5);
  assert.deepEqual(ordered.map(s => s.slot), SUPPORTED_SLOTS);
});

test("validateTaskProviderConfiguration - rejects if ownerId is missing", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  assert.throws(() => validateTaskProviderConfiguration("", "agent-01", slots), /OWNER_ID_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if agentId is missing", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "", slots), /AGENT_ID_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if layout has incorrect number of slots", () => {
  const slots = createValidSlots("owner-01", "agent-01").slice(0, 4);
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /EXACTLY_FIVE_PROVIDER_SLOTS_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if slot names are invalid", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[4].slot = "emergency_3"; // invalid slot name
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /INVALID_PROVIDER_SLOT_LAYOUT/);
});

test("validateTaskProviderConfiguration - rejects cross-owner credential access", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[0].credentialRef.ownerId = "owner-02"; // mismatched owner
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /CROSS_OWNER_CREDENTIAL_ACCESS_DENIED/);
});

test("validateTaskProviderConfiguration - rejects cross-agent credential sharing", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[0].credentialRef.agentId = "agent-02"; // mismatched agent
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /CROSS_AGENT_CREDENTIAL_ACCESS_DENIED/);
});

test("validateTaskProviderConfiguration - rejects if credential slot mismatched", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[1].credentialRef.slot = "primary"; // mismatched slot
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /CREDENTIAL_SLOT_MISMATCH/);
});

test("validateTaskProviderConfiguration - rejects if remote slot has no credentialRef", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[0].credentialRef = null;
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /REMOTE_SLOT_CONFIGURATION_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if remote slot has invalid kind", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[0].kind = "local_open_source";
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /REMOTE_SLOT_CONFIGURATION_REQUIRED/);
});

test("validateTaskProviderConfiguration - rejects if emergency slot has credentialRef", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[3].credentialRef = { ownerId: "owner-01", agentId: "agent-01", slot: "emergency_1", secretLocator: "vault://a/ollama" };
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /EMERGENCY_SLOT_MUST_BE_LOCAL_AND_KEYLESS/);
});

test("validateTaskProviderConfiguration - rejects duplicate providers across slots", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[1].provider = "gemini"; // duplicate with slot 0
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /PROVIDERS_MUST_BE_DISTINCT/);
});

test("validateTaskProviderConfiguration - rejects paid/overage/automatic billing configuration during validation", () => {
  const slots1 = createValidSlots("owner-01", "agent-01");
  slots1[0].tier = "paid";
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots1), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);

  const slots2 = createValidSlots("owner-01", "agent-01");
  slots2[1].isPaid = true;
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots2), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);

  const slots3 = createValidSlots("owner-01", "agent-01");
  slots3[2].billingModel = "automatic";
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots3), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);
});


// --- 2. Advanced Security & Error-Handling Tests (PR Feedback) ---

test("validateTaskProviderConfiguration - rejects missing or unknown tier metadata", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  delete slots[0].tier; // missing tier metadata
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);

  const slots2 = createValidSlots("owner-01", "agent-01");
  slots2[0].tier = "unknown_premium_tier"; // unknown tier metadata
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots2), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);
});

test("validateTaskProviderConfiguration - rejects missing limit metadata", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  delete slots[0].limit; // missing quota metadata
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);
});

test("validateTaskProviderConfiguration - rejects invalid trial expiry metadata", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[0].tier = "trial";
  delete slots[0].trialExpiryTimestamp; // missing trial expiry metadata
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);

  const slots2 = createValidSlots("owner-01", "agent-01");
  slots2[0].tier = "trial";
  slots2[0].trialExpiryTimestamp = "invalid-date-string"; // invalid trial expiry metadata
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots2), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);
});

test("validateTaskProviderConfiguration - rejects conflicting billing flags", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[0].tier = "free";
  slots[0].isPaid = true; // conflicting flag
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);
});

test("validateTaskProviderConfiguration - rejects cross-owner access", () => {
  const slots = createValidSlots("owner-01", "agent-01");
  slots[0].credentialRef.ownerId = "owner-different"; // cross-owner
  assert.throws(() => validateTaskProviderConfiguration("owner-01", "agent-01", slots), /CROSS_OWNER_CREDENTIAL_ACCESS_DENIED/);
});

test("ProviderConfigurationRouter Constructor - default-construction fails securely", () => {
  // Reliance on default constructor with process-local fallbacks must be rejected in production
  assert.throws(() => new ProviderConfigurationRouter({ gemini: async () => {} }), /QUOTA_LEDGER_REQUIRED/);
  assert.throws(() => new ProviderConfigurationRouter({ gemini: async () => {} }, { quotaLedger: new QuotaLedger() }), /RECOVERY_MANAGER_REQUIRED/);
});

test("ProviderConfigurationRouter Constructor - rejects unknown constructor options", () => {
  assert.throws(() => new ProviderConfigurationRouter(
    { gemini: async () => {} },
    {
      quotaLedger: new QuotaLedger(),
      recoveryManager: new RecoveryContractManager(),
      credentialHealthRegistry: new CredentialHealthRegistry(),
      unknownOption: "someValue"
    }
  ), /UNKNOWN_CONSTRUCTOR_OPTION/);
});

test("ProviderConfigurationRouter Constructor - rejects durable-interface failure", () => {
  // Mock an invalid quotaLedger interface
  const invalidQuotaLedger = { reserve: "not-a-function", commit: () => {}, release: () => {} };
  assert.throws(() => new ProviderConfigurationRouter(
    { gemini: async () => {} },
    {
      quotaLedger: invalidQuotaLedger,
      recoveryManager: new RecoveryContractManager(),
      credentialHealthRegistry: new CredentialHealthRegistry()
    }
  ), /INVALID_QUOTA_LEDGER_INTERFACE/);
});

test("ProviderConfigurationRouter - evidence secret injection prevention", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new CredentialHealthRegistry();

  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });

  const executors = {
    // Attempt to inject a secret key inside providerResponseId
    gemini: async () => ({
      output: "success",
      evidence: { providerResponseId: "vault://super-secret-key-path", rawSecret: "plaintext_api_key_123" }
    })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });
  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-99",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "test"
  });

  // Verify only allowed fields were sanitizely copied, preventing blind copy of secrets
  const attemptEvidence = result.attempts[0].evidence;
  assert.equal(attemptEvidence.rawSecret, undefined, "rawSecret must be omitted from attempts log");
  assert.equal(attemptEvidence.providerResponseId, "vault://super-secret-key-path");
});

test("ProviderConfigurationRouter - commit failure must trigger reservation release and fail closed safely", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new CredentialHealthRegistry();

  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "vault://a/claude", { limit: 10 });

  // Stub/Mock commit to throw an error only for gemini
  quotaLedger.commit = async (reservation) => {
    if (reservation.provider === "gemini") {
      throw new Error("DURABLE_COMMIT_FAILED");
    }
    reservation.status = "committed";
  };

  // We spy on the release call to ensure it is triggered during exception handling to avoid quota leakage
  let releaseCalled = false;
  const originalRelease = quotaLedger.release.bind(quotaLedger);
  quotaLedger.release = async (res) => {
    releaseCalled = true;
    return originalRelease(res);
  };

  const executors = {
    gemini: async () => ({ output: "gemini", evidence: { providerResponseId: "g1" } }),
    claude: async () => ({ output: "claude", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });

  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-cc",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "test"
  });

  // Since Gemini's commit fails, we release the quota, record failure and failover to Claude
  assert.equal(result.selectedProvider, "claude");
  assert.equal(releaseCalled, true, "Release must be called to avoid quota leakage");
  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.outcome, "failed");
  assert.equal(geminiAttempt.errorCode, "COMMIT_OR_RECOVERY_FAILURE");
});


// --- 3. Original Execution, Routing & Failover Tests (Adapted to ownerId and injected constructor dependencies) ---

test("ProviderConfigurationRouter - executes and routes successfully to primary", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new CredentialHealthRegistry();

  // Configure quotas under ownerId:agentId scoped isolation key
  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });

  const executors = {
    gemini: async ({ handle }) => {
      assert.equal(handle.startsWith("lease_handle_"), true, "Must receive authorized lease handle, not secretLocator");
      return { output: "gemini success", evidence: { providerResponseId: "g1" } };
    }
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });
  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-1",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "test prompt"
  });

  assert.equal(result.selectedProvider, "gemini");
  assert.equal(result.output, "gemini success");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, "verified_success");
});

test("ProviderConfigurationRouter - fails over through remote slots to emergency_1 and emergency_2", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new CredentialHealthRegistry();

  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "tertiary", "sarvam", "vault://a/sarvam", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "emergency_1", "ollama", null, { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "emergency_2", "llama3", null, { limit: 5 });

  const executors = {
    gemini: async () => { throw new Error("TIMEOUT"); },
    claude: async () => { throw new Error("429 TOO_MANY_REQUESTS"); },
    sarvam: async () => { throw new Error("503 SERVICE_UNAVAILABLE"); },
    ollama: async () => { throw new Error("LOCAL_DISK_FULL"); },
    llama3: async () => ({ output: "local llama success", evidence: { artifactSha256: hash } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });
  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-2",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "prompt"
  });

  assert.equal(result.selectedProvider, "llama3");
  assert.equal(result.attempts.length, 5);
  assert.equal(result.attempts[4].outcome, "verified_success");
});

test("ProviderConfigurationRouter - complete bounded failover throwing when all 5 slots fail", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new CredentialHealthRegistry();

  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "tertiary", "sarvam", "vault://a/sarvam", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "emergency_1", "ollama", null, { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "emergency_2", "llama3", null, { limit: 5 });

  const executors = {
    gemini: async () => { throw new Error("FAIL"); },
    claude: async () => { throw new Error("FAIL"); },
    sarvam: async () => { throw new Error("FAIL"); },
    ollama: async () => { throw new Error("FAIL"); },
    llama3: async () => { throw new Error("FAIL"); }
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });

  await assert.rejects(
    () => router.execute({
      ownerId: "owner-01",
      agentId: "agent-01",
      taskId: "task-3",
      slots: createValidSlots("owner-01", "agent-01"),
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


// --- 4. Fail-Closed on Missing Quota / Expired Trial Tests ---

test("ProviderConfigurationRouter - fails closed on missing quota configuration", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new CredentialHealthRegistry();

  // Do NOT configure quota for primary slot (gemini)
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });

  const executors = {
    gemini: async () => ({ output: "gemini", evidence: { providerResponseId: "g1" } }),
    claude: async () => ({ output: "claude success", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });
  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-4",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "prompt"
  });

  assert.equal(result.selectedProvider, "claude");
  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.outcome, "skipped");
  assert.equal(geminiAttempt.errorCode, "QUOTA_NOT_CONFIGURED");
});

test("ProviderConfigurationRouter - fails closed on expired trial quota", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new CredentialHealthRegistry();
  const pastDate = new Date(Date.now() - 5000).toISOString();

  // Primary slot (gemini) has an expired trial
  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", {
    limit: 10,
    trialExpiryTimestamp: pastDate,
    tier: "trial"
  });
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });

  const executors = {
    gemini: async () => ({ output: "gemini", evidence: { providerResponseId: "g1" } }),
    claude: async () => ({ output: "claude success", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });
  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-5",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "prompt"
  });

  assert.equal(result.selectedProvider, "claude");
  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.outcome, "skipped");
  assert.equal(geminiAttempt.errorCode, "TRIAL_EXPIRED");
});


// --- 5. Unhealthy Credentials Failure Closed ---

test("ProviderConfigurationRouter - fails closed on unhealthy credentials", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const healthRegistry = new CredentialHealthRegistry();

  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "vault://a/claude", { limit: 10 });

  // Mark Gemini's credential as unhealthy
  healthRegistry.markUnhealthy("vault://a/gemini");

  const executors = {
    gemini: async () => ({ output: "gemini", evidence: { providerResponseId: "g1" } }),
    claude: async () => ({ output: "claude success", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry: healthRegistry });
  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-6",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "prompt"
  });

  assert.equal(result.selectedProvider, "claude");
  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.outcome, "skipped");
  assert.equal(geminiAttempt.errorCode, "UNHEALTHY_CREDENTIAL");
});


// --- 6. Circuit Breaker / Cooldown Failures Closed ---

test("ProviderConfigurationRouter - fails closed on cooldown / circuit-breaker OPEN", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager({ cooldownDurationMs: 1000, maxConsecutiveFailures: 1 });
  const credentialHealthRegistry = new CredentialHealthRegistry();

  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "vault://a/claude", { limit: 10 });

  const executors = {
    gemini: async () => { throw new Error("TRANSIENT TIMEOUT"); },
    claude: async () => ({ output: "claude success", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });

  // Run first execution: Gemini fails and gets placed on circuit-breaker cooldown
  const result1 = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-8",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "prompt"
  });
  assert.equal(result1.selectedProvider, "claude");

  // Run second execution: Gemini should be skipped immediately due to "PROVIDER_IN_COOLDOWN"
  const result2 = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-9",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "prompt"
  });
  assert.equal(result2.selectedProvider, "claude");
  const geminiAttempt2 = result2.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt2.outcome, "skipped");
  assert.equal(geminiAttempt2.errorCode, "PROVIDER_IN_COOLDOWN");
});


// --- 7. Deterministic Isolation and Secret Protection ---

test("ProviderConfigurationRouter - state is isolated by owner, agent, slot, provider, and locator", async () => {
  const ql = new QuotaLedger();
  // Configure isolation key elements
  ql.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 1 });
  ql.configureQuota("owner-02:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 5 });

  const q1 = ql.getQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini");
  const q2 = ql.getQuota("owner-02:agent-01", "primary", "gemini", "vault://a/gemini");

  assert.notEqual(q1, q2);
  assert.equal(q1.limit, 1);
  assert.equal(q2.limit, 5);
});

test("ProviderConfigurationRouter - never leaks or resolves plaintext credentials in logs or errors", async () => {
  const quotaLedger = new QuotaLedger();
  const recoveryManager = new RecoveryContractManager();
  const credentialHealthRegistry = new CredentialHealthRegistry();

  quotaLedger.configureQuota("owner-01:agent-01", "primary", "gemini", "vault://a/gemini", { limit: 5 });
  quotaLedger.configureQuota("owner-01:agent-01", "secondary", "claude", "vault://a/claude", { limit: 5 });

  const executors = {
    gemini: async () => { throw new Error("FAIL with api_key=super_secret_value"); },
    claude: async () => ({ output: "claude", evidence: { providerResponseId: "c1" } })
  };

  const router = new ProviderConfigurationRouter(executors, { quotaLedger, recoveryManager, credentialHealthRegistry });
  const result = await router.execute({
    ownerId: "owner-01",
    agentId: "agent-01",
    taskId: "task-10",
    slots: createValidSlots("owner-01", "agent-01"),
    input: "prompt"
  });

  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.errorCode, "PROVIDER_EXECUTION_FAILED");
  // Ensure we didn't store raw api key inside attempts or errorCode
  assert.equal(JSON.stringify(geminiAttempt).includes("super_secret_value"), false);
});
