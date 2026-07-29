import { createHash, randomUUID } from "node:crypto";
import { deepFreeze, deepCopy, sanitizeSecrets } from "./creativeReferenceLibrary.js";

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
}

// Exactly 22 specific Interactive Interview Catalog sections
export const BLUEPRINT_SECTIONS = [
  { no: 1, name: "Brand Voice & Tone Profile" },
  { no: 2, name: "Pacing & Editing Cadence" },
  { no: 3, name: "Color Palettes & Color Grading" },
  { no: 4, name: "Visual Reference Preferences" },
  { no: 5, name: "Hook Formulas & Patterns" },
  { no: 6, name: "Format Structures & Durations" },
  { no: 7, name: "Content Boundaries & Prohibitions" },
  { no: 8, name: "Affiliate Placement Guidelines" },
  { no: 9, name: "Custom Fonts & Typography Styles" },
  { no: 10, name: "Aspect Ratios & Framing Rules" },
  { no: 11, name: "Target Platform Constraints" },
  { no: 12, name: "Call to Action (CTA) Styles" },
  { no: 13, name: "Soundscapes & Sound Effects Rules" },
  { no: 14, name: "Content-Safe Restrictions" },
  { no: 15, name: "Regulatory & Sponsor Disclosures" },
  { no: 16, name: "Output Rendering Formats" },
  { no: 17, name: "Editing & Scene Cuts Rules" },
  { no: 18, name: "Source Asset Metadata Guidelines" },
  { no: 19, name: "Parallel Job Execution Options" },
  { no: 20, name: "Retry Strategies & Backoff Rules" },
  { no: 21, name: "Primary Platform Destination Formats" },
  { no: 22, name: "Thumbnail & Cover Art Specifications" }
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

// ----------------------------------------------------
// 1. Session Registry & Messaging Engine
// ----------------------------------------------------

export function createSession(ownerId, agentId) {
  if (!ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (!agentId) throw new Error("AGENT_ID_REQUIRED");

  const session = {
    id: randomUUID(),
    ownerId,
    agentId,
    isActive: true,
    activeQuestionId: null, // Tracks currently active interview question
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  sessions.set(session.id, session);
  return session;
}

export function getSession(ownerId, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (session.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  return session;
}

export function sendMessage(ownerId, sessionId, sender, messageType, content) {
  const session = getSession(ownerId, sessionId);

  if (!content || content.trim().length === 0) {
    throw new Error("MESSAGE_CONTENT_CANNOT_BE_EMPTY");
  }

  // Validate message matrix constraints
  const allowedSenders = ["owner", "agent", "system"];
  if (!allowedSenders.includes(sender)) throw new Error("INVALID_SENDER");

  const validTypes = [
    "owner_decision", "owner_question",
    "agent_question", "agent_suggestion", "agent_explanation",
    "validation_warning", "system_status"
  ];
  if (!validTypes.includes(messageType)) throw new Error("INVALID_MESSAGE_TYPE");

  // Validate sender / message_type matching
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
  session.updatedAt = new Date().toISOString();
  return message;
}

// ----------------------------------------------------
// 2. Blueprint Draft Management & Version Control
// ----------------------------------------------------

export function createBlueprintDraft(ownerId, agentId, universeId = null) {
  if (!ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (!agentId) throw new Error("AGENT_ID_REQUIRED");

  // Ensure there is only at most one active blueprint draft per agent
  const activeDrafts = [...drafts.values()].filter(d => d.agentId === agentId && d.isActive);
  if (activeDrafts.length > 0) {
    throw new Error("ACTIVE_BLUEPRINT_DRAFT_ALREADY_EXISTS_FOR_AGENT");
  }

  const draft = {
    id: randomUUID(),
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
  return draft;
}

export function getBlueprintDraft(ownerId, blueprintId) {
  const draft = drafts.get(blueprintId);
  if (!draft) throw new Error("BLUEPRINT_DRAFT_NOT_FOUND");
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  return draft;
}

/**
 * Owner answers must create a proposed change first, rather than directly overwriting the active blueprint draft.
 * Accepts expectedRevision for optimistic concurrency checking.
 */
export function saveBlueprintDecision(ownerId, blueprintId, sectionNo, decisionValue, expectedRevision, provenance = "direct_owner") {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  if (draft.revision !== expectedRevision) {
    throw new Error("STALE_WRITE_REJECTED");
  }

  const sec = BLUEPRINT_SECTIONS.find(s => s.no === sectionNo);
  if (!sec) throw new Error("INVALID_BLUEPRINT_SECTION_NUMBER");

  if (!decisionValue || decisionValue.trim().length === 0) {
    throw new Error("DECISION_VALUE_CANNOT_BE_EMPTY");
  }

  const allowedProv = ["direct_owner", "accepted_suggestion"];
  if (!allowedProv.includes(provenance)) throw new Error("INVALID_PROVENANCE_TYPE");

  // Create or update decision record
  const existing = [...decisions.values()].find(d => d.blueprintId === blueprintId && d.sectionNo === sectionNo);
  if (existing) {
    existing.decisionValue = decisionValue.trim();
    existing.provenance = provenance;
    existing.updatedAt = new Date().toISOString();
  } else {
    const dec = {
      id: randomUUID(),
      blueprintId,
      sectionNo,
      decisionValue: decisionValue.trim(),
      provenance,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    decisions.set(dec.id, dec);
  }

  // Synchronize snapshot field
  draft.snapshot[String(sectionNo)] = decisionValue.trim();
  draft.revision += 1;
  draft.updatedAt = new Date().toISOString();

  return draft;
}

/**
 * Propose suggestion with confidence validation (0 to 100 range)
 */
export function proposeAgentSuggestion(ownerId, agentId, blueprintId, sectionNo, suggestionValue, confidence = 100, provenance = "agent_recommendation") {
  const draft = drafts.get(blueprintId);
  if (!draft) throw new Error("BLUEPRINT_DRAFT_NOT_FOUND");
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
    status: "proposed", // 'proposed', 'accepted', 'rejected', 'superseded'
    provenance,
    confidence,
    decisionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  suggestions.set(sugg.id, sugg);
  draft.updatedAt = new Date().toISOString();
  return sugg;
}

export function acceptSuggestion(ownerId, blueprintId, suggestionId, expectedRevision) {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const sugg = suggestions.get(suggestionId);
  if (!sugg || sugg.blueprintId !== blueprintId) {
    throw new Error("SUGGESTION_NOT_FOUND");
  }
  if (sugg.status !== "proposed") {
    throw new Error("SUGGESTION_ALREADY_PROCESSED");
  }

  // Record owner decision (uses expectedRevision)
  saveBlueprintDecision(ownerId, blueprintId, sugg.sectionNo, sugg.suggestionValue, expectedRevision, "accepted_suggestion");

  // Retrieve decisionId to bind
  const decision = [...decisions.values()].find(d => d.blueprintId === blueprintId && d.sectionNo === sugg.sectionNo);
  sugg.status = "accepted";
  sugg.decisionId = decision ? decision.id : null;
  sugg.updatedAt = new Date().toISOString();

  // Supersede other suggestions in this section
  const related = [...suggestions.values()].filter(s => s.blueprintId === blueprintId && s.sectionNo === sugg.sectionNo && s.id !== suggestionId && s.status === "proposed");
  for (const s of related) {
    s.status = "superseded";
    s.updatedAt = new Date().toISOString();
  }

  draft.updatedAt = new Date().toISOString();
  return sugg;
}

export function rejectSuggestion(ownerId, blueprintId, suggestionId) {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const sugg = suggestions.get(suggestionId);
  if (!sugg || sugg.blueprintId !== blueprintId) {
    throw new Error("SUGGESTION_NOT_FOUND");
  }
  if (sugg.status !== "proposed") {
    throw new Error("SUGGESTION_ALREADY_PROCESSED");
  }

  sugg.status = "rejected";
  sugg.updatedAt = new Date().toISOString();
  draft.updatedAt = new Date().toISOString();
  return sugg;
}

/**
 * Configurable Interview Engine: Ask exactly one active question at a time.
 * Adding a question tracks its state. It can be linked to a communication session.
 */
export function raiseUnresolvedQuestion(ownerId, agentId, blueprintId, sectionNo, questionText, sessionId = null) {
  const draft = drafts.get(blueprintId);
  if (!draft) throw new Error("BLUEPRINT_DRAFT_NOT_FOUND");
  if (draft.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (draft.agentId !== agentId) throw new Error("CROSS_AGENT_MUTATION_REJECTED");
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const sec = BLUEPRINT_SECTIONS.find(s => s.no === sectionNo);
  if (!sec) throw new Error("INVALID_BLUEPRINT_SECTION_NUMBER");

  if (!questionText || questionText.trim().length === 0) {
    throw new Error("QUESTION_TEXT_CANNOT_BE_EMPTY");
  }

  // Active question block: If a session is linked, ensure there is only at most one active interview question.
  if (sessionId) {
    const session = getSession(ownerId, sessionId);
    if (session.activeQuestionId) {
      const activeQ = unresolvedQuestions.get(session.activeQuestionId);
      if (activeQ && activeQ.isActive) {
        throw new Error("SESSION_ALREADY_HAS_AN_ACTIVE_INTERVIEW_QUESTION");
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
    const session = getSession(ownerId, sessionId);
    session.activeQuestionId = q.id;
  }

  draft.updatedAt = new Date().toISOString();
  return q;
}

/**
 * Answering a question resolves it. Must pass expectedRevision of the blueprint draft.
 */
export function resolveQuestion(ownerId, blueprintId, questionId, decisionValue, expectedRevision) {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  const q = unresolvedQuestions.get(questionId);
  if (!q || q.blueprintId !== blueprintId) {
    throw new Error("QUESTION_NOT_FOUND");
  }
  if (!q.isActive) {
    throw new Error("QUESTION_ALREADY_RESOLVED");
  }

  // Answer question by recording a blueprint decision
  saveBlueprintDecision(ownerId, blueprintId, q.sectionNo, decisionValue, expectedRevision, "direct_owner");

  q.isActive = false;
  q.updatedAt = new Date().toISOString();

  // Clean active session question link if applicable
  if (q.sessionId) {
    const session = sessions.get(q.sessionId);
    if (session && session.activeQuestionId === q.id) {
      session.activeQuestionId = null;
    }
  }

  draft.updatedAt = new Date().toISOString();
  return q;
}

// ----------------------------------------------------
// 3. Draft Validation Engine
// ----------------------------------------------------

export function validateBlueprintDraft(ownerId, blueprintId) {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  const snapshot = draft.snapshot || {};

  const errors = [];
  const warnings = [];

  // 1. Complete validation across all 22 specific Interactive Interview sections
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

  // 2. Strict brand voice and content boundaries safety analysis
  const brandVoice = typeof snapshot["1"] === "string" ? snapshot["1"] : "";
  const boundaries = typeof snapshot["7"] === "string" ? snapshot["7"] : "";

  if (brandVoice.toLowerCase().includes("unsafe") || brandVoice.toLowerCase().includes("unfiltered")) {
    errors.push("Brand voice contains unsafe or prohibited terminology (e.g. 'unfiltered', 'unsafe').");
  }
  if (boundaries.trim().length > 0 && boundaries.trim().length < 10) {
    warnings.push("Content boundaries entry is exceptionally short; review for safety compliance.");
  }

  // 3. Automated check for any unresolved open-ended questions
  const openQuestions = [...unresolvedQuestions.values()].filter(q => q.blueprintId === blueprintId && q.isActive);
  if (openQuestions.length > 0) {
    errors.push(`Blueprint has ${openQuestions.length} unresolved active questions.`);
  }

  const isValid = errors.length === 0;
  const snapshotHash = computeBlueprintHash(snapshot);

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
  return result;
}

// ----------------------------------------------------
// 4. Version Control, Snapshotting & Approvals
// ----------------------------------------------------

export function createBlueprintVersion(ownerId, blueprintId) {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  if (!draft.isActive) throw new Error("BLUEPRINT_DRAFT_IS_INACTIVE");

  // Run validation
  const valResult = validateBlueprintDraft(ownerId, blueprintId);
  if (!valResult.isValid) {
    throw new Error("CANNOT_VERSION_INVALID_BLUEPRINT_DRAFT");
  }

  const snapshot = deepCopy(draft.snapshot);
  const snapshotHash = computeBlueprintHash(snapshot);

  const existing = [...versions.values()].filter(v => v.blueprintId === blueprintId);
  const versionNo = existing.length + 1;

  // Enforce zero-trust credential sanitization
  const cleanSnapshot = sanitizeSecrets(snapshot);

  const v = {
    id: randomUUID(),
    blueprintId,
    versionNo,
    snapshot: deepFreeze(cleanSnapshot),
    snapshotHash,
    status: "unapproved", // 'unapproved', 'approved', 'superseded'
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  versions.set(v.id, v);
  draft.updatedAt = new Date().toISOString();
  return v;
}

export function approveExactBlueprintVersion(ownerId, versionId, expectedHash) {
  if (!ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const version = versions.get(versionId);
  if (!version) throw new Error("BLUEPRINT_VERSION_NOT_FOUND");

  const draft = drafts.get(version.blueprintId);
  if (!draft || draft.ownerId !== ownerId) {
    throw new Error("OWNER_AUTHENTICATION_FAILED");
  }

  if (version.snapshotHash !== expectedHash) {
    throw new Error("SNAPSHOT_HASH_MISMATCH");
  }

  if (version.status === "approved") {
    throw new Error("VERSION_ALREADY_APPROVED");
  }

  // Create immutable owner approval
  const approval = {
    id: randomUUID(),
    blueprintVersionId: versionId,
    snapshotHash: version.snapshotHash,
    ownerId,
    approvedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  approvals.set(approval.id, approval);

  // Transition current version status
  version.status = "approved";
  version.updatedAt = new Date().toISOString();

  // Supersede other approved/unapproved versions for this blueprint draft
  const related = [...versions.values()].filter(v => v.blueprintId === version.blueprintId && v.id !== versionId);
  for (const rv of related) {
    if (rv.status === "approved") {
      rv.status = "superseded";
      rv.updatedAt = new Date().toISOString();
    }
  }

  // Deactivate draft to prevent further edits (immutable upon approval)
  draft.isActive = false;
  draft.updatedAt = new Date().toISOString();

  return approval;
}

export function retrieveActiveApprovedBlueprint(ownerId, agentId) {
  // Find approved versions belonging to an agent
  const agentDrafts = [...drafts.values()].filter(d => d.agentId === agentId && d.ownerId === ownerId);
  const draftIds = agentDrafts.map(d => d.id);

  const approved = [...versions.values()]
    .filter(v => draftIds.includes(v.blueprintId) && v.status === "approved")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return approved[0] || null;
}

// ----------------------------------------------------
// 5. Version Comparison Tools & Sanitized Context Previews
// ----------------------------------------------------

/**
 * Returns section-by-section comparison differences between two versions of a blueprint
 */
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

  return {
    blueprintId,
    versionIdA,
    versionIdB,
    hasDifferences: Object.keys(diff).length > 0,
    differences: diff
  };
}

/**
 * Previews sanitized, recursively-scrubbed context payload before committing / approving.
 */
export function previewSanitizedWorkerContext(ownerId, blueprintId) {
  const draft = getBlueprintDraft(ownerId, blueprintId);
  const rawContext = {
    blueprintId,
    agentId: draft.agentId,
    universeId: draft.universeId,
    snapshot: draft.snapshot,
    revision: draft.revision
  };

  return deepFreeze(sanitizeSecrets(deepCopy(rawContext)));
}
