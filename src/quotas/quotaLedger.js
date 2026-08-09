export class TestOnlyInMemoryQuotaLedger {
  constructor() {
    this.isTestOnly = true;
    // Key: `${agentId}:${slotName}:${provider}:${secretLocator}`
    this.quotas = new Map();
  }

  _buildKey(agentId, slotName, provider, secretLocator) {
    const loc = secretLocator ?? "no_secret";
    return `${agentId}:${slotName}:${provider}:${loc}`;
  }

  configureQuota(agentId, slotName, provider, secretLocator, {
    limit,
    usageCount = 0,
    resetTimestamp = null,
    trialExpiryTimestamp = null,
    tier = "free",
    isPaid = false
  } = {}) {
    if (isPaid || (tier !== "free" && tier !== "trial")) {
      throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
    }

    // Validate finite limit (no Infinity)
    if (limit === undefined || limit === null || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      throw new Error("INVALID_LIMIT: limit must be a positive finite number");
    }

    // Validate non-negative usage count
    if (typeof usageCount !== "number" || !Number.isFinite(usageCount) || usageCount < 0) {
      throw new Error("INVALID_USAGE_COUNT: usageCount must be a non-negative finite number");
    }

    // Validate timestamps
    let parsedReset = null;
    if (resetTimestamp) {
      parsedReset = new Date(resetTimestamp);
      if (Number.isNaN(parsedReset.getTime())) {
        throw new Error("INVALID_RESET_TIMESTAMP");
      }
    }

    let parsedExpiry = null;
    if (trialExpiryTimestamp) {
      parsedExpiry = new Date(trialExpiryTimestamp);
      if (Number.isNaN(parsedExpiry.getTime())) {
        throw new Error("INVALID_TRIAL_EXPIRY_TIMESTAMP");
      }
    }

    const key = this._buildKey(agentId, slotName, provider, secretLocator);
    this.quotas.set(key, {
      limit,
      usageCount,
      resetTimestamp: parsedReset,
      trialExpiryTimestamp: parsedExpiry,
      tier,
      isPaid: false
    });
  }

  getQuota(agentId, slotName, provider, secretLocator) {
    const key = this._buildKey(agentId, slotName, provider, secretLocator);
    return this.quotas.get(key);
  }

  resetUsageIfNeeded(agentId, slotName, provider, secretLocator) {
    const quota = this.getQuota(agentId, slotName, provider, secretLocator);
    if (!quota) return;

    if (quota.resetTimestamp && Date.now() >= quota.resetTimestamp.getTime()) {
      quota.usageCount = 0;
      quota.resetTimestamp = null;
    }
  }

  checkQuota(agentId, slotName, provider, secretLocator) {
    this.resetUsageIfNeeded(agentId, slotName, provider, secretLocator);
    const quota = this.getQuota(agentId, slotName, provider, secretLocator);

    // Fail closed for unconfigured quota; never grant implicit unlimited usage
    if (!quota) {
      return { allowed: false, reason: "quota_not_configured" };
    }

    if (quota.isPaid || (quota.tier !== "free" && quota.tier !== "trial")) {
      return { allowed: false, reason: "paid_route_forbidden" };
    }

    if (quota.trialExpiryTimestamp && Date.now() >= quota.trialExpiryTimestamp.getTime()) {
      return { allowed: false, reason: "trial_expired" };
    }

    if (quota.usageCount >= quota.limit) {
      return { allowed: false, reason: "quota_exceeded" };
    }

    return { allowed: true, reason: "within_quota" };
  }

  // Atomic reservation
  async reserve(agentId, slotName, provider, secretLocator) {
    this.resetUsageIfNeeded(agentId, slotName, provider, secretLocator);
    const check = this.checkQuota(agentId, slotName, provider, secretLocator);
    if (!check.allowed) {
      throw new Error(`QUOTA_RESERVATION_FAILED: ${check.reason}`);
    }

    const quota = this.getQuota(agentId, slotName, provider, secretLocator);
    // Single-threaded synchronous tick is fully atomic for check + increment!
    quota.usageCount++;

    return {
      id: Math.random().toString(36).slice(2, 11),
      agentId,
      slotName,
      provider,
      secretLocator,
      status: "reserved"
    };
  }

  async commit(reservation) {
    if (!reservation || reservation.status !== "reserved") {
      throw new Error("INVALID_RESERVATION_STATUS");
    }
    reservation.status = "committed";
  }

  async release(reservation) {
    if (!reservation || reservation.status !== "reserved") {
      return; // Already committed or released, or invalid
    }
    const quota = this.getQuota(
      reservation.agentId,
      reservation.slotName,
      reservation.provider,
      reservation.secretLocator
    );
    if (quota) {
      quota.usageCount = Math.max(0, quota.usageCount - 1);
    }
    reservation.status = "released";
  }
}

// Keep QuotaLedger name alias to avoid breaking imports
export { TestOnlyInMemoryQuotaLedger as QuotaLedger };
