import test from "node:test";
import assert from "node:assert/strict";
import { deterministicJarvisContentHandler } from "../src/jarvis/deterministicContentWorkflow.js";
import { createDeterministicNarrationPlan, deterministicNarrationPlanHandler } from "../src/jarvis/deterministicNarrationPlan.js";

async function outline(overrides = {}) {
  const ctx = {
    agentId: "agent-01",
    jobType: "jarvis.content.outline.v1",
    payload: {
      publicBrand: "Raat Ki Awaaz",
      concept: "Ek sunsaan pahadi hostel mein band kamre se har raat kisi bachche ki ghanti sunai deti hai.",
      language: "hinglish",
      targetMinutes: 27,
      ...overrides,
    },
    heartbeat() {},
    checkpoint: async () => {},
  };
  return deterministicJarvisContentHandler(ctx);
}

test("creates a deterministic narration-only plan from the existing outline contract", async () => {
  const source = await outline();
  const first = createDeterministicNarrationPlan(source);
  const second = createDeterministicNarrationPlan(source);
  assert.deepEqual(second, first);
  assert.equal(first.readiness, "narration_plan_only");
  assert.equal(first.generationMode, "deterministic_local");
  assert.equal(first.narrationSegments.length, 5);
  assert.equal(first.narrationSegments.reduce((sum, segment) => sum + segment.plannedDurationSeconds, 0), 27 * 60);
  assert.deepEqual(first.voiceProfiles.map((profile) => profile.label), ["indian_male_narrator", "indian_female_narrator"]);
  assert.ok(first.narrationSegments.every((segment) => segment.audioStatus === "not_generated"));
  assert.ok(first.cuePlan.every((cue) => cue.assetReference === null && cue.status === "cue_only"));
  assert.deepEqual(first.generatedAudio, []);
  assert.deepEqual(first.bundledAssets, []);
  assert.deepEqual(first.providerCalls, []);
  assert.equal(first.publication.status, "not_requested");
});

test("handler enforces scope and records planning-only checkpoints", async () => {
  const source = await outline({ language: "hindi" });
  const checkpoints = [];
  const context = {
    agentId: "agent-01",
    jobType: "jarvis.content.narration-plan.v1",
    payload: { outlinePackage: source },
    heartbeat() {},
    checkpoint: async (...entry) => checkpoints.push(entry),
  };
  const plan = await deterministicNarrationPlanHandler(context);
  assert.equal(plan.language, "hindi");
  assert.match(plan.narrationSegments[0].deliveryDirection, /शुरुआत/);
  assert.deepEqual(checkpoints.map(([step]) => step), ["narration_source_validated", "narration_plan_ready"]);
  await assert.rejects(deterministicNarrationPlanHandler({ ...context, agentId: "agent-02" }), /SCOPE_MISMATCH/);
  await assert.rejects(deterministicNarrationPlanHandler({ ...context, jobType: "jarvis.content.outline.v1" }), /SCOPE_MISMATCH/);
});

test("rejects malformed, non-local, secret-bearing, and internal-name-leaking outlines", async () => {
  const source = await outline();
  assert.throws(() => createDeterministicNarrationPlan({ ...source, readiness: "audio_ready" }), /SOURCE_CONTRACT_MISMATCH/);
  assert.throws(() => createDeterministicNarrationPlan({ ...source, providerCalls: [{ provider: "paid" }] }), /SOURCE_NOT_LOCAL/);
  assert.throws(() => createDeterministicNarrationPlan({ ...source, suppliedConcept: "A valid looking story carrying api_key=unsafe-value inside its public brief." }), /SECRET_REJECTED/);
  assert.throws(() => createDeterministicNarrationPlan({ ...source, publicBrand: "JARVIS Horror" }), /INTERNAL_NAME_REJECTED/);
  assert.throws(() => createDeterministicNarrationPlan({ ...source, publicBrand: "NISHA Horror" }), /INTERNAL_NAME_REJECTED/);
  assert.throws(() => createDeterministicNarrationPlan({ ...source, storyOutline: source.storyOutline.slice(1) }), /BEATS_INVALID/);
});
