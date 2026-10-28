import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deterministicJarvisScriptPlanHandler } from "../src/jarvis/deterministicScriptPlan.js";

function outline(overrides = {}) {
  return {
    schemaVersion: 1,
    packageId: crypto.createHash("sha256").update("source-outline").digest("hex"),
    packageType: "jarvis_mvp_story_outline",
    readiness: "outline_only",
    generationMode: "deterministic_local",
    publicBrand: "Raat Ki Awaaz",
    language: "hinglish",
    targetMinutes: 27,
    suppliedConcept: "Ek sunsaan pahadi hostel mein band kamre se har raat ghanti sunai deti hai.",
    storyOutline: [
      { beat: "hook", purpose: "Open with an immediate unsettling event grounded in the supplied concept." },
      { beat: "discovery", purpose: "Reveal the local mystery without explaining its supernatural cause." },
      { beat: "escalation", purpose: "Increase danger, emotional pressure, and uncertainty." },
      { beat: "reversal", purpose: "Introduce a fair but surprising change in what the audience believes." },
      { beat: "cliffhanger", purpose: "End with unresolved danger without revealing the final truth." },
    ],
    providerCalls: [],
    publication: { requested: false, status: "not_requested" },
    ...overrides,
  };
}

function context(packageOverrides = {}, contextOverrides = {}) {
  const checkpoints = [];
  return {
    checkpoints,
    ctx: {
      agentId: "agent-01",
      jobType: "jarvis.content.script-plan.v1",
      payload: { outlinePackage: outline(packageOverrides) },
      heartbeat() {},
      async checkpoint(step, progress, data) { checkpoints.push({ step, progress, data }); },
      ...contextOverrides,
    },
  };
}

test("creates a deterministic truthful Hindi/Hinglish 25-30 minute script plan", async () => {
  const first = context();
  const second = context();
  const result = await deterministicJarvisScriptPlanHandler(first.ctx);
  const replay = await deterministicJarvisScriptPlanHandler(second.ctx);
  assert.deepEqual(result, replay);
  assert.equal(result.readiness, "script_plan_only");
  assert.equal(result.generationMode, "deterministic_local");
  assert.equal(result.sections.reduce((sum, section) => sum + section.targetMinutes, 0), 27);
  assert.deepEqual(result.sections.map((section) => section.beat), ["hook", "discovery", "escalation", "reversal", "cliffhanger"]);
  assert.ok(result.sections.every((section) => section.languageStyle === "natural_hinglish"));
  assert.deepEqual(result.providerCalls, []);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.publication, { requested: false, status: "not_requested" });
  assert.equal(first.checkpoints.at(-1).step, "script_plan_ready");
});

test("supports Hindi and preserves the requested bounded duration", async () => {
  const { ctx } = context({ language: "hindi", targetMinutes: 30 });
  const result = await deterministicJarvisScriptPlanHandler(ctx);
  assert.equal(result.sections.reduce((sum, section) => sum + section.targetMinutes, 0), 30);
  assert.ok(result.sections.every((section) => section.languageStyle === "natural_hindi"));
});

test("rejects scope, contract, secrets, internal names, and side-effect claims", async () => {
  await assert.rejects(deterministicJarvisScriptPlanHandler(context({}, { agentId: "agent-02" }).ctx), /SCOPE_MISMATCH/);
  await assert.rejects(deterministicJarvisScriptPlanHandler(context({ readiness: "script_ready" }).ctx), /TRUTHFULNESS_MISMATCH/);
  await assert.rejects(deterministicJarvisScriptPlanHandler(context({ targetMinutes: 31 }).ctx), /DURATION_INVALID/);
  await assert.rejects(deterministicJarvisScriptPlanHandler(context({ suppliedConcept: "A long enough concept containing api_key=secret must never enter a public plan." }).ctx), /SECRET_REJECTED/);
  await assert.rejects(deterministicJarvisScriptPlanHandler(context({ publicBrand: "JARVIS Horror" }).ctx), /AGENT_NAME_REJECTED/);
  await assert.rejects(deterministicJarvisScriptPlanHandler(context({ publicBrand: "BYTE Horror" }).ctx), /AGENT_NAME_REJECTED/);
  await assert.rejects(deterministicJarvisScriptPlanHandler(context({ providerCalls: ["claimed-call"] }).ctx), /SIDE_EFFECT_MISMATCH/);
});
