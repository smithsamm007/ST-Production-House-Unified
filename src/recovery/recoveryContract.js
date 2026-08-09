export function sanitizeErrorMessage(message) {
  if (!message) return "";
  let msg = typeof message === "string" ? message : (message?.message ?? String(message));

  // Redact vault paths: vault://...
  msg = msg.replace(/vault:\/\/[^\s]+/gi, "[REDACTED_VAULT_LOCATOR]");

  // Redact potential API keys (alphanumeric, 20+ chars, typical headers, auth tokens)
  msg = msg.replace(/(?:api_key|apikey|token|auth|password|secret)[=:][\w\-~.]+/gi, (match) => {
    const parts = match.split(/[=:]/);
    return `${parts[0]}:[REDACTED]`;
  });

  return msg;
}

export function classifyError(error) {
  const msg = (error?.message ?? String(error)).toUpperCase();

  // Known transient errors (rate limit, timeouts, network)
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
    msg.includes("TEMPORARY")
  ) {
    return "transient";
  }

  // Unknown errors must NOT default to transient retry; they default to "fatal"!
  return "fatal";
}

export class TestOnlyInMemoryRecoveryContractManager {
  constructor({
    cooldownDurationMs = 5000,
    maxConsecutiveFailures = 3
  } = {}) {
    this.isTestOnly = true;
    this.cooldownDurationMs = cooldownDurationMs;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    // Key: `${agentId}:${slotName}:${provider}:${secretLocator}` -> { state, consecutiveFailures, cooldownUntil }
    this.states = new Map();
  }

  _buildKey(agentId, slotName, provider, secretLocator) {
    const loc = secretLocator ?? "no_secret";
    return `${agentId}:${slotName}:${provider}:${loc}`;
  }

  getOrCreateState(agentId, slotName, provider, secretLocator) {
    const key = this._buildKey(agentId, slotName, provider, secretLocator);
    if (!this.states.has(key)) {
      this.states.set(key, {
        state: "CLOSED",
        consecutiveFailures: 0,
        cooldownUntil: null
      });
    }
    return this.states.get(key);
  }

  isHealthy(agentId, slotName, provider, secretLocator) {
    const info = this.getOrCreateState(agentId, slotName, provider, secretLocator);

    if (info.state === "OPEN") {
      if (info.cooldownUntil && Date.now() >= info.cooldownUntil) {
        info.state = "HALF_OPEN";
        info.cooldownUntil = null;
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess(agentId, slotName, provider, secretLocator) {
    const info = this.getOrCreateState(agentId, slotName, provider, secretLocator);
    info.state = "CLOSED";
    info.consecutiveFailures = 0;
    info.cooldownUntil = null;
  }

  recordFailure(agentId, slotName, provider, secretLocator, error) {
    const info = this.getOrCreateState(agentId, slotName, provider, secretLocator);
    const errorType = classifyError(error);

    info.consecutiveFailures++;

    if (
      errorType === "fatal" ||
      info.consecutiveFailures >= this.maxConsecutiveFailures ||
      info.state === "HALF_OPEN"
    ) {
      info.state = "OPEN";
      info.cooldownUntil = Date.now() + this.cooldownDurationMs;
    }
  }
}

// Keep RecoveryContractManager alias for compatibility
export { TestOnlyInMemoryRecoveryContractManager as RecoveryContractManager };
