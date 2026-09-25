import test from "node:test";
import assert from "node:assert/strict";

import {
  PACKAGING_QC_ERROR_CODES,
  PACKAGING_VERSION,
  derivePackagingInputs,
  buildDocumentRecord,
  computeDocumentContentHash,
  verifyStoredDocument,
  buildEpisodePackageManifest,
  computeEpisodeManifestId,
  runPackagingStage,
  evaluateEpisodeQcGate,
  recordHumanQcDecision,
  QC_CHECKS,
  QC_VERDICTS,
} from "../src/pipeline/packagingQc.js";
import { createArtifactDescriptor } from "../src/media/artifactDescriptor.js";

const NOW = () => new Date("2026-09-25T10:00:00.000Z");

const RELEASE = { id: "release-1", agentId: "agent-01" };
const STAGE_INPUTS = { channelId: "ch-1", title: "Nightfall Ward 7", season: 1, episode: 3 };

function makeDescriptor({ agentId = "agent-01", artifactType = "image", sha = "b".repeat(64) } = {}) {
  const descriptor = createArtifactDescriptor({
    artifactType,
    mimeType: artifactType === "image" ? "image/png" : "video/mp4",
    contentSha256: sha,
    producer: { agentId, runId: "run-1", stageId: "visual", providerId: "pollinations" },
    createdAt: NOW().toISOString(),
  });
  return {
    ...descriptor,
    verification: {
      state: "VERIFIED",
      inspectedBy: "ffprobe",
      inspectedAt: NOW().toISOString(),
      reasonCode: null,
    },
  };
}

function makeRecordedArtifacts() {
  return [
    {
      stage: "audio",
      agentId: "agent-01",
      sha256: "a".repeat(64),
      storagePath: "/run/narration.mp3",
      descriptor: makeDescriptor({ artifactType: "audio", sha: "a".repeat(64) }),
    },
    {
      stage: "visual",
      agentId: "agent-01",
      sha256: "c".repeat(64),
      storagePath: "/run/frame.png",
      descriptor: makeDescriptor({ sha: "c".repeat(64) }),
    },
    {
      stage: "assembly",
      agentId: "agent-01",
      sha256: "d".repeat(64),
      storagePath: "/run/episode.mp4",
      descriptor: makeDescriptor({ artifactType: "video", sha: "d".repeat(64) }),
    },
  ];
}

const THUMBNAIL_RESULT = {
  success: true,
  failureCode: null,
  quotaState: "OK",
  mediaStatus: "verified",
  generationMode: "provider_generated",
  descriptor: makeDescriptor({ sha: "b".repeat(64) }),
  outcome: null,
  inspection: { success: true, contentSha256: "b".repeat(64) },
  outputPath: "/run/thumbnail.png",
};

// ---------------------------------------------------------------------------
// derivePackagingInputs: deterministic, release-scoped
// ---------------------------------------------------------------------------

test("derivePackagingInputs is deterministic and scoped to the release's Director", () => {
  const a = derivePackagingInputs({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: makeRecordedArtifacts() });
  const b = derivePackagingInputs({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: makeRecordedArtifacts() });
  assert.equal(a.inputsVersion, PACKAGING_VERSION);
  assert.deepEqual(a, b, "packaging inputs are a pure function of release identity + stage hashes");
  assert.equal(a.subtitleDoc.agentId, "agent-01");
  assert.equal(a.metadataDoc.agentId, "agent-01");
  assert.equal(a.thumbnailRequest.agentId, "agent-01");
  assert.ok(a.subtitleDoc.sourceStageHashes.assembly);
});

test("derivePackagingInputs fails closed on cross-Director or malformed input", () => {
  const foreign = makeRecordedArtifacts();
  foreign[0] = { ...foreign[0], agentId: "agent-02" };
  assert.throws(() => derivePackagingInputs({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: foreign }), /PACKAGING_AGENT_SCOPE_MISMATCH/);
  assert.throws(() => derivePackagingInputs({ release: null, stageInputs: STAGE_INPUTS, recordedArtifacts: [] }), /PACKAGING_INPUT_INVALID/);
  assert.throws(() => derivePackagingInputs({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: "x" }), /PACKAGING_INPUT_INVALID/);
});

// ---------------------------------------------------------------------------
// Document records: content-addressed, tamper-detectable
// ---------------------------------------------------------------------------

test("buildDocumentRecord is content-addressed; verifyStoredDocument detects tampering", () => {
  const doc = { hello: "world", n: 1 };
  const record = buildDocumentRecord({ kind: "subtitle", doc });
  assert.equal(record.kind, "subtitle");
  assert.equal(record.sha256, computeDocumentContentHash(doc));
  assert.deepEqual(verifyStoredDocument({ expectedSha256: record.sha256, content: record.content }), { intact: true, reason: null });
  assert.equal(verifyStoredDocument({ expectedSha256: record.sha256, content: record.content.replace("world", "tampered") }).intact, false);
  assert.equal(verifyStoredDocument({ expectedSha256: record.sha256, content: "" }).reason, "QC_DOCUMENT_TAMPERED");
});

// ---------------------------------------------------------------------------
// Episode package manifest: binding + identity
// ---------------------------------------------------------------------------

test("buildEpisodePackageManifest binds the release's own artifacts; identity recomputes", () => {
  const recorded = makeRecordedArtifacts();
  const subtitleRecord = buildDocumentRecord({ kind: "subtitle", doc: { documentType: "episode_subtitle_document_v1", agentId: "agent-01" } });
  const metadataRecord = buildDocumentRecord({ kind: "metadata", doc: { documentType: "episode_metadata_document_v1", agentId: "agent-01" } });
  const manifest = buildEpisodePackageManifest({
    release: RELEASE,
    stageInputs: STAGE_INPUTS,
    assemblyArtifact: recorded.find((a) => a.stage === "assembly"),
    audioArtifact: recorded.find((a) => a.stage === "audio"),
    visualArtifact: recorded.find((a) => a.stage === "visual"),
    thumbnail: { sha256: "b".repeat(64), descriptor: makeDescriptor({ sha: "b".repeat(64) }) },
    subtitleRecord,
    metadataRecord,
  });
  assert.equal(manifest.manifestType, "episode_package_manifest_v1");
  assert.equal(manifest.agentId, "agent-01");
  assert.equal(manifest.publication.status, "not_requested");
  assert.equal(manifest.manifestId, computeEpisodeManifestId(manifest));
  assert.equal(manifest.artifacts.mainVideo.sha256, "d".repeat(64));
  assert.equal(manifest.artifacts.thumbnail.sha256, "b".repeat(64));

  // Tampering with the manifest body is detectable.
  const tampered = { ...manifest, title: "Mutated" };
  assert.notEqual(computeEpisodeManifestId(tampered), manifest.manifestId);
});

test("manifest binding fails closed on cross-Director descriptors or missing assembly", () => {
  const recorded = makeRecordedArtifacts();
  const foreignAssembly = { ...recorded[2], descriptor: makeDescriptor({ agentId: "agent-02", artifactType: "video" }) };
  assert.throws(
    () => buildEpisodePackageManifest({
      release: RELEASE,
      stageInputs: STAGE_INPUTS,
      assemblyArtifact: foreignAssembly,
      audioArtifact: recorded[0],
      visualArtifact: recorded[1],
      thumbnail: { sha256: "b".repeat(64), descriptor: makeDescriptor({}) },
      subtitleRecord: buildDocumentRecord({ kind: "subtitle", doc: {} }),
      metadataRecord: buildDocumentRecord({ kind: "metadata", doc: {} }),
    }),
    /PACKAGING_AGENT_SCOPE_MISMATCH/,
  );
  assert.throws(
    () => buildEpisodePackageManifest({
      release: RELEASE,
      stageInputs: STAGE_INPUTS,
      assemblyArtifact: null,
      audioArtifact: recorded[0],
      visualArtifact: recorded[1],
      thumbnail: { sha256: "b".repeat(64), descriptor: makeDescriptor({}) },
      subtitleRecord: buildDocumentRecord({ kind: "subtitle", doc: {} }),
      metadataRecord: buildDocumentRecord({ kind: "metadata", doc: {} }),
    }),
    /PACKAGING_INCOMPLETE/,
  );
});

// ---------------------------------------------------------------------------
// runPackagingStage: end-to-end shapes
// ---------------------------------------------------------------------------

test("runPackagingStage completes: thumbnail verified, documents + manifest built", async () => {
  const runner = async () => THUMBNAIL_RESULT;
  const result = await runPackagingStage({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: makeRecordedArtifacts(), runner });
  assert.equal(result.status, "complete");
  assert.equal(result.thumbnailVerdict.verified, true);
  assert.equal(result.thumbnail.sha256, "b".repeat(64));
  assert.ok(result.documents.subtitle.sha256.match(/^[0-9a-f]{64}$/));
  assert.ok(result.documents.metadata.sha256.match(/^[0-9a-f]{64}$/));
  assert.ok(result.documents.manifest.sha256.match(/^[0-9a-f]{64}$/));
  assert.equal(result.manifest.artifacts.mainVideo.sha256, "d".repeat(64));
});

test("runPackagingStage propagates durable waits and honest failures", async () => {
  const waitingRunner = async () => ({ success: false, descriptor: null, inspection: null, outcome: null, quotaState: "WAITING_FOR_QUOTA", mediaStatus: "unverified", generationMode: "not_evidenced", failureCode: "CREDENTIAL_MISSING" });
  const waiting = await runPackagingStage({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: makeRecordedArtifacts(), runner: waitingRunner });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.failureCode, "CREDENTIAL_MISSING");

  const failingRunner = async () => ({ success: false, descriptor: null, inspection: { success: false, contentSha256: null }, outcome: null, quotaState: "OK", mediaStatus: "unverified", generationMode: "not_evidenced", failureCode: "INSPECTION_FAILED" });
  const failed = await runPackagingStage({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: makeRecordedArtifacts(), runner: failingRunner });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "INSPECTION_FAILED");
});

test("runPackagingStage rejects a forged verified thumbnail (bridge forgery gate)", async () => {
  const forged = { ...THUMBNAIL_RESULT, descriptor: makeDescriptor({ sha: "b".repeat(64) }), inspection: null };
  const runner = async () => forged;
  await assert.rejects(
    () => runPackagingStage({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: makeRecordedArtifacts(), runner }),
    /EXECUTOR_DESCRIPTOR_INVALID/,
    "hand-forged verification without a real inspection cannot record",
  );
});

test("runPackagingStage requires a runner and a release Director binding", async () => {
  await assert.rejects(() => runPackagingStage({ release: RELEASE, stageInputs: STAGE_INPUTS, recordedArtifacts: makeRecordedArtifacts(), runner: null }), /PACKAGING_RUNNER_REQUIRED/);
  await assert.rejects(() => runPackagingStage({ release: { id: "r" }, stageInputs: STAGE_INPUTS, recordedArtifacts: [], runner: async () => THUMBNAIL_RESULT }), /PACKAGING_AGENT_SCOPE_MISMATCH/);
});

// ---------------------------------------------------------------------------
// evaluateEpisodeQcGate: automated verdicts
// ---------------------------------------------------------------------------

function buildGateFixtures() {
  const recorded = makeRecordedArtifacts();
  const subtitleDoc = { documentType: "episode_subtitle_document_v1", agentId: "agent-01", lines: [1, 2] };
  const metadataDoc = { documentType: "episode_metadata_document_v1", agentId: "agent-01", entries: [] };
  const subtitleRecord = buildDocumentRecord({ kind: "subtitle", doc: subtitleDoc });
  const metadataRecord = buildDocumentRecord({ kind: "metadata", doc: metadataDoc });
  const manifest = buildEpisodePackageManifest({
    release: RELEASE,
    stageInputs: STAGE_INPUTS,
    assemblyArtifact: recorded.find((a) => a.stage === "assembly"),
    audioArtifact: recorded.find((a) => a.stage === "audio"),
    visualArtifact: recorded.find((a) => a.stage === "visual"),
    thumbnail: { sha256: "b".repeat(64), descriptor: makeDescriptor({ sha: "b".repeat(64) }) },
    subtitleRecord,
    metadataRecord,
  });
  const manifestRecord = buildDocumentRecord({ kind: "manifest", doc: manifest });
  return { recorded, subtitleDoc, metadataDoc, subtitleRecord, metadataRecord, manifest, manifestRecord };
}

test("QC gate approves a complete verified package (all four pipeline checks pass)", () => {
  const f = buildGateFixtures();
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest: f.manifest,
    manifestRecord: f.manifestRecord,
    recordedArtifacts: f.recorded,
    storedDocuments: { subtitle: f.subtitleRecord.content, metadata: f.metadataRecord.content },
    runnerChecks: [{ name: "duration_policy", passed: true }],
    now: NOW,
  });
  assert.equal(verdict.verdict, "approved");
  assert.equal(verdict.decidedBy, "automated");
  assert.equal(verdict.reasonCode, null);
  assert.ok(verdict.checks.every((c) => c.passed === true));
  assert.deepEqual(verdict.checks.map((c) => c.check), [...QC_CHECKS]);
  assert.equal(verdict.manifestId, f.manifest.manifestId);
});

test("QC gate rejects a tampered manifest document (identity recheck from content)", () => {
  const f = buildGateFixtures();
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest: f.manifest,
    manifestRecord: { ...f.manifestRecord, sha256: "0".repeat(64) },
    recordedArtifacts: f.recorded,
    now: NOW,
  });
  assert.equal(verdict.verdict, "rejected");
  assert.equal(verdict.reasonCode, "QC_DOCUMENT_TAMPERED");
});

test("QC gate fails closed on tampered stored documents", () => {
  const f = buildGateFixtures();
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest: f.manifest,
    manifestRecord: f.manifestRecord,
    recordedArtifacts: f.recorded,
    storedDocuments: { subtitle: f.subtitleRecord.content.replace("1", "9"), metadata: f.metadataRecord.content },
    now: NOW,
  });
  assert.equal(verdict.verdict, "rejected");
  assert.equal(verdict.reasonCode, "QC_DOCUMENT_TAMPERED");
});

test("QC gate rejects when manifest does not bind the recorded artifacts", () => {
  const f = buildGateFixtures();
  const shifted = f.recorded.map((a) => (a.stage === "assembly" ? { ...a, sha256: "e".repeat(64) } : a));
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest: f.manifest,
    manifestRecord: f.manifestRecord,
    recordedArtifacts: shifted,
    now: NOW,
  });
  assert.equal(verdict.verdict, "rejected");
  assert.equal(verdict.reasonCode, "QC_ARTIFACT_MISSING");
});

test("QC gate rejects unverified media bindings", () => {
  const f = buildGateFixtures();
  const manifest = {
    ...f.manifest,
    artifacts: { ...f.manifest.artifacts, mainVideo: { ...f.manifest.artifacts.mainVideo, verified: false } },
  };
  manifest.manifestId = computeEpisodeManifestId(manifest);
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest,
    manifestRecord: null,
    recordedArtifacts: f.recorded,
    now: NOW,
  });
  assert.equal(verdict.verdict, "rejected");
  assert.equal(verdict.reasonCode, "QC_MEDIA_NOT_VERIFIED");
});

test("QC gate fails closed on foreign manifests and cross-Director artifacts", () => {
  const f = buildGateFixtures();
  assert.throws(
    () => evaluateEpisodeQcGate({ release: { id: "other", agentId: "agent-01" }, manifest: f.manifest, recordedArtifacts: f.recorded, now: NOW }),
    /QC_MANIFEST_INVALID/,
  );
  const foreignRecorded = f.recorded.map((a) => ({ ...a, agentId: "agent-02" }));
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest: f.manifest,
    manifestRecord: f.manifestRecord,
    recordedArtifacts: foreignRecorded,
    now: NOW,
  });
  assert.equal(verdict.verdict, "rejected");
  assert.equal(verdict.reasonCode, "QC_AGENT_SCOPE_MISMATCH");
});

test("QC gate: missing recorded artifacts throws (fail closed), never approves", () => {
  const f = buildGateFixtures();
  assert.throws(
    () => evaluateEpisodeQcGate({ release: RELEASE, manifest: f.manifest, manifestRecord: f.manifestRecord, recordedArtifacts: [], now: NOW }),
    /QC_ARTIFACT_MISSING/,
  );
});

// ---------------------------------------------------------------------------
// Human-in-the-loop support
// ---------------------------------------------------------------------------

test("QC gate surfaces needs_human for runner checks requiring human review", () => {
  const f = buildGateFixtures();
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest: f.manifest,
    manifestRecord: f.manifestRecord,
    recordedArtifacts: f.recorded,
    runnerChecks: [{ name: "brand_visibility_audit", requiresHuman: true }],
    now: NOW,
  });
  assert.equal(verdict.verdict, "needs_human");
  assert.equal(verdict.decidedBy, "automated", "the gate itself did not decide — a human must");
  assert.equal(verdict.reasonCode, "QC_HUMAN_REVIEW_REQUIRED");
});

test("recordHumanQcDecision records explicit human decisions; never derives them", () => {
  const f = buildGateFixtures();
  const decision = recordHumanQcDecision({
    release: RELEASE,
    manifest: f.manifest,
    verdict: "approved",
    decidedBy: "owner-session-7",
    now: NOW,
  });
  assert.equal(decision.decidedBy, "human");
  assert.equal(decision.decidedByUser, "owner-session-7");
  assert.equal(decision.verdict, "approved");
  assert.equal(decision.manifestId, f.manifest.manifestId);

  assert.throws(() => recordHumanQcDecision({ release: RELEASE, manifest: f.manifest, verdict: "needs_human", decidedBy: "x", now: NOW }), /QC_VERDICT_MALFORMED/);
  assert.throws(() => recordHumanQcDecision({ release: RELEASE, manifest: f.manifest, verdict: "approved", decidedBy: "", now: NOW }), /QC_VERDICT_MALFORMED/);
  assert.throws(() => recordHumanQcDecision({ release: { id: "r", agentId: "agent-02" }, manifest: f.manifest, verdict: "approved", decidedBy: "x", now: NOW }), /QC_AGENT_SCOPE_MISMATCH/);
  assert.throws(() => recordHumanQcDecision({ release: RELEASE, manifest: { ...f.manifest, title: "mutated" }, verdict: "approved", decidedBy: "x", now: NOW }), /QC_MANIFEST_INVALID/);
});

// ---------------------------------------------------------------------------
// Code-set closure
// ---------------------------------------------------------------------------

test("error codes are exported and closed", () => {
  assert.deepEqual([...PACKAGING_QC_ERROR_CODES].sort(), [
    "PACKAGING_AGENT_SCOPE_MISMATCH",
    "PACKAGING_INCOMPLETE",
    "PACKAGING_INPUT_INVALID",
    "PACKAGING_MEDIA_REJECTED",
    "PACKAGING_RUNNER_REQUIRED",
    "QC_AGENT_SCOPE_MISMATCH",
    "QC_ARTIFACT_MISSING",
    "QC_CONTENT_HASH_MISSING",
    "QC_DOCUMENT_TAMPERED",
    "QC_MANIFEST_INVALID",
    "QC_MEDIA_NOT_VERIFIED",
    "QC_RUNNER_CHECK_FAILED",
    "QC_VERDICT_MALFORMED",
  ]);
});
