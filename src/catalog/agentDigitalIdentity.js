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

export function normalizeForPunctuation(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/[_\-\.\s\p{P}]+/gu, "");
}

export function isInternalAgentName(publicName, agent) {
  if (!publicName || !agent) return false;

  const normPublic = normalizeForPunctuation(publicName);
  const normAgentName = normalizeForPunctuation(agent.name);
  const normAgentId = normalizeForPunctuation(agent.id);
  const normAgentNamespace = normalizeForPunctuation(agent.namespace);

  if (normAgentName && normPublic.includes(normAgentName)) {
    return true;
  }
  if (normAgentId && normPublic.includes(normAgentId)) {
    return true;
  }
  if (normAgentNamespace && normPublic.includes(normAgentNamespace)) {
    return true;
  }

  return false;
}

export function resolvePublicAttribution({ agentId, agent, profile, primarySocialAccount }) {
  if (!agentId || !agent) {
    throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
  }

  let resolved = null;
  let sourceType = null;
  let sourceId = null;

  if (profile) {
    if (profile.agentId !== agentId) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (profile.status !== "active") {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    resolved = profile.publicBrandName?.trim();
    sourceType = "public_profile";
    sourceId = profile.agent_id || profile.agentId;
  }

  if (primarySocialAccount) {
    if (primarySocialAccount.agentId !== agentId) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (primarySocialAccount.isPrimary !== true) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (!SUPPORTED_PLATFORMS.includes(primarySocialAccount.platform)) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (primarySocialAccount.connectionStatus !== "connected") {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (checkReauthenticationRequired(primarySocialAccount)) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }
    if (primarySocialAccount.tokenExpiresAt && isTokenExpired(primarySocialAccount.tokenExpiresAt)) {
      throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
    }

    // Social account connection takes precedence if both exist
    resolved = primarySocialAccount.publicAccountName?.trim();
    sourceType = "social_account";
    sourceId = primarySocialAccount.id;
  }

  if (!resolved || resolved.trim() === "") {
    throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
  }

  if (isInternalAgentName(resolved, agent)) {
    throw new Error("PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
  }

  return {
    sourceAgentId: agentId,
    publicAttribution: resolved,
    sourceType,
    sourceId,
    isValid: true
  };
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
