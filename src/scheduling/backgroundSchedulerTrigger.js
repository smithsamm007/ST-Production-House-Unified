/**
 * ST Production House — durable background scheduler trigger (sql/029).
 *
 * Closes the documented gap in `docs/production/DIRECTOR_EPISODE_SCHEDULE.md`:
 * the scheduler could only be fired by the owner route
 * (`POST /api/scheduling/directors/:agentId/run`). This module adds the
 * IN-PROCESS, opt-in background trigger so scheduled slots are claimed and
 * queued without a human in the loop, by reusing the EXACT same durable,
 * idempotent tick (`runDirectorScheduleTick`) — never a second scheduler.
 *
 * Honest scope (unchanged):
 *   - It QUEUES planned episodes into the durable production/approval
 *     pipeline. It never publishes, never bypasses the owner approval gate
 *     (Rule 7), and never starts workers by itself.
 *   - The trigger is OFF unless `STPH_ENABLE_SCHEDULE_TRIGGER=1` — a change
 *     of automation cadence is an owner deployment decision, not a silent one.
 *   - Storage errors, an individual owner's failures, and overlapping ticks
 *     are recorded truthfully; nothing is fabricated to look green (Rules 1-3).
 *
 * Design contract:
 *   - The timer and the tick are INJECTED dependencies. The module holds no
 *     clock/state of its own beyond run accounting; identical inputs to
 *     `parseSchedulerIntervalMinutes` behave identically (pure, offline).
 *   - Overlapping runs are skipped and counted — two timers can never create
 *     a double logical episode (on top of the DB-level idempotency gate).
 *   - No secret, locator, or internal agent NAME is ever carried in the
 *     report (agent ids only — Rules 15/17).
 */

import { DEFAULT_LOOKBACK_DAYS, DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR } from "./productionScheduler.js";
import { DirectorScheduleRepository } from "../catalog/scheduleRepository.js";

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
export const DEFAULT_SCHEDULER_INTERVAL_MINUTES = 15;
export const SCHEDULE_TRIGGER_ENABLED_ENV = "STPH_ENABLE_SCHEDULE_TRIGGER";

/** Stable owner-facing audit codes emitted by the cross-owner tick. */
export const BACKGROUND_TICK_AUDIT_EVENTS = Object.freeze({
  queuedEvent: "scheduled_production_queued",
  tickEvent: "production_schedule_tick_background",
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Pure parser for `STPH_SCHEDULER_TICK_MINUTES`. Accepts integer minutes in
 * [1, 1440]; anything else falls back to the default (never NaN/never zero —
 * a misconfigured value must not silently disable the trigger).
 */
export function parseSchedulerIntervalMinutes(raw, fallback = DEFAULT_SCHEDULER_INTERVAL_MINUTES) {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_INTERVAL_MINUTES || parsed > MAX_INTERVAL_MINUTES) {
    return fallback;
  }
  return parsed;
}

/** frozen — stable, allowlisted lifecycle state for the trigger */
function readonlyStatus(state) {
  return Object.freeze({
    started: state.started,
    stopped: state.stopped,
    running: state.running,
    intervalMinutes: state.intervalMinutes,
    startedCount: state.startedCount,
    completedCount: state.completedCount,
    failedCount: state.failedCount,
    skippedOverlappingCount: state.skippedOverlappingCount,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunFinishedAt: state.lastRunFinishedAt,
    lastOutcome: state.lastOutcome,         // result summary object | null
    lastError: state.lastError ?? null,     // message or code — never a secret
  });
}

export function createBackgroundSchedulerTrigger({
  tick,
  intervalMinutes = DEFAULT_SCHEDULER_INTERVAL_MINUTES,
  runOnStart = true,
  timer = null,
} = {}) {
  if (typeof tick !== "function") throw fail("SCHEDULER_TRIGGER_TICK_REQUIRED");
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES ||
      intervalMinutes > MAX_INTERVAL_MINUTES) {
    throw fail("SCHEDULER_TRIGGER_INTERVAL_INVALID");
  }
  const setIntervalFn = typeof timer?.setIntervalFn === "function" ? timer.setIntervalFn : setInterval;
  const clearIntervalFn = typeof timer?.clearIntervalFn === "function" ? timer.clearIntervalFn : clearInterval;
  const intervalMs = intervalMinutes * 60_000;

  const state = {
    started: false,
    stopped: false,
    running: false,
    intervalMinutes,
    startedCount: 0,
    completedCount: 0,
    failedCount: 0,
    skippedOverlappingCount: 0,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastOutcome: null,
    lastError: null,
  };

  let handle = null;

  function summarize(report) {
    // Only allowlisted scheduler counters pass here — the per-Director slider
    // data never serializes through the trigger status (Rules 15/17).
    if (!report || typeof report !== "object") return null;
    const totals = report.totals && typeof report.totals === "object" ? report.totals : report;
    return Object.freeze({
      created: Number(totals.created) || 0,
      delayed: Number(totals.delayed) || 0,
      blocked: Number(totals.blocked) || 0,
      skipped: Number(totals.skipped) || 0,
      duplicates: Number(totals.duplicates) || 0,
      ownersTouched: Number(report.ownersTouched) || 0,
      invalidSchedules: Number(report.invalidSchedules) || 0,
    });
  }

  async function runOnce() {
    if (state.running) {
      state.skippedOverlappingCount += 1;
      return null;
    }
    state.running = true;
    state.startedCount += 1;
    state.lastRunStartedAt = new Date().toISOString();
    try {
      const report = await tick();
      state.lastOutcome = summarize(report);
      state.completedCount += 1;
      return state.lastOutcome;
    } catch (error) {
      state.failedCount += 1;
      state.lastError = error?.code ?? error?.message ?? "SCHEDULER_TRIGGER_TICK_FAILED";
      return null;
    } finally {
      state.running = false;
      state.lastRunFinishedAt = new Date().toISOString();
    }
  }

  function start() {
    if (state.started) return readonlyStatus(state);
    state.started = true;
    state.stopped = false;
    handle = setIntervalFn(() => runOnce(), intervalMs);
    if (handle && typeof handle.unref === "function") handle.unref();
    if (runOnStart) {
      // First tick without waiting a full interval — the promise is
      // deliberately NOT awaited: the caller must not be blocked by storage.
      void runOnce();
    }
    return readonlyStatus(state);
  }

  function stop() {
    if (handle !== null) {
      clearIntervalFn(handle);
      handle = null;
    }
    state.stopped = true;
    return readonlyStatus(state);
  }

  function status() {
    return readonlyStatus(state);
  }

  return {
    start,
    stop,
    status,
    /** Test seam: run one tick synchronously (bypasses the timer). */
    async runNow() { return runOnce(); },
  };
}

const OWNER_GROUP_LIMIT = 200;

/**
 * Run ONE durable tick across ALL owners with enabled schedules. This is the
 * background twin of the per-Director owner route: same validation, same
 * capacity/quota/deps admission, same idempotent slot claims (Rules 8, 13).
 *
 * `db` + repository resolve the enabled rows server-internally; `rowsProvider`
 * is the test seam (no database needed in unit tests). One owner failing does
 * not stop the others; every failure is counted with a stable code.
 * `listJobStatuses` is `(ownerId, agentId) => statuses` — it is wrapped per
 * owner below so the scheduler's single-argument call stays tenanted.
 */
export async function runAllDirectorScheduleTicks({
  db = null,
  rowsProvider = null,
  scheduleRepository = null,
  productionRepository = null,
  listJobStatuses = null,
  quotaSnapshotProvider = null,
  enabledAgents = null,
  recordAuditEvent = null,
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  maxConcurrentJobsPerDirector = DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR,
  dryRun = false,
} = {}) {
  const { runDirectorScheduleTick } = await import("./productionScheduler.js");

  const resolveRepository = typeof scheduleRepository === "function"
    ? scheduleRepository
    : () => scheduleRepository;

  let records;
  if (typeof rowsProvider === "function") {
    records = (await rowsProvider()) ?? [];
  } else {
    if (!db || typeof db.query !== "function") throw fail("STORAGE_NOT_CONFIGURED");
    records = await new DirectorScheduleRepository(db).listAllEnabledScheduleRecords();
  }
  if (!Array.isArray(records)) throw fail("SCHEDULE_INPUT_INVALID");

  const invalidSchedules = [];
  const validByOwner = new Map();
  for (const record of records.slice(0, 2000)) {
    if (record?.invalid || !record?.settings) {
      invalidSchedules.push(record?.agentId ?? null);
      continue;
    }
    const ownerId = record.ownerId;
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      invalidSchedules.push(record.agentId ?? null);
      continue;
    }
    if (!validByOwner.has(ownerId)) validByOwner.set(ownerId, []);
    const group = validByOwner.get(ownerId);
    if (group.length < OWNER_GROUP_LIMIT) group.push(record);
  }

  const ownerReports = [];
  const totals = {
    owners: validByOwner.size,
    directors: 0,
    pausedDirectors: 0,
    created: 0,
    delayed: 0,
    blocked: 0,
    skipped: 0,
    duplicates: 0,
    ownerFailures: 0,
  };

  for (const [ownerId, ownerRecords] of validByOwner) {
    try {
      const production = productionRepository && typeof productionRepository.listChannels === "function"
        ? productionRepository
        : null;

      const report = await runDirectorScheduleTick({
        ownerId,
        schedules: ownerRecords.map((r) => ({ agentId: r.agentId, settings: r.settings })),
        scheduleRepository: resolveRepository(ownerId),
        production,
        listJobStatuses: typeof listJobStatuses === "function"
          ? (agentId) => listJobStatuses(ownerId, agentId)
          : null,
        quotaSnapshotProvider,
        enabledAgents,
        now,
        lookbackDays,
        maxConcurrentJobsPerDirector,
        dryRun,
        onDirectorPlanned: async ({ agentId, slot, releaseId, jobId, season, episode }) => {
          if (typeof recordAuditEvent !== "function") return;
          await recordAuditEvent(ownerId, BACKGROUND_TICK_AUDIT_EVENTS.queuedEvent, {
            agentId,
            scheduleDate: slot.scheduleDate ?? slot.localDate,
            slotIndex: slot.slotIndex,
            season,
            episode,
            releaseId,
            jobId,
          });
        },
      });
      if (typeof recordAuditEvent === "function" && !dryRun) {
        await recordAuditEvent(ownerId, BACKGROUND_TICK_AUDIT_EVENTS.tickEvent, {
          directors: report.totals.directors,
          created: report.totals.created,
          delayed: report.totals.delayed,
          blocked: report.totals.blocked,
          skipped: report.totals.skipped,
          duplicates: report.totals.duplicates,
        });
      }
      totals.directors += report.totals.directors;
      totals.pausedDirectors += report.totals.pausedDirectors;
      totals.created += report.totals.created;
      totals.delayed += report.totals.delayed;
      totals.blocked += report.totals.blocked;
      totals.skipped += report.totals.skipped;
      totals.duplicates += report.totals.duplicates;
      ownerReports.push(Object.freeze({ ownerId, report }));
    } catch (error) {
      totals.ownerFailures += 1;
      ownerReports.push(Object.freeze({
        ownerId,
        ownershipFailureCode: error?.code ?? "SCHEDULER_OWNER_FAILED",
      }));
    }
  }

  return Object.freeze({
    schemaVersion: "background_schedule_tick_v1",
    totals: Object.freeze(totals),
    invalidSchedules: Object.freeze(invalidSchedules.slice(0, 200)),
    ownersTouched: validByOwner.size,
    dryRun: dryRun === true,
    ownerReports,
  });
}

// --------------------------------------------------------------------------
// Test seam for rowsProvider-only unit runs: pass an injected
// `scheduleRepository` (or a resolver function) instead of a db. The trigger
// handles grouping, owner isolation, and audit logic; the repository seam
// keeps claim/mark semantics under test control without a database.
// --------------------------------------------------------------------------

export default {
  createBackgroundSchedulerTrigger,
  parseSchedulerIntervalMinutes,
  runAllDirectorScheduleTicks,
  DEFAULT_SCHEDULER_INTERVAL_MINUTES,
  SCHEDULE_TRIGGER_ENABLED_ENV,
};
