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
 * Validates the per-agent provider configuration slots layout.
 * Ensures exactly primary, secondary, tertiary, emergency_1, emergency_2 slots exist,
 * validates remote vs local open-source layouts, confirms credential ownership,
 * enforces free/free-trial tier requirements, and ensures distinct providers.
 *
 * @param {string} agentId
 * @param {Array} slots
 * @returns {Array} List of validated and ordered slot objects
 */
export function validateTaskProviderConfiguration(agentId, slots) {
  if (!agentId) {
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

    if (slot.credentialRef.agentId !== agentId) {
      throw new Error("CROSS_AGENT_CREDENTIAL_ACCESS_DENIED");
    }

    if (slot.credentialRef.slot !== slotName) {
      throw new Error("CREDENTIAL_SLOT_MISMATCH");
    }

    if (!slot.credentialRef.secretLocator || typeof slot.credentialRef.secretLocator !== "string") {
      throw new Error("REMOTE_SLOT_CONFIGURATION_REQUIRED");
    }

    // Remote slots accept only free/free-trial configuration
    const isPaidConfig = slot.isPaid === true ||
                         slot.tier === "paid" ||
                         slot.tier === "overage" ||
                         slot.billingModel === "automatic" ||
                         slot.billingEnabled === true;
    if (isPaidConfig) {
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
    this.executors = new Map(Object.entries(executors ?? {}));
    // Default to clean/isolated or global instances of public contracts
    this.quotaLedger = quotaLedger ?? new QuotaLedger();
    this.recoveryManager = recoveryManager ?? new RecoveryContractManager();
    this.credentialHealthRegistry = credentialHealthRegistry ?? defaultCredentialHealthRegistry;
  }

  /**
   * Executes tasks through configured providers with bounded failover.
   * Enforces all secure fail-closed validations including paid-route blocks,
   * expired trials, cooldowns, and unhealthy credentials.
   *
   * @param {Object} params
   * @param {string} params.agentId
   * @param {string} params.taskId
   * @param {Array} params.slots
   * @param {any} params.input
   * @returns {Promise<Object>} Output, selectedProvider, and the attempts log
   */
  async execute({ agentId, taskId, slots, input }) {
    const ordered = validateTaskProviderConfiguration(agentId, slots);
    const attempts = [];

    for (const slot of ordered) {
      const startedAt = new Date().toISOString();
      const executor = this.executors.get(slot.provider);
      const secretLocator = slot.credentialRef?.secretLocator ?? null;
      const provider = slot.provider;

      // 1. Paid, Overage, and Automatic Billing route rejection
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
        if (!this.recoveryManager.isHealthy(agentId, slot.slot, provider, secretLocator)) {
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
        reservation = await this.quotaLedger.reserve(agentId, slot.slot, provider, secretLocator);
      } catch (reserveError) {
        const sanitizedMsg = sanitizeErrorMessage(reserveError);
        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          outcome: "skipped",
          errorCode: sanitizedMsg
        });
        continue;
      }

      // 5. Executor Registration check
      if (!executor) {
        await this.quotaLedger.release(reservation);

        const configError = new Error("EXECUTOR_NOT_REGISTERED");
        if (this.recoveryManager) {
          this.recoveryManager.recordFailure(agentId, slot.slot, provider, secretLocator, configError);
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
        const result = await executor({
          agentId,
          taskId,
          input,
          secretLocator
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

        // Success! Commit reservation and record success
        await this.quotaLedger.commit(reservation);
        if (this.recoveryManager) {
          this.recoveryManager.recordSuccess(agentId, slot.slot, provider, secretLocator);
        }

        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: "verified_success",
          evidence: result.evidence
        });

        return { output: result.output, selectedProvider: slot.provider, attempts };
      } catch (execError) {
        // Sanitize error and record failure on circuit breaker
        const sanitizedMsg = sanitizeErrorMessage(execError);
        const sanitizedError = new Error(sanitizedMsg);

        // Release reservation
        await this.quotaLedger.release(reservation);

        if (this.recoveryManager) {
          this.recoveryManager.recordFailure(agentId, slot.slot, provider, secretLocator, sanitizedError);
        }

        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: "failed",
          errorCode: sanitizedMsg
        });
      }
    }

    const failure = new Error("ALL_CONFIGURED_PROVIDERS_FAILED");
    failure.attempts = attempts;
    throw failure;
  }
}
