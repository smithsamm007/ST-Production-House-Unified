import test from "node:test";
import assert from "node:assert/strict";
import { createDeterministicVisualScenePlan } from "../src/jarvis/deterministicVisualScenePlanner.js";

function outline(overrides = {}) {
  return {
    schemaVersion: 1,
    packageId: "a".repeat(64),
    packageType: "jarvis_mvp_story_outline",
    readiness: "outline_only",
    generationMode: "deterministic_local",
    publicBrand: "Raat Ki Awaaz",
    language: "hinglish",
    targetMinutes: 27,
    suppliedConcept: "Ek sunsaan pahadi hostel mein band kamre ki ghanti har raat apne aap bajti hai.",
    storyOutline: [
      { beat: "hook", purpose: "Open with an immediate unsettling event grounded in the supplied concept." },
      { beat: "discovery", purpose: "Reveal the local mystery without explaining its supernatural cause." },
      { beat: "escalation", purpose: "Increase danger, emotional pressure, and uncertainty." },
      { beat: "reversal", purpose: "Introduce a fair but surprising change in what the audience believes." },
      { beat: "cliffhanger", purpose: "End with unresolved danger without revealing the final truth." },
    ],
    shortsPlan: ["opening_hook", "high_tension_moment", "cliffhanger_teaser"],
    providerCalls: [],
    publication: { requested: false, status: "not_requested" },
    ...overrides,
  };
}

test("creates a stable scene-plan-only package with safe long-form and exactly three Shorts specs", () => {
  const first = createDeterministicVisualScenePlan(outline());
  const second = createDeterministicVisualScenePlan(outline());
  assert.deepEqual(first, second);
  assert.equal(first.readiness, "scene_plan_only");
  assert.equal(first.generationMode, "deterministic_local");
  assert.equal(first.longFormScenes.length, 5);
  assert.ok(first.longFormScenes.every((scene) => scene.frame.aspectRatio === "16:9"));
  assert.deepEqual(first.shortsScenes.map(({ role }) => role), [
    "opening_hook", "high_tension_moment", "cliffhanger_teaser",
  ]);
  assert.ok(first.shortsScenes.every((scene) => scene.frame.aspectRatio === "9:16"));
  assert.deepEqual(first.generatedMedia, []);
  assert.deepEqual(first.providerCalls, []);
  assert.deepEqual(first.publication, { requested: false, status: "not_requested" });
});

test("rejects outline scope and untruthful upstream provider or publication state", () => {
  assert.throws(() => createDeterministicVisualScenePlan(outline({ readiness: "rendered" })), /SCOPE_MISMATCH/);
  assert.throws(() => createDeterministicVisualScenePlan(outline({ providerCalls: [{ provider: "fake" }] })), /PROVIDER_OUTPUT_REJECTED/);
  assert.throws(() => createDeterministicVisualScenePlan(outline({ publication: { requested: true, status: "published" } })), /PUBLICATION_SCOPE_REJECTED/);
});

test("rejects malformed Shorts roles, secrets, and internal agent-name leakage", () => {
  assert.throws(() => createDeterministicVisualScenePlan(outline({ shortsPlan: ["opening_hook"] })), /SHORTS_ROLES_INVALID/);
  assert.throws(() => createDeterministicVisualScenePlan(outline({ suppliedConcept: "A sufficiently long concept containing api_key=do-not-copy must never pass validation." })), /SECRET_REJECTED/);
  assert.throws(() => createDeterministicVisualScenePlan(outline({ publicBrand: "JARVIS Horror" })), /INTERNAL_AGENT_NAME_REJECTED/);
  assert.throws(() => createDeterministicVisualScenePlan(outline({ publicBrand: "Aarohi Stories" })), /INTERNAL_AGENT_NAME_REJECTED/);
  const unsafeOutline = outline();
  unsafeOutline.storyOutline[0].purpose = "Sherlock appears publicly in this sufficiently descriptive scene purpose.";
  assert.throws(() => createDeterministicVisualScenePlan(unsafeOutline), /INTERNAL_AGENT_NAME_REJECTED/);
});
