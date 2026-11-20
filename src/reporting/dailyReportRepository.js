/**
 * ST Production House — durable daily-report store & schedule (Day 4 / D6).
 *
 * PostgreSQL owns the schedule: `next_run_at` and every due decision are
 * compared with `clock_timestamp()`. A process that was down for days finds the
 * stored next run in the past and applies the configured missed-run policy.
 *
 * Exactly one report may exist per reporting date (`UNIQUE`), the claim is
 * serialized by locking the single schedule row, and generation itself is
 * protected by a lease + monotonic fencing token so two instances can never
 * complete the same report.
 */

import {
  DEFAULT_LOCAL_HOUR,
  DEFAULT_LOCAL_MINUTE,
  DEFAULT_MISSED_RUN_POLICY,
  DEFAULT_REPORT_TIMEZONE,
  MISSED_RUN_POLICIES,
  assertTimeZone,
  nextRunAt,
  reportDateForScheduledRun,
  windowForReportDate,
} from "./reportSchedule.js";

export const MISSED_RUN_GRACE_SECONDS = 300;
export const REPORT_STATUS = Object.freeze({
  GENERATING: "generating",
  COMPLETE: "complete",
  FAILED: "failed",
});

function iso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function reportError(code, status = 409) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

export function mapSchedule(row) {
  if (!row) return null;
  return {
    scheduleId: row.schedule_id,
    enabled: row.enabled === true,
    timezone: row.timezone,
    localHour: Number(row.local_hour),
    localMinute: Number(row.local_minute),
    localTime: `${String(row.local_hour).padStart(2, "0")}:${String(row.local_minute).padStart(2, "0")}`,
    missedRunPolicy: row.missed_run_policy,
    lastRunAt: iso(row.last_run_at),
    lastReportDate: row.last_report_date_text ?? (row.last_report_date ? String(row.last_report_date) : null),
    nextRunAt: iso(row.next_run_at),
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by ?? null,
  };
}

export function mapReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    reportDate: row.report_date_text ?? (row.report_date ? String(row.report_date) : null),
    timezone: row.timezone,
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    status: row.status,
    payload: row.payload ?? null,
    evidenceHash: row.evidence_hash ?? null,
    evidenceRefs: Array.isArray(row.evidence_refs) ? row.evidence_refs : [],
    generatedAt: iso(row.generated_at),
    generationAttempts: Number(row.generation_attempts ?? 0),
    maxGenerationAttempts: Number(row.max_generation_attempts ?? 0),
    failedReason: row.failed_reason ?? null,
    notificationEventId: row.notification_event_id ?? null,
    createdAt: iso(row.created_at),
    generationFencingToken: Number(row.generation_fencing_token ?? 0),
  };
}

const REPORT_COLUMNS = "*, report_date::text AS report_date_text";
const SCHEDULE_COLUMNS = "*, last_report_date::text AS last_report_date_text";

export class PostgresDailyReportRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function") {
      throw reportError("REPORT_POOL_REQUIRED", 500);
    }
    this.pool = pool;
  }

  async _tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ schedule
  async ensureSchedule({ now = new Date() } = {}) {
    const existing = await this.getSchedule();
    if (existing) return existing;
    const next = nextRunAt({
      from: now,
      timeZone: DEFAULT_REPORT_TIMEZONE,
      hour: DEFAULT_LOCAL_HOUR,
      minute: DEFAULT_LOCAL_MINUTE,
    });
    const { rows } = await this.pool.query(
      `INSERT INTO forge_report_schedule (schedule_id, next_run_at)
       VALUES ('forge_daily_report', $1::timestamptz)
       ON CONFLICT (schedule_id) DO UPDATE SET next_run_at = forge_report_schedule.next_run_at
       RETURNING ${SCHEDULE_COLUMNS}`,
      [next.toISOString()]
    );
    return mapSchedule(rows[0]);
  }

  async getSchedule() {
    const { rows } = await this.pool.query(
      `SELECT ${SCHEDULE_COLUMNS} FROM forge_report_schedule WHERE schedule_id = 'forge_daily_report'`
    );
    return rows[0] ? mapSchedule(rows[0]) : null;
  }

  /**
   * Owner-controlled schedule change. `next_run_at` is always recomputed from
   * the new local time; in-flight history is preserved.
   */
  async updateSchedule({
    localHour,
    localMinute,
    timezone,
    enabled,
    missedRunPolicy,
    updatedBy = null,
    now = new Date(),
  } = {}) {
    const current = (await this.getSchedule()) ?? (await this.ensureSchedule({ now }));
    const nextHour = localHour === undefined ? current.localHour : Number(localHour);
    const nextMinute = localMinute === undefined ? current.localMinute : Number(localMinute);
    const nextTimezone = timezone === undefined ? current.timezone : String(timezone);
    const nextEnabled = enabled === undefined ? current.enabled : enabled === true;
    const nextPolicy = missedRunPolicy === undefined ? current.missedRunPolicy : String(missedRunPolicy);

    if (!Number.isInteger(nextHour) || nextHour < 0 || nextHour > 23) {
      throw reportError("REPORT_HOUR_INVALID", 400);
    }
    if (!Number.isInteger(nextMinute) || nextMinute < 0 || nextMinute > 59) {
      throw reportError("REPORT_MINUTE_INVALID", 400);
    }
    assertTimeZone(nextTimezone);
    if (!MISSED_RUN_POLICIES.includes(nextPolicy)) {
      throw reportError("REPORT_MISSED_POLICY_INVALID", 400);
    }

    const next = nextRunAt({ from: now, timeZone: nextTimezone, hour: nextHour, minute: nextMinute });
    const { rows } = await this.pool.query(
      `UPDATE forge_report_schedule
          SET local_hour = $1,
              local_minute = $2,
              timezone = $3,
              enabled = $4,
              missed_run_policy = $5,
              next_run_at = $6::timestamptz,
              updated_by = $7,
              updated_at = clock_timestamp()
        WHERE schedule_id = 'forge_daily_report'
        RETURNING ${SCHEDULE_COLUMNS}`,
      [nextHour, nextMinute, nextTimezone, nextEnabled, nextPolicy, next.toISOString(), updatedBy]
    );
    return mapSchedule(rows[0]);
  }

  /**
   * Claim one due scheduled run. Serialized by the single schedule row lock.
   * Returns the created (or already existing) report for the scheduled local
   * date, and always advances the durable next run.
   */
  async claimDueSchedule({ workerId, leaseSeconds = 120, now = new Date() } = {}) {
    if (typeof workerId !== "string" || workerId.length === 0 || workerId.length > 120) {
      throw reportError("REPORT_WORKER_ID_INVALID", 400);
    }
    // Idempotent bootstrap of the single durable schedule row, with the local
    // 08:00 default computed in the runtime's own timezone database.
    await this.ensureSchedule({ now });
    return this._tx(async (client) => {
      const claimedRow = await client.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM forge_report_schedule
          WHERE schedule_id = 'forge_daily_report'
          FOR UPDATE`
      );
      const scheduleRow = claimedRow.rows[0];
      if (!scheduleRow) throw reportError("REPORT_SCHEDULE_MISSING", 500);
      const schedule = mapSchedule(scheduleRow);
      if (!schedule.enabled) {
        return { claimed: false, reason: "SCHEDULE_DISABLED", schedule };
      }

      const clock = await client.query(
        `SELECT ($1::timestamptz <= clock_timestamp()) AS due,
                (clock_timestamp() - $1::timestamptz) > ($2 || ' seconds')::interval AS missed`,
        [schedule.nextRunAt, String(MISSED_RUN_GRACE_SECONDS)]
      );
      if (clock.rows[0].due !== true) {
        return { claimed: false, reason: "NOT_DUE", schedule };
      }

      const missed = clock.rows[0].missed === true;
      const scheduledRunAt = new Date(schedule.nextRunAt);
      const reportDate = reportDateForScheduledRun({
        nextRunAt: scheduledRunAt,
        timeZone: schedule.timezone,
      });
      const next = nextRunAt({
        from: now,
        timeZone: schedule.timezone,
        hour: schedule.localHour,
        minute: schedule.localMinute,
      });

      if (missed && schedule.missedRunPolicy === "SKIP") {
        const advanced = await client.query(
          `UPDATE forge_report_schedule
              SET next_run_at = $1::timestamptz,
                  last_run_at = clock_timestamp(),
                  updated_at = clock_timestamp()
            WHERE schedule_id = 'forge_daily_report'
            RETURNING ${SCHEDULE_COLUMNS}`,
          [next.toISOString()]
        );
        return {
          claimed: false,
          reason: "MISSED_RUN_SKIPPED",
          reportDate,
          missedRunAt: iso(scheduledRunAt),
          nextRunAt: iso(next),
          schedule: mapSchedule(advanced.rows[0]),
        };
      }

      const { windowStart, windowEnd } = windowForReportDate({
        reportDate,
        timeZone: schedule.timezone,
      });

      const inserted = await client.query(
        `INSERT INTO forge_daily_reports
           (report_date, timezone, window_start, window_end, status,
            generation_attempts, generation_lease_owner, generation_lease_expires_at,
            generation_fencing_token)
         VALUES ($1::date, $2, $3::timestamptz, $4::timestamptz, 'generating',
                 1, $5, clock_timestamp() + ($6 || ' seconds')::interval, 1)
         ON CONFLICT (report_date) DO NOTHING
         RETURNING ${REPORT_COLUMNS}`,
        [
          reportDate,
          schedule.timezone,
          windowStart.toISOString(),
          windowEnd.toISOString(),
          workerId,
          String(Math.max(10, leaseSeconds)),
        ]
      );

      const advanced = await client.query(
        `UPDATE forge_report_schedule
            SET next_run_at = $1::timestamptz,
                last_run_at = clock_timestamp(),
                last_report_date = $2::date,
                updated_at = clock_timestamp()
          WHERE schedule_id = 'forge_daily_report'
          RETURNING ${SCHEDULE_COLUMNS}`,
        [next.toISOString(), reportDate]
      );

      if (!inserted.rows[0]) {
        return {
          claimed: false,
          reason: "REPORT_ALREADY_EXISTS",
          reportDate,
          missed,
          nextRunAt: iso(next),
          schedule: mapSchedule(advanced.rows[0]),
        };
      }

      return {
        claimed: true,
        missed,
        reportDate,
        report: mapReport(inserted.rows[0]),
        reportId: inserted.rows[0].id,
        fencingToken: 1,
        nextRunAt: iso(next),
        schedule: mapSchedule(advanced.rows[0]),
      };
    });
  }

  /**
   * Owner-triggered manual run for one reporting date. Idempotent: an existing
   * complete report for that date is returned instead of a second report.
   */
  async claimManualReport({ reportDate, workerId, leaseSeconds = 120 } = {}) {
    const schedule = (await this.getSchedule()) ?? (await this.ensureSchedule());
    const { windowStart, windowEnd } = windowForReportDate({
      reportDate,
      timeZone: schedule.timezone,
    });
    const inserted = await this.pool.query(
      `INSERT INTO forge_daily_reports
         (report_date, timezone, window_start, window_end, status,
          generation_attempts, generation_lease_owner, generation_lease_expires_at,
          generation_fencing_token)
       VALUES ($1::date, $2, $3::timestamptz, $4::timestamptz, 'generating',
               1, $5, clock_timestamp() + ($6 || ' seconds')::interval, 1)
       ON CONFLICT (report_date) DO NOTHING
       RETURNING ${REPORT_COLUMNS}`,
      [
        reportDate,
        schedule.timezone,
        windowStart.toISOString(),
        windowEnd.toISOString(),
        workerId,
        String(Math.max(10, leaseSeconds)),
      ]
    );
    if (inserted.rows[0]) {
      const report = mapReport(inserted.rows[0]);
      return { claimed: true, report, fencingToken: report.generationFencingToken };
    }
    const existing = await this.getReportByDate(reportDate);
    return {
      claimed: false,
      report: existing,
      fencingToken: existing?.generationFencingToken ?? null,
      reason:
        existing?.status === REPORT_STATUS.COMPLETE
          ? "REPORT_ALREADY_COMPLETE"
          : existing?.status === REPORT_STATUS.FAILED
            ? "REPORT_FAILED"
            : "REPORT_IN_PROGRESS",
    };
  }

  /**
   * Restart recovery: a report left `generating` by a dead instance (expired
   * lease) or a failed report with attempts remaining is re-leased.
   */
  async claimRetryableReports({ workerId, leaseSeconds = 120, limit = 5 } = {}) {
    const { rows } = await this.pool.query(
      `WITH candidates AS (
         SELECT id
           FROM forge_daily_reports
          WHERE status IN ('generating', 'failed')
            AND generation_attempts < max_generation_attempts
            AND (generation_lease_expires_at IS NULL OR generation_lease_expires_at <= clock_timestamp())
          ORDER BY report_date ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE forge_daily_reports r
          SET status = 'generating',
              generation_attempts = r.generation_attempts + 1,
              generation_lease_owner = $2,
              generation_lease_expires_at = clock_timestamp() + ($3 || ' seconds')::interval,
              generation_fencing_token = r.generation_fencing_token + 1
         FROM candidates c
        WHERE r.id = c.id
        RETURNING ${REPORT_COLUMNS}`,
      [Math.max(1, Math.min(50, limit)), workerId, String(Math.max(10, leaseSeconds))]
    );
    return rows.map(mapReport);
  }

  // ------------------------------------------------------------------- reports
  async getReport(reportId) {
    const { rows } = await this.pool.query(
      `SELECT ${REPORT_COLUMNS} FROM forge_daily_reports WHERE id = $1`,
      [reportId]
    );
    return rows[0] ? mapReport(rows[0]) : null;
  }

  async getReportByDate(reportDate) {
    const { rows } = await this.pool.query(
      `SELECT ${REPORT_COLUMNS} FROM forge_daily_reports WHERE report_date = $1::date`,
      [reportDate]
    );
    return rows[0] ? mapReport(rows[0]) : null;
  }

  async listReports({ limit = 30, includePayload = false } = {}) {
    const { rows } = await this.pool.query(
      `SELECT ${REPORT_COLUMNS} FROM forge_daily_reports ORDER BY report_date DESC LIMIT $1`,
      [Math.max(1, Math.min(180, limit))]
    );
    return rows.map((row) => {
      const mapped = mapReport(row);
      if (!includePayload) delete mapped.payload;
      return mapped;
    });
  }

  async markReportComplete({ reportId, fencingToken, payload, evidenceHash, evidenceRefs = [] }) {
    const { rowCount, rows } = await this.pool.query(
      `UPDATE forge_daily_reports
          SET status = 'complete',
              payload = $3::jsonb,
              evidence_hash = $4,
              evidence_refs = $5::jsonb,
              generated_at = clock_timestamp(),
              failed_reason = NULL,
              generation_lease_owner = NULL,
              generation_lease_expires_at = NULL
        WHERE id = $1
          AND generation_fencing_token = $2
          AND status = 'generating'
        RETURNING ${REPORT_COLUMNS}`,
      [reportId, Number(fencingToken), JSON.stringify(payload ?? {}), evidenceHash, JSON.stringify(evidenceRefs)]
    );
    if (rowCount > 0) return { deduplicated: false, report: mapReport(rows[0]) };

    const current = await this.getReport(reportId);
    if (!current) throw reportError("REPORT_NOT_FOUND", 404);
    if (current.status === REPORT_STATUS.COMPLETE) return { deduplicated: true, report: current };
    throw reportError("REPORT_GENERATION_FENCING_STALE");
  }

  async markReportFailed({ reportId, fencingToken, reason }) {
    const { rowCount, rows } = await this.pool.query(
      `UPDATE forge_daily_reports
          SET status = 'failed',
              failed_reason = left($3, 300),
              generation_lease_owner = NULL,
              generation_lease_expires_at = NULL
        WHERE id = $1
          AND generation_fencing_token = $2
          AND status = 'generating'
        RETURNING ${REPORT_COLUMNS}`,
      [reportId, Number(fencingToken), String(reason ?? "REPORT_GENERATION_FAILED")]
    );
    if (rowCount === 0) return null;
    return mapReport(rows[0]);
  }

  async attachNotificationEvent({ reportId, eventId }) {
    const { rows } = await this.pool.query(
      `UPDATE forge_daily_reports
          SET notification_event_id = COALESCE(notification_event_id, $2)
        WHERE id = $1
        RETURNING ${REPORT_COLUMNS}`,
      [reportId, eventId]
    );
    return rows[0] ? mapReport(rows[0]) : null;
  }

  /** The Owner whose durable inbox receives the report notification. */
  async resolveOwnerId() {
    const { rows } = await this.pool.query(
      "SELECT id FROM owners ORDER BY created_at ASC, id ASC LIMIT 1"
    );
    return rows[0]?.id ?? null;
  }

  async getStatus() {
    const schedule = await this.getSchedule();
    const latest = await this.pool.query(
      `SELECT ${REPORT_COLUMNS} FROM forge_daily_reports ORDER BY report_date DESC LIMIT 1`
    );
    const counts = await this.pool.query(
      "SELECT status, count(*)::int AS count FROM forge_daily_reports GROUP BY status"
    );
    const byStatus = {};
    for (const row of counts.rows) byStatus[row.status] = Number(row.count);
    return {
      schedule,
      lastReport: latest.rows[0] ? mapReport(latest.rows[0]) : null,
      reportsByStatus: byStatus,
      totalReports: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
    };
  }
}
