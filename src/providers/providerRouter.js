const REMOTE_SLOTS = Object.freeze(["primary", "secondary", "tertiary"]);
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

export function validateTaskProviderPolicy(agentId, slots) {
  if (!agentId || !Array.isArray(slots) || slots.length !== 4) {
    throw new Error("EXACTLY_FOUR_PROVIDER_SLOTS_REQUIRED");
  }
  const bySlot = new Map(slots.map((item) => [item.slot, item]));
  if (bySlot.size !== 4 ||
      !REMOTE_SLOTS.every((slot) => bySlot.has(slot)) ||
      !bySlot.has(EMERGENCY_SLOT)) {
    throw new Error("INVALID_PROVIDER_SLOT_LAYOUT");
  }

  const providers = new Set();
  for (const slotName of REMOTE_SLOTS) {
    const slot = bySlot.get(slotName);
    if (slot.kind !== "remote" || !slot.provider || !slot.credentialRef) {
      throw new Error("REMOTE_SLOT_CONFIGURATION_REQUIRED");
    }
    if (slot.credentialRef.agentId !== agentId) {
      throw new Error("CROSS_AGENT_CREDENTIAL_ACCESS_DENIED");
    }
    if (slot.credentialRef.slot !== slotName) {
      throw new Error("CREDENTIAL_SLOT_MISMATCH");
    }
    if (providers.has(slot.provider)) throw new Error("PROVIDERS_MUST_BE_DISTINCT");
    providers.add(slot.provider);
  }

  const emergency = bySlot.get(EMERGENCY_SLOT);
  if (emergency.kind !== "local_open_source" ||
      !emergency.provider ||
      emergency.credentialRef != null) {
    throw new Error("OPEN_SOURCE_EMERGENCY_MUST_BE_LOCAL_AND_KEYLESS");
  }
  if (providers.has(emergency.provider)) throw new Error("PROVIDERS_MUST_BE_DISTINCT");
  return [...REMOTE_SLOTS.map((name) => bySlot.get(name)), emergency];
}

export class ProviderRouter {
  constructor(executors) {
    this.executors = new Map(Object.entries(executors ?? {}));
  }

  async execute({ agentId, taskId, slots, input }) {
    const ordered = validateTaskProviderPolicy(agentId, slots);
    const attempts = [];

    for (const slot of ordered) {
      const executor = this.executors.get(slot.provider);
      const startedAt = new Date().toISOString();
      if (!executor) {
        attempts.push({ slot: slot.slot, provider: slot.provider, startedAt,
          outcome: "unavailable", errorCode: "EXECUTOR_NOT_REGISTERED" });
        continue;
      }
      try {
        const result = await executor({
          agentId,
          taskId,
          input,
          secretLocator: slot.credentialRef?.secretLocator ?? null
        });
        slot.kind === "remote" ? assertRemoteEvidence(result) : assertLocalEvidence(result);
        attempts.push({ slot: slot.slot, provider: slot.provider, startedAt,
          finishedAt: new Date().toISOString(), outcome: "verified_success",
          evidence: result.evidence });
        return { output: result.output, selectedProvider: slot.provider, attempts };
      } catch (error) {
        attempts.push({ slot: slot.slot, provider: slot.provider, startedAt,
          finishedAt: new Date().toISOString(), outcome: "failed",
          errorCode: error?.message ?? "UNKNOWN_PROVIDER_FAILURE" });
      }
    }
    const failure = new Error("ALL_CONFIGURED_PROVIDERS_FAILED");
    failure.attempts = attempts;
    throw failure;
  }
}
