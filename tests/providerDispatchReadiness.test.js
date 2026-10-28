import test from "node:test";
import assert from "node:assert/strict";
import {
  DispatchReadinessError,
  evaluateApprovedFreeDispatchReadiness
} from "../src/providers/dispatchReadiness.js";

const checkpoint = (capability = "text_generation", agentId = "agent-01") => ({
  step: "dispatch_waiting_for_quota",
  progress: 0,
  data: {
    schemaVersion: 1,
    state: "WAITING_FOR_QUOTA",
    reasonCode: "APPROVED_FREE_CAPACITY_UNAVAILABLE",
    resumable: true,
    executionStarted: false,
    ownerId: "owner-test",
    agentId,
    capability,
    capacityPolicy: "approved_free_only",
    providerSelection: "not_performed"
  }
});

const localCapacity = (overrides = {}) => ({
  providerId: "p_local_fallback",
  agentId: "agent-01",
  approved: true,
  available: true,
  costMode: "zero",
  billingEnabled: false,
  overageAllowed: false,
  ...overrides
});

test("keeps script, visual, and audio checkpoints truthful while evaluating readiness", () => {
  for (const capability of ["text_generation", "image_generation", "audio_generation"]) {
    const source = checkpoint(capability);
    const before = structuredClone(source);
    const result = evaluateApprovedFreeDispatchReadiness({
      checkpoint: source,
      agentPolicy: "agent-01",
      capacitySnapshot: [localCapacity()]
    });

    assert.equal(result.state, "WAITING_FOR_QUOTA");
    assert.equal(result.approvedFreeCapacityAvailable, true);
    assert.deepEqual(result.eligibleProviderIds, ["p_local_fallback"]);
    assert.equal(result.providerSelection, "not_performed");
    assert.equal(result.executionStarted, false);
    assert.equal(result.providerCallStarted, false);
    assert.deepEqual(source, before);
  }
});

test("requires explicit approved, free, available capacity and never treats routing config as capacity", () => {
  const cases = [
    [],
    [localCapacity({ approved: false })],
    [localCapacity({ available: false })],
    [localCapacity({ costMode: "paid" })],
    [localCapacity({ billingEnabled: true })],
    [localCapacity({ overageAllowed: true })]
  ];

  for (const capacitySnapshot of cases) {
    const result = evaluateApprovedFreeDispatchReadiness({
      checkpoint: checkpoint(),
      agentPolicy: "agent-01",
      capacitySnapshot
    });
    assert.equal(result.approvedFreeCapacityAvailable, false);
    assert.deepEqual(result.eligibleProviderIds, []);
    assert.equal(result.providerSelection, "not_performed");
    assert.equal(result.executionStarted, false);
  }
});

test("disabled providers remain ineligible even when a snapshot claims capacity", () => {
  const result = evaluateApprovedFreeDispatchReadiness({
    checkpoint: checkpoint(),
    agentPolicy: "agent-01",
    capacitySnapshot: [{
      providerId: "p_remote_1",
      agentId: "agent-01",
      approved: true,
      available: true,
      costMode: "zero"
    }]
  });
  assert.deepEqual(result.eligibleProviderIds, []);
});

test("rejects cross-agent, fabricated, duplicate, and secret-bearing capacity data", () => {
  const attempts = [
    [localCapacity({ agentId: "agent-02" }), "DISPATCH_READINESS_CAPACITY_SCOPE_MISMATCH"],
    [{ ...localCapacity(), providerId: "invented-provider" }, "DISPATCH_READINESS_FABRICATED_PROVIDER_REJECTED"],
    [[localCapacity(), localCapacity()], "DISPATCH_READINESS_DUPLICATE_PROVIDER_REJECTED"],
    [localCapacity({ credentialRef: "vault://secret" }), "DISPATCH_READINESS_SECRET_REJECTED"]
  ];

  for (const [value, code] of attempts) {
    const capacitySnapshot = Array.isArray(value) ? value : [value];
    assert.throws(
      () => evaluateApprovedFreeDispatchReadiness({
        checkpoint: checkpoint(),
        agentPolicy: "agent-01",
        capacitySnapshot
      }),
      (error) => error instanceof DispatchReadinessError && error.code === code
    );
  }
});

test("rejects mutated checkpoint execution, selection, policy, scope, and secrets", () => {
  const mutations = [
    { executionStarted: true },
    { providerSelection: "p_local_fallback" },
    { capacityPolicy: "paid_allowed" },
    { state: "RUNNING" },
    { agentId: "agent-02" },
    { credentialRef: "opaque://secret" }
  ];

  for (const mutation of mutations) {
    const value = checkpoint();
    Object.assign(value.data, mutation);
    assert.throws(
      () => evaluateApprovedFreeDispatchReadiness({
        checkpoint: value,
        agentPolicy: "agent-01",
        capacitySnapshot: []
      }),
      DispatchReadinessError
    );
  }
});

test("is deterministic across repeated evaluations", () => {
  const args = {
    checkpoint: checkpoint(),
    agentPolicy: "agent-01",
    capacitySnapshot: [localCapacity()]
  };
  const expected = evaluateApprovedFreeDispatchReadiness(args);
  for (let index = 0; index < 100; index += 1) {
    assert.deepEqual(evaluateApprovedFreeDispatchReadiness(args), expected);
  }
});
