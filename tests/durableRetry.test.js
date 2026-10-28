import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRetryError,
  calculateNextAttemptDelay,
  sanitizeErrorMessage,
  sanitizeEvidencePayload,
} from "../src/jobs/retry/retryManager.js";

test("Durable Retry Unit Tests — Stable Retry Error Classification", () => {
  // Transient cases
  assert.equal(classifyRetryError(new Error("RATE_LIMIT")), "transient");
  assert.equal(classifyRetryError(new Error("429 Too Many Requests")), "transient");
  assert.equal(classifyRetryError(new Error("TIMEOUT")), "transient");
  assert.equal(classifyRetryError(new Error("ETIMEDOUT")), "transient");
  assert.equal(classifyRetryError(new Error("503 Service Unavailable")), "transient");
  assert.equal(classifyRetryError(new Error("Lease expired and reclaimed")), "transient");

  // Fatal / Unknown cases (Unknown errors must fail closed and NOT default to transient retry)
  assert.equal(classifyRetryError(new Error("SOME_RANDOM_PROVIDER_UNKNOWN_ERROR")), "fatal");
  assert.equal(classifyRetryError(new Error("DB_DOWN")), "fatal");
  assert.equal(classifyRetryError(new Error("ACCESS_DENIED")), "fatal");
  assert.equal(classifyRetryError(null), "fatal");
  assert.equal(classifyRetryError(""), "fatal");
});

test("Durable Retry Unit Tests — Error Message and Secret Redaction", () => {
  const secretErr = "Failed because API key api_key=xyz123abc is invalid";
  const sanitized1 = sanitizeErrorMessage(secretErr);
  assert.equal(sanitized1.includes("xyz123abc"), false, "API key value should be redacted");
  assert.equal(sanitized1.includes("api_key:[REDACTED]"), true);

  const vaultErr = "Could not fetch vault://secrets/claude from key vault";
  const sanitized2 = sanitizeErrorMessage(vaultErr);
  assert.equal(sanitized2.includes("vault://"), false, "Vault locators should be redacted");
  assert.equal(sanitized2.includes("[REDACTED_VAULT_LOCATOR]"), true);

  const opaqueErr = "Failed to load opaque://credentials/postiz";
  const sanitized3 = sanitizeErrorMessage(opaqueErr);
  assert.equal(sanitized3.includes("opaque://"), false, "Opaque locators should be redacted");
  assert.equal(sanitized3.includes("[REDACTED_VAULT_LOCATOR]"), true);
});

test("Durable Retry Unit Tests — Bounded Exponential Backoff with Jitter", () => {
  // Option structure: baseDelaySeconds, factor, maxDelaySeconds, jitter / jitterFn

  // Try 1: 5 * 2^0 = 5
  const delay1 = calculateNextAttemptDelay(1, { baseDelaySeconds: 5, factor: 2, jitter: 0 });
  assert.equal(delay1, 5);

  // Try 2: 5 * 2^1 = 10
  const delay2 = calculateNextAttemptDelay(2, { baseDelaySeconds: 5, factor: 2, jitter: 0 });
  assert.equal(delay2, 10);

  // Try 3: 5 * 2^2 = 20
  const delay3 = calculateNextAttemptDelay(3, { baseDelaySeconds: 5, factor: 2, jitter: 0 });
  assert.equal(delay3, 20);

  // Bounded to max delay: say max is 15
  const delayBounded = calculateNextAttemptDelay(3, { baseDelaySeconds: 5, factor: 2, maxDelaySeconds: 15, jitter: 0 });
  assert.equal(delayBounded, 15);

  // Deterministic constant jitter: delay of 10 + jitter 2.5 = 12.5
  const delayJitter = calculateNextAttemptDelay(2, { baseDelaySeconds: 5, factor: 2, jitter: 2.5 });
  assert.equal(delayJitter, 12.5);

  // Injectable jitter function: receives delay and returns jitter
  const delayJitterFn = calculateNextAttemptDelay(2, {
    baseDelaySeconds: 5,
    factor: 2,
    jitterFn: (d) => d * 0.5, // 50% jitter
  });
  assert.equal(delayJitterFn, 15);
});


test("Durable Retry Unit Tests — exact codes do not match hostile substrings", () => {
  assert.equal(classifyRetryError(new Error("prefix-503-suffix")), "fatal");
  assert.equal(classifyRetryError(new Error("CONNECTION_EXPIRED_CREDENTIAL")), "fatal");
  assert.equal(classifyRetryError({ code: "ETIMEDOUT", message: "socket closed" }), "transient");
});

test("Durable Retry Unit Tests — Evidence payload retains schema and drops secrets", () => {
  const sanitized = sanitizeEvidencePayload({
    jobId: "job-123",
    agentId: "agent-456",
    attempts: 3,
    classification: "transient",
    reason: "provider token=super-secret timed out",
    nextAttemptAt: "2026-08-10T10:00:00.000Z",
    arbitrarySecret: "must-not-persist",
    nested: { token: "must-not-persist" },
  });
  assert.deepEqual(sanitized, {
    jobId: "job-123",
    agentId: "agent-456",
    attempts: 3,
    classification: "transient",
    reason: "provider token:[REDACTED] timed out",
    nextAttemptAt: "2026-08-10T10:00:00.000Z",
  });
  assert.equal("arbitrarySecret" in sanitized, false);
  assert.equal("nested" in sanitized, false);
});
