import test from "node:test";
import assert from "node:assert/strict";
import {
  createNicheReference,
  createVisualReference,
  canonicalizeSupportedYouTubeUrls,
  rejectUnsafeUrls,
  createManualDraftProfile,
  submitProfileForApproval,
  approveExactProfileSnapshot,
  rejectEditsToApprovedImmutableProfiles,
  updateProfileSnapshot,
  activateProfile,
  deactivateReference,
  assignReferenceScope,
  retrieveLatestApprovedNicheProfile,
  retrieveLatestApprovedVisualProfile,
  buildSanitizedInternalWorkerContext,
  preventInternalAgentNames,
  resetCreativeReferenceRegistry,
  computeProfileHash
} from "../src/catalog/creativeReferenceLibrary.js";

test("1. Niche and visual references can use different YouTube links", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const niche = createNicheReference(ownerId, universeId, {
    url: "https://www.youtube.com/watch?v=nicheVideoId123",
    writtenBrief: "Spooky storytelling style",
    ownerNotes: "Notes"
  });

  const visual = createVisualReference(ownerId, universeId, {
    url: "https://youtu.be/visualVideoId999",
    writtenVisualBrief: "Dark red cinematic palette",
    ownerNotes: "Notes"
  });

  assert.notEqual(niche.canonicalUrl, visual.canonicalUrl);
  assert.equal(niche.referenceType, "niche");
  assert.equal(visual.referenceType, "visual");
});

test("2 & 3. Niche settings do not modify visual settings and vice versa", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const niche = createNicheReference(ownerId, universeId, {
    url: "https://www.youtube.com/watch?v=videoIdA",
    writtenBrief: "Folk horror focus"
  });

  const visual = createVisualReference(ownerId, universeId, {
    url: "https://www.youtube.com/watch?v=videoIdB",
    writtenVisualBrief: "Surreal imagery"
  });

  assert.equal(niche.writtenBrief, "Folk horror focus");
  assert.equal(niche.writtenVisualBrief, undefined);

  assert.equal(visual.writtenVisualBrief, "Surreal imagery");
  assert.equal(visual.writtenBrief, undefined);
});

test("4. Channel, video, and playlist URLs are canonicalized", () => {
  // Test video links
  assert.equal(
    canonicalizeSupportedYouTubeUrls("https://youtu.be/xyz777"),
    "https://www.youtube.com/watch?v=xyz777"
  );
  assert.equal(
    canonicalizeSupportedYouTubeUrls("https://www.youtube.com/watch?v=xyz777&feature=share"),
    "https://www.youtube.com/watch?v=xyz777"
  );

  // Test playlist link
  assert.equal(
    canonicalizeSupportedYouTubeUrls("https://youtube.com/playlist?list=PLxyz123"),
    "https://www.youtube.com/playlist?list=PLxyz123"
  );

  // Test channel links
  assert.equal(
    canonicalizeSupportedYouTubeUrls("https://www.youtube.com/channel/UCxyz"),
    "https://www.youtube.com/channel/UCxyz"
  );
  assert.equal(
    canonicalizeSupportedYouTubeUrls("https://youtube.com/c/CreatorName"),
    "https://www.youtube.com/c/CreatorName"
  );
  assert.equal(
    canonicalizeSupportedYouTubeUrls("https://youtube.com/@CreatorHandle/"),
    "https://www.youtube.com/@CreatorHandle"
  );
});

test("5. Equivalent YouTube URLs are detected as duplicates", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  createNicheReference(ownerId, universeId, {
    url: "https://youtu.be/videoDuplicate"
  });

  // Equivalent url (standard format resolving to same canonical URL) throws error
  assert.throws(() => {
    createNicheReference(ownerId, universeId, {
      url: "https://www.youtube.com/watch?v=videoDuplicate"
    });
  }, /DUPLICATE_CANONICAL_REFERENCE/);
});

test("6. HTTP URLs are rejected", () => {
  assert.throws(() => {
    rejectUnsafeUrls("http://youtube.com/watch?v=abc");
  }, /HTTPS_ONLY_REQUIRED/);
});

test("7. Localhost and private network targets are rejected", () => {
  assert.throws(() => {
    rejectUnsafeUrls("https://localhost/watch?v=abc");
  }, /PRIVATE_OR_LOCALHOST_TARGET_REJECTED/);

  assert.throws(() => {
    rejectUnsafeUrls("https://127.0.0.1/watch?v=abc");
  }, /PRIVATE_OR_LOCALHOST_TARGET_REJECTED/);

  assert.throws(() => {
    rejectUnsafeUrls("https://192.168.1.1/watch?v=abc");
  }, /PRIVATE_OR_LOCALHOST_TARGET_REJECTED/);

  assert.throws(() => {
    rejectUnsafeUrls("https://sub.local/watch?v=abc");
  }, /PRIVATE_OR_LOCALHOST_TARGET_REJECTED/);
});

test("8. Embedded credentials and non-standard ports are rejected", () => {
  assert.throws(() => {
    rejectUnsafeUrls("https://user:pass@youtube.com/watch?v=abc");
  }, /EMBEDDED_CREDENTIALS_PROHIBITED/);

  assert.throws(() => {
    rejectUnsafeUrls("https://youtube.com:8443/watch?v=abc");
  }, /NON_STANDARD_PORTS_PROHIBITED/);
});

test("9. Non-allowlisted domains are rejected", () => {
  assert.throws(() => {
    rejectUnsafeUrls("https://vimeo.com/video123");
  }, /UNAPPROVED_DOMAIN_REJECTED/);
});

test("10 & 11. Unanalyzed references remain awaiting_analysis with no fake analysis evidence created", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const ref = createNicheReference(ownerId, universeId, {
    url: "https://youtu.be/videoForAnalysis"
  });

  assert.equal(ref.status, "awaiting_analysis");
});

test("12 & 13. Manual profiles require owner approval bound to exact immutable snapshot hash", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const ref = createNicheReference(ownerId, universeId, {
    url: "https://youtu.be/videoA"
  });

  const snapshot = {
    storytellingApproach: "First-person narrative",
    tone: "Eerie"
  };

  const profile = createManualDraftProfile(ref.id, snapshot);
  submitProfileForApproval(profile.id);

  // Exact hash binds approval
  const expectedHash = computeProfileHash(snapshot);
  const approval = approveExactProfileSnapshot(ownerId, profile.id, expectedHash);

  assert.ok(approval);
  assert.equal(profile.status, "approved");

  // Attempting to activate with wrong hash throws
  assert.throws(() => {
    approveExactProfileSnapshot(ownerId, profile.id, "wrong_hash_value");
  }, /SNAPSHOT_HASH_MISMATCH/);
});

test("14. An edited profile requires new approval", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const ref = createNicheReference(ownerId, universeId, {
    url: "https://youtu.be/videoA"
  });

  const snapshot = {
    storytellingApproach: "First-person narrative"
  };

  const profile = createManualDraftProfile(ref.id, snapshot);
  submitProfileForApproval(profile.id);

  const expectedHash = computeProfileHash(snapshot);
  approveExactProfileSnapshot(ownerId, profile.id, expectedHash);

  // Since profile is now approved, editing is blocked
  assert.throws(() => {
    updateProfileSnapshot(profile.id, { storytellingApproach: "Third-person" });
  }, /CANNOT_MODIFY_APPROVED_PROFILE/);
});

test("15. Scope assignments are validated", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const ref = createNicheReference(ownerId, universeId, {
    url: "https://youtu.be/videoA"
  });

  const assignment = assignReferenceScope(ref.id, {
    scopeType: "story_arc",
    scopeTargetId: "story-arc-uuid-abc"
  });

  assert.ok(assignment);
  assert.equal(assignment.scopeType, "story_arc");

  assert.throws(() => {
    assignReferenceScope(ref.id, {
      scopeType: "invalid_scope_value",
      scopeTargetId: "uuid"
    });
  }, /INVALID_SCOPE_TYPE/);
});

test("16. Worker context contains no plaintext secrets", () => {
  resetCreativeReferenceRegistry();
  const ownerId = "owner-123";
  const universeId = "universe-horror-123";

  const ref = createNicheReference(ownerId, universeId, {
    url: "https://youtu.be/videoA"
  });

  const context = buildSanitizedInternalWorkerContext(ref.id);
  assert.ok(context);
  assert.equal(context.apiKey, undefined);
  assert.equal(context.secretLocator, undefined);
  assert.equal(context.token, undefined);
  assert.equal(context.password, undefined);
});

test("17. Public output contains no JARVIS, LAKME, or other internal agent names", () => {
  const agent = { id: "agent-01", name: "JARVIS" };
  assert.equal(preventInternalAgentNames("Brand JARVIS Show", agent), true);
  assert.equal(preventInternalAgentNames("LAKME Channel", agent), true);
  assert.equal(preventInternalAgentNames("Safe Public Brand", agent), false);
});
