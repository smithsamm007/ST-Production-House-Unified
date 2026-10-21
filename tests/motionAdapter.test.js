import test from "node:test";
import assert from "node:assert/strict";
import {
  MOTION_MODES,
  MOTION_OUTCOME_TYPE,
  MOTION_REQUEST_TYPE,
  createMotionRequest,
  declareMotionProviderCapabilities,
  recordMotionOutcome,
  serializeArtifactDescriptorRef,
  computeMotionOutcomeId,
} from "../src/media/motionAdapter.js";

const AGENT_ID = "agent-01";
const SHA = "a".repeat(64) + "b".repeat(0); // not valid; helpers below make real refs
const ref = (hex) => `sha256:${hex}`;
const FRAME_A = ref("aa".repeat(32));
const FRAME_B = ref("bb".repeat(32));

function baseParams() {
  return { sourceFps: 1, fps: 24, mbSize: 16, search: 8, frameCount: 6 };
}

test("motion request: deterministic identity — identical inputs yield byte-identical frozen records", () => {
  const a = createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A, FRAME_B], params: baseParams() });
  const b = createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A, FRAME_B], params: baseParams() });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(Object.isFrozen(a), true);
  assert.equal(a.requestType, MOTION_REQUEST_TYPE);
  assert.match(a.requestId, /^[a-f0-9]{64}$/);
});

test("motion request: source refs are explicit sha256 bindings; any other shape is rejected", () => {
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: ["frames/0001.png"], params: baseParams() }),
    /MOTION_SOURCE_REF_INVALID/
  );
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [`sha256:${"zz".repeat(32)}`], params: baseParams() }),
    /MOTION_SOURCE_REF_INVALID/
  );
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [], params: baseParams() }),
    /MOTION_SOURCE_REF_INVALID/
  );
});

test("motion request: bounded parameters — every violation fails closed with a stable code", () => {
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: { ...baseParams(), fps: 0 } }),
    /MOTION_PARAMS_INVALID/
  );
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: { ...baseParams(), fps: 121 } }),
    /MOTION_PARAMS_INVALID/
  );
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: { ...baseParams(), mbSize: 10 } }),
    /MOTION_PARAMS_INVALID/
  );
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: { ...baseParams(), frameCount: 20_001 } }),
    /MOTION_PARAMS_INVALID/
  );
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: { ...baseParams(), sourceFps: 24, fps: 24 } }),
    /MOTION_PARAMS_INVALID/
  );
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: { ...baseParams(), search: 3 } }),
    /MOTION_PARAMS_INVALID/
  );
});

test("motion request: unregistered agent ids are rejected (Rule 15 identity boundary)", () => {
  assert.throws(
    () => createMotionRequest({ agentId: "agent-not-real", sourceRefs: [FRAME_A], params: baseParams() }),
    /MOTION_AGENT_INVALID/
  );
});

test("motion request: secrets and internal agent names are rejected everywhere (Rules 15/17)", () => {
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams(), note: "vault://secret/locator" }),
    /MOTION_SECRET_REJECTED/
  );
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams(), note: "A JARVIS logo" }),
    /MOTION_INTERNAL_NAME_REJECTED/
  );
  const ok = createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams(), note: "night sky stars drift" });
  assert.equal(ok.note, "night sky stars drift");
});

test("motion request: mode is bounded; an unknown mode fails closed", () => {
  assert.throws(
    () => createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams(), mode: "vibes" }),
    /MOTION_MODE_INVALID/
  );
  assert.equal(createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams() }).mode, "minterpolate");
  assert.deepEqual([...MOTION_MODES], ["minterpolate"]);
});

test("motion capabilities: deterministic declaration, honestly local-only", () => {
  const cap = declareMotionProviderCapabilities({ adapterId: "ffmpeg-minterpolate", modalities: ["interpolation"] });
  const again = declareMotionProviderCapabilities({ adapterId: "ffmpeg-minterpolate", modalities: ["interpolation"] });
  assert.deepEqual(JSON.parse(JSON.stringify(cap)), JSON.parse(JSON.stringify(again)));
  assert.equal(cap.localOnly, true);
  assert.match(cap.capabilitiesId, /^[a-f0-9]{64}$/);
  assert.throws(
    () => declareMotionProviderCapabilities({ adapterId: "ffmpeg-minterpolate", modalities: ["dreams"] }),
    /MOTION_REQUEST_INVALID/
  );
});

test("motion outcome: UNVERIFIED descriptor never claims verified media (exit 0 is not evidence)", () => {
  const request = createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams() });
  const descriptor = {
    artifactType: "video",
    mimeType: "video/mp4",
    contentSha256: "cc".repeat(32),
    verification: { state: "UNVERIFIED", inspectedBy: null, inspectedAt: null, reasonCode: "NO_INSPECTION_RESULT" },
    descriptorId: null,
  };
  const outcome = recordMotionOutcome({ request, descriptor, providerCall: { status: "succeeded" } });
  assert.equal(outcome.mediaStatus, "unverified");
  assert.equal(outcome.generationMode, "not_evidenced");
  assert.equal(outcome.interpolationMode, "not_evidenced");
  assert.equal(outcome.quotaState, "OK");
  assert.equal(outcome.outcomeType, MOTION_OUTCOME_TYPE);
  assert.match(outcome.outcomeId, /^[a-f0-9]{64}$/);
});

test("motion outcome: VERIFIED descriptor promotes honestly to local_interpolation", () => {
  const request = createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams() });
  const descriptor = {
    artifactType: "video",
    mimeType: "video/mp4",
    contentSha256: "cc".repeat(32),
    verification: { state: "VERIFIED", inspectedBy: "ffprobe", inspectedAt: "2026-10-21T00:00:00.000Z", reasonCode: null },
    descriptorId: "desc-1",
  };
  const outcome = recordMotionOutcome({ request, descriptor });
  assert.equal(outcome.mediaStatus, "verified");
  assert.equal(outcome.generationMode, "local_interpolation");
  assert.equal(outcome.interpolationMode, "local_interpolation");
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), JSON.parse(JSON.stringify(
    recordMotionOutcome({ request, descriptor })
  )));
});

test("motion outcome: garbage input and invalid provider calls fail closed", () => {
  const request = createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams() });
  assert.throws(() => recordMotionOutcome({}), /MOTION_REQUEST_INVALID/);
  assert.throws(
    () => recordMotionOutcome({ request, descriptor: null }),
    /MOTION_REQUEST_INVALID/
  );
  assert.throws(
    () => recordMotionOutcome({
      request,
      descriptor: { artifactType: "video", mimeType: "video/mp4", contentSha256: "aa", verificationState: "UNVERIFIED" },
      providerCall: { status: "vibes" },
    }),
    /MOTION_REQUEST_INVALID/
  );
});

test("motion outcome: id is a deterministic function of the recorded evidence", () => {
  const request = createMotionRequest({ agentId: AGENT_ID, sourceRefs: [FRAME_A], params: baseParams() });
  const descriptor = {
    artifactType: "video",
    mimeType: "video/mp4",
    contentSha256: "cc".repeat(32),
    verification: { state: "UNVERIFIED", inspectedBy: null, inspectedAt: null, reasonCode: "NO_INSPECTION_RESULT" },
    descriptorId: null,
  };
  const outcome = recordMotionOutcome({ request, descriptor });
  assert.equal(outcome.outcomeId, computeMotionOutcomeId({ ...outcome, outcomeId: undefined }));
});

test("safe descriptor serialization: allowlist survived fields only (Rule 17)", () => {
  const ref1 = serializeArtifactDescriptorRef({
    artifactType: "video",
    mimeType: "video/mp4",
    contentSha256: "cc".repeat(32),
    verificationState: "UNVERIFIED",
    descriptorId: "d-1",
    secretField: "vault://should-not-serialize",
  });
  assert.deepEqual({ ...ref1 }, {
    descriptorId: "d-1",
    artifactType: "video",
    mimeType: "video/mp4",
    contentSha256: "cc".repeat(32),
    verificationState: "UNVERIFIED",
  });
  assert.throws(() => serializeArtifactDescriptorRef({ artifactType: "video", mimeType: "video/mp4" }), /MOTION_REQUEST_INVALID/);
});
