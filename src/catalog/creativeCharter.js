import { createHash, randomUUID } from "node:crypto";

const charters = new Map();
const assignments = new Map();
const approvals = new Map();

export function resetCreativeCharterRegistry() {
  charters.clear();
  assignments.clear();
  approvals.clear();
}

export function deepFreeze(obj) {
  if (obj && typeof obj === "object") {
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
      deepFreeze(obj[key]);
    }
  }
  return obj;
}

export function deepCopy(obj) {
  if (obj === undefined) return undefined;
  return JSON.parse(JSON.stringify(obj));
}

function stableStringify(obj) {
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `"${k}":${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

export function computeSnapshotHash(snapshot) {
  return createHash("sha256")
    .update(stableStringify(snapshot))
    .digest("hex");
}

export function createDraftCharter(ownerId, { name, vision, defaultLanguage, secondaryLanguage }) {
  if (!name || !name.trim()) throw new Error("CHARTER_NAME_REQUIRED");
  if (!vision || !vision.trim()) throw new Error("CHARTER_VISION_REQUIRED");
  if (!defaultLanguage) throw new Error("DEFAULT_LANGUAGE_REQUIRED");

  const charter = {
    id: randomUUID(),
    ownerId,
    name: name.trim(),
    vision: vision.trim(),
    defaultLanguage,
    secondaryLanguage,
    status: "draft",
    revision: 1,
    versions: []
  };
  charters.set(charter.id, charter);
  return charter;
}

export function updateDraftCharter(ownerId, charterId, expectedRevision, updates) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  if (charter.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (charter.revision !== expectedRevision) throw new Error("STALE_WRITE_REJECTED");
  if (charter.status === "approved" || charter.status === "active") {
    throw new Error("CANNOT_MODIFY_APPROVED_CHARTER");
  }

  if (updates.name) charter.name = updates.name.trim();
  if (updates.vision) charter.vision = updates.vision.trim();
  if (updates.defaultLanguage) charter.defaultLanguage = updates.defaultLanguage;
  if (updates.secondaryLanguage) charter.secondaryLanguage = updates.secondaryLanguage;

  charter.revision += 1;
  return charter;
}

export function createNewCharterVersion(ownerId, charterId, snapshot) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  if (charter.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (charter.status === "approved" || charter.status === "active") {
    throw new Error("CANNOT_MODIFY_APPROVED_CHARTER");
  }

  const versionNo = charter.versions.length + 1;
  const snapshotHash = computeSnapshotHash(snapshot);

  const version = {
    id: randomUUID(),
    charterId,
    versionNo,
    snapshot: deepFreeze(deepCopy(snapshot)),
    snapshotHash,
    isApproved: false,
    isActive: false,
    revision: 1
  };

  charter.versions.push(version);
  return version;
}

export function submitCharterForOwnerApproval(ownerId, charterId, versionNo) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  if (charter.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const version = charter.versions.find((v) => v.versionNo === versionNo);
  if (!version) throw new Error("CHARTER_VERSION_NOT_FOUND");
  return { charterId, versionNo, status: "pending_approval" };
}

export function approveExactImmutableVersion(ownerId, charterId, versionNo, { assignedAgentId, assignedUniverseId }) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  if (charter.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const version = charter.versions.find((v) => v.versionNo === versionNo);
  if (!version) throw new Error("CHARTER_VERSION_NOT_FOUND");

  const approvalId = randomUUID();
  const approval = {
    id: approvalId,
    charterVersionId: version.id,
    snapshotHash: version.snapshotHash,
    assignedAgentId,
    assignedUniverseId,
    ownerId,
    approvedAt: new Date().toISOString()
  };

  approvals.set(approval.id, approval);
  version.isApproved = true;
  charter.status = "approved";
  return approval;
}

export function activateApprovedVersion(ownerId, charterId, versionNo, approvalId) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  if (charter.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const version = charter.versions.find((v) => v.versionNo === versionNo);
  if (!version) throw new Error("CHARTER_VERSION_NOT_FOUND");

  const approval = approvals.get(approvalId);
  if (!approval || approval.charterVersionId !== version.id || approval.ownerId !== ownerId) {
    throw new Error("ACTIVATION_REJECTED_WITHOUT_OWNER_APPROVAL");
  }

  // Deep copy and verify hash dynamically to prevent snapshot tampering after approval
  const currentHash = computeSnapshotHash(version.snapshot);
  if (currentHash !== approval.snapshotHash) {
    throw new Error("APPROVAL_INVALID_FOR_MODIFIED_SNAPSHOT");
  }

  for (const v of charter.versions) {
    v.isActive = false;
  }

  version.isActive = true;
  charter.status = "active";
  return { charterId, versionNo, isActive: true };
}

export function deactivateCharter(ownerId, charterId) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  if (charter.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  charter.status = "inactive";
  for (const v of charter.versions) {
    v.isActive = false;
  }
  return { charterId, isActive: false };
}

export function assignCharterToInternalAgent(ownerId, agentId, charterId, universeId, approvalId) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  if (charter.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const approval = approvals.get(approvalId);
  if (!approval || approval.ownerId !== ownerId) {
    throw new Error("ACTIVATION_REJECTED_WITHOUT_OWNER_APPROVAL");
  }
  if (approval.assignedAgentId !== agentId) {
    throw new Error("APPROVAL_NOT_REUSABLE_FOR_ANOTHER_AGENT");
  }
  if (approval.assignedUniverseId !== universeId) {
    throw new Error("APPROVAL_NOT_REUSABLE_FOR_ANOTHER_UNIVERSE");
  }

  const activeVersion = charter.versions.find((v) => v.isActive && v.isApproved);
  if (!activeVersion || activeVersion.id !== approval.charterVersionId) {
    throw new Error("ACTIVATION_REJECTED_WITHOUT_OWNER_APPROVAL");
  }

  // Safe handling of concurrent activations & multiple active assignments per agent
  const existingActive = [...assignments.values()].find((a) => a.agentId === agentId && a.isActive);
  if (existingActive && existingActive.charterId !== charterId) {
    throw new Error("MULTIPLE_ACTIVE_ASSIGNMENTS_REJECTED");
  }

  const assignment = {
    id: randomUUID(),
    agentId,
    charterId,
    universeId,
    isActive: true,
    revision: 1,
    assignedAt: new Date().toISOString()
  };
  assignments.set(assignment.id, assignment);
  return assignment;
}

export function updateAssignment(ownerId, assignmentId, expectedRevision, updates) {
  const assignment = assignments.get(assignmentId);
  if (!assignment) throw new Error("ASSIGNMENT_NOT_FOUND");
  const charter = charters.get(assignment.charterId);
  if (!charter || charter.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (assignment.revision !== expectedRevision) throw new Error("STALE_WRITE_REJECTED");

  if (updates.isActive !== undefined) {
    assignment.isActive = updates.isActive;
  }

  assignment.revision += 1;
  return assignment;
}

export function retrieveActiveCharter(agentId) {
  const assignment = [...assignments.values()].find((a) => a.agentId === agentId && a.isActive);
  if (!assignment) return null;
  const charter = charters.get(assignment.charterId);
  return charter || null;
}

export function generateSanitizedWorkerContext(agentId) {
  const charter = retrieveActiveCharter(agentId);
  if (!charter) return null;

  const activeVersion = charter.versions.find((v) => v.isActive);
  const snapshot = activeVersion ? activeVersion.snapshot : {};

  return {
    agentId,
    charterId: charter.id,
    vision: charter.vision,
    defaultLanguage: charter.defaultLanguage,
    secondaryLanguage: charter.secondaryLanguage,
    snapshot: Object.freeze({
      universeType: snapshot.universeType,
      narrator: snapshot.narrator,
      sourceCategories: snapshot.sourceCategories,
      lazyHierarchy: snapshot.lazyHierarchy,
      bibleSummary: snapshot.bibleSummary
    })
  };
}

export function generateSanitizedPublicAttribution({ profile, primarySocialAccount, agent }) {
  if (!agent) {
    return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
  }

  const brand = (profile && profile.status === "active") ? profile.publicBrandName?.trim() : null;
  const social = (primarySocialAccount && primarySocialAccount.connectionStatus === "connected")
    ? primarySocialAccount.publicAccountName?.trim()
    : null;

  const resolved = social || brand;
  if (!resolved || resolved.trim() === "") {
    return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
  }

  const cleanName = resolved.toLowerCase().replace(/[_\-\.\s]+/g, "");
  const cleanAgentName = agent.name.toLowerCase().replace(/[_\-\.\s]+/g, "");
  const cleanAgentId = agent.id.toLowerCase().replace(/[_\-\.\s]+/g, "");

  if (cleanName.includes(cleanAgentName) || cleanName.includes(cleanAgentId)) {
    return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
  }

  const internalNames = ["JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA", "BYTE", "CHANAKYA", "KABIR", "SHAKTI", "ROHAN", "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA", "KARAN", "DEV", "AANYA", "ARJUN", "NISHA"];
  for (const name of internalNames) {
    if (cleanName.includes(name.toLowerCase().replace(/[_\-\.\s]+/g, ""))) {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
  }

  return resolved;
}

// ----------------------------------------------------
// Idempotent Seeding Implementation
// ----------------------------------------------------
export function initializeSeedState(ownerId) {
  resetCreativeCharterRegistry();

  // 1. Seed JARVIS
  const jarvisCharter = createDraftCharter(ownerId, {
    name: "JARVIS Show Charter",
    vision: "A connected, long-running cinematic universe designed to produce stories and episodes for many years.",
    defaultLanguage: "Hindi",
    secondaryLanguage: "Hinglish"
  });
  const jarvisSnapshot = {
    universeType: "Hindi/Hinglish Horror Cinematic Universe",
    genresAndThemes: ["horror", "suspense", "thriller", "supernatural mystery", "curses", "crime", "emotion", "entertainment"],
    universeBible: {
      recurringCharacters: [],
      supernaturalEntities: [],
      cursedObjects: [],
      curseRules: [],
      organizations: [],
      historicalEvents: [],
      storyArcs: [],
      episodeContinuity: [],
      universeTimeline: [],
      characterRelationships: [],
      crossovers: [],
      callbacks: [],
      unresolvedMysteries: [],
      postCreditContinuity: [],
      canonAndNonCanon: []
    }
  };
  const jVersion = createNewCharterVersion(ownerId, jarvisCharter.id, jarvisSnapshot);
  const jApproval = approveExactImmutableVersion(ownerId, jarvisCharter.id, jVersion.versionNo, {
    assignedAgentId: "agent-01",
    assignedUniverseId: "universe-horror-jarvis-uuid"
  });
  activateApprovedVersion(ownerId, jarvisCharter.id, jVersion.versionNo, jApproval.id);
  assignCharterToInternalAgent(ownerId, "agent-01", jarvisCharter.id, "universe-horror-jarvis-uuid", jApproval.id);

  // 2. Seed LAKME
  const lakmeCharter = createDraftCharter(ownerId, {
    name: "LAKME Mythology Charter",
    vision: "Respectful treatment of Hindu traditions presenting timeline of cosmic and historical events.",
    defaultLanguage: "Hindi"
  });
  const lakmeSnapshot = {
    universeType: "Hindu Mythology Universe",
    narrator: {
      identity: "Samay (Time)",
      concept: "Samay narrates events according to their position in the cosmic and historical timeline."
    },
    sacredTerminology: "Sanskrit with Hindi explanations.",
    sourceCategories: ["Vedas", "Puranas", "Upanishads", "Ramayana", "Mahabharata"],
    claimSafetyClassifications: {
      directlySupported: "directly supported by a cited source",
      traditionalVersion: "traditional or regional version",
      interpretation: "scholarly or narrative interpretation",
      dramatizedConnective: "dramatized connective material",
      ownerApprovedFictional: "owner-approved fictionalization"
    }
  };
  const lVersion = createNewCharterVersion(ownerId, lakmeCharter.id, lakmeSnapshot);
  const lApproval = approveExactImmutableVersion(ownerId, lakmeCharter.id, lVersion.versionNo, {
    assignedAgentId: "agent-03",
    assignedUniverseId: "universe-mythology-lakme-uuid"
  });
  activateApprovedVersion(ownerId, lakmeCharter.id, lVersion.versionNo, lApproval.id);
  assignCharterToInternalAgent(ownerId, "agent-03", lakmeCharter.id, "universe-mythology-lakme-uuid", lApproval.id);
}

// LAKME Cosmic and Timeline Lazy Hierarchy resolution
export class LakmeLazyHierarchy {
  constructor(universeId) {
    this.universeId = universeId;
  }

  resolveNodePath({ era, sourceCollection, series, season, storyArc, episodeNo }) {
    const path = [];
    if (era) path.push({ level: "Era_or_Yuga", name: era });
    if (sourceCollection) path.push({ level: "Source_Collection", name: sourceCollection });
    if (series) path.push({ level: "Series", name: series });
    if (season) path.push({ level: "Season", name: `Season ${season}` });
    if (storyArc) path.push({ level: "Story_Arc", name: storyArc });
    if (episodeNo) path.push({ level: "Episode", name: `Episode ${episodeNo}` });

    return {
      universeId: this.universeId,
      path,
      formattedReference: path.map((p) => p.name).join(" → ")
    };
  }
}
