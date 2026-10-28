import test from "node:test";
import assert from "node:assert/strict";
import { PrivatePublishingTestService, PrivatePublishingTestError } from "../src/publishing/privatePublishingTest.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

const VALID_ARTIFACT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function buildValidIdentity(agentId = "agent-01") {
  return {
    agentId,
    agent: { id: agentId, name: "InternalAgentName" },
    profile: { agentId, publicBrandName: "Public Studio Brand", publicDisplayName: "Studio Brand", status: "active" }
  };
}

test("private publishing test: succeeds with owner approval and genuine platform receipt", async () => {
  const ledger = new EvidenceLedger();
  const service = new PrivatePublishingTestService({ evidenceLedger: ledger });

  const publisher = {
    publish: async (request) => ({
      platformPostId: "yt_private_post_99",
      platformUrl: "https://youtube.com/watch?v=yt_private_post_99",
      rawResponse: JSON.stringify({ status: "uploaded", privacy: "private", id: "yt_private_post_99" })
    })
  };

  const identity = buildValidIdentity("agent-01");

  const result = await service.runPrivatePublishingTest({
    ownerId: "owner-01",
    agentId: identity.agentId,
    agent: identity.agent,
    profile: identity.profile,
    artifactSha256: VALID_ARTIFACT_HASH,
    destination: "youtube",
    captionSnapshot: { text: "Private test Reel" },
    mode: "private",
    publisher
  });

  assert.equal(result.status, "platform_verified");
  assert.equal(result.published, true);
  assert.equal(result.platformPostId, "yt_private_post_99");
  assert.equal(result.mode, "private");
  assert.equal(result.publicAttribution, "Public Studio Brand");

  const events = ledger.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "platform_publish");
  assert.equal(events[0].classification, "private_first");
  assert.equal(events[0].payload.platformPostId, "yt_private_post_99");
});

test("private publishing test: rejects non-private mode ('public')", async () => {
  const service = new PrivatePublishingTestService();
  const identity = buildValidIdentity("agent-01");

  await assert.rejects(
    async () => {
      await service.runPrivatePublishingTest({
        ownerId: "owner-01",
        agentId: identity.agentId,
        agent: identity.agent,
        profile: identity.profile,
        artifactSha256: VALID_ARTIFACT_HASH,
        destination: "youtube",
        captionSnapshot: { text: "Public test" },
        mode: "public",
        publisher: { publish: async () => ({}) }
      });
    },
    (err) => {
      assert.equal(err.code, "PRIVATE_FIRST_MODE_REQUIRED");
      return true;
    }
  );
});

test("private publishing test: rejects invalid platform destination", async () => {
  const service = new PrivatePublishingTestService();
  const identity = buildValidIdentity("agent-01");

  await assert.rejects(
    async () => {
      await service.runPrivatePublishingTest({
        ownerId: "owner-01",
        agentId: identity.agentId,
        agent: identity.agent,
        profile: identity.profile,
        artifactSha256: VALID_ARTIFACT_HASH,
        destination: "unsupported_platform",
        captionSnapshot: { text: "Test" },
        mode: "private",
        publisher: { publish: async () => ({}) }
      });
    },
    (err) => {
      assert.equal(err.code, "INVALID_PLATFORM_DESTINATION");
      return true;
    }
  );
});

test("private publishing test: rejects internal agent name leakage in caption", async () => {
  const service = new PrivatePublishingTestService();
  const identity = buildValidIdentity("agent-01");

  await assert.rejects(
    async () => {
      await service.runPrivatePublishingTest({
        ownerId: "owner-01",
        agentId: identity.agentId,
        agent: identity.agent,
        profile: identity.profile,
        artifactSha256: VALID_ARTIFACT_HASH,
        destination: "instagram",
        captionSnapshot: { text: "Created by JARVIS" },
        mode: "private",
        publisher: { publish: async () => ({}) }
      });
    },
    (err) => {
      assert.equal(err.code, "AGENT_NAME_LEAKAGE_DENIED");
      return true;
    }
  );
});

test("private publishing test: rejects missing platform response receipt", async () => {
  const service = new PrivatePublishingTestService();
  const identity = buildValidIdentity("agent-01");

  const publisher = {
    publish: async () => ({
      platformPostId: null, // Missing receipt
      platformUrl: null,
      rawResponse: null
    })
  };

  await assert.rejects(
    async () => {
      await service.runPrivatePublishingTest({
        ownerId: "owner-01",
        agentId: identity.agentId,
        agent: identity.agent,
        profile: identity.profile,
        artifactSha256: VALID_ARTIFACT_HASH,
        destination: "youtube",
        captionSnapshot: { text: "Private test" },
        mode: "private",
        publisher
      });
    },
    (err) => {
      assert.equal(err.message, "PLATFORM_RECEIPT_REQUIRED");
      return true;
    }
  );
});
