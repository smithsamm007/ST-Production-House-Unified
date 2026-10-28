import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicShortsPlan,
  deterministicShortsPlanHandler,
} from "../src/jarvis/deterministicShortsPlan.js";

function outline(overrides = {}) {
  return {
    schemaVersion: 1,
    packageId: "b".repeat(64),
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

test("creates a deterministic planning-only package with exactly three 9:16 Shorts and no ending reveal", () => {
  const first = createDeterministicShortsPlan(outline());
  const second = createDeterministicShortsPlan(outline());
  assert.deepEqual(first, second);
  assert.equal(first.readiness, "shorts_plan_only");
  assert.deepEqual(first.shorts.map(({ role }) => role), [
    "opening_hook", "high_tension_moment", "cliffhanger_teaser",
  ]);
  assert.deepEqual(first.shorts.map(({ sourceBeat }) => sourceBeat), ["hook", "escalation", "cliffhanger"]);
  assert.ok(first.shorts.every(({ frame }) => frame.aspectRatio === "9:16" && frame.width === 1080 && frame.height === 1920));
  assert.ok(first.shorts.every(({ endingRevealAllowed, mediaStatus }) => !endingRevealAllowed && mediaStatus === "not_generated"));
  assert.deepEqual(first.generatedMedia, []);
  assert.deepEqual(first.providerCalls, []);
  assert.deepEqual(first.artifacts, []);
  assert.deepEqual(first.publication, { requested: false, status: "not_requested" });
});

test("handler is scope-bound and records only truthful planning checkpoints", async () => {
  const checkpoints = [];
  const ctx = {
    agentId: "agent-01",
    jobType: "jarvis.content.shorts-plan.v1",
    payload: { outlinePackage: outline() },
    heartbeat() {},
    async checkpoint(...args) { checkpoints.push(args); },
  };
  const result = await deterministicShortsPlanHandler(ctx);
  assert.equal(result.readiness, "shorts_plan_only");
  assert.deepEqual(checkpoints.map(([step]) => step), ["shorts_source_validated", "shorts_plan_ready"]);
  await assert.rejects(deterministicShortsPlanHandler({ ...ctx, agentId: "agent-02" }), /SCOPE_MISMATCH/);
});

test("rejects scope drift, wrong role count, secrets, internal names, and side-effect claims", () => {
  assert.throws(() => createDeterministicShortsPlan(outline({ readiness: "rendered" })), /CONTRACT_MISMATCH/);
  assert.throws(() => createDeterministicShortsPlan(outline({ shortsPlan: ["opening_hook"] })), /ROLES_INVALID/);
  assert.throws(() => createDeterministicShortsPlan(outline({ publicBrand: "Aarohi Stories" })), /INTERNAL_AGENT_NAME_REJECTED/);
  const secret = outline();
  secret.storyOutline[2].purpose = "Escalate this sufficiently detailed beat with api_key=never-copy in the scene.";
  assert.throws(() => createDeterministicShortsPlan(secret), /SECRET_REJECTED/);
  assert.throws(() => createDeterministicShortsPlan(outline({
    suppliedConcept: "A sufficiently detailed concept with access_token=never-copy must fail closed.",
  })), /SECRET_REJECTED/);
  assert.throws(() => createDeterministicShortsPlan(outline({ providerCalls: [{ provider: "fake" }] })), /PROVIDER_STATE_INVALID/);
  assert.throws(() => createDeterministicShortsPlan(outline({ publication: { requested: true, status: "published" } })), /PUBLICATION_STATE_INVALID/);
});
