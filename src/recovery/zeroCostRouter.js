import { validateTaskProviderPolicy } from "../providers/providerRouter.js";
import { TestOnlyInMemoryQuotaLedger } from "../quotas/quotaLedger.js";
import { TestOnlyInMemoryRecoveryContractManager, sanitizeErrorMessage } from "./recoveryContract.js";

function assertRemoteEvidence(result) {
  if (!result?.output || !result?.evidence?.providerResponseId) {
    throw new Error("REMOTE_PROVIDER_EVIDENCE_REQUIRED");
  }
}

function assertLocalEvidence(result) {
  if (!result?.output || !/^[a-f0-9]{64}$/i.test(result?.evidence?.artifactSha256 ?? "")) {
    throw new Error("LOCAL_ARTIFACT_HASH_REQUIRED");
  }
}

export class ZeroCostRouter {
  constructor(executors, { quotaLedger, recoveryManager } = {}) {
    this.executors = new Map(Object.entries(executors ?? {}));
    // Default to secure TestOnlyInMemory instances if not explicitly passed
    this.quotaLedger = quotaLedger ?? new TestOnlyInMemoryQuotaLedger();
    this.recoveryManager = recoveryManager ?? new TestOnlyInMemoryRecoveryContractManager();
  }

  async execute({ agentId, taskId, slots, input }) {
    const ordered = validateTaskProviderPolicy(agentId, slots);
    const attempts = [];

    for (const slot of ordered) {
      const startedAt = new Date().toISOString();
      const executor = this.executors.get(slot.provider);
      const secretLocator = slot.credentialRef?.secretLocator ?? null;
      const provider = slot.provider;

      // 1. Strict Paid/Overage route rejection
      const isPaidConfig = slot.isPaid || slot.tier === "paid" || slot.tier === "overage";
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

      // 2. Health / Circuit Breaker check (applied to all slots, including emergency)
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

      // 3. Atomic Quota Reservation
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

      // 4. Executor Registration check
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

      // 5. Execution phase
      try {
        const result = await executor({
          agentId,
          taskId,
          input,
          secretLocator
        });

        // Verify output evidence
        slot.kind === "remote" ? assertRemoteEvidence(result) : assertLocalEvidence(result);

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
