import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MEDIA_PACKAGE_MANIFEST_TYPE,
  MANIFEST_MEDIA_STATUSES,
  createMediaPackageManifest,
  computeMediaPackageManifestId,
  verifyMediaPackageManifest,
  detectMediaPackageManifestTampering,
  isMediaPackageProductionReady,
  serializeMediaPackageManifest,
} from "../src/production/mediaPackageManifest.js";
import {
  createArtifactDescriptor,
  verifyArtifactDescriptor,
  descriptorFingerprint,
} from "../src/media/artifactDescriptor.js";
import {
  createReelPlan,
  createReelPackagePlan,
} from "../src/production/reelPlan.js";

// ---------------------------------------------------------------------------
// Deterministic helpers (no clocks, no randomness — tests are reproducible)
// ---------------------------------------------------------------------------

const AGENT_ID = "agent-01"; // JARVIS in the catalog (internal-only rule respected in content)
const RUN_ID = "run-2026-001-x";
const OTHER_RUN_ID = "run-2026-999-z";

const MAIN_HASH = "a".repeat(64);
const REEL1_HASH = "b".repeat(64);
const REEL2_HASH = "c".repeat(64);
const BRAND_HASH = "d".repeat(64);
const INTEGRATION_HASH = "e".repeat(64);
const SUBTITLE_HASH = "f".repeat(64);
const THUMBNAIL_HASH = "1".repeat(64);

/** Content-hash helper: "hash of real bytes" — deterministic per label. */
const contentHash = (label) => createHash("sha256").update(label).digest("hex");

let descriptorCounter = 0;

function producer(overrides = {}) {
  descriptorCounter += 1;
  return {
    agentId: AGENT_ID,
    runId: RUN_ID,
    stageId: "assembly",
    providerId: "local_emergency",
    ...overrides,
  };
}

function descriptorInput(hash, overrides = {}) {
  return {
    contentSha256: hash,
    artifactType: "video",
    mimeType: "video/mp4",
    durationSeconds: 2100.5,
    producer: producer(),
    ...overrides,
  };
}

function passingInspection(hash, overrides = {}) {
  return {
    tool: "ffprobe",
    success: true,
    contentSha256: hash,
    format: { duration: "2100.5", format_name: "mp4" },
    streams: [{ codec_type: "video", width: 1920, height: 1080 }],
    ...overrides,
  };
}

function verifiedDescriptor(hash, overrides = {}, inspectionOverrides = {}) {
  return verifyArtifactDescriptor(
    createArtifactDescriptor(descriptorInput(hash, overrides)),
    passingInspection(
      descriptorInput(hash, overrides).contentSha256,
      inspectionOverrides,
    ),
  );
}

function unverifiedDescriptor(hash, overrides = {}) {
  return createArtifactDescriptor(descriptorInput(hash, overrides));
}

function contentA(overrides = {}) {
  return {
    agentId: AGENT_ID,
    productionRunId: RUN_ID,
    role: "content_reel",
    hook: "Ek raat ki dastak",
    objective: "Set the horror hook in 8 seconds",
    aspectRatio: "9:16",
    durationSeconds: 45,
    captionConcept: "Darr ki shuruaat",
    segments: [{ artifactRef: `sha256:${REEL1_HASH}`, kind: "video_clip", durationSeconds: 20 }],
    destinations: ["youtube_shorts", "instagram_reels"],
    ...overrides,
  };
}

function contentB(overrides = {}) {
  return contentA({
    hook: "Woh kamra jo kabhi khula nahi",
    objective: "Deepen the mystery without revealing the source",
    captionConcept: "Raaz andhere mein chhupa hai",
    segments: [{ artifactRef: `sha256:${REEL2_HASH}`, kind: "still_image", durationSeconds: 15 }],
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
    segments: [{ artifactRef: `sha256:${BRAND_HASH}`, kind: "video_clip", durationSeconds: 25 }],
    destinations: ["youtube_shorts", "snapchat_spotlight"],
    ...overrides,
  });
}

function reelPackage(overrides = {}) {
  return createReelPackagePlan({
    agentId: AGENT_ID,
    productionRunId: RUN_ID,
    contentReels: [contentA(), contentB()],
    brandReel: brand(),
    brandIntegrationMode: "STANDALONE_ONLY",
    ...overrides,
  });
}

/** One fully valid standalone manifest input (rebuilt per call for isolation). */
function manifestInput(overrides = {}) {
  return {
    agentId: AGENT_ID,
    productionRunId: RUN_ID,
    reelPackage: reelPackage(),
    mainVideo: { descriptor: verifiedDescriptor(MAIN_HASH) },
    contentReelArtifacts: [
      { descriptor: verifiedDescriptor(REEL1_HASH) },
      { descriptor: verifiedDescriptor(REEL2_HASH) },
    ],
    brandReelArtifact: { descriptor: verifiedDescriptor(BRAND_HASH) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Canonical package construction + media status truthfulness
// ---------------------------------------------------------------------------

test("canonical 1 main + 2 content Reels + 1 brand Reel manifest builds with recomputed id", () => {
  const manifest = createMediaPackageManifest(manifestInput());
  assert.equal(manifest.manifestType, MEDIA_PACKAGE_MANIFEST_TYPE);
  assert.match(manifest.id, /^[0-9a-f]{64}$/);
  assert.equal(manifest.agentId, AGENT_ID);
  assert.equal(manifest.productionRunId, RUN_ID);
  assert.equal(manifest.brandIntegrationMode, "STANDALONE_ONLY");
  assert.equal(manifest.mainVideo.verificationState, "VERIFIED");
  assert.equal(manifest.contentReelArtifacts.length, 2);
  assert.equal(manifest.mainVideoIntegration, null);
  assert.equal(manifest.publication.status, "not_requested");
  assert.equal(verifyMediaPackageManifest(manifest).intact, true);
});

test("mediaStatus derives ONLY from bound verification states (no_media / partial / verified)", () => {
  assert.deepEqual(MANIFEST_MEDIA_STATUSES, ["no_media", "partial_unverified", "verified"]);

  const noneVerified = createMediaPackageManifest(
    manifestInput({
      mainVideo: { descriptor: unverifiedDescriptor(MAIN_HASH) },
      contentReelArtifacts: [
        { descriptor: unverifiedDescriptor(REEL1_HASH) },
        { descriptor: unverifiedDescriptor(REEL2_HASH) },
      ],
      brandReelArtifact: { descriptor: unverifiedDescriptor(BRAND_HASH) },
    }),
  );
  assert.equal(noneVerified.mediaStatus, "no_media");

  const partial = createMediaPackageManifest(
    manifestInput({
      brandReelArtifact: { descriptor: unverifiedDescriptor(BRAND_HASH) },
    }),
  );
  assert.equal(partial.mediaStatus, "partial_unverified");

  const all = createMediaPackageManifest(manifestInput());
  assert.equal(all.mediaStatus, "verified");
});

test("worker success without inspection stays UNVERIFIED and can never read as verified", () => {
  // The producer reported success, but no real inspection result exists.
  const manifest = createMediaPackageManifest(
    manifestInput({ mainVideo: { descriptor: unverifiedDescriptor(MAIN_HASH) } }),
  );
  assert.equal(manifest.mainVideo.verificationState, "UNVERIFIED");
  assert.equal(manifest.mediaStatus, "partial_unverified");
  assert.equal(
    JSON.stringify(serializeMediaPackageManifest(manifest)).includes('"verified"'),
    false,
  );
});

// ---------------------------------------------------------------------------
// Fail-closed binding: counts, descriptors, scoping, types
// ---------------------------------------------------------------------------

test("package cardinality fails closed: main missing, wrong Reel counts, duplicate refs", () => {
  assert.throws(() => createMediaPackageManifest(manifestInput({ mainVideo: undefined })), /MANIFEST_MAIN_VIDEO_BINDING_INVALID/);
  assert.throws(() => createMediaPackageManifest(manifestInput({ mainVideo: {} })), /MANIFEST_MAIN_VIDEO_BINDING_INVALID/);
  assert.throws(() => createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: { descriptorType: "forged" } } })), /MANIFEST_MAIN_VIDEO_BINDING_INVALID/);
  assert.throws(() => createMediaPackageManifest(manifestInput({ contentReelArtifacts: [] })), /MANIFEST_CONTENT_REEL_COUNT/);
  assert.throws(() => createMediaPackageManifest(manifestInput({ contentReelArtifacts: [{ descriptor: verifiedDescriptor(REEL1_HASH) }] })), /MANIFEST_CONTENT_REEL_COUNT/);
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({
          contentReelArtifacts: [
            { descriptor: verifiedDescriptor(REEL1_HASH) },
            { descriptor: verifiedDescriptor(REEL1_HASH) },
          ],
        }),
      ),
    /MANIFEST_CONTENT_REEL_DUPLICATE/,
  );
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({ brandReelArtifact: { descriptor: verifiedDescriptor(REEL1_HASH) } }),
      ),
    /MANIFEST_BRAND_REEL_DUPLICATE/,
  );
  assert.throws(() => createMediaPackageManifest(manifestInput({ brandReelArtifact: undefined })), /MANIFEST_BRAND_REEL_BINDING_INVALID/);
});

test("binding accepts only real descriptor identities; hand-forged refs fail closed", () => {
  // A descriptor whose contentSha256 field was mutated after the fact cannot
  // produce a valid sha256 reference and must fail closed.
  const forged = verifiedDescriptor(MAIN_HASH);
  const tamperedRef = { ...forged, contentSha256: "not-a-hash" };
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: tamperedRef } })),
    /MANIFEST_MAIN_VIDEO_BINDING_INVALID/,
  );
  // Hand-forged verification states (anything but UNVERIFIED/VERIFIED) fail closed.
  const handForged = { ...verifiedDescriptor(MAIN_HASH), verification: { state: "QUANTUM_VERIFIED", inspectedBy: null, inspectedAt: null, reasonCode: null } };
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: handForged } })),
    /MANIFEST_MAIN_VIDEO_BINDING_INVALID/,
  );
  // VERIFIED with a lingering reasonCode is contradictory — fail closed.
  const contradictory = { ...verifiedDescriptor(MAIN_HASH), verification: { ...verifiedDescriptor(MAIN_HASH).verification, reasonCode: "SOMETHING" } };
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: contradictory } })),
    /MANIFEST_MAIN_VIDEO_BINDING_INVALID/,
  );
  // Unknown fields on a binding entry fail closed.
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: verifiedDescriptor(MAIN_HASH), surprise: 1 } })),
    /MANIFEST_MAIN_VIDEO_FIELD_UNKNOWN/,
  );
});

test("cross-Director producers fail closed with the isolation code", () => {
  // agent-02 is another registered Director; its artifacts can never bind here.
  const foreign = verifiedDescriptor(MAIN_HASH, { producer: producer({ agentId: "agent-02" }) });
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: foreign } })),
    /MANIFEST_ARTIFACT_CROSS_DIRECTOR/,
  );
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({
          contentReelArtifacts: [
            { descriptor: verifiedDescriptor(REEL1_HASH, { producer: producer({ agentId: "agent-02" }) }) },
            { descriptor: verifiedDescriptor(REEL2_HASH) },
          ],
        }),
      ),
    /MANIFEST_ARTIFACT_CROSS_DIRECTOR/,
  );
});

test("foreign-run bindings fail closed with MANIFEST_ARTIFACT_RUN_MISMATCH", () => {
  const foreignRun = verifiedDescriptor(MAIN_HASH, { producer: producer({ runId: OTHER_RUN_ID }) });
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: foreignRun } })),
    /MANIFEST_ARTIFACT_RUN_MISMATCH/,
  );
});

test("artifact-type mismatch fails closed: a thumbnail cannot bind as the main video", () => {
  const thumbnail = verifiedDescriptor(THUMBNAIL_HASH, {
    artifactType: "thumbnail",
    mimeType: "image/png",
    durationSeconds: null,
  });
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: thumbnail } })),
    /MANIFEST_ARTIFACT_TYPE_MISMATCH/,
  );
  const subtitle = verifiedDescriptor(SUBTITLE_HASH, {
    artifactType: "subtitle",
    mimeType: "text/vtt",
    durationSeconds: null,
  });
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({ contentReelArtifacts: [{ descriptor: subtitle }, { descriptor: verifiedDescriptor(REEL2_HASH) }] }),
      ),
    /MANIFEST_ARTIFACT_TYPE_MISMATCH/,
  );
});

// ---------------------------------------------------------------------------
// Reel-package integrity + integration authority
// ---------------------------------------------------------------------------

test("tampered reel package fails closed; valid package binds with scope checks", () => {
  const pkg = reelPackage();
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ reelPackage: { ...pkg, brandIntegrationMode: "INTEGRATED" } })),
    /MANIFEST_REEL_PACKAGE_TAMPERED/,
  );
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ reelPackage: { planType: "not_a_reel_package" } })),
    /MANIFEST_REEL_PACKAGE_INVALID/,
  );
  // A coherent reel package built for a DIFFERENT run cannot bind here.
  const foreignRunPkg = createReelPackagePlan({
    agentId: AGENT_ID,
    productionRunId: OTHER_RUN_ID,
    contentReels: [contentA({ productionRunId: OTHER_RUN_ID }), contentB({ productionRunId: OTHER_RUN_ID })],
    brandReel: brand({ productionRunId: OTHER_RUN_ID }),
    brandIntegrationMode: "STANDALONE_ONLY",
  });
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ reelPackage: foreignRunPkg })),
    /MANIFEST_REEL_PACKAGE_SCOPE_MISMATCH/,
  );
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ reelPackage: reelPackage({ agentId: "agent-02" }) })),
    /REEL_PACKAGE_SCOPE_MISMATCH|MANIFEST_REEL_PACKAGE_SCOPE_MISMATCH/,
  );
});

test("INTEGRATED manifest requires the run-authorized integration artifact; mismatches fail closed", () => {
  const authorization = { authorizationRef: "auth-001", boundRunId: RUN_ID };
  const integratedPkg = reelPackage({
    brandIntegrationMode: "INTEGRATED",
    ownerAuthorization: authorization,
    mainVideoIntegration: { artifactRef: `sha256:${INTEGRATION_HASH}` },
  });
  // Missing binding entirely.
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ reelPackage: integratedPkg })),
    /MANIFEST_INTEGRATION_BINDING_REQUIRED/,
  );
  // Bound artifact does not match the package's authorized reference.
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({ reelPackage: integratedPkg, mainVideoIntegrationArtifact: { descriptor: verifiedDescriptor(SUBTITLE_HASH) } }),
      ),
    /MANIFEST_INTEGRATION_ARTIFACT_MISMATCH/,
  );
  // Matching artifact binds; mode + integration carried through truthfully.
  const manifest = createMediaPackageManifest(
    manifestInput({ reelPackage: integratedPkg, mainVideoIntegrationArtifact: { descriptor: verifiedDescriptor(INTEGRATION_HASH) } }),
  );
  assert.equal(manifest.brandIntegrationMode, "INTEGRATED");
  assert.equal(manifest.mainVideoIntegration.artifactRef, `sha256:${INTEGRATION_HASH}`);
  assert.equal(verifyMediaPackageManifest(manifest).intact, true);
});

test("integration artifact duplicating a bound package artifact fails closed", () => {
  const authorization = { authorizationRef: "auth-001", boundRunId: RUN_ID };
  const integratedPkg = reelPackage({
    brandIntegrationMode: "INTEGRATED",
    ownerAuthorization: authorization,
    mainVideoIntegration: { artifactRef: `sha256:${REEL1_HASH}` },
  });
  // Package would reject reusing the brand Reel's segment, so authorize the
  // reel-1 hash here only to test the manifest-level duplicate gate.
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({ reelPackage: integratedPkg, mainVideoIntegrationArtifact: { descriptor: verifiedDescriptor(REEL1_HASH) } }),
      ),
    /MANIFEST_INTEGRATION_ARTIFACT_MISMATCH|MANIFEST_INTEGRATION_ARTIFACT_DUPLICATE/,
  );
});

test("integration material supplied for a STANDALONE package fails closed", () => {
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({ mainVideoIntegrationArtifact: { descriptor: verifiedDescriptor(INTEGRATION_HASH) } }),
      ),
    /MANIFEST_INTEGRATION_CONFLICT/,
  );
});

// ---------------------------------------------------------------------------
// Optional entries: subtitles, thumbnails, metadata
// ---------------------------------------------------------------------------

test("optional entries bind with labels; secrets, internal names, and unknown fields fail closed", () => {
  const manifest = createMediaPackageManifest(
    manifestInput({
      subtitles: [{ descriptor: verifiedDescriptor(SUBTITLE_HASH, { artifactType: "subtitle", mimeType: "text/vtt", durationSeconds: null }), label: "en", entryNote: "timed narration track" }],
      thumbnailPlans: [{ descriptor: verifiedDescriptor(THUMBNAIL_HASH, { artifactType: "thumbnail", mimeType: "image/png", durationSeconds: null }) }],
      metadataEntries: [{ descriptor: verifiedDescriptor(contentHash("metadata"), { artifactType: "metadata", mimeType: "application/json", durationSeconds: null }) }],
    }),
  );
  assert.equal(manifest.subtitles.length, 1);
  assert.equal(manifest.subtitles[0].label, "en");
  assert.equal(manifest.thumbnailPlans[0].label, "thumbnail"); // default label
  assert.equal(manifest.metadataEntries[0].label, "metadata");
  assert.equal(manifest.mediaStatus, "verified");
  assert.equal(verifyMediaPackageManifest(manifest).intact, true);

  // Secret-like free text fails closed (Rule 17).
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({
          subtitles: [{ descriptor: verifiedDescriptor(SUBTITLE_HASH, { artifactType: "subtitle", mimeType: "text/vtt", durationSeconds: null }), entryNote: "see vault://x for key" }],
        }),
      ),
    /MANIFEST_SECRET_REJECTED/,
  );
  // Internal agent names in free text fail closed (Rule 15).
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({
          subtitles: [{ descriptor: verifiedDescriptor(SUBTITLE_HASH, { artifactType: "subtitle", mimeType: "text/vtt", durationSeconds: null }), entryNote: "a production for NEWTON" }],
        }),
      ),
    /MANIFEST_INTERNAL_NAME_REJECTED/,
  );
  // Unknown fields fail closed.
  assert.throws(
    () =>
      createMediaPackageManifest(
        manifestInput({
          subtitles: [{ descriptor: verifiedDescriptor(SUBTITLE_HASH, { artifactType: "subtitle", mimeType: "text/vtt", durationSeconds: null }), extra: true }],
        }),
      ),
    /MANIFEST_SUBTITLE_FIELD_UNKNOWN/,
  );
});

test("optional entry limits and scoping still apply to subtitles/thumbnails/metadata", () => {
  const make = (hash, producerOverrides = {}) =>
    verifiedDescriptor(hash, { artifactType: "subtitle", mimeType: "text/vtt", durationSeconds: null, producer: producer(producerOverrides) });
  const tooMany = Array.from({ length: 13 }, (_, i) => ({ descriptor: make(contentHash(`sub-${i}`)) }));
  assert.throws(() => createMediaPackageManifest(manifestInput({ subtitles: tooMany })), /MANIFEST_SUBTITLE_BINDING_INVALID/);
  const foreignRunDescriptor = make(contentHash("foreign-sub"), { runId: OTHER_RUN_ID });
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ thumbnailPlans: [{ descriptor: foreignRunDescriptor }] })),
    /MANIFEST_ARTIFACT_RUN_MISMATCH/,
  );
});

// ---------------------------------------------------------------------------
// Identity, determinism, tamper matrix
// ---------------------------------------------------------------------------

test("manifest identity is deterministic; identical inputs produce identical ids", () => {
  const a = createMediaPackageManifest(manifestInput());
  const b = createMediaPackageManifest(manifestInput());
  assert.equal(a.id, b.id);
  assert.equal(computeMediaPackageManifestId(a), a.id);
  assert.equal(detectMediaPackageManifestTampering(a, b).tampered, false);
  assert.equal(JSON.stringify(serializeMediaPackageManifest(a)), JSON.stringify(serializeMediaPackageManifest(b)));
});

test("tamper matrix: every bound-artifact substitution or field mutation is detected", () => {
  // A PARTIAL manifest is the base so "upgrades" are real content changes.
  const original = createMediaPackageManifest(
    manifestInput({ brandReelArtifact: { descriptor: unverifiedDescriptor(BRAND_HASH) } }),
  );
  assert.equal(original.mediaStatus, "partial_unverified");
  const cases = [
    ["main video artifact swapped", (m) => ({ ...m, mainVideo: { ...m.mainVideo, artifactRef: `sha256:${INTEGRATION_HASH}` } })],
    ["content reel artifact swapped", (m) => ({ ...m, contentReelArtifacts: [m.contentReelArtifacts[0], { ...m.contentReelArtifacts[1], artifactRef: `sha256:${INTEGRATION_HASH}` } ] })],
    ["brand reel artifact swapped", (m) => ({ ...m, brandReelArtifact: { ...m.brandReelArtifact, artifactRef: `sha256:${INTEGRATION_HASH}` } })],
    ["mediaStatus forged", (m) => ({ ...m, mediaStatus: "verified" })],
    ["run id mutated", (m) => ({ ...m, productionRunId: OTHER_RUN_ID })],
    ["agent mutated", (m) => ({ ...m, agentId: "agent-02" })],
    ["publication status mutated", (m) => ({ ...m, publication: { status: "requested" } })],
    ["verification state upgraded", (m) => ({ ...m, brandReelArtifact: { ...m.brandReelArtifact, verificationState: "VERIFIED" } })],
    ["reel package link mutated", (m) => ({ ...m, reelPackageId: "0".repeat(64) })],
    ["descriptor fingerprint mutated", (m) => ({ ...m, mainVideo: { ...m.mainVideo, descriptorFingerprint: "0".repeat(64) } })],
  ];
  for (const [label, mutate] of cases) {
    const candidate = mutate(original);
    const report = detectMediaPackageManifestTampering(original, candidate);
    assert.equal(report.tampered, true, `tamper case "${label}" must be detected`);
    const integrity = verifyMediaPackageManifest(candidate);
    assert.equal(integrity.reason, "MANIFEST_ID_MISMATCH", `integrity gate must reject "${label}"`);
  }
  // An added bound artifact is also tampering.
  const added = { ...original, subtitles: [{ ...original.mainVideo, label: "extra" }] };
  assert.equal(detectMediaPackageManifestTampering(original, added).tampered, true);
  // A removed bound artifact is also tampering.
  const removed = { ...original, metadataEntries: [] };
  assert.equal(detectMediaPackageManifestTampering(original, removed).tampered, false, "empty-vs-empty optionals are content-equal");
  const withMetadata = createMediaPackageManifest(
    manifestInput({ metadataEntries: [{ descriptor: verifiedDescriptor(contentHash("meta-x"), { artifactType: "metadata", mimeType: "application/json", durationSeconds: null }) }] }),
  );
  assert.equal(detectMediaPackageManifestTampering(withMetadata, withMetadata).tampered, false);
  assert.equal(detectMediaPackageManifestTampering(withMetadata, removed).tampered, true, "removing a bound artifact must be detected");
});

test("bound entries carry the descriptor fingerprint of the exact bound descriptor", () => {
  const descriptor = verifiedDescriptor(MAIN_HASH);
  const manifest = createMediaPackageManifest(manifestInput({ mainVideo: { descriptor } }));
  assert.equal(manifest.mainVideo.descriptorFingerprint, descriptorFingerprint(descriptor));
  // A mutated descriptor yields a different fingerprint — substitution is visible.
  const other = verifiedDescriptor(MAIN_HASH, { durationSeconds: 2400 });
  const otherManifest = createMediaPackageManifest(manifestInput({ mainVideo: { descriptor: other } }));
  assert.notEqual(otherManifest.mainVideo.descriptorFingerprint, manifest.mainVideo.descriptorFingerprint);
});

test("caller-supplied id must be truthful — a forged id fails closed", () => {
  assert.throws(
    () => createMediaPackageManifest({ ...manifestInput(), id: "0".repeat(64) }),
    /MANIFEST_ID_MISMATCH/,
  );
  const truthful = createMediaPackageManifest(manifestInput());
  const rebuilt = createMediaPackageManifest({ ...manifestInput(), id: computeMediaPackageManifestId(createMediaPackageManifest(manifestInput())) });
  assert.equal(rebuilt.id, truthful.id);
});

// ---------------------------------------------------------------------------
// Serialization: strict allowlist (Rules 15/17)
// ---------------------------------------------------------------------------

test("serialization is a fixed-order allowlist; authorization refs and secrets never leak", () => {
  const authorization = { authorizationRef: "auth-001", boundRunId: RUN_ID };
  const integratedPkg = reelPackage({
    brandIntegrationMode: "INTEGRATED",
    ownerAuthorization: authorization,
    mainVideoIntegration: { artifactRef: `sha256:${INTEGRATION_HASH}` },
  });
  const manifest = createMediaPackageManifest(
    manifestInput({ reelPackage: integratedPkg, mainVideoIntegrationArtifact: { descriptor: verifiedDescriptor(INTEGRATION_HASH) } }),
  );
  const out = serializeMediaPackageManifest(manifest);
  const flat = JSON.stringify(out);
  assert.deepEqual(Object.keys(out), [
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
  assert.equal(flat.includes("auth-001"), false);
  assert.equal(Object.isFrozen(out), true);
  // Polluted extra keys are dropped by the allowlist (no leak).
  const polluted = serializeMediaPackageManifest({ ...manifest, credentialLocator: "vault://kms/x" });
  assert.equal(JSON.stringify(polluted).includes("vault://"), false);
  // Deletion of an allowlisted field fails the integrity gate.
  assert.throws(() => serializeMediaPackageManifest({ ...manifest, mainVideo: undefined }), /MANIFEST_ID_MISMATCH/);
  // Re-serialization is byte-identical.
  assert.equal(JSON.stringify(serializeMediaPackageManifest(manifest)), JSON.stringify(out));
});

test("serialized manifest never claims generation or publication", () => {
  const out = serializeMediaPackageManifest(createMediaPackageManifest(manifestInput()));
  assert.deepEqual(out.publication, { status: "not_requested" });
  assert.equal(Object.keys(out).includes("providerCalls"), false);
  assert.equal(Object.keys(out).includes("generatedAssets"), false);
});

test("manifest input rejects unknown top-level fields", () => {
  assert.throws(() => createMediaPackageManifest({ ...manifestInput(), brandIntegrationMode: "STANDALONE_ONLY" }), /MANIFEST_FIELD_UNKNOWN/);
  assert.throws(() => createMediaPackageManifest({ ...manifestInput(), ownerAuthorization: { authorizationRef: "x", boundRunId: RUN_ID } }), /MANIFEST_FIELD_UNKNOWN/);
});

// ---------------------------------------------------------------------------
// Extended tamper matrix + canonical identity (issue #152 review hardening)
// ---------------------------------------------------------------------------

test("an extra main-video binding is rejected: cardinality is structural, not just integrity", () => {
  // The manifest records exactly one main video; a second one cannot be
  // smuggled in via an optional list (which binds subtitle-type descriptors
  // only) nor via any other field (top-level fields are allowlisted).
  const extra = createMediaPackageManifest(manifestInput());
  assert.equal(extra.mainVideo.verificationState, "VERIFIED");
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ subtitles: [{ descriptor: verifiedDescriptor(MAIN_HASH) }] })),
    /MANIFEST_ARTIFACT_TYPE_MISMATCH/,
  );
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ thumbnailPlans: [{ descriptor: verifiedDescriptor(REEL1_HASH) }] })),
    /MANIFEST_ARTIFACT_TYPE_MISMATCH/,
  );
});

test("tamper matrix extension: thumbnail and integration binding mutations are detected", () => {
  const authorization = { authorizationRef: "auth-001", boundRunId: RUN_ID };
  const integratedPkg = reelPackage({
    brandIntegrationMode: "INTEGRATED",
    ownerAuthorization: authorization,
    mainVideoIntegration: { artifactRef: `sha256:${INTEGRATION_HASH}` },
  });
  const original = createMediaPackageManifest(
    manifestInput({
      reelPackage: integratedPkg,
      mainVideoIntegrationArtifact: { descriptor: verifiedDescriptor(INTEGRATION_HASH) },
      thumbnailPlans: [{ descriptor: verifiedDescriptor(THUMBNAIL_HASH, { artifactType: "thumbnail", mimeType: "image/png", durationSeconds: null }) }],
    }),
  );
  assert.equal(verifyMediaPackageManifest(original).intact, true);
  const cases = [
    ["thumbnail binding swapped", (m) => ({ ...m, thumbnailPlans: [{ ...m.thumbnailPlans[0], artifactRef: `sha256:${SUBTITLE_HASH}` }] })],
    ["thumbnail fingerprint mutated", (m) => ({ ...m, thumbnailPlans: [{ ...m.thumbnailPlans[0], descriptorFingerprint: "0".repeat(64) }] })],
    ["integration binding swapped", (m) => ({ ...m, mainVideoIntegration: { ...m.mainVideoIntegration, artifactRef: `sha256:${SUBTITLE_HASH}` } })],
    ["integration fingerprint mutated", (m) => ({ ...m, mainVideoIntegration: { ...m.mainVideoIntegration, descriptorFingerprint: "0".repeat(64) } })],
    ["integration removed", (m) => ({ ...m, mainVideoIntegration: null })],
    ["integration downgraded to UNVERIFIED", (m) => ({ ...m, mainVideoIntegration: { ...m.mainVideoIntegration, verificationState: "UNVERIFIED" } })],
    ["integration note mutated", (m) => ({ ...m, mainVideoIntegration: { ...m.mainVideoIntegration, entryNote: "different note" } })],
  ];
  for (const [label, mutate] of cases) {
    const candidate = mutate(original);
    const report = detectMediaPackageManifestTampering(original, candidate);
    assert.equal(report.tampered, true, `tamper case "${label}" must be detected`);
    assert.equal(verifyMediaPackageManifest(candidate).intact, false, `integrity gate must reject "${label}"`);
  }
});

test("canonical identity is key-order invariant; arrays stay order-sensitive", () => {
  // Same content, different insertion order — identity must be identical.
  const reordered = {};
  for (const key of ["metadataEntries", "brandReelArtifact", "contentReelArtifacts", "mainVideo", "reelPackage", "productionRunId", "agentId"].reverse()) {
    const built = manifestInput();
    reordered[key] = built[key];
  }
  const a = createMediaPackageManifest(manifestInput());
  const b = createMediaPackageManifest(reordered);
  assert.equal(a.id, b.id);
  assert.equal(computeMediaPackageManifestId(a), computeMediaPackageManifestId(b));
  // Array order IS semantically meaningful: swapping the two Reels changes identity.
  const swapped = createMediaPackageManifest(
    manifestInput({ contentReelArtifacts: [manifestInput().contentReelArtifacts[1], manifestInput().contentReelArtifacts[0]] }),
  );
  assert.notEqual(a.id, swapped.id);
});

test("unsafe free text (raw paths, shell metacharacters) fails closed everywhere", () => {
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ productionRunId: "/etc/shadow" })),
    /MANIFEST_UNSAFE_TEXT_REJECTED/,
  );
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ productionRunId: "run; rm -rf /" })),
    /MANIFEST_UNSAFE_TEXT_REJECTED/,
  );
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ subtitles: [{ descriptor: verifiedDescriptor(SUBTITLE_HASH, { artifactType: "subtitle", mimeType: "text/vtt", durationSeconds: null }), entryNote: "see /var/secrets/key.txt for details" }] })),
    /MANIFEST_UNSAFE_TEXT_REJECTED/,
  );
  // backtick command substitution is never valid note text
  assert.throws(
    () => createMediaPackageManifest(manifestInput({ productionRunId: "run-`id`-x" })),
    /MANIFEST_UNSAFE_TEXT_REJECTED/,
  );
});

test("production-ready gate: only a fully verified manifest with intact identity is ready", () => {
  const ready = isMediaPackageProductionReady(createMediaPackageManifest(manifestInput()));
  assert.deepEqual(ready, { ready: true, reason: null });

  // Unverified media is never production-ready, regardless of worker claims.
  const partial = createMediaPackageManifest(
    manifestInput({ brandReelArtifact: { descriptor: unverifiedDescriptor(BRAND_HASH) } }),
  );
  assert.deepEqual(isMediaPackageProductionReady(partial), { ready: false, reason: "MEDIA_STATUS_NOT_VERIFIED" });

  // Tampered identity is never production-ready.
  const forged = { ...createMediaPackageManifest(manifestInput()), mediaStatus: "verified", id: "0".repeat(64) };
  assert.deepEqual(isMediaPackageProductionReady(forged), { ready: false, reason: "MANIFEST_ID_MISMATCH" });

  // Unknown brand mode and mutated publication state fail truthfully. Field
  // mutations break the recomputed identity first, so these cases rebuild the
  // id after mutation — the gate must STILL reject on the semantic violation.
  const forgedMode = { ...createMediaPackageManifest(manifestInput()), brandIntegrationMode: "SPONSORED_AUTO" };
  forgedMode.id = computeMediaPackageManifestId(forgedMode);
  assert.deepEqual(isMediaPackageProductionReady(forgedMode), { ready: false, reason: "BRAND_MODE_INVALID" });
  const forgedPublication = { ...createMediaPackageManifest(manifestInput()), publication: { status: "requested" } };
  forgedPublication.id = computeMediaPackageManifestId(forgedPublication);
  assert.deepEqual(isMediaPackageProductionReady(forgedPublication), { ready: false, reason: "PUBLICATION_STATE_INVALID" });

  // Full plan: zero verified bindings → no_media, and never ready.
  const plannedOnly = createMediaPackageManifest(
    manifestInput({
      mainVideo: { descriptor: unverifiedDescriptor(MAIN_HASH) },
      contentReelArtifacts: [
        { descriptor: unverifiedDescriptor(REEL1_HASH) },
        { descriptor: unverifiedDescriptor(REEL2_HASH) },
      ],
      brandReelArtifact: { descriptor: unverifiedDescriptor(BRAND_HASH) },
    }),
  );
  assert.equal(plannedOnly.mediaStatus, "no_media");
  assert.equal(isMediaPackageProductionReady(plannedOnly).ready, false);
});

test("serialized bindings are individually allowlisted; polluted inner fields never leak", () => {
  const manifest = createMediaPackageManifest(manifestInput());
  const polluted = {
    ...manifest,
    mainVideo: { ...manifest.mainVideo, rawPath: "/media/secret/file.mp4", providerPayload: { key: "x" } },
    contentReelArtifacts: [{ ...manifest.contentReelArtifacts[0], internalLocator: "vault://kms/leak" }, manifest.contentReelArtifacts[1]],
  };
  const out = serializeMediaPackageManifest(polluted);
  const flat = JSON.stringify(out);
  assert.equal(flat.includes("rawPath"), false);
  assert.equal(flat.includes("providerPayload"), false);
  assert.equal(flat.includes("internalLocator"), false);
  assert.equal(flat.includes("vault://"), false);
  // The polluted rebuild still passes integrity (identity ignores extra keys)
  // and serialization is still byte-identical to the clean one.
  assert.equal(JSON.stringify(out), JSON.stringify(serializeMediaPackageManifest(manifest)));
});

test("descriptor-id/content-hash mutation on a bound artifact is detected", () => {
  const original = createMediaPackageManifest(manifestInput());
  const candidate = createMediaPackageManifest(
    manifestInput({ mainVideo: { descriptor: verifiedDescriptor(MAIN_HASH, { durationSeconds: 2600 }) } }),
  );
  assert.equal(detectMediaPackageManifestTampering(original, candidate).tampered, true);
  // And swapping the artifactRef while keeping the fingerprint consistent is
  // also caught (both fields are bound into identity).
  const refSwap = { ...original, mainVideo: { ...original.mainVideo, artifactRef: `sha256:${INTEGRATION_HASH}` } };
  assert.equal(verifyMediaPackageManifest(refSwap).intact, false);
});
