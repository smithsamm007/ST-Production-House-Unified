import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const EXPECTED_SHORT_ROLES = Object.freeze([
  "opening_hook",
  "high_tension_moment",
  "cliffhanger_teaser",
]);
const EXPECTED_BEATS = Object.freeze(["hook", "discovery", "escalation", "reversal", "cliffhanger"]);
const INTERNAL_AGENT_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_MARKERS = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|token\s*[=:]/i;

function requireSafeText(value, code, min = 1, max = 1200) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_MARKERS.test(normalized)) throw new Error("VISUAL_PLAN_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAMES.test(normalized)) throw new Error("VISUAL_PLAN_INTERNAL_AGENT_NAME_REJECTED");
  return normalized;
}

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateOutlinePackage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("VISUAL_PLAN_OUTLINE_INVALID");
  }
  if (
    input.schemaVersion !== 1 ||
    input.packageType !== "jarvis_mvp_story_outline" ||
    input.readiness !== "outline_only" ||
    input.generationMode !== "deterministic_local"
  ) {
    throw new Error("VISUAL_PLAN_SCOPE_MISMATCH");
  }
  const packageId = requireSafeText(input.packageId, "VISUAL_PLAN_PACKAGE_ID_INVALID", 64, 64);
  if (!/^[a-f0-9]{64}$/.test(packageId)) throw new Error("VISUAL_PLAN_PACKAGE_ID_INVALID");
  const publicBrand = requireSafeText(input.publicBrand, "VISUAL_PLAN_PUBLIC_BRAND_INVALID", 2, 80);
  const suppliedConcept = requireSafeText(input.suppliedConcept, "VISUAL_PLAN_CONCEPT_INVALID", 20, 1200);
  if (!Array.isArray(input.providerCalls) || input.providerCalls.length !== 0) {
    throw new Error("VISUAL_PLAN_PROVIDER_OUTPUT_REJECTED");
  }
  if (!input.publication || input.publication.requested !== false || input.publication.status !== "not_requested") {
    throw new Error("VISUAL_PLAN_PUBLICATION_SCOPE_REJECTED");
  }
  if (!Array.isArray(input.storyOutline) || input.storyOutline.length !== EXPECTED_BEATS.length) {
    throw new Error("VISUAL_PLAN_BEATS_INVALID");
  }
  const beats = input.storyOutline.map((entry, index) => {
    if (!entry || entry.beat !== EXPECTED_BEATS[index]) throw new Error("VISUAL_PLAN_BEATS_INVALID");
    return {
      beat: entry.beat,
      purpose: requireSafeText(entry.purpose, "VISUAL_PLAN_BEAT_PURPOSE_INVALID", 10, 300),
    };
  });
  if (!Array.isArray(input.shortsPlan) ||
      input.shortsPlan.length !== EXPECTED_SHORT_ROLES.length ||
      !input.shortsPlan.every((role, index) => role === EXPECTED_SHORT_ROLES[index])) {
    throw new Error("VISUAL_PLAN_SHORTS_ROLES_INVALID");
  }
  return { packageId, publicBrand, suppliedConcept, beats };
}

/**
 * Builds specifications only. It does not generate, render, upload, or publish media.
 */
export function createDeterministicVisualScenePlan(outlinePackage) {
  const validated = validateOutlinePackage(outlinePackage);
  const longFormScenes = validated.beats.map(({ beat, purpose }, index) => ({
    sceneNumber: index + 1,
    beat,
    purpose,
    frame: { aspectRatio: "16:9", width: 1920, height: 1080 },
    visualSafety: {
      sourceMaterial: "owner_supplied_concept_only",
      requireOriginalComposition: true,
      protectedCharacterImitation: false,
    },
  }));
  const shortsScenes = EXPECTED_SHORT_ROLES.map((role, index) => ({
    sceneNumber: index + 1,
    role,
    frame: { aspectRatio: "9:16", width: 1080, height: 1920 },
    endingDisclosure: role === "cliffhanger_teaser" ? "ending_not_revealed" : "not_applicable",
  }));
  const planId = stableId({ sourcePackageId: validated.packageId, longFormScenes, shortsScenes });

  return {
    schemaVersion: 1,
    planId,
    sourcePackageId: validated.packageId,
    packageType: "visual_scene_plan_v1",
    readiness: "scene_plan_only",
    generationMode: "deterministic_local",
    publicBrand: validated.publicBrand,
    longFormScenes,
    shortsScenes,
    generatedMedia: [],
    providerCalls: [],
    publication: { requested: false, status: "not_requested" },
  };
}
