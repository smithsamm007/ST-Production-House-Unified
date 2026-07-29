import { createHash, randomUUID } from "node:crypto";
import { deepFreeze as originalDeepFreeze, deepCopy, sanitizeSecrets } from "./creativeReferenceLibrary.js";

// Custom deepFreeze that recursively freezes objects
export function deepFreeze(obj) {
  if (obj && typeof obj === "object") {
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
      deepFreeze(obj[key]);
    }
  }
  return obj;
}

// In-memory registry to mock/simulate database layers and policies
const sessions = new Map();
const messages = new Map();
const drafts = new Map();
const versions = new Map();
const decisions = new Map();
const suggestions = new Map();
const unresolvedQuestions = new Map();
const validationResults = new Map();
const approvals = new Map();
const proposedChanges = new Map();

export function resetOwnerAgentCommunicationRegistry() {
  sessions.clear();
  messages.clear();
  drafts.clear();
  versions.clear();
  decisions.clear();
  suggestions.clear();
  unresolvedQuestions.clear();
  validationResults.clear();
  approvals.clear();
  proposedChanges.clear();
}

// Correction 1: Required Creative Universe sections (exactly 22 specific names)
export const BLUEPRINT_SECTIONS = [
  { no: 1, name: "Universe Overview" },
  { no: 2, name: "Niche" },
  { no: 3, name: "Audience" },
  { no: 4, name: "Language" },
  { no: 5, name: "Tone" },
  { no: 6, name: "Story Architecture" },
  { no: 7, name: "Canon" },
  { no: 8, name: "Characters" },
  { no: 9, name: "Narration" },
  { no: 10, name: "Source Policy" },
  { no: 11, name: "Niche References" },
  { no: 12, name: "Visual References" },
  { no: 13, name: "Voice Profile" },
  { no: 14, name: "Visual Profile" },
  { no: 15, name: "Episode Rules" },
  { no: 16, name: "Provider Policy" },
  { no: 17, name: "Promotion Rules" },
  { no: 18, name: "Affiliate Rules" },
  { no: 19, name: "Storage Policy" },
  { no: 20, name: "Publishing Policy" },
  { no: 21, name: "Autopilot Boundaries" },
  { no: 22, name: "Unresolved Decisions" }
];

function stableStringify(obj) {
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `"${k}":${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

export function computeBlueprintHash(snapshot) {
  return createHash("sha256")
    .update(stableStringify(snapshot))
    .digest("hex");
}

// Helper to prevent mutable internal references from escaping (Correction 4)
function copyAndFreeze(obj) {
  if (obj === undefined) return undefined;
  return deepFreeze(deepCopy(obj));
}

// Internal raw lookups to avoid TypeError on frozen objects
function getDraftInternal(blueprintId) {
  const d = drafts.get(blueprintId);
  if (!d) throw new Error("BLUEPRINT_DRAFT_NOT_FOUND");
  return d;
}

function getSessionInternal(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("SESSION_NOT_FOUND");
  return s;
}

// ----------------------------------------------------
// 1. Session Registry & Messaging Engine (Correction 3 - Session/Draft Isolation)
// ----------------------------------------------------

export function createSession(ownerId, agentId, blueprintDraftId = null) {
  if (!ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (!agentId) throw new Error("AGENT_ID_REQUIRED");

  const session = {
    id: randomUUID(),
    ownerId,
    agentId,
    isActive: true,
    activeQuestionId: null,
    blueprintDraftId, // Linked blueprint draft for this session
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  sessions.set(session.id, session);
  return copyAndFreeze(session);
}

export function getSession(ownerId, sessionId) {
  const session = getSessionInternal(sessionId);
  if (session.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  return copyAndFreeze(session);
}

export function sendMessage(ownerId, sessionId, sender, messageType, content) {
  const sessionObj = getSessionInternal(sessionId);
  if (sessionObj.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  if (!content || content.trim().length === 0) {
    throw new Error("MESSAGE_CONTENT_CANNOT_BE_EMPTY");
  }

  const allowedSenders = ["owner", "agent", "system"];
  if (!allowedSenders.includes(sender)) throw new Error("INVALID_SENDER");

  const validTypes = [
    "owner_decision", "owner_question",
    "agent_question", "agent_suggestion", "agent_explanation",
    "validation_warning", "system_status"
  ];
  if (!validTypes.includes(messageType)) throw new Error("INVALID_MESSAGE_TYPE");

  if (sender === "owner" && !["owner_decision", "owner_question"].includes(messageType)) {
    throw new Error("INVALID_SENDER_MESSAGE_TYPE_COMBINATION");
  }
  if (sender === "agent" && !["agent_question", "agent_suggestion", "agent_explanation"].includes(messageType)) {
    throw new Error("INVALID_SENDER_MESSAGE_TYPE_COMBINATION");
  }
  if (sender === "system" && !["validation_warning", "system_status"].includes(messageType)) {
    throw new Error("INVALID_SENDER_MESSAGE_TYPE_COMBINATION");
  }

  const message = {
    id: randomUUID(),
    sessionId,
    sender,
    messageType,
    content: content.trim(),
    createdAt: new Date().toISOString()
  };

  messages.set(message.id, message);
  sessionObj.updatedAt = new Date().toISOString();
  return copyAndFreeze(message);
}

// ----------------------------------------------------
// 2. Blueprint Draft Management (Correction 3 - Session/Draft Isolation)
// ----------------------------------------------------

export function createBlueprintDraft(ownerId, agentId, universeId = null, sessionId = null) {
  if (!ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (!agentId) throw new Error("AGENT_ID_REQUIRED");

  const draft = {
    id: randomUUID(),
    communicationSessionId: sessionId,
    ownerId,
    agentId,
    universeId,
    revision: 1,
    snapshot: {},
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  drafts.set(draft.id, draft);

  if (sessionId) {
    const sessionObj = getSessionInternal(sessionId);
    if (sessionObj) {
      sessionObj.blueprintDraftId = draft.id;
    }
  }

  return copyAndFreeze(draft);
}

export function getBlueprintDraft(ownerId, blueprintId) {
  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  return copyAndFreeze(draft);
}

// ----------------------------------------------------
// 3. Proposed Changes Engine (Correction 2)
// ----------------------------------------------------

export function createProposedChange(ownerId, sessionId, blueprintId, sectionNo, rawAnswer, proposedValue, provenance = "interview_answer") {
  const session = getSessionInternal(sessionId);
  if (session.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const sec = BLUEPRINT_SECTIONS.find(s => s.no === sectionNo);
  if (!sec) throw new Error("INVALID_BLUEPRINT_SECTION_NUMBER");

  if (!rawAnswer || rawAnswer.trim().length === 0) {
    throw new Error("RAW_ANSWER_CANNOT_BE_EMPTY");
  }

  const change = {
    id: randomUUID(),
    ownerId,
    sessionId,
    blueprintId,
    sectionNo,
    rawAnswer: rawAnswer.trim(),
    proposedValue: proposedValue,
    provenance,
    status: "proposed", // 'proposed', 'accepted', 'rejected', 'superseded'
    revision: draft.revision,
    createdAt: new Date().toISOString()
  };

  proposedChanges.set(change.id, change);
  return copyAndFreeze(change);
}

export function acceptProposedChange(ownerId, blueprintId, changeId, expectedRevision) {
  const draftObj = getDraftInternal(blueprintId);
  if (draftObj.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  // Correction 8: Fork approved blueprint draft instead of mutating it
  let targetDraft = draftObj;
  if (!draftObj.isActive) {
    targetDraft = forkApprovedDraftIfNeeded(ownerId, blueprintId);
  }

  if (targetDraft.revision !== expectedRevision) {
    throw new Error("STALE_WRITE_REJECTED");
  }

  const changeObj = proposedChanges.get(changeId);
  if (!changeObj || changeObj.blueprintId !== blueprintId) {
    throw new Error("PROPOSED_CHANGE_NOT_FOUND");
  }
  if (changeObj.status !== "proposed") {
    throw new Error("PROPOSED_CHANGE_ALREADY_PROCESSED");
  }

  // Update blueprint draft snapshot upon owner acceptance
  targetDraft.snapshot[String(changeObj.sectionNo)] = changeObj.proposedValue;
  targetDraft.revision += 1;
  targetDraft.updatedAt = new Date().toISOString();

  changeObj.status = "accepted";
  changeObj.updatedAt = new Date().toISOString();

  // Supersede other proposed changes in the same section
  const related = [...proposedChanges.values()].filter(
    c => c.blueprintId === blueprintId && c.sectionNo === changeObj.sectionNo && c.id !== changeId && c.status === "proposed"
  );
  for (const c of related) {
    c.status = "superseded";
  }

  return copyAndFreeze(changeObj);
}

export function rejectProposedChange(ownerId, blueprintId, changeId) {
  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const changeObj = proposedChanges.get(changeId);
  if (!changeObj || changeObj.blueprintId !== blueprintId) {
    throw new Error("PROPOSED_CHANGE_NOT_FOUND");
  }
  if (changeObj.status !== "proposed") {
    throw new Error("PROPOSED_CHANGE_ALREADY_PROCESSED");
  }

  changeObj.status = "rejected";
  changeObj.updatedAt = new Date().toISOString();
  return copyAndFreeze(changeObj);
}

// Direct Blueprint edits are recorded immediately ONLY via owner_direct_edit (Correction 2)
export function ownerDirectEdit(ownerId, blueprintId, sectionNo, value, expectedRevision) {
  const draftObj = getDraftInternal(blueprintId);
  if (draftObj.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  // Correction 8: Editing an approved blueprint generates a unapproved successor draft
  let targetDraft = draftObj;
  if (!draftObj.isActive) {
    targetDraft = forkApprovedDraftIfNeeded(ownerId, blueprintId);
  }

  if (targetDraft.revision !== expectedRevision) {
    throw new Error("STALE_WRITE_REJECTED");
  }

  const sec = BLUEPRINT_SECTIONS.find(s => s.no === sectionNo);
  if (!sec) throw new Error("INVALID_BLUEPRINT_SECTION_NUMBER");

  targetDraft.snapshot[String(sectionNo)] = value;
  targetDraft.revision += 1;
  targetDraft.updatedAt = new Date().toISOString();

  // Record a decision row
  const dec = {
    id: randomUUID(),
    blueprintId: targetDraft.id,
    sectionNo,
    decisionValue: value,
    provenance: "owner_direct_edit",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  decisions.set(dec.id, dec);

  return copyAndFreeze(targetDraft);
}

// Helper to fork approved drafts to successor (Correction 8)
export function forkApprovedDraftIfNeeded(ownerId, blueprintId) {
  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const approvedVer = [...versions.values()].find(v => v.blueprintId === blueprintId && v.status === "approved");
  if (!approvedVer) {
    throw new Error("INACTIVE_DRAFT_HAS_NO_APPROVED_VERSION");
  }

  // Create a brand new draft successor derived from approved snapshot
  const successorDraft = {
    id: randomUUID(),
    communicationSessionId: draft.communicationSessionId,
    ownerId: draft.ownerId,
    agentId: draft.agentId,
    universeId: draft.universeId,
    revision: 1,
    snapshot: deepCopy(approvedVer.snapshot), // Inherit approved snapshot
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  drafts.set(successorDraft.id, successorDraft);
  return successorDraft;
}

// ----------------------------------------------------
// 4. Configurable Interview Question & Suggestions Engine
// ----------------------------------------------------

export function raiseUnresolvedQuestion(ownerId, agentId, blueprintId, sectionNo, questionText, sessionId = null) {
  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (draft.agentId !== agentId) throw new Error("CROSS_AGENT_MUTATION_REJECTED");
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const sec = BLUEPRINT_SECTIONS.find(s => s.no === sectionNo);
  if (!sec) throw new Error("INVALID_BLUEPRINT_SECTION_NUMBER");

  if (!questionText || questionText.trim().length === 0) {
    throw new Error("QUESTION_TEXT_CANNOT_BE_EMPTY");
  }

  // Active question session lock (only one active question at a time per session)
  if (sessionId) {
    const sessionObj = getSessionInternal(sessionId);
    if (sessionObj) {
      if (sessionObj.activeQuestionId) {
        const activeQ = unresolvedQuestions.get(sessionObj.activeQuestionId);
        if (activeQ && activeQ.isActive) {
          throw new Error("SESSION_ALREADY_HAS_AN_ACTIVE_INTERVIEW_QUESTION");
        }
      }
    }
  }

  const q = {
    id: randomUUID(),
    blueprintId,
    sectionNo,
    questionText: questionText.trim(),
    isActive: true,
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  unresolvedQuestions.set(q.id, q);

  if (sessionId) {
    const sessionObj = getSessionInternal(sessionId);
    if (sessionObj) {
      sessionObj.activeQuestionId = q.id;
    }
  }

  draft.updatedAt = new Date().toISOString();
  return copyAndFreeze(q);
}

// Answering a question creates a reviewable proposed change, doesn't directly mutate (Correction 2)
export function resolveQuestion(ownerId, blueprintId, questionId, rawAnswer, proposedValue, sessionId = null) {
  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const q = unresolvedQuestions.get(questionId);
  if (!q || q.blueprintId !== blueprintId) {
    throw new Error("QUESTION_NOT_FOUND");
  }
  if (!q.isActive) {
    throw new Error("QUESTION_ALREADY_RESOLVED");
  }

  // Create a proposed change instead of direct mutate
  const resolvedSessionId = sessionId || q.sessionId || randomUUID();
  if (!sessions.has(resolvedSessionId)) {
    createSession(ownerId, draft.agentId, blueprintId);
  }
  const change = createProposedChange(ownerId, resolvedSessionId, blueprintId, q.sectionNo, rawAnswer, proposedValue, "question_resolution");

  q.isActive = false;
  q.updatedAt = new Date().toISOString();

  // Clear session lock
  const sessionObj = getSessionInternal(resolvedSessionId);
  if (sessionObj && sessionObj.activeQuestionId === q.id) {
    sessionObj.activeQuestionId = null;
  }

  draft.updatedAt = new Date().toISOString();
  return copyAndFreeze(q);
}

export function proposeAgentSuggestion(ownerId, agentId, blueprintId, sectionNo, suggestionValue, confidence = 100, provenance = "agent_recommendation") {
  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (draft.agentId !== agentId) throw new Error("CROSS_AGENT_MUTATION_REJECTED");
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const sec = BLUEPRINT_SECTIONS.find(s => s.no === sectionNo);
  if (!sec) throw new Error("INVALID_BLUEPRINT_SECTION_NUMBER");

  if (!suggestionValue || suggestionValue.trim().length === 0) {
    throw new Error("SUGGESTION_VALUE_CANNOT_BE_EMPTY");
  }

  if (confidence < 0 || confidence > 100) {
    throw new Error("CONFIDENCE_VALUE_MUST_BE_BETWEEN_0_AND_100");
  }

  const sugg = {
    id: randomUUID(),
    blueprintId,
    sectionNo,
    suggestionValue: suggestionValue.trim(),
    status: "proposed",
    provenance,
    confidence,
    decisionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  suggestions.set(sugg.id, sugg);
  draft.updatedAt = new Date().toISOString();
  return copyAndFreeze(sugg);
}

export function acceptSuggestion(ownerId, blueprintId, suggestionId, expectedRevision) {
  const draftObj = getDraftInternal(blueprintId);
  if (draftObj.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const sugg = suggestions.get(suggestionId);
  if (!sugg || sugg.blueprintId !== blueprintId) {
    throw new Error("SUGGESTION_NOT_FOUND");
  }
  if (sugg.status !== "proposed") {
    throw new Error("SUGGESTION_ALREADY_PROCESSED");
  }

  // Accepting suggestion creates a proposed change rather than directly mutating the blueprint
  const resolvedSessionId = draftObj.communicationSessionId || randomUUID();
  const change = createProposedChange(ownerId, resolvedSessionId, blueprintId, sugg.sectionNo, "Accept agent suggestion", sugg.suggestionValue, "accepted_suggestion");

  // Accept the proposed change to apply it to the draft
  acceptProposedChange(ownerId, blueprintId, change.id, expectedRevision);

  sugg.status = "accepted";
  sugg.decisionId = change.id;
  sugg.updatedAt = new Date().toISOString();

  // Supersede other suggestions in this section
  const related = [...suggestions.values()].filter(
    s => s.blueprintId === blueprintId && s.sectionNo === sugg.sectionNo && s.id !== suggestionId && s.status === "proposed"
  );
  for (const s of related) {
    s.status = "superseded";
    s.updatedAt = new Date().toISOString();
  }

  return copyAndFreeze(sugg);
}

export function rejectSuggestion(ownerId, blueprintId, suggestionId) {
  const draftObj = getDraftInternal(blueprintId);
  if (draftObj.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const sugg = suggestions.get(suggestionId);
  if (!sugg || sugg.blueprintId !== blueprintId) {
    throw new Error("SUGGESTION_NOT_FOUND");
  }
  if (sugg.status !== "proposed") {
    throw new Error("SUGGESTION_ALREADY_PROCESSED");
  }

  sugg.status = "rejected";
  sugg.updatedAt = new Date().toISOString();
  return copyAndFreeze(sugg);
}

// ----------------------------------------------------
// 5. Validation & Versioning
// ----------------------------------------------------

export function validateBlueprintDraft(ownerId, blueprintId) {
  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  const snapshot = draft.snapshot || {};

  const errors = [];
  const warnings = [];

  for (const sec of BLUEPRINT_SECTIONS) {
    const val = snapshot[String(sec.no)];
    if (!val) {
      errors.push(`Section ${sec.no} (${sec.name}) has no recorded decision.`);
    } else if (typeof val === "string" && val.trim().length === 0) {
      errors.push(`Section ${sec.no} (${sec.name}) has no recorded decision.`);
    } else if (typeof val === "object" && Object.keys(val).length === 0) {
      errors.push(`Section ${sec.no} (${sec.name}) has no recorded decision.`);
    }
  }

  const brandVoice = typeof snapshot["5"] === "string" ? snapshot["5"] : ""; // Tone
  const boundaries = typeof snapshot["21"] === "string" ? snapshot["21"] : ""; // Autopilot Boundaries

  if (brandVoice.toLowerCase().includes("unsafe") || brandVoice.toLowerCase().includes("unfiltered")) {
    errors.push("Brand voice contains unsafe or prohibited terminology (e.g. 'unfiltered', 'unsafe').");
  }
  if (boundaries.trim().length > 0 && boundaries.trim().length < 10) {
    warnings.push("Content boundaries entry is exceptionally short; review for safety compliance.");
  }

  const openQuestions = [...unresolvedQuestions.values()].filter(q => q.blueprintId === blueprintId && q.isActive);
  if (openQuestions.length > 0) {
    errors.push(`Blueprint has ${openQuestions.length} unresolved active questions.`);
  }

  const isValid = errors.length === 0;

  // Correction 5: Hashing the Stored Snapshot Order
  const cleanSnapshot = sanitizeBlueprintSnapshotForWorkers(snapshot);
  const snapshotHash = computeBlueprintHash(cleanSnapshot);

  const result = {
    id: randomUUID(),
    blueprintId,
    snapshotHash,
    isValid,
    errors,
    warnings,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  validationResults.set(result.id, result);
  return copyAndFreeze(result);
}

// Sanitization worker-context allowlist (Correction 9)
export function sanitizeBlueprintSnapshotForWorkers(snapshot) {
  const clean = {};
  for (const [key, value] of Object.entries(snapshot)) {
    const sectionNo = parseInt(key, 10);
    if (sectionNo >= 1 && sectionNo <= 22) {
      if (typeof value === "string") {
        clean[key] = sanitizeSecrets(value);
      } else if (value && typeof value === "object") {
        clean[key] = sanitizeObjectWithWorkerAllowlist(value);
      } else {
        clean[key] = value;
      }
    }
  }
  return clean;
}

function sanitizeObjectWithWorkerAllowlist(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const safeObj = {};
  const allowlistedFields = [
    "brandVoice", "tone", "pace", "colorPalette", "aspectRatio",
    "ctaText", "soundType", "fontName", "fontSize", "normalField",
    "nicheReferences", "visualReferences", "platform", "destination",
    "value", "name", "description", "id"
  ];
  for (const [k, v] of Object.entries(obj)) {
    if (allowlistedFields.includes(k)) {
      if (typeof v === "object") {
        safeObj[k] = sanitizeObjectWithWorkerAllowlist(v);
      } else {
        safeObj[k] = v;
      }
    }
  }
  return safeObj;
}

// Correction 5: Create Blueprint Version
export function createBlueprintVersion(ownerId, blueprintId) {
  const draft = getDraftInternal(blueprintId);
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const valResult = validateBlueprintDraft(ownerId, blueprintId);
  if (!valResult.isValid) {
    throw new Error("CANNOT_VERSION_INVALID_BLUEPRINT_DRAFT");
  }

  // 1. deep-copy draft snapshot
  const rawSnapshot = deepCopy(draft.snapshot);
  // 2. sanitize using explicit allowlist
  const cleanSnapshot = sanitizeBlueprintSnapshotForWorkers(rawSnapshot);
  // 3. compute SHA-256 on exactly the stored sanitized version
  const snapshotHash = computeBlueprintHash(cleanSnapshot);

  const existing = [...versions.values()].filter(v => v.blueprintId === blueprintId);
  const versionNo = existing.length + 1;

  const v = {
    id: randomUUID(),
    blueprintId,
    versionNo,
    snapshot: deepFreeze(cleanSnapshot), // Stored recursively frozen
    snapshotHash,
    status: "unapproved",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  versions.set(v.id, v);
  draft.updatedAt = new Date().toISOString();
  return copyAndFreeze(v);
}

// Correction 6: Validation-Bound Approvals
export function approveExactBlueprintVersion(ownerId, versionId, expectedHash) {
  if (!ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const version = versions.get(versionId);
  if (!version) throw new Error("BLUEPRINT_VERSION_NOT_FOUND");

  const draft = getDraftInternal(version.blueprintId);
  if (draft.ownerId !== ownerId) {
    throw new Error("OWNER_AUTHENTICATION_FAILED");
  }

  if (version.snapshotHash !== expectedHash) {
    throw new Error("SNAPSHOT_HASH_MISMATCH");
  }

  if (version.status !== "unapproved") {
    throw new Error("VERSION_ALREADY_APPROVED_OR_SUPERSEDED");
  }

  // validation-bound validation presence
  const valResult = [...validationResults.values()].find(
    r => r.blueprintId === version.blueprintId && r.snapshotHash === expectedHash && r.isValid
  );
  if (!valResult) {
    throw new Error("NO_STORED_SUCCESSFUL_VALIDATION_RESULT_FOUND_FOR_HASH");
  }

  // zero open unresolved questions
  const openQuestions = [...unresolvedQuestions.values()].filter(
    q => q.blueprintId === version.blueprintId && q.isActive
  );
  if (openQuestions.length > 0) {
    throw new Error("BLUEPRINT_HAS_UNRESOLVED_BLOCKING_QUESTIONS");
  }

  const approval = {
    id: randomUUID(),
    blueprintVersionId: versionId,
    snapshotHash: version.snapshotHash,
    ownerId,
    approvedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Correction 11: Boundaries (no autopilot/publishing granted)
    isAgentActive: false,
    autopilotEnabled: false,
    publishingAuthorized: false,
    credentialsResolved: false,
    providersInvoked: false,
    productionEnqueued: false
  };

  approvals.set(approval.id, approval);

  version.status = "approved";
  version.updatedAt = new Date().toISOString();

  const related = [...versions.values()].filter(v => v.blueprintId === version.blueprintId && v.id !== versionId);
  for (const rv of related) {
    if (rv.status === "approved") {
      rv.status = "superseded";
    }
  }

  draft.isActive = false;
  draft.updatedAt = new Date().toISOString();

  return copyAndFreeze(approval);
}

export function retrieveActiveApprovedBlueprint(ownerId, agentId) {
  const agentDrafts = [...drafts.values()].filter(d => d.agentId === agentId && d.ownerId === ownerId);
  const draftIds = agentDrafts.map(d => d.id);

  const approved = [...versions.values()]
    .filter(v => draftIds.includes(v.blueprintId) && v.status === "approved")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return approved[0] ? copyAndFreeze(approved[0]) : null;
}

// ----------------------------------------------------
// 6. Version Comparison Tools & Sanitized Context Previews
// ----------------------------------------------------

export function compareBlueprintVersions(ownerId, blueprintId, versionIdA, versionIdB) {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  const verA = versions.get(versionIdA);
  const verB = versions.get(versionIdB);

  if (!verA || verA.blueprintId !== blueprintId) throw new Error("VERSION_A_NOT_FOUND");
  if (!verB || verB.blueprintId !== blueprintId) throw new Error("VERSION_B_NOT_FOUND");

  const diff = {};
  for (const sec of BLUEPRINT_SECTIONS) {
    const valA = verA.snapshot[String(sec.no)] || null;
    const valB = verB.snapshot[String(sec.no)] || null;

    if (JSON.stringify(valA) !== JSON.stringify(valB)) {
      diff[String(sec.no)] = {
        sectionName: sec.name,
        before: valA,
        after: valB
      };
    }
  }

  return copyAndFreeze({
    blueprintId,
    versionIdA,
    versionIdB,
    hasDifferences: Object.keys(diff).length > 0,
    differences: diff
  });
}

// Correction 9: Explicit worker allowlisted context preview
export function previewSanitizedWorkerContext(ownerId, blueprintId) {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  const rawSnapshot = deepCopy(draft.snapshot);
  const cleanSnapshot = sanitizeBlueprintSnapshotForWorkers(rawSnapshot);

  const rawContext = {
    blueprintId,
    agentId: draft.agentId,
    universeId: draft.universeId,
    snapshot: cleanSnapshot,
    revision: draft.revision
  };

  return deepFreeze(deepCopy(rawContext));
}

// Correction 10: Dynamic Agent name privacy check using registry
export function preventInternalAgentNames(name, agentRegistry) {
  if (!name) return false;
  const cleanName = String(name).toLowerCase().replace(/[_\-\.\s]+/g, "");

  if (agentRegistry && typeof agentRegistry.list === "function") {
    const list = agentRegistry.list();
    for (const agent of list) {
      const cleanAgentName = String(agent.name || "").toLowerCase().replace(/[_\-\.\s]+/g, "");
      if (cleanName.includes(cleanAgentName)) {
        return true;
      }
    }
  } else {
    // Hard fallback standard preloaded agent names
    const preloaded = ["JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA", "BYTE", "CHANAKYA", "KABIR", "SHAKTI", "ROHAN", "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA", "KARAN", "DEV", "AANYA", "ARJUN", "NISHA"];
    for (const item of preloaded) {
      if (cleanName.includes(item.toLowerCase().replace(/[_\-\.\s]+/g, ""))) {
        return true;
      }
    }
  }
  return false;
}

// Correction 12: Interface Contract Documentation
export const INTERFACE_CONTRACT = {
  layout: "desktop 45/55 split | mobile tabs",
  components: [
    "conversation stream",
    "one active question",
    "Blueprint preview",
    "progress",
    "warnings",
    "version comparison"
  ],
  actions: [
    "Save Draft",
    "Continue Later",
    "Preview Worker Context",
    "Validate Charter",
    "Compare Versions",
    "Reject Suggested Changes",
    "Approve Charter"
  ],
  disabledActions: [
    "Configure Autopilot"
  ]
};
