import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const AGENT_ID = "agent-01";
const JOB_TYPE = "jarvis.content.shorts-plan.v1";
const SOURCE_TYPE = "jarvis_mvp_story_outline";
const BEATS = Object.freeze(["hook", "discovery", "escalation", "reversal", "cliffhanger"]);
const SHORTS = Object.freeze([
  { role: "opening_hook", sourceBeat: "hook", targetSeconds: 30 },
  { role: "high_tension_moment", sourceBeat: "escalation", targetSeconds: 45 },
  { role: "cliffhanger_teaser", sourceBeat: "cliffhanger", targetSeconds: 30 },
]);
const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token/i;
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safePublicText(value, code, min, max) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_LIKE.test(normalized)) throw new Error("SHORTS_PLAN_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw new Error("SHORTS_PLAN_INTERNAL_AGENT_NAME_REJECTED");
  return normalized;
}

function validateOutline(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("SHORTS_PLAN_SOURCE_INVALID");
  }
  if (
    source.schemaVersion !== 1 ||
    source.packageType !== SOURCE_TYPE ||
    source.readiness !== "outline_only" ||
    source.generationMode !== "deterministic_local"
  ) {
    throw new Error("SHORTS_PLAN_SOURCE_CONTRACT_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/.test(source.packageId || "")) throw new Error("SHORTS_PLAN_SOURCE_ID_INVALID");
  if (!Array.isArray(source.providerCalls) || source.providerCalls.length !== 0) {
    throw new Error("SHORTS_PLAN_SOURCE_PROVIDER_STATE_INVALID");
  }
  if (source.publication?.requested !== false || source.publication?.status !== "not_requested") {
    throw new Error("SHORTS_PLAN_SOURCE_PUBLICATION_STATE_INVALID");
  }
  safePublicText(source.suppliedConcept, "SHORTS_PLAN_CONCEPT_INVALID", 20, 1200);
  if (!new Set(["hindi", "hinglish"]).has(source.language)) {
    throw new Error("SHORTS_PLAN_LANGUAGE_UNSUPPORTED");
  }
  if (!Number.isInteger(source.targetMinutes) || source.targetMinutes < 25 || source.targetMinutes > 30) {
    throw new Error("SHORTS_PLAN_DURATION_INVALID");
  }
  if (!Array.isArray(source.shortsPlan) ||
      source.shortsPlan.length !== SHORTS.length ||
      !source.shortsPlan.every((role, index) => role === SHORTS[index].role)) {
    throw new Error("SHORTS_PLAN_SOURCE_ROLES_INVALID");
  }
  if (!Array.isArray(source.storyOutline) || source.storyOutline.length !== BEATS.length) {
    throw new Error("SHORTS_PLAN_SOURCE_BEATS_INVALID");
  }
  const purposes = new Map();
  source.storyOutline.forEach((entry, index) => {
    if (!entry || entry.beat !== BEATS[index]) throw new Error("SHORTS_PLAN_SOURCE_BEATS_INVALID");
    purposes.set(entry.beat, safePublicText(entry.purpose, "SHORTS_PLAN_PURPOSE_INVALID", 10, 300));
  });
  return {
    publicBrand: safePublicText(source.publicBrand, "SHORTS_PLAN_PUBLIC_BRAND_INVALID", 2, 80),
    purposes,
  };
}

export function createDeterministicShortsPlan(outlinePackage) {
  const validated = validateOutline(outlinePackage);
  const shorts = SHORTS.map((definition, index) => ({
    order: index + 1,
    role: definition.role,
    sourceBeat: definition.sourceBeat,
    sourceDirection: validated.purposes.get(definition.sourceBeat),
    frame: { aspectRatio: "9:16", width: 1080, height: 1920 },
    targetSeconds: definition.targetSeconds,
    endingRevealAllowed: false,
    mediaStatus: "not_generated",
  }));
  const packageId = stableId({ sourcePackageId: outlinePackage.packageId, shorts });
  return {
    schemaVersion: 1,
    packageId,
    packageType: "shorts_plan_v1",
    sourcePackageId: outlinePackage.packageId,
    readiness: "shorts_plan_only",
    generationMode: "deterministic_local",
    publicBrand: validated.publicBrand,
    shorts,
    generatedMedia: [],
    providerCalls: [],
    artifacts: [],
    publication: { requested: false, status: "not_requested" },
  };
}

export async function deterministicShortsPlanHandler(ctx) {
  if (ctx.agentId !== AGENT_ID || ctx.jobType !== JOB_TYPE) throw new Error("SHORTS_PLAN_SCOPE_MISMATCH");
  const plan = createDeterministicShortsPlan(ctx.payload?.outlinePackage);
  ctx.heartbeat("shorts_source_validated", 20, { generationMode: "deterministic_local" });
  await ctx.checkpoint("shorts_source_validated", 20, { sourcePackageId: plan.sourcePackageId });
  await ctx.checkpoint("shorts_plan_ready", 100, { packageId: plan.packageId, readiness: plan.readiness });
  return plan;
}
