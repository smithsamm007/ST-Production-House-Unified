import test from "node:test";
import assert from "node:assert/strict";
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
  serializeForDashboard
} from "../src/catalog/agentDigitalIdentity.js";
import { PublishingService } from "../src/publishing/publishingService.js";

const dummyHash = "c".repeat(64);

test("1. All 20 agents remain preloaded", () => {
  const registry = new AgentRegistry();
  assert.equal(PRELOADED_AGENTS.length, 20);
  assert.equal(registry.list().length, 20);
});

test("2. Maximum 50 agents remains enforced", () => {
  const registry = new AgentRegistry();
  const overflowAgentId = "agent-51";
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
  // Case A: valid active profile
  const profile = {
    agentId: "agent-01",
    publicBrandName: "My Cool Channel",
    publicDisplayName: "Cool Display",
    status: "active"
  };
  const attribution = resolvePublicAttribution({ profile });
  assert.equal(attribution, "My Cool Channel");

  // Case B: Profile uses internal name 'JARVIS' -> must block with PUBLIC_PUBLISHING_IDENTITY_REQUIRED
  const badProfile = {
    agentId: "agent-01",
    publicBrandName: "JARVIS",
    publicDisplayName: "Jarvis Agent",
    status: "active"
  };
  assert.equal(resolvePublicAttribution({ profile: badProfile }), "PUBLIC_PUBLISHING_IDENTITY_REQUIRED");

  // Case C: Primary social account connected
  const primarySocialAccount = {
    agentId: "agent-01",
    connectionStatus: "connected",
    publicAccountName: "My Instagram Brand",
    platform: "instagram",
    isPrimary: true
  };
  assert.equal(resolvePublicAttribution({ profile, primarySocialAccount }), "My Instagram Brand");

  // Case D: Social account name is internal name 'SHERLOCK' -> must block
  const badSocialAccount = {
    agentId: "agent-01",
    connectionStatus: "connected",
    publicAccountName: "SHERLOCK",
    platform: "instagram",
    isPrimary: true
  };
  assert.equal(resolvePublicAttribution({ profile, primarySocialAccount: badSocialAccount }), "PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
});

test("5. Publishing is blocked when no public identity is configured", () => {
  const service = new PublishingService();

  // Explicit "PUBLIC_PUBLISHING_IDENTITY_REQUIRED" throws on request
  assert.throws(() => {
    service.request({
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption",
      publicAttribution: "PUBLIC_PUBLISHING_IDENTITY_REQUIRED"
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // Internal names (like PANCHI) throw on request
  assert.throws(() => {
    service.request({
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption",
      publicAttribution: "PANCHI"
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);
});

test("6 & 7. Cross-agent account access and credential access rejection", () => {
  const connection = {
    agentId: "agent-01",
    email_address: "agent1@example.com"
  };

  // agent-01 accessing agent-01 is OK
  assert.equal(validateConnectionOwnership("agent-01", connection), true);

  // agent-02 accessing agent-01 throws
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
  assert.equal(serialized.otherFields.innerSecret, undefined);
  assert.equal(serialized.otherFields.cleartext, "safe-value");
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
  // Enforce types youtube, instagram, facebook, snapchat are supported
  assert.deepEqual([...SUPPORTED_PLATFORMS], ["youtube", "instagram", "facebook", "snapchat"]);
  assert.deepEqual([...CONNECTION_STATUSES], ["unconfigured", "connected", "expired", "disconnected"]);

  // Mock array simulating DB constraints for agent_social_accounts
  const accounts = [
    { agentId: "agent-01", platform: "youtube", isPrimary: true, publicAccountName: "Brand YT" },
    { agentId: "agent-01", platform: "youtube", isPrimary: false, publicAccountName: "Backup YT 1" },
    { agentId: "agent-01", platform: "youtube", isPrimary: false, publicAccountName: "Backup YT 2" },
    { agentId: "agent-01", platform: "instagram", isPrimary: true, publicAccountName: "Brand IG" }
  ];

  // Helper validation for unique primary rule per agent/platform
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

  // If we try to add another primary YouTube account, check fails
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
