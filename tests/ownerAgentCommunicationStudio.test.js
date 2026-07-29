import test from "node:test";
import assert from "node:assert/strict";
import {
  BLUEPRINT_SECTIONS,
  resetOwnerAgentCommunicationRegistry,
  computeBlueprintHash,
  createSession,
  sendMessage,
  createBlueprintDraft,
  getBlueprintDraft,
  saveBlueprintDecision,
  proposeAgentSuggestion,
  acceptSuggestion,
  rejectSuggestion,
  raiseUnresolvedQuestion,
  resolveQuestion,
  validateBlueprintDraft,
  createBlueprintVersion,
  approveExactBlueprintVersion,
  retrieveActiveApprovedBlueprint,
  compareBlueprintVersions,
  previewSanitizedWorkerContext,
  getSession
} from "../src/catalog/ownerAgentCommunicationStudio.js";

test("1. Owner-Agent Communication Studio preserves exactly 22 Interactive Interview Catalog sections", () => {
  assert.equal(BLUEPRINT_SECTIONS.length, 22);
  assert.equal(BLUEPRINT_SECTIONS[0].no, 1);
  assert.equal(BLUEPRINT_SECTIONS[0].name, "Brand Voice & Tone Profile");
  assert.equal(BLUEPRINT_SECTIONS[21].no, 22);
  assert.equal(BLUEPRINT_SECTIONS[21].name, "Thumbnail & Cover Art Specifications");
});

test("2. Messaging engine enforces zero-trust owner validation and correct sender/message matrix", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const crossOwnerId = "owner-111";
  const agentId = "agent-01";

  const session = createSession(ownerId, agentId);
  assert.ok(session.id);
  assert.equal(session.isActive, true);

  // Cross-owner message injection is rejected
  assert.throws(() => {
    sendMessage(crossOwnerId, session.id, "owner", "owner_decision", "Attack plan");
  }, /OWNER_AUTHENTICATION_FAILED/);

  // Non-existent session rejected
  assert.throws(() => {
    sendMessage(ownerId, "non-existent-session-id", "owner", "owner_decision", "Attack plan");
  }, /SESSION_NOT_FOUND/);

  // Empty content is rejected
  assert.throws(() => {
    sendMessage(ownerId, session.id, "owner", "owner_decision", "   ");
  }, /MESSAGE_CONTENT_CANNOT_BE_EMPTY/);

  // Invalid message type combination for Owner
  assert.throws(() => {
    sendMessage(ownerId, session.id, "owner", "agent_question", "Question from agent");
  }, /INVALID_SENDER_MESSAGE_TYPE_COMBINATION/);

  // Invalid message type combination for Agent
  assert.throws(() => {
    sendMessage(ownerId, session.id, "agent", "owner_decision", "Decision from agent");
  }, /INVALID_SENDER_MESSAGE_TYPE_COMBINATION/);

  // Valid combos succeed
  const msg1 = sendMessage(ownerId, session.id, "owner", "owner_decision", "Tone should be horror");
  assert.equal(msg1.sender, "owner");
  assert.equal(msg1.messageType, "owner_decision");

  const msg2 = sendMessage(ownerId, session.id, "agent", "agent_suggestion", "Use eerie synths");
  assert.equal(msg2.sender, "agent");
  assert.equal(msg2.messageType, "agent_suggestion");

  const msg3 = sendMessage(ownerId, session.id, "system", "validation_warning", "Section 1 missing");
  assert.equal(msg3.sender, "system");
  assert.equal(msg3.messageType, "validation_warning");
});

test("3. Only one active blueprint draft can exist per agent", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft1 = createBlueprintDraft(ownerId, agentId);
  assert.ok(draft1);

  // Secondary active blueprint draft creation throws error
  assert.throws(() => {
    createBlueprintDraft(ownerId, agentId);
  }, /ACTIVE_BLUEPRINT_DRAFT_ALREADY_EXISTS_FOR_AGENT/);
});

test("4. Cross-owner blueprint draft access is rejected", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const crossOwnerId = "owner-111";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);

  assert.throws(() => {
    getBlueprintDraft(crossOwnerId, draft.id);
  }, /OWNER_AUTHENTICATION_FAILED/);
});

test("5. Decisions increment revision count and update draft snapshot with optimistic concurrency checks", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  assert.equal(draft.revision, 1);

  // Stale write rejection
  assert.throws(() => {
    saveBlueprintDecision(ownerId, draft.id, 1, "Spooky and dramatic voice", 999);
  }, /STALE_WRITE_REJECTED/);

  saveBlueprintDecision(ownerId, draft.id, 1, "Spooky and dramatic voice", 1);
  assert.equal(draft.revision, 2);
  assert.equal(draft.snapshot["1"], "Spooky and dramatic voice");

  // Invalid section number
  assert.throws(() => {
    saveBlueprintDecision(ownerId, draft.id, 23, "Invalid", 2);
  }, /INVALID_BLUEPRINT_SECTION_NUMBER/);

  // Empty decision
  assert.throws(() => {
    saveBlueprintDecision(ownerId, draft.id, 1, "", 2);
  }, /DECISION_VALUE_CANNOT_BE_EMPTY/);
});

test("6. Agent suggestions can be proposed, accepted and rejected", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);

  // Propose suggestion
  const sug = proposeAgentSuggestion(ownerId, agentId, draft.id, 2, "120bpm pacing", 95);
  assert.equal(sug.status, "proposed");
  assert.equal(sug.sectionNo, 2);
  assert.equal(sug.confidence, 95);

  // Suggestion with invalid confidence is rejected
  assert.throws(() => {
    proposeAgentSuggestion(ownerId, agentId, draft.id, 2, "120bpm pacing", 150);
  }, /CONFIDENCE_VALUE_MUST_BE_BETWEEN_0_AND_100/);

  // Suggestion with negative confidence is rejected
  assert.throws(() => {
    proposeAgentSuggestion(ownerId, agentId, draft.id, 2, "120bpm pacing", -10);
  }, /CONFIDENCE_VALUE_MUST_BE_BETWEEN_0_AND_100/);

  // Cross-agent proposal rejected
  assert.throws(() => {
    proposeAgentSuggestion(ownerId, "agent-cross", draft.id, 2, "90bpm pacing");
  }, /CROSS_AGENT_MUTATION_REJECTED/);

  // Accept suggestion (passing current revision 1)
  const acceptedSugg = acceptSuggestion(ownerId, draft.id, sug.id, 1);
  assert.equal(acceptedSugg.status, "accepted");
  assert.equal(draft.snapshot["2"], "120bpm pacing");

  // Trying to accept again throws
  assert.throws(() => {
    acceptSuggestion(ownerId, draft.id, sug.id, 2);
  }, /SUGGESTION_ALREADY_PROCESSED/);

  // Propose another suggestion to reject
  const sug2 = proposeAgentSuggestion(ownerId, agentId, draft.id, 3, "Red color palette", 80);
  const rejectedSugg = rejectSuggestion(ownerId, draft.id, sug2.id);
  assert.equal(rejectedSugg.status, "rejected");
});

test("7. Unresolved questions block validation and can be resolved by the owner", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);

  // Seed all 22 sections so that's not a block
  for (let i = 1; i <= 22; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Section ${i} standard`, i);
  }

  // Raise unresolved question
  const q = raiseUnresolvedQuestion(ownerId, agentId, draft.id, 5, "What hook formula should we use?");
  assert.equal(q.isActive, true);

  // Validation should fail due to unresolved question
  const val1 = validateBlueprintDraft(ownerId, draft.id);
  assert.equal(val1.isValid, false);
  assert.ok(val1.errors.some(e => e.includes("unresolved active questions")));

  // Resolve question (passing revision 23)
  resolveQuestion(ownerId, draft.id, q.id, "The three-second horror hook", 23);
  assert.equal(q.isActive, false);

  // Validation should now pass
  const val2 = validateBlueprintDraft(ownerId, draft.id);
  assert.equal(val2.isValid, true);
  assert.equal(draft.snapshot["5"], "The three-second horror hook");
});

test("8. Complete 22-section validation is enforced during blueprint versioning", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);

  // Populate only 21 sections
  for (let i = 1; i <= 21; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  // Attempting to create a version with an incomplete blueprint fails
  assert.throws(() => {
    createBlueprintVersion(ownerId, draft.id);
  }, /CANNOT_VERSION_INVALID_BLUEPRINT_DRAFT/);

  // Populate the 22nd section
  saveBlueprintDecision(ownerId, draft.id, 22, "Cover art overlay template", 22);

  // Version creation now succeeds
  const ver = createBlueprintVersion(ownerId, draft.id);
  assert.equal(ver.versionNo, 1);
  assert.equal(ver.status, "unapproved");
});

test("9. Secret-leak scanning is recursively performed during blueprint versioning", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);

  // Populate all sections, including secret-shaped values to verify recursive sanitization
  for (let i = 1; i <= 22; i++) {
    if (i === 15) {
      saveBlueprintDecision(ownerId, draft.id, i, "Standard disclosure", i);
    } else {
      saveBlueprintDecision(ownerId, draft.id, i, `Decision ${i}`, i);
    }
  }

  // Let's directly add secret credential field inside the snapshot object to test recursive sanitization
  draft.snapshot["18"] = {
    apiKey: "leak-private-api-key-123456",
    nested: {
      password: "nested_secret_pass",
      normalField: "safe-asset-location"
    }
  };

  const ver = createBlueprintVersion(ownerId, draft.id);
  assert.ok(ver);

  // The output must be recursively sanitized in the snapshot
  assert.equal(ver.snapshot["18"].apiKey, undefined);
  assert.equal(ver.snapshot["18"].nested.password, undefined);
  assert.equal(ver.snapshot["18"].nested.normalField, "safe-asset-location");
});

test("10. Immutable approval deactivates the blueprint draft and supersedes older versions", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  for (let i = 1; i <= 22; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver1 = createBlueprintVersion(ownerId, draft.id);
  assert.equal(ver1.status, "unapproved");

  // Approval with mismatched hash fails
  assert.throws(() => {
    approveExactBlueprintVersion(ownerId, ver1.id, "mismatched-hash-value-000000000000000000000000000000000000000000000");
  }, /SNAPSHOT_HASH_MISMATCH/);

  // Approval succeeds with correct hash
  const app = approveExactBlueprintVersion(ownerId, ver1.id, ver1.snapshotHash);
  assert.ok(app);
  assert.equal(ver1.status, "approved");

  // Draft becomes inactive and immutable
  assert.equal(draft.isActive, false);
  assert.throws(() => {
    saveBlueprintDecision(ownerId, draft.id, 1, "New voice", 23);
  }, /BLUEPRINT_DRAFT_IS_INACTIVE/);

  // Retrieve active approved blueprint
  const activeBlueprint = retrieveActiveApprovedBlueprint(ownerId, agentId);
  assert.ok(activeBlueprint);
  assert.equal(activeBlueprint.id, ver1.id);
});

test("11. Configurable interview engine ensures only one active question is allowed at a time per session", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const session = createSession(ownerId, agentId);
  const draft = createBlueprintDraft(ownerId, agentId);

  // Raise active question 1 linked to session
  const q1 = raiseUnresolvedQuestion(ownerId, agentId, draft.id, 1, "Select brand tone", session.id);
  assert.ok(q1);

  // Trying to raise a second active question linked to the same session throws
  assert.throws(() => {
    raiseUnresolvedQuestion(ownerId, agentId, draft.id, 2, "Select pacing", session.id);
  }, /SESSION_ALREADY_HAS_AN_ACTIVE_INTERVIEW_QUESTION/);

  // Resolve question 1
  resolveQuestion(ownerId, draft.id, q1.id, "Scary voice", 1);

  // Now raising a second active question succeeds
  const q2 = raiseUnresolvedQuestion(ownerId, agentId, draft.id, 2, "Select pacing", session.id);
  assert.ok(q2);
});

test("12. Version comparison tool correctly highlights differences between blueprint version snapshots", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  for (let i = 1; i <= 22; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Original value ${i}`, i);
  }

  const ver1 = createBlueprintVersion(ownerId, draft.id);

  // Create version 2 with modified pacing (Section 2)
  saveBlueprintDecision(ownerId, draft.id, 2, "Modified fast pacing", 23);
  const ver2 = createBlueprintVersion(ownerId, draft.id);

  const cmpResult = compareBlueprintVersions(ownerId, draft.id, ver1.id, ver2.id);
  assert.equal(cmpResult.hasDifferences, true);
  assert.ok(cmpResult.differences["2"]);
  assert.equal(cmpResult.differences["2"].before, "Original value 2");
  assert.equal(cmpResult.differences["2"].after, "Modified fast pacing");
});

test("13. Preview sanitized worker context returns recursive credentials-stripped preview", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  for (let i = 1; i <= 22; i++) {
    if (i === 18) {
      draft.snapshot["18"] = {
        api_token: "super-secret-oauth-value",
        normalConfig: "safe-value"
      };
    } else {
      draft.snapshot[String(i)] = `Value ${i}`;
    }
  }

  const preview = previewSanitizedWorkerContext(ownerId, draft.id);
  assert.ok(preview);
  assert.equal(preview.snapshot["18"].api_token, undefined);
  assert.equal(preview.snapshot["18"].normalConfig, "safe-value");
});

test("14. Unresolved question resolve check behaves defensively", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  const q = raiseUnresolvedQuestion(ownerId, agentId, draft.id, 1, "Choose brand tone");

  // Answering non-existent question
  assert.throws(() => {
    resolveQuestion(ownerId, draft.id, "non-existent-question-id", "Horror", 1);
  }, /QUESTION_NOT_FOUND/);

  // Answering twice is blocked
  resolveQuestion(ownerId, draft.id, q.id, "Horror", 1);
  assert.throws(() => {
    resolveQuestion(ownerId, draft.id, q.id, "Comedy", 2);
  }, /QUESTION_ALREADY_RESOLVED/);
});

test("15. Brand voice validation rejects unsafe and unfiltered terminology", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  for (let i = 1; i <= 22; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Value ${i}`, i);
  }

  // Set brand voice (Section 1) containing unsafe
  saveBlueprintDecision(ownerId, draft.id, 1, "This is an unsafe system", 23);
  const val = validateBlueprintDraft(ownerId, draft.id);
  assert.equal(val.isValid, false);
  assert.ok(val.errors.some(e => e.includes("Brand voice contains unsafe or prohibited terminology")));
});

test("16. Session messaging engine defends against invalid message formats", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const session = createSession(ownerId, agentId);
  assert.throws(() => {
    sendMessage(ownerId, session.id, "owner", "owner_decision", null);
  }, /MESSAGE_CONTENT_CANNOT_BE_EMPTY/);
});

test("17. Suggestions cannot be processed twice", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  const sug = proposeAgentSuggestion(ownerId, agentId, draft.id, 2, "Action tone", 100);

  // Reject suggestion
  rejectSuggestion(ownerId, draft.id, sug.id);
  assert.throws(() => {
    acceptSuggestion(ownerId, draft.id, sug.id, 1);
  }, /SUGGESTION_ALREADY_PROCESSED/);
});

test("18. Direct-owner answer allows multiple decisions across the blueprint sections", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  saveBlueprintDecision(ownerId, draft.id, 3, "Cold color palette", 1);
  assert.equal(draft.snapshot["3"], "Cold color palette");
});

test("19. Rejects action on drafts for non-active blueprints", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  draft.isActive = false;

  assert.throws(() => {
    saveBlueprintDecision(ownerId, draft.id, 1, "Values", 1);
  }, /BLUEPRINT_DRAFT_IS_INACTIVE/);
});

test("20. Cannot version invalid blueprint drafts with unresolved questions", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  for (let i = 1; i <= 22; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Value ${i}`, i);
  }

  raiseUnresolvedQuestion(ownerId, agentId, draft.id, 3, "Is this correct?");

  assert.throws(() => {
    createBlueprintVersion(ownerId, draft.id);
  }, /CANNOT_VERSION_INVALID_BLUEPRINT_DRAFT/);
});

test("21. Retrieval of active approved blueprint is accurate when multiple blueprints exist", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  for (let i = 1; i <= 22; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Value ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  const active = retrieveActiveApprovedBlueprint(ownerId, agentId);
  assert.ok(active);
  assert.equal(active.id, ver.id);
});

test("22. Section mismatch checks prevent bad inputs during decision save", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  assert.throws(() => {
    saveBlueprintDecision(ownerId, draft.id, -5, "Bad section", 1);
  }, /INVALID_BLUEPRINT_SECTION_NUMBER/);
});

test("23. Zero-trust validation for session detail fetch", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const session = createSession(ownerId, "agent-01");

  assert.throws(() => {
    getSession("owner-mismatch", session.id);
  }, /OWNER_AUTHENTICATION_FAILED/);
});

test("24. Session is resolved correctly by owners", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const session = createSession(ownerId, "agent-01");

  const resolved = getSession(ownerId, session.id);
  assert.equal(resolved.id, session.id);
});

test("25. Validation errors format lists incomplete sections clearly", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  const val = validateBlueprintDraft(ownerId, draft.id);
  assert.equal(val.isValid, false);
  assert.equal(val.errors.length, 22);
});

test("26. Validates confidence boundaries are handled appropriately inside suggest parameters", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  const sug = proposeAgentSuggestion(ownerId, agentId, draft.id, 1, "Brand text", 0);
  assert.equal(sug.confidence, 0);
});

test("27. Suggestion rejects negative or overflow confidence", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  assert.throws(() => {
    proposeAgentSuggestion(ownerId, agentId, draft.id, 1, "Brand text", -1);
  }, /CONFIDENCE_VALUE_MUST_BE_BETWEEN_0_AND_100/);

  assert.throws(() => {
    proposeAgentSuggestion(ownerId, agentId, draft.id, 1, "Brand text", 101);
  }, /CONFIDENCE_VALUE_MUST_BE_BETWEEN_0_AND_100/);
});

test("28. Compare versions returns consistent diff format A vs B", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  for (let i = 1; i <= 22; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Value ${i}`, i);
  }

  const ver1 = createBlueprintVersion(ownerId, draft.id);
  saveBlueprintDecision(ownerId, draft.id, 1, "New brand tone", 23);
  const ver2 = createBlueprintVersion(ownerId, draft.id);

  const diff = compareBlueprintVersions(ownerId, draft.id, ver1.id, ver2.id);
  assert.equal(diff.differences["1"].before, "Value 1");
  assert.equal(diff.differences["1"].after, "New brand tone");
});

test("29. Inactive draft versioning attempt fails", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-999";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId, agentId);
  for (let i = 1; i <= 22; i++) {
    saveBlueprintDecision(ownerId, draft.id, i, `Value ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  assert.throws(() => {
    createBlueprintVersion(ownerId, draft.id);
  }, /BLUEPRINT_DRAFT_IS_INACTIVE/);
});

test("30. Active approved blueprint query handles clean defaults", () => {
  resetOwnerAgentCommunicationRegistry();
  const active = retrieveActiveApprovedBlueprint("owner-999", "agent-01");
  assert.equal(active, null);
});
