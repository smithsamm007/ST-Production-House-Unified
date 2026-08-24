import test from "node:test";
import assert from "node:assert/strict";
import {
  DispatchAdmissionError,
  reserveApprovedFreeDispatchAdmission
} from "../src/providers/dispatchAdmission.js";

const checkpoint = (taskId = "dispatch-" + "a".repeat(64)) => ({
  taskId,
  data: {
    state: "WAITING_FOR_QUOTA",
    ownerId: "owner-test",
    agentId: "agent-01",
    capability: "text_generation",
    capacityPolicy: "approved_free_only",
    providerSelection: "not_performed",
    executionStarted: false
  }
});

const capacity = (overrides = {}) => ({
  providerId: "p_local_fallback",
  agentId: "agent-01",
  approved: true,
  available: true,
  costMode: "zero",
  billingEnabled: false,
  overageAllowed: false,
  ...overrides
});

const candidate = (overrides = {}) => ({
  ownerId: "owner-test",
  agentId: "agent-01",
  capability: "text_generation",
  providerId: "p_local_fallback",
  slot: "emergency_1",
  credentialId: null,
  ...overrides
});

function durableLedger() {
  const reservations = new Map();
  const calls = [];
  return {
    isProductionDurable: true,
    calls,
    async reserve(scope) {
      calls.push(structuredClone(scope));
      if (!reservations.has(scope.idempotencyKey)) {
        reservations.set(scope.idempotencyKey, {
          id: "reservation-" + (reservations.size + 1),
          ...scope,
          status: "reserved"
        });
      }
      return reservations.get(scope.idempotencyKey);
    }
  };
}

test("durably reserves an approved-free local admission without starting execution", async () => {
  const quotaLedger = durableLedger();
  const source = checkpoint();
  const before = structuredClone(source);
  const result = await reserveApprovedFreeDispatchAdmission({
    checkpoint: source,
    agentPolicy: "agent-01",
    capacitySnapshot: [capacity()],
    candidate: candidate(),
    quotaLedger
  });

  assert.equal(result.checkpointState, "WAITING_FOR_QUOTA");
  assert.equal(result.reservationStatus, "reserved");
  assert.equal(result.admittedProviderId, "p_local_fallback");
  assert.equal(result.executionStarted, false);
  assert.equal(result.providerCallStarted, false);
  assert.deepEqual(source, before);
  assert.deepEqual(quotaLedger.calls[0], {
    ownerId: "owner-test",
    agentId: "agent-01",
    slot: "emergency_1",
    provider: "p_local_fallback",
    credentialId: null,
    idempotencyKey: `${source.taskId}:dispatch-admission:p_local_fallback`,
    units: 1
  });
});

test("repeated admission is idempotent for the same checkpoint and provider", async () => {
  const quotaLedger = durableLedger();
  const args = {
    checkpoint: checkpoint(),
    agentPolicy: "agent-01",
    capacitySnapshot: [capacity()],
    candidate: candidate(),
    quotaLedger
  };
  const first = await reserveApprovedFreeDispatchAdmission(args);
  const second = await reserveApprovedFreeDispatchAdmission(args);
  assert.deepEqual(second, first);
  assert.equal(quotaLedger.calls.length, 2);
});

test("rejects non-durable quota and ineligible capacity before reservation", async () => {
  await assert.rejects(
    reserveApprovedFreeDispatchAdmission({
      checkpoint: checkpoint(),
      agentPolicy: "agent-01",
      capacitySnapshot: [capacity()],
      candidate: candidate(),
      quotaLedger: { isProductionDurable: false, reserve: async () => null }
    }),
    (error) => error.code === "DISPATCH_ADMISSION_DURABLE_QUOTA_REQUIRED"
  );

  const quotaLedger = durableLedger();
  await assert.rejects(
    reserveApprovedFreeDispatchAdmission({
      checkpoint: checkpoint(),
      agentPolicy: "agent-01",
      capacitySnapshot: [capacity({ available: false })],
      candidate: candidate(),
      quotaLedger
    }),
    (error) => error.code === "DISPATCH_ADMISSION_APPROVED_FREE_CAPACITY_REQUIRED"
  );
  assert.equal(quotaLedger.calls.length, 0);
});

test("rejects scope, slot, credential, and secret drift before reservation", async () => {
  const attempts = [
    candidate({ ownerId: "owner-other" }),
    candidate({ agentId: "agent-02" }),
    candidate({ capability: "image_generation" }),
    candidate({ slot: "primary" }),
    candidate({ credentialId: "credential-1" }),
    candidate({ metadata: "vault://secret" })
  ];

  for (const admissionCandidate of attempts) {
    const quotaLedger = durableLedger();
    await assert.rejects(
      reserveApprovedFreeDispatchAdmission({
        checkpoint: checkpoint(),
        agentPolicy: "agent-01",
        capacitySnapshot: [capacity()],
        candidate: admissionCandidate,
        quotaLedger
      }),
      DispatchAdmissionError
    );
    assert.equal(quotaLedger.calls.length, 0);
  }
});

test("fails closed when durable quota returns a mismatched reservation", async () => {
  const quotaLedger = {
    isProductionDurable: true,
    async reserve(scope) {
      return {
        id: "reservation-forged",
        ...scope,
        ownerId: "owner-other",
        status: "reserved"
      };
    }
  };
  await assert.rejects(
    reserveApprovedFreeDispatchAdmission({
      checkpoint: checkpoint(),
      agentPolicy: "agent-01",
      capacitySnapshot: [capacity()],
      candidate: candidate(),
      quotaLedger
    }),
    (error) => error.code === "DISPATCH_ADMISSION_RESERVATION_SCOPE_MISMATCH"
  );
});

test("propagates reservation failure without committing or executing", async () => {
  const calls = [];
  const quotaLedger = {
    isProductionDurable: true,
    async reserve() {
      calls.push("reserve");
      throw new Error("QUOTA_RESERVATION_FAILED: quota_exceeded");
    },
    async commit() {
      calls.push("commit");
    }
  };
  await assert.rejects(
    reserveApprovedFreeDispatchAdmission({
      checkpoint: checkpoint(),
      agentPolicy: "agent-01",
      capacitySnapshot: [capacity()],
      candidate: candidate(),
      quotaLedger
    }),
    /quota_exceeded/
  );
  assert.deepEqual(calls, ["reserve"]);
});
