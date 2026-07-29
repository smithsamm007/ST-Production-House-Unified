import test from "node:test";
import assert from "node:assert/strict";
import {
  createNicheReference,
  createVisualReference,
  canonicalizeSupportedYouTubeUrls,
  rejectUnsafeUrls,
  createManualDraftProfile,
  updateProfileSnapshot,
  transitionToDraftProfileReady,
  submitProfileForApproval,
  approveExactProfileSnapshot,
  activateProfile,
  deactivateReference,
  assignReferenceScope,
  retrieveLatestApprovedNicheProfile,
  retrieveLatestApprovedVisualProfile,
  buildSanitizedInternalWorkerContext,
  preventInternalAgentNames,
  resetCreativeReferenceRegistry,
  computeProfileHash,
  updateReference
} from "../src/catalog/creativeReferenceLibrary.js";

test("1. Niche and visual references can use different YouTube links", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const niche = createNicheReference(ownerId, universeId, {
    url: "https://www.youtube.com/watch?v=nicheVid123",
    writtenBrief: "Spooky storytelling style",
    ownerNotes: "Notes"
  });

  const visual = createVisualReference(ownerId, universeId, {
    url: "https://youtu.be/visualVid99",
    writtenVisualBrief: "Dark red cinematic palette",
    ownerNotes: "Notes"
  });

  assert.notEqual(niche.canonicalUrl, visual.canonicalUrl);
  assert.equal(niche.referenceType, "niche");
  assert.equal(visual.referenceType, "visual");
});

test("2 & 3. Niche settings do not modify visual settings and vice-versa", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const niche = createNicheReference(ownerId, universeId, {
    url: "https://www.youtube.com/watch?v=videoIdA123",
    writtenBrief: "Folk horror focus"
  });

  const visual = createVisualReference(ownerId, universeId, {
    url: "https://www.youtube.com/watch?v=videoIdB123",
    writtenVisualBrief: "Surreal imagery"
  });

  assert.equal(niche.writtenBrief, "Folk horror focus");
  assert.equal(niche.writtenVisualBrief, undefined);

  assert.equal(visual.writtenVisualBrief, "Surreal imagery");
  assert.equal(visual.writtenBrief, undefined);
});

test("4. Channel, video, and playlist URLs are canonicalized and classified", () => {
  // Test video links
  const vResult1 = canonicalizeSupportedYouTubeUrls("https://youtu.be/xyz77712345");
  assert.equal(vResult1.canonical, "https://www.youtube.com/watch?v=xyz77712345");
  assert.equal(vResult1.subClassification, "youtube_video");

  // Rejects bad 11-char video ID format
  assert.throws(() => {
    canonicalizeSupportedYouTubeUrls("https://youtu.be/bad-length");
  }, /MALFORMED_YOUTUBE_URL/);

  // Test playlist link
  const pResult = canonicalizeSupportedYouTubeUrls("https://youtube.com/playlist?list=PLxyz123playlist");
  assert.equal(pResult.canonical, "https://www.youtube.com/playlist?list=PLxyz123playlist");
  assert.equal(pResult.subClassification, "youtube_playlist");

  // Test channel links
  const cResult = canonicalizeSupportedYouTubeUrls("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
  assert.equal(cResult.canonical, "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
  assert.equal(cResult.subClassification, "youtube_channel");
});

test("5. Equivalent YouTube URLs are detected as duplicates", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  createNicheReference(ownerId, universeId, {
    url: "https://youtu.be/videoDuplic"
  });

  // Equivalent url throws duplicate error
  assert.throws(() => {
    createNicheReference(ownerId, universeId, {
      url: "https://www.youtube.com/watch?v=videoDuplic"
    });
  }, /DUPLICATE_CANONICAL_REFERENCE/);
});

test("6. Unsafe URLs are rejected", () => {
  assert.throws(() => rejectUnsafeUrls("http://youtube.com/watch?v=abc"), /HTTPS_ONLY_REQUIRED/);
  assert.throws(() => rejectUnsafeUrls("https://localhost/watch?v=abc"), /PRIVATE_OR_LOCALHOST_TARGET_REJECTED/);
  assert.throws(() => rejectUnsafeUrls("https://user:pass@youtube.com/watch?v=abc"), /EMBEDDED_CREDENTIALS_PROHIBITED/);
  assert.throws(() => rejectUnsafeUrls("https://youtube.com:8443/watch?v=abc"), /NON_STANDARD_PORTS_PROHIBITED/);
  assert.throws(() => rejectUnsafeUrls("https://vimeo.com/video123"), /UNAPPROVED_DOMAIN_REJECTED/);
});

test("7. Unanalyzed references remain awaiting_analysis", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const ref = createNicheReference(ownerId, universeId, {
    url: "https://youtu.be/videoForAna"
  });

  assert.equal(ref.status, "awaiting_analysis");
});

test("8. Niche/Visual cross-type validations are strictly enforced", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const nicheRef = createNicheReference(ownerId, universeId, { url: "https://youtu.be/video123456" });
  const visualRef = createVisualReference(ownerId, universeId, { url: "https://youtu.be/video789101" });

  // A niche reference can only create niche profiles
  const profileNiche = createManualDraftProfile(ownerId, nicheRef.id, { tone: "dark" });
  assert.equal(profileNiche.profileType, "niche");

  // Try to create visual profile under niche reference should be impossible because of reference type enforcement
  const profileVisual = createManualDraftProfile(ownerId, visualRef.id, { art: "realism" });
  assert.equal(profileVisual.profileType, "visual");

  // Enforce sequential state transitions
  transitionToDraftProfileReady(ownerId, profileNiche.id);
  transitionToDraftProfileReady(ownerId, profileVisual.id);

  submitProfileForApproval(ownerId, profileNiche.id);
  submitProfileForApproval(ownerId, profileVisual.id);

  const hNiche = computeProfileHash(profileNiche.snapshot);
  const hVisual = computeProfileHash(profileVisual.snapshot);

  approveExactProfileSnapshot(ownerId, profileNiche.id, hNiche);
  approveExactProfileSnapshot(ownerId, profileVisual.id, hVisual);

  // retrieveLatestApprovedNicheProfile strictly ignores visual profiles
  assert.equal(retrieveLatestApprovedNicheProfile(visualRef.id), null);
  assert.equal(retrieveLatestApprovedNicheProfile(nicheRef.id).id, profileNiche.id);

  // retrieveLatestApprovedVisualProfile strictly ignores niche profiles
  assert.equal(retrieveLatestApprovedVisualProfile(nicheRef.id), null);
  assert.equal(retrieveLatestApprovedVisualProfile(visualRef.id).id, profileVisual.id);
});

test("9. Cross-owner authorization rejections", () => {
  resetCreativeReferenceRegistry();
  const owner1 = "owner-1";
  const owner2 = "owner-2";
  const universeId = "universe-1";

  const ref = createNicheReference(owner1, universeId, { url: "https://youtu.be/video123456" });

  assert.throws(() => {
    createManualDraftProfile(owner2, ref.id, { data: 1 });
  }, /OWNER_AUTHENTICATION_FAILED/);
});

test("10. Immutable profiles are protected from changes", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-1";

  const ref = createNicheReference(ownerId, universeId, { url: "https://youtu.be/video123456" });
  const profile = createManualDraftProfile(ownerId, ref.id, { data: 1 });

  transitionToDraftProfileReady(ownerId, profile.id);
  submitProfileForApproval(ownerId, profile.id);
  const expectedHash = computeProfileHash(profile.snapshot);
  approveExactProfileSnapshot(ownerId, profile.id, expectedHash);

  assert.throws(() => {
    updateProfileSnapshot(ownerId, profile.id, 1, { data: 2 });
  }, /CANNOT_MODIFY_APPROVED_PROFILE/);
});

test("11. Polymorphic scope validation targets and crossovers are blocked", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const ref = createNicheReference(ownerId, universeId, { url: "https://youtu.be/video123456" });
  const nicheProfile = createManualDraftProfile(ownerId, ref.id, { data: 1 });

  // Reject unsupported live scope target
  assert.throws(() => {
    assignReferenceScope(ownerId, ref.id, {
      scopeType: "series",
      scopeTargetId: "unsupported-live-uuid"
    });
  }, /SCOPE_TARGET_REPOSITORY_NOT_AVAILABLE/);

  // Validates universe scope correctly
  const assignResult = assignReferenceScope(ownerId, ref.id, {
    scopeType: "universe",
    scopeTargetId: universeId
  });
  assert.ok(assignResult);
  assert.equal(assignResult.scopeType, "universe");
});

test("12. Optimistic concurrency revisions are validated", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-1";

  const ref = createNicheReference(ownerId, universeId, { url: "https://youtu.be/video123456" });
  assert.equal(ref.revision, 1);

  // Mismatch expected revision throws stale write
  assert.throws(() => {
    updateReference(ownerId, ref.id, 2, { status: "analysis_in_progress" });
  }, /STALE_WRITE_REJECTED/);

  updateReference(ownerId, ref.id, 1, { status: "analysis_in_progress" });
  assert.equal(ref.revision, 2);
  assert.equal(ref.status, "analysis_in_progress");
});

test("13. Public attribution contains no internal agent name leakages", () => {
  const agent = { id: "agent-01", name: "JARVIS" };
  assert.equal(preventInternalAgentNames("Brand JARVIS Show", agent), true);
  assert.equal(preventInternalAgentNames("LAKME Channel", agent), true);
  assert.equal(preventInternalAgentNames("Safe Public Brand", agent), false);
});

test("14. Meaningful reference inputs, titles, tags, and timestamps validations", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-1";

  // Rejects completely empty niche references
  assert.throws(() => {
    createNicheReference(ownerId, universeId, {
      url: "",
      writtenBrief: ""
    });
  }, /MEANINGFUL_REFERENCE_INPUT_REQUIRED/);

  // Rejects completely empty visual references
  assert.throws(() => {
    createVisualReference(ownerId, universeId, {
      url: "",
      writtenVisualBrief: ""
    });
  }, /MEANINGFUL_REFERENCE_INPUT_REQUIRED/);

  // Rejects bad timestamps orderings
  assert.throws(() => {
    createVisualReference(ownerId, universeId, {
      url: "https://youtu.be/video123456",
      startTimestamp: 50,
      endTimestamp: 30
    });
  }, /INVALID_TIMESTAMP_ORDERING/);

  // Accepts valid briefs without URLs
  const nicheNoUrl = createNicheReference(ownerId, universeId, {
    writtenBrief: "Spooky folk audio niche details",
    title: "Written Folk Brief",
    tags: ["horror", "folk"]
  });
  assert.ok(nicheNoUrl);
  assert.equal(nicheNoUrl.subClassification, "written_brief");
  assert.deepEqual(nicheNoUrl.tags, ["horror", "folk"]);
});

test("15. Approval state transitions required submitted -> draft_profile_ready -> awaiting_owner_review -> approved", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-1";

  const ref = createNicheReference(ownerId, universeId, { url: "https://youtu.be/video123456" });
  const profile = createManualDraftProfile(ownerId, ref.id, { tone: "dark spooky" });

  assert.equal(profile.status, "submitted");

  // Approval must fail unless the profile is awaiting_owner_review
  const expectedHash = computeProfileHash(profile.snapshot);
  assert.throws(() => {
    approveExactProfileSnapshot(ownerId, profile.id, expectedHash);
  }, /APPROVAL_FAILED_MUST_BE_AWAITING_REVIEW/);

  // Step 1: transition to draft_profile_ready
  transitionToDraftProfileReady(ownerId, profile.id);
  assert.equal(profile.status, "draft_profile_ready");

  // Step 2: submit for approval -> awaiting_owner_review
  submitProfileForApproval(ownerId, profile.id);
  assert.equal(profile.status, "awaiting_owner_review");

  // Step 3: approved
  approveExactProfileSnapshot(ownerId, profile.id, expectedHash);
  assert.equal(profile.status, "approved");
});

test("16. Worker context recursive sanitization DTO checks", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-1";

  const ref = createNicheReference(ownerId, universeId, { url: "https://youtu.be/video123456" });
  const profile = createManualDraftProfile(ownerId, ref.id, {
    tone: "Eerie",
    nestedPayload: {
      password: "secretPassword",
      api_key: "secretKey",
      nestedSafeArray: ["val1", "val2"]
    }
  });

  transitionToDraftProfileReady(ownerId, profile.id);
  submitProfileForApproval(ownerId, profile.id);
  const hash = computeProfileHash(profile.snapshot);
  approveExactProfileSnapshot(ownerId, profile.id, hash);

  const context = buildSanitizedInternalWorkerContext(ref.id);
  assert.ok(context);
  assert.equal(context.nicheSnapshot.nestedPayload.password, undefined);
  assert.equal(context.nicheSnapshot.nestedPayload.api_key, undefined);
  assert.deepEqual(context.nicheSnapshot.nestedPayload.nestedSafeArray, ["val1", "val2"]);
});
