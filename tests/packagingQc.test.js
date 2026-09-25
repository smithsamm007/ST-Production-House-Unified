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
  buildCanonicalMediaPackageManifest,
  QC_CHECKS,
  QC_VERDICTS,
} from "../src/pipeline/packagingQc.js";
import {
  buildCanonicalReelPackagePlan,
  buildReelAssemblyPlans,
  CANONICAL_REELS,
  REELS_STAGE_ERROR_CODES,
} from "../src/pipeline/reelsStage.js";
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
    "PACKAGING_DESCRIPTOR_INVALID",
    "PACKAGING_INCOMPLETE",
    "PACKAGING_INPUT_INVALID",
    "PACKAGING_INSPECTION_UNAVAILABLE",
    "PACKAGING_MEDIA_REJECTED",
    "PACKAGING_REEL_DESCRIPTORS_MISSING",
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
  assert.deepEqual([...REELS_STAGE_ERROR_CODES].sort(), [
    "REELS_AGENT_SCOPE_MISMATCH",
    "REELS_INPUT_INVALID",
    "REELS_MEDIA_REJECTED",
    "REELS_NOT_INDEPENDENT",
    "REELS_PLAN_UNBUILDABLE",
    "REELS_RUNNER_REQUIRED",
  ]);
});

// ---------------------------------------------------------------------------
// Canonical package production (Issue #189)
// ---------------------------------------------------------------------------

const RUN_ID = "episode-c189001";

function makeVerifiedDescriptor({ artifactType, sha, runId = RUN_ID, mimeType }) {
  const descriptor = createArtifactDescriptor({
    artifactType,
    mimeType: mimeType ?? (artifactType === "video" ? "video/mp4" : artifactType === "thumbnail" ? "image/png" : "audio/mpeg"),
    contentSha256: sha,
    producer: { agentId: "agent-01", runId, stageId: "test", providerId: "test-provider" },
    createdAt: NOW().toISOString(),
  });
  return {
    ...descriptor,
    verification: { state: "VERIFIED", inspectedBy: "ffprobe", inspectedAt: NOW().toISOString(), reasonCode: null },
  };
}

function makeCanonicalFixtures() {
  const narration = { stage: "audio", agentId: "agent-01", sha256: "a".repeat(64), descriptor: makeVerifiedDescriptor({ artifactType: "audio", sha: "a".repeat(64) }) };
  const visual = { stage: "visual", agentId: "agent-01", sha256: "c".repeat(64), descriptor: makeVerifiedDescriptor({ artifactType: "image", sha: "c".repeat(64) }) };
  const reelPackage = buildCanonicalReelPackagePlan({
    agentId: "agent-01",
    productionRunId: RUN_ID,
    narrationArtifact: narration,
    visualArtifact: visual,
    brandIdentityKey: "channel-agent-01",
  });
  const reelArtifacts = [
    { stage: "reel:content_reel_1", agentId: "agent-01", reelKey: "content_reel_1", sha256: "1".repeat(64), descriptor: makeVerifiedDescriptor({ artifactType: "video", sha: "1".repeat(64) }) },
    { stage: "reel:content_reel_2", agentId: "agent-01", reelKey: "content_reel_2", sha256: "2".repeat(64), descriptor: makeVerifiedDescriptor({ artifactType: "video", sha: "2".repeat(64) }) },
    { stage: "reel:brand_reel", agentId: "agent-01", reelKey: "brand_reel", sha256: "3".repeat(64), descriptor: makeVerifiedDescriptor({ artifactType: "video", sha: "3".repeat(64) }) },
  ];
  const assemblyArtifact = { stage: "assembly", agentId: "agent-01", sha256: "d".repeat(64), descriptor: makeVerifiedDescriptor({ artifactType: "video", sha: "d".repeat(64) }) };
  const thumbnail = { sha256: "b".repeat(64), descriptor: makeVerifiedDescriptor({ artifactType: "image", sha: "b".repeat(64) }) };
  const thumbnailInspection = { tool: "ffprobe", success: true, contentSha256: "b".repeat(64), format: { filename: "thumb.png", format_name: "png", size: "24" }, streams: [{ codec_type: "video", codec_name: "png" }] };
  const canonicalManifest = buildCanonicalMediaPackageManifest({
    release: RELEASE,
    productionRunId: RUN_ID,
    reelPackage,
    assemblyArtifact,
    reelArtifacts,
    thumbnail,
    thumbnailInspection,
  });
  return { narration, visual, reelPackage, reelArtifacts, assemblyArtifact, thumbnail, thumbnailInspection, canonicalManifest };
}

test("canonical reels: 2 independent content reels + 1 brand reel, STANDALONE_ONLY by default", () => {
  const f = makeCanonicalFixtures();
  assert.equal(f.reelPackage.planType, "reel_package_plan_v1");
  assert.equal(f.reelPackage.brandIntegrationMode, "STANDALONE_ONLY", "brand integration stays owner-gated (Rule 9)");
  assert.equal(f.reelPackage.mainVideoIntegration, null);
  assert.equal(f.reelPackage.contentReels.length, 2);
  assert.equal(f.reelPackage.brandReel.role, "brand_reel");
  assert.notEqual(f.reelPackage.contentReels[0].hook, f.reelPackage.contentReels[1].hook);
  assert.notEqual(
    JSON.stringify(f.reelPackage.contentReels[0].segments),
    JSON.stringify(f.reelPackage.contentReels[1].segments),
    "genuinely distinct segment plans",
  );
  assert.equal(f.reelPackage.brandReel.productIdentityKey, "channel-agent-01");
  assert.equal(f.reelPackage.contentReels[0].productIdentityKey, null);
});

test("canonical reels: copying a content reel fails closed (independence enforcement)", async () => {
  const spec = CANONICAL_REELS[0];
  const { createReelPlan, assertReelIndependence } = await import("../src/production/reelPlan.js");
  const copy = createReelPlan({
    agentId: "agent-01", productionRunId: RUN_ID, role: "content_reel",
    hook: spec.hook, objective: spec.objective, aspectRatio: "9:16", durationSeconds: 12,
    captionConcept: "x", segments: [{ artifactRef: `sha256:${"c".repeat(64)}`, kind: "still_image", durationSeconds: 12 }],
    destinations: ["youtube_shorts"],
  });
  assert.throws(() => assertReelIndependence(copy, copy), /REEL_/);
  void copy;
});

test("canonical reels: INTEGRATED brand mode is never constructed by the pipeline (owner gate)", () => {
  // The pipeline-side builder only ever produces STANDALONE_ONLY; INTEGRATED
  // requires ownerAuthorization bound to the run (Rule 9) and is constructed
  // solely through the S-M34-01 contract with owner material.
  assert.ok(CANONICAL_REELS.every((r) => r.role !== "integration"));
});

test("canonical S-M37 manifest binds the whole package; production-ready check passes", () => {
  const f = makeCanonicalFixtures();
  assert.equal(f.canonicalManifest.manifestType, "media_package_manifest_v1");
  assert.equal(f.canonicalManifest.agentId, "agent-01");
  assert.equal(f.canonicalManifest.mainVideo.verificationState, "VERIFIED");
  assert.equal(f.canonicalManifest.contentReelArtifacts.length, 2);
  assert.equal(f.canonicalManifest.brandReelArtifact.verificationState, "VERIFIED");
  assert.equal(f.canonicalManifest.thumbnailPlans.length, 1);
  assert.equal(f.canonicalManifest.brandIntegrationMode, "STANDALONE_ONLY");

  const f2 = makeCanonicalFixtures();
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest: buildEpisodePackageManifest({
      release: RELEASE,
      stageInputs: STAGE_INPUTS,
      assemblyArtifact: { ...f2.assemblyArtifact, descriptor: f2.assemblyArtifact.descriptor },
      audioArtifact: f2.narration,
      visualArtifact: f2.visual,
      thumbnail: f2.thumbnail,
      subtitleRecord: buildDocumentRecord({ kind: "subtitle", doc: { x: 1 } }),
      metadataRecord: buildDocumentRecord({ kind: "metadata", doc: { x: 2 } }),
    }),
    manifestRecord: null,
    recordedArtifacts: [...f2.reelArtifacts, f2.assemblyArtifact, f2.narration, f2.visual],
    canonicalManifest: f2.canonicalManifest,
    now: NOW,
  });
  assert.equal(verdict.verdict, "approved");
  assert.ok(verdict.checks.some((c) => c.check === "CANONICAL_PACKAGE_READY" && c.passed === true));
});

test("canonical QC rejects an unverified reel binding through the S-M37 production-ready gate", () => {
  const f = makeCanonicalFixtures();
  const unverifiedReel = {
    ...f.reelArtifacts[0],
    descriptor: {
      ...f.reelArtifacts[0].descriptor,
      verification: { state: "UNVERIFIED", inspectedBy: null, inspectedAt: null, reasonCode: "NO_INSPECTION_RESULT" },
    },
  };
  const tamperedManifest = buildCanonicalMediaPackageManifest({
    release: RELEASE,
    productionRunId: RUN_ID,
    reelPackage: f.reelPackage,
    assemblyArtifact: f.assemblyArtifact,
    reelArtifacts: [unverifiedReel, f.reelArtifacts[1], f.reelArtifacts[2]],
    thumbnail: f.thumbnail,
    thumbnailInspection: f.thumbnailInspection,
  });
  const verdict = evaluateEpisodeQcGate({
    release: RELEASE,
    manifest: buildEpisodePackageManifest({
      release: RELEASE,
      stageInputs: STAGE_INPUTS,
      assemblyArtifact: f.assemblyArtifact,
      audioArtifact: f.narration,
      visualArtifact: f.visual,
      thumbnail: f.thumbnail,
      subtitleRecord: buildDocumentRecord({ kind: "subtitle", doc: { x: 1 } }),
      metadataRecord: buildDocumentRecord({ kind: "metadata", doc: { x: 2 } }),
    }),
    manifestRecord: null,
    recordedArtifacts: [unverifiedReel, ...f.reelArtifacts.slice(1), f.assemblyArtifact, f.narration, f.visual],
    canonicalManifest: tamperedManifest,
    now: NOW,
  });
  assert.equal(verdict.verdict, "rejected");
  assert.equal(verdict.reasonCode, "MEDIA_STATUS_NOT_VERIFIED");
});

test("canonical manifest refuses cross-Director descriptors (isolation) and foreign runs", () => {
  const f = makeCanonicalFixtures();
  const foreignReel = { ...f.reelArtifacts[0], descriptor: makeVerifiedDescriptor({ artifactType: "video", sha: "1".repeat(64), runId: RUN_ID }) };
  foreignReel.descriptor = {
    ...foreignReel.descriptor,
    producer: { ...foreignReel.descriptor.producer, agentId: "agent-02" },
  };
  assert.throws(
    () => buildCanonicalMediaPackageManifest({
      release: RELEASE,
      productionRunId: RUN_ID,
      reelPackage: f.reelPackage,
      assemblyArtifact: f.assemblyArtifact,
      reelArtifacts: [foreignReel, f.reelArtifacts[1], f.reelArtifacts[2]],
      thumbnail: f.thumbnail,
      thumbnailInspection: f.thumbnailInspection,
    }),
    /MANIFEST_ARTIFACT_CROSS_DIRECTOR/,
  );
  const foreignRun = { ...f.reelArtifacts[0], descriptor: makeVerifiedDescriptor({ artifactType: "video", sha: "1".repeat(64), runId: "episode-forei00" }) };
  assert.throws(
    () => buildCanonicalMediaPackageManifest({
      release: RELEASE,
      productionRunId: RUN_ID,
      reelPackage: f.reelPackage,
      assemblyArtifact: f.assemblyArtifact,
      reelArtifacts: [foreignRun, f.reelArtifacts[1], f.reelArtifacts[2]],
      thumbnail: f.thumbnail,
      thumbnailInspection: f.thumbnailInspection,
    }),
    /MANIFEST_ARTIFACT_RUN_MISMATCH/,
  );
});

test("short-form assembly plans carry the short-form QC window per canonical reel", () => {
  const f = makeCanonicalFixtures();
  const plans = buildReelAssemblyPlans({
    reelPackage: f.reelPackage,
    narrationArtifact: f.narration,
    visualArtifact: f.visual,
    paths: { episode: "/stph/media/episodes" },
    productionRunId: RUN_ID,
  });
  assert.equal(plans.length, 3);
  for (const entry of plans) {
    assert.ok(["content_reel_1", "content_reel_2", "brand_reel"].includes(entry.plan.outputTarget), "short-form output target drives the 5–180 s QC gate");
    assert.equal(entry.plan.aspectRatio, "9:16");
    const planned = entry.plan.segments.filter((s) => s.kind === "still_image").reduce((sum, s) => sum + s.durationSeconds, 0);
    assert.ok(planned >= 5 && planned <= 180, `planned duration ${planned}s inside the short-form window`);
  }
  assert.notEqual(plans[0].plan.id, plans[1].plan.id, "per-reel plans are distinct canonical plans");
});
