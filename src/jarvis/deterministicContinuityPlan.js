import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const AGENT_ID = "agent-01";
const JOB_TYPE = "jarvis.content.continuity-plan.v1";
const BEATS = Object.freeze(["hook", "discovery", "escalation", "reversal", "cliffhanger"]);
const SHORTS = Object.freeze(["opening_hook", "high_tension_moment", "cliffhanger_teaser"]);
const INTERNAL_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_MARKERS = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\//i;

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safePublicText(value, code, min, max) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_MARKERS.test(normalized)) throw new Error("JARVIS_CONTINUITY_SECRET_REJECTED");
  if (INTERNAL_NAMES.test(normalized)) throw new Error("JARVIS_CONTINUITY_AGENT_NAME_REJECTED");
  return normalized;
}

function validateOutline(outline) {
  if (!outline || typeof outline !== "object" || Array.isArray(outline)) {
    throw new Error("JARVIS_CONTINUITY_OUTLINE_INVALID");
  }
  if (outline.schemaVersion !== 1 || outline.packageType !== "jarvis_mvp_story_outline") {
    throw new Error("JARVIS_CONTINUITY_CONTRACT_MISMATCH");
  }
  if (outline.readiness !== "outline_only" || outline.generationMode !== "deterministic_local") {
    throw new Error("JARVIS_CONTINUITY_TRUTHFULNESS_MISMATCH");
  }
  const publicBrand = safePublicText(outline.publicBrand, "JARVIS_CONTINUITY_BRAND_INVALID", 2, 80);
  const suppliedConcept = safePublicText(outline.suppliedConcept, "JARVIS_CONTINUITY_CONCEPT_INVALID", 20, 1200);
  if (!new Set(["hindi", "hinglish"]).has(outline.language)) {
    throw new Error("JARVIS_CONTINUITY_LANGUAGE_INVALID");
  }
  if (!Number.isInteger(outline.targetMinutes) || outline.targetMinutes < 25 || outline.targetMinutes > 30) {
    throw new Error("JARVIS_CONTINUITY_DURATION_INVALID");
  }
  const expectedId = hash({ publicBrand, concept: suppliedConcept, language: outline.language, targetMinutes: outline.targetMinutes });
  if (outline.packageId !== expectedId) throw new Error("JARVIS_CONTINUITY_PACKAGE_ID_MISMATCH");
  if (!Array.isArray(outline.storyOutline) || outline.storyOutline.length !== BEATS.length) {
    throw new Error("JARVIS_CONTINUITY_BEATS_INVALID");
  }
  outline.storyOutline.forEach((entry, index) => {
    if (!entry || entry.beat !== BEATS[index]) throw new Error("JARVIS_CONTINUITY_BEATS_INVALID");
    safePublicText(entry.purpose, "JARVIS_CONTINUITY_PURPOSE_INVALID", 10, 300);
  });
  if (!Array.isArray(outline.shortsPlan) || !SHORTS.every((item, index) => outline.shortsPlan[index] === item) || outline.shortsPlan.length !== SHORTS.length) {
    throw new Error("JARVIS_CONTINUITY_SHORTS_INVALID");
  }
  if (!Array.isArray(outline.providerCalls) || outline.providerCalls.length !== 0 ||
      outline.publication?.requested !== false || outline.publication?.status !== "not_requested") {
    throw new Error("JARVIS_CONTINUITY_SIDE_EFFECT_CLAIM_REJECTED");
  }
  return { publicBrand, suppliedConcept };
}

export async function deterministicJarvisContinuityPlanHandler(ctx) {
  if (ctx.agentId !== AGENT_ID || ctx.jobType !== JOB_TYPE) {
    throw new Error("JARVIS_CONTINUITY_SCOPE_MISMATCH");
  }
  const outline = ctx.payload?.outlinePackage;
  const { publicBrand, suppliedConcept } = validateOutline(outline);
  const checks = [
    { code: "beat_order", requirement: "Preserve hook-to-cliffhanger order across later planning." },
    { code: "concept_fidelity", requirement: "Keep every later scene grounded in the supplied concept." },
    { code: "mystery_integrity", requirement: "Do not reveal the final truth before the cliffhanger." },
    { code: "duration_boundary", requirement: `Keep the planned narrative within ${outline.targetMinutes} minutes.` },
    { code: "shorts_spoiler_safety", requirement: "Keep all three Shorts free of the ending reveal." },
  ];
  const validationId = hash({ sourcePackageId: outline.packageId, checks });

  ctx.heartbeat("outline_contract_validated", 50, { generationMode: "deterministic_local" });
  await ctx.checkpoint("outline_contract_validated", 50, { sourcePackageId: outline.packageId });
  await ctx.checkpoint("continuity_plan_ready", 100, { validationId, readiness: "continuity_plan_only" });

  return {
    schemaVersion: 1,
    validationId,
    packageType: "jarvis_mvp_continuity_plan",
    readiness: "continuity_plan_only",
    generationMode: "deterministic_local",
    sourcePackageId: outline.packageId,
    publicBrand,
    language: outline.language,
    targetMinutes: outline.targetMinutes,
    suppliedConcept,
    checks,
    validation: { status: "contract_validated", continuityNotYetVerified: true },
    providerCalls: [],
    artifacts: [],
    publication: { requested: false, status: "not_requested" },
  };
}
