import { CANONICAL_PROVIDERS } from "./config.js";
import { resolveChain, RoutingError } from "./router.js";

const SECRET_PATTERN = /vault:\/\/|opaque:\/\/|password|api[_ -]?key|bearer\s/i;

export class DispatchReadinessError extends Error {
  constructor(code) {
    super(code);
    this.name = "DispatchReadinessError";
    this.code = code;
  }
}

function fail(code) {
  throw new DispatchReadinessError(code);
}

function policyAgentId(agentPolicy) {
  if (typeof agentPolicy === "string") return agentPolicy;
  if (agentPolicy && typeof agentPolicy === "object") return agentPolicy.agentId;
  return null;
}

function validateCheckpoint(checkpoint, expectedAgentId) {
  const data = checkpoint?.data;
  if (
    !data ||
    data.state !== "WAITING_FOR_QUOTA" ||
    data.capacityPolicy !== "approved_free_only" ||
    data.executionStarted !== false ||
    data.providerSelection !== "not_performed" ||
    typeof data.ownerId !== "string" ||
    data.ownerId.length < 3 ||
    data.agentId !== expectedAgentId
  ) {
    fail("DISPATCH_READINESS_CHECKPOINT_SCOPE_MISMATCH");
  }

  if (SECRET_PATTERN.test(JSON.stringify(checkpoint))) {
    fail("DISPATCH_READINESS_SECRET_REJECTED");
  }

  return data;
}

function normalizeCapacitySnapshot(capacitySnapshot, expectedAgentId) {
  if (!Array.isArray(capacitySnapshot)) {
    fail("DISPATCH_READINESS_CAPACITY_SNAPSHOT_REQUIRED");
  }

  const seen = new Set();
  return capacitySnapshot.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.providerId !== "string") {
      fail("DISPATCH_READINESS_CAPACITY_ENTRY_INVALID");
    }
    if (!CANONICAL_PROVIDERS[entry.providerId]) {
      fail("DISPATCH_READINESS_FABRICATED_PROVIDER_REJECTED");
    }
    if (seen.has(entry.providerId)) {
      fail("DISPATCH_READINESS_DUPLICATE_PROVIDER_REJECTED");
    }
    seen.add(entry.providerId);
    if (entry.agentId !== expectedAgentId) {
      fail("DISPATCH_READINESS_CAPACITY_SCOPE_MISMATCH");
    }
    if (SECRET_PATTERN.test(JSON.stringify(entry))) {
      fail("DISPATCH_READINESS_SECRET_REJECTED");
    }

    return Object.freeze({
      providerId: entry.providerId,
      eligible:
        entry.approved === true &&
        entry.available === true &&
        entry.costMode === "zero" &&
        entry.billingEnabled !== true &&
        entry.overageAllowed !== true
    });
  });
}

export function evaluateApprovedFreeDispatchReadiness({
  checkpoint,
  agentPolicy,
  capacitySnapshot
}) {
  const expectedAgentId = policyAgentId(agentPolicy);
  if (!expectedAgentId) {
    fail("DISPATCH_READINESS_AGENT_POLICY_REQUIRED");
  }

  const checkpointData = validateCheckpoint(checkpoint, expectedAgentId);
  const capacity = normalizeCapacitySnapshot(capacitySnapshot, expectedAgentId);

  let route;
  try {
    route = resolveChain(agentPolicy, { costMode: "zero" });
  } catch (error) {
    if (error instanceof RoutingError) {
      fail("DISPATCH_READINESS_AGENT_POLICY_INVALID");
    }
    throw error;
  }

  const approvedFree = new Set(
    capacity.filter((entry) => entry.eligible).map((entry) => entry.providerId)
  );
  const eligibleProviderIds = Object.freeze(
    route.filter((providerId) => approvedFree.has(providerId))
  );

  return Object.freeze({
    schemaVersion: 1,
    ownerId: checkpointData.ownerId,
    agentId: checkpointData.agentId,
    capability: checkpointData.capability,
    state: "WAITING_FOR_QUOTA",
    approvedFreeCapacityAvailable: eligibleProviderIds.length > 0,
    eligibleProviderIds,
    providerSelection: "not_performed",
    executionStarted: false,
    providerCallStarted: false
  });
}
