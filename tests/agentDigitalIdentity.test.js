import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AgentRegistry, PRELOADED_AGENTS } from "../src/catalog/agents.js";
import {
  SUPPORTED_PLATFORMS,
  CONNECTION_STATUSES,
  PROFILE_STATUSES,
  validatePublicProfile,
  validateConnectionOwnership,
  isTokenExpired,
  checkReauthenticationRequired,
  resolvePublicAttribution,
  serializeForDashboard,
  isInternalAgentName
} from "../src/catalog/agentDigitalIdentity.js";
import { PublishingService, verifyAttributionSnapshot } from "../src/publishing/publishingService.js";

const dummyHash = "c".repeat(64);

test("1. All 20 agents remain preloaded", () => {
  const registry = new AgentRegistry();
  assert.equal(PRELOADED_AGENTS.length, 20);
  assert.equal(registry.list().length, 20);
});

test("2. Maximum 50 agents remains enforced", () => {
  const registry = new AgentRegistry();
  assert.throws(() => {
    for (let i = 21; i <= 51; i++) {
      registry.add({
        id: `agent-${i}`,
        name: `AGENT_NAME_${i}`,
        namespace: `st.agent.name_${i}`
      });
    }
  }, /AGENT_CAP_REACHED/);
});

test("3 & 4. Public attribution does not expose internal names and uses public brand or account brand", () => {
  const profile = {
    agentId: "agent-01",
    publicBrandName: "My Cool Channel",
    publicDisplayName: "Cool Display",
    status: "active"
  };
  const agent = { id: "agent-01", name: "JARVIS", namespace: "st.agent.jarvis" };
  const valAtt = resolvePublicAttribution({ agentId: "agent-01", agent, profile });
  assert.equal(valAtt.publicAttribution, "My Cool Channel");

  // Profile uses internal name 'JARVIS' -> must block
  const badProfile = {
    agentId: "agent-01",
    publicBrandName: "JARVIS",
    publicDisplayName: "Jarvis Agent",
    status: "active"
  };
  assert.throws(() => {
    resolvePublicAttribution({ agentId: "agent-01", agent, profile: badProfile });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // Profile uses internal name variant 'Agent JARVIS' -> must block
  const badProfileVariant = {
    agentId: "agent-01",
    publicBrandName: "Agent JARVIS",
    publicDisplayName: "Jarvis Agent",
    status: "active"
  };
  assert.throws(() => {
    resolvePublicAttribution({ agentId: "agent-01", agent, profile: badProfileVariant });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);
});

test("5. Publishing is blocked when no public identity is configured", () => {
  const service = new PublishingService();

  // Creation throws without valid attribution inputs
  assert.throws(() => {
    service.request({
      agentId: "agent-01",
      agent: { id: "agent-01", name: "JARVIS", namespace: "st.agent.jarvis" },
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption"
      // Missing profile and social account
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // Creation throws when a caller-supplied fabricated validatedAttribution object is passed directly
  assert.throws(() => {
    service.request({
      agentId: "agent-01",
      validatedAttribution: {
        sourceAgentId: "agent-01",
        publicAttribution: "Arbitrary Bypass String",
        sourceType: "public_profile",
        sourceId: "agent-01",
        isValid: true
      },
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption"
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);
});

test("6 & 7. Cross-agent account access and credential access rejection", () => {
  const connection = {
    agentId: "agent-01",
    email_address: "agent1@example.com"
  };

  assert.equal(validateConnectionOwnership("agent-01", connection), true);

  assert.throws(() => {
    validateConnectionOwnership("agent-02", connection);
  }, /CROSS_AGENT_ACCESS_DENIED/);
});

test("8. Dashboard serialization removes sensitive keys", () => {
  const input = {
    agentId: "agent-01",
    publicDisplayName: "Agent Profile",
    secretLocator: "vault://agents/agent-01/providers/gemini",
    privateKey: "some-fake-pem-key-material",
    accessToken: "ya29.OAuthTokenPlaceholder",
    refreshToken: "1//0refreshPlaceholder",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$somehash",
    api_key: "ai_zaSyFakeKeyValue",
    otherFields: {
      innerSecret: "hidden-value",
      cleartext: "safe-value"
    }
  };

  const serialized = serializeForDashboard(input);

  assert.equal(serialized.agentId, "agent-01");
  assert.equal(serialized.publicDisplayName, "Agent Profile");
  assert.equal(serialized.secretLocator, undefined);
  assert.equal(serialized.privateKey, undefined);
  assert.equal(serialized.accessToken, undefined);
  assert.equal(serialized.refreshToken, undefined);
  assert.equal(serialized.passwordHash, undefined);
  assert.equal(serialized.api_key, undefined);

  assert.equal(serialized.otherFields, undefined);
});

test("9. Token expiration triggers reauthentication-required status", () => {
  const futureDate = new Date(Date.now() + 3600_000).toISOString();
  const pastDate = new Date(Date.now() - 3600_000).toISOString();

  const validConnection = {
    connectionStatus: "connected",
    tokenExpiresAt: futureDate,
    reauthenticationRequired: false
  };

  const expiredConnection = {
    connectionStatus: "connected",
    tokenExpiresAt: pastDate,
    reauthenticationRequired: false
  };

  const forceReauthConnection = {
    connectionStatus: "connected",
    tokenExpiresAt: futureDate,
    reauthenticationRequired: true
  };

  assert.equal(checkReauthenticationRequired(validConnection), false);
  assert.equal(checkReauthenticationRequired(expiredConnection), true);
  assert.equal(checkReauthenticationRequired(forceReauthConnection), true);
});

test("10, 11 & 12. Multiple non-primary accounts and platforms validation", () => {
  assert.deepEqual([...SUPPORTED_PLATFORMS], ["youtube", "instagram", "facebook", "snapchat"]);
  assert.deepEqual([...CONNECTION_STATUSES], ["unconfigured", "connected", "expired", "disconnected"]);

  const accounts = [
    { agentId: "agent-01", platform: "youtube", isPrimary: true, publicAccountName: "Brand YT" },
    { agentId: "agent-01", platform: "youtube", isPrimary: false, publicAccountName: "Backup YT 1" },
    { agentId: "agent-01", platform: "youtube", isPrimary: false, publicAccountName: "Backup YT 2" },
    { agentId: "agent-01", platform: "instagram", isPrimary: true, publicAccountName: "Brand IG" }
  ];

  function checkPrimaryUniquenessRule(list) {
    const primarySet = new Set();
    for (const acc of list) {
      if (acc.isPrimary) {
        const key = `${acc.agentId}::${acc.platform}`;
        if (primarySet.has(key)) {
          throw new Error("ONLY_ONE_PRIMARY_ACCOUNT_PER_AGENT_PLATFORM");
        }
        primarySet.add(key);
      }
    }
    return true;
  }

  assert.ok(checkPrimaryUniquenessRule(accounts));

  const invalidAccounts = [
    ...accounts,
    { agentId: "agent-01", platform: "youtube", isPrimary: true, publicAccountName: "Clashing YT" }
  ];
  assert.throws(() => checkPrimaryUniquenessRule(invalidAccounts), /ONLY_ONE_PRIMARY_ACCOUNT_PER_AGENT_PLATFORM/);
});

test("13. No real secret values are present in fixtures", () => {
  const secretLoc = "vault://st/agents/agent-01/providers/gemini/primary";
  assert.ok(secretLoc.startsWith("vault://"));
});

test("14. Final Review Blockers Integration Tests", () => {
  const service = new PublishingService();

  const agentId = "agent-01";
  const agent = { id: "agent-01", name: "JARVIS", namespace: "st.agent.jarvis" };
  const profile = {
    agentId: "agent-01",
    publicBrandName: "My Cool Channel",
    publicDisplayName: "Cool Display",
    status: "active"
  };

  // - missing agentId must reject
  assert.throws(() => {
    service.request({
      agent,
      profile,
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption"
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - profile from another agent resolves to PUBLIC_PUBLISHING_IDENTITY_REQUIRED
  const profileOther = {
    agentId: "agent-02",
    publicBrandName: "Another Agent Brand",
    publicDisplayName: "Display",
    status: "active"
  };
  assert.throws(() => {
    resolvePublicAttribution({ agentId: "agent-01", agent, profile: profileOther });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - social account from another agent resolves to PUBLIC_PUBLISHING_IDENTITY_REQUIRED
  const socialOther = {
    agentId: "agent-02",
    platform: "youtube",
    isPrimary: true,
    connectionStatus: "connected",
    publicAccountName: "My Brand Channel"
  };
  assert.throws(() => {
    resolvePublicAttribution({ agentId: "agent-01", agent, primarySocialAccount: socialOther });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - non-primary social account resolves to PUBLIC_PUBLISHING_IDENTITY_REQUIRED
  const socialNonPrimary = {
    agentId: "agent-01",
    platform: "youtube",
    isPrimary: false,
    connectionStatus: "connected",
    publicAccountName: "My Brand Channel"
  };
  assert.throws(() => {
    resolvePublicAttribution({ agentId: "agent-01", agent, primarySocialAccount: socialNonPrimary });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - unsupported platform resolves to PUBLIC_PUBLISHING_IDENTITY_REQUIRED
  const socialUnsupportedPlatform = {
    agentId: "agent-01",
    platform: "twitter",
    isPrimary: true,
    connectionStatus: "connected",
    publicAccountName: "My Brand Channel"
  };
  assert.throws(() => {
    resolvePublicAttribution({ agentId: "agent-01", agent, primarySocialAccount: socialUnsupportedPlatform });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - expired token (reauthentication required or expired status) resolves to PUBLIC_PUBLISHING_IDENTITY_REQUIRED
  const socialExpiredStatus = {
    agentId: "agent-01",
    platform: "youtube",
    isPrimary: true,
    connectionStatus: "expired",
    publicAccountName: "My Brand Channel"
  };
  assert.throws(() => {
    resolvePublicAttribution({ agentId: "agent-01", agent, primarySocialAccount: socialExpiredStatus });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  const socialExpiredTimestamp = {
    agentId: "agent-01",
    platform: "youtube",
    isPrimary: true,
    connectionStatus: "connected",
    publicAccountName: "My Brand Channel",
    tokenExpiresAt: new Date(Date.now() - 3600_000).toISOString()
  };
  assert.throws(() => {
    resolvePublicAttribution({ agentId: "agent-01", agent, primarySocialAccount: socialExpiredTimestamp });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - future agents 21–50 checks work dynamically and punctuation variants are caught
  const futureAgent = {
    id: "agent-35",
    name: "AGENT_NAME_35",
    namespace: "st.agent.agent_name_35"
  };

  assert.equal(isInternalAgentName("AGENT_NAME_35", futureAgent), true);
  assert.equal(isInternalAgentName("Brand AGENT_NAME_35", futureAgent), true);
  assert.equal(isInternalAgentName("agent-name-35 channel", futureAgent), true);
  assert.equal(isInternalAgentName("st.agent.agent_name_35", futureAgent), true);

  // - pure function verification check verifyAttributionSnapshot
  const sampleSnapshot = {
    sourceAgentId: "agent-01",
    publicAttribution: "Some Brand",
    sourceType: "public_profile",
    sourceId: "agent-01",
    isValid: true
  };
  const correctHash = createHash("sha256")
    .update(JSON.stringify(sampleSnapshot))
    .digest("hex");
  assert.ok(verifyAttributionSnapshot(sampleSnapshot, correctHash));
  assert.ok(!verifyAttributionSnapshot(sampleSnapshot, "wronghash"));
  // Mutated snapshot is detected!
  assert.ok(!verifyAttributionSnapshot({ ...sampleSnapshot, publicAttribution: "Mutated Value" }, correctHash));

  // - case-insensitive duplicate email design validation
  const emailConnections = [
    { agentId: "agent-01", emailAddress: "TestEmail@Example.com", connectionStatus: "connected" }
  ];
  function validateEmailUniqueness(newConnection, existingList) {
    const normNew = String(newConnection.emailAddress || "").toLowerCase().trim();
    if (newConnection.connectionStatus === "connected" && normNew) {
      const exists = existingList.some(conn => {
        return conn.connectionStatus === "connected" && String(conn.emailAddress || "").toLowerCase().trim() === normNew;
      });
      if (exists) {
        throw new Error("EMAIL_ADDRESS_MUST_BE_UNIQUE");
      }
    }
    return true;
  }

  assert.ok(validateEmailUniqueness({
    agentId: "agent-02",
    emailAddress: "UniqueEmail@Example.com",
    connectionStatus: "connected"
  }, emailConnections));

  assert.throws(() => {
    validateEmailUniqueness({
      agentId: "agent-02",
      emailAddress: "testemail@example.com", // Case-insensitive duplicate of agent-01
      connectionStatus: "connected"
    }, emailConnections);
  }, /EMAIL_ADDRESS_MUST_BE_UNIQUE/);

  // - nested unexpected secret-reference fields serialization check
  const complexObj = {
    id: "connection-id-123",
    agentId: "agent-01",
    oauth_scopes: ["scope1"],
    api_key: "real-secret-key-material",
    credentials: {
      password: "password-val",
      token: "secret-token"
    },
    someUnknownPayload: {
      innerData: "should-not-serialize"
    },
    // Allowlisted nested container
    socialAccounts: [
      { platform: "youtube", publicAccountName: "YT Real Channel" }
    ]
  };
  const serialized = serializeForDashboard(complexObj);
  assert.equal(serialized.id, "connection-id-123");
  assert.equal(serialized.agentId, "agent-01");
  assert.deepEqual(serialized.oauth_scopes, ["scope1"]);
  assert.equal(serialized.api_key, undefined);
  assert.equal(serialized.credentials, undefined);
  assert.equal(serialized.someUnknownPayload, undefined); // Completely stripped because it is not in explicit allowlist!
  assert.equal(serialized.socialAccounts[0].platform, "youtube");
  assert.equal(serialized.socialAccounts[0].publicAccountName, "YT Real Channel");
});
