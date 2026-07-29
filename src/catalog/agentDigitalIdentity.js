export const SUPPORTED_PLATFORMS = Object.freeze(["youtube", "instagram", "facebook", "snapchat"]);
export const CONNECTION_STATUSES = Object.freeze(["unconfigured", "connected", "expired", "disconnected"]);
export const PROFILE_STATUSES = Object.freeze(["draft", "active", "suspended"]);

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

export function resolvePublicAttribution({ profile, primarySocialAccount }) {
  const brand = (profile && profile.status === "active") ? profile.publicBrandName?.trim() : null;
  const social = (primarySocialAccount &&
                  primarySocialAccount.connectionStatus === "connected" &&
                  !checkReauthenticationRequired(primarySocialAccount))
    ? primarySocialAccount.publicAccountName?.trim()
    : null;

  const resolved = social || brand;
  if (!resolved) {
    return "PUBLIC_PUBLISHING_IDENTITY_REQUIRED";
  }

  // Explicitly ensure we never output internal agent names like JARVIS, PANCHI, etc.
  const internalNames = ["JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA", "BYTE", "CHANAKYA", "KABIR", "SHAKTI", "ROHAN", "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA", "KARAN", "DEV", "AANYA", "ARJUN", "NISHA"];
  if (internalNames.includes(resolved.toUpperCase())) {
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
    const sensitiveKeys = [/secret/i, /token/i, /password/i, /key/i, /credential/i, /private/i];
    for (const [key, value] of Object.entries(data)) {
      const isSensitive = sensitiveKeys.some((regex) => regex.test(key));
      if (isSensitive) {
        continue; // Strip entirely
      }
      result[key] = serializeForDashboard(value);
    }
    return result;
  }
  return data;
}
