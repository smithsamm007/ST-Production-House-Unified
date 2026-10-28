import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const AGENT_ID = "agent-01";
const JOB_TYPE = "jarvis.content.metadata-thumbnail-plan.v1";
const SOURCE_PACKAGE_TYPE = "jarvis_mvp_story_outline";
const LANGUAGES = new Set(["hindi", "hinglish"]);
const EXPECTED_BEATS = ["hook", "discovery", "escalation", "reversal", "cliffhanger"];
const INTERNAL_AGENT_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);
const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token)/i;
const URL_LIKE = /(?:https?:\/\/|www\.|javascript:|data:)/i;

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicText(value, code, min = 2, max = 1200) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_LIKE.test(normalized)) throw new Error("METADATA_PLAN_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAMES.test(normalized)) throw new Error("METADATA_PLAN_INTERNAL_NAME_REJECTED");
  if (URL_LIKE.test(normalized)) throw new Error("METADATA_PLAN_UNSAFE_URL_REJECTED");
  return normalized;
}

function validateOutlinePackage(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("METADATA_PLAN_SOURCE_INVALID");
  const serialized = JSON.stringify(source);
  if (SECRET_LIKE.test(serialized)) throw new Error("METADATA_PLAN_SECRET_REJECTED");
  if (URL_LIKE.test(serialized)) throw new Error("METADATA_PLAN_UNSAFE_URL_REJECTED");
  if (source.schemaVersion !== 1 || source.packageType !== SOURCE_PACKAGE_TYPE || source.readiness !== "outline_only") {
    throw new Error("METADATA_PLAN_SOURCE_CONTRACT_MISMATCH");
  }
  if (source.generationMode !== "deterministic_local" || !Array.isArray(source.providerCalls) || source.providerCalls.length !== 0) {
    throw new Error("METADATA_PLAN_SOURCE_NOT_LOCAL");
  }
  if (source.publication?.requested !== false || source.publication?.status !== "not_requested") {
    throw new Error("METADATA_PLAN_SOURCE_PUBLICATION_STATE_INVALID");
  }
  if (typeof source.packageId !== "string" || !/^[a-f0-9]{64}$/.test(source.packageId)) {
    throw new Error("METADATA_PLAN_SOURCE_ID_INVALID");
  }
  const publicBrand = publicText(source.publicBrand, "METADATA_PLAN_PUBLIC_BRAND_INVALID", 2, 80);
  const suppliedConcept = publicText(source.suppliedConcept, "METADATA_PLAN_CONCEPT_INVALID", 20, 1200);
  const language = String(source.language || "").toLowerCase();
  if (!LANGUAGES.has(language)) throw new Error("METADATA_PLAN_LANGUAGE_UNSUPPORTED");
  if (!Number.isInteger(source.targetMinutes) || source.targetMinutes < 25 || source.targetMinutes > 30) {
    throw new Error("METADATA_PLAN_DURATION_INVALID");
  }
  if (!Array.isArray(source.storyOutline) || source.storyOutline.length !== EXPECTED_BEATS.length) {
    throw new Error("METADATA_PLAN_BEATS_INVALID");
  }
  source.storyOutline.forEach((item, index) => {
    if (!item || item.beat !== EXPECTED_BEATS[index]) throw new Error("METADATA_PLAN_BEATS_INVALID");
    publicText(item.purpose, "METADATA_PLAN_BEAT_PURPOSE_INVALID", 10, 300);
  });
  return { publicBrand, suppliedConcept, language, targetMinutes: source.targetMinutes };
}

function languageDrafts({ publicBrand, suppliedConcept, language, targetMinutes }) {
  if (language === "hindi") {
    return {
      titles: [
        `${publicBrand}: एक अनसुलझा रहस्य`,
        `${publicBrand}: खतरे से पहले की खामोशी`,
        `${publicBrand}: आख़िरी सच अभी बाकी है`,
      ],
      description: `${publicBrand} की यह ${targetMinutes} मिनट की हिंदी कहानी दिए गए विचार पर आधारित एक रहस्य, बढ़ते खतरे और अधूरे सच की रूपरेखा है। मूल विचार: ${suppliedConcept}`,
      hashtags: ["#HindiKahani", "#Rahasya", "#SuspenseStory"],
      overlayText: "सच अभी बाकी है",
    };
  }
  return {
    titles: [
      `${publicBrand}: Ek Unsolved Raaz`,
      `${publicBrand}: Khatre Se Pehle Ki Khamoshi`,
      `${publicBrand}: Aakhri Sach Abhi Baaki Hai`,
    ],
    description: `${publicBrand} ki yeh ${targetMinutes}-minute Hinglish story supplied concept par based mystery, rising danger aur unresolved truth ki draft outline hai. Supplied concept: ${suppliedConcept}`,
    hashtags: ["#HinglishStory", "#HindiKahani", "#SuspenseStory"],
    overlayText: "SACH ABHI BAAKI HAI",
  };
}

export function createDeterministicMetadataThumbnailPlan(source) {
  const validated = validateOutlinePackage(source);
  const drafts = languageDrafts(validated);
  const planIdentity = {
    sourcePackageId: source.packageId,
    language: validated.language,
    titles: drafts.titles,
    description: drafts.description,
    hashtags: drafts.hashtags,
    overlayText: drafts.overlayText,
  };
  return {
    schemaVersion: 1,
    packageId: stableId(planIdentity),
    packageType: "metadata_thumbnail_plan",
    sourcePackageId: source.packageId,
    readiness: "metadata_thumbnail_plan_only",
    generationMode: "deterministic_local",
    publicBrand: validated.publicBrand,
    language: validated.language,
    metadataDraft: {
      status: "draft_only",
      titleVariants: drafts.titles,
      description: drafts.description,
      hashtags: drafts.hashtags,
      seoPerformanceClaims: [],
      urls: [],
    },
    thumbnailBrief: {
      status: "brief_only",
      composition: "One clear focal subject in a shadowed environment, with negative space reserved for short overlay text.",
      mood: "cinematic suspense with restrained contrast and an unresolved visual question",
      colorDirection: ["deep_blue", "charcoal", "muted_amber_accent"],
      overlayText: drafts.overlayText,
      generatedAsset: null,
      assetReference: null,
    },
    generatedAssets: [],
    providerCalls: [],
    publication: { requested: false, status: "not_requested" },
  };
}

export async function deterministicMetadataThumbnailPlanHandler(ctx) {
  if (ctx.agentId !== AGENT_ID || ctx.jobType !== JOB_TYPE) throw new Error("METADATA_PLAN_SCOPE_MISMATCH");
  const plan = createDeterministicMetadataThumbnailPlan(ctx.payload?.outlinePackage);
  ctx.heartbeat("metadata_source_validated", 20, { generationMode: "deterministic_local" });
  await ctx.checkpoint("metadata_source_validated", 20, { sourcePackageId: plan.sourcePackageId });
  await ctx.checkpoint("metadata_thumbnail_plan_ready", 100, { packageId: plan.packageId, readiness: plan.readiness });
  return plan;
}
