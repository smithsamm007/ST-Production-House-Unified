import { createHash, randomUUID } from "node:crypto";
import { validateTaskProviderPolicy } from "./providerRouter.js";

const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization)/i;
const LOCATOR_PATTERN = /^(?:vault|opaque):\/\/[a-zA-Z0-9_\-\.\/]+$/;
const AGENT_NAME_PATTERN = /\b(?:JARVIS|SHERLOCK|LAKME|VEDA|PANCHI|NEWTON)\b/i;

export class ProviderSmokeTestError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ProviderSmokeTestError";
    this.code = code;
    this.details = details;
  }
}

export function validateSmokeTestLocators(slots) {
  for (const slot of slots) {
    if (slot.kind === "remote" && slot.credentialRef) {
      const loc = slot.credentialRef.secretLocator;
      if (!loc || typeof loc !== "string" || !LOCATOR_PATTERN.test(loc)) {
        throw new ProviderSmokeTestError(
          `Invalid secret locator scheme for slot ${slot.slot}`,
          "INVALID_SECRET_LOCATOR"
        );
      }
    }
  }
}

export async function runProviderSmokeTest({
  ownerId,
  agentId,
  taskId = randomUUID(),
  slots,
  executor,
  evidenceLedger = null
}) {
  if (!ownerId || typeof ownerId !== "string" || ownerId.trim().length === 0) {
    throw new ProviderSmokeTestError("Valid ownerId is required", "OWNER_ID_REQUIRED");
  }
  if (!agentId || typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new ProviderSmokeTestError("Valid agentId is required", "AGENT_ID_REQUIRED");
  }
  if (typeof executor !== "function") {
    throw new ProviderSmokeTestError("Executor function is required", "EXECUTOR_REQUIRED");
  }

  // Check for internal agent name leakage in inputs
  if (AGENT_NAME_PATTERN.test(JSON.stringify({ ownerId, taskId }))) {
    throw new ProviderSmokeTestError(
      "Internal agent identifier leaked in public metadata",
      "AGENT_NAME_LEAKAGE_DENIED"
    );
  }

  // Validate 4-slot provider layout
  let validatedSlots;
  try {
    validatedSlots = validateTaskProviderPolicy(agentId, slots);
  } catch (err) {
    throw new ProviderSmokeTestError(
      err.message,
      "INVALID_PROVIDER_POLICY"
    );
  }

  // Validate locators for remote slots
  validateSmokeTestLocators(validatedSlots);

  const attempts = [];
  let successfulExecution = null;

  for (const slot of validatedSlots) {
    const startedAt = new Date().toISOString();
    try {
      const response = await executor({
        ownerId,
        agentId,
        taskId,
        slot: slot.slot,
        provider: slot.provider,
        kind: slot.kind,
        credentialRef: slot.credentialRef ?? null
      });

      const finishedAt = new Date().toISOString();

      if (!response) {
        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt,
          outcome: "failed",
          errorCode: "EMPTY_PROVIDER_RESPONSE"
        });
        continue;
      }

      // Verify receipt (Rule 1 & Rule 2)
      const hasRemoteReceipt = response.providerResponseId && response.providerResponseSha256;
      const hasLocalReceipt = response.artifactSha256 && /^[a-f0-9]{64}$/i.test(response.artifactSha256);

      if (slot.kind === "remote" && !hasRemoteReceipt) {
        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt,
          outcome: "failed",
          errorCode: "REMOTE_PROVIDER_RECEIPT_MISSING"
        });
        continue;
      }

      if (slot.kind === "local_open_source" && !hasLocalReceipt) {
        attempts.push({
          slot: slot.slot,
          provider: slot.provider,
          startedAt,
          finishedAt,
          outcome: "failed",
          errorCode: "LOCAL_ARTIFACT_HASH_MISSING"
        });
        continue;
      }

      // Successful verification
      const receipt = slot.kind === "remote"
        ? { providerResponseId: response.providerResponseId, providerResponseSha256: response.providerResponseSha256 }
        : { artifactSha256: response.artifactSha256 };

      const attemptRecord = Object.freeze({
        slot: slot.slot,
        provider: slot.provider,
        kind: slot.kind,
        startedAt,
        finishedAt,
        outcome: "verified_success",
        receipt
      });

      attempts.push(attemptRecord);
      successfulExecution = {
        selectedProvider: slot.provider,
        selectedSlot: slot.slot,
        receipt,
        output: response.output ?? "OK"
      };
      break; // Smoke test succeeded on configured provider
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const errorCode = err?.code || err?.message || "PROVIDER_EXECUTION_FAILED";
      attempts.push({
        slot: slot.slot,
        provider: slot.provider,
        kind: slot.kind,
        startedAt,
        finishedAt,
        outcome: "failed",
        errorCode
      });
    }
  }

  if (!successfulExecution) {
    const error = new ProviderSmokeTestError(
      "All configured providers failed smoke test",
      "ALL_PROVIDERS_FAILED",
      { attempts }
    );
    throw error;
  }

  // Append evidence event if ledger is provided
  if (evidenceLedger) {
    evidenceLedger.append({
      subjectId: taskId,
      kind: "provider_smoke_test",
      classification: "configured_provider_smoke",
      payload: {
        ownerId,
        agentId,
        selectedProvider: successfulExecution.selectedProvider,
        selectedSlot: successfulExecution.selectedSlot,
        receipt: successfulExecution.receipt,
        attemptCount: attempts.length
      }
    });
  }

  return Object.freeze({
    smokeTestId: randomUUID(),
    ownerId,
    agentId,
    taskId,
    status: "verified_success",
    selectedProvider: successfulExecution.selectedProvider,
    selectedSlot: successfulExecution.selectedSlot,
    receipt: successfulExecution.receipt,
    attempts: Object.freeze(attempts)
  });
}
