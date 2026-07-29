import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

const references = new Map();
const profiles = new Map();
const scopes = new Map();
const approvals = new Map();

export function resetCreativeReferenceRegistry() {
  references.clear();
  profiles.clear();
  scopes.clear();
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

export function computeProfileHash(snapshot) {
  return createHash("sha256")
    .update(stableStringify(snapshot))
    .digest("hex");
}

export function rejectUnsafeUrls(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("INVALID_URL_FORMAT");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("HTTPS_ONLY_REQUIRED");
  }

  if (parsed.username || parsed.password) {
    throw new Error("EMBEDDED_CREDENTIALS_PROHIBITED");
  }

  if (parsed.port && parsed.port !== "" && parsed.port !== "443") {
    throw new Error("NON_STANDARD_PORTS_PROHIBITED");
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || isIP(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("PRIVATE_OR_LOCALHOST_TARGET_REJECTED");
  }

  const allowedDomains = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
  if (!allowedDomains.includes(host)) {
    throw new Error("UNAPPROVED_DOMAIN_REJECTED");
  }

  return parsed;
}

export function canonicalizeSupportedYouTubeUrls(rawUrl) {
  const url = rejectUnsafeUrls(rawUrl);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  let canonical = "";
  if (host === "youtu.be") {
    const videoId = url.pathname.slice(1);
    if (!videoId) throw new Error("MALFORMED_YOUTUBE_URL");
    canonical = `https://www.youtube.com/watch?v=${videoId}`;
  } else {
    const searchParams = url.searchParams;
    if (searchParams.has("v")) {
      canonical = `https://www.youtube.com/watch?v=${searchParams.get("v")}`;
    } else if (searchParams.has("list")) {
      canonical = `https://www.youtube.com/playlist?list=${searchParams.get("list")}`;
    } else if (url.pathname.startsWith("/channel/") || url.pathname.startsWith("/c/") || url.pathname.startsWith("/@")) {
      canonical = `https://www.youtube.com${url.pathname.replace(/\/$/, "")}`;
    } else {
      throw new Error("MALFORMED_YOUTUBE_URL");
    }
  }
  return canonical;
}

export function createNicheReference(ownerId, universeId, { url, writtenBrief, ownerNotes, desiredCharacteristics, characteristicsToAvoid, language, priority }) {
  const canonicalUrl = canonicalizeSupportedYouTubeUrls(url);

  // Canonical-reference duplicate protection
  const isDuplicate = [...references.values()].some(
    (r) => r.universeId === universeId && r.referenceType === "niche" && r.canonicalUrl === canonicalUrl
  );
  if (isDuplicate) {
    throw new Error("DUPLICATE_CANONICAL_REFERENCE");
  }

  const reference = {
    id: randomUUID(),
    ownerId,
    universeId,
    referenceType: "niche",
    canonicalUrl,
    originalUrl: url,
    priority: priority ?? 100,
    isActive: true,
    status: "awaiting_analysis",
    writtenBrief,
    ownerNotes,
    desiredCharacteristics,
    characteristicsToAvoid,
    language: language ?? "en"
  };

  references.set(reference.id, reference);
  return reference;
}

export function createVisualReference(ownerId, universeId, { url, writtenVisualBrief, ownerNotes, desiredVisualCharacteristics, characteristicsToAvoid, priority }) {
  const canonicalUrl = canonicalizeSupportedYouTubeUrls(url);

  const isDuplicate = [...references.values()].some(
    (r) => r.universeId === universeId && r.referenceType === "visual" && r.canonicalUrl === canonicalUrl
  );
  if (isDuplicate) {
    throw new Error("DUPLICATE_CANONICAL_REFERENCE");
  }

  const reference = {
    id: randomUUID(),
    ownerId,
    universeId,
    referenceType: "visual",
    canonicalUrl,
    originalUrl: url,
    priority: priority ?? 100,
    isActive: true,
    status: "awaiting_analysis",
    writtenVisualBrief,
    ownerNotes,
    desiredVisualCharacteristics,
    characteristicsToAvoid
  };

  references.set(reference.id, reference);
  return reference;
}

export function createManualDraftProfile(referenceId, snapshot) {
  const reference = references.get(referenceId);
  if (!reference) throw new Error("REFERENCE_NOT_FOUND");

  const existing = [...profiles.values()].filter((p) => p.referenceId === referenceId);
  const versionNo = existing.length + 1;
  const snapshotHash = computeProfileHash(snapshot);

  const profile = {
    id: randomUUID(),
    referenceId,
    versionNo,
    snapshot: Object.freeze({ ...snapshot }),
    snapshotHash,
    status: "draft"
  };

  profiles.set(profile.id, profile);
  return profile;
}

export function submitProfileForApproval(profileId) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("PROFILE_NOT_FOUND");
  profile.status = "pending_approval";
  return profile;
}

export function approveExactProfileSnapshot(ownerId, profileId, expectedHash) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("PROFILE_NOT_FOUND");

  if (profile.snapshotHash !== expectedHash) {
    throw new Error("SNAPSHOT_HASH_MISMATCH");
  }

  const approval = {
    id: randomUUID(),
    profileId,
    snapshotHash: profile.snapshotHash,
    ownerId,
    approvedAt: new Date().toISOString()
  };

  approvals.set(approval.id, approval);
  profile.status = "approved";
  return approval;
}

export function rejectEditsToApprovedImmutableProfiles(profileId) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("PROFILE_NOT_FOUND");
  if (profile.status === "approved" || profile.status === "active") {
    throw new Error("CANNOT_MODIFY_APPROVED_PROFILE");
  }
}

export function updateProfileSnapshot(profileId, newSnapshot) {
  rejectEditsToApprovedImmutableProfiles(profileId);
  const profile = profiles.get(profileId);
  profile.snapshot = Object.freeze({ ...newSnapshot });
  profile.snapshotHash = computeProfileHash(newSnapshot);
  return profile;
}

export function activateProfile(profileId, approvalId) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("PROFILE_NOT_FOUND");

  const approval = approvals.get(approvalId);
  if (!approval || approval.profileId !== profileId) {
    throw new Error("PROFILE_ACTIVATION_REJECTED_WITHOUT_OWNER_APPROVAL");
  }

  const reference = references.get(profile.referenceId);
  // Deactivate other profiles for same reference
  const related = [...profiles.values()].filter((p) => p.referenceId === reference.id);
  for (const r of related) {
    if (r.status === "active") r.status = "inactive";
  }

  profile.status = "active";
  return profile;
}

export function deactivateReference(referenceId) {
  const reference = references.get(referenceId);
  if (!reference) throw new Error("REFERENCE_NOT_FOUND");
  reference.isActive = false;
  return reference;
}

export function assignReferenceScope(referenceId, { scopeType, scopeTargetId, nicheProfileId, visualProfileId }) {
  const reference = references.get(referenceId);
  if (!reference) throw new Error("REFERENCE_NOT_FOUND");

  const allowedScopes = ["universe", "series", "season", "story_arc", "episode", "standalone_reel", "main_video_promo"];
  if (!allowedScopes.includes(scopeType)) {
    throw new Error("INVALID_SCOPE_TYPE");
  }

  const assignment = {
    id: randomUUID(),
    referenceId,
    nicheProfileId: nicheProfileId || null,
    visualProfileId: visualProfileId || null,
    scopeType,
    scopeTargetId,
    isActive: true
  };

  scopes.set(assignment.id, assignment);
  return assignment;
}

export function retrieveLatestApprovedNicheProfile(referenceId) {
  const active = [...profiles.values()].find(
    (p) => p.referenceId === referenceId && p.status === "active"
  );
  if (active) return active;

  const approved = [...profiles.values()]
    .filter((p) => p.referenceId === referenceId && p.status === "approved")
    .sort((a, b) => b.versionNo - a.versionNo);

  return approved[0] || null;
}

export function retrieveLatestApprovedVisualProfile(referenceId) {
  const active = [...profiles.values()].find(
    (p) => p.referenceId === referenceId && p.status === "active"
  );
  if (active) return active;

  const approved = [...profiles.values()]
    .filter((p) => p.referenceId === referenceId && p.status === "approved")
    .sort((a, b) => b.versionNo - a.versionNo);

  return approved[0] || null;
}

export function buildSanitizedInternalWorkerContext(referenceId) {
  const reference = references.get(referenceId);
  if (!reference) throw new Error("REFERENCE_NOT_FOUND");

  const nicheProfile = retrieveLatestApprovedNicheProfile(referenceId);
  const visualProfile = retrieveLatestApprovedVisualProfile(referenceId);

  // Worker context must be sanitized, removing credentials, secrets, tokens, etc.
  return {
    referenceId,
    referenceType: reference.referenceType,
    canonicalUrl: reference.canonicalUrl,
    priority: reference.priority,
    status: reference.status,
    nicheSnapshot: nicheProfile ? nicheProfile.snapshot : null,
    visualSnapshot: visualProfile ? visualProfile.snapshot : null
  };
}

export function preventInternalAgentNames(name, agent) {
  if (!name || !agent) return false;
  const cleanName = String(name).toLowerCase().replace(/[_\-\.\s]+/g, "");
  const cleanAgentName = String(agent.name || "").toLowerCase().replace(/[_\-\.\s]+/g, "");
  const cleanAgentId = String(agent.id || "").toLowerCase().replace(/[_\-\.\s]+/g, "");

  if (cleanName.includes(cleanAgentName) || cleanName.includes(cleanAgentId)) {
    return true;
  }

  const internalNames = ["JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA", "BYTE", "CHANAKYA", "KABIR", "SHAKTI", "ROHAN", "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA", "KARAN", "DEV", "AANYA", "ARJUN", "NISHA"];
  for (const item of internalNames) {
    if (cleanName.includes(item.toLowerCase().replace(/[_\-\.\s]+/g, ""))) {
      return true;
    }
  }

  return false;
}
