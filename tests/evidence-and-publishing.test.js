import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";
import { PublishingService } from "../src/publishing/publishingService.js";
import { resolvePublicAttribution } from "../src/catalog/agentDigitalIdentity.js";

const hash = "b".repeat(64);

test("rejects fabricated upload receipts", () => {
  const ledger = new EvidenceLedger();
  assert.throws(() => ledger.append({
    subjectId: "publish-1",
    kind: "platform_publish",
    classification: "live_provider_verified",
    payload: { platformPostId: "fake" }
  }), /VERIFIABLE_PLATFORM_RECEIPT_REQUIRED/);
});

test("dry-run publishing produces no fake platform identity", async () => {
  const service = new PublishingService();

  const agentId = "agent-01";
  const agent = { id: "agent-01", name: "JARVIS", namespace: "st.agent.jarvis" };
  const profile = {
    agentId: "agent-01",
    publicBrandName: "My Real Brand",
    publicDisplayName: "Brand Display",
    status: "active"
  };
  const validatedAttribution = resolvePublicAttribution({ agentId, agent, profile });

  const request = service.request({
    agentId,
    validatedAttribution,
    artifactSha256: hash,
    destination: "youtube:channel-1",
    captionSnapshot: "Owner-reviewed caption",
    mode: "draft"
  });
  service.approve(request.id, {
    ownerId: "owner-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const result = await service.dispatch(request.id, null, { dryRun: true });
  assert.deepEqual(result, {
    requestId: request.id,
    status: "dry_run_completed",
    published: false
  });
});

test("live publishing requires a real provider receipt", async () => {
  const service = new PublishingService();

  const agentId = "agent-01";
  const agent = { id: "agent-01", name: "JARVIS", namespace: "st.agent.jarvis" };
  const profile = {
    agentId: "agent-01",
    publicBrandName: "My Real Brand",
    publicDisplayName: "Brand Display",
    status: "active"
  };
  const validatedAttribution = resolvePublicAttribution({ agentId, agent, profile });

  const request = service.request({
    agentId,
    validatedAttribution,
    artifactSha256: hash,
    destination: "instagram:account-1",
    captionSnapshot: "Approved caption"
  });
  service.approve(request.id, {
    ownerId: "owner-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  await assert.rejects(() => service.dispatch(request.id, {
    publish: async () => ({ platformPostId: "id-without-proof" })
  }, { dryRun: false }), /PLATFORM_RECEIPT_REQUIRED/);
});
