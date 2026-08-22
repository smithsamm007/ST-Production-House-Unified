import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deterministicJarvisContinuityPlanHandler } from "../src/jarvis/deterministicContinuityPlan.js";

const concept = "Ek sunsaan pahadi hostel mein har raat band kamre se kisi bachche ki ghanti sunai deti hai.";

function outline(overrides = {}) {
  const base = {
    schemaVersion: 1,
    packageType: "jarvis_mvp_story_outline",
    readiness: "outline_only",
    generationMode: "deterministic_local",
    publicBrand: "Raat Ki Awaaz",
    language: "hinglish",
    targetMinutes: 27,
    suppliedConcept: concept,
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
  if (!("packageId" in overrides)) {
    base.packageId = crypto.createHash("sha256").update(JSON.stringify({
      publicBrand: base.publicBrand,
      concept: base.suppliedConcept,
      language: base.language,
      targetMinutes: base.targetMinutes,
    })).digest("hex");
  }
  return base;
}

function context(packageOverrides = {}, contextOverrides = {}) {
  const checkpoints = [];
  return {
    checkpoints,
    ctx: {
      agentId: "agent-01",
      jobType: "jarvis.content.continuity-plan.v1",
      payload: { outlinePackage: outline(packageOverrides) },
      heartbeat() {},
      async checkpoint(step, progress, data) { checkpoints.push({ step, progress, data }); },
      ...contextOverrides,
    },
  };
}

test("validates the merged outline contract and returns a deterministic planning-only result", async () => {
  const first = context();
  const second = context();
  const result = await deterministicJarvisContinuityPlanHandler(first.ctx);
  assert.deepEqual(result, await deterministicJarvisContinuityPlanHandler(second.ctx));
  assert.equal(result.readiness, "continuity_plan_only");
  assert.deepEqual(result.validation, { status: "contract_validated", continuityNotYetVerified: true });
  assert.equal(result.checks.length, 5);
  assert.deepEqual(result.providerCalls, []);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.publication, { requested: false, status: "not_requested" });
  assert.equal(first.checkpoints.at(-1).step, "continuity_plan_ready");
});

test("rejects scope mismatch, tampering, unsafe content, and side-effect claims", async () => {
  await assert.rejects(deterministicJarvisContinuityPlanHandler(context({}, { agentId: "agent-02" }).ctx), /SCOPE_MISMATCH/);
  await assert.rejects(deterministicJarvisContinuityPlanHandler(context({ packageId: "0".repeat(64) }).ctx), /PACKAGE_ID_MISMATCH/);
  await assert.rejects(deterministicJarvisContinuityPlanHandler(context({ suppliedConcept: "A sufficiently long concept with password=hunter2 must be rejected by validation." }).ctx), /SECRET_REJECTED/);
  await assert.rejects(deterministicJarvisContinuityPlanHandler(context({ publicBrand: "JARVIS Stories" }).ctx), /AGENT_NAME_REJECTED/);
  await assert.rejects(deterministicJarvisContinuityPlanHandler(context({ publicBrand: "BYTE Stories" }).ctx), /AGENT_NAME_REJECTED/);
  await assert.rejects(deterministicJarvisContinuityPlanHandler(context({ providerCalls: ["fake-call"] }).ctx), /SIDE_EFFECT_CLAIM_REJECTED/);
  await assert.rejects(deterministicJarvisContinuityPlanHandler(context({ shortsPlan: ["opening_hook"] }).ctx), /SHORTS_INVALID/);
});
