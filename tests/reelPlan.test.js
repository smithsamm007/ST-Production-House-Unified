import test from "node:test";
import assert from "node:assert/strict";
import {
  REEL_PLAN_TYPE,
  REEL_PACKAGE_TYPE,
  REEL_DESTINATIONS,
  createReelPlan,
  computeReelPlanId,
  verifyReelPlanIntegrity,
  assertReelIndependence,
  createReelPackagePlan,
  computeReelPackagePlanId,
  verifyReelPackagePlanIntegrity,
  detectReelPackagePlanTampering,
  serializeReelPackagePlan,
} from "../src/production/reelPlan.js";

const REF = (hex) => `sha256:${hex}`;
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);

function contentA(overrides = {}) {
  return {
    agentId: "agent-01",
    productionRunId: "run-001-x",
    role: "content_reel",
    hook: "Ek raat ki dastak",
    objective: "Set the horror hook in 8 seconds",
    aspectRatio: "9:16",
    durationSeconds: 45,
    captionConcept: "Darr ki shuruaat",
    segments: [{ artifactRef: REF(H1), kind: "video_clip", durationSeconds: 20 }],
    destinations: ["youtube_shorts", "instagram_reels"],
    ...overrides,
  };
}

function contentB(overrides = {}) {
  return contentA({
    hook: "Woh kamra jo kabhi khula nahi",
    objective: "Deepen the mystery without revealing the source",
    captionConcept: "Raaz andhere mein chhupa hai",
    segments: [{ artifactRef: REF(H2), kind: "still_image", durationSeconds: 15 }],
    destinations: ["instagram_reels", "facebook_reels"],
    ...overrides,
  });
}

function brand(overrides = {}) {
  return contentA({
    role: "brand_reel",
    hook: "Raat Ki Awaaz presents",
    objective: "Standalone channel promotion with atmospheric treatment",
    productIdentityKey: "st-channel-hindi-horror",
    segments: [{ artifactRef: REF(H3), kind: "video_clip", durationSeconds: 25 }],
    destinations: ["youtube_shorts", "snapchat_spotlight"],
    ...overrides,
  });
}

test("createReelPlan builds deterministic SHA-256-anchored reel plans", () => {
  const a = createReelPlan(contentA());
  const b = createReelPlan(contentA());
  assert.equal(a.planType, REEL_PLAN_TYPE);
  assert.match(a.id, /^[0-9a-f]{64}$/);
  assert.equal(a.id, b.id);
  assert.equal(computeReelPlanId(a), a.id);
  assert.equal(verifyReelPlanIntegrity(a).intact, true);
});

test("destination allowlist stays inside the canonical package destinations", () => {
  for (const destination of REEL_DESTINATIONS) {
    assert.equal(typeof destination, "string");
  }
  assert.throws(() => createReelPlan(contentA({ destinations: ["tiktok"] })), /REEL_DESTINATION_INVALID/);
  assert.throws(() => createReelPlan(contentA({ destinations: ["youtube"] })), /REEL_DESTINATION_INVALID/); // long-form only
  assert.throws(() => createReelPlan(contentA({ destinations: ["youtube_shorts", "youtube_shorts"] })), /REEL_DESTINATION_DUPLICATE/);
  assert.throws(() => createReelPlan(contentA({ destinations: [] })), /REEL_DESTINATION_INVALID/);
});

test("artifact references accept only sha256 refs; paths and injection fail closed", () => {
  for (const bad of ["../../x.mp4", "/abs/path", "file:///x", "sha256:zz", ""]) {
    assert.throws(
      () => createReelPlan(contentA({ segments: [{ artifactRef: bad, kind: "video_clip" }] })),
      /REEL_ARTIFACT_REF_INVALID/,
    );
  }
  assert.throws(() => createReelPlan(contentA({ hook: "call access_token now" })), /REEL_SECRET_REJECTED/);
  assert.throws(() => createReelPlan(contentA({ captionConcept: "follow NEWTON for more" })), /REEL_INTERNAL_NAME_REJECTED/);
  assert.throws(() => createReelPlan(contentA({ extraField: 1 })), /REEL_FIELD_UNKNOWN/);
  assert.throws(() => createReelPlan(contentA({ agentId: "agent-999" })), /REEL_AGENT_INVALID/);
  assert.throws(() => createReelPlan(contentA({ aspectRatio: "16:9" })), /REEL_ASPECT_INVALID/); // long-form not a reel
  assert.throws(() => createReelPlan(contentA({ durationSeconds: 200 })), /REEL_DURATION_INVALID/);
});

test("independence: identical or trivially-identical reels fail closed with stable codes", () => {
  const a = createReelPlan(contentA());
  assert.throws(() => assertReelIndependence(a, createReelPlan(contentA())), /REEL_HOOK_NOT_INDEPENDENT/);
  // punctuation/case-insensitive: same hook with different subtitles cannot pass
  assert.throws(
    () => assertReelIndependence(a, createReelPlan(contentA({ hook: "EK RAAT KI DASTAK!" }))),
    /REEL_HOOK_NOT_INDEPENDENT/,
  );
  assert.throws(
    () => assertReelIndependence(a, createReelPlan(contentA({ hook: "Different hook entirely" }))),
    /REEL_OBJECTIVE_NOT_INDEPENDENT/,
  );
  assert.throws(
    () =>
      assertReelIndependence(
        a,
        createReelPlan(contentA({ hook: "Different hook entirely", objective: "A different objective", segments: contentA().segments })),
        ),
    /REEL_SEGMENT_PLAN_NOT_INDEPENDENT/,
  );
  assert.equal(assertReelIndependence(a, createReelPlan(contentB())), true);
});

test("content reels carry independent recomputed identities", () => {
  const a = createReelPlan(contentA());
  const b = createReelPlan(contentB());
  assert.equal(a.id !== b.id, true);
  assert.equal(computeReelPlanId(a), a.id);
  assert.equal(computeReelPlanId(b), b.id);
});

test("package: STANDALONE_ONLY never emits a main-video integration", () => {
  const pkg = createReelPackagePlan({
    agentId: "agent-01",
    productionRunId: "run-001-x",
    contentReels: [contentA(), contentB()],
    brandReel: brand(),
    brandIntegrationMode: "STANDALONE_ONLY",
  });
  assert.equal(pkg.planType, REEL_PACKAGE_TYPE);
  assert.equal(pkg.mainVideoIntegration, null);
  assert.equal(pkg.ownerDecision, null);
  assert.equal(verifyReelPackagePlanIntegrity(pkg).intact, true);
  // supplying integration material under STANDALONE_ONLY fails closed
  assert.throws(
    () =>
      createReelPackagePlan({
        agentId: "agent-01",
        productionRunId: "run-001-x",
        contentReels: [contentA(), contentB()],
        brandReel: brand(),
        brandIntegrationMode: "STANDALONE_ONLY",
        mainVideoIntegration: { artifactRef: REF(H4) },
      }),
    /REEL_INTEGRATION_CONFLICT/,
  );
});

test("package: INTEGRATED without owner authorization fails closed", () => {
  assert.throws(
    () =>
      createReelPackagePlan({
        agentId: "agent-01",
        productionRunId: "run-001-x",
        contentReels: [contentA(), contentB()],
        brandReel: brand(),
        brandIntegrationMode: "INTEGRATED",
      }),
    /REEL_OWNER_AUTHORIZATION_REQUIRED/,
  );
  assert.throws(
    () =>
      createReelPackagePlan({
        agentId: "agent-01",
        productionRunId: "run-001-x",
        contentReels: [contentA(), contentB()],
        brandReel: brand(),
        brandIntegrationMode: "INTEGRATED",
        ownerAuthorization: { authorizationRef: "auth-001", boundRunId: "run-999-z" },
        mainVideoIntegration: { artifactRef: REF(H4) },
      }),
    /REEL_AUTHORIZATION_RUN_MISMATCH/,
  );
});

test("package: INTEGRATED binds run-scoped authorization and forbids artifact reuse", () => {
  const pkg = createReelPackagePlan({
    agentId: "agent-01",
    productionRunId: "run-001-x",
    contentReels: [contentA(), contentB()],
    brandReel: brand(),
    brandIntegrationMode: "INTEGRATED",
    ownerAuthorization: { authorizationRef: "auth-001", boundRunId: "run-001-x" },
    mainVideoIntegration: { artifactRef: REF(H4), note: "15s brand segment for the main video" },
  });
  assert.equal(pkg.mainVideoIntegration.artifactRef, REF(H4));
  assert.equal(pkg.ownerDecision, null);
  // reusing the brand Reel's own artifact as the main-video segment fails closed
  assert.throws(
    () =>
      createReelPackagePlan({
        agentId: "agent-01",
        productionRunId: "run-001-x",
        contentReels: [contentA(), contentB()],
        brandReel: brand(),
        brandIntegrationMode: "INTEGRATED",
        ownerAuthorization: { authorizationRef: "auth-001", boundRunId: "run-001-x" },
        mainVideoIntegration: { artifactRef: REF(H3) }, // brand reel's artifact
      }),
    /REEL_INTEGRATION_ARTIFACT_REUSE/,
  );
});

test("package: OWNER_DECISION_REQUIRED records the pending decision without inventing one", () => {
  const pkg = createReelPackagePlan({
    agentId: "agent-01",
    productionRunId: "run-001-x",
    contentReels: [contentA(), contentB()],
    brandReel: brand(),
    brandIntegrationMode: "OWNER_DECISION_REQUIRED",
  });
  assert.deepEqual(pkg.ownerDecision, { status: "pending", decidedBy: null });
  assert.equal(pkg.mainVideoIntegration, null);
  // a pending decision cannot already carry authorization material
  assert.throws(
    () =>
      createReelPackagePlan({
        agentId: "agent-01",
        productionRunId: "run-001-x",
        contentReels: [contentA(), contentB()],
        brandReel: brand(),
        brandIntegrationMode: "OWNER_DECISION_REQUIRED",
        ownerAuthorization: { authorizationRef: "auth-001", boundRunId: "run-001-x" },
      }),
    /REEL_MODE_CONFLICT/,
  );
});

test("package: paid/sponsored standalone campaigns surface owner-action blocker truthfully", () => {
  const pkg = createReelPackagePlan({
    agentId: "agent-01",
    productionRunId: "run-001-x",
    contentReels: [contentA(), contentB()],
    brandReel: brand({ paidCampaign: true }),
    brandIntegrationMode: "STANDALONE_ONLY",
  });
  assert.deepEqual(pkg.ownerDecision, { status: "owner_action_required", decidedBy: null });
});

test("package: scope mismatch and unknown fields fail closed", () => {
  assert.throws(
    () => createReelPackagePlan({ agentId: "agent-01", productionRunId: "run-001-x", contentReels: [contentA()], brandReel: brand(), brandIntegrationMode: "STANDALONE_ONLY" }),
    /REEL_PACKAGE_CONTENT_COUNT/,
  );
  assert.throws(
    () =>
      createReelPackagePlan({
        agentId: "agent-01",
        productionRunId: "run-001-x",
        contentReels: [contentA({ productionRunId: "run-999-z" }), contentB()],
        brandReel: brand(),
        brandIntegrationMode: "STANDALONE_ONLY",
      }),
    /REEL_PACKAGE_SCOPE_MISMATCH/,
  );
  assert.throws(
    () =>
      createReelPackagePlan({
        agentId: "agent-01",
        productionRunId: "run-001-x",
        contentReels: [contentA({ role: "brand_reel", productIdentityKey: "p-1" }), contentB()],
        brandReel: brand(),
        brandIntegrationMode: "STANDALONE_ONLY",
      }),
    /REEL_PACKAGE_SCOPE_MISMATCH/,
  );
  assert.throws(
    () => createReelPackagePlan({ agentId: "agent-01", productionRunId: "run-001-x", contentReels: [contentA(), contentB()], brandReel: brand(), brandIntegrationMode: "SILENT_MERGE", surprise: 1 }),
    /REEL_PACKAGE_FIELD_UNKNOWN/,
  );
});

test("package identity is deterministic; tampering is detected", () => {
  const input = {
    agentId: "agent-01",
    productionRunId: "run-001-x",
    contentReels: [contentA(), contentB()],
    brandReel: brand(),
    brandIntegrationMode: "STANDALONE_ONLY",
  };
  const a = createReelPackagePlan(input);
  const b = createReelPackagePlan(input);
  assert.equal(a.id, b.id);
  assert.equal(computeReelPackagePlanId(a), a.id);
  assert.equal(detectReelPackagePlanTampering(a, b).tampered, false);
  assert.equal(detectReelPackagePlanTampering(a, { ...a, brandIntegrationMode: "INTEGRATED" }).tampered, true);
  assert.equal(verifyReelPackagePlanIntegrity({ ...a, brandReel: { ...a.brandReel, hook: "mutated" } }).reason, "REEL_PACKAGE_ID_MISMATCH");
});

test("serialization is a strict allowlist; authorization refs never serialize", () => {
  const integrated = createReelPackagePlan({
    agentId: "agent-01",
    productionRunId: "run-001-x",
    contentReels: [contentA(), contentB()],
    brandReel: brand(),
    brandIntegrationMode: "INTEGRATED",
    ownerAuthorization: { authorizationRef: "auth-001", boundRunId: "run-001-x" },
    mainVideoIntegration: { artifactRef: REF(H4) },
  });
  const out1 = serializeReelPackagePlan(integrated);
  const out2 = serializeReelPackagePlan(integrated);
  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  assert.deepEqual(Object.keys(out1), [
    "planType",
    "id",
    "agentId",
    "productionRunId",
    "brandIntegrationMode",
    "contentReels",
    "brandReel",
    "mainVideoIntegration",
    "ownerDecision",
  ]);
  assert.equal(JSON.stringify(out1).includes("auth-001"), false);
  assert.equal(Object.isFrozen(out1), true);
  // polluted extra keys are dropped by the allowlist (no leak)
  const polluted = serializeReelPackagePlan({ ...integrated, credentialLocator: "vault://kms/x" });
  assert.equal(JSON.stringify(polluted).includes("vault://"), false);
  // deletion of an allowlisted field fails the integrity gate
  assert.throws(() => serializeReelPackagePlan({ ...integrated, mainVideoIntegration: undefined }), /REEL_PACKAGE_ID_MISMATCH/);
});
