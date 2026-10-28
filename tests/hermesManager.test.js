/**
 * Hermes manager decision-layer tests (Issue #166).
 *
 * Honest-evidence scope (Rule 1): these tests verify the decision lifecycle
 * in isolation — classification, secret-gating, append-only audit history,
 * and evidence-gated completion. They prove nothing about live execution;
 * no providers, no publishing, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  HermesManager,
  InMemoryHermesDecisionStore,
  assertDecisionPayloadSafe,
  hermesDecisionDto,
} from "../src/manager/hermesManager.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const FUTURE = new Date(Date.now() + 60_000).toISOString();

function buildManager() {
  const store = new InMemoryHermesDecisionStore();
  let counter = 0;
  const manager = new HermesManager(store, {
    nextDecisionNumber: async () => {
      counter += 1;
      return counter;
    },
  });
  return { manager, store };
}

test("autonomous decision is recorded as EXECUTING with matrix authority", async () => {
  const { manager } = buildManager();
  const decision = await manager.decide({
    action: "production.start",
    directorId: "agent-01",
    category: "production",
    reason: "Scheduled daily production slot available.",
    payload: { providerKey: "gemini", expectedOutputs: ["episode", "shorts"] },
  }, { now: NOW });
  assert.equal(decision.outcome, "EXECUTING");
  assert.equal(decision.authority, "AUTONOMOUS");
  assert.equal(decision.decisionNumber, 1);
  assert.equal(decision.reasonCode, "AUTONOMOUS_WITHIN_OWNER_LIMITS");
});

test("credential requests are references — agentId/providerKey only", async () => {
  const { manager } = buildManager();
  const decision = await manager.decide({
    action: "provider.select",
    directorId: "agent-01",
    category: "providers",
    reason: "Provider A quota below threshold.",
    payload: { preferred: "provider-b" },
    credentialRequest: { agentId: "agent-01", providerKey: "gemini", scope: "production" },
  }, { now: NOW });
  assert.deepEqual(decision.credentialRequest, {
    agentId: "agent-01", providerKey: "gemini", scope: "production",
  });
  assert.ok(!JSON.stringify(decision).includes("AIza"), "no secret material in the record");
});

test("prohibited action is BLOCKED and recorded — refusals are audit evidence", async () => {
  const { manager, store } = buildManager();
  const decision = await manager.decide({
    action: "secrets.read_values",
    directorId: "agent-01",
    category: "security_refusal",
    reason: "Attempted secret access.",
  }, { now: NOW });
  assert.equal(decision.outcome, "BLOCKED");
  assert.equal(decision.reasonCode, "PROHIBITED_BY_AUTHORITY_MATRIX");
  assert.equal(store.size, 1, "refusal recorded");
});

test("unknown action fails closed to BLOCKED", async () => {
  const { manager } = buildManager();
  const decision = await manager.decide({
    action: "hermes.make_it_so",
    directorId: "agent-01",
    category: "production",
    reason: "Unclassified request.",
  }, { now: NOW });
  assert.equal(decision.outcome, "BLOCKED");
  assert.equal(decision.authority, "PROHIBITED");
});

test("owner-policy action without approval → OWNER_APPROVAL_REQUIRED; with approval → EXECUTING", async () => {
  const { manager } = buildManager();
  const refused = await manager.decide({
    action: "publishing.publish_publicly",
    directorId: "agent-01",
    category: "publishing",
    reason: "Release slot reached the owner gate.",
  }, { now: NOW });
  assert.equal(refused.outcome, "OWNER_APPROVAL_REQUIRED");

  const approved = await manager.decide({
    action: "publishing.publish_publicly",
    directorId: "agent-01",
    category: "publishing",
    reason: "Owner pre-approved this release.",
    ownerApproval: { ownerId: "owner-1", expiresAt: FUTURE },
  }, { now: NOW });
  assert.equal(approved.outcome, "EXECUTING");
});

test("payload secret-gate: secret-shaped fields and values are rejected", async () => {
  const { manager } = buildManager();
  await assert.rejects(
    () => manager.decide({
      action: "production.start", directorId: "agent-01", category: "production",
      reason: "r", payload: { api_key: "vault://x" },
    }, { now: NOW }),
    /SECRET_FIELD_REJECTED/,
  );
  await assert.rejects(
    () => manager.decide({
      action: "production.start", directorId: "agent-01", category: "production",
      reason: "r", payload: { note: "AIzaSyD-1234567890abcdefghijklmnopqrstu" },
    }, { now: NOW }),
    /SECRET_VALUE_REJECTED/,
  );
  await assert.rejects(
    () => manager.decide({
      action: "production.start", directorId: "agent-01", category: "production",
      reason: "r", payload: { nested: { deep: { token: "abc" } } },
    }, { now: NOW }),
    /SECRET_FIELD_REJECTED/,
  );
});

test("payload validator rejects hostile shapes and oversized input", () => {
  assert.throws(() => assertDecisionPayloadSafe({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }), /PAYLOAD_TOO_DEEP/);
  assert.throws(() => assertDecisionPayloadSafe({ list: Array.from({ length: 51 }, (_, i) => i) }), /PAYLOAD_TOO_LARGE/);
  assert.throws(() => assertDecisionPayloadSafe({ s: "x".repeat(501) }), /PAYLOAD_VALUE_TOO_LONG/);
  assert.throws(() => assertDecisionPayloadSafe(42), /PAYLOAD_TYPE_INVALID/);
  assert.throws(() => assertDecisionPayloadSafe({ when: new Date() }), /PAYLOAD_TYPE_INVALID/);
});

test("decision history is append-only: completion SUPERSEDES, never mutates", async () => {
  const { manager, store } = buildManager();
  await manager.decide({
    action: "production.start", directorId: "agent-01", category: "production",
    reason: "Slot available.", payload: { slot: 42 },
  }, { now: NOW });

  await manager.completeDecision(1, {
    succeeded: true,
    evidenceReceiptId: "receipt-1",
    fetchEvidence: async () => ({ found: true }),
  });
  assert.equal(store.size, 2, "original EXECUTING record is preserved");
  const history = await manager.listDecisions({});
  assert.equal(history[0].outcome, "EXECUTED");
  assert.equal(history[0].reasonCode, "EVIDENCE_VERIFIED");
  assert.equal(history[1].outcome, "EXECUTING", "audit trail keeps the original state");
});

test("completion WITHOUT ledger verification stays FAILED (Rule 1)", async () => {
  const { manager } = buildManager();
  await manager.decide({
    action: "production.start", directorId: "agent-01", category: "production",
    reason: "Slot available.",
  }, { now: NOW });

  const unverified = await manager.completeDecision(1, {
    succeeded: true,
    evidenceReceiptId: "receipt-x",
    fetchEvidence: async () => ({ found: false }),
  });
  assert.equal(unverified.outcome, "FAILED");
  assert.equal(unverified.reasonCode, "EVIDENCE_UNVERIFIED");

  const noLookup = await manager.decide({
    action: "production.retry", directorId: "agent-01", category: "production",
    reason: "Transient failure.",
  }, { now: NOW });
  assert.equal(noLookup.outcome, "EXECUTING");
  await assert.rejects(
    () => manager.completeDecision(2, { succeeded: true, evidenceReceiptId: "r" }),
    /EVIDENCE_LOOKUP_REQUIRED/,
  );
});

test("failure completion records truthful FAILED with error details", async () => {
  const { manager } = buildManager();
  await manager.decide({
    action: "provider.rotate_failed", directorId: "agent-02", category: "providers",
    reason: "Provider B failed.",
  }, { now: NOW });
  const failed = await manager.completeDecision(1, {
    succeeded: false, errorCode: "PROVIDER_TIMEOUT", detail: "Provider C also timed out.",
  });
  assert.equal(failed.outcome, "FAILED");
  assert.equal(failed.reasonCode, "EXECUTION_FAILED");
  assert.equal(failed.errorCode, "PROVIDER_TIMEOUT");
});

test("completion guards: unknown or non-executing decisions are rejected", async () => {
  const { manager } = buildManager();
  await manager.decide({
    action: "secrets.export_keys", directorId: "agent-01", category: "security_refusal",
    reason: "Attempt.",
  }, { now: NOW });
  await assert.rejects(() => manager.completeDecision(999, { succeeded: false }), /DECISION_NOT_FOUND/);
  await assert.rejects(
    () => manager.completeDecision(1, { succeeded: false }),
    /DECISION_NOT_EXECUTING/,
    "BLOCKED decisions cannot be 'completed'",
  );
  await assert.rejects(() => manager.completeDecision(0, { succeeded: false }), /DECISION_NUMBER_INVALID/);
  await assert.rejects(() => manager.completeDecision(1.5, { succeeded: false }), /DECISION_NUMBER_INVALID/);
});

test("overview summarizes outcomes, categories, refusals, and pending approvals", async () => {
  const { manager } = buildManager();
  await manager.decide({ action: "production.start", directorId: "agent-01", category: "production", reason: "r" }, { now: NOW });
  await manager.decide({ action: "secrets.read_values", directorId: "agent-01", category: "security_refusal", reason: "r" }, { now: NOW });
  await manager.decide({ action: "publishing.publish_publicly", directorId: "agent-01", category: "publishing", reason: "r" }, { now: NOW });
  const summary = await manager.overview();
  assert.equal(summary.decisions.EXECUTING, 1);
  assert.equal(summary.blockedRefusals, 1);
  assert.equal(summary.pendingOwnerApproval, 1);
  assert.equal(summary.byCategory.production, 1);
  assert.equal(summary.lastDecisionNumber, 3);
});

test("category filter and list bounds behave", async () => {
  const { manager } = buildManager();
  await manager.decide({ action: "production.start", directorId: "a", category: "production", reason: "r" }, { now: NOW });
  await manager.decide({ action: "provider.select", directorId: "a", category: "providers", reason: "r" }, { now: NOW });
  const onlyProviders = await manager.listDecisions({ category: "providers" });
  assert.equal(onlyProviders.length, 1);
  assert.equal(onlyProviders[0].category, "providers");
  await assert.rejects(
    () => manager.decide({ action: "production.start", directorId: "a", category: "nope", reason: "r" }),
    /DECISION_CATEGORY_INVALID/,
  );
});

test("DTO is an explicit allowlist and never invents fields", () => {
  const dto = hermesDecisionDto({
    decisionNumber: 7, action: "production.start", authority: "AUTONOMOUS",
    directorId: "agent-01", category: "production", reason: "r",
    outcome: "EXECUTING", reasonCode: "AUTONOMOUS_WITHIN_OWNER_LIMITS",
    payload: {}, credentialRequest: null,
    secretField: "should-never-appear",
    createdAt: NOW.toISOString(),
  });
  assert.equal(Object.keys(dto).length, 13);
  assert.ok(!("secretField" in dto));
  assert.ok(!JSON.stringify(dto).includes("should-never-appear"));
});
