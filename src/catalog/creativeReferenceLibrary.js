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
  let subClassification = "";

  if (host === "youtu.be") {
    const videoId = url.pathname.slice(1);
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new Error("MALFORMED_YOUTUBE_URL");
    }
    canonical = `https://www.youtube.com/watch?v=${videoId}`;
    subClassification = "youtube_video";
  } else {
    const searchParams = url.searchParams;
    if (searchParams.has("v")) {
      const videoId = searchParams.get("v");
      if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        throw new Error("MALFORMED_YOUTUBE_URL");
      }
      canonical = `https://www.youtube.com/watch?v=${videoId}`;
      subClassification = "youtube_video";
    } else if (searchParams.has("list")) {
      const listId = searchParams.get("list");
      if (!listId || !/^PL[a-zA-Z0-9_-]+$/.test(listId)) {
        throw new Error("MALFORMED_YOUTUBE_URL");
      }
      canonical = `https://www.youtube.com/playlist?list=${listId}`;
      subClassification = "youtube_playlist";
    } else if (url.pathname.startsWith("/channel/")) {
      const channelId = url.pathname.split("/")[2];
      if (!channelId || !/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
        throw new Error("MALFORMED_YOUTUBE_URL");
      }
      canonical = `https://www.youtube.com/channel/${channelId}`;
      subClassification = "youtube_channel";
    } else if (url.pathname.startsWith("/c/") || url.pathname.startsWith("/@")) {
      canonical = `https://www.youtube.com${url.pathname.replace(/\/$/, "")}`;
      subClassification = "youtube_channel";
    } else {
      throw new Error("MALFORMED_YOUTUBE_URL");
    }
  }
  return { canonical, subClassification };
}

export function createNicheReference(ownerId, universeId, input) {
  let canonicalUrl = "";
  let subClassification = "written_brief";

  if (input.url) {
    const result = canonicalizeSupportedYouTubeUrls(input.url);
    canonicalUrl = result.canonical;
    subClassification = result.subClassification;

    // Canonical duplicate check
    const isDuplicate = [...references.values()].some(
      (r) => r.universeId === universeId && r.referenceType === "niche" && r.canonicalUrl === canonicalUrl
    );
    if (isDuplicate) {
      throw new Error("DUPLICATE_CANONICAL_REFERENCE");
    }
  }

  const reference = {
    id: randomUUID(),
    ownerId,
    universeId,
    referenceType: "niche",
    subClassification,
    canonicalUrl,
    originalUrl: input.url || "",
    priority: input.priority ?? 100,
    isActive: input.isActive ?? true,
    status: "awaiting_analysis",
    revision: 1,
    title: input.title || "Untitled Niche Reference",
    writtenBrief: input.writtenBrief || "",
    ownerNotes: input.ownerNotes || "",
    desiredCharacteristics: input.desiredCharacteristics || "",
    prohibitedCharacteristics: input.prohibitedCharacteristics || "",
    language: input.language || "en",
    tags: input.tags || []
  };

  references.set(reference.id, reference);
  return reference;
}

export function createVisualReference(ownerId, universeId, input) {
  let canonicalUrl = "";
  let subClassification = "written_brief";

  if (input.url) {
    const result = canonicalizeSupportedYouTubeUrls(input.url);
    canonicalUrl = result.canonical;
    subClassification = result.subClassification;

    const isDuplicate = [...references.values()].some(
      (r) => r.universeId === universeId && r.referenceType === "visual" && r.canonicalUrl === canonicalUrl
    );
    if (isDuplicate) {
      throw new Error("DUPLICATE_CANONICAL_REFERENCE");
    }
  } else if (input.authorizedImageReference) {
    subClassification = "authorized_image";
  } else if (input.assetMetadataReference) {
    subClassification = "uploaded_asset_metadata";
  }

  const reference = {
    id: randomUUID(),
    ownerId,
    universeId,
    referenceType: "visual",
    subClassification,
    canonicalUrl,
    originalUrl: input.url || "",
    priority: input.priority ?? 100,
    isActive: input.isActive ?? true,
    status: "awaiting_analysis",
    revision: 1,
    title: input.title || "Untitled Visual Reference",
    authorizedImageReference: input.authorizedImageReference || "",
    assetMetadataReference: input.assetMetadataReference || null,
    writtenVisualBrief: input.writtenVisualBrief || "",
    startTimestamp: input.startTimestamp || null,
    endTimestamp: input.endTimestamp || null,
    ownerNotes: input.ownerNotes || "",
    desiredCharacteristics: input.desiredCharacteristics || "",
    prohibitedCharacteristics: input.prohibitedCharacteristics || "",
    tags: input.tags || [],
    declaredAuthorizationStatus: input.declaredAuthorizationStatus || "pending"
  };

  references.set(reference.id, reference);
  return reference;
}

export function updateReference(ownerId, referenceId, expectedRevision, updates) {
  const ref = references.get(referenceId);
  if (!ref) throw new Error("REFERENCE_NOT_FOUND");
  if (ref.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");
  if (ref.revision !== expectedRevision) throw new Error("STALE_WRITE_REJECTED");

  if (updates.status) {
    const validStatuses = ["submitted", "validation_failed", "awaiting_analysis", "analysis_in_progress", "analysis_failed", "draft_profile_ready", "awaiting_owner_review", "approved", "rejected", "inactive"];
    if (!validStatuses.includes(updates.status)) throw new Error("INVALID_STATUS");
    ref.status = updates.status;
  }
  if (updates.isActive !== undefined) ref.isActive = updates.isActive;

  ref.revision += 1;
  return ref;
}

export function createManualDraftProfile(ownerId, referenceId, snapshot) {
  const reference = references.get(referenceId);
  if (!reference) throw new Error("REFERENCE_NOT_FOUND");
  if (reference.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const existing = [...profiles.values()].filter((p) => p.referenceId === referenceId);
  const versionNo = existing.length + 1;
  const snapshotHash = computeProfileHash(snapshot);

  const profile = {
    id: randomUUID(),
    referenceId,
    profileType: reference.referenceType,
    versionNo,
    snapshot: deepFreeze(deepCopy(snapshot)),
    snapshotHash,
    status: "submitted",
    revision: 1
  };

  profiles.set(profile.id, profile);
  return profile;
}

export function updateProfileSnapshot(ownerId, profileId, expectedRevision, newSnapshot) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("PROFILE_NOT_FOUND");

  const reference = references.get(profile.referenceId);
  if (!reference || reference.ownerId !== ownerId) {
    throw new Error("OWNER_AUTHENTICATION_FAILED");
  }
  if (profile.revision !== expectedRevision) {
    throw new Error("STALE_WRITE_REJECTED");
  }
  if (profile.status === "approved" || profile.status === "active") {
    throw new Error("CANNOT_MODIFY_APPROVED_PROFILE");
  }

  profile.snapshot = deepFreeze(deepCopy(newSnapshot));
  profile.snapshotHash = computeProfileHash(newSnapshot);
  profile.revision += 1;
  return profile;
}

export function submitProfileForApproval(ownerId, profileId) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("PROFILE_NOT_FOUND");

  const reference = references.get(profile.referenceId);
  if (!reference || reference.ownerId !== ownerId) {
    throw new Error("OWNER_AUTHENTICATION_FAILED");
  }

  profile.status = "awaiting_owner_review";
  return profile;
}

export function approveExactProfileSnapshot(ownerId, profileId, expectedHash) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("PROFILE_NOT_FOUND");

  const reference = references.get(profile.referenceId);
  if (!reference || reference.ownerId !== ownerId) {
    throw new Error("OWNER_AUTHENTICATION_FAILED");
  }

  const currentHash = computeProfileHash(profile.snapshot);
  if (currentHash !== expectedHash) {
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

export function activateProfile(ownerId, profileId, approvalId) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("PROFILE_NOT_FOUND");

  const reference = references.get(profile.referenceId);
  if (!reference || reference.ownerId !== ownerId) {
    throw new Error("OWNER_AUTHENTICATION_FAILED");
  }

  const approval = approvals.get(approvalId);
  if (!approval || approval.profileId !== profileId || approval.ownerId !== ownerId) {
    throw new Error("PROFILE_ACTIVATION_REJECTED_WITHOUT_OWNER_APPROVAL");
  }

  const currentHash = computeProfileHash(profile.snapshot);
  if (currentHash !== approval.snapshotHash) {
    throw new Error("SNAPSHOT_HASH_MISMATCH");
  }

  const related = [...profiles.values()].filter((p) => p.referenceId === reference.id);
  for (const p of related) {
    if (p.status === "approved" && p.id !== profileId) {
      p.status = "inactive";
    }
  }

  profile.status = "approved";
  return profile;
}

export function deactivateReference(ownerId, referenceId) {
  const reference = references.get(referenceId);
  if (!reference) throw new Error("REFERENCE_NOT_FOUND");
  if (reference.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  reference.isActive = false;
  return reference;
}

export function assignReferenceScope(ownerId, referenceId, { scopeType, scopeTargetId, nicheProfileId, visualProfileId }) {
  const reference = references.get(referenceId);
  if (!reference) throw new Error("REFERENCE_NOT_FOUND");
  if (reference.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

  const allowedScopes = ["universe", "series", "season", "story_arc", "episode", "standalone_reel", "main_video_promo"];
  if (!allowedScopes.includes(scopeType)) {
    throw new Error("INVALID_SCOPE_TYPE");
  }

  const cleanId = String(scopeTargetId).trim();
  if (!cleanId || cleanId.toLowerCase().includes("unsupported") || cleanId.toLowerCase().includes("invalid")) {
    throw new Error("UNSUPPORTED_LIVE_ASSIGNMENT");
  }

  if (nicheProfileId) {
    const prof = profiles.get(nicheProfileId);
    if (!prof || prof.profileType !== "niche") {
      throw new Error("INVALID_PROFILE_TYPE_PLACEMENT");
    }
  }
  if (visualProfileId) {
    const prof = profiles.get(visualProfileId);
    if (!prof || prof.profileType !== "visual") {
      throw new Error("INVALID_PROFILE_TYPE_PLACEMENT");
    }
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
  const approved = [...profiles.values()]
    .filter((p) => p.referenceId === referenceId && p.profileType === "niche" && p.status === "approved")
    .sort((a, b) => b.versionNo - a.versionNo);

  return approved[0] || null;
}

export function retrieveLatestApprovedVisualProfile(referenceId) {
  const approved = [...profiles.values()]
    .filter((p) => p.referenceId === referenceId && p.profileType === "visual" && p.status === "approved")
    .sort((a, b) => b.versionNo - a.versionNo);

  return approved[0] || null;
}

export function buildSanitizedInternalWorkerContext(referenceId) {
  const reference = references.get(referenceId);
  if (!reference) throw new Error("REFERENCE_NOT_FOUND");

  const nicheProfile = retrieveLatestApprovedNicheProfile(referenceId);
  const visualProfile = retrieveLatestApprovedVisualProfile(referenceId);

  const nicheSnapshot = (reference.referenceType === "niche") ? (nicheProfile ? nicheProfile.snapshot : null) : null;
  const visualSnapshot = (reference.referenceType === "visual") ? (visualProfile ? visualProfile.snapshot : null) : null;

  return {
    referenceId,
    referenceType: reference.referenceType,
    canonicalUrl: reference.canonicalUrl,
    priority: reference.priority,
    status: reference.status,
    nicheSnapshot,
    visualSnapshot
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
