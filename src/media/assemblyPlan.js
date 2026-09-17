/**
 * ST Production House — FFmpeg assembly-plan contract (S-M33-01, Module 33 —
 * media pipeline, offline portion).
 *
 * Pure, deterministic, offline module. It performs NO FFmpeg execution, spawns
 * NO processes, touches NO filesystem, and reads NO clocks. It exists so the
 * future real assembly workers have a truthful, sandbox-safe contract:
 *
 *   - Inputs are ARTIFACT REFERENCES only: `sha256:<64-hex>` pointers into the
 *     artifact-descriptor namespace (S-M30-01). Raw paths cannot be expressed,
 *     so path traversal and arbitrary-file access are impossible by
 *     construction; shell metacharacters cannot appear in any accepted value.
 *   - Every parameter is an allowlisted enum or a bounded number. Unknown
 *     fields fail closed (unlike the descriptor's drop-semantics allowlist —
 *     an assembly plan is an execution instruction, so surprises must throw).
 *   - The main-video runtime QC gate (1800–3000 s) fails closed: a main video
 *     is "complete" only when the artifact descriptor is VERIFIED via a real
 *     matching inspection result AND the measured duration from that
 *     inspection payload lies inside the window. A caller's claimed duration
 *     is never evidence.
 *   - Serialization is a strict allowlist (Rule 17); secrets and internal
 *     agent names are rejected everywhere (Rules 15/17). Plans are
 *     deterministic with recomputed SHA-256 ids and tamper detection.
 */

import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { verifyArtifactDescriptor } from "./artifactDescriptor.js";

export const ASSEMBLY_PLAN_TYPE = "media_assembly_plan_v1";

/** Canonical main-video runtime window (30–50 minutes, ACTUAL media time). */
export const MAIN_VIDEO_MIN_SECONDS = 1800;
export const MAIN_VIDEO_MAX_SECONDS = 3000;

export const SEGMENT_KINDS = Object.freeze([
  "video_clip",
  "still_image",
  "title_card",
  "voice",
  "bgm",
  "sfx",
]);

export const TRANSITIONS = Object.freeze(["cut", "fade", "dissolve", "wipe"]);

export const ASPECT_RATIOS = Object.freeze(["16:9", "9:16", "1:1", "4:5"]);

export const OUTPUT_TARGETS = Object.freeze([
  "main_longform",
  "content_reel_1",
  "content_reel_2",
  "brand_reel",
]);

export const SUBTITLE_FORMATS = Object.freeze(["srt", "vtt"]);

export const AUDIO_ROLES = Object.freeze(["voice", "bgm", "sfx"]);

const AGENT_IDS = new Set(PRELOADED_AGENTS.map(({ id }) => id));
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,60}$/;
/** Artifact references are descriptor-namespace pointers, never paths. */
const ARTIFACT_REF_RE = /^sha256:[0-9a-f]{64}$/;
const ENUM_KIND_RE = /^[a-z0-9_]+$/;

const MAX_SEGMENTS = 200;
const MAX_AUDIO_TRACKS = 40;
const MAX_NOTE = 300;

/** Top-level fields an assembly plan accepts. Anything else → fail closed. */
const INPUT_FIELDS = Object.freeze([
  "agentId",
  "productionRunId",
  "outputTarget",
  "aspectRatio",
  "segments",
  "audioMix",
  "subtitleTrack",
  "note",
]);

/** Strict serialization allowlist (Rule 17). Order is contract. */
const PLAN_FIELDS = Object.freeze([
  "planType",
  "id",
  "agentId",
  "productionRunId",
  "outputTarget",
  "aspectRatio",
  "segments",
  "audioMix",
  "subtitleTrack",
  "note",
]);

function planError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw planError(code);
  }
}

function requireEnum(value, allowed, code) {
  if (typeof value !== "string" || !allowed.includes(value)) throw planError(code);
  return value;
}

function requireBoundedNumber(value, code, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw planError(code);
  }
  return value;
}

function requireAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw planError("ASSEMBLY_AGENT_INVALID");
  }
  return agentId;
}

function requireRunId(productionRunId) {
  if (typeof productionRunId !== "string" || !ID_RE.test(productionRunId)) {
    throw planError("ASSEMBLY_RUN_INVALID");
  }
  if (SECRET_LIKE.test(productionRunId)) throw planError("ASSEMBLY_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(productionRunId)) throw planError("ASSEMBLY_INTERNAL_NAME_REJECTED");
  return productionRunId;
}

/**
 * The only accepted reference shape: `sha256:<64-hex>`. This single shape
 * makes traversal (`../`), absolute paths, file:// URLs, shell metacharacters
 * and whitespace structurally impossible — they fail the regex, fail closed.
 */
function requireArtifactRef(value, code) {
  if (typeof value !== "string" || !ARTIFACT_REF_RE.test(value)) {
    throw planError(code);
  }
  return value.toLowerCase();
}

function requireSegments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SEGMENTS) {
    throw planError("ASSEMBLY_SEGMENT_LIMIT");
  }
  return Object.freeze(
    value.map((segment) => {
      requirePlainObject(segment, "ASSEMBLY_SEGMENT_INVALID");
      const allowed = ["artifactRef", "kind", "durationSeconds", "transitionIn"];
      for (const key of Object.keys(segment)) {
        if (!allowed.includes(key)) throw planError("ASSEMBLY_SEGMENT_FIELD_UNKNOWN");
      }
      const out = {
        artifactRef: requireArtifactRef(segment.artifactRef, "ASSEMBLY_ARTIFACT_REF_INVALID"),
        kind: requireEnum(segment.kind, SEGMENT_KINDS, "ASSEMBLY_SEGMENT_KIND_INVALID"),
      };
      if (segment.durationSeconds !== undefined && segment.durationSeconds !== null) {
        out.durationSeconds = requireBoundedNumber(
          segment.durationSeconds,
          "ASSEMBLY_SEGMENT_DURATION_INVALID",
          0.1,
          7200,
        );
      }
      out.transitionIn = requireEnum(
        segment.transitionIn === undefined || segment.transitionIn === null ? "cut" : segment.transitionIn,
        TRANSITIONS,
        "ASSEMBLY_TRANSITION_INVALID",
      );
      return Object.freeze(out);
    }),
  );
}

function requireAudioMix(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_AUDIO_TRACKS) {
    throw planError("ASSEMBLY_AUDIO_LIMIT");
  }
  return Object.freeze(
    value.map((track) => {
      requirePlainObject(track, "ASSEMBLY_AUDIO_INVALID");
      const allowed = ["artifactRef", "role", "gainDb", "ducking"];
      for (const key of Object.keys(track)) {
        if (!allowed.includes(key)) throw planError("ASSEMBLY_AUDIO_FIELD_UNKNOWN");
      }
      const out = {
        artifactRef: requireArtifactRef(track.artifactRef, "ASSEMBLY_ARTIFACT_REF_INVALID"),
        role: requireEnum(track.role, AUDIO_ROLES, "ASSEMBLY_AUDIO_ROLE_INVALID"),
        gainDb: requireBoundedNumber(
          track.gainDb === undefined || track.gainDb === null ? 0 : track.gainDb,
          "ASSEMBLY_AUDIO_GAIN_INVALID",
          -60,
          6,
        ),
        ducking: track.ducking === true,
      };
      return Object.freeze(out);
    }),
  );
}

function requireSubtitleTrack(value) {
  if (value === undefined || value === null) return null;
  requirePlainObject(value, "ASSEMBLY_SUBTITLE_INVALID");
  const allowed = ["artifactRef", "format"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw planError("ASSEMBLY_SUBTITLE_FIELD_UNKNOWN");
  }
  return Object.freeze({
    artifactRef: requireArtifactRef(value.artifactRef, "ASSEMBLY_ARTIFACT_REF_INVALID"),
    format: requireEnum(value.format, SUBTITLE_FORMATS, "ASSEMBLY_SUBTITLE_FORMAT_INVALID"),
  });
}

function optionalNote(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw planError("ASSEMBLY_NOTE_INVALID");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > MAX_NOTE) throw planError("ASSEMBLY_NOTE_INVALID");
  if (SECRET_LIKE.test(normalized)) throw planError("ASSEMBLY_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw planError("ASSEMBLY_INTERNAL_NAME_REJECTED");
  return normalized;
}

function buildPlan(input) {
  requirePlainObject(input, "ASSEMBLY_PLAN_INVALID");
  // Unknown top-level fields fail closed: a plan is an execution instruction,
  // so surprises must throw (unlike the descriptor's drop-semantics allowlist).
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.includes(key)) {
      throw planError("ASSEMBLY_FIELD_UNKNOWN");
    }
  }
  const plan = {
    planType: ASSEMBLY_PLAN_TYPE,
    id: null,
    agentId: requireAgentId(input.agentId),
    productionRunId: requireRunId(input.productionRunId),
    outputTarget: requireEnum(input.outputTarget, OUTPUT_TARGETS, "ASSEMBLY_OUTPUT_TARGET_INVALID"),
    aspectRatio: requireEnum(input.aspectRatio, ASPECT_RATIOS, "ASSEMBLY_ASPECT_INVALID"),
    segments: requireSegments(input.segments),
    audioMix: requireAudioMix(input.audioMix),
    subtitleTrack: requireSubtitleTrack(input.subtitleTrack),
    note: optionalNote(input.note),
  };
  plan.id = computeAssemblyPlanId(plan);
  return deepFreeze(plan);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Identity + tamper detection
// ---------------------------------------------------------------------------

/** Creates an immutable, deterministic assembly plan for one Director run. */
export function createAssemblyPlan(input) {
  return buildPlan(input);
}

/** Recomputed SHA-256 over canonical plan content (id field excluded). */
export function computeAssemblyPlanId(plan) {
  requirePlainObject(plan, "ASSEMBLY_PLAN_INVALID");
  const { id: _ignored, ...content } = plan;
  return stableId(content);
}

/**
 * Integrity gate: recompute and compare. Truthful verdict — never repairs.
 */
export function verifyAssemblyPlanIntegrity(plan) {
  requirePlainObject(plan, "ASSEMBLY_PLAN_INVALID");
  if (plan.planType !== ASSEMBLY_PLAN_TYPE) {
    return { intact: false, expectedId: null, reason: "ASSEMBLY_PLAN_TYPE_MISMATCH" };
  }
  const expectedId = computeAssemblyPlanId(plan);
  if (plan.id !== expectedId) {
    return { intact: false, expectedId, reason: "ASSEMBLY_ID_MISMATCH" };
  }
  return { intact: true, expectedId, reason: null };
}

/** Fingerprint over plan content excluding the id (identity anchor). */
export function assemblyPlanFingerprint(plan) {
  requirePlainObject(plan, "ASSEMBLY_PLAN_INVALID");
  const { id: _ignored, ...content } = plan;
  return stableId(content);
}

export function detectAssemblyPlanTampering(originalPlan, candidatePlan) {
  const a = assemblyPlanFingerprint(originalPlan);
  const b = assemblyPlanFingerprint(candidatePlan);
  return { tampered: a !== b, originalFingerprint: a, candidateFingerprint: b };
}

// ---------------------------------------------------------------------------
// Main-video runtime QC gate (fail-closed, binds to artifactDescriptor)
// ---------------------------------------------------------------------------

/**
 * Evaluates whether a main-video artifact may be represented as COMPLETE.
 *
 * Fail-closed requirements, in order:
 *   1. The artifact descriptor must be promoted to VERIFIED by the S-M30-01
 *      state machine — i.e. a real matching inspection result (ffprobe or
 *      explicitly equivalent) inspected content whose hash matches. The
 *      promotion's stable reasonCode is surfaced verbatim on failure.
 *   2. The measured duration must be present in the inspection payload
 *      (`format.duration`, as real inspectors report it). A claimed duration
 *      stored on the descriptor is NEVER sufficient evidence.
 *   3. The measured duration must lie inside [1800, 3000] seconds.
 *   4. If the descriptor also carries a claimed durationSeconds that
 *      contradicts the measured duration by more than 1 second, the gate
 *      fails closed with QC_DURATION_CONFLICT rather than trusting either.
 *
 * This function never mutates inputs and never fabricates a pass.
 */
export function evaluateMainVideoRuntimeGate(descriptor, inspection) {
  const promoted = verifyArtifactDescriptor(descriptor, inspection);
  if (promoted.verification.state !== "VERIFIED") {
    return {
      passed: false,
      reasonCode: "QC_DESCRIPTOR_NOT_VERIFIED",
      inspectionReasonCode: promoted.verification.reasonCode,
      measuredDurationSeconds: null,
    };
  }
  const rawDuration = inspection.format ? inspection.format.duration : undefined;
  const measured =
    typeof rawDuration === "number"
      ? rawDuration
      : typeof rawDuration === "string" && rawDuration.trim() !== "" && Number.isFinite(Number(rawDuration))
        ? Number(rawDuration)
        : null;
  if (measured === null || measured <= 0) {
    return { passed: false, reasonCode: "QC_INSPECTION_DURATION_MISSING", inspectionReasonCode: null, measuredDurationSeconds: null };
  }
  if (
    descriptor.durationSeconds !== null &&
    descriptor.durationSeconds !== undefined &&
    Math.abs(descriptor.durationSeconds - measured) > 1
  ) {
    return {
      passed: false,
      reasonCode: "QC_DURATION_CONFLICT",
      inspectionReasonCode: null,
      measuredDurationSeconds: measured,
    };
  }
  if (measured < MAIN_VIDEO_MIN_SECONDS || measured > MAIN_VIDEO_MAX_SECONDS) {
    return {
      passed: false,
      reasonCode: "QC_DURATION_OUT_OF_RANGE",
      inspectionReasonCode: null,
      measuredDurationSeconds: measured,
    };
  }
  return { passed: true, reasonCode: null, inspectionReasonCode: null, measuredDurationSeconds: measured };
}

// ---------------------------------------------------------------------------
// Serialization: strict allowlist (Rule 17)
// ---------------------------------------------------------------------------

/**
 * Emits ONLY allowlisted plan fields in fixed order (byte-identical), frozen.
 * Unlike plan construction (which throws on unknown fields), serialization
 * drops unknown keys — but every emitted string is re-scanned so secrets and
 * internal agent names can never leave the process through this contract.
 */
export function serializeAssemblyPlan(plan) {
  requirePlainObject(plan, "ASSEMBLY_PLAN_INVALID");
  // Project onto the allowlist FIRST, then verify integrity of the projection.
  // Polluted extra keys are dropped (they can never leak), while tampering
  // with any allowlisted field still fails the recomputed-id check.
  const projection = {};
  for (const field of PLAN_FIELDS) {
    projection[field] = plan[field] === undefined ? null : plan[field];
  }
  const integrity = verifyAssemblyPlanIntegrity(projection);
  if (!integrity.intact) throw planError(integrity.reason);
  const scan = (value) => {
    if (typeof value === "string") {
      if (SECRET_LIKE.test(value)) throw planError("ASSEMBLY_SECRET_REJECTED");
      if (ENUM_KIND_RE.test(value) === false && ARTIFACT_REF_RE.test(value) === false) {
        // Free-form strings (ids, notes) get the name rule; enums/refs passed
        // validation already.
        if (INTERNAL_AGENT_NAME.test(value)) throw planError("ASSEMBLY_INTERNAL_NAME_REJECTED");
      }
    } else if (Array.isArray(value)) {
      for (const child of value) scan(child);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) scan(child);
    }
  };
  scan(projection);
  return deepFreeze(projection);
}

export function canonicalSerializeAssemblyPlan(plan) {
  return JSON.stringify(serializeAssemblyPlan(plan));
}
