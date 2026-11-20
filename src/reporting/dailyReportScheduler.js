/**
 * ST Production House — durable daily-report scheduler worker (Day 4 / D6).
 *
 * The timer is only a trigger. The due decision, the next run time, the
 * reporting date, the one-report-per-date rule and the concurrency guard all
 * live in PostgreSQL (sql/044). A restart therefore produces exactly the same
 * outcome: due runs are caught up once, missed days are not backfilled, and a
 * report left `generating` by a dead instance is re-leased and completed.
 */

import crypto from "node:crypto";

import {
  NOTIFICATION_EVENT_TYPE,
  notificationIdempotencyKey,
} from "../notifications/notificationPolicy.js";
import { MISSED_RUN_GRACE_SECONDS } from "./dailyReportRepository.js";

export class DailyReportSchedulerWorker {
  constructor({
    reportRepository,
    service,
    notifier = null,
    instanceId = `report-scheduler-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
    leaseSeconds = 120,
    batchSize = 3,
    logger = console,
    now = () => new Date(),
  } = {}) {
    if (!reportRepository) throw new Error("REPORT_REPOSITORY_REQUIRED");
    if (!service) throw new Error("REPORT_SERVICE_REQUIRED");
    this.reportRepository = reportRepository;
    this.service = service;
    this.notifier = notifier;
    this.instanceId = instanceId;
    this.leaseSeconds = leaseSeconds;
    this.batchSize = batchSize;
    this.logger = logger;
    this.now = now;
    this._timer = null;
    this._running = false;
  }

  async runOnce() {
    if (this._running) return { skippedCycle: true, reason: "CYCLE_ALREADY_RUNNING" };
    this._running = true;
    const summary = {
      instanceId: this.instanceId,
      schedule: null,
      generated: 0,
      recovered: 0,
      failed: 0,
      reports: [],
    };
    try {
      const claim = await this.reportRepository.claimDueSchedule({
        workerId: this.instanceId,
        leaseSeconds: this.leaseSeconds,
        now: this.now(),
      });
      summary.schedule = {
        claimed: claim.claimed === true,
        reason: claim.reason ?? null,
        reportDate: claim.reportDate ?? null,
        missed: claim.missed === true,
        nextRunAt: claim.nextRunAt ?? claim.schedule?.nextRunAt ?? null,
        lastRunAt: claim.schedule?.lastRunAt ?? null,
        timezone: claim.schedule?.timezone ?? null,
        localTime: claim.schedule?.localTime ?? null,
        missedRunGraceSeconds: MISSED_RUN_GRACE_SECONDS,
      };

      if (claim.claimed) {
        const outcome = await this._generateOne({
          reportId: claim.reportId,
          fencingToken: claim.fencingToken,
          reportDate: claim.reportDate,
          timeZone: claim.schedule?.timezone,
          windowStart: claim.report?.windowStart,
          windowEnd: claim.report?.windowEnd,
        });
        summary.reports.push(outcome);
        if (outcome.status === "complete") summary.generated += 1;
        else summary.failed += 1;
      }

      // Restart recovery / bounded retry of interrupted or failed reports.
      const retryable = await this.reportRepository.claimRetryableReports({
        workerId: this.instanceId,
        leaseSeconds: this.leaseSeconds,
        limit: this.batchSize,
      });
      summary.recovered = retryable.length;
      for (const report of retryable) {
        const outcome = await this._generateOne({
          reportId: report.id,
          fencingToken: report.generationFencingToken,
          reportDate: report.reportDate,
          timeZone: report.timezone,
          windowStart: report.windowStart,
          windowEnd: report.windowEnd,
        });
        summary.reports.push(outcome);
        if (outcome.status === "complete") summary.generated += 1;
        else summary.failed += 1;
      }

      return summary;
    } finally {
      this._running = false;
    }
  }

  async _generateOne({ reportId, fencingToken, reportDate, timeZone, windowStart, windowEnd }) {
    try {
      const generated = await this.service.generate({
        reportId,
        fencingToken,
        reportDate,
        timeZone,
        windowStart,
        windowEnd,
        now: this.now(),
      });
      const notification = await this._notify(generated.report, generated.payload);
      return {
        reportId,
        reportDate,
        status: generated.report?.status ?? "complete",
        evidenceHash: generated.evidenceHash ?? generated.report?.evidenceHash ?? null,
        hashValid: generated.hashValid === true,
        notificationEventId: notification?.eventId ?? null,
        notificationDelivery: notification?.deliveryStates ?? null,
      };
    } catch (error) {
      const failed = await this.reportRepository.markReportFailed({
        reportId,
        fencingToken,
        reason: error?.code ?? "REPORT_GENERATION_FAILED",
      });
      this.logger.error?.(
        JSON.stringify({
          level: "error",
          code: "REPORT_GENERATION_FAILED",
          reportId,
          reportDate,
          reason: error?.code ?? "REPORT_GENERATION_FAILED",
          attempts: failed?.generationAttempts ?? null,
        })
      );
      return {
        reportId,
        reportDate,
        status: failed?.status ?? "failed",
        reason: error?.code ?? "REPORT_GENERATION_FAILED",
      };
    }
  }

  /**
   * Deliver the report digest to the Owner's durable inbox. The report itself is
   * already persisted before this runs, so a failed external channel can never
   * destroy it.
   */
  async _notify(report, payload) {
    if (!this.notifier || !report) return null;
    try {
      const ownerId = await this.reportRepository.resolveOwnerId();
      if (!ownerId) return { eventId: null, reason: "NO_OWNER_RECORD" };
      const summary = payload?.sections?.executiveSummary ?? {};
      const dispatch = await this.notifier.dispatch({
        eventType: NOTIFICATION_EVENT_TYPE.DAILY_FORGE_REPORT,
        recipient: "OWNER",
        ownerId,
        taskRef: `report:${report.reportDate}`,
        idempotencyKey: notificationIdempotencyKey("report", "daily", report.reportDate),
        payload: {
          reportId: report.id,
          reportDate: report.reportDate,
          evidenceHash: report.evidenceHash,
          overallCondition: summary.overallCondition ?? null,
          productionActivity: summary.productionActivity === true,
          blockerCount: Array.isArray(payload?.sections?.blockers) ? payload.sections.blockers.length : null,
          message: "The daily FORGE operations report is available in the Owner console.",
        },
      });
      await this.reportRepository.attachNotificationEvent({
        reportId: report.id,
        eventId: dispatch.event.id,
      });
      return {
        eventId: dispatch.event.id,
        deliveryStates: dispatch.deliveries.map((entry) => `${entry.channel}:${entry.state}`),
      };
    } catch (error) {
      this.logger.error?.(
        JSON.stringify({
          level: "error",
          code: "REPORT_NOTIFICATION_FAILED",
          reportId: report.id,
          reason: error?.code ?? "REPORT_NOTIFICATION_FAILED",
        })
      );
      return { eventId: null, reason: error?.code ?? "REPORT_NOTIFICATION_FAILED" };
    }
  }

  start({ intervalMs = 60_000 } = {}) {
    if (this._timer) return this._timer;
    const tick = () =>
      this.runOnce().catch((error) => {
        this.logger.error?.(
          JSON.stringify({
            level: "error",
            code: "REPORT_SCHEDULER_CYCLE_FAILED",
            message: String(error?.message ?? "unknown").slice(0, 200),
          })
        );
      });
    this._timer = setInterval(tick, intervalMs);
    this._timer.unref?.();
    // Catch up immediately on boot: a due run is never delayed by a full interval.
    void tick();
    return this._timer;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
