import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createDeterministicScriptDispatchRequest,
  createWaitingForQuotaCheckpoint,
} from "../src/jarvis/deterministicScriptDispatch.js";
import { WorkEnvelope } from "../src/workers/workEnvelope.js";

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scriptPlan(overrides = {}) {
  const sections = overrides.sections || [
    { order: 1, beat: "hook", targetMinutes: 3, writingDirection: "Open with an immediate unsettling event grounded in the supplied concept.", languageStyle: "natural_hinglish" },
    { order: 2, beat: "discovery", targetMinutes: 5, writingDirection: "Reveal the local mystery without explaining its supernatural cause.", languageStyle: "natural_hinglish" },
    { order: 3, beat: "escalation", targetMinutes: 7, writingDirection: "Increase danger, emotional pressure, and uncertainty.", languageStyle: "natural_hinglish" },
    { order: 4, beat: "reversal", targetMinutes: 6, writingDirection: "Introduce a fair but surprising change in what the audience believes.", languageStyle: "natural_hinglish" },
    { order: 5, beat: "cliffhanger", targetMinutes: 6, writingDirection: "End with unresolved danger without revealing the final truth.", languageStyle: "natural_hinglish" },
  ];
  const base = {
    schemaVersion: 1,
    packageType: "jarvis_mvp_script_plan",
    readiness: "script_plan_only",
    generationMode: "deterministic_local",
    sourcePackageId: "a".repeat(64),
    publicBrand: "Raat Ki Awaaz",
    language: "hinglish",
    targetMinutes: 27,
    suppliedConcept: "Ek sunsaan pahadi hostel mein har raat band kamre se ghanti sunai deti hai.",
    sections,
    providerCalls: [],
    artifacts: [],
    publication: { requested: false, status: "not_requested" },
    ...overrides,
  };
  if (!("planId" in overrides)) base.planId = stableId({ sourcePackageId: base.sourcePackageId, sections: base.sections });
  return base;
}

test("creates a deterministic WorkEnvelope-compatible provider-independent dispatch request", () => {
  const input = { ownerId: "owner-test", scriptPlan: scriptPlan() };
  const first = createDeterministicScriptDispatchRequest(input);
  const second = createDeterministicScriptDispatchRequest(input);
  assert.deepEqual(first, second);
  assert.doesNotThrow(() => new WorkEnvelope(first));
  assert.equal(first.agentId, "agent-01");
  assert.equal(first.payload.readiness, "dispatch_ready_only");
  assert.equal(first.payload.capability, "text_generation");
  assert.equal(first.context.capacityPolicy, "approved_free_only");
  assert.equal(first.context.dispatchMode, "provider_independent");
  for (const forbidden of ["provider", "credential", "execution", "evidence", "artifact", "publication"]) {
    assert.equal(Object.keys(first.payload).some((key) => key.toLowerCase().includes(forbidden)), false);
  }
});

test("constructs a stable truthful WAITING_FOR_QUOTA checkpoint without starting execution", () => {
  const request = createDeterministicScriptDispatchRequest({ ownerId: "owner-test", scriptPlan: scriptPlan() });
  const first = createWaitingForQuotaCheckpoint(request);
  assert.deepEqual(first, createWaitingForQuotaCheckpoint(request));
  assert.equal(first.state, "WAITING_FOR_QUOTA");
  assert.equal(first.reasonCode, "APPROVED_FREE_CAPACITY_UNAVAILABLE");
  assert.equal(first.resumable, true);
  assert.equal(first.executionStarted, false);
});

test("rejects malformed plans, tampering, secrets, internal names, and side-effect claims", () => {
  assert.throws(() => createDeterministicScriptDispatchRequest({ ownerId: "owner-test", scriptPlan: scriptPlan({ readiness: "script_ready" }) }), /TRUTHFULNESS_MISMATCH/);
  assert.throws(() => createDeterministicScriptDispatchRequest({ ownerId: "owner-test", scriptPlan: scriptPlan({ planId: "0".repeat(64) }) }), /PLAN_ID_MISMATCH/);
  assert.throws(() => createDeterministicScriptDispatchRequest({ ownerId: "owner-test", scriptPlan: scriptPlan({ suppliedConcept: "A sufficiently long concept containing api_key=secret must be rejected safely." }) }), /SECRET_REJECTED/);
  assert.throws(() => createDeterministicScriptDispatchRequest({ ownerId: "owner-test", scriptPlan: scriptPlan({ publicBrand: "NISHA Stories" }) }), /AGENT_NAME_REJECTED/);
  assert.throws(() => createDeterministicScriptDispatchRequest({ ownerId: "owner-test", scriptPlan: scriptPlan({ providerCalls: ["claimed-call"] }) }), /SIDE_EFFECT_CLAIM_REJECTED/);
  assert.throws(() => createWaitingForQuotaCheckpoint({ taskId: "invalid" }), /DISPATCH_INVALID/);
});
