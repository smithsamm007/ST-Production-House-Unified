import { PRELOADED_AGENTS } from "../catalog/agents.js";

const PRELOADED_AGENT_NAMES = Object.freeze(PRELOADED_AGENTS.map(agent => agent.name));

// Custom error classes to support fail-closed interfaces with precise error reporting.
export class WorkEnvelopeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkEnvelopeValidationError";
  }
}

export class SecurityViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecurityViolationError";
  }
}

/**
 * Normalizes strings by removing punctuation and converting to lowercase
 * to enable robust comparisons.
 */
export function normalizeString(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/[_\-\.\s\p{P}]+/gu, "");
}

/**
 * Validates a work envelope structure for provider-independent tasks.
 */
export class WorkEnvelope {
  constructor(data) {
    this.validate(data);
    this.taskId = data.taskId;
    this.jobType = data.jobType;
    this.agentId = data.agentId;
    this.payload = Object.freeze(JSON.parse(JSON.stringify(data.payload || {})));
    this.context = Object.freeze(JSON.parse(JSON.stringify(data.context || {})));
    Object.freeze(this);
  }

  validate(data) {
    if (!data || typeof data !== "object") {
      throw new WorkEnvelopeValidationError("Envelope data must be a valid object");
    }

    if (typeof data.taskId !== "string" || !data.taskId.trim()) {
      throw new WorkEnvelopeValidationError("Invalid or missing 'taskId'. Must be a non-empty string.");
    }

    if (typeof data.jobType !== "string" || !data.jobType.trim()) {
      throw new WorkEnvelopeValidationError("Invalid or missing 'jobType'. Must be a non-empty string.");
    }

    if (typeof data.agentId !== "string" || !data.agentId.trim()) {
      throw new WorkEnvelopeValidationError("Invalid or missing 'agentId'. Must be a non-empty string.");
    }

    if (!data.payload || typeof data.payload !== "object") {
      throw new WorkEnvelopeValidationError("Invalid or missing 'payload'. Must be an object.");
    }

    if (!data.context || typeof data.context !== "object") {
      throw new WorkEnvelopeValidationError("Invalid or missing 'context'. Must be an object.");
    }

    // Run security and isolation scans to guarantee fail-closed behavior.
    this.scanForPlaintextSecrets(data.payload, "payload");
    this.scanForPlaintextSecrets(data.context, "context");

    this.scanForInternalAgentNames(data.payload, "payload");
    this.scanForInternalAgentNames(data.context, "context");
  }

  /**
   * Scans a dictionary recursively to prevent any plain text API keys, tokens,
   * or passwords from being transmitted in the work envelope.
   */
  scanForPlaintextSecrets(obj, path = "") {
    if (!obj || typeof obj !== "object") return;

    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      const lowerKey = key.toLowerCase();

      if (typeof value === "string") {
        const isSecretKey =
          lowerKey.includes("password") ||
          lowerKey.includes("secret") ||
          lowerKey.includes("token") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("privatekey") ||
          lowerKey.includes("auth");

        if (isSecretKey) {
          // If it is a secret key, it must start with an opaque locator such as vault:// or opaque://
          if (value && !value.startsWith("vault://") && !value.startsWith("opaque://")) {
            throw new SecurityViolationError(
              `Plaintext secret detected at "${currentPath}". Secrets must use opaque locators (e.g. vault://...).`
            );
          }
        }
      } else if (typeof value === "object" && value !== null) {
        this.scanForPlaintextSecrets(value, currentPath);
      }
    }
  }

  /**
   * Scans a dictionary recursively to prevent leakage of internal agent names
   * (e.g. JARVIS, SHERLOCK, etc.) in public or user-visible text fields.
   */
  scanForInternalAgentNames(obj, path = "") {
    if (!obj || typeof obj !== "object") return;

    // Use registered internal agent names if available, falling back to preloaded set.
    const agentsToBlock = PRELOADED_AGENT_NAMES || [
      "JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA",
      "BYTE", "CHANAKYA", "KABIR", "SHAKTI", "ROHAN",
      "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA",
      "KARAN", "DEV", "AANYA", "ARJUN", "NISHA"
    ];

    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      const lowerKey = key.toLowerCase();

      if (typeof value === "string") {
        // We scan fields that are public-facing or typical output/metadata fields.
        // To be extremely fail-closed, we can scan any string field in public-facing keys,
        // or any text that might be shared.
        const isPublicField =
          lowerKey.includes("caption") ||
          lowerKey.includes("description") ||
          lowerKey.includes("title") ||
          lowerKey.includes("text") ||
          lowerKey.includes("message") ||
          lowerKey.includes("brand") ||
          lowerKey.includes("display") ||
          lowerKey.includes("public");

        if (isPublicField) {
          const normValue = normalizeString(value);
          for (const agentName of agentsToBlock) {
            const normAgentName = normalizeString(agentName);
            if (normAgentName && normValue.includes(normAgentName)) {
              throw new SecurityViolationError(
                `Internal-only agent name leakage detected in public field "${currentPath}".`
              );
            }
          }
        }
      } else if (typeof value === "object" && value !== null) {
        this.scanForInternalAgentNames(value, currentPath);
      }
    }
  }
}
