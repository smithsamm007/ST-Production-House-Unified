/**
 * ST Production House — Visual-generation adapter contract
 * (S-M35-01, Module 35 — media pipeline, offline contract layer).
 *
 * Pure, deterministic, offline module. It performs NO image/video generation,
 * NO provider calls, NO filesystem access, and NO clock reads. It exists so
 * the future real visual workers have a truthful contract to implement
 * against, mirroring the proven TTS contract (S-M32-01):
 *
 *   - Provider routing follows the fixed free-first chain: approved free
 *     primary → secondary → tertiary → local open-source emergency. There is
 *     no paid fallback and no account rotation anywhere in this contract.
 *   - A per-Director visual style/continuity profile persists style, framing,
 *     and continuity hints. It is Director-scoped (one registered agent id),
 *     locator-free, and carries no credential material (Rule 17).
 *   - A generation request binds one Director, one style profile, one modality,
 *     and one visual scene-plan reference. Paths cannot be expressed.
 *   - A generation outcome is truthful by construction: a provider call that
 *     merely reports "succeeded" is NOT evidence of generated media. The
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
  descriptorFingerprint,
} from "./artifactDescriptor.js";

export const VISUAL_OUTCOME_TYPE = "visual_generation_outcome_v1";
export const VISUAL_REQUEST_TYPE = "visual_generation_request_v1";
export const VISUAL_CAPABILITIES_TYPE = "visual_provider_capabilities_v1";
export const VISUAL_PROFILE_TYPE = "visual_style_profile_v1";

/** Fixed free-first routing chain. Order is contract; never reordered. */
export const VISUAL_PROVIDER_TIERS = Object.freeze([
  Object.freeze({ tier: 1, role: "approved_free_primary" }),
  Object.freeze({ tier: 2, role: "approved_free_secondary" }),
  Object.freeze({ tier: 3, role: "approved_free_tertiary" }),
  Object.freeze({ tier: 4, role: "local_open_source_emergency" }),
]);

const PROVIDER_ROLES = new Set(VISUAL_PROVIDER_TIERS.map((tier) => tier.role));

export const VISUAL_MODALITIES = Object.freeze([
  "image",
  "video_clip",
  "animation",
  "still_acquisition",
]);

/** Modality → artifact-descriptor artifact type (S-M30-01 vocabulary). */
const MODALITY_ARTIFACT_TYPE = Object.freeze({
  image: "image",
  video_clip: "video",
  animation: "video",
  still_acquisition: "image",
});

export const VISUAL_ASPECT_RATIOS = Object.freeze(["16:9", "9:16", "1:1", "4:5"]);

export const VISUAL_CALL_STATUSES = Object.freeze([
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

function visualError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw visualError(code);
  }
}

function cleanText(value, code, max) {
  if (typeof value !== "string") throw visualError(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > max) throw visualError(code);
  if (SECRET_LIKE.test(normalized)) throw visualError("VISUAL_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw visualError("VISUAL_INTERNAL_NAME_REJECTED");
  return normalized;
}

/** Registered internal Director id (Rule 15: names are internal-only). */
function requireAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw visualError("VISUAL_AGENT_INVALID");
  }
  return agentId;
}

function requireProviderId(providerId) {
  if (typeof providerId !== "string" || !ID_RE.test(providerId)) {
    throw visualError("VISUAL_PROVIDER_INVALID");
  }
  if (SECRET_LIKE.test(providerId)) throw visualError("VISUAL_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(providerId)) throw visualError("VISUAL_INTERNAL_NAME_REJECTED");
  return providerId;
}

function requireProviderRole(providerRole) {
  if (typeof providerRole !== "string" || !PROVIDER_ROLES.has(providerRole)) {
    throw visualError("VISUAL_PROVIDER_ROLE_INVALID");
  }
  return providerRole;
}

function requireModality(modality) {
  if (typeof modality !== "string" || !VISUAL_MODALITIES.includes(modality)) {
    throw visualError("VISUAL_MODALITY_INVALID");
  }
  return modality;
}

function requireAspectRatio(value) {
  if (typeof value !== "string" || !VISUAL_ASPECT_RATIOS.includes(value)) {
    throw visualError("VISUAL_ASPECT_INVALID");
  }
  return value;
}

function requireBoundedNumber(value, code, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw visualError(code);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Provider capability declaration (what an adapter CLAIMS it can do)
// ---------------------------------------------------------------------------

/**
 * Declares an adapter's visual capabilities. A capability declaration is a
 * claim by the adapter author — metadata for routing, never evidence that
 * any generation happened.
 */
export function declareVisualProviderCapabilities(input = {}) {
  requirePlainObject(input, "VISUAL_CAPABILITY_INVALID");
  const adapterId = cleanText(input.adapterId, "VISUAL_ADAPTER_ID_INVALID", 120);
  if (!Array.isArray(input.modalities) || input.modalities.length === 0 || input.modalities.length > VISUAL_MODALITIES.length) {
    throw visualError("VISUAL_MODALITY_INVALID");
  }
  const modalities = Object.freeze([...new Set(input.modalities.map(requireModality))].sort());
  if (!Array.isArray(input.aspectRatios) || input.aspectRatios.length === 0 || input.aspectRatios.length > VISUAL_ASPECT_RATIOS.length) {
    throw visualError("VISUAL_ASPECT_INVALID");
  }
  const aspectRatios = Object.freeze([...new Set(input.aspectRatios.map(requireAspectRatio))].sort());
  let maxClipSeconds = null;
  if (input.maxClipSeconds !== undefined && input.maxClipSeconds !== null) {
    maxClipSeconds = requireBoundedNumber(input.maxClipSeconds, "VISUAL_BOUNDS_INVALID", 1, 600);
  }
  const capabilities = {
    capabilitiesType: VISUAL_CAPABILITIES_TYPE,
    adapterId,
    modalities,
    aspectRatios,
    maxClipSeconds,
    supportsCharacterContinuity: input.supportsCharacterContinuity === true,
  };
  capabilities.capabilitiesId = stableId(capabilities);
  return Object.freeze(capabilities);
}

// ---------------------------------------------------------------------------
// Director-scoped visual style/continuity profile (locator-free)
// ---------------------------------------------------------------------------

/**
 * Creates a persistent visual style/continuity profile. The profile binds one
 * Director to a style summary, framing, and continuity hint set so visuals
 * stay consistent across production runs. No credential material, no
 * locators, and no cross-Director sharing exist here.
 */
export function createVisualStyleProfile(input = {}) {
  requirePlainObject(input, "VISUAL_PROFILE_INVALID");
  const agentId = requireAgentId(input.agentId);
  const styleSummary = cleanText(input.styleSummary, "VISUAL_STYLE_INVALID", 600);
  const framing = input.framing === undefined || input.framing === null
    ? null
    : cleanText(input.framing, "VISUAL_FRAMING_INVALID", 200);
  const aspectRatio = input.aspectRatio === undefined || input.aspectRatio === null
    ? null
    : requireAspectRatio(input.aspectRatio);
  const palette = input.palette === undefined || input.palette === null
    ? null
    : cleanText(input.palette, "VISUAL_PALETTE_INVALID", 200);
  if (!Array.isArray(input.continuityHints) && input.continuityHints !== undefined && input.continuityHints !== null) {
    throw visualError("VISUAL_CONTINUITY_INVALID");
  }
  const continuityHints = input.continuityHints === undefined || input.continuityHints === null
    ? Object.freeze([])
    : Object.freeze(
        input.continuityHints.slice(0, 20).map((hint) => {
          if (input.continuityHints.length > 20) throw visualError("VISUAL_CONTINUITY_INVALID");
          return cleanText(hint, "VISUAL_CONTINUITY_INVALID", 200);
        }),
      );
  const profile = {
    profileType: VISUAL_PROFILE_TYPE,
    agentId,
    styleSummary,
    framing,
    aspectRatio,
    palette,
    continuityHints,
  };
  profile.visualProfileId = stableId(profile);
  return Object.freeze(profile);
}

/** Recomputes the profile id over its identity content (tamper detection). */
export function computeVisualProfileId(profile) {
  const { profileType, agentId, styleSummary, framing, aspectRatio, palette, continuityHints } = profile ?? {};
  return stableId({ profileType, agentId, styleSummary, framing, aspectRatio, palette, continuityHints });
}

/** Returns `{ ok: true }` or `{ ok: false, reasonCode }`; never throws on mismatch. */
export function verifyVisualStyleProfile(profile) {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    return { ok: false, reasonCode: "VISUAL_PROFILE_MALFORMED" };
  }
  if (profile.profileType !== VISUAL_PROFILE_TYPE) {
    return { ok: false, reasonCode: "VISUAL_PROFILE_MALFORMED" };
  }
  if (profile.visualProfileId !== computeVisualProfileId(profile)) {
    return { ok: false, reasonCode: "VISUAL_PROFILE_TAMPERED" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Generation request (Director-scoped, scene-plan-bound, path-free)
// ---------------------------------------------------------------------------

/**
 * Binds one visual generation request to one Director, one style profile, one
 * modality, one provider slot, and one visual scene-plan reference
 * (`<scenePlanId>#<sceneKey>`-shaped, artifact-reference discipline: no
 * paths, no shell characters).
 */
export function createVisualGenerationRequest(input = {}) {
  requirePlainObject(input, "VISUAL_REQUEST_INVALID");
  const profile = input.styleProfile;
  if (verifyVisualStyleProfile(profile).ok === false) {
    throw visualError("VISUAL_PROFILE_INVALID");
  }
  const modality = requireModality(input.modality);
  requirePlainObject(input.provider, "VISUAL_PROVIDER_INVALID");
  const provider = Object.freeze({
    providerId: requireProviderId(input.provider.providerId),
    providerRole: requireProviderRole(input.provider.providerRole),
    modelIdentifier: cleanText(input.provider.modelIdentifier, "VISUAL_MODEL_INVALID", 160),
  });
  const aspectRatio = input.aspectRatio === undefined || input.aspectRatio === null
    ? profile.aspectRatio
    : requireAspectRatio(input.aspectRatio);
  const scenePlanRef = cleanText(input.scenePlanRef, "VISUAL_SCENE_REF_INVALID", 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._#:-]{2,198}$/.test(scenePlanRef)) {
    throw visualError("VISUAL_SCENE_REF_INVALID");
  }
  const isStillModality = modality === "image" || modality === "still_acquisition";
  if (isStillModality && input.clipSeconds !== undefined && input.clipSeconds !== null) {
    throw visualError("VISUAL_CLIP_SECONDS_INVALID");
  }
  const clipSeconds = isStillModality
    ? null
    : requireBoundedNumber(input.clipSeconds, "VISUAL_CLIP_SECONDS_INVALID", 1, 600);
  const request = {
    requestType: VISUAL_REQUEST_TYPE,
    agentId: profile.agentId,
    visualProfileId: profile.visualProfileId,
    modality,
    provider,
    aspectRatio,
    scenePlanRef,
    clipSeconds,
  };
  request.requestId = stableId(request);
  return Object.freeze(request);
}

/** Recomputes the request id over its identity content. */
export function computeVisualRequestId(request) {
  const { requestType, agentId, visualProfileId, modality, provider, aspectRatio, scenePlanRef, clipSeconds } = request ?? {};
  return stableId({ requestType, agentId, visualProfileId, modality, provider, aspectRatio, scenePlanRef, clipSeconds });
}

// ---------------------------------------------------------------------------
// Generation outcome (truthful by construction)
// ---------------------------------------------------------------------------

function requireVisualDescriptor(descriptor, modality) {
  requirePlainObject(descriptor, "VISUAL_DESCRIPTOR_INVALID");
  if (descriptor.descriptorType !== "st_media_artifact_descriptor") {
    throw visualError("VISUAL_DESCRIPTOR_INVALID");
  }
  if (descriptor.artifactType !== MODALITY_ARTIFACT_TYPE[modality]) {
    throw visualError("VISUAL_DESCRIPTOR_INVALID");
  }
  const verification = descriptor.verification;
  requirePlainObject(verification, "VISUAL_DESCRIPTOR_INVALID");
  if (verification.state === "VERIFIED") {
    // A verified descriptor must carry a plausible inspection trail; a
    // hand-forged verification block is rejected here (mirror of the TTS
    // contract's forgery gate).
    if (typeof verification.inspectedBy !== "string" || !["ffprobe", "equivalent"].includes(verification.inspectedBy)) {
      throw visualError("VISUAL_DESCRIPTOR_INVALID");
    }
    if (verification.reasonCode !== null) {
      throw visualError("VISUAL_DESCRIPTOR_INVALID");
    }
    if (
      verification.inspectedAt !== null &&
      (typeof verification.inspectedAt !== "string" || Number.isNaN(new Date(verification.inspectedAt).getTime()))
    ) {
      throw visualError("VISUAL_DESCRIPTOR_INVALID");
    }
  } else if (verification.state !== "UNVERIFIED") {
    throw visualError("VISUAL_DESCRIPTOR_INVALID");
  }
  return descriptor;
}

/**
 * Records one visual generation attempt against a style profile, its request,
 * and the produced media artifact descriptor. The fail-closed core:
 *
 *   - `providerCall.status === "succeeded"` is a CLAIM, not evidence.
 *     `mediaStatus` derives exclusively from the descriptor's verification
 *     state; `generationMode` is "provider_generated" only for a VERIFIED
 *     descriptor (reachable only through the S-M30-01 real-inspection
 *     promotion) and "not_evidenced" otherwise.
 *   - `quota_exhausted` maps to quotaState WAITING_FOR_QUOTA: a durable,
 *     resumable waiting state, never a success.
 *   - The outcome is Director-scoped: the descriptor's producer agent must
 *     match the profile's agent, or the record fails closed.
 */
export function recordVisualGenerationOutcome(input = {}) {
  requirePlainObject(input, "VISUAL_INPUT_INVALID");
  const profile = input.styleProfile;
  if (verifyVisualStyleProfile(profile).ok === false) {
    throw visualError("VISUAL_PROFILE_INVALID");
  }
  const request = input.request;
  requirePlainObject(request, "VISUAL_REQUEST_INVALID");
  if (request.requestType !== VISUAL_REQUEST_TYPE || request.requestId !== computeVisualRequestId(request)) {
    throw visualError("VISUAL_REQUEST_TAMPERED");
  }
  if (request.agentId !== profile.agentId || request.visualProfileId !== profile.visualProfileId) {
    throw visualError("VISUAL_REQUEST_SCOPE_MISMATCH");
  }
  const descriptor = requireVisualDescriptor(input.descriptor, request.modality);
  if (descriptor.producer.agentId !== profile.agentId) {
    throw visualError("VISUAL_AGENT_SCOPE_MISMATCH");
  }
  const providerCall = requireProviderCall(input.providerCall);
  if (
    providerCall.providerId !== request.provider.providerId ||
    providerCall.providerRole !== request.provider.providerRole
  ) {
    throw visualError("VISUAL_PROVIDER_MISMATCH");
  }

  const verified = descriptor.verification.state === "VERIFIED";
  const quotaState = providerCall.status === "quota_exhausted" ? "WAITING_FOR_QUOTA" : "OK";
  const outcome = {
    outcomeType: VISUAL_OUTCOME_TYPE,
    agentId: profile.agentId,
    visualProfileId: profile.visualProfileId,
    requestId: request.requestId,
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

function requireProviderCall(providerCall) {
  requirePlainObject(providerCall, "VISUAL_PROVIDER_CALL_INVALID");
  const providerId = requireProviderId(providerCall.providerId);
  const providerRole = requireProviderRole(providerCall.providerRole);
  if (typeof providerCall.status !== "string" || !VISUAL_CALL_STATUSES.includes(providerCall.status)) {
    throw visualError("VISUAL_PROVIDER_CALL_INVALID");
  }
  return { providerId, providerRole, status: providerCall.status };
}

/** Recomputes the outcome id over its identity content. */
export function computeVisualOutcomeId(outcome) {
  const {
    outcomeType, agentId, visualProfileId, requestId,
    descriptorFingerprint: fingerprint, descriptorVerificationState,
    provider, quotaState, mediaStatus, generationMode, providerCallsCount, publication,
  } = outcome ?? {};
  return stableId({
    outcomeType, agentId, visualProfileId, requestId,
    descriptorFingerprint: fingerprint, descriptorVerificationState,
    provider, quotaState, mediaStatus, generationMode, providerCallsCount, publication,
  });
}

/** Truthful verdict; never repairs or re-stamps a mutated outcome. */
export function verifyVisualOutcome(outcome) {
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    return { ok: false, reasonCode: "VISUAL_OUTCOME_MALFORMED" };
  }
  if (outcome.outcomeType !== VISUAL_OUTCOME_TYPE) {
    return { ok: false, reasonCode: "VISUAL_OUTCOME_MALFORMED" };
  }
  if (outcome.outcomeId !== computeVisualOutcomeId(outcome)) {
    return { ok: false, reasonCode: "VISUAL_OUTCOME_TAMPERED" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Serialization: strict allowlist (Rule 17)
// ---------------------------------------------------------------------------

const OUTCOME_FIELDS = Object.freeze([
  "outcomeType",
  "outcomeId",
  "agentId",
  "visualProfileId",
  "requestId",
  "descriptorFingerprint",
  "descriptorVerificationState",
  "provider",
  "quotaState",
  "mediaStatus",
  "generationMode",
  "providerCallsCount",
  "publication",
]);

/**
 * Emits ONLY the allowlisted outcome fields in fixed order (byte-identical),
 * frozen. Polluted extra keys can never leak; every emitted string is
 * re-scanned so secrets and internal agent names cannot leave the process.
 */
export function serializeVisualOutcome(outcome) {
  const verdict = verifyVisualOutcome(outcome);
  if (!verdict.ok) throw visualError(verdict.reasonCode);
  const output = {};
  for (const field of OUTCOME_FIELDS) {
    output[field] = outcome[field] === undefined ? null : outcome[field];
  }
  const scan = (value) => {
    if (typeof value === "string") {
      if (SECRET_LIKE.test(value)) throw visualError("VISUAL_SECRET_REJECTED");
    } else if (Array.isArray(value)) {
      for (const child of value) scan(child);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) scan(child);
    }
  };
  scan(output);
  return deepFreeze(output);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
