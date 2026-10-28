import test from "node:test";
import assert from "node:assert/strict";
import { WorkEnvelope } from "../src/workers/workEnvelope.js";
import {
  createDeterministicVisualDispatch,
  createWaitingForQuotaState,
} from "../src/jarvis/deterministicVisualDispatch.js";

function visualPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: "a".repeat(64),
    sourcePackageId: "b".repeat(64),
    packageType: "visual_scene_plan_v1",
    readiness: "scene_plan_only",
    generationMode: "deterministic_local",
    publicBrand: "Raat Ki Awaaz",
    longFormScenes: ["hook", "discovery", "escalation", "reversal", "cliffhanger"].map((beat, index) => ({
      sceneNumber: index + 1,
      beat,
      purpose: `Create an original safe visual direction for the ${beat} story beat.`,
      frame: { aspectRatio: "16:9", width: 1920, height: 1080 },
      visualSafety: {
        sourceMaterial: "owner_supplied_concept_only",
        requireOriginalComposition: true,
        protectedCharacterImitation: false,
      },
    })),
    shortsScenes: ["opening_hook", "high_tension_moment", "cliffhanger_teaser"].map((role, index) => ({
      sceneNumber: index + 1,
      role,
      frame: { aspectRatio: "9:16", width: 1080, height: 1920 },
      endingDisclosure: role === "cliffhanger_teaser" ? "ending_not_revealed" : "not_applicable",
    })),
    generatedMedia: [],
    providerCalls: [],
    publication: { requested: false, status: "not_requested" },
    ...overrides,
  };
}

test("emits stable WorkEnvelope-compatible image dispatch requests without execution claims", () => {
  const first = createDeterministicVisualDispatch(visualPlan());
  const second = createDeterministicVisualDispatch(visualPlan());
  assert.deepEqual(first, second);
  assert.equal(first.readiness, "dispatch_ready_only");
  assert.equal(first.capability, "image_generation");
  assert.equal(first.dispatchRequests.length, 8);
  assert.equal(first.dispatchRequests.filter(({ payload }) => payload.lane === "long_form").length, 5);
  assert.equal(first.dispatchRequests.filter(({ payload }) => payload.lane === "short").length, 3);
  assert.ok(first.dispatchRequests.every((request) => new WorkEnvelope(request)));
  assert.ok(first.dispatchRequests.slice(0, 5).every(({ payload }) => payload.scene.frame.aspectRatio === "16:9"));
  assert.ok(first.dispatchRequests.slice(5).every(({ payload }) => payload.scene.frame.aspectRatio === "9:16"));
  assert.deepEqual(first.providerCalls, []);
  assert.deepEqual(first.credentials, []);
  assert.deepEqual(first.artifacts, []);
  assert.deepEqual(first.evidence, []);
  assert.deepEqual(first.publication, { requested: false, status: "not_requested" });
});

test("constructs a truthful non-persisted WAITING_FOR_QUOTA checkpoint without invoking a provider", () => {
  const waiting = createWaitingForQuotaState(createDeterministicVisualDispatch(visualPlan()));
  assert.equal(waiting.state, "WAITING_FOR_QUOTA");
  assert.equal(waiting.reason, "APPROVED_FREE_CAPACITY_UNAVAILABLE");
  assert.equal(waiting.checkpoint.persistenceStatus, "not_persisted");
  assert.deepEqual(waiting.providerCalls, []);
  assert.deepEqual(waiting.artifacts, []);
  assert.equal(waiting.publication.status, "not_requested");
});

test("rejects contract drift, scene-count or aspect-ratio changes, secrets, and all internal names", () => {
  assert.throws(() => createDeterministicVisualDispatch(visualPlan({ readiness: "rendered" })), /CONTRACT_MISMATCH/);
  assert.throws(() => createDeterministicVisualDispatch(visualPlan({ shortsScenes: [] })), /SHORT_SCENES_INVALID/);
  const wrongFrame = visualPlan();
  wrongFrame.longFormScenes[0].frame.aspectRatio = "9:16";
  assert.throws(() => createDeterministicVisualDispatch(wrongFrame), /FRAME_INVALID/);
  assert.throws(() => createDeterministicVisualDispatch(visualPlan({ publicBrand: "Nisha Stories" })), /INTERNAL_AGENT_NAME_REJECTED/);
  const secret = visualPlan();
  secret.longFormScenes[0].purpose = "Use api_key=never-copy for this otherwise sufficiently detailed scene.";
  assert.throws(() => createDeterministicVisualDispatch(secret), /SECRET_REJECTED/);
});

test("rejects upstream provider, media, publication, and unsafe ending claims", () => {
  assert.throws(() => createDeterministicVisualDispatch(visualPlan({ providerCalls: [{ provider: "fake" }] })), /SIDE_EFFECT_INVALID/);
  assert.throws(() => createDeterministicVisualDispatch(visualPlan({ generatedMedia: [{ id: "fake" }] })), /SIDE_EFFECT_INVALID/);
  assert.throws(() => createDeterministicVisualDispatch(visualPlan({ publication: { requested: true, status: "published" } })), /PUBLICATION_INVALID/);
  const reveal = visualPlan();
  reveal.shortsScenes[2].endingDisclosure = "ending_revealed";
  assert.throws(() => createDeterministicVisualDispatch(reveal), /ENDING_REVEAL_INVALID/);
});

