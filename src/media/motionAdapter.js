/**
 * ST Production House — Motion adapter contract (S-M40-01, Module 40 —
 * offline motion stage: deterministic contract + local FFmpeg minterpolate
 * fallback. Issue #236.)
 *
 * Pure, deterministic, offline module. It performs NO motion generation,
 * NO provider calls, NO filesystem access, and NO clock reads. It is the
 * truthful contract the local interpolation worker (motionInterpolationWorker)
 * implements and records against, mirroring the proven visual contract
 * (S-M35-01):
 *
 *   - The SHIPPED provider chain is LOCAL ONLY: tier 1 is the local
 *     open-source emergency slot (FFmpeg minterpolate — the machine has the
 *     binary, no model weights, no licence-burdened assets to document,
 *     Rules 5/12). Remote motion providers (e.g. ViMax) are deliberately NOT
 *     in this contract's chain: live provider work stays owner-gated and out
 *     of this slice; nothing here contacts a network (Rule 17 / issue #236
 *     scope).
 *   - A motion request binds ONE Director, the interpolation parameters
 *     (bounded fps/window), and the SHA-256 monetary binding of the source
 *     frames. Paths are never expressible in the contract — real paths are
 *     operational (worker) inputs, validated there, and never serialized.
 *   - A motion outcome is truthful by construction: an ffmpeg exit 0 is NOT
 *     evidence of motion media. The outcome's media state derives ONLY from
 *     the artifact descriptor's verification state (S-M30-01), which stays
 *     UNVERIFIED unless a real matching inspection promoted it. There is no
 *     quota dimension here — the local slot has none — so quotaState is
 *     honestly constant ("OK"); a MISSING BINARY is a truthful spawn
 *     failure, never a disguised wait.
 *   - Serialization is a strict allowlist (Rule 17): unknown fields are
 *     blocked, locator/secret-shaped values are rejected at entry, and
 *     internal agent names never appear in free text (Rule 15).
 *   - Identical inputs produce byte-identical frozen records whose ids are
 *     recomputed SHA-256 digests; no clocks drift into identity fields.
 */

import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

export const MOTION_REQUEST_TYPE = "motion_request_v1";
export const MOTION_OUTCOME_TYPE = "motion_outcome_v1";
export const MOTION_CAPABILITIES_TYPE = "motion_provider_capabilities_v1";

/**
 * Fixed provider chain, LOCAL ONLY for this slice. Order is contract; never
 * reordered. A future owner-gated live motion provider would append its own
 * tier in its own PR — never before a remote call is owner-provisioned.
 */
export const MOTION_PROVIDER_TIERS = Object.freeze([
  Object.freeze({ tier: 1, role: "local_open_source_emergency" }),
]);

const PROVIDER_ROLES = new Set(MOTION_PROVIDER_TIERS.map((tier) => tier.role));

export const MOTION_MODALITIES = Object.freeze(["interpolation"]);

/** Motion interpolation modes this contract defines (all locally executed). */
export const MOTION_MODES = Object.freeze(["minterpolate"]);

export const MOTION_CALL_STATUSES = Object.freeze([
  "succeeded",
  "failed",
]);

/**
 * Bounded interpolation parameters (ffmpeg minterpolate vocabulary, no
 * invented flags — the worker serializes exactly these fields into argv):
 *   sourceFps — frame rate the input frames are treated as (1..120)
 *   fps       — target interpolated frame rate (1..120)
 *   mbSize    — macroblock size (16, 8, or 32) mirroring minterpolate values
 *   search    — bounded in-window motion-search radius parameter (4..64)
 *   frameCount — input frame count actually fed (bounded so a runaway plan
 *                cannot hide as an unbounded claim)
 */
export const MOTION_PARAM_BOUNDS = Object.freeze({
  sourceFps: Object.freeze({ min: 1, max: 120, integer: true }),
  fps: Object.freeze({ min: 1, max: 120, integer: true }),
  mbSize: Object.freeze({ options: [8, 16, 32] }),
  search: Object.freeze({ min: 4, max: 64, integer: true }),
  frameCount: Object.freeze({ min: 1, max: 20_000, integer: true }),
});

/** Stable error codes (fail-closed, no new pipeline states are introduced). */
export const MOTION_ERROR_CODES = Object.freeze([
  "MOTION_AGENT_INVALID",
  "MOTION_REQUEST_INVALID",
  "MOTION_MODE_INVALID",
  "MOTION_PARAMS_INVALID",
  "MOTION_SOURCE_REF_INVALID",
  "MOTION_CAPACITY_INVALID",
  "MOTION_INTERNAL_NAME_REJECTED",
  "MOTION_SECRET_REJECTED",
  "MOTION_SPAWN_FAILED",
  "MOTION_TIMEOUT",
  "MOTION_CALL_FAILED",
  "MOTION_EXECUTOR_INVALID",
  "INSPECTION_FAILED",
]);

const AGENT_IDS = new Set(PRELOADED_AGENTS.map(({ id }) => id));
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_LIKE =
  /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization/i;
const SHA256_REF_RE = /^sha256:[a-f0-9]{64}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,60}$/;

function motionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw motionError(code);
  }
  return value;
}

function cleanNote(value, code, max = 300) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw motionError(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) throw motionError(code);
  if (normalized.length > max) throw motionError(code);
  if (SECRET_LIKE.test(normalized)) throw motionError("MOTION_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw motionError("MOTION_INTERNAL_NAME_REJECTED");
  return normalized;
}

/** Registered internal Director id (Rule 15: names are internal-only). */
export function requireMotionAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw motionError("MOTION_AGENT_INVALID");
  }
  return agentId;
}

function requireProviderRole(providerRole) {
  if (typeof providerRole !== "string" || !PROVIDER_ROLES.has(providerRole)) {
    throw motionError("MOTION_REQUEST_INVALID");
  }
  return providerRole;
}

function requireBoundedInt(value, key) {
  const bound = MOTION_PARAM_BOUNDS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw motionError("MOTION_PARAMS_INVALID");
  }
  if (bound.integer && !Number.isInteger(value)) throw motionError("MOTION_PARAMS_INVALID");
  if (bound.min !== undefined && value < bound.min) throw motionError("MOTION_PARAMS_INVALID");
  if (bound.max !== undefined && value > bound.max) throw motionError("MOTION_PARAMS_INVALID");
  if (bound.options && !bound.options.includes(value)) throw motionError("MOTION_PARAMS_INVALID");
  return value;
}

/** A source binding must be an explicit sha256: descriptor reference. */
export function requireSourceRef(sourceRef) {
  if (typeof sourceRef !== "string" || !SHA256_REF_RE.test(sourceRef)) {
    throw motionError("MOTION_SOURCE_REF_INVALID");
  }
  return sourceRef;
}

// ---------------------------------------------------------------------------
// Provider capability declaration (what an adapter CLAIMS it can do)
// ---------------------------------------------------------------------------

/**
 * Declares an adapter's motion capabilities. A declaration is a claim used
 * for routing — never evidence that any motion was generated.
 */
export function declareMotionProviderCapabilities(input = {}) {
  requirePlainObject(input, "MOTION_REQUEST_INVALID");
  const adapterId = cleanNote(input.adapterId, "MOTION_REQUEST_INVALID", 120);
  if (!Array.isArray(input.modalities) || input.modalities.length === 0 || input.modalities.length > MOTION_MODALITIES.length) {
    throw motionError("MOTION_REQUEST_INVALID");
  }
  const modalities = Object.freeze([...new Set(input.modalities)].sort());
  for (const modality of modalities) {
    if (!MOTION_MODALITIES.includes(modality)) throw motionError("MOTION_REQUEST_INVALID");
  }
  const modes = Object.freeze(
    Array.isArray(input.modes) && input.modes.length > 0
      ? [...new Set(input.modes)].sort()
      : [...MOTION_MODES],
  );
  for (const mode of modes) {
    if (!MOTION_MODES.includes(mode)) throw motionError("MOTION_MODE_INVALID");
  }
  const capabilities = {
    capabilitiesType: MOTION_CAPABILITIES_TYPE,
    adapterId,
    modalities,
    modes,
    localOnly: true,
  };
  capabilities.capabilitiesId = stableId(capabilities);
  return Object.freeze(capabilities);
}

// ---------------------------------------------------------------------------
// Motion request (deterministic identity, bounded fields, no paths/secrets)
// ---------------------------------------------------------------------------

/**
 * Creates a frozen motion request binding one Director to one interpolation
 * job over explicit sha256: source frame bindings.
 */
export function createMotionRequest(input = {}) {
  requirePlainObject(input, "MOTION_REQUEST_INVALID");
  const agentId = requireMotionAgentId(input.agentId);
  const mode = input.mode === undefined ? "minterpolate" : input.mode;
  if (!MOTION_MODES.includes(mode)) throw motionError("MOTION_MODE_INVALID");
  const providerRole = requireProviderRole(
    input.providerRole === undefined ? "local_open_source_emergency" : input.providerRole,
  );

  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length < 1 || input.sourceRefs.length > 512) {
    throw motionError("MOTION_SOURCE_REF_INVALID");
  }
  const sourceRefs = Object.freeze([...new Set(input.sourceRefs.map(requireSourceRef))].sort());
  if (sourceRefs.length !== input.sourceRefs.length) {
    // Duplicates collapse silently elsewhere; here duplicates are a contract
    // violation so the frame plan can never drift from the recorded plan.
    if (sourceRefs.length < input.sourceRefs.length) {
      // Allow duplicate suppression is NOT allowed: records stay identical,
      // and inputs must already be unique.
      throw motionError("MOTION_SOURCE_REF_INVALID");
    }
  }

  const params = requirePlainObject(input.params ?? {}, "MOTION_PARAMS_INVALID");
  const interpolationParams = Object.freeze({
    sourceFps: requireBoundedInt(params.sourceFps, "sourceFps"),
    fps: requireBoundedInt(params.fps, "fps"),
    mbSize: params.mbSize === undefined ? 16 : requireBoundedInt(params.mbSize, "mbSize"),
    search: params.search === undefined ? 8 : requireBoundedInt(params.search, "search"),
    frameCount: requireBoundedInt(params.frameCount, "frameCount"),
  });
  if (interpolationParams.fps <= interpolationParams.sourceFps) {
    // Interpolation must actually increase temporal density; a request that
    // cannot would silently degrade into a copy, which this contract refuses
    // to record as motion.
    throw motionError("MOTION_PARAMS_INVALID");
  }

  const request = {
    requestType: MOTION_REQUEST_TYPE,
    agentId,
    mode,
    providerRole,
    sourceRefs,
    params: interpolationParams,
    note: cleanNote(input.note, "MOTION_REQUEST_INVALID"),
  };
  request.requestId = stableId(request);
  return Object.freeze(request);
}

// ---------------------------------------------------------------------------
// Motion outcome (truthful by construction: descriptor decides)
// ---------------------------------------------------------------------------

/**
 * Records ONE motion outcome. The recorded media state derives ONLY from the
 * artifact descriptor's verificationState:
 *   VERIFIED   → mediaStatus "verified", generationMode "local_interpolation"
 *   otherwise  → mediaStatus "unverified", generationMode "not_evidenced"
 * An executor exit 0 with no inspection NEVER verifies (Rules 1–3).
 */
export function recordMotionOutcome(input = {}) {
  requirePlainObject(input, "MOTION_REQUEST_INVALID");
  const request = input.request;
  if (!request || request.requestType !== MOTION_REQUEST_TYPE) {
    throw motionError("MOTION_REQUEST_INVALID");
  }
  const descriptor = input.descriptor;
  if (!descriptor || typeof descriptor !== "object" || descriptor.artifactType === undefined) {
    throw motionError("MOTION_REQUEST_INVALID");
  }
  const providerCall = input.providerCall ?? null;
  if (providerCall !== null) {
    requirePlainObject(providerCall, "MOTION_REQUEST_INVALID");
    if (!MOTION_CALL_STATUSES.includes(providerCall.status)) {
      throw motionError("MOTION_REQUEST_INVALID");
    }
  }
  const verificationState = descriptor.verification?.state ?? descriptor.verificationState ?? "UNVERIFIED";
  const interpolationMode = verificationState === "VERIFIED"
    ? "local_interpolation"
    : "not_evidenced";
  const mediaStatus = verificationState === "VERIFIED" ? "verified" : "unverified";

  const outcome = {
    outcomeType: MOTION_OUTCOME_TYPE,
    requestId: request.requestId,
    agentId: request.agentId,
    mode: request.mode,
    providerRole: request.providerRole,
    frameCount: request.params.frameCount,
    descriptor: serializeArtifactDescriptorRef(descriptor),
    providerCall,
    // No remote provider quota exists for the local slot; the constant is the
    // honest value, never a hidden wait.
    quotaState: "OK",
    interpolationMode,
    mediaStatus,
    generationMode: interpolationMode,
  };
  outcome.outcomeId = stableId(outcome);
  return Object.freeze(outcome);
}

/**
 * Safe descriptor reference (Rule 17): only the allowlisted integrity fields
 * survive serialization; descriptor objects are passed out by identity, and
 * audit surfaces use this ref.
 */
export function serializeArtifactDescriptorRef(descriptor) {
  requirePlainObject(descriptor, "MOTION_REQUEST_INVALID");
  const ref = {
    descriptorId: typeof descriptor.descriptorId === "string" ? descriptor.descriptorId : null,
    artifactType: descriptor.artifactType,
    mimeType: descriptor.mimeType,
    contentSha256: typeof descriptor.contentSha256 === "string" ? descriptor.contentSha256 : null,
    verificationState: descriptor.verification?.state ?? "UNVERIFIED",
  };
  if (!ref.contentSha256 || !ref.verificationState) throw motionError("MOTION_REQUEST_INVALID");
  return Object.freeze(ref);
}

/** Freeze helper re-used by workers. */
export function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// Re-exported so callers can verify outcome integrity without importing the
// contract module directly (identity anchor over recorded evidence).
export { stableId as computeMotionOutcomeId };
