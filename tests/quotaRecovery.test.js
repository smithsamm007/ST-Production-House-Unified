import test from "node:test";
import assert from "node:assert/strict";
import { QuotaLedger } from "../src/quotas/quotaLedger.js";
import { classifyError, RecoveryContractManager } from "../src/recovery/recoveryContract.js";
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

test("Retry Taxonomy - classifies transient vs fatal errors", () => {
  assert.equal(classifyError(new Error("RATE_LIMIT")), "transient");
  assert.equal(classifyError(new Error("429 Too Many Requests")), "transient");
  assert.equal(classifyError(new Error("TIMEOUT")), "transient");
  assert.equal(classifyError(new Error("ETIMEDOUT")), "transient");
  assert.equal(classifyError(new Error("503 Service Unavailable")), "transient");

  assert.equal(classifyError(new Error("ACCESS_DENIED")), "fatal");
  assert.equal(classifyError(new Error("401 Unauthorized")), "fatal");
  assert.equal(classifyError(new Error("403 Forbidden")), "fatal");
  assert.equal(classifyError(new Error("INVALID_INPUT")), "fatal");
  assert.equal(classifyError(new Error("EXECUTOR_NOT_REGISTERED")), "fatal");
});

test("Quota Ledger - configure and check limits", () => {
  const ledger = new QuotaLedger();
  ledger.configureQuota("agent-01", "primary", { limit: 2 });

  // Check initial quota
  let check = ledger.checkQuota("agent-01", "primary");
  assert.equal(check.allowed, true);

  // Use up quota
  ledger.incrementUsage("agent-01", "primary");
  ledger.incrementUsage("agent-01", "primary");

  // Should be exceeded
  check = ledger.checkQuota("agent-01", "primary");
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "quota_exceeded");

  assert.throws(() => ledger.incrementUsage("agent-01", "primary"), /QUOTA_LIMIT_EXCEEDED/);
});

test("Quota Ledger - reset timestamp behavior", () => {
  const ledger = new QuotaLedger();
  const pastDate = new Date(Date.now() - 1000).toISOString();

  ledger.configureQuota("agent-01", "primary", { limit: 1, usageCount: 1, resetTimestamp: pastDate });

  // Usage count is 1, but resetTimestamp is in the past, so checkQuota should reset it and allow access
  const check = ledger.checkQuota("agent-01", "primary");
  assert.equal(check.allowed, true);

  const quota = ledger.getQuota("agent-01", "primary");
  assert.equal(quota.usageCount, 0);
  assert.equal(quota.resetTimestamp, null);
});

test("Quota Ledger - trial expiry behavior", () => {
  const ledger = new QuotaLedger();
  const pastDate = new Date(Date.now() - 1000).toISOString();
  const futureDate = new Date(Date.now() + 100000).toISOString();

  // Expired trial
  ledger.configureQuota("agent-01", "primary", { trialExpiryTimestamp: pastDate, tier: "trial" });
  let check = ledger.checkQuota("agent-01", "primary");
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "trial_expired");

  // Valid trial
  ledger.configureQuota("agent-01", "secondary", { trialExpiryTimestamp: futureDate, tier: "trial" });
  check = ledger.checkQuota("agent-01", "secondary");
  assert.equal(check.allowed, true);
});

test("Quota Ledger - blocks paid/overage configurations", () => {
  const ledger = new QuotaLedger();
  assert.throws(() => {
    ledger.configureQuota("agent-01", "primary", { tier: "paid" });
  }, /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);

  assert.throws(() => {
    ledger.configureQuota("agent-01", "primary", { isPaid: true });
  }, /PAID_OR_OVERAGE_ROUTES_FORBIDDEN/);
});

test("Circuit Breaker - CLOSED, OPEN, HALF_OPEN transitions", () => {
  const recovery = new RecoveryContractManager({ cooldownDurationMs: 50, maxConsecutiveFailures: 2 });

  // Initially CLOSED (healthy)
  assert.equal(recovery.isHealthy("agent-01", "primary"), true);

  // 1st transient failure
  recovery.recordFailure("agent-01", "primary", new Error("TIMEOUT"));
  assert.equal(recovery.isHealthy("agent-01", "primary"), true);

  // 2nd transient failure -> trips breaker to OPEN
  recovery.recordFailure("agent-01", "primary", new Error("TIMEOUT"));
  assert.equal(recovery.isHealthy("agent-01", "primary"), false);

  // Wait for cooldown to expire
  const start = Date.now();
  while (Date.now() - start < 60) {}

  // Should transition to HALF_OPEN when we check health
  assert.equal(recovery.isHealthy("agent-01", "primary"), true);
  const info = recovery.getOrCreateState("agent-01", "primary");
  assert.equal(info.state, "HALF_OPEN");

  // Success in HALF_OPEN -> CLOSED
  recovery.recordSuccess("agent-01", "primary");
  assert.equal(info.state, "CLOSED");
  assert.equal(info.consecutiveFailures, 0);

  // Fatal error trips breaker immediately
  recovery.recordFailure("agent-01", "primary", new Error("ACCESS_DENIED"));
  assert.equal(info.state, "OPEN");
});

test("Circuit Breaker - HALF_OPEN failure goes back to OPEN", () => {
  const recovery = new RecoveryContractManager({ cooldownDurationMs: 50, maxConsecutiveFailures: 1 });

  recovery.recordFailure("agent-01", "primary", new Error("TIMEOUT"));
  assert.equal(recovery.isHealthy("agent-01", "primary"), false);

  // Wait for cooldown
  const start = Date.now();
  while (Date.now() - start < 60) {}

  assert.equal(recovery.isHealthy("agent-01", "primary"), true); // Transitions to HALF_OPEN

  // Fail again in HALF_OPEN -> should immediately go to OPEN
  recovery.recordFailure("agent-01", "primary", new Error("TIMEOUT"));
  assert.equal(recovery.getOrCreateState("agent-01", "primary").state, "OPEN");
});

test("ZeroCostRouter - routes correctly with quotas and fallback", async () => {
  const ledger = new QuotaLedger();
  const recovery = new RecoveryContractManager({ cooldownDurationMs: 1000 });

  // Gemini fails transiently
  // Claude has exceeded quota
  // Sarvam has expired trial
  // Ollama (local fallback) succeeds

  ledger.configureQuota("agent-01", "secondary", { limit: 1, usageCount: 1 }); // Claude exceeded
  ledger.configureQuota("agent-01", "tertiary", { trialExpiryTimestamp: new Date(Date.now() - 1000).toISOString(), tier: "trial" }); // Sarvam expired

  const executors = {
    gemini: async () => { throw new Error("RATE_LIMIT"); },
    claude: async () => ({ output: "claude", evidence: { providerResponseId: "c1" } }),
    sarvam: async () => ({ output: "sarvam", evidence: { providerResponseId: "s1" } }),
    ollama: async () => ({ output: "local_ollama", evidence: { artifactSha256: hash } })
  };

  const router = new ZeroCostRouter(executors, { quotaLedger: ledger, recoveryManager: recovery });
  const result = await router.execute({
    agentId: "agent-01", taskId: "task-1", slots: baseSlots, input: "test-prompt"
  });

  assert.equal(result.selectedProvider, "ollama");
  assert.equal(result.output, "local_ollama");

  // Gemini should be marked failed and recorded on circuit breaker
  const geminiState = recovery.getOrCreateState("agent-01", "primary");
  assert.equal(geminiState.consecutiveFailures, 1);

  // Claude should have been skipped with QUOTA_EXCEEDED error code in attempts
  const claudeAttempt = result.attempts.find(a => a.provider === "claude");
  assert.equal(claudeAttempt.outcome, "skipped");
  assert.equal(claudeAttempt.errorCode, "QUOTA_EXCEEDED_QUOTA_EXCEEDED");

  // Sarvam skipped with trial expired
  const sarvamAttempt = result.attempts.find(a => a.provider === "sarvam");
  assert.equal(sarvamAttempt.outcome, "skipped");
  assert.equal(sarvamAttempt.errorCode, "QUOTA_EXCEEDED_TRIAL_EXPIRED");
});

test("ZeroCostRouter - rejects paid or overage slots", async () => {
  const slotsWithPaid = structuredClone(baseSlots);
  // Mark secondary slot with tier="paid" (paid/overage route)
  slotsWithPaid[1].tier = "paid";

  const executors = {
    gemini: async () => { throw new Error("TIMEOUT"); },
    claude: async () => ({ output: "paid claude", evidence: { providerResponseId: "c2" } }),
    sarvam: async () => { throw new Error("TIMEOUT"); },
    ollama: async () => ({ output: "local_ollama", evidence: { artifactSha256: hash } })
  };

  const router = new ZeroCostRouter(executors);
  const result = await router.execute({
    agentId: "agent-01", taskId: "task-1", slots: slotsWithPaid, input: "test"
  });

  // Claude should be completely skipped, falling back to ollama
  assert.equal(result.selectedProvider, "ollama");
  const claudeAttempt = result.attempts.find(a => a.provider === "claude");
  assert.equal(claudeAttempt.outcome, "skipped");
  assert.equal(claudeAttempt.errorCode, "PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
});
