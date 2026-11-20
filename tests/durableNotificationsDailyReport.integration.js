/**
 * D6 — durable notifications + autonomous daily FORGE report.
 * PostgreSQL 15 acceptance (disposable database, canonical migrations).
 *
 *   A notification creation & durable storage   B in-app delivery
 *   C unconfigured external channel             D real delivery success
 *   E bounded retry on failure                  F max attempts → dead letter + alert
 *   G duplicate events → one notification       H restart recovers pending work
 *   I two workers cannot double-deliver         J report from persisted records
 *   K duplicate scheduler → one report/date     L report worker restart recovery
 *   M 08:00 Asia/Kolkata scheduling             N missed-run recovery policy
 *   O failed external delivery keeps report     P metrics reconcile with SQL
 *   Q NOT_RUN / BLOCKED labelling               R Owner auth + Director isolation
 *   S no secrets in payloads                    T real routers + mounted workers
 *
 * Nothing here touches a persistent database or a real provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import supertest from "supertest";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";
import { PostgresNotificationRepository } from "../src/notifications/notificationRepository.js";
import { createChannelRegistry } from "../src/notifications/notificationChannels.js";
import { NotificationDeliveryWorker } from "../src/notifications/notificationDeliveryWorker.js";
import { NOTIFICATION_EVENT_TYPE } from "../src/notifications/notificationPolicy.js";
import { PostgresDailyReportRepository } from "../src/reporting/dailyReportRepository.js";
import { DailyReportService } from "../src/reporting/dailyReportService.js";
import { DailyReportSchedulerWorker } from "../src/reporting/dailyReportScheduler.js";
import { localDateString, localDateTimeParts } from "../src/reporting/reportSchedule.js";
import { verifyReportEvidenceHash } from "../src/reporting/dailyReportGenerator.js";
import { createNotificationRouter } from "../src/api/notificationRouter.js";
import { createForgeReportRouter } from "../src/api/forgeReportRouter.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";
const ARTIFACT = "a".repeat(64);
const COMMIT = "f".repeat(40);
const WEBHOOK_URL = "https://hooks.example.test/stph-notify";
const quiet = { log() {}, warn() {}, error() {} };

const webhook = { mode: "ok", calls: 0, delayMs: 0, lastBody: null };

async function fetchStub(url, init) {
  webhook.calls += 1;
  webhook.lastBody = init?.body ? JSON.parse(init.body) : null;
  if (webhook.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, webhook.delayMs));
  if (webhook.mode === "throw") {
    const error = new Error("socket hang up");
    error.code = "ECONNRESET";
    throw error;
  }
  if (webhook.mode === "500") return { ok: false, status: 500 };
  return { ok: true, status: 204 };
}

test(
  "PostgreSQL 15 durable notifications + daily FORGE report: outbox, retries, dead letter, scheduler, HTTP",
  { skip: !POSTGRES_URL ? "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" : false },
  async () => {
    const created = await createDisposableDatabase(POSTGRES_URL, "stph_acceptance");
    const pool = new pg.Pool({ connectionString: created.connectionString, max: 12 });
    const auxiliaryPools = [];
    const auxPool = () => {
      const poolInstance = new pg.Pool({ connectionString: created.connectionString, max: 4 });
      auxiliaryPools.push(poolInstance);
      return poolInstance;
    };

    try {
      const migrations = await new MigrationRunner(new PostgresAdapter({}, pool)).runMigrations();
      assert.ok(migrations.appliedCount >= 44, "migration 044 must be part of the canonical set");

      const ownerId = (
        await pool.query("INSERT INTO owners (email, password_hash) VALUES ($1, 'test-hash') RETURNING id", [
          `d6-owner-${Date.now()}@example.test`,
        ])
      ).rows[0].id;
      const otherOwnerId = (
        await pool.query("INSERT INTO owners (email, password_hash) VALUES ($1, 'test-hash') RETURNING id", [
          `d6-other-${Date.now()}@example.test`,
        ])
      ).rows[0].id;

      const repo = new PostgresNotificationRepository(pool);
      const registry = createChannelRegistry({
        repository: repo,
        env: { STPH_NOTIFICATION_WEBHOOK_URL: WEBHOOK_URL },
        fetchImpl: fetchStub,
      });
      const makeWorker = (repositoryInstance = repo, instanceId = "d6-worker-1") =>
        new NotificationDeliveryWorker({
          repository: repositoryInstance,
          channels: registry,
          instanceId,
          random: () => 0.5,
          leaseSeconds: 60,
          batchSize: 50,
          logger: quiet,
        });
      const worker = makeWorker();

      const reportRepository = new PostgresDailyReportRepository(pool);
      const reportService = new DailyReportService({
        pool,
        reportRepository,
        logger: quiet,
        backlogDirectory: process.cwd(),
      });
      const makeScheduler = (repositoryInstance, instanceId, notifier = worker) =>
        new DailyReportSchedulerWorker({
          reportRepository: repositoryInstance,
          service: reportService,
          notifier,
          instanceId,
          logger: quiet,
          leaseSeconds: 60,
        });

      /* ------------------------------------------------- Test M (default schedule) */
      const seededSchedule = await reportRepository.ensureSchedule();
      assert.equal(seededSchedule.timezone, "Asia/Kolkata");
      assert.equal(seededSchedule.localHour, 8);
      assert.equal(seededSchedule.localMinute, 0);
      assert.equal(seededSchedule.missedRunPolicy, "RUN_ONCE_ON_RECOVERY");
      const seededNext = localDateTimeParts(new Date(seededSchedule.nextRunAt), "Asia/Kolkata");
      assert.equal(seededNext.hour, 8);
      assert.equal(seededNext.minute, 0);
      assert.ok(new Date(seededSchedule.nextRunAt).getTime() > Date.now());

      /* --------------------------------------------- Test A/B/C/D/S (first event) */
      const eventASpec = {
        eventType: NOTIFICATION_EVENT_TYPE.FORGE_TASK_COMPLETED,
        ownerId,
        taskRef: "forge-task-A",
        idempotencyKey: `d6-A-${Date.now()}`,
        payload: {
          message: "Durable notifications landed.",
          artifactSha256: ARTIFACT,
          apiKey: "sk-live-d6-never-store",
          password: "hunter2-d6",
          nested: { token: "tok_d6_never_store" },
          note: "y".repeat(900),
        },
      };
      const dispatchA = await worker.dispatch(eventASpec);
      assert.equal(dispatchA.delivered, true);

      const storedA = await pool.query("SELECT * FROM forge_notification_events WHERE id = $1", [dispatchA.event.id]);
      assert.equal(storedA.rowCount, 1, "A: the event is durably persisted");
      assert.equal(storedA.rows[0].event_type, "FORGE_TASK_COMPLETED");
      assert.equal(storedA.rows[0].priority, "NORMAL");
      assert.equal(storedA.rows[0].idempotency_key, eventASpec.idempotencyKey);
      assert.ok(storedA.rows[0].created_at);

      const inboxDeliveryA = dispatchA.deliveries.find((entry) => entry.channel === "owner_inbox");
      assert.equal(inboxDeliveryA.state, "delivered", "B: in-app delivery is confirmed");
      assert.ok(inboxDeliveryA.deliveredAt);
      assert.equal(inboxDeliveryA.attempts, 1);

      for (const channel of ["email", "push"]) {
        const delivery = dispatchA.deliveries.find((entry) => entry.channel === channel);
        assert.equal(delivery.state, "unconfigured", `${channel} is honestly unconfigured`);
        assert.equal(delivery.attempts, 0);
        assert.equal(delivery.errorClass, "UNCONFIGURED");
        assert.equal(delivery.deliveredAt, null);
      }

      const webhookDeliveryA = dispatchA.deliveries.find((entry) => entry.channel === "webhook");
      assert.equal(webhookDeliveryA.state, "delivered", "D: a real transport success is recorded");
      assert.equal(webhookDeliveryA.attempts, 1);
      assert.ok(webhookDeliveryA.deliveredAt);
      assert.equal(webhookDeliveryA.channelRef, "webhook:204");
      assert.equal(dispatchA.deliveries.length, 4, "one durable row per channel");

      const sanitizedPayload = JSON.stringify(storedA.rows[0].payload);
      assert.ok(!sanitizedPayload.includes("sk-live-d6-never-store"), "S: no api key in the stored payload");
      assert.ok(!sanitizedPayload.includes("hunter2-d6"), "S: no password in the stored payload");
      assert.ok(!sanitizedPayload.includes("tok_d6_never_store"), "S: no nested token in the stored payload");
      assert.equal(storedA.rows[0].payload.note.length <= 501, true, "S: long strings are truncated");
      assert.ok(!JSON.stringify(webhook.lastBody).includes("sk-live-d6-never-store"), "S: no secret sent to transport");

      /* ------------------------------------------------------- Test E (retry) */
      webhook.mode = "throw";
      webhook.calls = 0;
      const dispatchE = await worker.dispatch({
        eventType: NOTIFICATION_EVENT_TYPE.PUBLISHING_FAILED,
        ownerId,
        taskRef: "publish-E",
        idempotencyKey: `d6-E-${Date.now()}`,
        payload: { message: "Upload failed." },
      });
      const webhookDeliveryE = dispatchE.deliveries.find((entry) => entry.channel === "webhook");
      assert.equal(webhookDeliveryE.state, "retry_scheduled");
      assert.equal(webhookDeliveryE.attempts, 1);
      assert.equal(webhookDeliveryE.errorClass, "TRANSIENT");
      assert.ok(webhookDeliveryE.nextAttemptAt);
      assert.ok(new Date(webhookDeliveryE.nextAttemptAt).getTime() > Date.now(), "E: a durable future retry is scheduled");
      assert.equal(dispatchE.deliveries.find((entry) => entry.channel === "owner_inbox").state, "delivered");

      /* ------------------------------------------ Test F (dead letter + alert) */
      await pool.query(
        "UPDATE forge_notification_deliveries SET max_attempts = 2, next_attempt_at = clock_timestamp() WHERE id = $1",
        [webhookDeliveryE.id]
      );
      await worker.runOnce();
      const webhookDeliveryF = await repo.getDelivery(webhookDeliveryE.id);
      assert.equal(webhookDeliveryF.state, "dead_letter", "F: exhausted attempts move to dead letter");
      assert.ok(webhookDeliveryF.deadLetteredAt);
      assert.equal(webhookDeliveryF.attempts, 2);
      assert.equal(webhookDeliveryF.nextAttemptAt, null);

      const alerts = await pool.query(
        "SELECT * FROM forge_notification_events WHERE event_type = 'DELIVERY_ALERT' AND owner_id = $1",
        [ownerId]
      );
      assert.ok(alerts.rowCount >= 1, "F: repeated failure raises an observable Owner-inbox alert");
      const alertDelivery = await repo.listDeliveriesForEvent(alerts.rows[0].id);
      assert.equal(alertDelivery.find((entry) => entry.channel === "owner_inbox").state, "delivered");
      const deadLetters = await repo.listDeadLetters({ ownerId, limit: 20 });
      assert.ok(deadLetters.some((entry) => entry.id === webhookDeliveryE.id), "dead letters remain inspectable");

      /* ------------------------------------------------ Test G (deduplication) */
      const eventsBefore = (await pool.query("SELECT count(*)::int AS c FROM forge_notification_events")).rows[0].c;
      const duplicate = await worker.dispatch(eventASpec);
      assert.equal(duplicate.deduplicated, true);
      const eventsAfter = (await pool.query("SELECT count(*)::int AS c FROM forge_notification_events")).rows[0].c;
      assert.equal(eventsAfter, eventsBefore, "G: a duplicate event is not inserted twice");
      assert.equal((await repo.listDeliveriesForEvent(dispatchA.event.id)).length, 4, "G: no duplicate delivery rows");

      /* --------------------------------------------- Test H (restart recovery) */
      webhook.mode = "ok";
      webhook.calls = 0;
      const dispatchH = await worker.dispatch({
        eventType: NOTIFICATION_EVENT_TYPE.WORKER_CRASH,
        ownerId,
        taskRef: "worker-H",
        idempotencyKey: `d6-H-${Date.now()}`,
        payload: { message: "Worker heartbeat lost." },
      });
      const webhookDeliveryH = dispatchH.deliveries.find((entry) => entry.channel === "webhook");
      assert.equal(webhookDeliveryH.state, "delivered");

      // Simulate a process that claimed the delivery and died before confirming.
      await pool.query(
        `UPDATE forge_notification_deliveries
            SET state = 'attempted', attempts = 1, lease_owner = 'dead-worker',
                lease_expires_at = clock_timestamp() - interval '1 minute',
                fencing_token = fencing_token + 1, delivered_at = NULL, channel_ref = NULL,
                next_attempt_at = NULL
          WHERE id = $1`,
        [webhookDeliveryH.id]
      );

      const restartedWorker = makeWorker(new PostgresNotificationRepository(auxPool()), "d6-restarted");
      const cycleH = await restartedWorker.runOnce();
      assert.ok(cycleH.recoveredLeases >= 1, "H: the expired lease is recovered, not dropped");
      const recoveredDeliveryH = await repo.getDelivery(webhookDeliveryH.id);
      assert.equal(recoveredDeliveryH.state, "delivered", "H: the restarted worker delivers the pending event");
      assert.equal(recoveredDeliveryH.attempts, 2);

      /* ------------------------------------- Test I (two workers, one delivery) */
      webhook.mode = "slow";
      webhook.delayMs = 40;
      webhook.calls = 0;
      const { event: eventI } = await repo.createEvent({
        eventType: NOTIFICATION_EVENT_TYPE.WORKER_RETRY_EXHAUSTED,
        ownerId,
        taskRef: "worker-I",
        idempotencyKey: `d6-I-${Date.now()}`,
        payload: { message: "Two workers race." },
      });
      await repo.enqueueDeliveries({ eventId: eventI.id, channelPlan: await registry.plan() });
      const [cycleI1, cycleI2] = await Promise.all([
        makeWorker(new PostgresNotificationRepository(auxPool()), "d6-i-1").runOnce(),
        makeWorker(new PostgresNotificationRepository(auxPool()), "d6-i-2").runOnce(),
      ]);
      assert.equal(webhook.calls, 1, "I: only one worker performs the external delivery");
      assert.equal(cycleI1.claimed + cycleI2.claimed, 2, "I: only claimable channels are claimed");
      const deliveriesI = await repo.listDeliveriesForEvent(eventI.id);
      const webhookDeliveryI = deliveriesI.find((entry) => entry.channel === "webhook");
      assert.equal(webhookDeliveryI.state, "delivered");
      assert.equal(webhookDeliveryI.attempts, 1);
      assert.equal(deliveriesI.find((entry) => entry.channel === "owner_inbox").state, "delivered");
      webhook.mode = "ok";
      webhook.delayMs = 0;

      /* ------------------------------------------- Test J/P (report from records) */
      const forgeWorker = (
        await pool.query("INSERT INTO forge_workers (worker_key, role) VALUES ($1, 'coder') RETURNING id", [
          `d6-worker-${Date.now()}`,
        ])
      ).rows[0];
      const forgeTask = (
        await pool.query(
          `INSERT INTO forge_tasks (issue_number, derived_branch, title, status, idempotency_key)
           VALUES ($1, $2, $3, 'ACCEPTED', $4) RETURNING id`,
          [298, "task/298-durable-notifications-daily-report", "Durable notifications and daily report", `d6-task-${Date.now()}`]
        )
      ).rows[0];
      await pool.query(
        "INSERT INTO forge_task_results (task_id, worker_id, fencing_token, outcome, result) VALUES ($1, $2, 1, 'SUCCEEDED', '{}'::jsonb)",
        [forgeTask.id, forgeWorker.id]
      );
      await pool.query(
        "INSERT INTO forge_task_results (task_id, worker_id, fencing_token, outcome, result) VALUES ($1, $2, 2, 'FAILED', '{}'::jsonb)",
        [forgeTask.id, forgeWorker.id]
      );
      const pullRequest = (
        await pool.query(
          `INSERT INTO forge_pull_requests (task_id, pr_number, branch_name, head_sha, state)
           VALUES ($1, $2, $3, $4, 'merged') RETURNING id`,
          [forgeTask.id, 9000 + (Date.now() % 900), "task/298-durable-notifications-daily-report", COMMIT]
        )
      ).rows[0];
      await pool.query(
        `INSERT INTO forge_ci_results (pr_id, commit_sha, workflow_name, run_id, status)
         VALUES ($1, $2, 'CI', $3, 'success')`,
        [pullRequest.id, COMMIT, `d6-run-${Date.now()}`]
      );

      await pool.query(
        "INSERT INTO agents (id, name, namespace) VALUES ('agent-d6', 'Director D6', 'director-d6') ON CONFLICT (id) DO NOTHING"
      );
      const artifact = (
        await pool.query(
          `INSERT INTO artifacts (kind, storage_uri, sha256, ffprobe_verified, metadata)
           VALUES ('video', 's3://stph/d6-report.mp4', $1, true, '{}'::jsonb) RETURNING id`,
          [ARTIFACT]
        )
      ).rows[0];
      const publishingRequest = (
        await pool.query(
          `INSERT INTO publishing_requests
             (artifact_id, destination, caption_snapshot, mode, status, approved_by, approval_expires_at)
           VALUES ($1, 'youtube', 'D6 report fixture', 'approved', 'approved', $2, clock_timestamp() + interval '1 hour')
           RETURNING id`,
          [artifact.id, ownerId]
        )
      ).rows[0];
      await pool.query(
        `INSERT INTO publishing_receipts
           (publishing_request_id, platform_post_id, platform_url, provider_response_sha256)
         VALUES ($1, $2, $3, $4)`,
        [
          publishingRequest.id,
          `yt-d6-${Date.now()}`,
          "https://www.youtube.com/watch?v=d6-report",
          "b".repeat(64),
        ]
      );

      await pool.query(
        `WITH t AS (SELECT clock_timestamp() - interval '1 hour' AS n)
         INSERT INTO forge_publishing_approvals
           (idempotency_key, owner_id, director_id, artifact_sha256, destinations, policy_version,
            status, notified_at, deadline_at)
         SELECT $1, $2, 'agent-01', $3, ARRAY['youtube'], '1', 'AWAITING_OWNER',
                t.n, t.n + interval '5 hours'
           FROM t`,
        [`d6-approval-${Date.now()}`, ownerId, ARTIFACT]
      );

      await pool.query(
        `INSERT INTO authentication_audit_events (owner_id, event_type, payload)
         VALUES ($1, 'login_succeeded', '{}'::jsonb), ($1, 'login_failed', '{}'::jsonb)`,
        [ownerId]
      );

      const todayIst = localDateString(new Date(), "Asia/Kolkata");
      const manualClaim = await reportRepository.claimManualReport({
        reportDate: todayIst,
        workerId: "d6-manual",
      });
      assert.equal(manualClaim.claimed, true);
      const generatedToday = await reportService.generate({
        reportId: manualClaim.report.id,
        fencingToken: manualClaim.fencingToken,
        reportDate: todayIst,
        timeZone: "Asia/Kolkata",
        windowStart: manualClaim.report.windowStart,
        windowEnd: manualClaim.report.windowEnd,
      });
      assert.equal(generatedToday.report.status, "complete", "J: the report is durably stored");
      assert.match(generatedToday.report.evidenceHash, /^[a-f0-9]{64}$/);
      assert.equal(generatedToday.hashValid, true, "J: the stored payload matches its evidence hash");
      assert.equal(verifyReportEvidenceHash(generatedToday.payload), true);

      const reportPayload = generatedToday.payload;
      assert.equal(reportPayload.reportDate, todayIst);
      assert.equal(reportPayload.sections.forgeOperations.tasksCompleted.value, 1);
      assert.equal(reportPayload.sections.forgeOperations.tasksFailed.value, 1);
      assert.equal(reportPayload.sections.repository.mergedPullRequests.value, 1);
      assert.ok(reportPayload.sections.repository.ciRuns.value >= 1);
      assert.equal(reportPayload.sections.repository.ciRuns.verification, "CI_VERIFIED");
      assert.equal(reportPayload.sections.mediaProduction.ffprobeVerified.value, 1);
      assert.equal(
        reportPayload.sections.mediaProduction.ffprobeVerified.verification,
        "PRODUCTION_VERIFIED"
      );
      assert.equal(reportPayload.sections.publishingAndAnalytics.uploadsConfirmedByReceipt.value, 1);
      assert.equal(
        reportPayload.sections.publishingAndAnalytics.uploadsConfirmedByReceipt.verification,
        "PROVIDER_VERIFIED"
      );
      assert.equal(reportPayload.sections.hermesOperations.outstandingDecisions.value, 1);
      assert.equal(reportPayload.sections.executiveSummary.productionActivity, true);
      assert.ok(reportPayload.claims.length >= 5);
      assert.ok(reportPayload.claims.every((claim) => claim.evidence && claim.verification));

      // P: every headline metric reconciles with a direct SQL count in the same window.
      const reconciliation = async (sql, params) => (await pool.query(sql, params)).rows[0].c;
      const windowParams = [reportPayload.window.start, reportPayload.window.end];
      assert.equal(
        reportPayload.sections.forgeOperations.tasksCompleted.value,
        await reconciliation(
          "SELECT count(*)::int AS c FROM forge_task_results WHERE outcome = 'SUCCEEDED' AND created_at >= $1 AND created_at < $2",
          windowParams
        )
      );
      assert.equal(
        reportPayload.sections.mediaProduction.ffprobeVerified.value,
        await reconciliation(
          "SELECT count(*)::int AS c FROM artifacts WHERE ffprobe_verified = true AND created_at >= $1 AND created_at < $2",
          windowParams
        )
      );
      assert.equal(
        reportPayload.sections.publishingAndAnalytics.uploadsConfirmedByReceipt.value,
        await reconciliation(
          "SELECT count(*)::int AS c FROM publishing_receipts WHERE received_at >= $1 AND received_at < $2",
          windowParams
        )
      );
      assert.equal(
        reportPayload.sections.notifications.eventsCreated.value,
        await reconciliation(
          "SELECT count(*)::int AS c FROM forge_notification_events WHERE created_at >= $1 AND created_at < $2",
          windowParams
        )
      );

      /* -------------------------------- Test Q (NOT_RUN / BLOCKED honesty) */
      assert.equal(reportPayload.sections.mediaProduction.scriptsGenerated.verification, "NOT_RUN");
      assert.equal(reportPayload.sections.mediaProduction.ffmpegRendersCompleted.verification, "NOT_RUN");
      assert.equal(
        reportPayload.sections.securityAndInfrastructure.backupStatus.verification,
        "NOT_RUN"
      );
      assert.equal(
        reportPayload.sections.securityAndInfrastructure.cloudRuntimeStatus.verification,
        "NOT_RUN"
      );
      assert.equal(
        reportPayload.sections.repository.issuesCompleted.verification,
        "NOT_RUN",
        "Q: unmirrored issue tracker data is never guessed"
      );
      assert.equal(
        reportPayload.sections.mediaProduction.artifactsAwaitingQc.verification,
        "BLOCKED",
        "Q: an unverified artifact is labelled BLOCKED, not completed"
      );
      assert.equal(reportPayload.sections.publishingAndAnalytics.uncertainUploads.verification, "NOT_RUN");
      assert.ok(reportPayload.accuracyLegend.NOT_RUN.includes("No durable evidence"));

      /* --------------------- Test K (duplicate scheduler → one report per date) */
      const yesterdayIst = localDateString(new Date(Date.now() - 86_400_000), "Asia/Kolkata");
      await pool.query(
        "UPDATE forge_report_schedule SET next_run_at = clock_timestamp() - interval '1 day' WHERE schedule_id = 'forge_daily_report'"
      );
      const schedulerK1 = makeScheduler(reportRepository, "d6-sched-1");
      const schedulerK2 = makeScheduler(new PostgresDailyReportRepository(auxPool()), "d6-sched-2");
      const [cycleK1, cycleK2] = await Promise.all([schedulerK1.runOnce(), schedulerK2.runOnce()]);
      const reportsForYesterday = await pool.query(
        "SELECT count(*)::int AS c FROM forge_daily_reports WHERE report_date = $1::date",
        [yesterdayIst]
      );
      assert.equal(reportsForYesterday.rows[0].c, 1, "K: exactly one report per reporting date");
      assert.equal(cycleK1.generated + cycleK2.generated, 1, "K: only one scheduler execution generates");
      assert.ok(
        ["NOT_DUE", "REPORT_ALREADY_EXISTS", null].includes(cycleK1.schedule.reason) &&
          ["NOT_DUE", "REPORT_ALREADY_EXISTS", null].includes(cycleK2.schedule.reason)
      );
      const scheduleAfterK = await reportRepository.getSchedule();
      assert.ok(new Date(scheduleAfterK.nextRunAt).getTime() > Date.now(), "K: the next run advanced durably");

      /* ---------------------------------- Test L (report worker restart recovery) */
      const staleDate = "2020-01-05";
      const staleReport = (
        await pool.query(
          `INSERT INTO forge_daily_reports
             (report_date, timezone, window_start, window_end, status,
              generation_attempts, generation_lease_owner, generation_lease_expires_at,
              generation_fencing_token)
           VALUES ($1::date, 'Asia/Kolkata', '2020-01-04T18:30:00Z', '2020-01-05T18:30:00Z',
                   'generating', 1, 'dead-scheduler', clock_timestamp() - interval '10 minutes', 1)
           RETURNING id`,
          [staleDate]
        )
      ).rows[0];
      const schedulerL = makeScheduler(new PostgresDailyReportRepository(auxPool()), "d6-sched-restarted");
      const cycleL = await schedulerL.runOnce();
      assert.ok(cycleL.recovered >= 1, "L: an interrupted report is re-claimed after restart");
      const recoveredReport = await reportRepository.getReport(staleReport.id);
      assert.equal(recoveredReport.status, "complete", "L: the restarted scheduler completes the report");
      assert.equal(recoveredReport.generationAttempts, 2);
      assert.equal(verifyReportEvidenceHash(recoveredReport.payload), true);

      /* ------------------------------------- Test N (missed-run recovery policy) */
      const twoDaysAgo = localDateString(new Date(Date.now() - 2 * 86_400_000), "Asia/Kolkata");
      await pool.query(
        "UPDATE forge_report_schedule SET next_run_at = clock_timestamp() - interval '2 days' WHERE schedule_id = 'forge_daily_report'"
      );
      const schedulerN = makeScheduler(new PostgresDailyReportRepository(auxPool()), "d6-sched-catchup");
      const cycleN = await schedulerN.runOnce();
      assert.equal(cycleN.schedule.missed, true, "N: the missed run is detected from database time");
      assert.equal(cycleN.generated, 1, "N: RUN_ONCE_ON_RECOVERY generates the missed report once");
      assert.ok(await reportRepository.getReportByDate(twoDaysAgo), "N: the catch-up report exists for the missed date");
      assert.equal(
        (await pool.query("SELECT count(*)::int AS c FROM forge_daily_reports WHERE report_date = $1::date", [twoDaysAgo]))
          .rows[0].c,
        1
      );

      const threeDaysAgo = localDateString(new Date(Date.now() - 3 * 86_400_000), "Asia/Kolkata");
      await pool.query(
        "UPDATE forge_report_schedule SET missed_run_policy = 'SKIP' WHERE schedule_id = 'forge_daily_report'"
      );
      await pool.query(
        "UPDATE forge_report_schedule SET next_run_at = clock_timestamp() - interval '3 days' WHERE schedule_id = 'forge_daily_report'"
      );
      const schedulerSkip = makeScheduler(new PostgresDailyReportRepository(auxPool()), "d6-sched-skip");
      const cycleSkip = await schedulerSkip.runOnce();
      assert.equal(cycleSkip.schedule.reason, "MISSED_RUN_SKIPPED");
      assert.equal(cycleSkip.generated, 0, "N: SKIP never fabricates a catch-up report");
      assert.equal(await reportRepository.getReportByDate(threeDaysAgo), null);
      await pool.query(
        "UPDATE forge_report_schedule SET missed_run_policy = 'RUN_ONCE_ON_RECOVERY' WHERE schedule_id = 'forge_daily_report'"
      );

      /* ------------------- Test O (failed external delivery keeps the report) */
      webhook.mode = "throw";
      webhook.calls = 0;
      await pool.query(
        "UPDATE forge_report_schedule SET next_run_at = '2020-02-10T02:30:00Z' WHERE schedule_id = 'forge_daily_report'"
      );
      const schedulerO = makeScheduler(new PostgresDailyReportRepository(auxPool()), "d6-sched-delivery");
      const cycleO = await schedulerO.runOnce();
      assert.equal(cycleO.generated, 1);
      const reportO = await reportRepository.getReportByDate("2020-02-10");
      assert.equal(reportO.status, "complete", "O: the report is complete before delivery is attempted");
      assert.ok(reportO.notificationEventId, "O: the report notification event is linked");
      const deliveryO = await repo.listDeliveriesForEvent(reportO.notificationEventId);
      const webhookO = deliveryO.find((entry) => entry.channel === "webhook");
      assert.equal(webhookO.state, "retry_scheduled", "O: the external failure is recorded honestly");
      const rereadO = await reportRepository.getReport(reportO.id);
      assert.equal(rereadO.status, "complete", "O: the report survives the failed external delivery");
      assert.equal(verifyReportEvidenceHash(rereadO.payload), true);
      webhook.mode = "ok";

      /* ---------------- Test R/T (real routers, auth, CSRF, isolation) --------- */
      const appRepository = new PostgresNotificationRepository(auxPool());
      const appRegistry = createChannelRegistry({
        repository: appRepository,
        env: { STPH_NOTIFICATION_WEBHOOK_URL: WEBHOOK_URL },
        fetchImpl: fetchStub,
      });
      const appWorker = makeWorker(appRepository, "d6-http-worker");
      const appReportRepository = new PostgresDailyReportRepository(auxPool());
      const appService = new DailyReportService({
        pool,
        reportRepository: appReportRepository,
        logger: quiet,
        backlogDirectory: process.cwd(),
      });
      const appScheduler = makeScheduler(appReportRepository, "d6-http-scheduler", appWorker);

      const buildApp = ({ sessionOwner = null, csrf = true } = {}) => {
        const app = express();
        app.use((req, res, next) => {
          if (sessionOwner) req.forgeSession = { id: sessionOwner, role: "owner", authenticated: true };
          req.forgeCsrfVerified = csrf;
          next();
        });
        const ownerOptions = {
          verifyCsrf: (req) => req.forgeCsrfVerified === true,
          getOwnerId: (req) => req.forgeSession?.id ?? null,
          logger: quiet,
        };
        app.use(
          "/api/notifications",
          createNotificationRouter({
            repository: appRepository,
            worker: appWorker,
            channels: appRegistry,
            ...ownerOptions,
          })
        );
        app.use(
          "/api/forge-reports",
          createForgeReportRouter({
            reportRepository: appReportRepository,
            service: appService,
            scheduler: appScheduler,
            instanceId: "d6-http",
            ...ownerOptions,
          })
        );
        return app;
      };

      const ownerApp = supertest(buildApp({ sessionOwner: ownerId }));
      const noSession = supertest(buildApp({ sessionOwner: null }));
      const csrfOff = supertest(buildApp({ sessionOwner: ownerId, csrf: false }));
      const foreign = supertest(buildApp({ sessionOwner: otherOwnerId }));

      await noSession.get("/api/notifications/inbox").expect(401);
      await noSession.get("/api/forge-reports/reports").expect(401);
      await csrfOff
        .post(`/api/notifications/inbox/${dispatchA.event.id}/read`)
        .send({})
        .expect(403)
        .expect((res) => assert.equal(res.body.code, "CSRF_REJECTED"));
      await csrfOff
        .patch("/api/forge-reports/schedule")
        .send({ localHour: 7 })
        .expect(403)
        .expect((res) => assert.equal(res.body.code, "CSRF_REJECTED"));

      // R: another Owner cannot read or mutate this Owner's notification.
      await foreign.get(`/api/notifications/inbox/${dispatchA.event.id}`).expect(404);
      await foreign.post(`/api/notifications/inbox/${dispatchA.event.id}/read`).send({}).expect(404);
      await foreign
        .post(`/api/notifications/deliveries/${webhookDeliveryE.id}/retry`)
        .send({})
        .expect(404);

      // R: the custody channel cannot be disabled and an unconfigured channel
      // cannot be switched on by a client.
      await ownerApp
        .patch("/api/notifications/channels/owner_inbox")
        .send({ enabled: false })
        .expect(409)
        .expect((res) => assert.equal(res.body.code, "INBOX_CHANNEL_IMMUTABLE"));
      await ownerApp
        .patch("/api/notifications/channels/email")
        .send({ enabled: true })
        .expect(409)
        .expect((res) => assert.equal(res.body.code, "CHANNEL_NOT_CONFIGURABLE"));
      await ownerApp
        .patch("/api/notifications/channels/email")
        .send({ enabled: false })
        .expect(200)
        .expect((res) => assert.equal(res.body.channel.ownerEnabled, false));

      // R: a Director-recipient event never appears in the Owner inbox.
      const { event: directorEvent } = await appRepository.createEvent({
        eventType: NOTIFICATION_EVENT_TYPE.DIRECTOR_PRODUCTION_FAILED,
        recipient: "director:agent-d6",
        directorId: "agent-d6",
        idempotencyKey: `d6-director-${Date.now()}`,
        payload: { message: "Director render failed." },
      });
      const inboxList = await ownerApp.get("/api/notifications/inbox?limit=100").expect(200);
      assert.ok(
        !inboxList.body.events.some((event) => event.id === directorEvent.id),
        "R: Director events are not exposed in the Owner inbox"
      );
      await ownerApp.get(`/api/notifications/inbox/${directorEvent.id}`).expect(404);

      /* --------------------------------------------- Test T (routes + workers) */
      const inboxHttp = await ownerApp.get("/api/notifications/inbox?limit=100").expect(200);
      assert.ok(inboxHttp.body.unread >= 1);
      assert.ok(inboxHttp.body.events.some((event) => event.id === dispatchA.event.id));
      const unreadBefore = inboxHttp.body.unread;

      const markRead = await ownerApp
        .post(`/api/notifications/inbox/${dispatchA.event.id}/read`)
        .send({})
        .expect(200);
      assert.ok(markRead.body.event.readAt);
      const unreadAfter = await ownerApp.get("/api/notifications/inbox/unread-count").expect(200);
      assert.equal(unreadAfter.body.unread, unreadBefore - 1);

      const deadLetterHttp = await ownerApp.get("/api/notifications/deliveries/dead-letter").expect(200);
      assert.ok(deadLetterHttp.body.deliveries.some((entry) => entry.id === webhookDeliveryE.id));

      const manualRetry = await ownerApp
        .post(`/api/notifications/deliveries/${webhookDeliveryE.id}/retry`)
        .send({})
        .expect(200);
      assert.ok(manualRetry.body.deliveries.some((entry) => entry.channel === "webhook"));

      const channelHttp = await ownerApp.get("/api/notifications/channels").expect(200);
      const emailChannel = channelHttp.body.channels.find((entry) => entry.channel === "email");
      assert.equal(emailChannel.runtimeConfigured, false);
      assert.equal(emailChannel.configured, false);
      assert.equal(emailChannel.ownerEnabled, false);
      assert.equal(channelHttp.body.channels.find((entry) => entry.channel === "owner_inbox").configured, true);

      const workerRun = await ownerApp.post("/api/notifications/run").send({}).expect(200);
      assert.ok(workerRun.body.cycle.instanceId);

      const historyHttp = await ownerApp.get("/api/forge-reports/reports?limit=10").expect(200);
      assert.ok(historyHttp.body.count >= 1);
      assert.equal(historyHttp.body.reports[0].payload, undefined, "T: history does not ship full payloads");
      assert.ok(historyHttp.body.schedule.nextRunAt);

      const latestHttp = await ownerApp.get("/api/forge-reports/reports/latest").expect(200);
      assert.ok(latestHttp.body.report.sections);
      assert.equal(latestHttp.body.report.payloadHashVerified, true);

      const runHttp = await ownerApp
        .post("/api/forge-reports/reports/run")
        .send({ reportDate: "2019-12-01" })
        .expect(201);
      assert.equal(runHttp.body.report.status, "complete");
      assert.equal(runHttp.body.evidenceHashVerified, true);
      const replayHttp = await ownerApp
        .post("/api/forge-reports/reports/run")
        .send({ reportDate: "2019-12-01" })
        .expect(200);
      assert.equal(replayHttp.body.deduplicated, true, "T: a manual run is idempotent per date");

      const reportById = await ownerApp
        .get(`/api/forge-reports/reports/${runHttp.body.report.reportId}`)
        .expect(200);
      assert.equal(reportById.body.report.reportDate, "2019-12-01");
      assert.ok(Array.isArray(reportById.body.report.evidenceRefs));
      assert.ok(reportById.body.report.evidenceRefs.length > 0);

      const schedulePatch = await ownerApp
        .patch("/api/forge-reports/schedule")
        .send({ localHour: 9, localMinute: 15, timezone: "Asia/Kolkata" })
        .expect(200);
      assert.equal(schedulePatch.body.schedule.localTime, "09:15");
      const patchedNext = localDateTimeParts(
        new Date(schedulePatch.body.schedule.nextRunAt),
        "Asia/Kolkata"
      );
      assert.equal(patchedNext.hour, 9, "T: the Owner-configured hour is honoured");
      assert.equal(patchedNext.minute, 15);

      const reportStatus = await ownerApp.get("/api/forge-reports/status").expect(200);
      assert.ok(reportStatus.body.totalReports >= 5);
      assert.ok(reportStatus.body.schedule.nextRunAt);
      assert.equal(reportStatus.body.schedule.timezone, "Asia/Kolkata");

      // The mounted notification worker is exercised through the route; the
      // mounted scheduler is exercised by runOnce below.
      const mountedSchedulerCycle = await appScheduler.runOnce();
      assert.ok(mountedSchedulerCycle.instanceId);
      assert.ok(mountedSchedulerCycle.schedule);

      // Director isolation remains enforced at the data layer too.
      const ownerInboxRows = await pool.query(
        "SELECT count(*)::int AS c FROM forge_notification_events WHERE owner_id = $1 AND recipient <> 'OWNER'",
        [ownerId]
      );
      assert.equal(ownerInboxRows.rows[0].c, 0);
    } finally {
      for (const auxiliary of auxiliaryPools) await auxiliary.end().catch(() => {});
      await pool.end().catch(() => {});
      assert.equal(await dropDisposableDatabase(POSTGRES_URL, created.name), true);
    }
  }
);
