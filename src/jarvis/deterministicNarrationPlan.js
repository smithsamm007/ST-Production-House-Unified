import crypto from "node:crypto";

const AGENT_ID = "agent-01";
const JOB_TYPE = "jarvis.content.narration-plan.v1";
const SOURCE_PACKAGE_TYPE = "jarvis_mvp_story_outline";
const LANGUAGES = new Set(["hindi", "hinglish"]);
const EXPECTED_BEATS = ["hook", "discovery", "escalation", "reversal", "cliffhanger"];
const INTERNAL_AGENT_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i"
);
const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token)/i;

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicText(value, code, min = 2, max = 1200) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_LIKE.test(normalized)) throw new Error("NARRATION_PLAN_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAMES.test(normalized)) throw new Error("NARRATION_PLAN_INTERNAL_NAME_REJECTED");
  return normalized;
}

function validateOutlinePackage(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("NARRATION_PLAN_SOURCE_INVALID");
  }
  if (SECRET_LIKE.test(JSON.stringify(source))) throw new Error("NARRATION_PLAN_SECRET_REJECTED");
  if (source.schemaVersion !== 1 || source.packageType !== SOURCE_PACKAGE_TYPE || source.readiness !== "outline_only") {
    throw new Error("NARRATION_PLAN_SOURCE_CONTRACT_MISMATCH");
  }
  if (source.generationMode !== "deterministic_local" || !Array.isArray(source.providerCalls) || source.providerCalls.length !== 0) {
    throw new Error("NARRATION_PLAN_SOURCE_NOT_LOCAL");
  }
  if (source.publication?.requested !== false || source.publication?.status !== "not_requested") {
    throw new Error("NARRATION_PLAN_SOURCE_PUBLICATION_STATE_INVALID");
  }
  if (typeof source.packageId !== "string" || !/^[a-f0-9]{64}$/.test(source.packageId)) {
    throw new Error("NARRATION_PLAN_SOURCE_ID_INVALID");
  }
  const publicBrand = publicText(source.publicBrand, "NARRATION_PLAN_PUBLIC_BRAND_INVALID", 2, 80);
  publicText(source.suppliedConcept, "NARRATION_PLAN_CONCEPT_INVALID", 20, 1200);
  const language = String(source.language || "").toLowerCase();
  if (!LANGUAGES.has(language)) throw new Error("NARRATION_PLAN_LANGUAGE_UNSUPPORTED");
  if (!Number.isInteger(source.targetMinutes) || source.targetMinutes < 25 || source.targetMinutes > 30) {
    throw new Error("NARRATION_PLAN_DURATION_INVALID");
  }
  if (!Array.isArray(source.storyOutline) || source.storyOutline.length !== EXPECTED_BEATS.length) {
    throw new Error("NARRATION_PLAN_BEATS_INVALID");
  }
  const beats = source.storyOutline.map((item, index) => {
    if (!item || item.beat !== EXPECTED_BEATS[index]) throw new Error("NARRATION_PLAN_BEATS_INVALID");
    return { beat: item.beat, purpose: publicText(item.purpose, "NARRATION_PLAN_BEAT_PURPOSE_INVALID", 10, 300) };
  });
  return { publicBrand, language, targetMinutes: source.targetMinutes, beats };
}

function narrationDirection(language, beat) {
  const hindi = {
    hook: "धीमी शुरुआत, फिर पहले असामान्य संकेत पर तुरंत तनाव बढ़ाएँ।",
    discovery: "रहस्य को स्पष्ट उच्चारण और नियंत्रित जिज्ञासा के साथ सामने रखें।",
    escalation: "छोटे विरामों के साथ डर और भावनात्मक दबाव लगातार बढ़ाएँ।",
    reversal: "विश्वास बदलने वाले मोड़ से पहले लंबा विराम रखें।",
    cliffhanger: "अंतिम सत्य बताए बिना अनसुलझे खतरे पर आवाज़ रोकें।",
  };
  const hinglish = {
    hook: "Dheemi shuruaat ke baad pehle unusual signal par tension turant badhaayein.",
    discovery: "Raaz ko clear pronunciation aur controlled curiosity ke saath reveal karein.",
    escalation: "Chhote pauses ke saath darr aur emotional pressure lagataar badhaayein.",
    reversal: "Audience ka bharosa badalne wale twist se pehle ek lamba pause rakhein.",
    cliffhanger: "Final sach reveal kiye bina unresolved danger par narration rok dein.",
  };
  return (language === "hindi" ? hindi : hinglish)[beat];
}

export function createDeterministicNarrationPlan(source) {
  const validated = validateOutlinePackage(source);
  const totalSeconds = validated.targetMinutes * 60;
  const weights = [0.12, 0.2, 0.27, 0.23];
  const durations = weights.map((weight) => Math.floor(totalSeconds * weight));
  durations.push(totalSeconds - durations.reduce((sum, value) => sum + value, 0));
  const narrationSegments = validated.beats.map((beat, index) => ({
    segment: index + 1,
    beat: beat.beat,
    plannedDurationSeconds: durations[index],
    narratorProfile: index === 3 ? "indian_female_narrator" : "indian_male_narrator",
    deliveryDirection: narrationDirection(validated.language, beat.beat),
    outlinePurpose: beat.purpose,
    audioStatus: "not_generated",
  }));
  const planIdentity = {
    sourcePackageId: source.packageId,
    language: validated.language,
    targetMinutes: validated.targetMinutes,
    narrationSegments,
  };
  return {
    schemaVersion: 1,
    packageId: stableId(planIdentity),
    packageType: "narration_audio_plan",
    sourcePackageId: source.packageId,
    readiness: "narration_plan_only",
    generationMode: "deterministic_local",
    publicBrand: validated.publicBrand,
    language: validated.language,
    targetMinutes: validated.targetMinutes,
    voiceProfiles: [
      { label: "indian_male_narrator", genderPresentation: "male", provider: null, status: "profile_only" },
      { label: "indian_female_narrator", genderPresentation: "female", provider: null, status: "profile_only" },
    ],
    narrationSegments,
    cuePlan: validated.beats.map((beat, index) => ({
      segment: index + 1,
      beat: beat.beat,
      bgmMood: ["uneasy_ambient", "mystery_low_pulse", "rising_tension", "reversal_sting", "unresolved_dark_ambient"][index],
      sfxIntent: ["distant_room_tone", "subtle_discovery_accent", "escalating_environmental_detail", "single_twist_accent", "abrupt_silence"][index],
      assetReference: null,
      status: "cue_only",
    })),
    generatedAudio: [],
    bundledAssets: [],
    providerCalls: [],
    publication: { requested: false, status: "not_requested" },
  };
}

export async function deterministicNarrationPlanHandler(ctx) {
  if (ctx.agentId !== AGENT_ID || ctx.jobType !== JOB_TYPE) throw new Error("NARRATION_PLAN_SCOPE_MISMATCH");
  const plan = createDeterministicNarrationPlan(ctx.payload?.outlinePackage);
  ctx.heartbeat("narration_source_validated", 20, { generationMode: "deterministic_local" });
  await ctx.checkpoint("narration_source_validated", 20, { sourcePackageId: plan.sourcePackageId });
  await ctx.checkpoint("narration_plan_ready", 100, { packageId: plan.packageId, readiness: plan.readiness });
  return plan;
}
import { PRELOADED_AGENTS } from "../catalog/agents.js";
