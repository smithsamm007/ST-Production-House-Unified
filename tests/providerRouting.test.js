import test from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_PROVIDERS } from "../src/providers/config.js";
import { resolveChain, RoutingError, createFailoverEvidence } from "../src/providers/router.js";

test("Canonical provider registry contains exactly 3 remote slots and 1 keyless local fallback", () => {
  assert.equal(Object.keys(CANONICAL_PROVIDERS).length, 4);
  assert.equal(CANONICAL_PROVIDERS.p_remote_1.enabled, false);
  assert.equal(CANONICAL_PROVIDERS.p_remote_2.enabled, false);
  assert.equal(CANONICAL_PROVIDERS.p_remote_3.enabled, false);
  assert.equal(CANONICAL_PROVIDERS.p_local_fallback.enabled, true);
  assert.equal(CANONICAL_PROVIDERS.p_local_fallback.keyless, true);
});

test("Deterministic: same inputs produce identical chain over 100 iterations", () => {
  const policy = {
    agentId: "agent-01",
    providers: [
      { id: "p_remote_1", priority: 1, enabled: true },
      { id: "p_remote_2", priority: 2, enabled: true },
      { id: "p_local_fallback", priority: 3, enabled: true }
    ]
  };
  const ctx = { costMode: "default" };

  const baseline = resolveChain(policy, ctx);
  assert.deepEqual(baseline, ["p_remote_1", "p_remote_2", "p_local_fallback"]);

  for (let i = 0; i < 100; i++) {
    const current = resolveChain(policy, ctx);
    assert.deepEqual(current, baseline);
  }
});

test("Disabled providers never appear in any chain", () => {
  const policy = {
    agentId: "agent-01",
    providers: [
      { id: "p_remote_1", priority: 1, enabled: true },
      { id: "p_remote_2", priority: 2, enabled: false },
      { id: "p_remote_3", priority: 3, enabled: false },
      { id: "p_local_fallback", priority: 4, enabled: true }
    ]
  };

  const chain = resolveChain(policy, { costMode: "default" });
  assert.deepEqual(chain, ["p_remote_1", "p_local_fallback"]);
  assert.equal(chain.includes("p_remote_2"), false);
  assert.equal(chain.includes("p_remote_3"), false);
});

test("Zero-cost mode reorders keyless local fallback FIRST", () => {
  const policy = {
    agentId: "agent-01",
    providers: [
      { id: "p_remote_1", priority: 1, enabled: true },
      { id: "p_remote_2", priority: 2, enabled: true },
      { id: "p_local_fallback", priority: 3, enabled: true }
    ]
  };

  const defaultChain = resolveChain(policy, { costMode: "default" });
  assert.deepEqual(defaultChain, ["p_remote_1", "p_remote_2", "p_local_fallback"]);

  const zeroCostChain = resolveChain(policy, { costMode: "zero" });
  assert.deepEqual(zeroCostChain, ["p_local_fallback", "p_remote_1", "p_remote_2"]);
});

test("Unknown agent policy throws RoutingError without silent fallback", () => {
  assert.throws(() => resolveChain(null), RoutingError);
  assert.throws(() => resolveChain(undefined), RoutingError);
  assert.throws(() => resolveChain("unknown_agent_policy_xyz"), RoutingError);
  assert.throws(() => resolveChain({}), RoutingError);
  assert.throws(() => resolveChain({ agentId: "agent-01", providers: [] }), RoutingError);
});

test("Fabricated providers are rejected and throw RoutingError", () => {
  const policyWithFabricated = {
    agentId: "agent-01",
    providers: [
      { id: "p_remote_1", priority: 1, enabled: true },
      { id: "p_fabricated_provider_99", priority: 2, enabled: true }
    ]
  };

  assert.throws(() => resolveChain(policyWithFabricated), (err) => {
    return err instanceof RoutingError && err.message.includes("Fabricated provider rejected");
  });
});

test("Emits pure-data failover evidence objects", () => {
  const policy = {
    agentId: "agent-01",
    providers: [
      { id: "p_remote_1", priority: 1, enabled: true },
      { id: "p_remote_2", priority: 2, enabled: true },
      { id: "p_local_fallback", priority: 3, enabled: true }
    ]
  };

  const chain = resolveChain(policy, {
    costMode: "default",
    reasons: {
      p_remote_1: "PRIMARY_SLOT_FAILED",
      p_remote_2: "SECONDARY_SLOT_FAILED",
      p_local_fallback: "EMERGENCY_FALLBACK"
    }
  });

  const evidence = chain.evidence;
  assert.equal(Array.isArray(evidence), true);
  assert.equal(evidence.length, 3);

  assert.deepEqual(evidence[0], { attempt: 1, providerId: "p_remote_1", reason: "PRIMARY_SLOT_FAILED" });
  assert.deepEqual(evidence[1], { attempt: 2, providerId: "p_remote_2", reason: "SECONDARY_SLOT_FAILED" });
  assert.deepEqual(evidence[2], { attempt: 3, providerId: "p_local_fallback", reason: "EMERGENCY_FALLBACK" });

  const standaloneEvidence = createFailoverEvidence(["p_remote_1", "p_local_fallback"]);
  assert.equal(standaloneEvidence.length, 2);
  assert.equal(standaloneEvidence[0].attempt, 1);
  assert.equal(standaloneEvidence[0].providerId, "p_remote_1");
  assert.equal(standaloneEvidence[1].attempt, 2);
  assert.equal(standaloneEvidence[1].providerId, "p_local_fallback");
});
