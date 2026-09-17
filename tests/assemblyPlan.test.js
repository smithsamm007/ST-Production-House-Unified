import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactDescriptor, verifyArtifactDescriptor } from "../src/media/artifactDescriptor.js";
import {
  ASSEMBLY_PLAN_TYPE,
  MAIN_VIDEO_MIN_SECONDS,
  MAIN_VIDEO_MAX_SECONDS,
  createAssemblyPlan,
  computeAssemblyPlanId,
  verifyAssemblyPlanIntegrity,
  assemblyPlanFingerprint,
  detectAssemblyPlanTampering,
  evaluateMainVideoRuntimeGate,
  serializeAssemblyPlan,
  canonicalSerializeAssemblyPlan,
} from "../src/media/assemblyPlan.js";

const REF = (hex) => `sha256:${hex}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function descriptor(overrides = {}) {
  return createArtifactDescriptor({
    contentSha256: HASH_A,
    artifactType: "video",
    mimeType: "video/mp4",
    producer: { agentId: "agent-01", runId: "run-001", stageId: "assembly", providerId: "local-ffmpeg" },
    ...overrides,
  });
}

function inspection(overrides = {}) {
  return {
    tool: "ffprobe",
    success: true,
    contentSha256: HASH_A,
    format: { duration: 2400, format_name: "mp4" },
    streams: [{ codec_type: "video" }, { codec_type: "audio" }],
    ...overrides,
  };
}

function planInput(overrides = {}) {
  return {
    agentId: "agent-01",
    productionRunId: "run-001-x",
    outputTarget: "main_longform",
    aspectRatio: "16:9",
    segments: [{ artifactRef: REF(HASH_A), kind: "video_clip", durationSeconds: 60, transitionIn: "fade" }],
    audioMix: [{ artifactRef: REF(HASH_B), role: "bgm", gainDb: -12, ducking: true }],
    subtitleTrack: { artifactRef: REF(HASH_C), format: "srt" },
    note: "night courtyard scene",
    ...overrides,
  };
}

test("createAssemblyPlan builds a deterministic SHA-256-anchored plan", () => {
  const a = createAssemblyPlan(planInput());
  const b = createAssemblyPlan(planInput());
  assert.equal(a.planType, ASSEMBLY_PLAN_TYPE);
  assert.match(a.id, /^[0-9a-f]{64}$/);
  assert.equal(a.id, b.id);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(computeAssemblyPlanId(a), a.id);
  assert.equal(verifyAssemblyPlanIntegrity(a).intact, true);
});

test("identical plans share fingerprints; any content change is detected as tampering", () => {
  const plan = createAssemblyPlan(planInput());
  const clone = createAssemblyPlan(planInput());
  assert.equal(assemblyPlanFingerprint(plan), assemblyPlanFingerprint(clone));
  assert.equal(detectAssemblyPlanTampering(plan, clone).tampered, false);
  for (const mutate of [
    (p) => ({ ...p, note: "different note" }),
    (p) => ({ ...p, outputTarget: "content_reel_1" }),
    (p) => ({ ...p, aspectRatio: "9:16" }),
    (p) => ({ ...p, segments: [] }),
  ]) {
    assert.equal(detectAssemblyPlanTampering(plan, mutate(plan)).tampered, true);
  }
});

test("tampered plans fail the integrity gate; type mismatch is reported first", () => {
  const plan = createAssemblyPlan(planInput());
  assert.equal(verifyAssemblyPlanIntegrity({ ...plan, note: "mutated" }).reason, "ASSEMBLY_ID_MISMATCH");
  assert.equal(verifyAssemblyPlanIntegrity({ planType: "other" }).reason, "ASSEMBLY_PLAN_TYPE_MISMATCH");
});

test("artifact references accept only sha256:<64-hex>; traversal/injection/paths fail closed", () => {
  const base = planInput();
  for (const bad of [
    "../../../etc/passwd",
    "/absolute/path/video.mp4",
    "file:///etc/passwd",
    "sha256:ZZZ",
    "sha256:" + "g".repeat(64),
    "video.mp4",
    "sha256:" + "a".repeat(63),
    REF(HASH_A) + "; rm -rf /",
    REF(HASH_A) && "`id`",
    "  ",
    "",
  ]) {
    assert.throws(
      () => createAssemblyPlan({ ...base, segments: [{ artifactRef: bad, kind: "video_clip" }] }),
      /ASSEMBLY_ARTIFACT_REF_INVALID/,
    );
  }
});

test("shell metacharacters and secret-like values are rejected everywhere", () => {
  assert.throws(() => createAssemblyPlan(planInput({ productionRunId: "run-1; rm -rf /" })), /ASSEMBLY_RUN_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ productionRunId: "run-$(whoami)" })), /ASSEMBLY_RUN_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ productionRunId: "run-001-x", note: "token access_token abc" })), /ASSEMBLY_SECRET_REJECTED/);
  assert.throws(() => createAssemblyPlan(planInput({ note: "as told by SHERLOCK" })), /ASSEMBLY_INTERNAL_NAME_REJECTED/);
});

test("unknown fields fail closed at plan and sub-object level", () => {
  assert.throws(() => createAssemblyPlan(planInput({ extraField: 1 })), /ASSEMBLY_FIELD_UNKNOWN/);
  assert.throws(
    () => createAssemblyPlan(planInput({ segments: [{ artifactRef: REF(HASH_A), kind: "video_clip", exec: "/bin/sh" }] })),
    /ASSEMBLY_SEGMENT_FIELD_UNKNOWN/,
  );
  assert.throws(
    () => createAssemblyPlan(planInput({ audioMix: [{ artifactRef: REF(HASH_B), role: "bgm", cmd: "curl" }] })),
    /ASSEMBLY_AUDIO_FIELD_UNKNOWN/,
  );
  assert.throws(
    () => createAssemblyPlan(planInput({ subtitleTrack: { artifactRef: REF(HASH_C), format: "srt", url: "http://x" } })),
    /ASSEMBLY_SUBTITLE_FIELD_UNKNOWN/,
  );
});

test("enums and bounded numerics enforce the contract", () => {
  assert.throws(() => createAssemblyPlan(planInput({ aspectRatio: "21:9" })), /ASSEMBLY_ASPECT_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ outputTarget: "tv_special" })), /ASSEMBLY_OUTPUT_TARGET_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ segments: [{ artifactRef: REF(HASH_A), kind: "hologram" }] })), /ASSEMBLY_SEGMENT_KIND_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ segments: [{ artifactRef: REF(HASH_A), kind: "video_clip", durationSeconds: 99999 }] })), /ASSEMBLY_SEGMENT_DURATION_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ segments: [{ artifactRef: REF(HASH_A), kind: "video_clip", transitionIn: "explode" }] })), /ASSEMBLY_TRANSITION_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ audioMix: [{ artifactRef: REF(HASH_B), role: "narrator" }] })), /ASSEMBLY_AUDIO_ROLE_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ audioMix: [{ artifactRef: REF(HASH_B), role: "bgm", gainDb: 100 }] })), /ASSEMBLY_AUDIO_GAIN_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ subtitleTrack: { artifactRef: REF(HASH_C), format: "ass" } })), /ASSEMBLY_SUBTITLE_FORMAT_INVALID/);
  assert.throws(() => createAssemblyPlan(planInput({ segments: [] })), /ASSEMBLY_SEGMENT_LIMIT/);
  assert.throws(() => createAssemblyPlan(planInput({ agentId: "agent-999" })), /ASSEMBLY_AGENT_INVALID/);
});

test("runtime QC gate: no inspection ⇒ NOT VERIFIED with truthful upstream reason", () => {
  const d = descriptor({ durationSeconds: 2400 });
  const result = evaluateMainVideoRuntimeGate(d, null);
  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, "QC_DESCRIPTOR_NOT_VERIFIED");
  assert.equal(result.inspectionReasonCode, "NO_INSPECTION_RESULT");
  assert.equal(result.measuredDurationSeconds, null);
});

test("runtime QC gate: failed or mismatched inspections never promote", () => {
  const d = descriptor({ durationSeconds: 2400 });
  assert.equal(evaluateMainVideoRuntimeGate(d, inspection({ success: false })).reasonCode, "QC_DESCRIPTOR_NOT_VERIFIED");
  assert.equal(
    evaluateMainVideoRuntimeGate(d, inspection({ contentSha256: HASH_B })).inspectionReasonCode,
    "INSPECTION_HASH_MISMATCH",
  );
  assert.equal(
    evaluateMainVideoRuntimeGate(d, inspection({ tool: "imaginary-probe" })).inspectionReasonCode,
    "INSPECTION_TOOL_UNKNOWN",
  );
});

test("runtime QC gate: passing gate measures duration from the inspection payload", () => {
  const d = descriptor({ durationSeconds: 2400 });
  const result = evaluateMainVideoRuntimeGate(d, inspection());
  assert.equal(result.passed, true);
  assert.equal(result.measuredDurationSeconds, 2400);
  // string duration (real ffprobe reports strings) accepted
  const strResult = evaluateMainVideoRuntimeGate(d, inspection({ format: { duration: "2400" } }));
  assert.equal(strResult.passed, true);
});

test("runtime QC gate: out-of-range main videos fail closed", () => {
  assert.equal(MAIN_VIDEO_MIN_SECONDS, 1800);
  assert.equal(MAIN_VIDEO_MAX_SECONDS, 3000);
  const short = descriptor({ contentSha256: HASH_A, durationSeconds: 30 });
  const shortResult = evaluateMainVideoRuntimeGate(short, inspection({ format: { duration: 30 } }));
  assert.equal(shortResult.passed, false);
  assert.equal(shortResult.reasonCode, "QC_DURATION_OUT_OF_RANGE");
  assert.equal(shortResult.measuredDurationSeconds, 30);
  const long = descriptor({ contentSha256: HASH_A, durationSeconds: 3001 });
  assert.equal(evaluateMainVideoRuntimeGate(long, inspection({ format: { duration: 3001 } })).reasonCode, "QC_DURATION_OUT_OF_RANGE");
  // boundary values pass
  assert.equal(evaluateMainVideoRuntimeGate(descriptor({ durationSeconds: 1800 }), inspection({ format: { duration: 1800 } })).passed, true);
  assert.equal(evaluateMainVideoRuntimeGate(descriptor({ durationSeconds: 3000 }), inspection({ format: { duration: 3000 } })).passed, true);
});

test("runtime QC gate: claimed-vs-measured conflict fails closed", () => {
  const d = descriptor({ durationSeconds: 2400 });
  assert.equal(evaluateMainVideoRuntimeGate(d, inspection({ format: { duration: 2999 } })).reasonCode, "QC_DURATION_CONFLICT");
  assert.equal(evaluateMainVideoRuntimeGate(d, inspection({ format: { duration: 2400.5 } })).passed, true);
});

test("runtime QC gate: missing measured duration cannot pass", () => {
  const d = descriptor();
  const result = evaluateMainVideoRuntimeGate(d, inspection({ format: {} }));
  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, "QC_INSPECTION_DURATION_MISSING");
});

test("serialization is a strict allowlist; verified artifacts re-serialize byte-identically", () => {
  const plan = createAssemblyPlan(planInput());
  const out1 = serializeAssemblyPlan(plan);
  const out2 = serializeAssemblyPlan(plan);
  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  assert.deepEqual(Object.keys(out1), [
    "planType", "id", "agentId", "productionRunId", "outputTarget",
    "aspectRatio", "segments", "audioMix", "subtitleTrack", "note",
  ]);
  assert.equal(Object.isFrozen(out1), true);
  // extra/unknown keys are dropped by the allowlist projection (no leak),
  // while deleting or mutating an allowlisted field fails the integrity gate
  const polluted = { ...plan, credentialLocator: "vault://kms/x", ownerToken: "tok_1" };
  const json = JSON.stringify(serializeAssemblyPlan(polluted));
  assert.equal(json.includes("vault://"), false);
  assert.equal(json.includes("ownerToken"), false);
  assert.throws(
    () => serializeAssemblyPlan({ ...plan, note: undefined }),
    /ASSEMBLY_ID_MISMATCH/,
  );
  assert.equal(canonicalSerializeAssemblyPlan(plan), JSON.stringify(out1));
  // serialized plan without verification block is deterministic across runs
  const verified = verifyArtifactDescriptor(descriptor(), inspection());
  assert.equal(verified.verification.state, "VERIFIED");
});
