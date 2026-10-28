import test from "node:test";
import assert from "node:assert/strict";
import { deterministicJarvisContentHandler } from "../src/jarvis/deterministicContentWorkflow.js";
import { createDeterministicNarrationPlan } from "../src/jarvis/deterministicNarrationPlan.js";
import {
  createDeterministicAudioDispatch,
  createWaitingForQuotaCheckpoint,
  deterministicAudioDispatchHandler,
} from "../src/jarvis/deterministicAudioDispatch.js";
import { WorkEnvelope } from "../src/workers/workEnvelope.js";

async function narrationPlan() {
  const outline = await deterministicJarvisContentHandler({
    agentId: "agent-01",
    jobType: "jarvis.content.outline.v1",
    payload: {
      publicBrand: "Raat Ki Awaaz",
      concept: "Ek sunsaan pahadi hostel mein band kamre se har raat kisi bachche ki ghanti sunai deti hai.",
      language: "hinglish",
      targetMinutes: 27,
    },
    heartbeat() {},
    checkpoint: async () => {},
  });
  return createDeterministicNarrationPlan(outline);
}

test("creates stable WorkEnvelope-compatible narration and cue dispatch requests without side effects", async () => {
  const source = await narrationPlan();
  const first = createDeterministicAudioDispatch(source, { ownerId: "owner-test" });
  const second = createDeterministicAudioDispatch(source, { ownerId: "owner-test" });
  assert.deepEqual(second, first);
  assert.equal(first.readiness, "dispatch_ready_only");
  assert.equal(first.capability, "audio_generation");
  assert.equal(first.requests.length, 6);
  assert.equal(first.requests.filter(({ payload }) => payload.requestKind === "narration_tts").length, 5);
  assert.equal(first.requests.at(-1).payload.requestKind, "cue_planning");
  for (const request of first.requests) {
    assert.ok(request instanceof WorkEnvelope);
    assert.equal(request.payload.capability, "audio_generation");
    assert.equal(Object.hasOwn(request.payload, "providerSelection"), false);
    assert.equal(request.payload.executionStatus, "not_started");
  }
  assert.equal(Object.hasOwn(first, "credentials"), false);
  assert.deepEqual(first.providerCalls, []);
  assert.deepEqual(first.evidence, []);
  assert.deepEqual(first.artifacts, []);
  assert.equal(first.publication.status, "not_requested");
  assert.doesNotMatch(JSON.stringify(first), /vault:\/\/|opaque:\/\/|secretLocator|credentialRef/);
});

test("constructs a deterministic resumable WAITING_FOR_QUOTA checkpoint without provider calls", async () => {
  const dispatch = createDeterministicAudioDispatch(await narrationPlan(), { ownerId: "owner-test" });
  const first = createWaitingForQuotaCheckpoint(dispatch);
  const second = createWaitingForQuotaCheckpoint(dispatch);
  assert.deepEqual(second, first);
  assert.equal(first.state, "WAITING_FOR_QUOTA");
  assert.equal(first.reasonCode, "APPROVED_FREE_CAPACITY_UNAVAILABLE");
  assert.equal(first.resumable, true);
  assert.equal(first.pendingTaskIds.length, 6);
  assert.deepEqual(first.providerCalls, []);
});

test("handler enforces scope and records dispatch-only checkpoints", async () => {
  const source = await narrationPlan();
  const checkpoints = [];
  const context = {
    agentId: "agent-01",
    jobType: "jarvis.audio.dispatch.v1",
    payload: { narrationPlan: source },
    context: { ownerId: "owner-test" },
    heartbeat() {},
    checkpoint: async (...entry) => checkpoints.push(entry),
  };
  const plan = await deterministicAudioDispatchHandler(context);
  assert.equal(plan.readiness, "dispatch_ready_only");
  assert.deepEqual(checkpoints.map(([step]) => step), ["audio_dispatch_validated", "audio_dispatch_ready"]);
  await assert.rejects(deterministicAudioDispatchHandler({ ...context, agentId: "agent-02" }), /SCOPE_MISMATCH/);
});

test("rejects malformed contracts, names, secrets, durations, cues and side-effect claims", async () => {
  const source = await narrationPlan();
  assert.throws(() => createDeterministicAudioDispatch({ ...source, readiness: "audio_ready" }, { ownerId: "owner-test" }), /SOURCE_CONTRACT_MISMATCH/);
  assert.throws(() => createDeterministicAudioDispatch({ ...source, publicBrand: "NISHA Audio" }, { ownerId: "owner-test" }), /INTERNAL_NAME_REJECTED/);
  assert.throws(() => createDeterministicAudioDispatch({ ...source, publicBrand: "api_key=unsafe-value" }, { ownerId: "owner-test" }), /SECRET_REJECTED/);
  assert.throws(() => createDeterministicAudioDispatch({ ...source, targetMinutes: 26 }, { ownerId: "owner-test" }), /TOTAL_DURATION_MISMATCH/);
  assert.throws(() => createDeterministicAudioDispatch({ ...source, cuePlan: source.cuePlan.slice(1) }, { ownerId: "owner-test" }), /CUES_INVALID/);
  assert.throws(() => createDeterministicAudioDispatch({ ...source, generatedAudio: [{ fake: true }] }, { ownerId: "owner-test" }), /SIDE_EFFECT_CLAIMED/);
  assert.throws(() => createDeterministicAudioDispatch(source, { ownerId: "owner-test", agentId: "agent-02" }), /SCOPE_MISMATCH/);
});
