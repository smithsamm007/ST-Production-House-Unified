import test from "node:test";
import assert from "node:assert/strict";
import {
  DispatchAdmissionLifecycleError,
  PostgresDispatchAdmissionLifecycle,
  buildDispatchAdmissionCheckpointTransition
} from "../src/providers/postgresDispatchAdmissionLifecycle.js";

const reservation = (overrides = {}) => ({
  id: "reservation-1",
  ownerId: "owner-test",
  agentId: "agent-01",
  slot: "emergency_1",
  provider: "p_local_fallback",
  credentialId: null,
  units: 1,
  ...overrides
});

const checkpoint = (overrides = {}) => ({
  taskId: `dispatch-${"a".repeat(64)}`,
  step: "script_dispatch_waiting_for_quota",
  progress: 0,
  data: {
    state: "WAITING_FOR_QUOTA",
    ownerId: "owner-test",
    agentId: "agent-01",
    capability: "text_generation",
    capacityPolicy: "approved_free_only",
    providerSelection: "not_performed",
    executionStarted: false,
    ...overrides
  },
  artifactRefs: [],
  evidenceRefs: [],
  updatedAt: "2026-08-24T00:00:00.000Z",
  payloadHash: "a".repeat(64),
  checksum: "b".repeat(64)
});

test("builds a truthful pre-execution admission checkpoint", () => {
  const source = checkpoint();
  const before = structuredClone(source);
  const result = buildDispatchAdmissionCheckpointTransition({
    checkpointRecord: source,
    reservation: reservation(),
    action: "claim",
    updatedAt: "2026-08-24T00:01:00.000Z"
  });

  assert.deepEqual(source, before);
  assert.equal(result.data.state, "DISPATCH_ADMITTED");
  assert.equal(result.data.reservationStatus, "reserved");
  assert.equal(result.data.providerSelection, "not_performed");
  assert.equal(result.data.executionStarted, false);
  assert.equal(result.data.providerCallStarted, false);
  assert.match(result.payloadHash, /^[0-9a-f]{64}$/);
  assert.match(result.checksum, /^[0-9a-f]{64}$/);
});

test("builds a truthful released checkpoint that can return to readiness", () => {
  const admitted = checkpoint({
    state: "DISPATCH_ADMITTED",
    reservationId: "reservation-1",
    reservationStatus: "reserved",
    admittedProviderId: "p_local_fallback",
    admittedSlot: "emergency_1"
  });
  const result = buildDispatchAdmissionCheckpointTransition({
    checkpointRecord: admitted,
    reservation: reservation(),
    action: "release",
    updatedAt: "2026-08-24T00:02:00.000Z"
  });

  assert.equal(result.data.state, "WAITING_FOR_QUOTA");
  assert.equal(result.data.reasonCode, "DISPATCH_ADMISSION_RELEASED");
  assert.equal(result.data.reservationStatus, "released");
  assert.equal(result.data.admittedProviderId, null);
  assert.equal(result.data.executionStarted, false);
  assert.equal(result.data.providerCallStarted, false);
});

test("rejects scope drift, invalid state, action, and timestamp", () => {
  const attempts = [
    () => buildDispatchAdmissionCheckpointTransition({
      checkpointRecord: checkpoint({ ownerId: "owner-other" }),
      reservation: reservation(), action: "claim", updatedAt: new Date().toISOString()
    }),
    () => buildDispatchAdmissionCheckpointTransition({
      checkpointRecord: checkpoint({ state: "DISPATCH_ADMITTED" }),
      reservation: reservation(), action: "claim", updatedAt: new Date().toISOString()
    }),
    () => buildDispatchAdmissionCheckpointTransition({
      checkpointRecord: checkpoint(), reservation: reservation(), action: "commit",
      updatedAt: new Date().toISOString()
    }),
    () => buildDispatchAdmissionCheckpointTransition({
      checkpointRecord: checkpoint(), reservation: reservation(), action: "claim", updatedAt: "invalid"
    })
  ];
  for (const attempt of attempts) assert.throws(attempt, DispatchAdmissionLifecycleError);
});

test("fails malformed and secret-bearing input before starting a transaction", async () => {
  let transactions = 0;
  const lifecycle = new PostgresDispatchAdmissionLifecycle({
    async withTransaction() {
      transactions += 1;
      throw new Error("should not run");
    }
  });
  const base = {
    reservation: reservation(),
    checkpointTaskId: `dispatch-${"a".repeat(64)}`,
    expectedPayloadHash: "a".repeat(64)
  };
  await assert.rejects(lifecycle.claim({ ...base, expectedPayloadHash: "stale" }), DispatchAdmissionLifecycleError);
  await assert.rejects(
    lifecycle.claim({ ...base, reservation: reservation({ metadata: "vault://secret" }) }),
    (error) => error.code === "DISPATCH_ADMISSION_LIFECYCLE_SECRET_REJECTED"
  );
  assert.equal(transactions, 0);
});

test("propagates transaction failure without a provider execution fallback", async () => {
  const calls = [];
  const lifecycle = new PostgresDispatchAdmissionLifecycle({
    async withTransaction() {
      calls.push("transaction");
      throw new Error("DATABASE_TRANSACTION_FAILED");
    }
  });
  await assert.rejects(
    lifecycle.claim({
      reservation: reservation(),
      checkpointTaskId: `dispatch-${"a".repeat(64)}`,
      expectedPayloadHash: "a".repeat(64)
    }),
    /DATABASE_TRANSACTION_FAILED/
  );
  assert.deepEqual(calls, ["transaction"]);
});
