import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const SCRIPT_BEATS = Object.freeze(["hook", "discovery", "escalation", "reversal", "cliffhanger"]);
const INTERNAL_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_MARKERS = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|secret[_ -]?locator/i;

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeText(value, code, min, max) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_MARKERS.test(normalized)) throw new Error("JARVIS_SCRIPT_DISPATCH_SECRET_REJECTED");
  if (INTERNAL_NAMES.test(normalized)) throw new Error("JARVIS_SCRIPT_DISPATCH_AGENT_NAME_REJECTED");
  return normalized;
}

function validateScriptPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("JARVIS_SCRIPT_DISPATCH_PLAN_INVALID");
  }
  if (plan.schemaVersion !== 1 || plan.packageType !== "jarvis_mvp_script_plan") {
    throw new Error("JARVIS_SCRIPT_DISPATCH_CONTRACT_MISMATCH");
  }
  if (plan.readiness !== "script_plan_only" || plan.generationMode !== "deterministic_local") {
    throw new Error("JARVIS_SCRIPT_DISPATCH_TRUTHFULNESS_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/.test(plan.sourcePackageId || "")) {
    throw new Error("JARVIS_SCRIPT_DISPATCH_SOURCE_ID_INVALID");
  }
  const publicBrand = safeText(plan.publicBrand, "JARVIS_SCRIPT_DISPATCH_BRAND_INVALID", 2, 80);
  const suppliedConcept = safeText(plan.suppliedConcept, "JARVIS_SCRIPT_DISPATCH_CONCEPT_INVALID", 20, 1200);
  if (!new Set(["hindi", "hinglish"]).has(plan.language)) {
    throw new Error("JARVIS_SCRIPT_DISPATCH_LANGUAGE_INVALID");
  }
  if (!Number.isInteger(plan.targetMinutes) || plan.targetMinutes < 25 || plan.targetMinutes > 30) {
    throw new Error("JARVIS_SCRIPT_DISPATCH_DURATION_INVALID");
  }
  if (!Array.isArray(plan.sections) || plan.sections.length !== SCRIPT_BEATS.length) {
    throw new Error("JARVIS_SCRIPT_DISPATCH_SECTIONS_INVALID");
  }
  const sections = plan.sections.map((section, index) => {
    if (!section || section.order !== index + 1 || section.beat !== SCRIPT_BEATS[index]) {
      throw new Error("JARVIS_SCRIPT_DISPATCH_SECTIONS_INVALID");
    }
    if (!Number.isInteger(section.targetMinutes) || section.targetMinutes < 1) {
      throw new Error("JARVIS_SCRIPT_DISPATCH_SECTION_DURATION_INVALID");
    }
    const writingDirection = safeText(
      section.writingDirection,
      "JARVIS_SCRIPT_DISPATCH_DIRECTION_INVALID",
      10,
      300,
    );
    const expectedStyle = plan.language === "hindi" ? "natural_hindi" : "natural_hinglish";
    if (section.languageStyle !== expectedStyle) {
      throw new Error("JARVIS_SCRIPT_DISPATCH_LANGUAGE_STYLE_INVALID");
    }
    return {
      order: section.order,
      beat: section.beat,
      targetMinutes: section.targetMinutes,
      writingDirection,
      languageStyle: section.languageStyle,
    };
  });
  if (sections.reduce((total, section) => total + section.targetMinutes, 0) !== plan.targetMinutes) {
    throw new Error("JARVIS_SCRIPT_DISPATCH_DURATION_TOTAL_MISMATCH");
  }
  if (!Array.isArray(plan.providerCalls) || plan.providerCalls.length !== 0 ||
      !Array.isArray(plan.artifacts) || plan.artifacts.length !== 0 ||
      plan.publication?.requested !== false || plan.publication?.status !== "not_requested") {
    throw new Error("JARVIS_SCRIPT_DISPATCH_SIDE_EFFECT_CLAIM_REJECTED");
  }
  const expectedPlanId = stableId({ sourcePackageId: plan.sourcePackageId, sections });
  if (plan.planId !== expectedPlanId) throw new Error("JARVIS_SCRIPT_DISPATCH_PLAN_ID_MISMATCH");
  return { publicBrand, suppliedConcept, sections };
}

export function createDeterministicScriptDispatchRequest({ ownerId, scriptPlan }) {
  if (typeof ownerId !== "string" || !/^[a-z0-9][a-z0-9_-]{2,79}$/i.test(ownerId)) {
    throw new Error("JARVIS_SCRIPT_DISPATCH_OWNER_INVALID");
  }
  const { publicBrand, suppliedConcept, sections } = validateScriptPlan(scriptPlan);
  const dispatchId = stableId({ ownerId, planId: scriptPlan.planId, capability: "text_generation" });
  return Object.freeze({
    taskId: `dispatch-${dispatchId}`,
    jobType: "content.script.generate.v1",
    agentId: "agent-01",
    payload: Object.freeze({
      schemaVersion: 1,
      dispatchId,
      readiness: "dispatch_ready_only",
      capability: "text_generation",
      sourcePlanId: scriptPlan.planId,
      publicBrand,
      language: scriptPlan.language,
      targetMinutes: scriptPlan.targetMinutes,
      suppliedConcept,
      sections: Object.freeze(sections.map((section) => Object.freeze(section))),
    }),
    context: Object.freeze({
      ownerId,
      capacityPolicy: "approved_free_only",
      dispatchMode: "provider_independent",
    }),
  });
}

export function createWaitingForQuotaCheckpoint(dispatchRequest) {
  if (dispatchRequest?.agentId !== "agent-01" ||
      dispatchRequest?.payload?.readiness !== "dispatch_ready_only" ||
      dispatchRequest?.payload?.capability !== "text_generation" ||
      !/^dispatch-[a-f0-9]{64}$/.test(dispatchRequest?.taskId || "")) {
    throw new Error("JARVIS_WAITING_FOR_QUOTA_DISPATCH_INVALID");
  }
  const checkpointId = stableId({
    taskId: dispatchRequest.taskId,
    sourcePlanId: dispatchRequest.payload.sourcePlanId,
    state: "WAITING_FOR_QUOTA",
  });
  return Object.freeze({
    schemaVersion: 1,
    checkpointId,
    taskId: dispatchRequest.taskId,
    state: "WAITING_FOR_QUOTA",
    step: "waiting_for_approved_free_capacity",
    reasonCode: "APPROVED_FREE_CAPACITY_UNAVAILABLE",
    resumable: true,
    executionStarted: false,
  });
}
