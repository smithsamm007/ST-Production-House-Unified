import test from "node:test";
import assert from "node:assert/strict";
import { TestOnlyInMemoryQuotaLedger } from "../src/quotas/quotaLedger.js";
import { classifyError, sanitizeErrorMessage, TestOnlyInMemoryRecoveryContractManager } from "../src/recovery/recoveryContract.js";
import { ZeroCostRouter } from "../src/recovery/zeroCostRouter.js";

const hash = "a".repeat(64);
const baseSlots = [
  { slot: "primary", kind: "remote", provider: "gemini",
    credentialRef: { agentId: "agent-01", slot: "primary", secretLocator: "vault://a/gemini" } },
  { slot: "secondary", kind: "remote", provider: "claude",
    credentialRef: { agentId: "agent-01", slot: "secondary", secretLocator: "vault://a/claude" } },
  { slot: "tertiary", kind: "remote", provider: "sarvam",
    credentialRef: { agentId: "agent-01", slot: "tertiary", secretLocator: "vault://a/sarvam" } },
  { slot: "open_source_emergency", kind: "local_open_source", provider: "ollama",
    credentialRef: null }
];

test("Retry Taxonomy - classifies transient vs fatal, unknown error is fatal", () => {
  assert.equal(classifyError(new Error("RATE_LIMIT")), "transient");
  assert.equal(classifyError(new Error("429 Too Many Requests")), "transient");
  assert.equal(classifyError(new Error("TIMEOUT")), "transient");
  assert.equal(classifyError(new Error("ETIMEDOUT")), "transient");
  assert.equal(classifyError(new Error("503 Service Unavailable")), "transient");

  // Unknown errors must NOT default to transient retry; they are fatal!
  assert.equal(classifyError(new Error("SOME_RANDOM_PROVIDER_UNKNOWN_ERROR")), "fatal");
  assert.equal(classifyError(new Error("DB_DOWN")), "fatal");
  assert.equal(classifyError(new Error("ACCESS_DENIED")), "fatal");
});

test("Error Sanitization - strips out secrets and vault locators", () => {
  const secretErr = "Failed because API key api_key=xyz123abc is invalid";
  const sanitized1 = sanitizeErrorMessage(secretErr);
  assert.equal(sanitized1.includes("xyz123abc"), false, "API key value should be redacted");
  assert.equal(sanitized1.includes("api_key:[REDACTED]"), true);

  const vaultErr = "Could not fetch vault://secrets/claude from key vault";
  const sanitized2 = sanitizeErrorMessage(vaultErr);
  assert.equal(sanitized2.includes("vault://"), false, "Vault locators should be redacted");
  assert.equal(sanitized2.includes("[REDACTED_VAULT_LOCATOR]"), true);
});

test("Quota Ledger - configure, check, and fail-closed", () => {
  const ledger = new TestOnlyInMemoryQuotaLedger();

  // Fail closed for unconfigured quota
  const checkUnconfigured = ledger.checkQuota("agent-01", "primary", "gemini", "vault://a/gemini");
  assert.equal(checkUnconfigured.allowed, false);
  assert.equal(checkUnconfigured.reason, "quota_not_configured");

  // Validate limits (rejection of Infinity)
  assert.throws(() => {
    ledger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: Infinity });
  }, /INVALID_LIMIT/);

  assert.throws(() => {
    ledger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: -5 });
  }, /INVALID_LIMIT/);

  // Configure correct quota
  ledger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 2 });

  let check = ledger.checkQuota("agent-01", "primary", "gemini", "vault://a/gemini");
  assert.equal(check.allowed, true);
});

test("Quota Ledger - state isolation by agent, slot, provider, and credential locator", () => {
  const ledger = new TestOnlyInMemoryQuotaLedger();

  // Configure quota for agent-01 on gemini with primary slot and vault://a/gemini
  ledger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 1 });
  // Configure quota for agent-02 with identical slot/provider but different agent
  ledger.configureQuota("agent-02", "primary", "gemini", "vault://a/gemini", { limit: 10 });
  // Configure quota for agent-01 but different credential locator
  ledger.configureQuota("agent-01", "primary", "gemini", "vault://other/gemini", { limit: 5 });

  const q1 = ledger.getQuota("agent-01", "primary", "gemini", "vault://a/gemini");
  const q2 = ledger.getQuota("agent-02", "primary", "gemini", "vault://a/gemini");
  const q3 = ledger.getQuota("agent-01", "primary", "gemini", "vault://other/gemini");

  assert.notEqual(q1, q2);
  assert.notEqual(q1, q3);
  assert.equal(q1.limit, 1);
  assert.equal(q2.limit, 10);
  assert.equal(q3.limit, 5);
});

test("Quota Ledger - trial expiry and reset behaviors", () => {
  const ledger = new TestOnlyInMemoryQuotaLedger();
  const pastDate = new Date(Date.now() - 1000).toISOString();
  const futureDate = new Date(Date.now() + 100000).toISOString();

  // 1. Reset timestamp
  ledger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", {
    limit: 1, usageCount: 1, resetTimestamp: pastDate
  });
  // Should auto-reset usageCount and allow access
  const checkReset = ledger.checkQuota("agent-01", "primary", "gemini", "vault://a/gemini");
  assert.equal(checkReset.allowed, true);
  assert.equal(ledger.getQuota("agent-01", "primary", "gemini", "vault://a/gemini").usageCount, 0);

  // 2. Trial expiry
  ledger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", {
    limit: 10, trialExpiryTimestamp: pastDate, tier: "trial"
  });
  const checkExpiry = ledger.checkQuota("agent-01", "secondary", "claude", "vault://a/claude");
  assert.equal(checkExpiry.allowed, false);
  assert.equal(checkExpiry.reason, "trial_expired");
});

test("Quota Ledger - race condition / concurrency protection (atomic reservation)", async () => {
  const ledger = new TestOnlyInMemoryQuotaLedger();
  ledger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 2 });

  // Make 3 parallel reservation attempts. Since limit is 2, only 2 must succeed!
  const p1 = ledger.reserve("agent-01", "primary", "gemini", "vault://a/gemini");
  const p2 = ledger.reserve("agent-01", "primary", "gemini", "vault://a/gemini");
  const p3 = ledger.reserve("agent-01", "primary", "gemini", "vault://a/gemini");

  const results = await Promise.allSettled([p1, p2, p3]);
  const succeeded = results.filter(r => r.status === "fulfilled");
  const failed = results.filter(r => r.status === "rejected");

  assert.equal(succeeded.length, 2, "Only 2 parallel reservations should succeed");
  assert.equal(failed.length, 1, "The third parallel reservation should fail/be rejected");
  assert.equal(failed[0].reason.message.includes("quota_exceeded"), true);

  // Releasing one reservation allows a new one to be reserved
  const reservationToRelease = succeeded[0].value;
  await ledger.release(reservationToRelease);

  const p4 = await ledger.reserve("agent-01", "primary", "gemini", "vault://a/gemini");
  assert.equal(p4.status, "reserved");
});

test("Circuit Breaker - applies to emergency open-source routes", () => {
  const recovery = new TestOnlyInMemoryRecoveryContractManager({ cooldownDurationMs: 50, maxConsecutiveFailures: 1 });

  // Ollama emergency route
  assert.equal(recovery.isHealthy("agent-01", "open_source_emergency", "ollama", null), true);

  // Record a failure -> trips circuit breaker immediately
  recovery.recordFailure("agent-01", "open_source_emergency", "ollama", null, new Error("TIMEOUT"));
  assert.equal(recovery.isHealthy("agent-01", "open_source_emergency", "ollama", null), false);

  // Wait for cooldown
  const start = Date.now();
  while (Date.now() - start < 100) {}

  // Check health -> transitions to HALF_OPEN
  assert.equal(recovery.isHealthy("agent-01", "open_source_emergency", "ollama", null), true);
  assert.equal(recovery.getOrCreateState("agent-01", "open_source_emergency", "ollama", null).state, "HALF_OPEN");
});

test("ZeroCostRouter - routes, applies emergency CB, rejects paid route, and sanitizes", async () => {
  const ledger = new TestOnlyInMemoryQuotaLedger();
  const recovery = new TestOnlyInMemoryRecoveryContractManager({ cooldownDurationMs: 1000, maxConsecutiveFailures: 1 });

  // Configure quotas for the slots to prevent fail-closed unconfigured quota errors
  ledger.configureQuota("agent-01", "primary", "gemini", "vault://a/gemini", { limit: 10 });
  ledger.configureQuota("agent-01", "secondary", "claude", "vault://a/claude", { limit: 10 });
  ledger.configureQuota("agent-01", "tertiary", "sarvam", "vault://a/sarvam", { limit: 10 });
  // Bounded emergency slot must also have its quota configured
  ledger.configureQuota("agent-01", "open_source_emergency", "ollama", null, { limit: 10 });

  const executors = {
    gemini: async () => { throw new Error("TIMEOUT_ERROR: api_key=secretkeyhere"); },
    claude: async () => ({ output: "claude", evidence: { providerResponseId: "c1" } }),
    sarvam: async () => ({ output: "sarvam", evidence: { providerResponseId: "s1" } }),
    ollama: async () => ({ output: "local_ollama", evidence: { artifactSha256: hash } })
  };

  const router = new ZeroCostRouter(executors, { quotaLedger: ledger, recoveryManager: recovery });
  const result = await router.execute({
    agentId: "agent-01", taskId: "task-1", slots: baseSlots, input: "test-prompt"
  });

  // Since Gemini failed, it should fall back to Claude
  assert.equal(result.selectedProvider, "claude");

  // Gemini should be OPEN due to failure (maxConsecutiveFailures=1)
  const geminiState = recovery.getOrCreateState("agent-01", "primary", "gemini", "vault://a/gemini");
  assert.equal(geminiState.state, "OPEN");

  // Verify that Gemini's recorded error was properly sanitized
  const geminiAttempt = result.attempts.find(a => a.provider === "gemini");
  assert.equal(geminiAttempt.errorCode.includes("secretkeyhere"), false, "Error message should have been sanitized");
  assert.equal(geminiAttempt.errorCode.includes("api_key:[REDACTED]"), true);
});
