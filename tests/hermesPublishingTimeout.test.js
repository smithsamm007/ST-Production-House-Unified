import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HermesPublishingTimeoutEngine,
  FilePublishingTimeoutStore,
  OWNER_APPROVAL_WINDOW_MS,
} from "../src/publishing/hermesPublishingTimeout.js";

function allPassingChecks() {
  return {
    productionQc: { passed: true, evidence: "ffprobe://verified/ep12" },
    platformPolicy: { passed: true, evidence: "policy://youtube/compliant" },
    copyright: { passed: true, evidence: "license://original-and-cleared" },
    legal: { passed: true, evidence: "legal://review-passed" },
    advertisingDisclosure: { passed: true, evidence: "disclosure://affiliate-explicit" },
    privacy: { passed: true, evidence: "rule15://zero-internal-names" },
    safety: { passed: true, evidence: "safety://green" },
  };
}

const ACTIVE_POLICY = {
  policyId: "pol-pub-01",
  active: true,
  permitsLivePublishing: true,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

test("Within 5-hour window: HERMES must wait for Owner and cannot decide early", async () => {
  const engine = new HermesPublishingTimeoutEngine();
  const t0 = new Date("2026-11-18T10:00:00.000Z");
  await engine.registerPublishingRequest({
    requestId: "req-1",
    directorId: "agent-01",
    artifactHash: "sha256:abc",
    destination: "youtube",
    notifiedAt: t0.toISOString(),
    delegatedPolicyId: "pol-pub-01",
  });

  const beforeDeadline = new Date(t0.getTime() + OWNER_APPROVAL_WINDOW_MS - 60_000);
  const res = await engine.evaluateTimeoutDelegation({
    requestId: "req-1",
    policy: ACTIVE_POLICY,
    checks: allPassingChecks(),
    now: beforeDeadline,
  });

  assert.equal(res.status, "AWAITING_OWNER");
  assert.equal(res.decision, null);
});

test("After 5 hours with NO active delegated policy: silence is NEVER approval (REJECT)", async () => {
  const engine = new HermesPublishingTimeoutEngine();
  const t0 = new Date("2026-11-18T10:00:00.000Z");
  await engine.registerPublishingRequest({
    requestId: "req-2",
    directorId: "agent-01",
    artifactHash: "sha256:def",
    destination: "youtube",
    notifiedAt: t0.toISOString(),
  });

  const afterDeadline = new Date(t0.getTime() + OWNER_APPROVAL_WINDOW_MS + 1000);
  const res = await engine.evaluateTimeoutDelegation({
    requestId: "req-2",
    policy: null,
    checks: allPassingChecks(),
    now: afterDeadline,
  });

  assert.equal(res.decision, "REJECT");
  assert.match(res.hermesDecision.reasoning, /Silence is never approval/i);
  assert.equal(res.hermesDecision.delegationScope, "SINGLE_REQUEST_ONLY");
  assert.equal(res.hermesDecision.grantsUnrestrictedPublishing, false);
  assert.equal(res.hermesDecision.grantsSpendingAuthority, false);
  assert.equal(res.hermesDecision.grantsAccountConnection, false);
  assert.equal(res.hermesDecision.overridesOwnerReserved, false);
});

test("After 5 hours with active policy + failing check: HERMES REJECTS and notifies Owner", async () => {
  const engine = new HermesPublishingTimeoutEngine();
  const t0 = new Date("2026-11-18T10:00:00.000Z");
  await engine.registerPublishingRequest({
    requestId: "req-3",
    directorId: "agent-01",
    artifactHash: "sha256:ghi",
    destination: "youtube",
    notifiedAt: t0.toISOString(),
    delegatedPolicyId: "pol-pub-01",
  });

  const checks = allPassingChecks();
  checks.advertisingDisclosure = { passed: false, evidence: "", reason: "Missing affiliate disclosure" };

  const res = await engine.evaluateTimeoutDelegation({
    requestId: "req-3",
    policy: ACTIVE_POLICY,
    checks,
    now: new Date(t0.getTime() + OWNER_APPROVAL_WINDOW_MS + 1000),
  });

  assert.equal(res.decision, "REJECT");
  assert.deepEqual(res.hermesDecision.failedChecks, ["advertisingDisclosure"]);
  assert.equal(res.notification.recipient, "OWNER");
});

test("After 5 hours across server restart with active policy + all 7 checks passing: HERMES APPROVES single request and notifies Owner", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stph-pub-timeout-"));
  const storePath = path.join(tmpDir, "timeout-state.json");

  try {
    const t0 = new Date("2026-11-18T10:00:00.000Z");
    const engineBeforeRestart = new HermesPublishingTimeoutEngine({
      store: new FilePublishingTimeoutStore(storePath),
    });
    await engineBeforeRestart.registerPublishingRequest({
      requestId: "req-restart-1",
      directorId: "agent-02",
      artifactHash: "sha256:jkl",
      destination: "youtube",
      notifiedAt: t0.toISOString(),
      delegatedPolicyId: "pol-pub-01",
    });

    // Simulate server restart: fresh engine instance loads durable timestamp
    const engineAfterRestart = new HermesPublishingTimeoutEngine({
      store: new FilePublishingTimeoutStore(storePath),
    });
    const res = await engineAfterRestart.evaluateTimeoutDelegation({
      requestId: "req-restart-1",
      policy: ACTIVE_POLICY,
      checks: allPassingChecks(),
      now: new Date(t0.getTime() + OWNER_APPROVAL_WINDOW_MS),
    });

    assert.equal(res.decision, "APPROVE");
    assert.equal(res.status, "HERMES_DELEGATED_APPROVED");
    assert.equal(res.hermesDecision.delegationScope, "SINGLE_REQUEST_ONLY");
    assert.ok(res.hermesDecision.evidenceHash.length === 64);

    const notifications = await engineAfterRestart.getOwnerNotifications();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].requestId, "req-restart-1");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
