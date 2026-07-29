export const SUPPORTED_PLATFORMS = Object.freeze(["youtube", "instagram", "facebook", "snapchat"]);
export const CONNECTION_STATUSES = Object.freeze(["unconfigured", "connected", "expired", "disconnected"]);
export const PROFILE_STATUSES = Object.freeze(["draft", "active", "suspended"]);

const DASHBOARD_ALLOWLIST = new Set([
  "id", "agent_id", "agentId", "name", "namespace", "enabled",
  "public_brand_name", "publicBrandName", "public_display_name", "publicDisplayName",
  "public_description", "publicDescription", "default_language", "defaultLanguage", "status",
  "email_address", "emailAddress", "provider", "connection_status", "connectionStatus",
  "token_expires_at", "tokenExpiresAt", "reauthentication_required", "reauthenticationRequired",
  "is_primary", "isPrimary", "last_verified_at", "lastVerifiedAt", "created_at", "createdAt",
  "updated_at", "updatedAt", "platform", "public_account_name", "publicAccountName",
  "external_account_id", "externalAccountId", "public_profile_url", "publicProfileUrl",
  "oauth_scopes", "oauthScopes",
  // Container keys for nested representation
  "social_accounts", "socialAccounts", "email_connections", "emailConnections", "public_profile", "publicProfile"
]);

export function validatePublicProfile(profile) {
  if (!profile?.agentId) throw new Error("AGENT_ID_REQUIRED");
  if (!profile.publicBrandName?.trim()) throw new Error("PUBLIC_BRAND_NAME_REQUIRED");
  if (!profile.publicDisplayName?.trim()) throw new Error("PUBLIC_DISPLAY_NAME_REQUIRED");
  if (!PROFILE_STATUSES.includes(profile.status)) {
    throw new Error("INVALID_PROFILE_STATUS");
  }
  return true;
}

export function validateConnectionOwnership(agentId, resource) {
  if (!agentId || !resource?.agentId) {
    throw new Error("OWNERSHIP_VALIDATION_FAILED");
  }
  if (resource.agentId !== agentId) {
    throw new Error("CROSS_AGENT_ACCESS_DENIED");
  }
  return true;
}

export function isTokenExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt) <= new Date();
}

export function checkReauthenticationRequired(connection) {
  if (!connection) return false;
  if (connection.reauthenticationRequired === true) return true;
  if (connection.tokenExpiresAt && isTokenExpired(connection.tokenExpiresAt)) {
    return true;
  }
  if (connection.connectionStatus === "expired") return true;
  return false;
}

export function isInternalAgentName(name, agent) {
  if (!name || !agent) return false;
  const cleanName = String(name).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const cleanAgentName = String(agent.name || "").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const cleanAgentId = String(agent.id || "").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const cleanNamespace = String(agent.namespace || "").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

  if (cleanName === cleanAgentName || cleanName === cleanAgentId || cleanName === cleanNamespace) {
    return true;
  }

  const regexAgentName = new RegExp(`\\b${cleanAgentName}\\b`, "i");
  const regexAgentId = new RegExp(`\\b${cleanAgentId}\\b`, "i");
  if (regexAgentName.test(name) || regexAgentId.test(name)) {
    return true;
  }

  return false;
}

export function resolvePublicAttribution({ agentId, agent, profile, primarySocialAccount }) {
  if (!agentId) {
    return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
  }

  // Verify Profile belongs to agentId if profile is provided
  if (profile) {
    if (profile.agentId !== agentId) {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
  }

  // Verify Primary Social Account belongs to agentId and meets constraints
  if (primarySocialAccount) {
    if (primarySocialAccount.agentId !== agentId) {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
    if (primarySocialAccount.isPrimary !== true) {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
    if (!SUPPORTED_PLATFORMS.includes(primarySocialAccount.platform)) {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
    if (primarySocialAccount.connectionStatus !== "connected") {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
    if (checkReauthenticationRequired(primarySocialAccount)) {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
    if (primarySocialAccount.tokenExpiresAt && isTokenExpired(primarySocialAccount.tokenExpiresAt)) {
      return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
    }
  }

  const brand = (profile && profile.status === "active") ? profile.publicBrandName?.trim() : null;
  const social = (primarySocialAccount) ? primarySocialAccount.publicAccountName?.trim() : null;

  const resolved = social || brand;
  if (!resolved || resolved.trim() === "") {
    return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
  }

  if (agent && isInternalAgentName(resolved, agent)) {
    return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
  }

  return resolved;
}

export function serializeForDashboard(data) {
  if (Array.isArray(data)) {
    return data.map(serializeForDashboard);
  }
  if (data && typeof data === "object" && !(data instanceof Date)) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (DASHBOARD_ALLOWLIST.has(key)) {
        result[key] = serializeForDashboard(value);
      }
    }
    return result;
  }
  return data;
}
