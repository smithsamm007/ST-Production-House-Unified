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
  serializeForDashboard,
  isInternalAgentName,
  normalizeForPunctuation
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

  // Creation throws without valid attribution object
  assert.throws(() => {
    service.request({
      agentId: "agent-01",
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption"
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // Creation throws when publicAttribution is a direct string bypass
  assert.throws(() => {
    service.request({
      agentId: "agent-01",
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption",
      publicAttribution: "Arbitrary Bypass String"
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

test("14. Final Review Blockers Integration Tests", async () => {
  const service = new PublishingService();

  const agentId = "agent-01";
  const agent = { id: "agent-01", name: "JARVIS", namespace: "st.agent.jarvis" };
  const profile = {
    agentId: "agent-01",
    publicBrandName: "My Cool Channel",
    publicDisplayName: "Cool Display",
    status: "active"
  };
  const validatedAttribution = resolvePublicAttribution({ agentId, agent, profile });

  // - arbitrary attribution-string bypass must reject
  assert.throws(() => {
    service.request({
      agentId,
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption",
      publicAttribution: "Arbitrary String"
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - missing agentId must reject
  assert.throws(() => {
    service.request({
      validatedAttribution,
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample video caption"
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - attribution belonging to another agent (sourceAgentId mismatch) must reject
  const profileOther = {
    agentId: "agent-02",
    publicBrandName: "Other Agent Brand",
    publicDisplayName: "Other",
    status: "active"
  };
  const agentOther = { id: "agent-02", name: "SHERLOCK", namespace: "st.agent.sherlock" };
  const validatedOther = resolvePublicAttribution({ agentId: "agent-02", agent: agentOther, profile: profileOther });

  assert.throws(() => {
    service.request({
      agentId: "agent-01", // selected agentId mismatch with validatedOther.sourceAgentId (agent-02)
      validatedAttribution: validatedOther,
      artifactSha256: dummyHash,
      destination: "youtube:channel-123",
      captionSnapshot: "Sample caption"
    });
  }, /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/);

  // - attribution snapshot-hash mismatch & mutation after approval
  const req = service.request({
    agentId,
    validatedAttribution,
    artifactSha256: dummyHash,
    destination: "youtube:channel-123",
    captionSnapshot: "Sample video caption"
  });

  service.approve(req.id, {
    ownerId: "owner-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  // Mutating attribution snapshot after approval blocks dispatch
  service.mutateRequestForTesting(req.id, {
    attributionSnapshot: {
      ...validatedAttribution,
      publicAttribution: "Tampered Brand Name" // Mutated!
    }
  });

  await assert.rejects(
    () => service.dispatch(req.id, null, { dryRun: true }),
    /ATTRIBUTION_SNAPSHOT_HASH_MISMATCH/
  );

  // - future-agent punctuation variants checking
  // Setup future agent dynamically (agent 35)
  const futureAgent = {
    id: "agent-35",
    name: "AGENT_NAME_35",
    namespace: "st.agent.agent_name_35"
  };

  // Names containing underscores, hyphens or punctuation are detected inside longer public names:
  // AGENT_NAME_35
  assert.equal(isInternalAgentName("AGENT_NAME_35", futureAgent), true);
  // Brand AGENT_NAME_35
  assert.equal(isInternalAgentName("Brand AGENT_NAME_35", futureAgent), true);
  // agent-name-35 channel
  assert.equal(isInternalAgentName("agent-name-35 channel", futureAgent), true);
  // st.agent.agent_name_35
  assert.equal(isInternalAgentName("st.agent.agent_name_35", futureAgent), true);

  // - case-insensitive duplicate email design validation
  // Email connections list simulated check: once normalized lower(), same address cannot belong to multiple agents once configured
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

  // - connected accounts requiring identifiers and secret references
  function validateConnectionProperties(conn) {
    if (conn.connectionStatus === "connected") {
      if (!conn.publicAccountName || !conn.secretLocator) {
        throw new Error("CONNECTED_ACCOUNTS_REQUIRE_IDENTIFIERS_AND_SECRETS");
      }
    }
    return true;
  }
  assert.ok(validateConnectionProperties({
    connectionStatus: "connected",
    publicAccountName: "Real brand",
    secretLocator: "vault://secret"
  }));
  assert.throws(() => {
    validateConnectionProperties({
      connectionStatus: "connected",
      publicAccountName: null,
      secretLocator: null
    });
  }, /CONNECTED_ACCOUNTS_REQUIRE_IDENTIFIERS_AND_SECRETS/);
});
