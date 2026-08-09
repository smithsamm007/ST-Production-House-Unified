import { QuotaLedger } from "../quotas/quotaLedger.js";
import { RecoveryContractManager, sanitizeErrorMessage } from "../recovery/recoveryContract.js";
import { credentialHealthRegistry as defaultCredentialHealthRegistry } from "./credentialHealth.js";

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
  if (msg.includes("TRIAL_EXPIRED") || msg.includes("QUOTA_RESERVATION_FAILED: trial_expired")) {
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
  if (msg.includes("COMMIT_OR_RECOVERY_FAILURE")) {
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

    if (!slot.credentialRef.secretLocator || typeof slot.credentialRef.secretLocator !== "string") {
      throw new Error("REMOTE_SLOT_CONFIGURATION_REQUIRED");
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
        throw new Error("TRIAL_EXPIRED");
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
  constructor(executors, { quotaLedger, recoveryManager, credentialHealthRegistry } = {}) {
    if (!executors || (executors instanceof Map ? executors.size === 0 : Object.keys(executors).length === 0)) {
      throw new Error("EXECUTORS_REQUIRED");
    }

    // Validate constructor options: strictly reject empty or unknown fields (fail-closed)
    if (arguments[1]) {
      const allowedKeys = ["quotaLedger", "recoveryManager", "credentialHealthRegistry"];
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

    this.executors = executors instanceof Map ? executors : new Map(Object.entries(executors));
    this.quotaLedger = quotaLedger;
    this.recoveryManager = recoveryManager;
    this.credentialHealthRegistry = credentialHealthRegistry;
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
      const secretLocator = slot.credentialRef?.secretLocator ?? null;
      const provider = slot.provider;

      // Fully qualified isolation key includes ownerId + agentId
      const scopeAgentId = `${ownerId}:${agentId}`;

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
        continue;
      }

      // 2. Unhealthy credentials check (Fails closed)
      if (this.credentialHealthRegistry) {
        if (!this.credentialHealthRegistry.isHealthy(secretLocator)) {
          attempts.push({
            slot: slot.slot,
            provider: slot.provider,
            startedAt,
            outcome: "skipped",
            errorCode: "UNHEALTHY_CREDENTIAL"
          });
          continue;
        }
      }

      // 3. Health / Circuit Breaker check (applied to all slots)
      if (this.recoveryManager) {
        if (!this.recoveryManager.isHealthy(scopeAgentId, slot.slot, provider, secretLocator)) {
          attempts.push({
            slot: slot.slot,
            provider: slot.provider,
            startedAt,
            outcome: "skipped",
            errorCode: "PROVIDER_IN_COOLDOWN"
          });
          continue;
        }
      }

      // 4. Atomic Quota Reservation
      let reservation;
      try {
        reservation = await this.quotaLedger.reserve(scopeAgentId, slot.slot, provider, secretLocator);
      } catch (reserveError) {
        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          outcome: "skipped",
          errorCode: getEnumErrorCode(reserveError)
        });
        continue;
      }

      // 5. Executor Registration check
      if (!executor) {
        try {
          await this.quotaLedger.release(reservation);
        } catch (releaseErr) {
          // Exception-safe cleanup: preserve original and do not leak quota
        }

        const configError = new Error("EXECUTOR_NOT_REGISTERED");
        try {
          this.recoveryManager.recordFailure(scopeAgentId, slot.slot, provider, secretLocator, configError);
        } catch (recErr) {
          // Exception-safe cleanup
        }

        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          outcome: "unavailable",
          errorCode: "EXECUTOR_NOT_REGISTERED"
        });
        continue;
      }

      // 6. Execution phase
      try {
        // Do NOT pass secretLocator or raw credentials to the provider executors.
        // Instead, pass a short-lived authorized handle or execution callback.
        const authHandle = "lease_handle_" + Math.random().toString(36).slice(2, 11);
        const result = await executor({
          agentId,
          taskId,
          input,
          handle: authHandle
        });

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

        // Try to commit reservation and record success (Exception-safe fail-closed guard)
        try {
          await this.quotaLedger.commit(reservation);
          this.recoveryManager.recordSuccess(scopeAgentId, slot.slot, provider, secretLocator);
        } catch (commitOrRecoveryError) {
          // Avoid quota leakage on commit failure by releasing reservation and failing closed
          try {
            await this.quotaLedger.release(reservation);
          } catch (releaseErr) {
            // Exception safe
          }
          throw new Error(`COMMIT_OR_RECOVERY_FAILURE: ${commitOrRecoveryError.message}`);
        }

        // Store only allowlisted, sanitized evidence references to prevent blindly copying secrets
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
      } catch (execError) {
        // Exception-safe cleanup: preserve original failure, avoid quota leakage, and fail closed
        try {
          await this.quotaLedger.release(reservation);
        } catch (releaseErr) {
          // Do not overwrite original execError
        }

        const sanitizedMsg = sanitizeErrorMessage(execError);
        const sanitizedError = new Error(sanitizedMsg);
        try {
          this.recoveryManager.recordFailure(scopeAgentId, slot.slot, provider, secretLocator, sanitizedError);
        } catch (recErr) {
          // Do not overwrite original execError
        }

        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: "failed",
          errorCode: getEnumErrorCode(execError)
        });
      }
    }

    const failure = new Error("ALL_CONFIGURED_PROVIDERS_FAILED");
    failure.attempts = attempts;
    throw failure;
  }
}
