import crypto from "node:crypto";

const JARVIS_AGENT_ID = "agent-01";
const OUTLINE_BEATS = Object.freeze(["hook", "discovery", "escalation", "reversal", "cliffhanger"]);
const INTERNAL_AGENT_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i"
);
const SECRET_MARKERS = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\//i;

function stableId(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function publicText(value, code, min, max) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_MARKERS.test(normalized)) throw new Error("JARVIS_SCRIPT_PLAN_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAMES.test(normalized)) throw new Error("JARVIS_SCRIPT_PLAN_AGENT_NAME_REJECTED");
  return normalized;
}

function validateOutlinePackage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JARVIS_OUTLINE_PACKAGE_INVALID");
  }
  if (value.schemaVersion !== 1 || value.packageType !== "jarvis_mvp_story_outline") {
    throw new Error("JARVIS_OUTLINE_CONTRACT_MISMATCH");
  }
  if (value.readiness !== "outline_only" || value.generationMode !== "deterministic_local") {
    throw new Error("JARVIS_OUTLINE_TRUTHFULNESS_MISMATCH");
  }
  if (!Array.isArray(value.providerCalls) || value.providerCalls.length !== 0 ||
      value.publication?.requested !== false || value.publication?.status !== "not_requested") {
    throw new Error("JARVIS_OUTLINE_SIDE_EFFECT_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/.test(value.packageId || "")) throw new Error("JARVIS_OUTLINE_PACKAGE_ID_INVALID");
  const publicBrand = publicText(value.publicBrand, "JARVIS_OUTLINE_PUBLIC_BRAND_INVALID", 2, 80);
  const suppliedConcept = publicText(value.suppliedConcept, "JARVIS_OUTLINE_CONCEPT_INVALID", 20, 1200);
  if (!new Set(["hindi", "hinglish"]).has(value.language)) throw new Error("JARVIS_OUTLINE_LANGUAGE_UNSUPPORTED");
  if (!Number.isInteger(value.targetMinutes) || value.targetMinutes < 25 || value.targetMinutes > 30) {
    throw new Error("JARVIS_OUTLINE_DURATION_INVALID");
  }
  if (!Array.isArray(value.storyOutline) || value.storyOutline.length !== OUTLINE_BEATS.length) {
    throw new Error("JARVIS_OUTLINE_BEATS_INVALID");
  }
  value.storyOutline.forEach((entry, index) => {
    if (!entry || entry.beat !== OUTLINE_BEATS[index]) throw new Error("JARVIS_OUTLINE_BEATS_INVALID");
    publicText(entry.purpose, "JARVIS_OUTLINE_PURPOSE_INVALID", 10, 300);
  });
  return { publicBrand, suppliedConcept };
}

export async function deterministicJarvisScriptPlanHandler(ctx) {
  if (ctx.agentId !== JARVIS_AGENT_ID || ctx.jobType !== "jarvis.content.script-plan.v1") {
    throw new Error("JARVIS_SCRIPT_PLAN_SCOPE_MISMATCH");
  }
  const outline = ctx.payload?.outlinePackage;
  const { publicBrand, suppliedConcept } = validateOutlinePackage(outline);
  const sectionMinutes = [3, 5, 7, 6, outline.targetMinutes - 21];
  const sections = OUTLINE_BEATS.map((beat, index) => ({
    order: index + 1,
    beat,
    targetMinutes: sectionMinutes[index],
    writingDirection: outline.storyOutline[index].purpose,
    languageStyle: outline.language === "hindi" ? "natural_hindi" : "natural_hinglish",
  }));
  const planId = stableId({ sourcePackageId: outline.packageId, sections });

  ctx.heartbeat("outline_validated", 20, { generationMode: "deterministic_local" });
  await ctx.checkpoint("outline_validated", 20, { sourcePackageId: outline.packageId });
  await ctx.checkpoint("script_plan_ready", 100, { planId, readiness: "script_plan_only" });

  return {
    schemaVersion: 1,
    planId,
    packageType: "jarvis_mvp_script_plan",
    readiness: "script_plan_only",
    generationMode: "deterministic_local",
    sourcePackageId: outline.packageId,
    publicBrand,
    language: outline.language,
    targetMinutes: outline.targetMinutes,
    suppliedConcept,
    sections,
    providerCalls: [],
    artifacts: [],
    publication: { requested: false, status: "not_requested" },
  };
}
import { PRELOADED_AGENTS } from "../catalog/agents.js";
