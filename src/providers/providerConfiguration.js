import { sanitizeErrorMessage } from "../recovery/recoveryContract.js";

export const SUPPORTED_SLOTS = Object.freeze([
  "primary",
  "secondary",
  "tertiary",
  "emergency_1",
  "emergency_2"
]);

export const REMOTE_SLOTS = Object.freeze(["primary", "secondary", "tertiary"]);
export const EMERGENCY_SLOTS = Object.freeze(["emergency_1", "emergency_2"]);

/**
 * Returns a stable uppercase enumerated error code based on the error context.
 *
 * @param {Error|any} error
 * @returns {string} Stable enumerated public error code
 */
export function getEnumErrorCode(error) {
  if (!error) return "UNKNOWN_PROVIDER_FAILURE";
  const msg = (error.message ?? String(error)).toUpperCase();

  if (msg.includes("QUOTA_NOT_CONFIGURED") || msg.includes("QUOTA_RESERVATION_FAILED: quota_not_configured")) {
    return "QUOTA_NOT_CONFIGURED";
  }
  if (msg.includes("TRIAL_EXPIRED") || msg.includes("QUOTA_RESERVATION_FAILED: trial_expired") || msg.includes("TRIAL_EXPIRY_REJECTED")) {
    return "TRIAL_EXPIRED";
  }
  if (msg.includes("QUOTA_EXCEEDED") || msg.includes("QUOTA_RESERVATION_FAILED: quota_exceeded")) {
    return "QUOTA_EXCEEDED";
  }
  if (msg.includes("UNHEALTHY_CREDENTIAL")) {
    return "UNHEALTHY_CREDENTIAL";
  }
  if (msg.includes("PROVIDER_IN_COOLDOWN")) {
    return "PROVIDER_IN_COOLDOWN";
  }
  if (msg === "TIMEOUT" || msg.includes("ETIMEDOUT")) {
    return "TIMEOUT";
  }
  if (msg === "RATE_LIMIT" || msg.includes("TOO_MANY_REQUESTS") || msg.includes("429")) {
    return "RATE_LIMIT";
  }
  if (msg === "SERVICE_UNAVAILABLE" || msg.includes("503")) {
    return "SERVICE_UNAVAILABLE";
  }
  if (msg === "TEMPORARY_NETWORK_FAILURE") {
    return "TEMPORARY_NETWORK_FAILURE";
  }
  if (msg.includes("EXECUTOR_NOT_REGISTERED")) {
    return "EXECUTOR_NOT_REGISTERED";
  }
  if (msg.includes("PAID_OR_OVERAGE_ROUTES_FORBIDDEN")) {
    return "PAID_OR_OVERAGE_ROUTES_FORBIDDEN";
  }
  if (msg.includes("REMOTE_PROVIDER_EVIDENCE_REQUIRED")) {
    return "REMOTE_PROVIDER_EVIDENCE_REQUIRED";
  }
  if (msg.includes("LOCAL_ARTIFACT_HASH_REQUIRED")) {
    return "LOCAL_ARTIFACT_HASH_REQUIRED";
  }
  if (msg.includes("CROSS_OWNER_CREDENTIAL_ACCESS_DENIED")) {
    return "CROSS_OWNER_CREDENTIAL_ACCESS_DENIED";
  }
  if (msg.includes("CROSS_AGENT_CREDENTIAL_ACCESS_DENIED")) {
    return "CROSS_AGENT_CREDENTIAL_ACCESS_DENIED";
  }
  if (msg.includes("CREDENTIAL_SLOT_MISMATCH")) {
    return "CREDENTIAL_SLOT_MISMATCH";
  }
  if (msg.includes("LEASE_EXPIRED") || msg.includes("LEASE_REVOKED") || msg.includes("LEASE_CONSUMED")) {
    return "LEASE_EXPIRED_OR_REVOKED";
  }
  if (msg.includes("AUDIT_FAILURE")) {
    return "AUDIT_FAILURE";
  }
  if (msg.includes("COMMIT_OR_RECOVERY_FAILURE") || msg.includes("COMMIT_FAILED") || msg.includes("DURABLE_COMMIT_FAILED")) {
    return "COMMIT_OR_RECOVERY_FAILURE";
  }
  return "PROVIDER_EXECUTION_FAILED";
}

/**
 * Validates the per-agent provider configuration slots layout.
 * Ensures exactly primary, secondary, tertiary, emergency_1, emergency_2 slots exist,
 * validates remote vs local open-source layouts, confirms owner and agent credential ownership,
 * enforces explicit unexpired free/trial classifications, and ensures distinct providers.
 *
 * @param {string} ownerId
 * @param {string} agentId
 * @param {Array} slots
 * @returns {Array} List of validated and ordered slot objects
 */
export function validateTaskProviderConfiguration(ownerId, agentId, slots) {
  if (!ownerId || typeof ownerId !== "string") {
    throw new Error("OWNER_ID_REQUIRED");
  }
  if (!agentId || typeof agentId !== "string") {
    throw new Error("AGENT_ID_REQUIRED");
  }
  if (!Array.isArray(slots) || slots.length !== 5) {
    throw new Error("EXACTLY_FIVE_PROVIDER_SLOTS_REQUIRED");
  }

  const bySlot = new Map(slots.map((item) => [item.slot, item]));
  if (bySlot.size !== 5 || !SUPPORTED_SLOTS.every((slot) => bySlot.has(slot))) {
    throw new Error("INVALID_PROVIDER_SLOT_LAYOUT");
  }

  const providers = new Set();

  // Validate Remote slots
  for (const slotName of REMOTE_SLOTS) {
    const slot = bySlot.get(slotName);
    if (!slot || slot.kind !== "remote" || !slot.provider || !slot.credentialRef) {
      throw new Error("REMOTE_SLOT_CONFIGURATION_REQUIRED");
    }

    if (!slot.credentialRef.ownerId || slot.credentialRef.ownerId !== ownerId) {
      throw new Error("CROSS_OWNER_CREDENTIAL_ACCESS_DENIED");
    }

    if (slot.credentialRef.agentId !== agentId) {
      throw new Error("CROSS_AGENT_CREDENTIAL_ACCESS_DENIED");
    }

    if (slot.credentialRef.slot !== slotName) {
      throw new Error("CREDENTIAL_SLOT_MISMATCH");
    }

    // Require non-secret credentialId and capability
    if (!slot.credentialRef.credentialId || typeof slot.credentialRef.credentialId !== "string") {
      throw new Error("REMOTE_SLOT_CONFIGURATION_REQUIRED");
    }
    if (!slot.credentialRef.capability || typeof slot.credentialRef.capability !== "string") {
      throw new Error("REMOTE_SLOT_CONFIGURATION_REQUIRED");
    }

    // Never allow raw secret locators inside configuration
    if (slot.credentialRef.secretLocator !== undefined) {
      throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
    }

    // Billing and Tier validations (Fail closed on missing/unknown metadata)
    const tier = slot.tier;
    if (tier !== "free" && tier !== "trial" && tier !== "free_trial") {
      throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
    }

    if (slot.isPaid === true || slot.billingModel === "automatic" || slot.billingEnabled === true) {
      throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
    }

    // Validate Trial Expiry if tier is trial/free_trial
    if (tier === "trial" || tier === "free_trial") {
      if (!slot.trialExpiryTimestamp) {
        throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
      }
      const parsedExpiry = new Date(slot.trialExpiryTimestamp);
      if (Number.isNaN(parsedExpiry.getTime())) {
        throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
      }
      if (Date.now() >= parsedExpiry.getTime()) {
        throw new Error("TRIAL_EXPIRY_REJECTED: TRIAL_EXPIRED");
      }
    }

    // Validate limit metadata exists
    if (slot.limit === undefined || slot.limit === null || typeof slot.limit !== "number" || slot.limit <= 0) {
      throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
    }

    if (providers.has(slot.provider)) {
      throw new Error("PROVIDERS_MUST_BE_DISTINCT");
    }
    providers.add(slot.provider);
  }

  // Validate Emergency slots
  for (const slotName of EMERGENCY_SLOTS) {
    const slot = bySlot.get(slotName);
    if (!slot || slot.kind !== "local_open_source" || !slot.provider || slot.credentialRef != null) {
      throw new Error("EMERGENCY_SLOT_MUST_BE_LOCAL_AND_KEYLESS");
    }

    if (providers.has(slot.provider)) {
      throw new Error("PROVIDERS_MUST_BE_DISTINCT");
    }
    providers.add(slot.provider);
  }

  // Return the slots ordered systematically: primary -> secondary -> tertiary -> emergency_1 -> emergency_2
  return [
    bySlot.get("primary"),
    bySlot.get("secondary"),
    bySlot.get("tertiary"),
    bySlot.get("emergency_1"),
    bySlot.get("emergency_2")
  ];
}

/**
 * ProviderConfigurationRouter
 * Manages per-agent provider routing and execution with zero-cost quotas,
 * circuit breakers, credential health monitoring, and billing-model enforcement.
 */
export class ProviderConfigurationRouter {
  constructor(executors, { quotaLedger, recoveryManager, credentialHealthRegistry, credentialBroker } = {}) {
    if (!executors || (executors instanceof Map ? executors.size === 0 : Object.keys(executors).length === 0)) {
      throw new Error("EXECUTORS_REQUIRED");
    }

    // Validate constructor options: strictly reject empty or unknown fields (fail-closed)
    if (arguments[1]) {
      const allowedKeys = ["quotaLedger", "recoveryManager", "credentialHealthRegistry", "credentialBroker"];
      const providedKeys = Object.keys(arguments[1]);
      for (const key of providedKeys) {
        if (!allowedKeys.includes(key)) {
          throw new Error(`UNKNOWN_CONSTRUCTOR_OPTION: ${key}`);
        }
      }
    }

    if (!quotaLedger) {
      throw new Error("QUOTA_LEDGER_REQUIRED");
    }
    if (!recoveryManager) {
      throw new Error("RECOVERY_MANAGER_REQUIRED");
    }
    if (!credentialHealthRegistry) {
      throw new Error("CREDENTIAL_HEALTH_REGISTRY_REQUIRED");
    }
    if (!credentialBroker) {
      throw new Error("CREDENTIAL_BROKER_REQUIRED");
    }

    // Validate that injected durable interfaces comply with expected signatures (fail-closed)
    if (typeof quotaLedger.reserve !== "function" || typeof quotaLedger.commit !== "function" || typeof quotaLedger.release !== "function") {
      throw new Error("INVALID_QUOTA_LEDGER_INTERFACE");
    }
    if (typeof recoveryManager.isHealthy !== "function" || typeof recoveryManager.recordSuccess !== "function" || typeof recoveryManager.recordFailure !== "function") {
      throw new Error("INVALID_RECOVERY_MANAGER_INTERFACE");
    }
    if (typeof credentialHealthRegistry.isHealthy !== "function") {
      throw new Error("INVALID_CREDENTIAL_HEALTH_REGISTRY_INTERFACE");
    }
    if (typeof credentialBroker.resolve !== "function") {
      throw new Error("INVALID_CREDENTIAL_BROKER_INTERFACE");
    }

    this.executors = executors instanceof Map ? executors : new Map(Object.entries(executors));
    this.quotaLedger = quotaLedger;
    this.recoveryManager = recoveryManager;
    this.credentialHealthRegistry = credentialHealthRegistry;
    this.credentialBroker = credentialBroker;
  }

  _quotaScope({ ownerId, agentId, taskId, slot, provider, credentialId }) {
    return {
      ownerId,
      agentId,
      slot,
      provider,
      credentialId,
      idempotencyKey: `${taskId}:${slot}`,
      units: 1
    };
  }

  async _reserveQuota(scope, legacyAgentId) {
    return this.quotaLedger.isProductionDurable
      ? this.quotaLedger.reserve(scope)
      : this.quotaLedger.reserve(legacyAgentId, scope.slot, scope.provider, scope.credentialId);
  }

  async _recordFallback(scope, errorCode) {
    if (!this.quotaLedger.isProductionDurable) return;
    if (typeof this.quotaLedger.recordFallback !== "function") {
      throw new Error("DURABLE_FALLBACK_EVIDENCE_REQUIRED");
    }
    await this.quotaLedger.recordFallback(scope, { errorCode });
  }

  async _recordFailureRoutingState(scope, errorCode) {
    const cooldownCodes = new Set([
      "RATE_LIMIT", "TIMEOUT", "SERVICE_UNAVAILABLE", "TEMPORARY_NETWORK_FAILURE"
    ]);
    if (this.quotaLedger.isProductionDurable && cooldownCodes.has(errorCode)) {
      if (typeof this.quotaLedger.recordCooldown !== "function") {
        throw new Error("DURABLE_COOLDOWN_EVIDENCE_REQUIRED");
      }
      await this.quotaLedger.recordCooldown(scope, {
        errorCode,
        retryAfterSeconds: 60,
        recordFallback: true
      });
      return;
    }
    await this._recordFallback(scope, errorCode);
  }

  /**
   * Executes tasks through configured providers with bounded failover.
   * Enforces all secure fail-closed validations including paid-route blocks,
   * expired trials, cooldowns, and unhealthy credentials.
   *
   * @param {Object} params
   * @param {string} params.ownerId
   * @param {string} params.agentId
   * @param {string} params.taskId
   * @param {Array} params.slots
   * @param {any} params.input
   * @returns {Promise<Object>} Output, selectedProvider, and the attempts log
   */
  async execute({ ownerId, agentId, taskId, slots, input }) {
    const ordered = validateTaskProviderConfiguration(ownerId, agentId, slots);
    const attempts = [];

    for (const slot of ordered) {
      const startedAt = new Date().toISOString();
      const executor = this.executors.get(slot.provider);
      const provider = slot.provider;

      const credentialId = slot.credentialRef?.credentialId ?? null;
      const capability = slot.credentialRef?.capability ?? null;
      const scopeAgentId = `${ownerId}:${agentId}`;
      const quotaScope = this._quotaScope({ ownerId, agentId, taskId, slot: slot.slot, provider, credentialId });

      // 1. Paid, Overage, and Automatic Billing route rejection (Fail closed)
      const isPaidConfig = slot.isPaid === true ||
                           slot.tier === "paid" ||
                           slot.tier === "overage" ||
                           slot.billingModel === "automatic" ||
                           slot.billingEnabled === true;
      if (isPaidConfig) {
        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          outcome: "skipped",
          errorCode: "PAID_OR_OVERAGE_ROUTES_FORBIDDEN"
        });
        await this._recordFallback(quotaScope, "PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
        continue;
      }

      // 2. Unhealthy credentials check (Fails closed)
      if (this.credentialHealthRegistry) {
        if (!this.credentialHealthRegistry.isHealthy({ ownerId, agentId, slot: slot.slot, provider, credentialId })) {
          attempts.push({
            slot: slot.slot,
            provider: slot.provider,
            startedAt,
            outcome: "skipped",
            errorCode: "UNHEALTHY_CREDENTIAL"
          });
          await this._recordFallback(quotaScope, "UNHEALTHY_CREDENTIAL");
          continue;
        }
      }

      // 3. Health / Circuit Breaker check (applied to all slots)
      if (this.recoveryManager) {
        if (!this.recoveryManager.isHealthy(scopeAgentId, slot.slot, provider, credentialId)) {
          attempts.push({
            slot: slot.slot,
            provider: slot.provider,
            startedAt,
            outcome: "skipped",
            errorCode: "PROVIDER_IN_COOLDOWN"
          });
          await this._recordFallback(quotaScope, "PROVIDER_IN_COOLDOWN");
          continue;
        }
      }

      // 4. Validate remote credential identity/capability and obtain an authorized short-lived lease (Slice 4.1 resolve API)
      let lease = null;
      if (slot.kind === "remote") {
        try {
          lease = await this.credentialBroker.resolve({
            ownerId,
            agentId,
            provider: slot.provider,
            capability,
            credentialId
          });
          if (!lease || typeof lease.consume !== "function") {
            throw new Error("LEASE_EXPIRED_OR_REVOKED");
          }
        } catch (brokerError) {
          const errorCode = getEnumErrorCode(brokerError);
          attempts.push({
            slot: slot.slot,
            provider: slot.provider,
            startedAt,
            outcome: "skipped",
            errorCode
          });
          await this._recordFallback(quotaScope, errorCode);
          continue;
        }
      }

      // 5. Atomic Quota Reservation
      let reservation;
      try {
        reservation = await this._reserveQuota(quotaScope, scopeAgentId);
        if (!reservation || reservation.status !== "reserved") {
          throw new Error("QUOTA_IDEMPOTENCY_TERMINAL_RESERVATION");
        }
      } catch (reserveError) {
        // If quota reservation fails, make sure we revoke the lease!
        if (lease) {
          try {
            await lease.revoke();
          } catch (e) {
            // Exception safe
          }
        }
        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          outcome: "skipped",
          errorCode: getEnumErrorCode(reserveError)
        });
        await this._recordFallback(quotaScope, getEnumErrorCode(reserveError));
        continue;
      }

      // Reservation State Machine (tracks "reserved", "committed", "released" cleanly to prevent double-finalization)
      let reservationState = "reserved";

      // 6. Execution & Verification within try-finally (guaranteeing reservation release & lease revocation)
      try {
        // Executor Registration check
        if (!executor) {
          throw new Error("EXECUTOR_NOT_REGISTERED");
        }

        // Execution phase: Execute inside lease.consume for remote execution
        let result;
        if (slot.kind === "remote") {
          result = await lease.consume(async (secret) => {
            // Secret material exists only for this bounded callback and is never persisted.
            return await executor({
              agentId,
              taskId,
              input,
              credential: secret
            });
          });
        } else {
          result = await executor({
            agentId,
            taskId,
            input
          });
        }

        // Verify output evidence
        if (slot.kind === "remote") {
          if (!result?.output || !result?.evidence?.providerResponseId) {
            throw new Error("REMOTE_PROVIDER_EVIDENCE_REQUIRED");
          }
        } else {
          if (!result?.output || !/^[a-f0-9]{64}$/i.test(result?.evidence?.artifactSha256 ?? "")) {
            throw new Error("LOCAL_ARTIFACT_HASH_REQUIRED");
          }
        }

        // Try to commit reservation (Exception-safe fail-closed guard)
        try {
          await this.quotaLedger.commit(reservation);
          reservationState = "committed";
        } catch (commitError) {
          throw commitError; // triggers release in catch block
        }

        // Record recovery success only after successful commit (avoid double-finalization)
        try {
          if (this.recoveryManager) {
            this.recoveryManager.recordSuccess(scopeAgentId, slot.slot, provider, credentialId);
          }
        } catch (recSuccessError) {
          throw new Error(`COMMIT_OR_RECOVERY_FAILURE: ${recSuccessError.message}`);
        }

        // Store only allowlisted sanitized evidence reference fields to prevent secret exposure
        const sanitizedEvidence = {};
        if (result.evidence?.providerResponseId) {
          sanitizedEvidence.providerResponseId = String(result.evidence.providerResponseId).slice(0, 100);
        }
        if (result.evidence?.artifactSha256) {
          sanitizedEvidence.artifactSha256 = String(result.evidence.artifactSha256).slice(0, 64);
        }

        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: "verified_success",
          evidence: sanitizedEvidence
        });

        return { output: result.output, selectedProvider: slot.provider, attempts };
      } catch (execOrCommitError) {
        // Exception-safe cleanup: release reservation if not committed
        if (reservationState === "reserved") {
          try {
            await this.quotaLedger.release(reservation);
            reservationState = "released";
          } catch (releaseErr) {
            // Exception-safe
          }
        }

        const sanitizedMsg = sanitizeErrorMessage(execOrCommitError);
        const sanitizedError = new Error(sanitizedMsg);
        try {
          if (this.recoveryManager) {
            this.recoveryManager.recordFailure(scopeAgentId, slot.slot, provider, credentialId, sanitizedError);
          }
        } catch (recErr) {
          // Exception-safe
        }

        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: "failed",
          errorCode: getEnumErrorCode(execOrCommitError)
        });

        // Never execute a second provider after the first provider already succeeded
        // and its quota reservation was committed. That could duplicate side effects.
        if (reservationState === "committed") {
          const terminal = new Error("POST_COMMIT_RECOVERY_STATE_FAILURE");
          terminal.doNotRetry = true;
          terminal.attempts = attempts;
          throw terminal;
        }
        await this._recordFailureRoutingState(quotaScope, getEnumErrorCode(execOrCommitError));
      } finally {
        // Always revoke lease in both success/failure paths to guarantee cleanup
        if (lease) {
          try {
            await lease.revoke();
          } catch (e) {
            // Exception safe
          }
        }
      }
    }

    const failure = new Error("ALL_CONFIGURED_PROVIDERS_FAILED");
    failure.attempts = attempts;
    throw failure;
  }
}
