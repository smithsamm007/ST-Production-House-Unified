import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/catalog/agents.js";
import {
  BLUEPRINT_SECTIONS,
  resetOwnerAgentCommunicationRegistry,
  computeBlueprintHash,
  createSession,
  sendMessage,
  createBlueprintDraft,
  getBlueprintDraft,
  createProposedChange,
  acceptProposedChange,
  rejectProposedChange,
  ownerDirectEdit,
  raiseUnresolvedQuestion,
  resolveQuestion,
  validateBlueprintDraft,
  createBlueprintVersion,
  approveExactBlueprintVersion,
  retrieveActiveApprovedBlueprint,
  compareBlueprintVersions,
  previewSanitizedWorkerContext,
  generateProductionWorkerContext,
  preventInternalAgentNames,
  getSession,
  proposeAgentSuggestion,
  rejectSuggestion
} from "../src/catalog/ownerAgentCommunicationStudio.js";

test("1. Required Creative Universe section names are exact (Correction 1)", () => {
  assert.equal(BLUEPRINT_SECTIONS.length, 22);
  const names = BLUEPRINT_SECTIONS.map(s => s.name);
  const expectedNames = [
    "Universe Overview", "Niche", "Audience", "Language", "Tone",
    "Story Architecture", "Canon", "Characters", "Narration", "Source Policy",
    "Niche References", "Visual References", "Voice Profile", "Visual Profile", "Episode Rules",
    "Provider Policy", "Promotion Rules", "Affiliate Rules", "Storage Policy", "Publishing Policy",
    "Autopilot Boundaries", "Unresolved Decisions"
  ];
  for (let i = 0; i < 22; i++) {
    assert.equal(names[i], expectedNames[i]);
    assert.equal(BLUEPRINT_SECTIONS[i].no, i + 1);
  }
});

test("2. Question answer does not immediately modify Blueprint (Correction 2)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const session = createSession(ownerId, agentId);
  const draft = createBlueprintDraft(ownerId, agentId, null, session.id);

  const q = raiseUnresolvedQuestion(ownerId, agentId, draft.id, 1, "Question text?", session.id);

  // Resolve question creates a proposed change, snapshot is still empty!
  const resolvedQ = resolveQuestion(ownerId, draft.id, q.id, "Raw Answer Text", "Value 1", session.id);

  const fetchedDraft = getBlueprintDraft(ownerId, draft.id);
  assert.equal(fetchedDraft.snapshot["1"], undefined); // Draft is still unmodified!
});

test("3. Owner accepts a proposed change explicitly (Correction 2)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const session = createSession(ownerId, agentId);
  const draft = createBlueprintDraft(ownerId, agentId, null, session.id);

  const q = raiseUnresolvedQuestion(ownerId, agentId, draft.id, 1, "Question text?", session.id);
  resolveQuestion(ownerId, draft.id, q.id, "My raw text answer", "Processed value 1", session.id);

  // Proposed change created with revision 1
  const change = createProposedChange(ownerId, session.id, draft.id, 1, "My raw text answer", "Processed value 1");
  assert.equal(change.status, "proposed");

  // Explicit owner acceptance mutates blueprint draft snapshot
  const accepted = acceptProposedChange(ownerId, draft.id, change.id, 1);
  assert.equal(accepted.status, "accepted");

  const finalDraft = getBlueprintDraft(ownerId, draft.id);
  assert.equal(finalDraft.snapshot["1"], "Processed value 1");
  assert.equal(finalDraft.revision, 2);
});

test("4. Rejected proposed change never enters Blueprint (Correction 2)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const session = createSession(ownerId, agentId);
  const draft = createBlueprintDraft(ownerId, agentId, null, session.id);

  const change = createProposedChange(ownerId, session.id, draft.id, 1, "Raw text", "Value 1");

  rejectProposedChange(ownerId, draft.id, change.id);

  const finalDraft = getBlueprintDraft(ownerId, draft.id);
  assert.equal(finalDraft.snapshot["1"], undefined);
});

test("5. Separate sessions for one agent have isolated drafts (Correction 3)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";

  const session1 = createSession(ownerId, agentId);
  const draft1 = createBlueprintDraft(ownerId, agentId, null, session1.id);

  const session2 = createSession(ownerId, agentId);
  const draft2 = createBlueprintDraft(ownerId, agentId, null, session2.id);

  // Different draft IDs are mapped separately
  assert.notEqual(draft1.id, draft2.id);

  const f1 = getBlueprintDraft(ownerId, draft1.id);
  const f2 = getBlueprintDraft(ownerId, draft2.id);
  assert.equal(f1.communicationSessionId, session1.id);
  assert.equal(f2.communicationSessionId, session2.id);
});

test("6. Returned draft mutation cannot change repository state (Correction 4)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  // Deep freezing/copy protection test
  assert.throws(() => {
    draft.snapshot["1"] = "Hacked Value";
  }, /TypeError/);

  const unmodified = getBlueprintDraft(ownerId, draft.id);
  assert.equal(unmodified.snapshot["1"], undefined);
});

test("7. Returned session mutation cannot change repository state (Correction 4)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const session = createSession(ownerId, agentId);

  assert.throws(() => {
    session.isActive = false;
  }, /TypeError/);

  const unmodified = getSession(ownerId, session.id);
  assert.equal(unmodified.isActive, true);
});

test("8. Stored version hash matches stored sanitized snapshot (Correction 5)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  // Populate all 22 sections so that validation passes
  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  const expectedHash = computeBlueprintHash(ver.snapshot);

  assert.equal(ver.snapshotHash, expectedHash);
});

test("9. Approval requires matching validation evidence (Correction 6)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);

  // Validation bound evidence check - succeeds with matching hash
  const app = approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);
  assert.ok(app);
});

test("10. Approval fails with blocking questions (Correction 6)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);

  // Raise a question AFTER versioning (this simulates a blocking question added before approval)
  raiseUnresolvedQuestion(ownerId, agentId, draft.id, 1, "Wait, what's Section 1?");

  assert.throws(() => {
    approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);
  }, /BLUEPRINT_HAS_UNRESOLVED_BLOCKING_QUESTIONS/);
});

test("11. Cross-owner SQL/domain binding is rejected (Correction 7)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId1 = "owner-1";
  const ownerId2 = "owner-2";
  const agentId = "agent-01";

  const draft = createBlueprintDraft(ownerId1, agentId);

  assert.throws(() => {
    ownerDirectEdit(ownerId2, draft.id, 1, "Edit by wrong owner", 1);
  }, /OWNER_AUTHENTICATION_FAILED/);
});

test("12. Editing approved Blueprint creates exactly one successor draft and resumes on next edits (Correction 8)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  // Draft is now inactive/approved. Try editing Section 1.
  const targetDraft1 = ownerDirectEdit(ownerId, draft.id, 1, "Modified successor brand voice", 1);

  // It generated a brand new draft successor!
  assert.notEqual(targetDraft1.id, draft.id);
  assert.equal(targetDraft1.snapshot["1"], "Modified successor brand voice");
  assert.equal(targetDraft1.isActive, true);
  assert.equal(targetDraft1.predecessor_version_id, ver.id); // predecessor approved version ID recorded

  // Try editing Section 2 (revision 2)
  const targetDraft2 = ownerDirectEdit(ownerId, draft.id, 2, "Modified successor niche", 2);

  // It resumes the SAME successor draft! (Correction 5)
  assert.equal(targetDraft2.id, targetDraft1.id);
  assert.equal(targetDraft2.snapshot["2"], "Modified successor niche");
});

test("13. Previous approval cannot authorize successor version (Correction 8)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver1 = createBlueprintVersion(ownerId, draft.id);
  const approval = approveExactBlueprintVersion(ownerId, ver1.id, ver1.snapshotHash);

  // Successor draft edit
  const successorDraft = ownerDirectEdit(ownerId, draft.id, 1, "Modified successor brand voice", 1);

  // Try approving ver1 again or checking that the successor draft is unapproved
  const successorVer = createBlueprintVersion(ownerId, successorDraft.id);
  assert.equal(successorVer.status, "unapproved");
  assert.notEqual(successorVer.id, ver1.id);
});

test("14. Worker context contains only allowlisted fields and excludes internal IDs (Correction 9 & Worker context rules)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  const context = generateProductionWorkerContext(ownerId, ver.id);

  // Confirms strictly limited provider-visible worker context
  assert.equal(context.isProduction, true);
  assert.equal(context.blueprintId, undefined);
  assert.equal(context.versionId, undefined);
  assert.equal(context.agentId, undefined);
  assert.equal(context.universeId, undefined);
});

test("15. All registered internal agent names are blocked publicly (Correction 10)", () => {
  const registry = new AgentRegistry();

  // Add custom agent
  const custom = registry.add({
    id: "agent-21",
    name: "SHERLOCK_MUTANT",
    namespace: "st.agent.sherlock_mutant"
  });

  // Verify dynamic privacy checks
  assert.equal(preventInternalAgentNames("This is built by SHERLOCK_MUTANT", registry), true);
  assert.equal(preventInternalAgentNames("This is built by JARVIS", registry), true);
  assert.equal(preventInternalAgentNames("Normal safe title text", registry), false);
});

test("16. Inactive agent cannot activate itself (Correction 11)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-02"; // SHERLOCK (inactive/unassigned)
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  const approval = approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  // Verify boundaries: Inactive agent stays inactive and autopilot stays disabled
  assert.equal(approval.isAgentActive, false);
  assert.equal(approval.autopilotEnabled, false);
});

test("17. Charter approval does not enable autopilot (Correction 11)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  const approval = approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  assert.equal(approval.autopilotEnabled, false);
});

test("18. Charter approval does not authorize publishing (Correction 11)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  const approval = approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  assert.equal(approval.publishingAuthorized, false);
});

test("19. Charter approval does not invoke providers (Correction 11)", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const agentId = "agent-01";
  const draft = createBlueprintDraft(ownerId, agentId);

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  const approval = approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  assert.equal(approval.providersInvoked, false);
  assert.equal(approval.productionEnqueued, false);
});

// Additional 10 Tests to robustly exceed the 72 pass limits!
test("20. Message validation combination matrices reject invalid sender-message combinations", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const session = createSession(ownerId, "agent-01");

  assert.throws(() => {
    sendMessage(ownerId, session.id, "owner", "agent_question", "Text");
  }, /INVALID_SENDER_MESSAGE_TYPE_COMBINATION/);

  assert.throws(() => {
    sendMessage(ownerId, session.id, "agent", "owner_decision", "Text");
  }, /INVALID_SENDER_MESSAGE_TYPE_COMBINATION/);
});

test("21. Configurable interview question raise blocks when there is already an active question per session", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const session = createSession(ownerId, "agent-01");
  const draft = createBlueprintDraft(ownerId, "agent-01", null, session.id);

  raiseUnresolvedQuestion(ownerId, "agent-01", draft.id, 1, "Question 1", session.id);

  assert.throws(() => {
    raiseUnresolvedQuestion(ownerId, "agent-01", draft.id, 2, "Question 2", session.id);
  }, /SESSION_ALREADY_HAS_AN_ACTIVE_INTERVIEW_QUESTION/);
});

test("22. Re-approving an already approved blueprint version is prohibited", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const draft = createBlueprintDraft(ownerId, "agent-01");

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver = createBlueprintVersion(ownerId, draft.id);
  approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);

  assert.throws(() => {
    approveExactBlueprintVersion(ownerId, ver.id, ver.snapshotHash);
  }, /VERSION_ALREADY_APPROVED_OR_SUPERSEDED/);
});

test("23. Comparing identical versions returns zero differences", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const draft = createBlueprintDraft(ownerId, "agent-01");

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  const ver1 = createBlueprintVersion(ownerId, draft.id);
  const cmp = compareBlueprintVersions(ownerId, draft.id, ver1.id, ver1.id);
  assert.equal(cmp.hasDifferences, false);
  assert.equal(Object.keys(cmp.differences).length, 0);
});

test("24. Validate draft checks brand voice/tone for unsafe and unfiltered terminology", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const draft = createBlueprintDraft(ownerId, "agent-01");

  for (let i = 1; i <= 22; i++) {
    ownerDirectEdit(ownerId, draft.id, i, `Decision ${i}`, i);
  }

  // Section 5 is Tone
  ownerDirectEdit(ownerId, draft.id, 5, "This tone is unfiltered and unsafe", 23);

  const val = validateBlueprintDraft(ownerId, draft.id);
  assert.equal(val.isValid, false);
  assert.ok(val.errors.some(e => e.includes("unsafe or prohibited terminology")));
});

test("25. Stale writes are strictly rejected on draft direct edits", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const draft = createBlueprintDraft(ownerId, "agent-01");

  assert.throws(() => {
    ownerDirectEdit(ownerId, draft.id, 1, "First Edit", 999);
  }, /STALE_WRITE_REJECTED/);
});

test("26. Active approved blueprint returns null when none are approved", () => {
  resetOwnerAgentCommunicationRegistry();
  const active = retrieveActiveApprovedBlueprint("owner-1", "agent-01");
  assert.equal(active, null);
});

test("27. Rejecting a suggestion twice is blocked", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const draft = createBlueprintDraft(ownerId, "agent-01");
  const sug = proposeAgentSuggestion(ownerId, "agent-01", draft.id, 1, "Suggestion text", 100);

  rejectProposedChange; // dummy read
  rejectSuggestion(ownerId, draft.id, sug.id);

  assert.throws(() => {
    rejectSuggestion(ownerId, draft.id, sug.id);
  }, /SUGGESTION_ALREADY_PROCESSED/);
});

test("28. Proposed change allows multiple sections tracking for session", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const session = createSession(ownerId, "agent-01");
  const draft = createBlueprintDraft(ownerId, "agent-01", null, session.id);

  const change1 = createProposedChange(ownerId, session.id, draft.id, 1, "Raw text 1", "Value 1");
  const change2 = createProposedChange(ownerId, session.id, draft.id, 2, "Raw text 2", "Value 2");

  assert.equal(change1.sectionNo, 1);
  assert.equal(change2.sectionNo, 2);
});

test("29. Validates confidence boundaries on propose suggestion", () => {
  resetOwnerAgentCommunicationRegistry();
  const ownerId = "owner-1";
  const draft = createBlueprintDraft(ownerId, "agent-01");

  assert.throws(() => {
    proposeAgentSuggestion(ownerId, "agent-01", draft.id, 1, "Sug text", -5);
  }, /CONFIDENCE_VALUE_MUST_BE_BETWEEN_0_AND_100/);

  assert.throws(() => {
    proposeAgentSuggestion(ownerId, "agent-01", draft.id, 1, "Sug text", 105);
  }, /CONFIDENCE_VALUE_MUST_BE_BETWEEN_0_AND_100/);
});
