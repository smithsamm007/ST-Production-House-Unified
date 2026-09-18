/**
 * ST Production House — Complete media-package manifest contract
 * (S-M37-01, Module 37 — package layer, offline portion).
 *
 * Pure, deterministic, offline module. It performs NO media generation, NO
 * inspection, NO provider calls, NO filesystem access, and NO clock reads. It
 * binds ONE production run's complete output set into a single verifiable
 * manifest:
 *
 *   - The canonical package: exactly 1 main long-form video + the 2
 *     independent content Reels + 1 standalone brand Reel, each bound to a
 *     REAL artifact-descriptor identity (`sha256:<64-hex>`, the S-M30-01
 *     identity anchor) and to a verification outcome derived ONLY from that
 *     descriptor's verification state.
 *   - Every bound descriptor must be produced by the manifest's own Director
 *     AND under the manifest's own production run — cross-Director and
 *     foreign-run bindings fail closed (default cross-Director access DENY).
 *   - The optional main-video brand integration appears only when the bound
 *     Reel package (S-M34-01) itself carries an authorized integration — the
 *     manifest can never invent one; supplying integration material for a
 *     standalone package fails closed.
 *   - Subtitles / thumbnail-plan / metadata entries are optional and must
 *     carry real descriptor identities when present.
 *   - Manifest identity is a recomputed SHA-256 over the allowlisted content
 *     (authorization material excluded); any addition, removal, or
 *     substitution of bound artifacts is detectable tampering.
 *   - The manifest truthfully reports mediaStatus and NEVER claims generation
 *     or publication (publication is always `not_requested`; Rules 15/17).
 */

import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { descriptorFingerprint } from "../media/artifactDescriptor.js";
import { REEL_PACKAGE_TYPE, verifyReelPackagePlanIntegrity } from "./reelPlan.js";

export const MEDIA_PACKAGE_MANIFEST_TYPE = "media_package_manifest_v1";

export const MANIFEST_MEDIA_STATUSES = Object.freeze([
  "no_media",
  "partial_unverified",
  "verified",
]);

const AGENT_IDS = new Set(PRELOADED_AGENTS.map(({ id }) => id));
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,60}$/;
const ARTIFACT_REF_RE = /^sha256:[0-9a-f]{64}$/;

const OPTIONAL_ENTRY_LIMIT = 12;

/** Raw filesystem paths and shell metacharacters are never valid free text. */
const UNSAFE_TEXT = /\.\.\/|\.\\|`|\$\(|&&|;|(^|[\s"'\]])\/[A-Za-z0-9._-]/;

function manifestError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Canonical JSON: object keys are emitted in sorted order so that a record
 * rebuilt with its keys in a different insertion order has the SAME identity
 * (key order is not semantically meaningful); array order and values remain
 * significant. Identity is computed over this form only.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableId(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw manifestError(code);
  }
}

function cleanText(value, code, max) {
  if (typeof value !== "string") throw manifestError(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > max) throw manifestError(code);
  if (SECRET_LIKE.test(normalized)) throw manifestError("MANIFEST_SECRET_REJECTED");
  if (UNSAFE_TEXT.test(normalized)) throw manifestError("MANIFEST_UNSAFE_TEXT_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw manifestError("MANIFEST_INTERNAL_NAME_REJECTED");
  return normalized;
}

function requireAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw manifestError("MANIFEST_AGENT_INVALID");
  }
  return agentId;
}

function requireArtifactRef(value, code) {
  if (typeof value !== "string" || !ARTIFACT_REF_RE.test(value)) {
    throw manifestError(code);
  }
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Binding: descriptor identity + truthful verification derivation
// ---------------------------------------------------------------------------

/**
 * Enforces Director + run scope on a bound artifact: the producer of every
 * bound descriptor must be the manifest's own Director (or a non-internal
 * label the catalog does not recognize — third-party provenance) and must
 * carry the manifest's own production run id. Cross-Director artifacts and
 * foreign-run artifacts fail closed (Rule: default cross-Director access DENY).
 */
function assertArtifactScopedToDirectorAndRun(descriptor, agentId, productionRunId, code) {
  const producer = descriptor.producer;
  if (producer === null || typeof producer !== "object" || Array.isArray(producer)) {
    throw manifestError(code);
  }
  const producerAgent = producer.agentId;
  if (typeof producerAgent !== "string" || producerAgent.length === 0) {
    throw manifestError(code);
  }
  if (producerAgent !== agentId && AGENT_IDS.has(producerAgent)) {
    // A KNOWN other-Director producer — isolation violation, fail closed.
    throw manifestError("MANIFEST_ARTIFACT_CROSS_DIRECTOR");
  }
  if (producer.runId !== productionRunId) {
    // The manifest binds one production run's outputs; a descriptor produced
    // under a different run is a foreign binding.
    throw manifestError("MANIFEST_ARTIFACT_RUN_MISMATCH");
  }
}

/**
 * Builds one bound-artifact entry from a real S-M30-01 descriptor. The
 * entry's verification state is DERIVED — it is never accepted from the
 * caller. A descriptor whose verification state is anything but UNVERIFIED
 * or VERIFIED (i.e. hand-forged state), a VERIFIED descriptor that still
 * carries a reasonCode, a wrong-typed artifact (when `artifactType` is
 * required), or an unknown entry field fails closed.
 */
function bindArtifact(input, code, agentId, productionRunId, options = {}) {
  requirePlainObject(input, code);
  const allowedKeys = options.allowLabel
    ? ["descriptor", "entryNote", "label"]
    : ["descriptor", "entryNote"];
  const fieldCode = `${code.replace(/_BINDING_INVALID$/, "")}_FIELD_UNKNOWN`;
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      throw manifestError(fieldCode);
    }
  }
  const descriptor = input.descriptor;
  requirePlainObject(descriptor, code);
  if (descriptor.descriptorType !== "st_media_artifact_descriptor") {
    throw manifestError(code);
  }
  const verification = descriptor.verification;
  requirePlainObject(verification, code);
  if (verification.state !== "UNVERIFIED" && verification.state !== "VERIFIED") {
    throw manifestError(code);
  }
  if (verification.state === "VERIFIED" && verification.reasonCode !== null) {
    throw manifestError(code);
  }
  // Isolation checks take precedence over shape checks: a foreign-Director or
  // foreign-run binding is always rejected with its isolation code, whatever
  // its artifact type.
  assertArtifactScopedToDirectorAndRun(descriptor, agentId, productionRunId, code);
  if (options.artifactType !== undefined && options.artifactType !== null && descriptor.artifactType !== options.artifactType) {
    throw manifestError("MANIFEST_ARTIFACT_TYPE_MISMATCH");
  }
  return Object.freeze({
    artifactRef: requireArtifactRef(`sha256:${descriptor.contentSha256}`, code),
    descriptorFingerprint: descriptorFingerprint(descriptor),
    verificationState: verification.state,
    entryNote:
      input.entryNote === undefined || input.entryNote === null
        ? null
        : cleanText(input.entryNote, "MANIFEST_NOTE_INVALID", 200),
  });
}

function requireOptionalBindings(value, code, label, agentId, productionRunId, artifactType) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > OPTIONAL_ENTRY_LIMIT) {
    throw manifestError(code);
  }
  return Object.freeze(
    value.map((entry) => {
      const bound = bindArtifact(entry, code, agentId, productionRunId, { allowLabel: true, artifactType });
      return Object.freeze({
        ...bound,
        label: cleanText(entry.label ?? label, "MANIFEST_NOTE_INVALID", 60),
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Manifest construction (canonical 1 + 2 + 1, bound and verified truthfully)
// ---------------------------------------------------------------------------

/**
 * Builds the media-package manifest for one production run.
 *
 * Required inputs:
 *   - `reelPackage`: the run's S-M34-01 reel package plan. The manifest
 *     verifies the package's recomputed integrity, derives content-Reel and
 *     brand-Reel metadata from it, and mirrors its brandIntegrationMode.
 *   - `mainVideo`: one bound artifact (a `video` descriptor).
 *   - `contentReelArtifacts`: exactly 2 bound artifacts (video descriptors).
 *   - `brandReelArtifact`: exactly 1 bound artifact (video descriptor).
 *   - Optional: `subtitles`, `thumbnailPlans`, `metadataEntries` (each bound).
 *   - Optional: `mainVideoIntegrationArtifact` — required ONLY when the reel
 *     package carries an authorized `mainVideoIntegration`; its artifact
 *     reference must match the package's authorization exactly.
 *
 * If `planType`/`id` are supplied they must be truthful (construction
 * recomputes both; a mismatch fails closed instead of being overwritten).
 */
export function createMediaPackageManifest(input = {}) {
  requirePlainObject(input, "MANIFEST_INPUT_INVALID");
  for (const key of Object.keys(input)) {
    if (
      !["planType", "id", "agentId", "productionRunId", "mainVideo", "contentReelArtifacts",
        "brandReelArtifact", "reelPackage", "subtitles", "thumbnailPlans", "metadataEntries",
        "mainVideoIntegrationArtifact"].includes(key)
    ) {
      throw manifestError("MANIFEST_FIELD_UNKNOWN");
    }
  }
  if (input.planType !== undefined && input.planType !== null && input.planType !== MEDIA_PACKAGE_MANIFEST_TYPE) {
    throw manifestError("MANIFEST_TYPE_MISMATCH");
  }
  const agentId = requireAgentId(input.agentId);
  const productionRunId = cleanText(input.productionRunId, "MANIFEST_RUN_INVALID", 80);

  // Reel package integrity + scope (S-M34-01 record, trusted only if intact).
  const reelPackage = input.reelPackage;
  requirePlainObject(reelPackage, "MANIFEST_REEL_PACKAGE_INVALID");
  if (reelPackage.planType !== REEL_PACKAGE_TYPE) {
    throw manifestError("MANIFEST_REEL_PACKAGE_INVALID");
  }
  const packageIntegrity = verifyReelPackagePlanIntegrity(reelPackage);
  if (!packageIntegrity.intact) {
    throw manifestError("MANIFEST_REEL_PACKAGE_TAMPERED");
  }
  if (typeof reelPackage.id !== "string" || reelPackage.id.length !== 64) {
    throw manifestError("MANIFEST_REEL_PACKAGE_INVALID");
  }
  if (reelPackage.agentId !== agentId || reelPackage.productionRunId !== productionRunId) {
    throw manifestError("MANIFEST_REEL_PACKAGE_SCOPE_MISMATCH");
  }

  // Main video: exactly one bound video artifact.
  const mainVideo = bindArtifact(
    input.mainVideo,
    "MANIFEST_MAIN_VIDEO_BINDING_INVALID",
    agentId,
    productionRunId,
    { artifactType: "video" },
  );

  // Content Reels: exactly two bound video artifacts.
  if (!Array.isArray(input.contentReelArtifacts) || input.contentReelArtifacts.length !== 2) {
    throw manifestError("MANIFEST_CONTENT_REEL_COUNT");
  }
  const contentReelArtifacts = [
    bindArtifact(
      input.contentReelArtifacts[0],
      "MANIFEST_CONTENT_REEL_BINDING_INVALID",
      agentId,
      productionRunId,
      { artifactType: "video" },
    ),
    bindArtifact(
      input.contentReelArtifacts[1],
      "MANIFEST_CONTENT_REEL_BINDING_INVALID",
      agentId,
      productionRunId,
      { artifactType: "video" },
    ),
  ];
  if (contentReelArtifacts[0].artifactRef === contentReelArtifacts[1].artifactRef) {
    throw manifestError("MANIFEST_CONTENT_REEL_DUPLICATE");
  }

  // Brand Reel: exactly one bound video artifact, distinct from content reels.
  const brandReelArtifact = bindArtifact(
    input.brandReelArtifact,
    "MANIFEST_BRAND_REEL_BINDING_INVALID",
    agentId,
    productionRunId,
    { artifactType: "video" },
  );
  if (contentReelArtifacts.some((reel) => reel.artifactRef === brandReelArtifact.artifactRef)) {
    throw manifestError("MANIFEST_BRAND_REEL_DUPLICATE");
  }

  // Optional main-video integration: only from the package's own authority.
  let mainVideoIntegration = null;
  if (reelPackage.mainVideoIntegration !== null && reelPackage.mainVideoIntegration !== undefined) {
    if (input.mainVideoIntegrationArtifact === undefined || input.mainVideoIntegrationArtifact === null) {
      throw manifestError("MANIFEST_INTEGRATION_BINDING_REQUIRED");
    }
    const bound = bindArtifact(
      input.mainVideoIntegrationArtifact,
      "MANIFEST_INTEGRATION_BINDING_INVALID",
      agentId,
      productionRunId,
      { artifactType: "video" },
    );
    if (bound.artifactRef !== reelPackage.mainVideoIntegration.artifactRef) {
      throw manifestError("MANIFEST_INTEGRATION_ARTIFACT_MISMATCH");
    }
    if (
      bound.artifactRef === mainVideo.artifactRef ||
      contentReelArtifacts.some((reel) => reel.artifactRef === bound.artifactRef) ||
      bound.artifactRef === brandReelArtifact.artifactRef
    ) {
      // The integrated segment is its own artifact — duplicating any other
      // bound package artifact (including the main video it integrates into)
      // fails closed.
      throw manifestError("MANIFEST_INTEGRATION_ARTIFACT_DUPLICATE");
    }
    mainVideoIntegration = Object.freeze(bound);
  } else if (input.mainVideoIntegrationArtifact !== undefined && input.mainVideoIntegrationArtifact !== null) {
    // Integration material supplied for a standalone/pending package — the
    // manifest can never invent an integration, so this fails closed.
    throw manifestError("MANIFEST_INTEGRATION_CONFLICT");
  }

  // Optional entries are type-bound: a subtitle entry binds subtitle
  // descriptors, a thumbnail entry binds thumbnails, metadata binds metadata.
  // A video (or any other type) can never masquerade as an optional entry.
  const subtitles = requireOptionalBindings(
    input.subtitles, "MANIFEST_SUBTITLE_BINDING_INVALID", "subtitle", agentId, productionRunId, "subtitle",
  );
  const thumbnailPlans = requireOptionalBindings(
    input.thumbnailPlans, "MANIFEST_THUMBNAIL_BINDING_INVALID", "thumbnail", agentId, productionRunId, "thumbnail",
  );
  const metadataEntries = requireOptionalBindings(
    input.metadataEntries, "MANIFEST_METADATA_BINDING_INVALID", "metadata", agentId, productionRunId, "metadata",
  );

  // Truthful media status derived ONLY from bound verification states.
  const boundAll = [
    mainVideo,
    ...contentReelArtifacts,
    brandReelArtifact,
    ...(mainVideoIntegration ? [mainVideoIntegration] : []),
    ...subtitles,
    ...thumbnailPlans,
    ...metadataEntries,
  ];
  const verifiedCount = boundAll.filter((entry) => entry.verificationState === "VERIFIED").length;
  const mediaStatus =
    verifiedCount === 0 ? "no_media" : verifiedCount === boundAll.length ? "verified" : "partial_unverified";

  const manifest = {
    manifestType: MEDIA_PACKAGE_MANIFEST_TYPE,
    id: null,
    agentId,
    productionRunId,
    reelPackageId: reelPackage.id,
    brandIntegrationMode: reelPackage.brandIntegrationMode,
    mainVideo,
    contentReelArtifacts,
    brandReelArtifact,
    mainVideoIntegration,
    subtitles,
    thumbnailPlans,
    metadataEntries,
    mediaStatus,
    publication: Object.freeze({ status: "not_requested" }),
  };
  manifest.id = computeMediaPackageManifestId(manifest);
  if (input.id !== undefined && input.id !== null && input.id !== manifest.id) {
    // A caller-supplied id must be truthful; it is never silently adopted.
    throw manifestError("MANIFEST_ID_MISMATCH");
  }
  return deepFreeze(manifest);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Identity + tamper detection (authorization material excluded from identity)
// ---------------------------------------------------------------------------

/** Recomputed SHA-256 over canonical manifest content (id excluded). */
export function computeMediaPackageManifestId(manifest) {
  requirePlainObject(manifest, "MANIFEST_INPUT_INVALID");
  const { id: _ignored, ...content } = manifest;
  return stableId(content);
}

export function verifyMediaPackageManifest(manifest) {
  requirePlainObject(manifest, "MANIFEST_INPUT_INVALID");
  if (manifest.manifestType !== MEDIA_PACKAGE_MANIFEST_TYPE) {
    return { intact: false, expectedId: null, reason: "MANIFEST_TYPE_MISMATCH" };
  }
  const expectedId = computeMediaPackageManifestId(manifest);
  if (manifest.id !== expectedId) {
    return { intact: false, expectedId, reason: "MANIFEST_ID_MISMATCH" };
  }
  return { intact: true, expectedId, reason: null };
}

const BRAND_MODES = Object.freeze(["STANDALONE_ONLY", "INTEGRATED", "OWNER_DECISION_REQUIRED"]);

/**
 * Production-readiness gate: a manifest is production-ready ONLY when its
 * recomputed identity is intact, every bound artifact (main video, both
 * content Reels, brand Reel, integration, subtitles, thumbnails, metadata)
 * is VERIFIED through its descriptor's real inspection outcome, the reported
 * mediaStatus is consistent with that, the brand mode is a known mode, and
 * publication remains not_requested. A planned or partially verified package
 * is never production-ready; the reason is always reported truthfully.
 */
export function isMediaPackageProductionReady(manifest) {
  requirePlainObject(manifest, "MANIFEST_INPUT_INVALID");
  const integrity = verifyMediaPackageManifest(manifest);
  if (!integrity.intact) return { ready: false, reason: integrity.reason };
  if (!BRAND_MODES.includes(manifest.brandIntegrationMode)) {
    return { ready: false, reason: "BRAND_MODE_INVALID" };
  }
  if (manifest.publication === null || typeof manifest.publication !== "object" || manifest.publication.status !== "not_requested") {
    return { ready: false, reason: "PUBLICATION_STATE_INVALID" };
  }
  const bindings = [
    manifest.mainVideo,
    ...(Array.isArray(manifest.contentReelArtifacts) ? manifest.contentReelArtifacts : []),
    manifest.brandReelArtifact,
    ...(manifest.mainVideoIntegration ? [manifest.mainVideoIntegration] : []),
    ...(Array.isArray(manifest.subtitles) ? manifest.subtitles : []),
    ...(Array.isArray(manifest.thumbnailPlans) ? manifest.thumbnailPlans : []),
    ...(Array.isArray(manifest.metadataEntries) ? manifest.metadataEntries : []),
  ];
  for (const binding of bindings) {
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
      return { ready: false, reason: "MANIFEST_BINDING_MALFORMED" };
    }
    if (binding.verificationState !== "VERIFIED") {
      return { ready: false, reason: "MEDIA_STATUS_NOT_VERIFIED" };
    }
  }
  if (manifest.mediaStatus !== "verified") {
    return { ready: false, reason: "MEDIA_STATUS_NOT_VERIFIED" };
  }
  return { ready: true, reason: null };
}

export function detectMediaPackageManifestTampering(originalManifest, candidateManifest) {
  const a = computeMediaPackageManifestId(originalManifest);
  const b = computeMediaPackageManifestId(candidateManifest);
  return { tampered: a !== b, originalFingerprint: a, candidateFingerprint: b };
}

// ---------------------------------------------------------------------------
// Serialization: strict allowlist (Rule 17)
// ---------------------------------------------------------------------------

const MANIFEST_FIELDS = Object.freeze([
  "manifestType",
  "id",
  "agentId",
  "productionRunId",
  "reelPackageId",
  "brandIntegrationMode",
  "mainVideo",
  "contentReelArtifacts",
  "brandReelArtifact",
  "mainVideoIntegration",
  "subtitles",
  "thumbnailPlans",
  "metadataEntries",
  "mediaStatus",
  "publication",
]);

/**
 * Emits ONLY allowlisted fields in fixed order (byte-identical), frozen.
 * Every bound entry is re-projected through its own explicit allowlist, so a
 * polluted inner field can never leak even if a caller rebuilt the manifest.
 * Polluted extra top-level keys can never leak; deletion/mutation of an
 * allowlisted field fails the recomputed-id gate; secrets, raw paths, shell
 * text, and internal agent names are re-scanned and rejected (Rules 15/17).
 * No authorization material exists on the manifest (S-M34-01 keeps it on the
 * package control plane, not here).
 */
function serializeBinding(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry !== "object" || Array.isArray(entry)) {
    throw manifestError("MANIFEST_BINDING_MALFORMED");
  }
  const projection = {
    artifactRef: entry.artifactRef === undefined ? null : entry.artifactRef,
    descriptorFingerprint: entry.descriptorFingerprint === undefined ? null : entry.descriptorFingerprint,
    verificationState: entry.verificationState === undefined ? null : entry.verificationState,
    entryNote: entry.entryNote === undefined ? null : entry.entryNote,
  };
  if (entry.label !== undefined) projection.label = entry.label;
  return projection;
}

export function serializeMediaPackageManifest(manifest) {
  requirePlainObject(manifest, "MANIFEST_INPUT_INVALID");
  const projection = {};
  for (const field of MANIFEST_FIELDS) {
    if (field === "mainVideo" || field === "brandReelArtifact" || field === "mainVideoIntegration") {
      projection[field] = serializeBinding(manifest[field]);
    } else if (field === "contentReelArtifacts" || field === "subtitles" || field === "thumbnailPlans" || field === "metadataEntries") {
      const list = Array.isArray(manifest[field]) ? manifest[field] : [];
      projection[field] = list.map(serializeBinding);
    } else {
      projection[field] = manifest[field] === undefined ? null : manifest[field];
    }
  }
  const integrity = verifyMediaPackageManifest(projection);
  if (!integrity.intact) throw manifestError(integrity.reason);
  const scan = (value) => {
    if (typeof value === "string") {
      if (SECRET_LIKE.test(value)) throw manifestError("MANIFEST_SECRET_REJECTED");
      if (UNSAFE_TEXT.test(value) && !ARTIFACT_REF_RE.test(value)) throw manifestError("MANIFEST_UNSAFE_TEXT_REJECTED");
      if (!ARTIFACT_REF_RE.test(value) && !ID_RE.test(value) && INTERNAL_AGENT_NAME.test(value)) {
        throw manifestError("MANIFEST_INTERNAL_NAME_REJECTED");
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
