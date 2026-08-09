export class QuotaLedger {
  constructor() {
    // Key: `${agentId}:${slotName}`
    this.quotas = new Map();
  }

  configureQuota(agentId, slotName, {
    limit = Infinity,
    usageCount = 0,
    resetTimestamp = null,
    trialExpiryTimestamp = null,
    tier = "free", // "free" or "trial" are allowed; "paid" or other tiers are strictly forbidden/blocked
    isPaid = false
  } = {}) {
    if (isPaid || (tier !== "free" && tier !== "trial")) {
      throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
    }
    const key = `${agentId}:${slotName}`;
    this.quotas.set(key, {
      limit,
      usageCount,
      resetTimestamp: resetTimestamp ? new Date(resetTimestamp) : null,
      trialExpiryTimestamp: trialExpiryTimestamp ? new Date(trialExpiryTimestamp) : null,
      tier,
      isPaid: false
    });
  }

  getQuota(agentId, slotName) {
    const key = `${agentId}:${slotName}`;
    return this.quotas.get(key);
  }

  resetUsageIfNeeded(agentId, slotName) {
    const quota = this.getQuota(agentId, slotName);
    if (!quota) return;

    if (quota.resetTimestamp && Date.now() >= quota.resetTimestamp.getTime()) {
      quota.usageCount = 0;
      quota.resetTimestamp = null;
    }
  }

  checkQuota(agentId, slotName) {
    this.resetUsageIfNeeded(agentId, slotName);
    const quota = this.getQuota(agentId, slotName);

    // If no quota is configured, treat it as default free tier with infinite limit.
    if (!quota) {
      return { allowed: true, reason: "default_free" };
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

  incrementUsage(agentId, slotName) {
    this.resetUsageIfNeeded(agentId, slotName);
    const quota = this.getQuota(agentId, slotName);
    if (!quota) {
      this.configureQuota(agentId, slotName, { limit: Infinity, usageCount: 1 });
      return;
    }

    const check = this.checkQuota(agentId, slotName);
    if (!check.allowed) {
      throw new Error(`QUOTA_LIMIT_EXCEEDED: ${check.reason}`);
    }

    quota.usageCount++;
  }
}
