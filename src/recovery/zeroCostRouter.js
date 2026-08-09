import { validateTaskProviderPolicy } from "../providers/providerRouter.js";

const EMERGENCY_SLOT = "open_source_emergency";

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
    this.quotaLedger = quotaLedger;
    this.recoveryManager = recoveryManager;
  }

  async execute({ agentId, taskId, slots, input }) {
    const ordered = validateTaskProviderPolicy(agentId, slots);
    const attempts = [];

    for (const slot of ordered) {
      const startedAt = new Date().toISOString();
      const executor = this.executors.get(slot.provider);

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

      // 2. Quota Check (using the ledger if provided)
      if (this.quotaLedger && slot.slot !== EMERGENCY_SLOT) {
        const check = this.quotaLedger.checkQuota(agentId, slot.slot);
        if (!check.allowed) {
          attempts.push({
            slot: slot.slot,
            provider: slot.provider,
            startedAt,
            outcome: "skipped",
            errorCode: `QUOTA_EXCEEDED_${check.reason.toUpperCase()}`
          });
          continue;
        }
      }

      // 3. Health / Cooldown Check (using recoveryManager if provided)
      if (this.recoveryManager && slot.slot !== EMERGENCY_SLOT) {
        if (!this.recoveryManager.isHealthy(agentId, slot.slot)) {
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

      // 4. Executor Registration check
      if (!executor) {
        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          outcome: "unavailable",
          errorCode: "EXECUTOR_NOT_REGISTERED"
        });
        if (this.recoveryManager && slot.slot !== EMERGENCY_SLOT) {
          this.recoveryManager.recordFailure(agentId, slot.slot, new Error("EXECUTOR_NOT_REGISTERED"));
        }
        continue;
      }

      try {
        const result = await executor({
          agentId,
          taskId,
          input,
          secretLocator: slot.credentialRef?.secretLocator ?? null
        });

        // Verify output evidence
        slot.kind === "remote" ? assertRemoteEvidence(result) : assertLocalEvidence(result);

        // Success! Record success in recovery manager and increment quota ledger
        if (this.recoveryManager && slot.slot !== EMERGENCY_SLOT) {
          this.recoveryManager.recordSuccess(agentId, slot.slot);
        }
        if (this.quotaLedger && slot.slot !== EMERGENCY_SLOT) {
          this.quotaLedger.incrementUsage(agentId, slot.slot);
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
      } catch (error) {
        // Failure! Record failure in recovery manager
        if (this.recoveryManager && slot.slot !== EMERGENCY_SLOT) {
          this.recoveryManager.recordFailure(agentId, slot.slot, error);
        }

        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: "failed",
          errorCode: error?.message ?? "UNKNOWN_PROVIDER_FAILURE"
        });
      }
    }

    const failure = new Error("ALL_CONFIGURED_PROVIDERS_FAILED");
    failure.attempts = attempts;
    throw failure;
  }
}
