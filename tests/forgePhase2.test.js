import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

import {
  ACTOR_TYPES,
  ForgeEvidenceLedger,
  ForgePermissionGateway,
  PERMISSION_TIERS,
} from "../src/forge/permissionGateway.js";
import { OwnerDelegationEngine } from "../src/forge/delegationEngine.js";
import {
  DIRECTOR_ACCOUNT_PLATFORMS,
  IsolatedDirectorPoolRegistry,
  YOUTUBE_SHORTS_FORMAT,
} from "../src/forge/directorIsolation.js";
import { ForgeControlPlane, OPERATIONAL_STATES } from "../src/forge/forgeControlPlane.js";
import { createForgeControlRouter } from "../src/forge/forgeControlRouter.js";

test("Permission Gateway: deny-by-default, T0-T7 tiers, coding-worker GitHub write ban, workflow ban, and self-approval ban", () => {
  const gw = new ForgePermissionGateway();

  // Unauthenticated denied
  assert.equal(gw.authorize({ action: "repo.read", tier: PERMISSION_TIERS.T1 }).allowed, false);

  // Unknown tier denied
  assert.equal(
    gw.authorize({
      actor: { id: "owner-1", type: ACTOR_TYPES.OWNER, authenticated: true },
      action: "repo.read",
      tier: "T99",
    }).code,
    "DENY_UNKNOWN_TIER"
  );

  // Coding worker denied GitHub write (v1.2 Condition 1)
  const coderPush = gw.authorize({
    actor: { id: "coder-1", type: ACTOR_TYPES.FORGE_CODER, authenticated: true },
    action: "github.push_branch",
    tier: PERMISSION_TIERS.T5,
  });
  assert.equal(coderPush.allowed, false);

  // Controller allowed T6a/T6b/T6c, denied T7 without Owner approval
  assert.equal(
    gw.authorize({
      actor: { id: "forge-ctrl", type: ACTOR_TYPES.FORGE_CONTROLLER, authenticated: true },
      action: "ci.dispatch",
      tier: PERMISSION_TIERS.T6A,
    }).allowed,
    true
  );
  assert.equal(
    gw.authorize({
      actor: { id: "forge-ctrl", type: ACTOR_TYPES.FORGE_CONTROLLER, authenticated: true },
      action: "deploy.production",
      tier: PERMISSION_TIERS.T7,
    }).code,
    "DENY_OWNER_RESERVED"
  );

  // Workflow file edits rejected by default
  assert.equal(
    gw.authorize({
      actor: { id: "forge-ctrl", type: ACTOR_TYPES.FORGE_CONTROLLER, authenticated: true },
      action: "github.push_branch",
      tier: PERMISSION_TIERS.T5,
      touchedPaths: [".github/workflows/ci.yml"],
    }).code,
    "DENY_WORKFLOW_MODIFICATION"
  );

  // Coding worker cannot approve its own commit
  assert.equal(
    gw.authorize({
      actor: { id: "rev-1", type: ACTOR_TYPES.FORGE_REVIEWER, authenticated: true },
      action: "review.submit_verdict",
      tier: PERMISSION_TIERS.T3,
      reviewContext: { authorWorkerId: "worker-A", reviewerWorkerId: "worker-A" },
    }).code,
    "DENY_SELF_APPROVAL"
  );

  // Unapproved paid provider rejected
  assert.equal(
    gw.authorize({
      actor: { id: "forge-ctrl", type: ACTOR_TYPES.FORGE_CONTROLLER, authenticated: true },
      action: "llm.invoke",
      tier: PERMISSION_TIERS.T4,
      budget: { costTier: "paid", ownerApprovedPaid: false },
    }).code,
    "DENY_UNAPPROVED_PAID_PROVIDER"
  );

  // Evidence chain remains valid
  assert.equal(gw.evidenceLedger.verifyChain().valid, true);
});

test("Owner Delegation Engine: silence/expiry is never consent; Owner-reserved categories locked; explicit policy works when unavailable", () => {
  const engine = new OwnerDelegationEngine();

  // Cannot register delegation for Owner-reserved category
  assert.throws(
    () =>
      engine.registerPolicy({
        policyId: "bad-pol",
        category: "spending.above_limits",
        allowedActions: ["spending.commit"],
      }),
    /OWNER_RESERVED_CATEGORY_CANNOT_BE_DELEGATED/
  );

  engine.registerPolicy({
    policyId: "pol-sched",
    category: "scheduling",
    allowedActions: ["schedule.rebalance"],
    expiresAt: "2030-01-01T00:00:00Z",
  });

  // Owner available -> deferred to Owner
  const whenAvail = engine.evaluate({
    category: "scheduling",
    action: "schedule.rebalance",
    resource: "director:agent-01",
    policyId: "pol-sched",
    now: new Date("2026-11-17T10:00:00Z"),
  });
  assert.equal(whenAvail.authorizationResult, "DEFERRED_TO_OWNER");

  // Owner unavailable + expired deadline + no policy -> DENIED_NO_ASSUMED_CONSENT
  engine.setOwnerAvailability("unavailable");
  const expiredNoPolicy = engine.evaluate({
    category: "publishing",
    action: "publishing.publish_publicly",
    resource: "channel:midnight-horror",
    decisionDeadline: "2026-11-17T09:00:00Z",
    now: new Date("2026-11-17T10:00:00Z"),
  });
  assert.equal(expiredNoPolicy.authorizationResult, "DENIED_NO_ASSUMED_CONSENT");
  assert.ok(expiredNoPolicy.evidenceRef);

  // Owner unavailable + explicit active policy -> AUTHORIZED_DELEGATED
  const delegated = engine.evaluate({
    category: "scheduling",
    action: "schedule.rebalance",
    resource: "director:agent-01",
    policyId: "pol-sched",
    now: new Date("2026-11-17T10:00:00Z"),
  });
  assert.equal(delegated.authorizationResult, "AUTHORIZED_DELEGATED");
  assert.equal(delegated.executionOutcome, "EXECUTED_WITHIN_DELEGATION");
});

test("Director Isolation: non-owner RLS roles, role-switch & spoof rejection, pool isolation, and 5-platform + YouTube Shorts model", () => {
  const registry = new IsolatedDirectorPoolRegistry();
  const poolA = registry.registerDirector("agent-01");
  const poolB = registry.registerDirector("agent-02");

  assert.equal(poolA.isSuperuser, false);
  assert.equal(poolA.bypassRls, false);
  assert.notEqual(poolA.poolId, poolB.poolId);
  assert.equal(DIRECTOR_ACCOUNT_PLATFORMS.length, 5);

  // Director A inserts own record
  assert.equal(
    registry.executeScopedQuery({
      pool: poolA,
      operation: "INSERT",
      targetDirectorId: "agent-01",
      record: { title: "Ward 7 Lore" },
    }).ok,
    true
  );

  // Director B cannot read Director A even with spoofed session variable
  const crossRead = registry.executeScopedQuery({
    pool: poolB,
    operation: "SELECT",
    targetDirectorId: "agent-01",
    spoofedSessionVar: "agent-01",
  });
  assert.equal(crossRead.rows.length, 0);
  assert.equal(crossRead.code, "RLS_FILTERED_EMPTY");

  // Director B cannot SET ROLE to Director A
  const roleSwitch = registry.executeScopedQuery({
    pool: poolB,
    operation: "SELECT",
    targetDirectorId: "agent-01",
    attemptedSetRole: poolA.dbRole,
  });
  assert.equal(roleSwitch.ok, false);
  assert.equal(roleSwitch.code, "DENY_ROLE_SWITCH_PROHIBITED");

  // Director B cannot insert into Director A
  const crossInsert = registry.executeScopedQuery({
    pool: poolB,
    operation: "INSERT",
    targetDirectorId: "agent-01",
    record: { title: "Injected" },
  });
  assert.equal(crossInsert.ok, false);
  assert.equal(crossInsert.code, "DENY_RLS_WITH_CHECK_VIOLATION");

  // 5-platform isolation + YouTube Shorts uses Director's own YouTube account
  registry.configurePlatformSlot({
    directorId: "agent-01",
    platform: "youtube",
    vaultLocator: "vault://stph-secrets/agent-01/youtube-oauth",
    status: "sandbox_verified",
  });
  const shortsRes = registry.resolvePublishingAccount({
    directorId: "agent-01",
    targetPlatformOrFormat: YOUTUBE_SHORTS_FORMAT,
  });
  assert.equal(shortsRes.ok, true);
  assert.equal(shortsRes.accountPlatform, "youtube");
  assert.equal(shortsRes.format, YOUTUBE_SHORTS_FORMAT);

  // Disconnected Director B fails honestly (no substitution to Director A)
  const unconfigured = registry.resolvePublishingAccount({
    directorId: "agent-02",
    targetPlatformOrFormat: "youtube",
  });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "ACCOUNT_NOT_CONFIGURED");
});

test("Control Plane Reliability: atomic expired-lease reclaim, fencing rejection, 1-PR slot + drift detection, and crash reconciliation", () => {
  let currentMs = Date.parse("2026-11-17T10:00:00Z");
  const cp = new ForgeControlPlane({ nowFn: () => new Date(currentMs) });

  const { task } = cp.enqueueTask({
    issueNumber: 301,
    slug: "phase-2-gateway",
    title: "Implement Permission Gateway",
    idempotencyKey: "idem-301",
  });
  assert.equal(task.derivedBranch, "task/301-phase-2-gateway");

  // Duplicate enqueue deduplicates cleanly
  assert.equal(
    cp.enqueueTask({
      issueNumber: 301,
      slug: "phase-2-gateway",
      title: "Implement Permission Gateway",
      idempotencyKey: "idem-301",
    }).deduplicated,
    true
  );

  // Worker 1 claims lease (fencingToken = 1)
  const lease1 = cp.claimLease({ taskId: task.id, workerId: "worker-1", leaseTtlMs: 60_000 });
  assert.equal(lease1.ok, true);
  assert.equal(lease1.fencingToken, 1);

  // Advance clock past lease expiry; Worker 2 atomically reclaims (fencingToken = 2)
  currentMs += 120_000;
  const lease2 = cp.claimLease({ taskId: task.id, workerId: "worker-2", leaseTtlMs: 60_000 });
  assert.equal(lease2.ok, true);
  assert.equal(lease2.fencingToken, 2);
  assert.equal(cp.listLeaseHistory(task.id).length, 2);

  // Stale Worker 1 rejected by fencing token when attempting PR slot reservation
  const staleReserve = cp.reservePrSlot({ taskId: task.id, fencingToken: 1 });
  assert.equal(staleReserve.ok, false);
  assert.equal(staleReserve.code, "DENY_STALE_FENCING_TOKEN");

  // GitHub drift detected if an untracked open PR exists
  const drift = cp.reservePrSlot({ taskId: task.id, fencingToken: 2, observedOpenGithubPrs: [999] });
  assert.equal(drift.ok, false);
  assert.equal(drift.code, "PR_SLOT_DRIFT_DETECTED");

  // Valid reservation succeeds; second reservation blocked by 1-PR-in-flight
  assert.equal(cp.reservePrSlot({ taskId: task.id, fencingToken: 2 }).ok, true);
  assert.equal(cp.reservePrSlot({ taskId: task.id, fencingToken: 2 }).code, "ONE_PR_IN_FLIGHT_OCCUPIED");

  // Write-ahead external op + crash reconciliation
  const op = cp.beginExternalOp({
    idempotencyKey: "op-push-301",
    taskId: task.id,
    fencingToken: 2,
    operationType: "github.push_branch",
    touchedPaths: ["src/forge/permissionGateway.js"],
  });
  assert.equal(op.ok, true);
  assert.equal(op.op.status, "IN_FLIGHT");

  const rec = cp.reconcileExternalOp({
    idempotencyKey: "op-push-301",
    observedOnGithub: true,
    observedSha: "a".repeat(40),
  });
  assert.equal(rec.op.status, "COMMITTED");
  assert.equal(cp.evidenceLedger.verifyChain().valid, true);
});

test("Control Plane HTTP API: authentication, CSRF enforcement, honest status snapshot, and validation", async () => {
  const cp = new ForgeControlPlane();
  const app = express();
  app.use(
    "/api/forge",
    createForgeControlRouter({
      controlPlane: cp,
      authenticateSession: (req) =>
        req.headers["x-owner-session"] === "valid-owner"
          ? { authenticated: true, role: "owner", id: "owner-01" }
          : null,
    })
  );

  // Unauthenticated rejected
  const unauth = await request(app).get("/api/forge/status");
  assert.equal(unauth.status, 401);

  // Authenticated status reports honest states
  const statusRes = await request(app)
    .get("/api/forge/status")
    .set("x-owner-session", "valid-owner");
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.forge.controlPlane, OPERATIONAL_STATES.IMPLEMENTED);
  assert.equal(statusRes.body.forge.persistentCloudHosting, OPERATIONAL_STATES.AWAITING_OWNER_APPROVAL);

  // Mutation without CSRF rejected
  const noCsrf = await request(app)
    .post("/api/forge/tasks")
    .set("x-owner-session", "valid-owner")
    .send({ issueNumber: 302, slug: "test", title: "Test", idempotencyKey: "k-302" });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.code, "CSRF_TOKEN_REQUIRED");

  // Mutation with CSRF succeeds
  const created = await request(app)
    .post("/api/forge/tasks")
    .set("x-owner-session", "valid-owner")
    .set("x-csrf-token", "csrf-ok")
    .send({ issueNumber: 302, slug: "test", title: "Test", idempotencyKey: "k-302" });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.derivedBranch, "task/302-test");
});
