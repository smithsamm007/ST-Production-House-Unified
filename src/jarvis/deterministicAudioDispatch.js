import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { WorkEnvelope } from "../workers/workEnvelope.js";

const AGENT_ID = "agent-01";
const JOB_TYPE = "jarvis.audio.dispatch.v1";
const SOURCE_PACKAGE_TYPE = "narration_audio_plan";
const EXPECTED_BEATS = ["hook", "discovery", "escalation", "reversal", "cliffhanger"];
const VOICE_PROFILES = new Set(["indian_male_narrator", "indian_female_narrator"]);
const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator)/i;
const INTERNAL_AGENT_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeText(value, code, min = 2, max = 1200) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_LIKE.test(normalized)) throw new Error("AUDIO_DISPATCH_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAMES.test(normalized)) throw new Error("AUDIO_DISPATCH_INTERNAL_NAME_REJECTED");
  return normalized;
}

function isEmptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function validateNarrationPlan(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("AUDIO_DISPATCH_SOURCE_INVALID");
  if (SECRET_LIKE.test(JSON.stringify(source))) throw new Error("AUDIO_DISPATCH_SECRET_REJECTED");
  if (source.schemaVersion !== 1 || source.packageType !== SOURCE_PACKAGE_TYPE || source.readiness !== "narration_plan_only") {
    throw new Error("AUDIO_DISPATCH_SOURCE_CONTRACT_MISMATCH");
  }
  if (source.generationMode !== "deterministic_local" || !isEmptyArray(source.providerCalls)) {
    throw new Error("AUDIO_DISPATCH_SOURCE_NOT_LOCAL");
  }
  if (!isEmptyArray(source.generatedAudio) || !isEmptyArray(source.bundledAssets)) {
    throw new Error("AUDIO_DISPATCH_SOURCE_SIDE_EFFECT_CLAIMED");
  }
  if (source.publication?.requested !== false || source.publication?.status !== "not_requested") {
    throw new Error("AUDIO_DISPATCH_SOURCE_PUBLICATION_STATE_INVALID");
  }
  if (typeof source.packageId !== "string" || !/^[a-f0-9]{64}$/.test(source.packageId)) {
    throw new Error("AUDIO_DISPATCH_SOURCE_ID_INVALID");
  }
  const publicBrand = safeText(source.publicBrand, "AUDIO_DISPATCH_PUBLIC_BRAND_INVALID", 2, 80);
  const language = String(source.language || "").toLowerCase();
  if (language !== "hindi" && language !== "hinglish") throw new Error("AUDIO_DISPATCH_LANGUAGE_UNSUPPORTED");
  if (!Number.isInteger(source.targetMinutes) || source.targetMinutes < 25 || source.targetMinutes > 30) {
    throw new Error("AUDIO_DISPATCH_DURATION_INVALID");
  }
  if (!Array.isArray(source.voiceProfiles) || source.voiceProfiles.length !== 2) throw new Error("AUDIO_DISPATCH_VOICE_PROFILES_INVALID");
  for (const profile of source.voiceProfiles) {
    if (!profile || !VOICE_PROFILES.has(profile.label) || profile.status !== "profile_only" || profile.provider !== null) {
      throw new Error("AUDIO_DISPATCH_VOICE_PROFILES_INVALID");
    }
  }
  if (!Array.isArray(source.narrationSegments) || source.narrationSegments.length !== EXPECTED_BEATS.length) {
    throw new Error("AUDIO_DISPATCH_SEGMENTS_INVALID");
  }
  const segments = source.narrationSegments.map((segment, index) => {
    if (!segment || segment.segment !== index + 1 || segment.beat !== EXPECTED_BEATS[index]) {
      throw new Error("AUDIO_DISPATCH_SEGMENTS_INVALID");
    }
    if (!Number.isInteger(segment.plannedDurationSeconds) || segment.plannedDurationSeconds < 1) {
      throw new Error("AUDIO_DISPATCH_SEGMENT_DURATION_INVALID");
    }
    if (!VOICE_PROFILES.has(segment.narratorProfile) || segment.audioStatus !== "not_generated") {
      throw new Error("AUDIO_DISPATCH_SEGMENTS_INVALID");
    }
    return {
      segment: segment.segment,
      beat: segment.beat,
      plannedDurationSeconds: segment.plannedDurationSeconds,
      narratorProfile: segment.narratorProfile,
      deliveryDirection: safeText(segment.deliveryDirection, "AUDIO_DISPATCH_DIRECTION_INVALID", 10, 300),
      outlinePurpose: safeText(segment.outlinePurpose, "AUDIO_DISPATCH_PURPOSE_INVALID", 10, 300),
    };
  });
  if (segments.reduce((sum, segment) => sum + segment.plannedDurationSeconds, 0) !== source.targetMinutes * 60) {
    throw new Error("AUDIO_DISPATCH_TOTAL_DURATION_MISMATCH");
  }
  if (!Array.isArray(source.cuePlan) || source.cuePlan.length !== EXPECTED_BEATS.length) throw new Error("AUDIO_DISPATCH_CUES_INVALID");
  const cues = source.cuePlan.map((cue, index) => {
    if (!cue || cue.segment !== index + 1 || cue.beat !== EXPECTED_BEATS[index] || cue.status !== "cue_only" || cue.assetReference !== null) {
      throw new Error("AUDIO_DISPATCH_CUES_INVALID");
    }
    return {
      segment: cue.segment,
      beat: cue.beat,
      bgmMood: safeText(cue.bgmMood, "AUDIO_DISPATCH_CUE_INVALID", 3, 100),
      sfxIntent: safeText(cue.sfxIntent, "AUDIO_DISPATCH_CUE_INVALID", 3, 100),
      assetReference: null,
      cueStatus: "not_executed",
    };
  });
  return { publicBrand, language, targetMinutes: source.targetMinutes, segments, cues };
}

function envelope({ taskId, jobType, payload, ownerId, sourcePackageId }) {
  return new WorkEnvelope({
    taskId,
    jobType,
    agentId: AGENT_ID,
    payload,
    context: {
      ownerId,
      sourcePackageId,
      dispatchMode: "provider_independent",
      executionStatus: "not_started",
    },
  });
}

export function createDeterministicAudioDispatch(source, { ownerId, agentId = AGENT_ID } = {}) {
  if (agentId !== AGENT_ID || typeof ownerId !== "string" || !/^[a-zA-Z0-9_-]{3,80}$/.test(ownerId)) {
    throw new Error("AUDIO_DISPATCH_SCOPE_MISMATCH");
  }
  const validated = validateNarrationPlan(source);
  const narrationRequests = validated.segments.map((segment) => {
    const identity = { sourcePackageId: source.packageId, ownerId, requestKind: "narration_tts", segment };
    return envelope({
      taskId: `audio-${stableId(identity)}`,
      jobType: "audio.narration.generate.v1",
      ownerId,
      sourcePackageId: source.packageId,
      payload: {
        capability: "audio_generation",
        requestKind: "narration_tts",
        language: validated.language,
        ...segment,
        executionStatus: "not_started",
      },
    });
  });
  const cueIdentity = { sourcePackageId: source.packageId, ownerId, requestKind: "cue_planning", cues: validated.cues };
  const cueRequest = envelope({
    taskId: `audio-${stableId(cueIdentity)}`,
    jobType: "audio.cues.plan.v1",
    ownerId,
    sourcePackageId: source.packageId,
    payload: {
      capability: "audio_generation",
      requestKind: "cue_planning",
      language: validated.language,
      cues: validated.cues,
      executionStatus: "not_started",
    },
  });
  const requests = Object.freeze([...narrationRequests, cueRequest]);
  const packageIdentity = { sourcePackageId: source.packageId, ownerId, taskIds: requests.map(({ taskId }) => taskId) };
  return Object.freeze({
    schemaVersion: 1,
    packageId: stableId(packageIdentity),
    packageType: "audio_dispatch_plan",
    sourcePackageId: source.packageId,
    readiness: "dispatch_ready_only",
    capability: "audio_generation",
    generationMode: "deterministic_local",
    ownerId,
    agentId,
    publicBrand: validated.publicBrand,
    language: validated.language,
    targetMinutes: validated.targetMinutes,
    requests,
    providerCalls: [],
    evidence: [],
    artifacts: [],
    publication: { requested: false, status: "not_requested" },
  });
}

export function createWaitingForQuotaCheckpoint(dispatchPlan) {
  if (!dispatchPlan || dispatchPlan.packageType !== "audio_dispatch_plan" || dispatchPlan.readiness !== "dispatch_ready_only") {
    throw new Error("AUDIO_DISPATCH_PLAN_INVALID");
  }
  if (!Array.isArray(dispatchPlan.requests) || dispatchPlan.requests.length < 1) throw new Error("AUDIO_DISPATCH_REQUESTS_INVALID");
  const pendingTaskIds = dispatchPlan.requests.map(({ taskId }) => taskId);
  const checkpointId = stableId({ packageId: dispatchPlan.packageId, status: "WAITING_FOR_QUOTA", pendingTaskIds });
  return Object.freeze({
    checkpointId,
    step: "waiting_for_quota",
    progress: 0,
    state: "WAITING_FOR_QUOTA",
    reasonCode: "APPROVED_FREE_CAPACITY_UNAVAILABLE",
    capability: "audio_generation",
    resumable: true,
    resumeFrom: "audio_dispatch_ready",
    dispatchPackageId: dispatchPlan.packageId,
    pendingTaskIds: Object.freeze([...pendingTaskIds]),
    providerCalls: Object.freeze([]),
  });
}

export async function deterministicAudioDispatchHandler(ctx) {
  if (ctx.agentId !== AGENT_ID || ctx.jobType !== JOB_TYPE) throw new Error("AUDIO_DISPATCH_SCOPE_MISMATCH");
  const plan = createDeterministicAudioDispatch(ctx.payload?.narrationPlan, {
    ownerId: ctx.context?.ownerId,
    agentId: ctx.agentId,
  });
  ctx.heartbeat("audio_dispatch_validated", 20, { capability: "audio_generation" });
  await ctx.checkpoint("audio_dispatch_validated", 20, { sourcePackageId: plan.sourcePackageId });
  await ctx.checkpoint("audio_dispatch_ready", 100, { packageId: plan.packageId, readiness: plan.readiness });
  return plan;
}
