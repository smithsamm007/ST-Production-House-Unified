import { createHash, randomUUID } from "node:crypto";

/**
 * Robustly sanitizes and redacts sensitive error messages to prevent secret exposure.
 */
export function sanitizeErrorMessage(message) {
  if (!message) return "";
  let msg = typeof message === "string" ? message : (message?.message ?? String(message));

  // Redact vault/opaque paths: vault://... or opaque://...
  msg = msg.replace(/(?:vault|opaque):\/\/[^\s"']+/gi, "[REDACTED_VAULT_LOCATOR]");

  // Redact potential credentials, secrets, tokens, API keys
  msg = msg.replace(/(?:bearer\s+|token\s*[:=]\s*|api_key\s*[:=]\s*|apikey\s*[:=]\s*|auth\s*[:=]\s*|password\s*[:=]\s*|secret\s*[:=]\s*|credential\s*[:=]\s*)[\w\-~.]+/gi, (match) => {
    const parts = match.split(/[:=]/);
    if (parts.length > 1) {
      return `${parts[0]}:[REDACTED]`;
    }
    return "[REDACTED_CREDENTIAL]";
  });

  // Redact query-string secrets
  msg = msg.replace(/(?:[?&])(?:secret|token|key|api_key|password)=[^&\s]+/gi, (match) => {
    const prefix = match.charAt(0);
    const key = match.substring(1).split("=")[0];
    return `${prefix}${key}=[REDACTED]`;
  });

  return msg;
}

/**
 * Recursively redacts and sanitizes nested error payloads and structures.
 * Allows only standard properties and filters out nested objects/arbitrary keys.
 */
export function deepRedactAndSanitize(val) {
  if (val === null || val === undefined) return val;

  if (typeof val === "string") {
    return sanitizeErrorMessage(val);
  }

  if (Array.isArray(val)) {
    return val.map(deepRedactAndSanitize);
  }

  if (typeof val === "object") {
    const clean = {};
    for (const key of Object.keys(val)) {
      if (["message", "err", "error", "code", "classification", "errorCode"].includes(key)) {
        clean[key] = deepRedactAndSanitize(val[key]);
      }
    }
    return clean;
  }

  return val;
}

/**
 * Builds a secret-safe, bounded error payload DTO for database persistence.
 */
export function buildSecretSafeErrorPayload(errorPayload) {
  const errorMessage = errorPayload?.message || errorPayload?.err || String(errorPayload);
  const sanitized = sanitizeErrorMessage(errorMessage).substring(0, 500);

  return {
    errorCode: classifyRetryError(errorMessage) === "transient" ? "TRANSIENT_FAILURE" : "FATAL_FAILURE",
    summary: sanitized
  };
}

/**
 * Stable explicit retry error classification.
 * No broad substrings (rejects generic EXPIRED or CONN). unknown, authorization, billing,
 * quota-policy, credential-expiry and security failures fail closed.
 */
export function classifyRetryError(error) {
  if (!error) return "fatal";
  const msg = (error.message || String(error)).toUpperCase().trim();

  // Explicit, stable transient error codes / messages
  const transientPatterns = [
    "TIMEOUT",
    "RATE_LIMIT",
    "429",
    "TOO_MANY_REQUESTS",
    "SERVICE_UNAVAILABLE",
    "503",
    "504",
    "ETIMEDOUT",
    "LEASE EXPIRED AND RECLAIMED",
    "LEASE_EXPIRED_AND_RECLAIMED",
    "TEMPORARY_NETWORK_FAILURE"
  ];

  for (const pattern of transientPatterns) {
    if (msg === pattern || msg.includes(pattern)) {
      return "transient";
    }
  }

  return "fatal";
}

/**
 * Bounded exponential backoff delay calculator.
 * Validates inputs, bounds jitter, and clamps the final delay to the explicit maximum.
 */
export function calculateNextAttemptDelay(attempts, options = {}) {
  if (typeof attempts !== "number" || Number.isNaN(attempts) || !Number.isFinite(attempts) || attempts < 0) {
    throw new Error("INVALID_ATTEMPTS_VALUE");
  }

  const baseDelaySeconds = options.baseDelaySeconds ?? 5;
  const factor = options.factor ?? 2;
  const maxDelaySeconds = options.maxDelaySeconds ?? 3600;

  if (
    typeof baseDelaySeconds !== "number" || Number.isNaN(baseDelaySeconds) || !Number.isFinite(baseDelaySeconds) || baseDelaySeconds < 0 ||
    typeof factor !== "number" || Number.isNaN(factor) || !Number.isFinite(factor) || factor < 0 ||
    typeof maxDelaySeconds !== "number" || Number.isNaN(maxDelaySeconds) || !Number.isFinite(maxDelaySeconds) || maxDelaySeconds < 0
  ) {
    throw new Error("INVALID_BACKOFF_OPTIONS");
  }

  const expDelay = baseDelaySeconds * Math.pow(factor, attempts - 1);
  let delay = Math.min(maxDelaySeconds, expDelay);
  if (Number.isNaN(delay) || !Number.isFinite(delay) || delay < 0) {
    delay = maxDelaySeconds;
  }

  let jitter = 0;
  if (typeof options.jitterFn === "function") {
    jitter = options.jitterFn(delay);
  } else if (options.jitter !== undefined) {
    jitter = options.jitter;
  } else {
    jitter = Math.random() * delay * 0.1;
  }

  // Validate and bound jitter
  if (typeof jitter !== "number" || Number.isNaN(jitter) || !Number.isFinite(jitter) || jitter < 0) {
    jitter = 0;
  }
  // Jitter cannot exceed 50% of the computed delay
  jitter = Math.min(jitter, delay * 0.5);

  const finalDelay = delay + jitter;
  return Math.min(maxDelaySeconds, Math.max(0, finalDelay));
}

// Helper to sort and normalize object fields for deterministic hashing
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

/**
 * Concurrency-safe and transactional evidence appending.
 * Enforces transaction-level advisory locks to guarantee sequence serialization.
 */
export async function appendEvidenceEventXact(client, { subjectId, kind, classification, payload }) {
  // Use a transaction-level advisory lock to serialize appends to evidence events cleanly
  await client.query("SELECT pg_advisory_xact_lock($1);", [72101 + 999]);

  // Find previous event to establish chain integrity
  const prevRes = await client.query(
    "SELECT event_hash FROM evidence_events ORDER BY occurred_at DESC, id DESC LIMIT 1;"
  );
  const previousHash = prevRes.rows[0] ? prevRes.rows[0].event_hash : null;

  const recordId = randomUUID();
  const occurredAt = new Date().toISOString();

  // Clean payload by recursively redacting secrets
  const cleanPayload = deepRedactAndSanitize(payload || {});

  const record = {
    id: recordId,
    occurredAt,
    previousHash,
    subjectId,
    kind,
    classification,
    payload: cleanPayload,
  };

  const eventHash = createHash("sha256")
    .update(JSON.stringify(stable(record)))
    .digest("hex");

  await client.query(
    `INSERT INTO evidence_events (id, subject_id, kind, classification, payload, previous_hash, event_hash, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
    [
      recordId,
      subjectId,
      kind,
      classification,
      JSON.stringify(cleanPayload),
      previousHash,
      eventHash,
      occurredAt,
    ]
  );
}
