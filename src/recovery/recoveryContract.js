export function classifyError(error) {
  const msg = (error?.message ?? String(error)).toUpperCase();

  // Fatal errors: will not succeed on retry (e.g. auth, credential, validation, invalid request)
  if (
    msg.includes("AUTH") ||
    msg.includes("CREDENTIAL") ||
    msg.includes("ACCESS_DENIED") ||
    msg.includes("FORBIDDEN") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("INVALID") ||
    msg.includes("VALIDATION") ||
    msg.includes("400") ||
    msg.includes("EXECUTOR_NOT_REGISTERED") ||
    msg.includes("CONFIG")
  ) {
    return "fatal";
  }

  // Transient errors: might succeed on retry (e.g. rate limit, timeout, network/connection issue)
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

  // Default to transient for safe retry / backup paths
  return "transient";
}

export class RecoveryContractManager {
  constructor({
    cooldownDurationMs = 5000,
    maxConsecutiveFailures = 3
  } = {}) {
    this.cooldownDurationMs = cooldownDurationMs;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    // Key: `${agentId}:${slotName}` -> { state, consecutiveFailures, cooldownUntil }
    this.states = new Map();
  }

  getOrCreateState(agentId, slotName) {
    const key = `${agentId}:${slotName}`;
    if (!this.states.has(key)) {
      this.states.set(key, {
        state: "CLOSED",
        consecutiveFailures: 0,
        cooldownUntil: null
      });
    }
    return this.states.get(key);
  }

  isHealthy(agentId, slotName) {
    const info = this.getOrCreateState(agentId, slotName);

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

  recordSuccess(agentId, slotName) {
    const info = this.getOrCreateState(agentId, slotName);
    info.state = "CLOSED";
    info.consecutiveFailures = 0;
    info.cooldownUntil = null;
  }

  recordFailure(agentId, slotName, error) {
    const info = this.getOrCreateState(agentId, slotName);
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
