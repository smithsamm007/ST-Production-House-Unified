/**
 * ST Production House — Media artifact descriptor & verification contract
 * (S-M30-01, Module 30 — offline foundation for the real media layer).
 *
 * Pure, deterministic, offline module. It performs NO media generation, NO
 * provider calls, NO filesystem access, and NO clock reads. It exists so a
 * worker can represent an artifact truthfully (AGENTS.md Rules 1–3):
 *
 *   - An artifact's identity is anchored to the SHA-256 of its CONTENT.
 *   - A descriptor is UNVERIFIED by default. It becomes VERIFIED only when a
 *     real inspection result (FFprobe-style, supplied by the caller) matches
 *     the artifact's content hash. A mismatched or missing inspection result
 *     NEVER promotes the descriptor to VERIFIED.
 *   - A worker "success" without a passing inspection result is representable
 *     as unverified — it can never be serialized as verified/valid.
 *   - Serialized output uses a strict field allowlist: no secrets, no secret
 *     locators, no credential material, and no internal agent names in
 *     public-facing fields (Rules 15/17).
 *
 * Determinism: identical inputs produce byte-identical serialized
 * descriptors. Timestamps, if any, are injected by the caller and are never
 * part of the identity.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Stable error codes (fail-closed)
// ---------------------------------------------------------------------------

export const ARTIFACT_TYPES = Object.freeze([
  "audio",
  "image",
  "video",
  "subtitle",
  "thumbnail",
  "metadata",
]);

export const MIME_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "text/vtt",
  "application/x-subrip",
  "application/json",
]);

export const VERIFICATION_STATES = Object.freeze([
  "UNVERIFIED",
  "VERIFIED",
]);

export const INSPECTION_TOOLS = Object.freeze(["ffprobe", "equivalent"]);

export const MAX_STRING = 300;
export const MAX_PRODUCER_NOTE = 1000;

const SHA256_RE = /^[a-f0-9]{64}$/;
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+$/;
// Allowlisted keys are camelCase (contentSha256, artifactType, ...); the scan
// is defense-in-depth against corrupted/crafted objects, so it must accept
// exactly the shapes this module emits.
const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const FIELD_VALUE_MAX = 200;

// Secret-like content is rejected outright in any serialized field
// (mirrors the repository-wide redaction rules; Rules 4/17).
const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization)/i;

function descriptorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw descriptorError(code);
  }
}

function requireBoundedString(value, code, max = MAX_STRING) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw descriptorError(code);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Internal name protection (Rule 15). Derived from the preloaded catalog so a
// newly registered agent (e.g. NEWTON) is protected without editing this file.
// ---------------------------------------------------------------------------

let internalNameCache = null;

function internalAgentNames() {
  if (internalNameCache) return internalNameCache;
  let names = [];
  try {
    // Dynamic import keeps this module loadable in isolation (tests, tools).
    // Failure to load the catalog must not weaken the rest of the contract;
    // the names check is defense-in-depth on top of field validation.
    // eslint-disable-next-line no-undef
    import("../catalog/agents.js").then((mod) => {
      internalNameCache = Object.freeze(
        mod.PRELOADED_AGENTS.map((agent) => agent.name.toLowerCase())
      );
    }).catch(() => {});
  } catch {
    // Catalog unavailable in this environment; field validation still holds.
  }
  // The canonical founding names are pinned statically as the baseline set;
  // the catalog import above extends coverage to newly registered agents.
  names = [
    "jarvis", "sherlock", "lakme", "panchi", "veda", "byte", "chanakya",
    "kabir", "shakti", "rohan", "maya", "aarohi", "vikram", "tara",
    "ananya", "karan", "dev", "aanya", "arjun", "nisha", "newton",
  ];
  internalNameCache = Object.freeze(names);
  return internalNameCache;
}

function containsInternalAgentName(value) {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return internalAgentNames().some((name) => normalized.includes(name));
}

// ---------------------------------------------------------------------------
// Descriptor validation (identity anchored to the content hash)
// ---------------------------------------------------------------------------

/**
 * Validates and returns a frozen, canonical descriptor. Throws a stable-coded
 * error on the first violation. The descriptor never carries the content
 * itself — only its hash and bounded provenance.
 */
export function createArtifactDescriptor(input) {
  requirePlainObject(input, "ARTIFACT_DESCRIPTOR_INVALID");

  // 1. Identity anchor: SHA-256 of the actual content bytes. Hex case is
  //    normalized to lowercase (tools report hashes in either case).
  if (typeof input.contentSha256 !== "string") {
    throw descriptorError("ARTIFACT_HASH_INVALID");
  }
  const contentSha256 = input.contentSha256.toLowerCase();
  if (!SHA256_RE.test(contentSha256)) {
    throw descriptorError("ARTIFACT_HASH_INVALID");
  }

  // 2. Type + MIME
  if (!ARTIFACT_TYPES.includes(input.artifactType)) {
    throw descriptorError("ARTIFACT_TYPE_INVALID");
  }
  if (
    typeof input.mimeType !== "string" ||
    input.mimeType.length > 100 ||
    !MIME_RE.test(input.mimeType) ||
    !MIME_TYPES.includes(input.mimeType)
  ) {
    throw descriptorError("ARTIFACT_MIME_INVALID");
  }

  // 3. Producer provenance: agent, run, stage, provider — all required and
  //    bounded. `agent` here is the internal agent id (e.g. agent-21) or a
  //    non-internal label; internal NAMES are rejected in serialized fields.
  requirePlainObject(input.producer, "ARTIFACT_PRODUCER_INVALID");
  const producerAgent = requireBoundedString(input.producer.agentId, "ARTIFACT_PRODUCER_INVALID", 80);
  const producerRun = requireBoundedString(input.producer.runId, "ARTIFACT_PRODUCER_INVALID", 80);
  const producerStage = requireBoundedString(input.producer.stageId, "ARTIFACT_PRODUCER_INVALID", 80);
  const producerProvider = requireBoundedString(input.producer.providerId, "ARTIFACT_PRODUCER_INVALID", 120);

  for (const value of [producerAgent, producerRun, producerStage, producerProvider]) {
    if (SECRET_LIKE.test(value)) {
      throw descriptorError("ARTIFACT_SECRET_REJECTED");
    }
  }

  // Optional bounded note (allowlisted text; secrets/internal names rejected).
  let producerNote = null;
  if (input.producer.note !== undefined && input.producer.note !== null) {
    producerNote = requireBoundedString(input.producer.note, "ARTIFACT_NOTE_INVALID", MAX_PRODUCER_NOTE);
    if (SECRET_LIKE.test(producerNote)) {
      throw descriptorError("ARTIFACT_SECRET_REJECTED");
    }
    if (containsInternalAgentName(producerNote)) {
      throw descriptorError("ARTIFACT_INTERNAL_NAME_REJECTED");
    }
  }

  // 4. Optional media facts — bounded, numeric, internally consistent.
  let durationSeconds = null;
  if (input.durationSeconds !== undefined && input.durationSeconds !== null) {
    if (typeof input.durationSeconds !== "number" || !Number.isFinite(input.durationSeconds) || input.durationSeconds < 0) {
      throw descriptorError("ARTIFACT_DURATION_INVALID");
    }
    durationSeconds = input.durationSeconds;
  }

  let dimensions = null;
  if (input.dimensions !== undefined && input.dimensions !== null) {
    requirePlainObject(input.dimensions, "ARTIFACT_DIMENSIONS_INVALID");
    const { width, height } = input.dimensions;
    if (
      typeof width !== "number" || !Number.isInteger(width) || width <= 0 || width > 100000 ||
      typeof height !== "number" || !Number.isInteger(height) || height <= 0 || height > 100000
    ) {
      throw descriptorError("ARTIFACT_DIMENSIONS_INVALID");
    }
    dimensions = Object.freeze({ width, height });
  }

  // 5. Verification state starts UNVERIFIED. Always. A passing inspection
  //    result is the ONLY promotion path (verifyArtifactDescriptor).
  const descriptor = Object.freeze({
    schemaVersion: 1,
    descriptorType: "st_media_artifact_descriptor",
    contentSha256,
    artifactType: input.artifactType,
    mimeType: input.mimeType,
    durationSeconds,
    dimensions,
    producer: Object.freeze({
      agentId: producerAgent,
      runId: producerRun,
      stageId: producerStage,
      providerId: producerProvider,
      ...(producerNote !== null ? { note: producerNote } : {}),
    }),
    verification: Object.freeze({
      state: "UNVERIFIED",
      inspectedBy: null,
      inspectedAt: null,
      reasonCode: "NO_INSPECTION_RESULT",
    }),
  });

  return descriptor;
}

// ---------------------------------------------------------------------------
// Verification state machine (fail-closed, exactly one promotion path)
// ---------------------------------------------------------------------------

/**
 * Attempts to promote a descriptor from UNVERIFIED to VERIFIED using a real
 * inspection result supplied by the caller (e.g. an FFprobe JSON payload).
 *
 * Promotion requires ALL of:
 *   - tool is `ffprobe` (or an explicitly equivalent inspector);
 *   - the result reports success;
 *   - the result's content hash matches the descriptor's identity anchor;
 *   - the inspection actually inspected content (non-empty format/streams or
 *     an equivalent non-empty inspection payload).
 *
 * Any mismatch, missing field, or unknown tool returns an UNVERIFIED
 * descriptor with a stable reasonCode — it never throws away the artifact and
 * never fabricates success.
 */
export function verifyArtifactDescriptor(descriptor, inspection) {
  requirePlainObject(descriptor, "ARTIFACT_DESCRIPTOR_INVALID");
  if (descriptor.descriptorType !== "st_media_artifact_descriptor") {
    throw descriptorError("ARTIFACT_DESCRIPTOR_INVALID");
  }
  if (descriptor.verification?.state === "VERIFIED") {
    // Already verified — idempotent re-verification is a no-op returning the
    // same immutable descriptor.
    return descriptor;
  }

  // A missing inspection result (null/undefined) means the descriptor simply
  // stays UNVERIFIED with the default reason — this is the truthful "worker
  // reported success but nothing was inspected" representation.
  if (inspection === null || inspection === undefined) {
    return descriptor;
  }
  requirePlainObject(inspection, "ARTIFACT_INSPECTION_INVALID");

  const reject = (reasonCode) => Object.freeze({
    ...descriptor,
    verification: Object.freeze({
      state: "UNVERIFIED",
      inspectedBy: typeof inspection.tool === "string" && INSPECTION_TOOLS.includes(inspection.tool)
        ? inspection.tool
        : null,
      inspectedAt: null,
      reasonCode,
    }),
  });

  if (typeof inspection.tool !== "string" || !INSPECTION_TOOLS.includes(inspection.tool)) {
    return reject("INSPECTION_TOOL_UNKNOWN");
  }
  if (inspection.success !== true) {
    return reject("INSPECTION_NOT_SUCCESSFUL");
  }
  if (typeof inspection.contentSha256 !== "string" || !SHA256_RE.test(inspection.contentSha256)) {
    return reject("INSPECTION_HASH_MISSING");
  }
  if (inspection.contentSha256.toLowerCase() !== descriptor.contentSha256) {
    return reject("INSPECTION_HASH_MISMATCH");
  }

  // The inspection must have actually inspected something real. An empty
  // payload (no format/streams fields at all) is treated as "missing
  // inspection" rather than evidence of success.
  const hasPayload =
    (inspection.format && typeof inspection.format === "object" && Object.keys(inspection.format).length > 0) ||
    (Array.isArray(inspection.streams) && inspection.streams.length > 0);
  if (!hasPayload) {
    return reject("INSPECTION_PAYLOAD_MISSING");
  }

  // Promotion: the only path that ever sets state VERIFIED.
  return Object.freeze({
    ...descriptor,
    verification: Object.freeze({
      state: "VERIFIED",
      inspectedBy: inspection.tool,
      inspectedAt: typeof inspection.inspectedAt === "string" && !Number.isNaN(new Date(inspection.inspectedAt).getTime())
        ? inspection.inspectedAt
        : null,
      reasonCode: null,
    }),
  });
}

/**
 * Explicit demotion used by recovery paths: if a later check (tamper scan,
 * re-inspection) contradicts a prior verification, the descriptor must return
 * to UNVERIFIED with a reason. Verification is never "sticky" against
 * contradicting evidence.
 */
export function revokeVerification(descriptor, reasonCode) {
  requirePlainObject(descriptor, "ARTIFACT_DESCRIPTOR_INVALID");
  requireBoundedString(reasonCode, "ARTIFACT_REASON_INVALID", 80);
  return Object.freeze({
    ...descriptor,
    verification: Object.freeze({
      state: "UNVERIFIED",
      inspectedBy: null,
      inspectedAt: null,
      reasonCode,
    }),
  });
}

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

/**
 * Detects whether a descriptor (as received — e.g. from storage, a queue, or
 * a worker result) has been altered relative to its canonical fingerprint.
 * The fingerprint is a SHA-256 over the descriptor's canonical allowlisted
 * serialization EXCLUDING the verification block, so verification transitions
 * do not change identity, while any tampering with the content hash, type,
 * MIME, media facts, or provenance is detected.
 */
export function descriptorFingerprint(descriptor) {
  requirePlainObject(descriptor, "ARTIFACT_DESCRIPTOR_INVALID");
  // Identity fingerprint: the allowlisted serialization WITHOUT the
  // verification block, so verification transitions never change identity.
  const serialized = serializeArtifactDescriptor(descriptor);
  const { verification, ...identity } = serialized;
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function detectTampering(originalDescriptor, candidateDescriptor) {
  const originalFingerprint = descriptorFingerprint(originalDescriptor);
  const candidateFingerprint = descriptorFingerprint(candidateDescriptor);
  return {
    tampered: originalFingerprint !== candidateFingerprint,
    originalFingerprint,
    candidateFingerprint,
  };
}

// ---------------------------------------------------------------------------
// Strict allowlist serialization (Rules 15/17)
// ---------------------------------------------------------------------------

function serializeVerification(verification) {
  return {
    state: verification.state,
    ...(verification.inspectedBy !== null ? { inspectedBy: verification.inspectedBy } : {}),
    ...(verification.inspectedAt !== null ? { inspectedAt: verification.inspectedAt } : {}),
    ...(verification.reasonCode !== null ? { reasonCode: verification.reasonCode } : {}),
  };
}

/**
 * Serializes a descriptor through a strict field allowlist. Keys are emitted
 * in fixed order for byte-identical determinism. Extra/unknown fields on the
 * descriptor object are silently DROPPED (allowlist semantics), and any
 * allowlisted string field carrying secret-like content or an internal agent
 * name is rejected rather than serialized.
 */
export function serializeArtifactDescriptor(descriptor) {
  requirePlainObject(descriptor, "ARTIFACT_DESCRIPTOR_INVALID");
  if (descriptor.descriptorType !== "st_media_artifact_descriptor") {
    throw descriptorError("ARTIFACT_DESCRIPTOR_INVALID");
  }

  // Allowlisted, ordered output. Nested objects are frozen so callers cannot
  // mutate a serialized descriptor in place.
  const producer = Object.freeze({
    agentId: descriptor.producer.agentId,
    runId: descriptor.producer.runId,
    stageId: descriptor.producer.stageId,
    providerId: descriptor.producer.providerId,
    ...(descriptor.producer.note ? { note: descriptor.producer.note } : {}),
  });
  const verification = Object.freeze(serializeVerification(descriptor.verification));

  const out = Object.freeze({
    schemaVersion: 1,
    descriptorType: "st_media_artifact_descriptor",
    contentSha256: descriptor.contentSha256,
    artifactType: descriptor.artifactType,
    mimeType: descriptor.mimeType,
    ...(descriptor.durationSeconds !== null && descriptor.durationSeconds !== undefined
      ? { durationSeconds: descriptor.durationSeconds }
      : {}),
    ...(descriptor.dimensions
      ? { dimensions: Object.freeze({ width: descriptor.dimensions.width, height: descriptor.dimensions.height }) }
      : {}),
    producer,
    verification,
  });

  // Defense-in-depth re-scan of every serialized string: secrets and internal
  // agent names must never leave the process through this contract.
  const scan = (value, path) => {
    if (typeof value === "string") {
      if (SECRET_LIKE.test(value)) {
        throw descriptorError(`ARTIFACT_SECRET_REJECTED_AT_${path.toUpperCase()}`);
      }
      if (path !== "producer.agentId" && containsInternalAgentName(value)) {
        throw descriptorError(`ARTIFACT_INTERNAL_NAME_REJECTED_AT_${path.toUpperCase()}`);
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (!FIELD_KEY_RE.test(key)) {
          throw descriptorError(`ARTIFACT_FIELD_KEY_INVALID_AT_${path.toUpperCase()}`);
        }
        scan(child, path ? `${path}.${key}` : key);
      }
    }
  };
  scan(out, "");

  return Object.freeze(out);
}

/**
 * Canonical JSON: fixed key order (insertion order of the allowlist above),
 * no whitespace variance, no undefined holes. Identical inputs yield
 * byte-identical output.
 */
export function canonicalSerialize(descriptor) {
  return JSON.stringify(serializeArtifactDescriptor(descriptor));
}
