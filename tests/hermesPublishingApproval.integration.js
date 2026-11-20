/**
 * D5 — HERMES five-hour Owner approval & delegated publishing decision.
 * PostgreSQL 15 acceptance (disposable database, canonical migrations).
 *
 *   A five-hour clock · B notification failure · C Owner approval
 *   D Owner rejection · E HERMES approval · F HERMES rejection
 *   G no delegated policy · H restart recovery · I multiple workers
 *   J Owner/deadline race · K artifact modification · L revoked policy
 *   M duplicate processing · N Owner-reserved authority · O mounted HTTP app
 *
 * Nothing here touches a persistent database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import supertest from "supertest";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";
import {
  PostgresPublishingApprovalRepository,
  NOTIFICATION_KIND,
  ownerNotificationDedupeKey,
} from "../src/publishing/publishingApprovalRepository.js";
import {
  PublishingApprovalDeadlineWorker,
  createOwnerInboxNotifier,
} from "../src/publishing/publishingApprovalDeadlineWorker.js";
import { DELEGATED_PUBLISHING_CHECKS } from "../src/publishing/hermesDelegatedPublishingDecision.js";
import { createPublishingApprovalRouter } from "../src/api/publishingApprovalRouter.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";
const ARTIFACT = "c".repeat(64);
const OTHER_ARTIFACT = "d".repeat(64);
// Anchored to the real clock, one minute in the past: the five-hour deadline is
// still in the future, so "no early decision" is genuinely tested.
const DELIVERED_AT = new Date(Date.now() - 60_000).toISOString();

function allPassingChecks() {
  const checks = {};
  for (const name of DELEGATED_PUBLISHING_CHECKS) {
    checks[name] = { passed: true, evidence: `evidence://${name}/pg-verified` };
  }
  return checks;
}

test(
  "PostgreSQL 15 HERMES five-hour publishing approvals: clock, decisions, race, revocation, worker, HTTP",
  { skip: !POSTGRES_URL ? "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" : false },
  async () => {
    const created = await createDisposableDatabase(POSTGRES_URL, "stph_acceptance");
    const pool = new pg.Pool({ connectionString: created.connectionString, max: 12 });
    const auxiliaryPools = [];
    const instancePool = () => {
      const aux = new pg.Pool({ connectionString: created.connectionString, max: 4 });
      auxiliaryPools.push(aux);
      return aux;
    };

    try {
      const migrations = await new MigrationRunner(new PostgresAdapter({}, pool)).runMigrations();
      assert.ok(migrations.appliedCount >= 43, "migration 043 must be part of the canonical set");

      const owner = (
        await pool.query(
          "INSERT INTO owners (email, password_hash) VALUES ($1, 'test-hash') RETURNING id",
          [`d5-owner-${Date.now()}@example.test`]
        )
      ).rows[0];
      const ownerId = owner.id;
      const otherOwner = (
        await pool.query(
          "INSERT INTO owners (email, password_hash) VALUES ($1, 'test-hash') RETURNING id",
          [`d5-other-${Date.now()}@example.test`]
        )
      ).rows[0].id;

      const repo = new PostgresPublishingApprovalRepository(pool);
      const policy = await repo.registerPolicy({ policyId: `pol-pub-${Date.now()}` });
      assert.equal(policy.active, true);
      assert.equal(policy.permitsLivePublishing, true);

      let seq = 0;
      const nextKey = (label) => `d5-${label}-${Date.now()}-${++seq}`;

      async function createPending(label, overrides = {}) {
        const { request } = await repo.createRequest({
          idempotencyKey: nextKey(label),
          ownerId,
          directorId: "agent-01",
          universeId: "ward-7",
          packageId: `pkg-${label}`,
          artifactSha256: ARTIFACT,
          destinations: ["youtube"],
          captionSnapshot: { title: `Episode ${label}` },
          policyVersion: String(policy.policyVersion),
          delegatedPolicyId: policy.policyId,
          ...overrides,
        });
        await repo.queueNotification({
          approvalId: request.id,
          kind: NOTIFICATION_KIND.OWNER_APPROVAL_REQUEST,
        });
        return request;
      }

      async function deliver(requestId, at = DELIVERED_AT) {
        return repo.markNotificationDelivered({
          dedupeKey: ownerNotificationDedupeKey(requestId),
          at,
        });
      }

      /** Move the durable window into the past without breaking the 5h CHECK. */
      async function expireNow(requestId) {
        await pool.query(
          `UPDATE forge_publishing_approvals a
              SET notified_at = t.n,
                  deadline_at = t.n + interval '5 hours'
             FROM (SELECT clock_timestamp() - interval '6 hours' AS n) t
            WHERE a.id = $1`,
          [requestId]
        );
      }

      const worker = (checksProvider, instanceId = "d5-worker-1") =>
        new PublishingApprovalDeadlineWorker({
          repository: repo,
          checksProvider,
          notifier: createOwnerInboxNotifier({ repository: repo }),
          instanceId,
        });

      /* ------------------------------------------------------------ Test A */
      const requestA = await createPending("A");
      let stored = await repo.getRequest(requestA.id);
      assert.equal(stored.status, "PENDING_NOTIFICATION");
      assert.equal(stored.deadlineAt, null, "the clock must not start before delivery");

      const deliveredA = await deliver(requestA.id);
      assert.equal(deliveredA.notification.state, "delivered");
      stored = await repo.getRequest(requestA.id);
      assert.equal(stored.status, "AWAITING_OWNER");
      assert.equal(stored.notifiedAt, DELIVERED_AT);
      assert.equal(
        new Date(stored.deadlineAt).getTime() - new Date(stored.notifiedAt).getTime(),
        5 * 60 * 60 * 1000,
        "deadline is exactly five hours after confirmed delivery"
      );

      const earlyWorkerA = worker(async () => allPassingChecks(), "d5-early");
      const earlyCycle = await earlyWorkerA.runOnce();
      assert.equal(earlyCycle.claimed, 0, "no HERMES evaluation inside the Owner window");
      assert.equal((await repo.getRequest(requestA.id)).status, "AWAITING_OWNER");

      /* ------------------------------------------------------------ Test B */
      const requestB = await createPending("B");
      const notifierFailure = new PublishingApprovalDeadlineWorker({
        repository: repo,
        checksProvider: async () => allPassingChecks(),
        notifier: {
          channel: "email",
          deliver: async () => {
            throw new Error("SMTP_UNREACHABLE");
          },
        },
        instanceId: "d5-failing-channel",
      });
      const failingNotification = await repo.getNotification(ownerNotificationDedupeKey(requestB.id));
      assert.equal(await notifierFailure.deliver(failingNotification), "failed");

      const failedState = await repo.getNotification(ownerNotificationDedupeKey(requestB.id));
      assert.equal(failedState.state, "failed");
      assert.equal(failedState.attempts, 1);
      assert.ok(failedState.lastError.includes("SMTP_UNREACHABLE"));

      stored = await repo.getRequest(requestB.id);
      assert.equal(stored.status, "PENDING_NOTIFICATION", "failed delivery keeps the request pending");
      assert.equal(stored.notifiedAt, null);
      assert.equal(stored.deadlineAt, null, "no five-hour clock without confirmed delivery");

      // Bounded retry, then a real delivery that starts the clock from IT.
      await repo.retryNotification(ownerNotificationDedupeKey(requestB.id));
      const lateDelivery = new Date(Date.now() - 30_000).toISOString();
      await repo.markNotificationDelivered({
        dedupeKey: ownerNotificationDedupeKey(requestB.id),
        at: lateDelivery,
      });
      stored = await repo.getRequest(requestB.id);
      assert.equal(stored.notifiedAt, lateDelivery);
      assert.equal(
        new Date(stored.deadlineAt).getTime() - new Date(stored.notifiedAt).getTime(),
        5 * 60 * 60 * 1000,
        "the clock is derived from the confirmed delivery, not the creation time"
      );

      /* ------------------------------------------------------------ Test C */
      const requestC = await createPending("C");
      await deliver(requestC.id);
      const ownerApproval = await repo.recordOwnerDecision({
        approvalId: requestC.id,
        ownerId,
        decision: "APPROVE",
        artifactSha256: ARTIFACT,
      });
      assert.equal(ownerApproval.request.status, "OWNER_APPROVED");
      assert.equal(ownerApproval.request.publishingAuthorized, true);
      assert.ok(ownerApproval.request.authorizationExpiresAt);

      await expireNow(requestC.id);
      const cCycle = await worker(async () => allPassingChecks(), "d5-c").runOnce();
      assert.equal(cCycle.claimed, 0, "an Owner decision removes the request from HERMES scope");
      stored = await repo.getRequest(requestC.id);
      assert.equal(stored.status, "OWNER_APPROVED");
      assert.equal(stored.hermesDecision, null);

      const decisionC = await repo.listDecisions(requestC.id);
      assert.equal(decisionC.filter((d) => d.actor === "HERMES").length, 0);

      // Binding: the approval only authorizes its exact artifact + destination.
      let gate = await repo.verifyAuthorization({
        approvalId: requestC.id,
        artifactSha256: ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, true);
      gate = await repo.verifyAuthorization({
        approvalId: requestC.id,
        artifactSha256: OTHER_ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, false);
      assert.equal(gate.code, "ARTIFACT_HASH_MISMATCH");
      gate = await repo.verifyAuthorization({
        approvalId: requestC.id,
        artifactSha256: ARTIFACT,
        destination: "instagram",
      });
      assert.equal(gate.code, "DESTINATION_NOT_AUTHORIZED");

      // Owner-scope isolation.
      await assert.rejects(
        repo.recordOwnerDecision({
          approvalId: requestC.id,
          ownerId: otherOwner,
          decision: "APPROVE",
          artifactSha256: ARTIFACT,
        }),
        (error) => error.code === "OWNER_SCOPE_MISMATCH"
      );

      /* ------------------------------------------------------------ Test D */
      const requestD = await createPending("D");
      await deliver(requestD.id);
      const ownerRejection = await repo.recordOwnerDecision({
        approvalId: requestD.id,
        ownerId,
        decision: "REJECT",
        artifactSha256: ARTIFACT,
        reason: "Episode does not meet the channel's editorial bar.",
      });
      assert.equal(ownerRejection.request.status, "OWNER_REJECTED");
      assert.equal(ownerRejection.request.publishingAuthorized, false);

      await expireNow(requestD.id);
      const dCycle = await worker(async () => allPassingChecks(), "d5-d").runOnce();
      assert.equal(dCycle.claimed, 0, "Owner rejection is final; HERMES never revisits it");
      gate = await repo.verifyAuthorization({
        approvalId: requestD.id,
        artifactSha256: ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, false);
      assert.equal(gate.code, "NO_ACTIVE_APPROVAL");

      /* ------------------------------------------------------------ Test E */
      const requestE = await createPending("E");
      await deliver(requestE.id);
      await expireNow(requestE.id);
      const eCycle = await worker(async () => allPassingChecks(), "d5-e").runOnce();
      assert.equal(eCycle.claimed, 1);
      assert.equal(eCycle.approved, 1);

      stored = await repo.getRequest(requestE.id);
      assert.equal(stored.status, "HERMES_APPROVED");
      assert.equal(stored.hermesDecision, "APPROVE");
      assert.equal(stored.publishingAuthorized, true);
      assert.ok(stored.hermesDecidedAt);
      assert.match(stored.decisionEvidenceHash, /^[a-f0-9]{64}$/);
      assert.deepEqual(stored.decisionReasonCodes, []);
      assert.ok(stored.authorizationExpiresAt);

      const decisionsE = await repo.listDecisions(requestE.id);
      const hermesE = decisionsE.filter((d) => d.actor === "HERMES");
      assert.equal(hermesE.length, 1);
      assert.equal(hermesE[0].decision, "APPROVE");
      assert.equal(hermesE[0].policyId, policy.policyId);
      assert.equal(hermesE[0].policyVersion, policy.policyVersion);

      gate = await repo.verifyAuthorization({
        approvalId: requestE.id,
        artifactSha256: ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, true);
      assert.equal(gate.code, "AUTHORIZED");

      const notificationsE = await repo.listNotifications(requestE.id);
      assert.equal(notificationsE.filter((n) => n.kind === NOTIFICATION_KIND.HERMES_DECISION).length, 1);
      assert.equal(
        notificationsE.find((n) => n.kind === NOTIFICATION_KIND.HERMES_DECISION).state,
        "delivered"
      );

      /* ------------------------------------------------------------ Test F */
      const requestF = await createPending("F");
      await deliver(requestF.id);
      await expireNow(requestF.id);
      const fCycle = await worker(
        async () => ({
          artifactIntegrity: { passed: true, evidence: `artifacts:sha256:${ARTIFACT}` },
          productionQc: { passed: false, reasonCode: "FFPROBE_NOT_VERIFIED" },
        }),
        "d5-f"
      ).runOnce();
      assert.equal(fCycle.rejected, 1);

      stored = await repo.getRequest(requestF.id);
      assert.equal(stored.status, "HERMES_REJECTED");
      assert.equal(stored.publishingAuthorized, false);
      assert.ok(stored.decisionReasonCodes.includes("CHECK_FAILED:productionQc"));
      assert.ok(stored.decisionReasonCodes.includes("CHECK_FAILED:copyrightLicensing"));
      assert.ok(stored.decisionReasonCodes.includes("CHECK_FAILED:advertisingDisclosure"));
      gate = await repo.verifyAuthorization({
        approvalId: requestF.id,
        artifactSha256: ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, false);

      /* ------------------------------------------------------------ Test G */
      const requestG = await createPending("G", {
        delegatedPolicyId: null,
        policyVersion: "1",
      });
      await deliver(requestG.id);
      await expireNow(requestG.id);
      const gCycle = await worker(async () => allPassingChecks(), "d5-g").runOnce();
      assert.equal(gCycle.rejected, 1);
      stored = await repo.getRequest(requestG.id);
      assert.equal(stored.status, "HERMES_REJECTED");
      assert.equal(stored.publishingAuthorized, false);
      assert.ok(stored.decisionReasonCodes.includes("POLICY_NOT_ACTIVE"));
      gate = await repo.verifyAuthorization({
        approvalId: requestG.id,
        artifactSha256: ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, false);

      /* ------------------------------------------------------------ Test H */
      const requestH = await createPending("H");
      await deliver(requestH.id);
      const deadlineBeforeRestart = (await repo.getRequest(requestH.id)).deadlineAt;
      await expireNow(requestH.id);
      const expiredDeadline = (await repo.getRequest(requestH.id)).deadlineAt;

      // Restart: brand-new pool, repository and worker over the same database.
      const restartedRepo = new PostgresPublishingApprovalRepository(instancePool());
      const recovered = await restartedRepo.getRequest(requestH.id);
      assert.equal(recovered.status, "AWAITING_OWNER");
      assert.equal(recovered.deadlineAt, expiredDeadline, "the durable deadline survives the restart");
      assert.equal(
        new Date(recovered.deadlineAt).getTime() - new Date(recovered.notifiedAt).getTime(),
        5 * 60 * 60 * 1000
      );
      assert.notEqual(deadlineBeforeRestart, null);

      const restartedWorker = new PublishingApprovalDeadlineWorker({
        repository: restartedRepo,
        checksProvider: async () => allPassingChecks(),
        notifier: createOwnerInboxNotifier({ repository: restartedRepo }),
        instanceId: "d5-restarted",
      });
      const hCycle = await restartedWorker.runOnce();
      assert.equal(hCycle.approved, 1);
      assert.equal((await restartedRepo.getRequest(requestH.id)).status, "HERMES_APPROVED");

      /* ------------------------------------------------------------ Test I */
      const requestI = await createPending("I");
      await deliver(requestI.id);
      await expireNow(requestI.id);

      const workerI1 = worker(async () => allPassingChecks(), "d5-i-1");
      const workerI2 = new PublishingApprovalDeadlineWorker({
        repository: new PostgresPublishingApprovalRepository(instancePool()),
        checksProvider: async () => allPassingChecks(),
        notifier: createOwnerInboxNotifier({ repository: restartedRepo }),
        instanceId: "d5-i-2",
      });
      const [i1, i2] = await Promise.all([workerI1.runOnce(), workerI2.runOnce()]);
      assert.equal(i1.claimed + i2.claimed, 1, "only one instance may claim the request");
      assert.equal(i1.approved + i2.approved, 1);
      const decisionsI = await repo.listDecisions(requestI.id);
      assert.equal(decisionsI.filter((d) => d.actor === "HERMES").length, 1);

      /* ------------------------------------------------------------ Test J */
      const requestJ = await createPending("J");
      await deliver(requestJ.id);
      await expireNow(requestJ.id);
      const claimedJ = await repo.claimExpiredApprovals({
        workerId: "d5-race",
        leaseSeconds: 60,
        limit: 20,
      });
      const leasedJ = claimedJ.find((entry) => entry.request.id === requestJ.id);
      assert.ok(leasedJ, "the expired request is leased before the race");

      const race = await Promise.allSettled([
        repo.recordOwnerDecision({
          approvalId: requestJ.id,
          ownerId,
          decision: "APPROVE",
          artifactSha256: ARTIFACT,
        }),
        repo.finalizeHermesDecision({
          approvalId: requestJ.id,
          fencingToken: leasedJ.fencingToken,
          decision: "APPROVE",
          reasonCodes: [],
          summary: "Racing deadline decision.",
          evaluatedChecks: {},
          evidenceHash: "e".repeat(64),
          workerId: "d5-race",
        }),
      ]);
      const fulfilled = race.filter((entry) => entry.status === "fulfilled");
      assert.equal(fulfilled.length, 1, "exactly one side may commit a terminal outcome");

      stored = await repo.getRequest(requestJ.id);
      assert.ok(["OWNER_APPROVED", "HERMES_APPROVED"].includes(stored.status));
      const decisionsJ = await repo.listDecisions(requestJ.id);
      assert.equal(decisionsJ.length, 1, "exactly one decision record exists");
      if (stored.status === "OWNER_APPROVED") {
        assert.equal(decisionsJ[0].actor, "OWNER");
        assert.equal(race.find((e) => e.status === "rejected").reason.code, "OWNER_RESPONSE_WON");
      } else {
        assert.equal(decisionsJ[0].actor, "HERMES");
        assert.equal(race.find((e) => e.status === "rejected").reason.code, "OWNER_RESPONSE_TOO_LATE");
      }

      /* ------------------------------------------------------------ Test K */
      // requestE was approved for ARTIFACT; a modified artifact can never reuse it.
      gate = await repo.verifyAuthorization({
        approvalId: requestE.id,
        artifactSha256: OTHER_ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, false);
      assert.equal(gate.code, "ARTIFACT_HASH_MISMATCH");

      const invalidated = await repo.invalidateRequest({
        approvalId: requestE.id,
        reason: "ARTIFACT_REENCODED_AFTER_APPROVAL",
      });
      assert.ok(invalidated.invalidatedAt);
      gate = await repo.verifyAuthorization({
        approvalId: requestE.id,
        artifactSha256: ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, false);
      assert.equal(gate.code, "APPROVAL_REQUEST_SUPERSEDED");

      /* ------------------------------------------------------------ Test M */
      // requestH was decided by the restarted worker; replaying the cycle must
      // produce no second decision and no second logical notification.
      const replayCycle1 = await restartedWorker.runOnce();
      const replayCycle2 = await restartedWorker.runOnce();
      assert.equal(replayCycle1.claimed, 0);
      assert.equal(replayCycle2.claimed, 0);
      const notificationsH = await repo.listNotifications(requestH.id);
      assert.equal(
        notificationsH.filter((n) => n.kind === NOTIFICATION_KIND.HERMES_DECISION).length,
        1,
        "one logical decision notification per request"
      );
      assert.equal((await repo.listDecisions(requestH.id)).length, 1);

      /* ------------------------------------------------------------ Test N */
      await assert.rejects(
        repo.registerPolicy({ policyId: "pol-spend", category: "spending", allowedActions: ["spending.commit"] }),
        (error) => error.code === "POLICY_CATEGORY_NOT_DELEGABLE"
      );
      await assert.rejects(
        repo.registerPolicy({
          policyId: "pol-security",
          category: "publishing",
          allowedActions: ["security.global_governance_change"],
        }),
        (error) => error.code === "POLICY_ACTION_OUT_OF_SCOPE"
      );

      /* ------------------------------------------------------------ Test L */
      const revocable = await repo.registerPolicy({ policyId: `pol-revoked-${Date.now()}` });
      const requestL = await createPending("L", {
        delegatedPolicyId: revocable.policyId,
        policyVersion: String(revocable.policyVersion),
      });
      await deliver(requestL.id);
      await expireNow(requestL.id);
      await repo.revokePolicy(revocable.policyId);

      const lCycle = await worker(async () => allPassingChecks(), "d5-l").runOnce();
      assert.equal(lCycle.rejected, 1);
      stored = await repo.getRequest(requestL.id);
      assert.equal(stored.status, "HERMES_REJECTED");
      assert.equal(stored.publishingAuthorized, false);
      assert.ok(stored.decisionReasonCodes.includes("POLICY_NOT_ACTIVE"));
      gate = await repo.verifyAuthorization({
        approvalId: requestL.id,
        artifactSha256: ARTIFACT,
        destination: "youtube",
      });
      assert.equal(gate.authorized, false);

      /* ------------------------------------------------------------ Test O */
      const appRepository = new PostgresPublishingApprovalRepository(instancePool());
      const appWorker = new PublishingApprovalDeadlineWorker({
        repository: appRepository,
        checksProvider: async () => allPassingChecks(),
        notifier: createOwnerInboxNotifier({ repository: appRepository }),
        instanceId: "d5-http-worker",
      });
      const app = express();
      app.use((req, res, next) => {
        req.forgeSession = { id: ownerId, role: "owner", authenticated: true };
        req.forgeCsrfVerified = true;
        next();
      });
      app.use(
        "/api/publishing-approvals",
        createPublishingApprovalRouter({
          repository: appRepository,
          worker: appWorker,
          verifyCsrf: (req) => req.forgeCsrfVerified === true,
          getOwnerId: (req) => req.forgeSession?.id ?? null,
        })
      );
      const api = supertest(app);

      const httpBody = {
        idempotencyKey: nextKey("O"),
        directorId: "agent-02",
        universeId: "ward-7",
        packageId: "pkg-O",
        artifactSha256: ARTIFACT,
        destinations: ["youtube"],
        policyVersion: String(policy.policyVersion),
        delegatedPolicyId: policy.policyId,
      };
      const createdHttp = await api
        .post("/api/publishing-approvals/requests")
        .send(httpBody)
        .expect(201);

      const httpRequest = createdHttp.body.request;
      assert.equal(httpRequest.status, "AWAITING_OWNER");
      assert.equal(httpRequest.notifications[0].state, "delivered");

      // Idempotent resubmission: same key, same request, no second row.
      const replayHttp = await api
        .post("/api/publishing-approvals/requests")
        .send(httpBody)
        .expect(200);
      assert.equal(replayHttp.body.deduplicated, true);
      assert.equal(replayHttp.body.request.approvalId, httpRequest.approvalId);

      await expireNow(httpRequest.approvalId);

      const deadlineRun = await api
        .post("/api/publishing-approvals/deadline/run")
        .send({})
        .expect(200);
      assert.equal(deadlineRun.body.cycle.approved + deadlineRun.body.cycle.rejected >= 1, true);

      const statusHttp = await api
        .get(`/api/publishing-approvals/requests/${httpRequest.approvalId}`)
        .expect(200);
      assert.equal(statusHttp.body.request.status, "HERMES_APPROVED");
      assert.equal(statusHttp.body.request.decisions[0].actor, "HERMES");

      const authorizationHttp = await api
        .get(`/api/publishing-approvals/requests/${httpRequest.approvalId}/authorization`)
        .query({ artifactSha256: ARTIFACT, destination: "youtube" })
        .expect(200);
      assert.equal(authorizationHttp.body.authorized, true);

      const lateOwnerHttp = await api
        .post(`/api/publishing-approvals/requests/${httpRequest.approvalId}/owner-decision`)
        .send({ decision: "APPROVE", artifactSha256: ARTIFACT })
        .expect(409);
      assert.equal(lateOwnerHttp.body.code, "OWNER_RESPONSE_TOO_LATE");

      // CSRF is enforced on every mutation by the mount's guard.
      const csrfApp = express();
      csrfApp.use((req, res, next) => {
        req.forgeSession = { id: ownerId };
        req.forgeCsrfVerified = false;
        next();
      });
      csrfApp.use(
        "/api/publishing-approvals",
        createPublishingApprovalRouter({
          repository: appRepository,
          worker: appWorker,
          verifyCsrf: (req) => req.forgeCsrfVerified === true,
        })
      );
      await supertest(csrfApp)
        .post("/api/publishing-approvals/policies")
        .send({ policyId: "pol-csrf" })
        .expect(403)
        .expect((res) => assert.equal(res.body.code, "CSRF_REJECTED"));

      // Another Owner cannot read this request (scoped 404, not 403 leak).
      const foreignApp = express();
      foreignApp.use((req, res, next) => {
        req.forgeSession = { id: otherOwner };
        req.forgeCsrfVerified = true;
        next();
      });
      foreignApp.use(
        "/api/publishing-approvals",
        createPublishingApprovalRouter({
          repository: appRepository,
          worker: appWorker,
          verifyCsrf: () => true,
        })
      );
      await supertest(foreignApp)
        .get(`/api/publishing-approvals/requests/${httpRequest.approvalId}`)
        .expect(404);
    } finally {
      for (const aux of auxiliaryPools) await aux.end().catch(() => {});
      await pool.end().catch(() => {});
      assert.equal(await dropDisposableDatabase(POSTGRES_URL, created.name), true);
    }
  }
);
