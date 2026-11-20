/**
 * ST Production House — Owner daily-report API (Day 4 / D6).
 *
 * Routes (all JSON, authenticated Owner only, CSRF on mutations):
 *   GET   /reports             report history (no payload)
 *   GET   /reports/latest      newest report with its full payload
 *   GET   /reports/:id         one report with the full payload + evidence hash
 *   POST  /reports/run         manual (idempotent) run for one reporting date
 *   GET   /schedule            durable schedule + last/next run
 *   PATCH /schedule            Owner-configured local time / zone / policy
 *   GET   /status              generation status, last run, next run
 *
 * The report is assembled from persisted records only; the router never lets a
 * caller supply report content.
 */

import express from "express";

import { localDateString } from "../reporting/reportSchedule.js";

function fail(res, code, message, status = 400) {
  return res.status(status).json({ code, message: message ?? code });
}

function publicError(error) {
  const status = Number(error?.status) || 500;
  return {
    code: error?.code ?? "REPORT_REQUEST_FAILED",
    message: status < 500 ? error.message : "The report request could not be processed.",
    status,
  };
}

export function reportSummaryDto(report) {
  if (!report) return null;
  return {
    reportId: report.id,
    reportDate: report.reportDate,
    timezone: report.timezone,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    status: report.status,
    evidenceHash: report.evidenceHash,
    generatedAt: report.generatedAt,
    generationAttempts: report.generationAttempts,
    maxGenerationAttempts: report.maxGenerationAttempts,
    failedReason: report.failedReason,
    notificationEventId: report.notificationEventId,
    createdAt: report.createdAt,
  };
}

export function reportDto(report) {
  if (!report) return null;
  const summary = report.payload?.sections?.executiveSummary ?? null;
  return {
    ...reportSummaryDto(report),
    executiveSummary: summary,
    evidenceRefs: report.evidenceRefs,
    accuracyLegend: report.payload?.accuracyLegend ?? null,
    claims: report.payload?.claims ?? [],
    sections: report.payload?.sections ?? null,
    payloadHashVerified: Boolean(report.payload?.evidenceHash) && report.payload.evidenceHash === report.evidenceHash,
  };
}

export function scheduleDto(schedule) {
  if (!schedule) return null;
  return {
    scheduleId: schedule.scheduleId,
    enabled: schedule.enabled,
    timezone: schedule.timezone,
    localTime: schedule.localTime,
    localHour: schedule.localHour,
    localMinute: schedule.localMinute,
    missedRunPolicy: schedule.missedRunPolicy,
    lastRunAt: schedule.lastRunAt,
    lastReportDate: schedule.lastReportDate,
    nextRunAt: schedule.nextRunAt,
    updatedAt: schedule.updatedAt,
  };
}

export function createForgeReportRouter({
  reportRepository,
  service,
  scheduler = null,
  getOwnerId = (req) => req?.forgeSession?.id ?? null,
  verifyCsrf = () => false,
  logger = console,
  instanceId = `report-http-${process.pid}`,
} = {}) {
  if (!reportRepository) throw new Error("REPORT_REPOSITORY_REQUIRED");
  if (!service) throw new Error("REPORT_SERVICE_REQUIRED");
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));

  const guard = (handler) => async (req, res) => {
    try {
      const ownerId = getOwnerId(req);
      if (!ownerId) return fail(res, "UNAUTHORIZED", "Authenticated Owner session required.", 401);
      const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
      if (mutation && verifyCsrf(req) !== true) {
        return fail(res, "CSRF_REJECTED", "A valid CSRF token is required for mutations.", 403);
      }
      return await handler(req, res, ownerId);
    } catch (error) {
      const shaped = publicError(error);
      if (shaped.status >= 500) {
        logger.error?.(
          JSON.stringify({ level: "error", code: shaped.code, message: String(error?.message ?? "").slice(0, 200) })
        );
      }
      return fail(res, shaped.code, shaped.message, shaped.status);
    }
  };

  const limitOf = (value, fallback = 30) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(180, Math.trunc(parsed))) : fallback;
  };

  router.get(
    "/reports",
    guard(async (req, res) => {
      const schedule = await reportRepository.getSchedule();
      const reports = await reportRepository.listReports({ limit: limitOf(req.query.limit) });
      return res.status(200).json({
        count: reports.length,
        schedule: scheduleDto(schedule),
        reports: reports.map(reportSummaryDto),
      });
    })
  );

  router.get(
    "/reports/latest",
    guard(async (req, res) => {
      const reports = await reportRepository.listReports({ limit: 1, includePayload: true });
      if (!reports[0]) return fail(res, "REPORT_NOT_FOUND", "No report has been generated yet.", 404);
      return res.status(200).json({ report: reportDto(reports[0]) });
    })
  );

  router.get(
    "/reports/:id",
    guard(async (req, res) => {
      const report = await reportRepository.getReport(req.params.id);
      if (!report) return fail(res, "REPORT_NOT_FOUND", "Unknown report.", 404);
      return res.status(200).json({ report: reportDto(report) });
    })
  );

  router.post(
    "/reports/run",
    guard(async (req, res) => {
      const schedule = await reportRepository.getSchedule();
      const timeZone = schedule?.timezone ?? "Asia/Kolkata";
      const reportDate =
        typeof req.body?.reportDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.reportDate)
          ? req.body.reportDate
          : localDateString(new Date(), timeZone);

      const claim = await reportRepository.claimManualReport({
        reportDate,
        workerId: `${instanceId}-manual`,
      });
      if (!claim.claimed) {
        return res.status(200).json({
          deduplicated: true,
          reason: claim.reason,
          report: claim.report ? reportDto(claim.report) : null,
        });
      }
      const generated = await service.generate({
        reportId: claim.report.id,
        fencingToken: claim.fencingToken,
        reportDate,
        timeZone,
        windowStart: claim.report.windowStart,
        windowEnd: claim.report.windowEnd,
      });
      return res.status(201).json({
        deduplicated: false,
        report: reportDto(generated.report),
        evidenceHashVerified: generated.hashValid === true,
      });
    })
  );

  router.get(
    "/schedule",
    guard(async (req, res) => {
      const schedule = (await reportRepository.getSchedule()) ?? (await reportRepository.ensureSchedule());
      return res.status(200).json({ schedule: scheduleDto(schedule) });
    })
  );

  router.patch(
    "/schedule",
    guard(async (req, res, ownerId) => {
      const body = req.body ?? {};
      if (body.localHour !== undefined && !Number.isInteger(body.localHour)) {
        return fail(res, "REPORT_HOUR_INVALID", "localHour must be an integer 0–23.", 400);
      }
      if (body.localMinute !== undefined && !Number.isInteger(body.localMinute)) {
        return fail(res, "REPORT_MINUTE_INVALID", "localMinute must be an integer 0–59.", 400);
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return fail(res, "REPORT_ENABLED_INVALID", "enabled must be a boolean.", 400);
      }
      const schedule = await reportRepository.updateSchedule({
        localHour: body.localHour,
        localMinute: body.localMinute,
        timezone: body.timezone,
        enabled: body.enabled,
        missedRunPolicy: body.missedRunPolicy,
        updatedBy: ownerId,
      });
      return res.status(200).json({ schedule: scheduleDto(schedule) });
    })
  );

  router.get(
    "/status",
    guard(async (req, res) => {
      const status = await reportRepository.getStatus();
      return res.status(200).json({
        schedule: scheduleDto(status.schedule),
        lastReport: status.lastReport ? reportSummaryDto(status.lastReport) : null,
        reportsByStatus: status.reportsByStatus,
        totalReports: status.totalReports,
        schedulerRunning: Boolean(scheduler?._timer),
        note: "08:00 Asia/Kolkata is the default; the next run shown is the durable database value.",
      });
    })
  );

  router.use((req, res) => fail(res, "NOT_FOUND", "Unknown report route.", 404));
  return router;
}
