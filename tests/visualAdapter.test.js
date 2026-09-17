import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactDescriptor, verifyArtifactDescriptor } from "../src/media/artifactDescriptor.js";
import {
  VISUAL_OUTCOME_TYPE,
  VISUAL_REQUEST_TYPE,
  VISUAL_PROFILE_TYPE,
  VISUAL_PROVIDER_TIERS,
  VISUAL_MODALITIES,
  declareVisualProviderCapabilities,
  createVisualStyleProfile,
  verifyVisualStyleProfile,
  computeVisualProfileId,
  createVisualGenerationRequest,
  computeVisualRequestId,
  recordVisualGenerationOutcome,
  verifyVisualOutcome,
  computeVisualOutcomeId,
  serializeVisualOutcome,
} from "../src/media/visualAdapter.js";

const H = "e".repeat(64);

function profile(overrides = {}) {
  return createVisualStyleProfile({
    agentId: "agent-01",
    styleSummary: "moody desaturated horror, deep shadows, film grain",
    framing: "wide establishing, slow push-ins",
    aspectRatio: "16:9",
    palette: "cold blues and sodium amber",
    continuityHints: ["recurrent brass lamp", "monsoon wet streets"],
    ...overrides,
  });
}

function request(styleProfile, overrides = {}) {
  return createVisualGenerationRequest({
    styleProfile,
    modality: "image",
    provider: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", modelIdentifier: "free-image-v1" },
    scenePlanRef: "sceneplan-abc#scene-1",
    ...overrides,
  });
}

function descriptor(overrides = {}) {
  return createArtifactDescriptor({
    contentSha256: H,
    artifactType: "image",
    mimeType: "image/png",
    producer: { agentId: "agent-01", runId: "run-001", stageId: "visuals", providerId: "prov-free-image-01" },
    ...overrides,
  });
}

function inspection(overrides = {}) {
  return {
    tool: "ffprobe",
    success: true,
    contentSha256: H,
    format: { duration: 0 },
    streams: [{ codec_type: "video" }],
    ...overrides,
  };
}

test("routing chain is the fixed free-first order with no paid tier", () => {
  assert.deepEqual(
    VISUAL_PROVIDER_TIERS.map((tier) => tier.role),
    ["approved_free_primary", "approved_free_secondary", "approved_free_tertiary", "local_open_source_emergency"],
  );
  assert.ok(VISUAL_MODALITIES.length >= 4);
});

test("capability declarations validate bounded fields with deterministic ids", () => {
  const cap = declareVisualProviderCapabilities({
    adapterId: "adapter-image-free",
    modalities: ["image", "video_clip"],
    aspectRatios: ["16:9", "9:16"],
    maxClipSeconds: 30,
    supportsCharacterContinuity: true,
  });
  assert.match(cap.capabilitiesId, /^[0-9a-f]{64}$/);
  const clone = declareVisualProviderCapabilities({
    adapterId: "adapter-image-free",
    modalities: ["video_clip", "image"],
    aspectRatios: ["9:16", "16:9"],
    maxClipSeconds: 30,
    supportsCharacterContinuity: true,
  });
  assert.equal(cap.capabilitiesId, clone.capabilitiesId); // modality order normalized
  assert.throws(() => declareVisualProviderCapabilities({ adapterId: "x", modalities: ["hologram"], aspectRatios: ["16:9"] }), /VISUAL_MODALITY_INVALID/);
  assert.throws(() => declareVisualProviderCapabilities({ adapterId: "adapter", modalities: ["image"], aspectRatios: ["21:9"] }), /VISUAL_ASPECT_INVALID/);
  assert.throws(() => declareVisualProviderCapabilities({ adapterId: "adapter", modalities: ["image"], aspectRatios: ["16:9"], maxClipSeconds: 0 }), /VISUAL_BOUNDS_INVALID/);
  assert.throws(() => declareVisualProviderCapabilities({ adapterId: "adapter with access_token", modalities: ["image"], aspectRatios: ["16:9"] }), /VISUAL_SECRET_REJECTED/);
});

test("style profiles are Director-scoped, locator-free, and tamper-detectable", () => {
  const p = profile();
  assert.equal(p.profileType, VISUAL_PROFILE_TYPE);
  assert.match(p.visualProfileId, /^[0-9a-f]{64}$/);
  assert.equal(verifyVisualStyleProfile(p).ok, true);
  assert.equal(verifyVisualStyleProfile({ ...p, styleSummary: "mutated" }).reasonCode, "VISUAL_PROFILE_TAMPERED");
  assert.equal(computeVisualProfileId(p), p.visualProfileId);
  assert.throws(() => profile({ agentId: "agent-999" }), /VISUAL_AGENT_INVALID/);
  assert.throws(() => profile({ styleSummary: "styled after SHERLOCK" }), /VISUAL_INTERNAL_NAME_REJECTED/);
  assert.throws(() => profile({ palette: "vault://kms/secret" }), /VISUAL_SECRET_REJECTED/);
  assert.throws(() => profile({ continuityHints: Array.from({ length: 21 }, () => "hint") }), /VISUAL_CONTINUITY_INVALID/);
});

test("generation requests bind profile, modality, provider, and scene reference; ids are deterministic", () => {
  const p = profile();
  const r1 = request(p);
  const r2 = request(p);
  assert.equal(r1.requestType, VISUAL_REQUEST_TYPE);
  assert.equal(r1.requestId, r2.requestId);
  assert.equal(computeVisualRequestId(r1), r1.requestId);
  assert.equal(r1.clipSeconds, null); // image modality has no clip duration
  const clip = request(p, { modality: "video_clip", clipSeconds: 8 });
  assert.equal(clip.clipSeconds, 8);
  assert.throws(() => request(p, { clipSeconds: 5 }), /VISUAL_CLIP_SECONDS_INVALID/); // image with clipSeconds
  assert.throws(() => request(p, { modality: "video_clip" }), /VISUAL_CLIP_SECONDS_INVALID/); // clip without duration
  assert.throws(() => request(p, { scenePlanRef: "../../etc/passwd" }), /VISUAL_SCENE_REF_INVALID/);
  assert.throws(() => request(p, { scenePlanRef: "a;b" }), /VISUAL_SCENE_REF_INVALID/);
  assert.throws(() => request(p, { provider: { providerId: "p", providerRole: "approved_free_primary", modelIdentifier: "m" } }), /VISUAL_PROVIDER_INVALID/);
  assert.throws(() => request(p, { provider: { providerId: "prov-ok-1", providerRole: "paid_fallback", modelIdentifier: "m" } }), /VISUAL_PROVIDER_ROLE_INVALID/);
  // tampered profile is rejected at request creation (the profile gate
  // surfaces the tamper before the request is ever built)
  assert.throws(() => request({ ...p, visualProfileId: "0".repeat(64) }), /VISUAL_PROFILE_INVALID/);
});

test("outcome truthfulness: succeeded call with UNVERIFIED descriptor is never media-ready", () => {
  const p = profile();
  const r = request(p);
  const d = descriptor();
  const outcome = recordVisualGenerationOutcome({
    styleProfile: p,
    request: r,
    descriptor: d,
    providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "succeeded" },
  });
  assert.equal(outcome.outcomeType, VISUAL_OUTCOME_TYPE);
  assert.equal(outcome.mediaStatus, "unverified");
  assert.equal(outcome.generationMode, "not_evidenced");
  assert.equal(outcome.quotaState, "OK");
  assert.equal(outcome.descriptorVerificationState, "UNVERIFIED");
  assert.deepEqual(outcome.publication, { status: "not_requested" });
});

test("outcome truthfulness: VERIFIED descriptor (real inspection) yields provider_generated", () => {
  const p = profile();
  const r = request(p);
  const verified = verifyArtifactDescriptor(descriptor(), inspection());
  assert.equal(verified.verification.state, "VERIFIED");
  const outcome = recordVisualGenerationOutcome({
    styleProfile: p,
    request: r,
    descriptor: verified,
    providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "succeeded" },
  });
  assert.equal(outcome.mediaStatus, "verified");
  assert.equal(outcome.generationMode, "provider_generated");
});

test("quota exhaustion records WAITING_FOR_QUOTA truthfully", () => {
  const p = profile();
  const r = request(p);
  const outcome = recordVisualGenerationOutcome({
    styleProfile: p,
    request: r,
    descriptor: descriptor(),
    providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "quota_exhausted" },
  });
  assert.equal(outcome.quotaState, "WAITING_FOR_QUOTA");
  assert.equal(outcome.mediaStatus, "unverified");
  assert.equal(outcome.generationMode, "not_evidenced");
});

test("outcome scoping: cross-Director descriptors and mismatched providers fail closed", () => {
  const p = profile();
  const r = request(p);
  assert.throws(
    () =>
      recordVisualGenerationOutcome({
        styleProfile: p,
        request: r,
        descriptor: descriptor({ producer: { agentId: "agent-02", runId: "run-001", stageId: "visuals", providerId: "prov-free-image-01" } }),
        providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "succeeded" },
      }),
    /VISUAL_AGENT_SCOPE_MISMATCH/,
  );
  assert.throws(
    () =>
      recordVisualGenerationOutcome({
        styleProfile: p,
        request: r,
        descriptor: descriptor(),
        providerCall: { providerId: "prov-other-image-9", providerRole: "approved_free_primary", status: "succeeded" },
      }),
    /VISUAL_PROVIDER_MISMATCH/,
  );
  // descriptor type must match modality (image request + video descriptor)
  assert.throws(
    () =>
      recordVisualGenerationOutcome({
        styleProfile: p,
        request: r,
        descriptor: descriptor({ artifactType: "video", mimeType: "video/mp4" }),
        providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "succeeded" },
      }),
    /VISUAL_DESCRIPTOR_INVALID/,
  );
  // hand-forged verification block is rejected (unknown inspector tool)
  const forged = { ...descriptor(), verification: { state: "VERIFIED", inspectedBy: "imaginary-probe", inspectedAt: null, reasonCode: null } };
  assert.throws(
    () =>
      recordVisualGenerationOutcome({
        styleProfile: p,
        request: r,
        descriptor: forged,
        providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "succeeded" },
      }),
    /VISUAL_DESCRIPTOR_INVALID/,
  );
  // tampered request cannot be recorded
  assert.throws(
    () =>
      recordVisualGenerationOutcome({
        styleProfile: p,
        request: { ...r, scenePlanRef: "sceneplan-abc#scene-2" },
        descriptor: descriptor(),
        providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "succeeded" },
      }),
    /VISUAL_REQUEST_TAMPERED/,
  );
});

test("outcomes are deterministic with recomputed ids and tamper detection", () => {
  const p = profile();
  const r = request(p);
  const args = {
    styleProfile: p,
    request: r,
    descriptor: descriptor(),
    providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "succeeded" },
  };
  const a = recordVisualGenerationOutcome(args);
  const b = recordVisualGenerationOutcome(args);
  assert.equal(a.outcomeId, b.outcomeId);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(computeVisualOutcomeId(a), a.outcomeId);
  assert.equal(verifyVisualOutcome(a).ok, true);
  assert.equal(verifyVisualOutcome({ ...a, mediaStatus: "verified" }).reasonCode, "VISUAL_OUTCOME_TAMPERED");
  assert.equal(verifyVisualOutcome({ outcomeType: "other" }).reasonCode, "VISUAL_OUTCOME_MALFORMED");
});

test("serialization is a strict allowlist; polluted fields can never leak", () => {
  const p = profile();
  const r = request(p);
  const outcome = recordVisualGenerationOutcome({
    styleProfile: p,
    request: r,
    descriptor: descriptor(),
    providerCall: { providerId: "prov-free-image-01", providerRole: "approved_free_primary", status: "succeeded" },
  });
  const out1 = serializeVisualOutcome(outcome);
  const out2 = serializeVisualOutcome(outcome);
  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  assert.deepEqual(Object.keys(out1), [
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
  assert.equal(Object.isFrozen(out1), true);
  const polluted = serializeVisualOutcome({ ...outcome, credentialLocator: "vault://kms/secret", ownerToken: "tok" });
  assert.equal(JSON.stringify(polluted).includes("vault://"), false);
  assert.equal(JSON.stringify(polluted).includes("ownerToken"), false);
});
