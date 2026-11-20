/**
 * ST Production House — daily report generation service (Day 4 / D6).
 *
 * Turns persisted records into one durable report row. Generation is
 * idempotent per reporting date: the row is created (unique) before this runs,
 * and completion requires the caller's fencing token, so a duplicate worker can
 * never overwrite a completed report.
 */

import {
  collectForgeDailyReport,
  hashReportPayload,
  verifyReportEvidenceHash,
} from "./dailyReportGenerator.js";
import { windowForReportDate } from "./reportSchedule.js";

export class DailyReportService {
  constructor({
    pool,
    reportRepository,
    logger = console,
    backlogDirectory = process.cwd(),
  } = {}) {
    if (!pool) throw new Error("REPORT_POOL_REQUIRED");
    if (!reportRepository) throw new Error("REPORT_REPOSITORY_REQUIRED");
    this.pool = pool;
    this.reportRepository = reportRepository;
    this.logger = logger;
    this.backlogDirectory = backlogDirectory;
  }

  /**
   * Generate and persist one report. Returns the durable row plus the payload.
   * `persist: false` is used by tests and preview endpoints to compute without
   * writing — it never claims a report exists.
   */
  async generate({
    reportId = null,
    fencingToken = null,
    reportDate,
    timeZone = "Asia/Kolkata",
    windowStart = null,
    windowEnd = null,
    now = new Date(),
    persist = true,
  }) {
    const window = windowStart && windowEnd
      ? { windowStart: new Date(windowStart), windowEnd: new Date(windowEnd) }
      : windowForReportDate({ reportDate, timeZone });

    const payload = await collectForgeDailyReport({
      pool: this.pool,
      reportDate,
      timeZone,
      generatedAt: now,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      backlogDirectory: this.backlogDirectory,
    });

    if (!persist) {
      return { report: null, payload, persisted: false };
    }
    if (!reportId || !fencingToken) {
      throw Object.assign(new Error("REPORT_CLAIM_REQUIRED"), { code: "REPORT_CLAIM_REQUIRED" });
    }

    const completed = await this.reportRepository.markReportComplete({
      reportId,
      fencingToken,
      payload,
      evidenceHash: payload.evidenceHash,
      evidenceRefs: payload.evidenceRefs ?? [],
    });

    if (completed.deduplicated) {
      this.logger.warn?.(
        JSON.stringify({
          level: "warn",
          code: "REPORT_GENERATION_DEDUPLICATED",
          reportId,
          reportDate,
        })
      );
    }

    return {
      report: completed.report,
      payload: completed.report?.payload ?? payload,
      persisted: true,
      deduplicated: completed.deduplicated === true,
      hashValid: verifyReportEvidenceHash(completed.report?.payload ?? payload),
      evidenceHash: completed.report?.evidenceHash ?? payload.evidenceHash,
      recomputedHash: hashReportPayload(payload),
    };
  }
}
