import { createHash, randomUUID } from "node:crypto";

export function sanitizeErrorMessage(message) {
  if (!message) return "";
  let msg = typeof message === "string" ? message : (message?.message ?? String(message));

  // Redact vault/opaque paths: vault://... or opaque://...
  msg = msg.replace(/(?:vault|opaque):\/\/[^\s"']+/gi, "[REDACTED_VAULT_LOCATOR]");

  // Redact potential API keys, secrets, tokens, credentials
  msg = msg.replace(/(?:api_key|apikey|token|auth|password|secret|credential)[=:][\w\-~.]+/gi, (match) => {
    const parts = match.split(/[=:]/);
    return `${parts[0]}:[REDACTED]`;
  });

  return msg;
}

export function classifyRetryError(error) {
  if (!error) return "fatal";
  const msg = (error.message || String(error)).toUpperCase();

  // Known transient errors (rate limit, timeouts, network, lease expired)
  if (
    msg.includes("RATE_LIMIT") ||
    msg.includes("429") ||
    msg.includes("TOO_MANY_REQUESTS") ||
    msg.includes("TIMEOUT") ||
    msg.includes("504") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("CONN") ||
    msg.includes("NETWORK") ||
    msg.includes("503") ||
    msg.includes("SERVICE_UNAVAILABLE") ||
    msg.includes("TEMPORARY") ||
    msg.includes("EXPIRED") ||
    msg.includes("RECLAIMED")
  ) {
    return "transient";
  }

  // Unknown errors must NOT default to transient retry; they default to "fatal"!
  return "fatal";
}

export function calculateNextAttemptDelay(attempts, options = {}) {
  const baseDelaySeconds = options.baseDelaySeconds ?? 5;
  const factor = options.factor ?? 2;
  const maxDelaySeconds = options.maxDelaySeconds ?? 3600;

  // exponential backoff
  const expDelay = baseDelaySeconds * Math.pow(factor, attempts - 1);
  const delay = Math.min(maxDelaySeconds, expDelay);

  // jitter
  let jitter = 0;
  if (typeof options.jitterFn === "function") {
    jitter = options.jitterFn(delay);
  } else if (options.jitter !== undefined) {
    jitter = options.jitter; // a deterministic constant for tests
  } else {
    // production random jitter, e.g. up to 10% of the delay
    jitter = Math.random() * delay * 0.1;
  }

  return Math.max(0, delay + jitter);
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

export async function appendEvidenceEventXact(client, { subjectId, kind, classification, payload }) {
  // Find previous event to establish chain integrity
  const prevRes = await client.query(
    "SELECT event_hash FROM evidence_events ORDER BY occurred_at DESC, id DESC LIMIT 1;"
  );
  const previousHash = prevRes.rows[0] ? prevRes.rows[0].event_hash : null;

  const recordId = randomUUID();
  const occurredAt = new Date().toISOString();

  const record = {
    id: recordId,
    occurredAt,
    previousHash,
    subjectId,
    kind,
    classification,
    payload: payload || {},
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
      JSON.stringify(payload || {}),
      previousHash,
      eventHash,
      occurredAt,
    ]
  );
}
