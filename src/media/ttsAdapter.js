/**
 * ST Production House — TTS adapter contract + persistent voice continuity
 * (S-M32-01, Module 32 — media pipeline, offline contract layer).
 *
 * Pure, deterministic, offline module. It performs NO audio generation, NO
 * provider calls, NO filesystem access, and NO clock reads. It exists so the
 * future real TTS workers have a truthful contract to implement against:
 *
 *   - Provider routing follows the fixed free-first chain: approved free
 *     primary → secondary → tertiary → local open-source emergency. There is
 *     no paid fallback and no account rotation anywhere in this contract.
 *   - A per-Director / per-character voice profile persists provider, model,
 *     voice, language, pronunciation, rate, pitch, and emotion configuration.
 *     It never carries secret material (Rule 17): credentials live in the
 *     credential broker behind opaque locators, never here.
 *   - A generation outcome is truthful by construction: a provider call that
 *     merely reports "succeeded" is NOT evidence of generated audio. The
 *     outcome's media state derives ONLY from the artifact descriptor's
 *     verification state (S-M30-01), which is UNVERIFIED unless a real
 *     matching inspection result promoted it. Quota exhaustion is recorded
 *     as WAITING_FOR_QUOTA — never disguised as success.
 *   - Serialization is a strict allowlist (Rule 17); internal agent names are
 *     rejected in free-text fields (Rule 15); identical inputs produce
 *     byte-identical records with recomputed SHA-256 ids (no clocks).
 */

import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import {
  INSPECTION_TOOLS,
  descriptorFingerprint,
} from "./artifactDescriptor.js";

export const TTS_OUTCOME_TYPE = "tts_generation_outcome_v1";
export const TTS_PROFILE_TYPE = "tts_voice_profile_v1";
export const TTS_CAPABILITIES_TYPE = "tts_provider_capabilities_v1";

/** Fixed free-first routing chain. Order is contract; never reordered. */
export const TTS_PROVIDER_TIERS = Object.freeze([
  Object.freeze({ tier: 1, role: "approved_free_primary" }),
  Object.freeze({ tier: 2, role: "approved_free_secondary" }),
  Object.freeze({ tier: 3, role: "approved_free_tertiary" }),
  Object.freeze({ tier: 4, role: "local_open_source_emergency" }),
]);

const PROVIDER_ROLES = new Set(TTS_PROVIDER_TIERS.map((tier) => tier.role));

export const TTS_EMOTIONS = Object.freeze([
  "neutral",
  "suspense",
  "dark",
  "urgent",
  "calm",
  "warm",
  "hopeful",
  "somber",
]);

export const TTS_LANGUAGES = Object.freeze(["en", "hi", "hinglish"]);

export const TTS_CALL_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "quota_exhausted",
]);

const AGENT_IDS = new Set(PRELOADED_AGENTS.map(({ id }) => id));
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,60}$/;
const LANGUAGE_RE = /^[a-z]{2,8}(?:[-_][a-zA-Z0-9]{2,12})?$/;

function ttsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw ttsError(code);
  }
}

function cleanText(value, code, max) {
  if (typeof value !== "string") throw ttsError(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > max) throw ttsError(code);
  if (SECRET_LIKE.test(normalized)) throw ttsError("TTS_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw ttsError("TTS_INTERNAL_NAME_REJECTED");
  return normalized;
}

/** Registered internal agent id (Rule 15: names are internal-only). */
function requireAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw ttsError("TTS_AGENT_INVALID");
  }
  return agentId;
}

function optionalCharacterId(characterId) {
  if (characterId === undefined || characterId === null) return null;
  return cleanText(characterId, "TTS_CHARACTER_INVALID", 80);
}

function requireLanguage(language) {
  if (typeof language !== "string" || !LANGUAGE_RE.test(language)) {
    throw ttsError("TTS_LANGUAGE_INVALID");
  }
  return language.toLowerCase();
}

function requireBoundedNumber(value, code, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw ttsError(code);
  }
  return value;
}

function requireProviderId(providerId) {
  if (typeof providerId !== "string" || !ID_RE.test(providerId)) {
    throw ttsError("TTS_PROVIDER_INVALID");
  }
  if (SECRET_LIKE.test(providerId)) throw ttsError("TTS_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(providerId)) throw ttsError("TTS_INTERNAL_NAME_REJECTED");
  return providerId;
}

function requireProviderRole(providerRole) {
  if (typeof providerRole !== "string" || !PROVIDER_ROLES.has(providerRole)) {
    throw ttsError("TTS_PROVIDER_ROLE_INVALID");
  }
  return providerRole;
}

// ---------------------------------------------------------------------------
// Provider capability declaration (what an adapter CLAIMS it can do)
// ---------------------------------------------------------------------------

/**
 * Declares an adapter's capabilities. A capability declaration is a claim by
 * the adapter author — it is metadata for routing, never evidence that any
 * generation happened.
 */
export function declareTtsProviderCapabilities(input = {}) {
  requirePlainObject(input, "TTS_CAPABILITY_INVALID");
  const adapterId = cleanText(input.adapterId, "TTS_ADAPTER_ID_INVALID", 120);
  if (!Array.isArray(input.languages) || input.languages.length === 0 || input.languages.length > 32) {
    throw ttsError("TTS_LANGUAGE_INVALID");
  }
  const languages = Object.freeze([...new Set(input.languages.map(requireLanguage))].sort());
  if (!Array.isArray(input.voices) || input.voices.length === 0 || input.voices.length > 200) {
    throw ttsError("TTS_VOICE_INVALID");
  }
  const voices = Object.freeze(input.voices.map((voice) => {
    requirePlainObject(voice, "TTS_VOICE_INVALID");
    return Object.freeze({
      voiceId: cleanText(voice.voiceId, "TTS_VOICE_INVALID", 120),
      language: requireLanguage(voice.language),
      supportsEmotion: voice.supportsEmotion === true,
    });
  }));
  const rateBounds = bounds(input.rateBounds, "TTS_BOUNDS_INVALID", 0.1, 5);
  const pitchBounds = bounds(input.pitchBounds, "TTS_BOUNDS_INVALID", -50, 50);
  const capabilities = {
    capabilitiesType: TTS_CAPABILITIES_TYPE,
    adapterId,
    languages,
    voices,
    supportsEmotion: input.supportsEmotion === true,
    supportsRate: input.supportsRate === true,
    supportsPitch: input.supportsPitch === true,
    rateBounds,
    pitchBounds,
  };
  capabilities.capabilitiesId = stableId(capabilities);
  return Object.freeze(capabilities);
}

function bounds(value, code, min, max) {
  if (value === undefined || value === null) return null;
  requirePlainObject(value, code);
  const low = requireBoundedNumber(value.min, code, min, max);
  const high = requireBoundedNumber(value.max, code, min, max);
  if (low > high) throw ttsError(code);
  return Object.freeze({ min: low, max: high });
}

// ---------------------------------------------------------------------------
// Voice continuity profile (per Director / per character)
// ---------------------------------------------------------------------------

/**
 * Creates a persistent voice-continuity profile. The profile binds one
 * Director (and optionally one character) to one provider slot, voice, and
 * delivery configuration so narration stays consistent across production
 * runs. No credential material is ever stored here.
 */
export function createVoiceProfile(input = {}) {
  requirePlainObject(input, "TTS_PROFILE_INVALID");
  const agentId = requireAgentId(input.agentId);
  const characterId = optionalCharacterId(input.characterId);
  const provider = input.provider === undefined || input.provider === null
    ? null
    : requireProviderBlock(input.provider);
  const language = input.language === undefined || input.language === null
    ? null
    : requireLanguage(input.language);
  const pronunciationProfile = normalizePronunciation(input.pronunciationProfile);
  const speakingRate = input.speakingRate === undefined || input.speakingRate === null
    ? null
    : requireBoundedNumber(input.speakingRate, "TTS_RATE_INVALID", 0.1, 5);
  const pitch = input.pitch === undefined || input.pitch === null
    ? null
    : requireBoundedNumber(input.pitch, "TTS_PITCH_INVALID", -50, 50);
  const emotion = input.emotion === undefined || input.emotion === null
    ? "neutral"
    : requireEmotion(input.emotion);

  const profile = {
    profileType: TTS_PROFILE_TYPE,
    agentId,
    characterId,
    provider,
    language,
    pronunciationProfile,
    speakingRate,
    pitch,
    emotion,
  };
  profile.voiceProfileId = stableId(profile);
  return Object.freeze(profile);
}

function requireProviderBlock(provider) {
  requirePlainObject(provider, "TTS_PROVIDER_INVALID");
  return Object.freeze({
    providerId: requireProviderId(provider.providerId),
    providerRole: requireProviderRole(provider.providerRole),
    modelIdentifier: cleanText(provider.modelIdentifier, "TTS_MODEL_INVALID", 160),
    voiceId: cleanText(provider.voiceId, "TTS_VOICE_INVALID", 160),
  });
}

function normalizePronunciation(entries) {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries) || entries.length > 50) throw ttsError("TTS_PRONUNCIATION_INVALID");
  return Object.freeze(entries.map((entry) => {
    requirePlainObject(entry, "TTS_PRONUNCIATION_INVALID");
    return Object.freeze({
      match: cleanText(entry.match, "TTS_PRONUNCIATION_INVALID", 120),
      replaceWith: cleanText(entry.replaceWith, "TTS_PRONUNCIATION_INVALID", 300),
    });
  }));
}

function requireEmotion(emotion) {
  if (typeof emotion !== "string" || !TTS_EMOTIONS.includes(emotion)) {
    throw ttsError("TTS_EMOTION_INVALID");
  }
  return emotion;
}

/** Recomputes the profile id over its identity content (tamper detection). */
export function computeVoiceProfileId(profile) {
  const {
    profileType, agentId, characterId, provider, language,
    pronunciationProfile, speakingRate, pitch, emotion,
  } = profile ?? {};
  return stableId({
    profileType, agentId, characterId, provider, language,
    pronunciationProfile, speakingRate, pitch, emotion,
  });
}

/** Returns `{ ok: true }` or `{ ok: false, reasonCode }`; never throws on mismatch. */
export function verifyVoiceProfile(profile) {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    return { ok: false, reasonCode: "TTS_PROFILE_MALFORMED" };
  }
  if (profile.profileType !== TTS_PROFILE_TYPE) {
    return { ok: false, reasonCode: "TTS_PROFILE_MALFORMED" };
  }
  if (profile.voiceProfileId !== computeVoiceProfileId(profile)) {
    return { ok: false, reasonCode: "TTS_PROFILE_TAMPERED" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Generation outcome (truthful by construction)
// ---------------------------------------------------------------------------

/**
 * Records one TTS generation attempt against a voice profile and its audio
 * artifact descriptor. The fail-closed core of this contract:
 *
 *   - `providerCall.status === "succeeded"` is a CLAIM by the adapter, not
 *     evidence. `mediaStatus` derives exclusively from the descriptor's
 *     verification state; `generationMode` is "provider_generated" only for
 *     a VERIFIED descriptor (which only the S-M30-01 promotion path — a real
 *     matching inspection — can produce) and "not_evidenced" otherwise.
 *   - `quota_exhausted` maps to quotaState WAITING_FOR_QUOTA: a durable,
 *     resumable waiting state, never a success.
 *   - The outcome is Director-scoped: the descriptor's producer agent must
 *     match the profile's agent, or the record fails closed.
 */
export function recordTtsGenerationOutcome(input = {}) {
  requirePlainObject(input, "TTS_INPUT_INVALID");
  const profile = input.voiceProfile;
  if (verifyVoiceProfile(profile).ok === false) {
    throw ttsError("TTS_PROFILE_INVALID");
  }
  const descriptor = requireAudioDescriptor(input.descriptor);
  if (descriptor.producer.agentId !== profile.agentId) {
    throw ttsError("TTS_AGENT_SCOPE_MISMATCH");
  }
  const providerCall = requireProviderCall(input.providerCall);
  if (providerCall.providerId !== profile.provider.providerId ||
      providerCall.providerRole !== profile.provider.providerRole) {
    throw ttsError("TTS_PROVIDER_MISMATCH");
  }

  const verified = descriptor.verification.state === "VERIFIED";
  const quotaState = providerCall.status === "quota_exhausted" ? "WAITING_FOR_QUOTA" : "OK";
  const outcome = {
    outcomeType: TTS_OUTCOME_TYPE,
    agentId: profile.agentId,
    voiceProfileId: profile.voiceProfileId,
    descriptorFingerprint: descriptorFingerprint(descriptor),
    descriptorVerificationState: descriptor.verification.state,
    provider: Object.freeze({
      providerId: providerCall.providerId,
      providerRole: providerCall.providerRole,
      callStatus: providerCall.status,
    }),
    quotaState,
    mediaStatus: verified ? "verified" : "unverified",
    generationMode: verified ? "provider_generated" : "not_evidenced",
    providerCallsCount: 1,
    publication: Object.freeze({ status: "not_requested" }),
  };
  outcome.outcomeId = stableId(outcome);
  return Object.freeze(outcome);
}

function requireAudioDescriptor(descriptor) {
  requirePlainObject(descriptor, "TTS_DESCRIPTOR_INVALID");
  if (descriptor.descriptorType !== "st_media_artifact_descriptor") {
    throw ttsError("TTS_DESCRIPTOR_INVALID");
  }
  if (descriptor.artifactType !== "audio") {
    throw ttsError("TTS_DESCRIPTOR_INVALID");
  }
  if (typeof descriptorFingerprint(descriptor) !== "string") {
    throw ttsError("TTS_DESCRIPTOR_INVALID");
  }
  const verification = descriptor.verification;
  requirePlainObject(verification, "TTS_DESCRIPTOR_INVALID");
  if (verification.state === "VERIFIED") {
    // A verified descriptor must carry a plausible inspection trail; a
    // hand-forged verification block is rejected here. (The descriptor
    // fingerprint excludes the verification block by design, so the outcome
    // re-checks this block explicitly: a real inspection names an allowlisted
    // tool, carries a reason-free state, and has an inspection timestamp.)
    if (typeof verification.inspectedBy !== "string" || !INSPECTION_TOOLS.includes(verification.inspectedBy)) {
      throw ttsError("TTS_DESCRIPTOR_INVALID");
    }
    if (verification.reasonCode !== null) {
      throw ttsError("TTS_DESCRIPTOR_INVALID");
    }
    if (
      typeof verification.inspectedAt !== "string" ||
      Number.isNaN(new Date(verification.inspectedAt).getTime())
    ) {
      throw ttsError("TTS_DESCRIPTOR_INVALID");
    }
  } else if (verification.state !== "UNVERIFIED") {
    throw ttsError("TTS_DESCRIPTOR_INVALID");
  }
  return descriptor;
}

function requireProviderCall(providerCall) {
  requirePlainObject(providerCall, "TTS_PROVIDER_CALL_INVALID");
  const providerId = requireProviderId(providerCall.providerId);
  const providerRole = requireProviderRole(providerCall.providerRole);
  if (typeof providerCall.status !== "string" || !TTS_CALL_STATUSES.includes(providerCall.status)) {
    throw ttsError("TTS_PROVIDER_CALL_INVALID");
  }
  return { providerId, providerRole, status: providerCall.status };
}

/** Recomputes the outcome id over its identity content. */
export function computeTtsOutcomeId(outcome) {
  const {
    outcomeType, agentId, voiceProfileId, descriptorFingerprint: fingerprint,
    descriptorVerificationState, provider, quotaState, mediaStatus,
    generationMode, providerCallsCount, publication,
  } = outcome ?? {};
  return stableId({
    outcomeType, agentId, voiceProfileId, descriptorFingerprint: fingerprint,
    descriptorVerificationState, provider, quotaState, mediaStatus,
    generationMode, providerCallsCount, publication,
  });
}

/** `{ ok: true }` / `{ ok: false, reasonCode }`; never throws on mismatch. */
export function verifyTtsOutcome(outcome) {
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    return { ok: false, reasonCode: "TTS_OUTCOME_MALFORMED" };
  }
  if (outcome.outcomeType !== TTS_OUTCOME_TYPE) {
    return { ok: false, reasonCode: "TTS_OUTCOME_MALFORMED" };
  }
  if (outcome.outcomeId !== computeTtsOutcomeId(outcome)) {
    return { ok: false, reasonCode: "TTS_OUTCOME_TAMPERED" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

/** The frozen free-first provider chain, in contract order. */
export function ttsProviderChain() {
  return TTS_PROVIDER_TIERS.map((tier) => ({ ...tier }));
}

/**
 * Maps a provider call status to the truthful durable quota state. Only
 * `quota_exhausted` produces WAITING_FOR_QUOTA; nothing produces a fake
 * success state.
 */
export function resolveTtsQuotaState(callStatus) {
  if (!TTS_CALL_STATUSES.includes(callStatus)) {
    throw ttsError("TTS_PROVIDER_CALL_INVALID");
  }
  return callStatus === "quota_exhausted" ? "WAITING_FOR_QUOTA" : "OK";
}

// ---------------------------------------------------------------------------
// Strict-allowlist serialization (Rule 17)
// ---------------------------------------------------------------------------

/** Frozen dashboard projection; unknown fields dropped, identity re-verified. */
export function serializeTtsOutcomeForDashboard(outcome) {
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    throw ttsError("TTS_OUTCOME_MALFORMED");
  }
  if (verifyTtsOutcome(outcome).ok === false) {
    throw ttsError("TTS_OUTCOME_TAMPERED");
  }
  requireAgentId(outcome.agentId);
  return Object.freeze({
    outcomeType: outcome.outcomeType,
    outcomeId: outcome.outcomeId,
    agentId: outcome.agentId,
    voiceProfileId: outcome.voiceProfileId,
    descriptorVerificationState: outcome.descriptorVerificationState,
    provider: Object.freeze({
      providerId: outcome.provider.providerId,
      providerRole: outcome.provider.providerRole,
      callStatus: outcome.provider.callStatus,
    }),
    quotaState: outcome.quotaState,
    mediaStatus: outcome.mediaStatus,
    generationMode: outcome.generationMode,
    publicationStatus: outcome.publication.status,
  });
}

/** Frozen profile projection for the owner dashboard (no secrets possible). */
export function serializeVoiceProfileForDashboard(profile) {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw ttsError("TTS_PROFILE_MALFORMED");
  }
  if (verifyVoiceProfile(profile).ok === false) {
    throw ttsError("TTS_PROFILE_TAMPERED");
  }
  requireAgentId(profile.agentId);
  return Object.freeze({
    profileType: profile.profileType,
    voiceProfileId: profile.voiceProfileId,
    agentId: profile.agentId,
    characterId: profile.characterId,
    provider: profile.provider === null
      ? null
      : Object.freeze({
        providerId: profile.provider.providerId,
        providerRole: profile.provider.providerRole,
        modelIdentifier: profile.provider.modelIdentifier,
        voiceId: profile.provider.voiceId,
      }),
    language: profile.language,
    speakingRate: profile.speakingRate,
    pitch: profile.pitch,
    emotion: profile.emotion,
  });
}
