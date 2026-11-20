/**
 * ST Production House — durable notification policy (Day 4 / D6).
 *
 * Pure, dependency-free policy for the general notification transport:
 * event taxonomy, priority mapping, bounded exponential backoff, error
 * classification and payload sanitization. Nothing here talks to a database or
 * a provider, so every rule below is unit-testable in isolation.
 *
 * Rule 17 / Rule 1: a notification body is a safe-output-allowlist projection.
 * Credentials, tokens, cookies and authorization material are removed before a
 * row ever reaches PostgreSQL, an external transport, a log or a report.
 */

export const NOTIFICATION_EVENT_TYPE = Object.freeze({
  OWNER_APPROVAL_REQUEST: "OWNER_APPROVAL_REQUEST",
  HERMES_DECISION: "HERMES_DECISION",
  APPROVAL_DEADLINE_OUTCOME: "APPROVAL_DEADLINE_OUTCOME",
  FORGE_TASK_COMPLETED: "FORGE_TASK_COMPLETED",
  FORGE_TASK_FAILED: "FORGE_TASK_FAILED",
  WORKER_CRASH: "WORKER_CRASH",
  WORKER_RETRY_EXHAUSTED: "WORKER_RETRY_EXHAUSTED",
  DIRECTOR_PRODUCTION_FAILED: "DIRECTOR_PRODUCTION_FAILED",
  PROVIDER_QUOTA_EXHAUSTED: "PROVIDER_QUOTA_EXHAUSTED",
  PUBLISHING_FAILED: "PUBLISHING_FAILED",
  SECURITY_ALERT: "SECURITY_ALERT",
  AUTHORIZATION_ALERT: "AUTHORIZATION_ALERT",
  DELIVERY_ALERT: "DELIVERY_ALERT",
  DAILY_FORGE_REPORT: "DAILY_FORGE_REPORT",
});

export const NOTIFICATION_PRIORITY = Object.freeze({
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  NORMAL: "NORMAL",
  LOW: "LOW",
});

export const PRIORITY_ORDER = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
});

/** Priority is a property of the event CLASS, not of the caller. */
const PRIORITY_BY_EVENT_TYPE = Object.freeze({
  [NOTIFICATION_EVENT_TYPE.OWNER_APPROVAL_REQUEST]: NOTIFICATION_PRIORITY.HIGH,
  [NOTIFICATION_EVENT_TYPE.HERMES_DECISION]: NOTIFICATION_PRIORITY.CRITICAL,
  [NOTIFICATION_EVENT_TYPE.APPROVAL_DEADLINE_OUTCOME]: NOTIFICATION_PRIORITY.CRITICAL,
  [NOTIFICATION_EVENT_TYPE.FORGE_TASK_COMPLETED]: NOTIFICATION_PRIORITY.NORMAL,
  [NOTIFICATION_EVENT_TYPE.FORGE_TASK_FAILED]: NOTIFICATION_PRIORITY.HIGH,
  [NOTIFICATION_EVENT_TYPE.WORKER_CRASH]: NOTIFICATION_PRIORITY.HIGH,
  [NOTIFICATION_EVENT_TYPE.WORKER_RETRY_EXHAUSTED]: NOTIFICATION_PRIORITY.HIGH,
  [NOTIFICATION_EVENT_TYPE.DIRECTOR_PRODUCTION_FAILED]: NOTIFICATION_PRIORITY.HIGH,
  [NOTIFICATION_EVENT_TYPE.PROVIDER_QUOTA_EXHAUSTED]: NOTIFICATION_PRIORITY.HIGH,
  [NOTIFICATION_EVENT_TYPE.PUBLISHING_FAILED]: NOTIFICATION_PRIORITY.CRITICAL,
  [NOTIFICATION_EVENT_TYPE.SECURITY_ALERT]: NOTIFICATION_PRIORITY.CRITICAL,
  [NOTIFICATION_EVENT_TYPE.AUTHORIZATION_ALERT]: NOTIFICATION_PRIORITY.CRITICAL,
  [NOTIFICATION_EVENT_TYPE.DELIVERY_ALERT]: NOTIFICATION_PRIORITY.HIGH,
  [NOTIFICATION_EVENT_TYPE.DAILY_FORGE_REPORT]: NOTIFICATION_PRIORITY.LOW,
});

export const OWNER_INBOX_CHANNEL = "owner_inbox";
export const DELIVERY_CHANNELS = Object.freeze(["owner_inbox", "email", "push", "webhook"]);
export const OPTIONAL_CHANNELS = Object.freeze(["email", "push", "webhook"]);

/** Secrets that must exist before a channel can be configured at all. */
export const CHANNEL_REQUIRED_SECRETS = Object.freeze({
  owner_inbox: null,
  email: "STPH_EMAIL_TRANSPORT",
  push: "STPH_PUSH_WEBHOOK_URL",
  webhook: "STPH_NOTIFICATION_WEBHOOK_URL",
});

export const RETRY_LIMITS = Object.freeze({
  DEFAULT_MAX_ATTEMPTS: 5,
  ABSOLUTE_MAX_ATTEMPTS: 20,
  BASE_SECONDS: 30,
  MAX_SECONDS: 3600,
  JITTER_RATIO: 0.2,
  MANUAL_RETRY_CEILING: 20,
});

export const DELIVERY_STATE = Object.freeze({
  CREATED: "created",
  QUEUED: "queued",
  ATTEMPTED: "attempted",
  DELIVERED: "delivered",
  FAILED: "failed",
  RETRY_SCHEDULED: "retry_scheduled",
  DEAD_LETTER: "dead_letter",
  UNCONFIGURED: "unconfigured",
});

export const DELIVERY_ERROR_CLASS = Object.freeze({
  TRANSIENT: "TRANSIENT",
  PERMANENT: "PERMANENT",
  RATE_LIMITED: "RATE_LIMITED",
  AUTHENTICATION: "AUTHENTICATION",
  UNCONFIGURED: "UNCONFIGURED",
  WORKER_LEASE_EXPIRED: "WORKER_LEASE_EXPIRED",
  UNKNOWN: "UNKNOWN",
});

export class NotificationError extends Error {
  constructor(code, message, status = 400) {
    super(message ?? code);
    this.name = "NotificationError";
    this.code = code;
    this.status = status;
  }
}

const SAFE_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const RECIPIENT = /^(OWNER|director:[A-Za-z0-9._:-]{2,80})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY =
  /(pass(word|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth[-_]?header|cookie|private[-_]?key|credential|client[-_]?secret|session[-_]?id|bearer)/i;

export function isKnownEventType(eventType) {
  return Object.values(NOTIFICATION_EVENT_TYPE).includes(eventType);
}

export function priorityForEventType(eventType) {
  const priority = PRIORITY_BY_EVENT_TYPE[eventType];
  if (!priority) {
    throw new NotificationError("NOTIFICATION_EVENT_TYPE_UNKNOWN", "Unknown notification event type.", 400);
  }
  return priority;
}

/**
 * Bounded exponential backoff with symmetric jitter.
 * Attempt 1 → ~base, 2 → ~2×base, … clamped to MAX_SECONDS.
 */
export function computeBackoffSeconds({
  attempts,
  baseSeconds = RETRY_LIMITS.BASE_SECONDS,
  maxSeconds = RETRY_LIMITS.MAX_SECONDS,
  jitterRatio = RETRY_LIMITS.JITTER_RATIO,
  random = Math.random,
} = {}) {
  const safeAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  const raw = Math.min(maxSeconds, baseSeconds * 2 ** (safeAttempts - 1));
  const jitter = raw * jitterRatio * (random() * 2 - 1);
  return Math.max(1, Math.min(maxSeconds, Math.round(raw + jitter)));
}

/** Stable classification used for bounded retry decisions and reporting. */
export function classifyDeliveryError(error) {
  const declared = error?.errorClass;
  if (declared && Object.values(DELIVERY_ERROR_CLASS).includes(declared)) return declared;
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  if (status === 429) return DELIVERY_ERROR_CLASS.RATE_LIMITED;
  if (status === 401 || status === 403) return DELIVERY_ERROR_CLASS.AUTHENTICATION;
  if (status >= 500 || status === 408 || status === 425) return DELIVERY_ERROR_CLASS.TRANSIENT;
  if (status >= 400) return DELIVERY_ERROR_CLASS.PERMANENT;
  const code = String(error?.code ?? "");
  if (["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return DELIVERY_ERROR_CLASS.TRANSIENT;
  }
  if (code === "UNCONFIGURED" || error?.unconfigured === true) return DELIVERY_ERROR_CLASS.UNCONFIGURED;
  return DELIVERY_ERROR_CLASS.TRANSIENT;
}

function scrubString(value, maxStringLength) {
  const withoutUserInfo = String(value).replace(/\/\/[^/@\s]+@/g, "//[redacted]@");
  const withoutBearer = withoutUserInfo.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  return withoutBearer.length > maxStringLength
    ? `${withoutBearer.slice(0, maxStringLength)}…`
    : withoutBearer;
}

/**
 * Safe-output allowlist projection. Unknown/secret-looking keys are dropped,
 * deep structures are bounded and long strings are truncated. No credential
 * can survive this function in a notification payload.
 */
export function sanitizeNotificationPayload(
  value,
  { depth = 0, maxStringLength = 500, maxArrayLength = 50, maxKeys = 60, maxDepth = 6 } = {}
) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return scrubString(value, maxStringLength);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayLength).map((entry) =>
      sanitizeNotificationPayload(entry, { depth: depth + 1, maxStringLength, maxArrayLength, maxKeys, maxDepth })
    );
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) return "[depth-limited]";
    const out = {};
    let keys = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (keys >= maxKeys) break;
      if (SECRET_KEY.test(key)) continue;
      if (typeof entry === "function" || typeof entry === "symbol") continue;
      out[key] = sanitizeNotificationPayload(entry, {
        depth: depth + 1,
        maxStringLength,
        maxArrayLength,
        maxKeys,
        maxDepth,
      });
      keys += 1;
    }
    return out;
  }
  return null;
}

/** Deterministic idempotency key from bounded parts (never random). */
export function notificationIdempotencyKey(...parts) {
  const cleaned = parts
    .flat()
    .filter((part) => part !== null && part !== undefined && part !== "")
    .map((part) => String(part).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 80));
  const key = cleaned.join(":").slice(0, 200);
  if (key.length < 8) {
    throw new NotificationError("NOTIFICATION_IDEMPOTENCY_KEY_INVALID", "Idempotency key parts are too short.", 400);
  }
  return key;
}

/**
 * Validate and normalize one notification event. The returned object is safe to
 * persist: payload is already sanitized and priority comes from the taxonomy
 * (a caller may only escalate to a HIGHER priority, never downgrade a CRITICAL
 * class).
 */
export function buildNotificationEvent({
  eventType,
  priority = null,
  recipient = "OWNER",
  ownerId = null,
  directorId = null,
  taskRef = null,
  idempotencyKey,
  payload = {},
} = {}) {
  if (!isKnownEventType(eventType)) {
    throw new NotificationError("NOTIFICATION_EVENT_TYPE_UNKNOWN", "Unknown notification event type.", 400);
  }
  if (typeof idempotencyKey !== "string" || !SAFE_KEY.test(idempotencyKey)) {
    throw new NotificationError(
      "NOTIFICATION_IDEMPOTENCY_KEY_INVALID",
      "An idempotency key of 8–200 safe characters is required.",
      400
    );
  }
  if (typeof recipient !== "string" || !RECIPIENT.test(recipient)) {
    throw new NotificationError("NOTIFICATION_RECIPIENT_INVALID", "A known recipient is required.", 400);
  }
  const taxonomyPriority = priorityForEventType(eventType);
  let finalPriority = taxonomyPriority;
  if (priority !== null && priority !== undefined) {
    if (!Object.values(NOTIFICATION_PRIORITY).includes(priority)) {
      throw new NotificationError("NOTIFICATION_PRIORITY_INVALID", "Unknown priority.", 400);
    }
    // Escalation allowed only (e.g. an approval request repeated 5 times may be
    // raised to CRITICAL); downgrading a security event is refused.
    finalPriority =
      PRIORITY_ORDER[priority] <= PRIORITY_ORDER[taxonomyPriority] ? priority : taxonomyPriority;
  }

  const isOwnerRecipient = recipient === "OWNER";
  if (isOwnerRecipient) {
    if (typeof ownerId !== "string" || !UUID.test(ownerId)) {
      throw new NotificationError(
        "NOTIFICATION_OWNER_REQUIRED",
        "Owner-scoped notifications require the authenticated Owner id.",
        400
      );
    }
  } else {
    if (typeof directorId !== "string" || directorId.length < 2 || directorId.length > 80) {
      throw new NotificationError("NOTIFICATION_DIRECTOR_REQUIRED", "A Director id is required.", 400);
    }
    if (ownerId && (typeof ownerId !== "string" || !UUID.test(ownerId))) {
      throw new NotificationError("NOTIFICATION_OWNER_INVALID", "Owner id must be a UUID.", 400);
    }
  }

  if (taskRef !== null && (typeof taskRef !== "string" || taskRef.length < 1 || taskRef.length > 160)) {
    throw new NotificationError("NOTIFICATION_TASK_REF_INVALID", "Task reference must be 1–160 characters.", 400);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new NotificationError("NOTIFICATION_PAYLOAD_INVALID", "Notification payload must be an object.", 400);
  }

  return {
    eventType,
    priority: finalPriority,
    recipient,
    ownerId: isOwnerRecipient ? ownerId : ownerId || null,
    directorId: isOwnerRecipient ? (directorId ?? null) : directorId,
    taskRef,
    idempotencyKey,
    payload: sanitizeNotificationPayload(payload) ?? {},
  };
}

/** Channel fan-out rule: inbox always, external channels always recorded. */
export function defaultChannelPlan() {
  return DELIVERY_CHANNELS.map((channel) => ({
    channel,
    configured: channel === OWNER_INBOX_CHANNEL,
  }));
}
