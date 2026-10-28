import { CANONICAL_PROVIDERS } from "./config.js";
import { evaluateApprovedFreeDispatchReadiness } from "./dispatchReadiness.js";

const REMOTE_SLOTS = new Set(["primary", "secondary", "tertiary"]);
const LOCAL_SLOTS = new Set(["emergency_1", "emergency_2"]);
const SECRET_PATTERN = /vault:\/\/|opaque:\/\/|password|api[_ -]?key|bearer\s/i;

export class DispatchAdmissionError extends Error {
  constructor(code) {
    super(code);
    this.name = "DispatchAdmissionError";
    this.code = code;
  }
}

function fail(code) {
  throw new DispatchAdmissionError(code);
}

function validateCandidate(candidate, checkpointData) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    candidate.ownerId !== checkpointData.ownerId ||
    candidate.agentId !== checkpointData.agentId ||
    candidate.capability !== checkpointData.capability ||
    typeof candidate.providerId !== "string" ||
    typeof candidate.slot !== "string"
  ) {
    fail("DISPATCH_ADMISSION_SCOPE_MISMATCH");
  }
  if (SECRET_PATTERN.test(JSON.stringify(candidate))) {
    fail("DISPATCH_ADMISSION_SECRET_REJECTED");
  }

  const provider = CANONICAL_PROVIDERS[candidate.providerId];
  if (!provider) fail("DISPATCH_ADMISSION_FABRICATED_PROVIDER_REJECTED");

  if (provider.kind === "local_open_source") {
    if (!LOCAL_SLOTS.has(candidate.slot) || candidate.credentialId != null) {
      fail("DISPATCH_ADMISSION_LOCAL_SLOT_INVALID");
    }
  } else {
    if (
      !REMOTE_SLOTS.has(candidate.slot) ||
      typeof candidate.credentialId !== "string" ||
      candidate.credentialId.length < 1 ||
      candidate.credentialId.length > 100
    ) {
      fail("DISPATCH_ADMISSION_REMOTE_SLOT_INVALID");
    }
  }
}

function validateReservation(reservation, scope) {
  if (
    !reservation ||
    reservation.status !== "reserved" ||
    reservation.ownerId !== scope.ownerId ||
    reservation.agentId !== scope.agentId ||
    reservation.slot !== scope.slot ||
    reservation.provider !== scope.provider ||
    reservation.credentialId !== scope.credentialId ||
    reservation.idempotencyKey !== scope.idempotencyKey ||
    reservation.units !== scope.units ||
    typeof reservation.id !== "string" ||
    reservation.id.length < 1
  ) {
    fail("DISPATCH_ADMISSION_RESERVATION_SCOPE_MISMATCH");
  }
}

export async function reserveApprovedFreeDispatchAdmission({
  checkpoint,
  agentPolicy,
  capacitySnapshot,
  candidate,
  quotaLedger
}) {
  if (
    !quotaLedger ||
    quotaLedger.isProductionDurable !== true ||
    typeof quotaLedger.reserve !== "function"
  ) {
    fail("DISPATCH_ADMISSION_DURABLE_QUOTA_REQUIRED");
  }
  if (!checkpoint || typeof checkpoint.taskId !== "string" || checkpoint.taskId.length < 1) {
    fail("DISPATCH_ADMISSION_CHECKPOINT_TASK_REQUIRED");
  }

  const readiness = evaluateApprovedFreeDispatchReadiness({
    checkpoint,
    agentPolicy,
    capacitySnapshot
  });
  validateCandidate(candidate, checkpoint.data);

  if (!readiness.eligibleProviderIds.includes(candidate.providerId)) {
    fail("DISPATCH_ADMISSION_APPROVED_FREE_CAPACITY_REQUIRED");
  }

  const scope = Object.freeze({
    ownerId: checkpoint.data.ownerId,
    agentId: checkpoint.data.agentId,
    slot: candidate.slot,
    provider: candidate.providerId,
    credentialId: candidate.credentialId ?? null,
    idempotencyKey: `${checkpoint.taskId}:dispatch-admission:${candidate.providerId}`,
    units: 1
  });

  const reservation = await quotaLedger.reserve(scope);
  validateReservation(reservation, scope);

  return Object.freeze({
    schemaVersion: 1,
    checkpointTaskId: checkpoint.taskId,
    checkpointState: "WAITING_FOR_QUOTA",
    ownerId: scope.ownerId,
    agentId: scope.agentId,
    capability: checkpoint.data.capability,
    admittedProviderId: scope.provider,
    admittedSlot: scope.slot,
    reservationId: reservation.id,
    reservationStatus: "reserved",
    executionStarted: false,
    providerCallStarted: false
  });
}
