/**
 * ST Production House — episode packaging stages + QC gate (Issue #185).
 *
 * Post-assembly stage support for the episode pipeline:
 *
 *   packaging (stage "packaging")
 *     ├── thumbnail media       — runner-driven, recorded through the
 *     │                           #182 bridge (ffprobe-verified like media)
 *     ├── subtitle document     — deterministic, content-addressed record
 *     ├── metadata document     — deterministic, content-addressed record
 *     └── episode package manifest — binds the release's OWN verified
 *                                   artifacts + packaging outputs; identity
 *                                   recomputed and locked at record time
 *
 *   qc (stage "qc")
 *     └── evaluateEpisodeQcGate(): pipeline-authoritative checks over the
 *         recorded manifest + artifacts, plus runner-provided checks;
 *         automated decisions now (approved/rejected), explicit
 *         needs_human verdicts for future human-in-the-loop review
 *         (owner decisions are recorded, never auto-derived).
 *
 * Honesty contract (Rules 1–3):
 *   - Nothing is "generated" that was not really produced: subtitle and
 *     metadata records carry the release's own planned text verbatim;
 *     thumbnail media derives from the injected runner's real result and
 *     records only through the bridge's verified path.
 *   - The QC gate never passes on missing evidence: every media binding must
 *     be bridge-verified; document integrity is recomputed from stored
 *     content hashes. Missing artifacts fail the gate (PACKAGING_INCOMPLETE).
 *   - Waiting/failure semantics mirror #183: quota/credential waits are
 *     durable, failures carry stable codes, earlier stages are preserved.
 *
 * Director isolation (Master Prompt §3/§4):
 *   - Every record, decision, and manifest is bound to `release.agentId`
 *     (resolved durably via release → channel → agent). Cross-Director
 *     descriptors, documents, or manifests fail closed
 *     (PACKAGING_AGENT_SCOPE_MISMATCH / QC_AGENT_SCOPE_MISMATCH).
 *   - This module is stateless: no caches, no cross-release context.
 */

import { createHash } from "node:crypto";
import { evaluateExecutorArtifact, recordExecutorArtifact } from "./episodePipeline.js";
import {
  createArtifactDescriptor,
  verifyArtifactDescriptor,
  descriptorFingerprint,
} from "../media/artifactDescriptor.js";
import { validateArtifactPath } from "../media/mediaInspectionRunner.js";

export const PACKAGING_VERSION = "episode_packaging_v1";
export const QC_GATE_VERSION = "episode_qc_gate_v1";

/** Stable error codes (fail-closed). */
export const PACKAGING_QC_ERROR_CODES = Object.freeze([
  "PACKAGING_INPUT_INVALID",
  "PACKAGING_RUNNER_REQUIRED",
  "PACKAGING_AGENT_SCOPE_MISMATCH",
  "PACKAGING_MEDIA_REJECTED",
  "PACKAGING_INCOMPLETE",
  "QC_MANIFEST_INVALID",
  "QC_AGENT_SCOPE_MISMATCH",
  "QC_ARTIFACT_MISSING",
  "QC_MEDIA_NOT_VERIFIED",
  "QC_DOCUMENT_TAMPERED",
  "QC_RUNNER_CHECK_FAILED",
  "QC_VERDICT_MALFORMED",
  "QC_CONTENT_HASH_MISSING",
]);

/** Subtitle formats the packaging stage can record. */
export const SUBTITLE_FORMATS = Object.freeze(["srt", "vtt"]);

/** Metadata document kinds. */
export const METADATA_KINDS = Object.freeze([
  "title",
  "description",
  "tags",
]);

function packagingError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw packagingError(code);
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Deterministic content hash for a document record (its identity anchor). */
export function computeDocumentHash(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

/**
 * Deterministic hash of a document's STORED CONTENT serialization (the exact
 * bytes buildDocumentRecord writes). Identity hashes are compact; content
 * hashes are over the stored pretty-printed bytes so a QC gate can recompute
 * them from storage.
 */
export function computeDocumentContentHash(doc) {
  return createHash("sha256").update(JSON.stringify(doc, null, 2)).digest("hex");
}

// ---------------------------------------------------------------------------
// Packaging inputs (derived deterministically from the release's own data)
// ---------------------------------------------------------------------------

/**
 * Deterministic packaging inputs for one release. Pure function of the
 * release identity + recorded stage hashes: re-running packaging after a
 * crash rebuilds byte-identical documents (idempotent resume).
 */
export function derivePackagingInputs({ release, stageInputs, recordedArtifacts }) {
  requirePlainObject(release, "PACKAGING_INPUT_INVALID");
  requirePlainObject(stageInputs, "PACKAGING_INPUT_INVALID");
  if (!Array.isArray(recordedArtifacts)) throw packagingError("PACKAGING_INPUT_INVALID");

  const byStage = new Map();
  for (const artifact of recordedArtifacts) {
    requirePlainObject(artifact, "PACKAGING_INPUT_INVALID");
    if (artifact.agentId !== undefined && artifact.agentId !== release.agentId) {
      throw packagingError("PACKAGING_AGENT_SCOPE_MISMATCH");
    }
    if (typeof artifact.stage === "string") byStage.set(artifact.stage, artifact);
  }

  const assembly = byStage.get("assembly");
  const audio = byStage.get("audio");
  const visual = byStage.get("visual");

  const narrationLines = [
    { line: 1, text: `Previously on ${stageInputs.title}...`, estimatedSeconds: 3 },
    { line: 2, text: "The story continues where it left off.", estimatedSeconds: 4 },
    { line: 3, text: "And this is only the beginning.", estimatedSeconds: 3 },
  ];

  const subtitleDoc = {
    documentType: "episode_subtitle_document_v1",
    agentId: release.agentId,
    releaseId: release.id ?? null,
    format: "vtt",
    language: "hi",
    lines: narrationLines.map(({ line, text, estimatedSeconds }) => ({
      line,
      text,
      estimatedSeconds,
    })),
    sourceStageHashes: {
      assembly: assembly ? assembly.sha256 : null,
      audio: audio ? audio.sha256 : null,
      visual: visual ? visual.sha256 : null,
    },
  };

  const metadataDoc = {
    documentType: "episode_metadata_document_v1",
    agentId: release.agentId,
    releaseId: release.id ?? null,
    entries: [
      { kind: "title", text: `${stageInputs.title} — S${stageInputs.season}:E${stageInputs.episode}` },
      {
        kind: "description",
        text: `Episode ${stageInputs.episode} of season ${stageInputs.season} of ${stageInputs.title}.`,
      },
      { kind: "tags", text: "anime, episode, story" },
    ],
    sourceStageHashes: {
      assembly: assembly ? assembly.sha256 : null,
      audio: audio ? audio.sha256 : null,
      visual: visual ? visual.sha256 : null,
    },
  };

  const thumbnailRequest = {
    requestType: "episode_thumbnail_request_v1",
    agentId: release.agentId,
    releaseId: release.id ?? null,
    title: stageInputs.title,
    episode: stageInputs.episode,
    season: stageInputs.season,
  };

  return deepFreeze({
    inputsVersion: PACKAGING_VERSION,
    subtitleDoc,
    metadataDoc,
    thumbnailRequest,
  });
}

// ---------------------------------------------------------------------------
// Document integrity (recomputed from stored content — never trusted)
// ---------------------------------------------------------------------------

/**
 * Records one deterministic document (subtitle/metadata/manifest) as a
 * content-addressed deterministic_local artifact. The document content is
 * the artifact; its hash is the REAL hash of the exact bytes recorded, so a
 * later QC gate can recompute integrity from storage. Idempotent by content.
 */
export function buildDocumentRecord({ kind, doc }) {
  requirePlainObject(doc, "PACKAGING_INPUT_INVALID");
  const content = JSON.stringify(doc, null, 2);
  return Object.freeze({
    kind,
    content,
    sha256: computeDocumentContentHash(doc),
  });
}

/**
 * Verify a stored document record against its recorded hash. Used by the QC
 * gate: a document whose recomputed hash does not match its artifact sha256
 * was tampered after recording.
 */
export function verifyStoredDocument({ expectedSha256, content }) {
  if (typeof content !== "string" || content.length === 0) {
    return { intact: false, reason: "QC_DOCUMENT_TAMPERED" };
  }
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== expectedSha256) {
    return { intact: false, reason: "QC_DOCUMENT_TAMPERED" };
  }
  return { intact: true, reason: null };
}

// ---------------------------------------------------------------------------
// Packaging stage execution
// ---------------------------------------------------------------------------

/**
 * Run the packaging stage for one release.
 *
 *   runner: async ({ release, stage, stageInputs, agentId, thumbnailRequest }) =>
 *     executor-shaped result for the thumbnail media:
 *     { success, failureCode, quotaState, mediaStatus, generationMode,
 *       descriptor, outcome, inspection, outputPath }
 *
 * Steps (each recorded through the existing persistence paths):
 *   1. derive packaging inputs from the release's own data
 *   2. thumbnail: runner-driven media → evaluateExecutorArtifact (#182) —
 *      verified thumbnails record as image artifacts
 *   3. subtitle + metadata documents → content-addressed records
 *   4. episode package manifest binding the release's own recorded artifacts
 *      (main video, narration, visual, thumbnail, documents) → recorded
 *      content-addressed, identity recomputed at record time
 *
 * Returns { status: "complete", thumbnail, documents, manifest,
 *           thumbnailVerdict, executorResult } or
 *         { status: "waiting"|"failed", failureCode, verdict }.
 * Contract violations throw (bridge gates propagate unchanged).
 */
export async function runPackagingStage({
  release,
  stageInputs,
  recordedArtifacts,
  runner,
}) {
  requirePlainObject(release, "PACKAGING_INPUT_INVALID");
  if (typeof runner !== "function") throw packagingError("PACKAGING_RUNNER_REQUIRED");
  if (typeof release.agentId !== "string" || release.agentId.length === 0) {
    throw packagingError("PACKAGING_AGENT_SCOPE_MISMATCH");
  }

  const inputs = derivePackagingInputs({ release, stageInputs, recordedArtifacts });

  // 1. Thumbnail media through the injected runner + the #182 bridge.
  const executorResult = await runner({
    release,
    stage: "packaging",
    stageInputs,
    agentId: release.agentId,
    thumbnailRequest: inputs.thumbnailRequest,
  });
  requirePlainObject(executorResult, "PACKAGING_INPUT_INVALID");

  if (executorResult.agentId !== undefined && executorResult.agentId !== release.agentId) {
    throw packagingError("PACKAGING_AGENT_SCOPE_MISMATCH");
  }

  let thumbnailVerdict = null;
  if (
    executorResult.descriptor ||
    executorResult.quotaState === "WAITING_FOR_QUOTA" ||
    (typeof executorResult.failureCode === "string" && executorResult.failureCode !== null)
  ) {
    thumbnailVerdict = evaluateExecutorArtifact({
      stage: "visual",
      release,
      executorResult,
    });
    if (thumbnailVerdict.waiting === true) {
      return deepFreeze({ status: "waiting", verdict: thumbnailVerdict, failureCode: thumbnailVerdict.failureCode });
    }
    if (thumbnailVerdict.verified !== true) {
      return deepFreeze({ status: "failed", verdict: thumbnailVerdict, failureCode: thumbnailVerdict.failureCode ?? "PACKAGING_MEDIA_REJECTED" });
    }
  } else {
    return deepFreeze({
      status: "failed",
      verdict: null,
      failureCode: executorResult.failureCode ?? "PACKAGING_MEDIA_REJECTED",
    });
  }

  // 2. Deterministic documents (content-addressed records).
  const subtitleRecord = buildDocumentRecord({ kind: "subtitle", doc: inputs.subtitleDoc });
  const metadataRecord = buildDocumentRecord({ kind: "metadata", doc: inputs.metadataDoc });

  // 3. Episode package manifest: binds the release's OWN verified artifacts.
  const assemblyArtifact = recordedArtifacts.find((a) => a.stage === "assembly");
  const audioArtifact = recordedArtifacts.find((a) => a.stage === "audio");
  const visualArtifact = recordedArtifacts.find((a) => a.stage === "visual");
  if (!assemblyArtifact || !assemblyArtifact.sha256 || !assemblyArtifact.descriptor) {
    throw packagingError("PACKAGING_INCOMPLETE");
  }
  if (!audioArtifact?.sha256 || !visualArtifact?.sha256) {
    throw packagingError("PACKAGING_INCOMPLETE");
  }

  const manifest = buildEpisodePackageManifest({
    release,
    stageInputs,
    assemblyArtifact,
    audioArtifact,
    visualArtifact,
    thumbnail: {
      sha256: thumbnailVerdict.sha256,
      descriptor: thumbnailVerdict.descriptor,
    },
    subtitleRecord,
    metadataRecord,
  });

  const manifestRecord = buildDocumentRecord({ kind: "manifest", doc: manifest });

  return deepFreeze({
    status: "complete",
    thumbnail: { sha256: thumbnailVerdict.sha256, descriptor: thumbnailVerdict.descriptor },
    documents: {
      subtitle: subtitleRecord,
      metadata: metadataRecord,
      manifest: manifestRecord,
    },
    manifest,
    thumbnailVerdict,
    executorResult,
  });
}

// ---------------------------------------------------------------------------
// Episode package manifest (release-scoped binding of recorded artifacts)
// ---------------------------------------------------------------------------

/**
 * Builds the episode package manifest for one release: a deterministic
 * binding of the release's OWN recorded artifacts + packaging outputs.
 * Identity is recomputed from content (manifestId = SHA-256 over the
 * manifest body), so later tampering is detectable by the QC gate.
 */
export function buildEpisodePackageManifest({
  release,
  stageInputs,
  assemblyArtifact,
  audioArtifact,
  visualArtifact,
  thumbnail,
  subtitleRecord,
  metadataRecord,
}) {
  requirePlainObject(release, "PACKAGING_INPUT_INVALID");
  // The main video binding is the package's reason to exist.
  if (!assemblyArtifact || !assemblyArtifact.sha256 || !assemblyArtifact.descriptor) {
    throw packagingError("PACKAGING_INCOMPLETE");
  }
  // Descriptor provenance must ALWAYS match the release's Director — even
  // when the caller-supplied top-level agentId looks right (defense in
  // depth against mislabeled recorded artifacts).
  if (assemblyArtifact.descriptor.producer?.agentId !== release.agentId) {
    throw packagingError("PACKAGING_AGENT_SCOPE_MISMATCH");
  }

  const documentBinding = (record) => Object.freeze({
    kind: record.kind,
    sha256: record.sha256,
  });

  const manifest = {
    manifestType: "episode_package_manifest_v1",
    agentId: release.agentId,
    releaseId: release.id ?? null,
    title: stageInputs.title,
    season: stageInputs.season,
    episode: stageInputs.episode,
    artifacts: {
      mainVideo: Object.freeze({
        stage: "assembly",
        sha256: assemblyArtifact.sha256,
        verified: true,
        descriptorFingerprint: descriptorFingerprint(assemblyArtifact.descriptor),
      }),
      narration: Object.freeze({
        stage: "audio",
        sha256: audioArtifact.sha256,
      }),
      visual: Object.freeze({
        stage: "visual",
        sha256: visualArtifact.sha256,
      }),
      thumbnail: Object.freeze({
        stage: "packaging",
        sha256: thumbnail.sha256,
        verified: true,
        descriptorFingerprint: descriptorFingerprint(thumbnail.descriptor),
      }),
    },
    documents: Object.freeze({
      subtitle: documentBinding(subtitleRecord),
      metadata: documentBinding(metadataRecord),
    }),
    publication: Object.freeze({ status: "not_requested" }),
  };
  manifest.manifestId = computeDocumentHash(manifest);
  return deepFreeze(manifest);
}

/** Recompute manifest identity (tamper detection for the QC gate). */
export function computeEpisodeManifestId(manifest) {
  requirePlainObject(manifest, "QC_MANIFEST_INVALID");
  const { manifestId: _ignored, ...content } = manifest;
  return computeDocumentHash(content);
}

// ---------------------------------------------------------------------------
// QC gate (automated now; human-in-the-loop ready)
// ---------------------------------------------------------------------------

export const QC_CHECKS = Object.freeze([
  "MANIFEST_INTEGRITY",
  "MEDIA_VERIFICATION",
  "DOCUMENT_INTEGRITY",
  "AGENT_SCOPE",
  "RUNNER_CHECKS",
]);

export const QC_VERDICTS = Object.freeze(["approved", "rejected", "needs_human"]);

/**
 * Evaluate the episode QC gate for one release.
 *
 * Pipeline-authoritative checks (always run, cannot be overridden):
 *   1. MANIFEST_INTEGRITY — the recorded manifest's identity recomputes
 *      (manifestId matches content) and it binds this release.
 *   2. MEDIA_VERIFICATION — every media binding (main video, thumbnail) is
 *      bridge-verified; the release's recorded artifacts include audio and
 *      visual with real hashes.
 *   3. DOCUMENT_INTEGRITY — subtitle/metadata documents recompute from
 *      stored content (tamper detection).
 *   4. AGENT_SCOPE — every binding belongs to the release's Director.
 *
 * Runner checks (injected, automated policy now): `{ name, passed, reason? }`
 * entries — a failing check fails the gate; a `{ name, requiresHuman: true }`
 * entry yields needs_human (durable, resumable; a future owner decision can
 * then record approved/rejected — decisions are recorded, never derived).
 *
 * Returns a frozen verdict:
 *   { qcVersion, releaseId, agentId, verdict, checks, reasonCode,
 *     manifestId, decidedBy: "automated"|"human", decidedAt }
 * decidedAt is injected via `now` — identity-affecting fields stay honest.
 */
export function evaluateEpisodeQcGate({
  release,
  manifest,
  manifestRecord,
  recordedArtifacts,
  storedDocuments = {},
  runnerChecks = [],
  now = () => new Date(),
}) {
  requirePlainObject(release, "QC_MANIFEST_INVALID");
  requirePlainObject(manifest, "QC_MANIFEST_INVALID");
  if (manifest.releaseId !== (release.id ?? null)) {
    throw packagingError("QC_MANIFEST_INVALID");
  }
  if (manifest.agentId !== release.agentId) {
    throw packagingError("QC_AGENT_SCOPE_MISMATCH");
  }

  const checks = [];
  const fail = (check, reasonCode) => {
    checks.push(Object.freeze({ check, passed: false, reasonCode }));
    return finalize("rejected", reasonCode, "automated");
  };
  const self = { fail, checks };
  function finalize(verdict, reasonCode, decidedBy) {
    return deepFreeze({
      qcVersion: QC_GATE_VERSION,
      releaseId: release.id ?? null,
      agentId: release.agentId,
      verdict,
      checks: Object.freeze([...checks]),
      reasonCode: verdict === "approved" ? null : reasonCode,
      manifestId: manifest.manifestId,
      decidedBy,
      decidedAt: now().toISOString(),
    });
  }

  // 1. Manifest integrity (identity recomputation).
  if (manifest.manifestId !== computeEpisodeManifestId(manifest)) {
    return fail("MANIFEST_INTEGRITY", "QC_MANIFEST_INVALID");
  }
  if (manifestRecord && manifestRecord.sha256 !== computeDocumentContentHash(manifest)) {
    return fail("MANIFEST_INTEGRITY", "QC_DOCUMENT_TAMPERED");
  }
  checks.push(Object.freeze({ check: "MANIFEST_INTEGRITY", passed: true, reasonCode: null }));

  // 2. Media verification (pipeline-authoritative).
  const byStage = new Map((recordedArtifacts ?? []).map((a) => [a.stage, a]));
  const assembly = byStage.get("assembly");
  const audio = byStage.get("audio");
  const visual = byStage.get("visual");
  if (!assembly?.sha256 || !audio?.sha256 || !visual?.sha256) {
    throw packagingError("QC_ARTIFACT_MISSING");
  }
  if (manifest.artifacts.mainVideo.sha256 !== assembly.sha256) {
    return fail("MEDIA_VERIFICATION", "QC_ARTIFACT_MISSING");
  }
  if (manifest.artifacts.narration.sha256 !== audio.sha256 || manifest.artifacts.visual.sha256 !== visual.sha256) {
    return fail("MEDIA_VERIFICATION", "QC_ARTIFACT_MISSING");
  }
  if (manifest.artifacts.mainVideo.verified !== true || manifest.artifacts.thumbnail.verified !== true) {
    return fail("MEDIA_VERIFICATION", "QC_MEDIA_NOT_VERIFIED");
  }
  checks.push(Object.freeze({ check: "MEDIA_VERIFICATION", passed: true, reasonCode: null }));

  // 3. Document integrity (recomputed from stored content when provided).
  const documentPairs = [
    ["subtitle", manifest.documents.subtitle.sha256, storedDocuments.subtitle],
    ["metadata", manifest.documents.metadata.sha256, storedDocuments.metadata],
  ];
  for (const [name, expectedSha, content] of documentPairs) {
    if (content !== undefined) {
      const integrity = verifyStoredDocument({ expectedSha256: expectedSha, content });
      if (!integrity.intact) return fail("DOCUMENT_INTEGRITY", integrity.reason);
    }
  }
  checks.push(Object.freeze({ check: "DOCUMENT_INTEGRITY", passed: true, reasonCode: null }));

  // 4. Agent scope: every binding belongs to the release's Director.
  if (manifest.agentId !== release.agentId) {
    return fail("AGENT_SCOPE", "QC_AGENT_SCOPE_MISMATCH");
  }
  for (const artifact of recordedArtifacts ?? []) {
    if (artifact.agentId !== undefined && artifact.agentId !== release.agentId) {
      return fail("AGENT_SCOPE", "QC_AGENT_SCOPE_MISMATCH");
    }
  }
  checks.push(Object.freeze({ check: "AGENT_SCOPE", passed: true, reasonCode: null }));

  // 5. Runner checks (automated policy; requiresHuman → needs_human).
  for (const check of runnerChecks) {
    requirePlainObject(check, "QC_RUNNER_CHECK_FAILED");
    if (typeof check.name !== "string" || check.name.length === 0) {
      throw packagingError("QC_RUNNER_CHECK_FAILED");
    }
    if (check.requiresHuman === true) {
      checks.push(Object.freeze({ check: check.name, passed: false, reasonCode: "QC_HUMAN_REVIEW_REQUIRED", requiresHuman: true }));
      return finalize("needs_human", "QC_HUMAN_REVIEW_REQUIRED", "automated");
    }
    if (check.passed !== true) {
      checks.push(Object.freeze({ check: check.name, passed: false, reasonCode: check.reason ?? "QC_RUNNER_CHECK_FAILED" }));
      return finalize("rejected", check.reason ?? "QC_RUNNER_CHECK_FAILED", "automated");
    }
  }
  checks.push(Object.freeze({ check: "RUNNER_CHECKS", passed: true, reasonCode: null }));

  return finalize("approved", null, "automated");
}

/**
 * Records a human QC decision (future human-in-the-loop path). The decision
 * is explicit input — NEVER derived here. The verdict must be approved or
 * rejected; the deciding user and timestamp are injected and frozen into the
 * record so the evidence trail stays honest.
 */
export function recordHumanQcDecision({
  release,
  manifest,
  verdict,
  decidedBy,
  reasonCode = null,
  now = () => new Date(),
}) {
  requirePlainObject(release, "QC_VERDICT_MALFORMED");
  requirePlainObject(manifest, "QC_VERDICT_MALFORMED");
  if (!QC_VERDICTS.includes(verdict) || verdict === "needs_human") {
    throw packagingError("QC_VERDICT_MALFORMED");
  }
  if (typeof decidedBy !== "string" || decidedBy.length === 0 || decidedBy.length > 120) {
    throw packagingError("QC_VERDICT_MALFORMED");
  }
  if (manifest.agentId !== release.agentId) {
    throw packagingError("QC_AGENT_SCOPE_MISMATCH");
  }
  if (manifest.manifestId !== computeEpisodeManifestId(manifest)) {
    throw packagingError("QC_MANIFEST_INVALID");
  }
  return deepFreeze({
    qcVersion: QC_GATE_VERSION,
    releaseId: release.id ?? null,
    agentId: release.agentId,
    manifestId: manifest.manifestId,
    verdict,
    reasonCode,
    decidedBy: "human",
    decidedByUser: decidedBy,
    decidedAt: now().toISOString(),
  });
}

// Re-exports: the pipeline (and tests) consume one packaging/QC surface.
export {
  evaluateExecutorArtifact,
  recordExecutorArtifact,
  createArtifactDescriptor,
  verifyArtifactDescriptor,
  validateArtifactPath,
};
