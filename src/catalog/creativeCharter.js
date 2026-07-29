import { createHash, randomUUID } from "node:crypto";

// In-memory backing stores for policy validation
const charters = new Map();
const universes = new Map();
const assignments = new Map();
const approvals = new Map();

export function resetCreativeCharterRegistry() {
  charters.clear();
  universes.clear();
  assignments.clear();
  approvals.clear();
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
    versions: []
  };
  charters.set(charter.id, charter);
  return charter;
}

export function validateCharterStructure(charter) {
  if (!charter || !charter.id || !charter.name || !charter.vision) {
    throw new Error("INVALID_CHARTER_STRUCTURE");
  }
  return true;
}

export function createNewCharterVersion(charterId, snapshot) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  if (charter.status === "approved" || charter.status === "active") {
    throw new Error("CANNOT_MODIFY_APPROVED_CHARTER");
  }

  const versionNo = charter.versions.length + 1;
  const snapshotHash = computeSnapshotHash(snapshot);

  const version = {
    id: randomUUID(),
    charterId,
    versionNo,
    snapshot: Object.freeze({ ...snapshot }),
    snapshotHash,
    isApproved: false,
    isActive: false
  };

  charter.versions.push(version);
  return version;
}

export function submitCharterForOwnerApproval(charterId, versionNo) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  const version = charter.versions.find((v) => v.versionNo === versionNo);
  if (!version) throw new Error("CHARTER_VERSION_NOT_FOUND");
  return { charterId, versionNo, status: "pending_approval" };
}

export function approveExactImmutableVersion(ownerId, charterId, versionNo, { assignedAgentId, assignedUniverseId }) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
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

export function activateApprovedVersion(charterId, versionNo, approvalId) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  const version = charter.versions.find((v) => v.versionNo === versionNo);
  if (!version) throw new Error("CHARTER_VERSION_NOT_FOUND");

  const approval = approvals.get(approvalId);
  if (!approval || approval.charterVersionId !== version.id) {
    throw new Error("ACTIVATION_REJECTED_WITHOUT_OWNER_APPROVAL");
  }

  // Verify hash match dynamically to prevent snapshot tampering after approval
  const currentHash = computeSnapshotHash(version.snapshot);
  if (currentHash !== approval.snapshotHash) {
    throw new Error("APPROVAL_INVALID_FOR_MODIFIED_SNAPSHOT");
  }

  // Deactivate any previous active version
  for (const v of charter.versions) {
    v.isActive = false;
  }

  version.isActive = true;
  charter.status = "active";
  return { charterId, versionNo, isActive: true };
}

export function deactivateCharter(charterId) {
  const charter = charters.get(charterId);
  if (!charter) throw new Error("CHARTER_NOT_FOUND");
  charter.status = "inactive";
  for (const v of charter.versions) {
    v.isActive = false;
  }
  return { charterId, isActive: false };
}

export function assignCharterToInternalAgent(agentId, charterId, universeId, approvalId) {
  const approval = approvals.get(approvalId);
  if (!approval) throw new Error("ACTIVATION_REJECTED_WITHOUT_OWNER_APPROVAL");
  if (approval.assignedAgentId !== agentId) {
    throw new Error("APPROVAL_NOT_REUSABLE_FOR_ANOTHER_AGENT");
  }

  // Ensure safe handling of concurrent activation attempts & multiple active assignments per agent
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
    assignedAt: new Date().toISOString()
  };
  assignments.set(assignment.id, assignment);
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

  // Worker context can contain internal agentId, but never API keys, OAuth tokens or passwords
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

  // Strict internal agent name check to prevent exposure of internal worker identities
  const cleanName = resolved.toLowerCase().replace(/[_\-\.\s]+/g, "");
  const cleanAgentName = agent.name.toLowerCase().replace(/[_\-\.\s]+/g, "");
  const cleanAgentId = agent.id.toLowerCase().replace(/[_\-\.\s]+/g, "");

  if (cleanName.includes(cleanAgentName) || cleanName.includes(cleanAgentId)) {
    return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
  }

  // Preloaded registry checks
  const internalNames = ["JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA", "BYTE", "CHANAKYA", "KABIR", "SHAKTI", "ROHAN", "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA", "KARAN", "DEV", "AANYA", "ARJUN", "NISHA"];
  for (const name of internalNames) {
    if (cleanName.includes(name.toLowerCase().replace(/[_\-\.\s]+/g, ""))) {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
  }

  return resolved;
}

// ----------------------------------------------------
// LAKME Cosmic and Timeline Lazy Hierarchy resolution
// Universe -> Era or Yuga -> Source Collection -> Series -> Season -> Story Arc -> Episode
// ----------------------------------------------------
export class LakmeLazyHierarchy {
  constructor(universeId) {
    this.universeId = universeId;
  }

  resolveNodePath({ era, sourceCollection, series, season, storyArc, episodeNo }) {
    // Dynamically structures an episode coordinates on-demand
    // Supports more than 8,000 episodes without creating preloaded db rows.
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
