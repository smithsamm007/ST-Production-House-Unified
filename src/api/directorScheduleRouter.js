/**
 * ST Production House — Owner API: per-Director episode & production schedule.
 *
 * Owner master prompt: "PER-DIRECTOR EPISODE DURATION & DAILY PRODUCTION
 * SCHEDULER". Mounted at /api/scheduling behind `authenticateOwner`:
 *
 *   GET  /limits                  → declared duration/frequency limits
 *   GET  /directors               → every Director's own persisted schedule,
 *                                   planned slots, next eligible slot, and
 *                                   TRUTHFUL queue/release counters
 *   GET  /directors/:agentId      → one Director's schedule + recent slots
 *   PUT  /directors/:agentId      → create/update the schedule (CSRF + audit)
 *   POST /directors/:agentId/run  → run ONE scheduler tick for that Director
 *                                   (CSRF + audit; `{ dryRun: true }` plans
 *                                   without writing anything)
 *
 * Security contract (AGENTS.md Rules 1, 5, 6, 7, 15, 17):
 *   - Every route requires a valid authenticated session; mutations also
 *     require a per-session CSRF token and always write an audit event.
 *   - Owner identity is SERVER-authoritative (req.ownerId) and every query is
 *     scoped to (owner, agent): another Director's schedule is a generic 404.
 *   - Validation runs SERVER-side through the pure schedule contract, so the
 *     dashboard cannot bypass it; unknown fields fail closed.
 *   - Responses are explicit safe DTOs — scheduling fields only, no agent
 *     names, no secrets, no storage internals.
 *   - Saving or enabling a schedule NEVER publishes and NEVER bypasses the
 *     owner-approval gate (Rule 7): a tick only QUEUES planned episodes into
 *     the existing approval pipeline.
 *   - Without configured storage the routes degrade honestly with 503 rather
 *     than faking a schedule (Rules 1–3).
 */

import { Router } from "express";
import { verifyCsrfToken } from "../catalog/ownerAuthentication.js";
import { DirectorScheduleRepository } from "../catalog/scheduleRepository.js";
import {
  EPISODE_DURATION_OPTIONS_SECONDS,
  EPISODES_PER_DAY_OPTIONS,
  EPISODES_PER_DAY_SAFE_LIMIT,
  PRODUCTION_DAY_PRESETS,
  defaultDirectorScheduleDto,
  directorScheduleDto,
  validateDirectorScheduleInput,
} from "../scheduling/directorSchedule.js";
import {
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR,
  runDirectorScheduleTick,
  summarizeDirectorSchedule,
} from "../scheduling/productionScheduler.js";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const JOB_LIST_LIMIT = 200;
const RELEASE_LIST_LIMIT = 200;
const SLOT_HISTORY_LIMIT = 20;

const SCHEDULE_INPUT_FIELDS = Object.freeze([
  "episodeDurationSeconds",
  "episodeDurationMinutes",
  "episodesPerDay",
  "productionDays",
  "productionStartTime",
  "timezone",
  "scheduleEnabled",
]);

/** Stable validation codes the client may see (allowlisted public errors). */
export const SCHEDULE_VALIDATION_CODES = Object.freeze([
  "SCHEDULE_INPUT_INVALID",
  "SCHEDULE_FIELD_UNKNOWN",
  "SCHEDULE_DURATION_INVALID",
  "SCHEDULE_EPISODES_PER_DAY_INVALID",
  "SCHEDULE_PRODUCTION_DAYS_INVALID",
  "SCHEDULE_START_TIME_INVALID",
  "SCHEDULE_TIMEZONE_INVALID",
  "SCHEDULE_ENABLED_INVALID",
  "SCHEDULE_DATE_INVALID",
]);

function hasOnlyFields(value, allowed) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

async function requireCsrf(req, res, next) {
  try {
    await verifyCsrfToken(req.session?.id, req.headers["x-csrf-token"]);
    return next();
  } catch {
    return res.status(403).json({ error: "CSRF_TOKEN_INVALID" });
  }
}

function logRouterError(event, err) {
  console.error(JSON.stringify({ event, error: err?.message ?? String(err) }));
}

function sendStorageError(res, err) {
  if (err?.code === "STORAGE_NOT_CONFIGURED") {
    return res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
  }
  return null;
}

/** Declared validation limits — the dashboard renders these, it does not invent them. */
export function scheduleLimits() {
  return Object.freeze({
    episodeDurationOptionsSeconds: [...EPISODE_DURATION_OPTIONS_SECONDS],
    episodesPerDayOptions: [...EPISODES_PER_DAY_OPTIONS],
    episodesPerDaySafeLimit: EPISODES_PER_DAY_SAFE_LIMIT,
    productionDayPresets: PRODUCTION_DAY_PRESETS,
    defaultLookbackDays: DEFAULT_LOOKBACK_DAYS,
    defaultMaxConcurrentJobsPerDirector: DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR,
  });
}

/** The settings object the pure contract consumes, derived from a safe DTO. */
function settingsFromDto(dto) {
  return {
    episodeDurationSeconds: dto.episodeDurationSeconds,
    episodesPerDay: dto.episodesPerDay,
    productionDays: [...dto.productionDays],
    productionStartTime: dto.productionStartTime,
    timezone: dto.timezone,
    scheduleEnabled: dto.scheduleEnabled,
  };
}

export function createDirectorScheduleRouter({
  db,
  recordAuditEvent,
  productionRepository,
  quotaSnapshotProvider = null,
  now = () => new Date(),
} = {}) {
  const resolveDb = typeof db === "function" ? db : () => db;
  const resolveProduction = typeof productionRepository === "function"
    ? productionRepository
    : () => productionRepository;

  function getRepo() {
    const adapter = resolveDb();
    if (!adapter || typeof adapter.query !== "function") {
      const error = new Error("STORAGE_NOT_CONFIGURED");
      error.code = "STORAGE_NOT_CONFIGURED";
      throw error;
    }
    return new DirectorScheduleRepository(adapter);
  }

  async function agentExists(agentId) {
    const result = await resolveDb().query("SELECT id FROM agents WHERE id = $1;", [agentId]);
    return result.rows.length > 0;
  }

  async function listJobStatuses(ownerId, agentId) {
    const result = await resolveDb().query(
      `SELECT status FROM jobs WHERE owner_id = $1 AND agent_id = $2 LIMIT ${JOB_LIST_LIMIT};`,
      [ownerId, agentId],
    );
    return result.rows.map((row) => row.status);
  }

  async function channelForAgent(ownerId, agentId) {
    const production = resolveProduction();
    if (!production || typeof production.listChannels !== "function") return null;
    const channels = (await production.listChannels(ownerId)) ?? [];
    return channels.find((channel) => channel.agentId === agentId) ?? null;
  }

  async function listReleases(ownerId, channel) {
    const production = resolveProduction();
    if (!channel || !production || typeof production.listReleasesForChannel !== "function") return [];
    return (await production.listReleasesForChannel(ownerId, channel.id, { limit: RELEASE_LIST_LIMIT })) ?? [];
  }

  async function buildDirectorView(ownerId, { agentId, channel, withHistory }) {
    const repo = getRepo();
    const row = await repo.getScheduleRow(ownerId, agentId);
    const schedule = row ? directorScheduleDto(row) : defaultDirectorScheduleDto(agentId);
    const [slotCounts, jobStatuses, releases, lastSlot] = await Promise.all([
      repo.countSlotsByState(ownerId, agentId),
      listJobStatuses(ownerId, agentId),
      listReleases(ownerId, channel),
      repo.getLastSlot(ownerId, agentId),
    ]);
    const summary = summarizeDirectorSchedule({
      agentId,
      settings: settingsFromDto(schedule),
      now: now(),
      slotCounts,
      jobStatuses,
      releases,
      lastSlot,
    });
    const view = {
      agentId,
      channelId: channel?.id ?? null,
      channelDisplayName: channel?.displayName ?? null,
      schedule,
      counters: {
        slots: summary.slots,
        jobs: summary.jobsByStatus,
        releases: summary.releasesByStatus,
        activeJobs: summary.activeJobCount,
        completedReleases: summary.completedReleases,
        awaitingOwnerApproval: summary.awaitingOwnerApproval,
        publishedReleases: summary.publishedReleases,
      },
      planning: {
        localToday: summary.localToday,
        todayPlannedSlots: summary.todayPlannedSlots,
        nextEligibleSlot: summary.nextEligibleSlot,
        upcomingSlots: summary.upcomingSlots,
      },
      lastSlot: summary.lastSlot,
    };
    if (withHistory) {
      view.recentSlots = await repo.listSlots(ownerId, agentId, { limit: SLOT_HISTORY_LIMIT });
    }
    return view;
  }

  const router = Router();

  router.get("/limits", (req, res) => res.status(200).json(scheduleLimits()));

  router.get("/directors", async (req, res) => {
    try {
      const production = resolveProduction();
      const channels = production && typeof production.listChannels === "function"
        ? (await production.listChannels(req.ownerId)) ?? []
        : [];
      const seen = [];
      const directors = [];
      for (const channel of channels) {
        if (seen.includes(channel.agentId)) continue;
        seen.push(channel.agentId);
        directors.push(await buildDirectorView(req.ownerId, {
          agentId: channel.agentId,
          channel,
          withHistory: false,
        }));
      }
      // Directors with a persisted schedule but no channel yet stay visible:
      // their configuration is real and their blocked reason is honest.
      for (const record of await getRepo().listScheduleRecords(req.ownerId)) {
        if (seen.includes(record.agentId)) continue;
        seen.push(record.agentId);
        directors.push(await buildDirectorView(req.ownerId, {
          agentId: record.agentId,
          channel: null,
          withHistory: false,
        }));
      }
      return res.status(200).json({ count: directors.length, directors, limits: scheduleLimits() });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("DIRECTOR_SCHEDULE_LIST_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.get("/directors/:agentId", async (req, res) => {
    try {
      const { agentId } = req.params;
      if (!AGENT_ID_PATTERN.test(agentId) || !(await agentExists(agentId))) {
        return res.status(404).json({ error: "AGENT_NOT_FOUND" });
      }
      const channel = await channelForAgent(req.ownerId, agentId);
      return res.status(200).json(await buildDirectorView(req.ownerId, { agentId, channel, withHistory: true }));
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("DIRECTOR_SCHEDULE_GET_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.put("/directors/:agentId", requireCsrf, async (req, res) => {
    try {
      const { agentId } = req.params;
      if (!AGENT_ID_PATTERN.test(agentId)) return res.status(404).json({ error: "AGENT_NOT_FOUND" });
      if (!hasOnlyFields(req.body, SCHEDULE_INPUT_FIELDS)) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      if (!(await agentExists(agentId))) return res.status(404).json({ error: "AGENT_NOT_FOUND" });
      const repo = getRepo();
      const existing = await repo.getScheduleRow(req.ownerId, agentId);
      const base = existing
        ? {
            episodeDurationSeconds: Number(existing.episode_duration_seconds),
            episodesPerDay: Number(existing.episodes_per_day),
            productionDays: String(existing.production_days),
            productionStartTime: String(existing.production_start_time),
            timezone: String(existing.timezone),
            scheduleEnabled: existing.schedule_enabled === true,
          }
        : null;
      let saved;
      try {
        saved = await repo.upsertSchedule(
          req.ownerId,
          agentId,
          validateDirectorScheduleInput(req.body, base),
        );
      } catch (err) {
        const code = err?.code ?? "SCHEDULE_INPUT_INVALID";
        if (SCHEDULE_VALIDATION_CODES.includes(code)) return res.status(400).json({ error: code });
        throw err;
      }
      if (typeof recordAuditEvent === "function") {
        await recordAuditEvent(req.ownerId, "director_schedule_saved", {
          agentId,
          episodeDurationSeconds: saved.episodeDurationSeconds,
          episodesPerDay: saved.episodesPerDay,
          productionDays: saved.productionDays,
          productionStartTime: saved.productionStartTime,
          timezone: saved.timezone,
          scheduleEnabled: saved.scheduleEnabled,
        });
      }
      return res.status(200).json(saved);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = err?.code ?? err?.message;
      if (SCHEDULE_VALIDATION_CODES.includes(code)) return res.status(400).json({ error: code });
      logRouterError("DIRECTOR_SCHEDULE_SAVE_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/directors/:agentId/run", requireCsrf, async (req, res) => {
    try {
      const { agentId } = req.params;
      if (!AGENT_ID_PATTERN.test(agentId)) return res.status(404).json({ error: "AGENT_NOT_FOUND" });
      if (!hasOnlyFields(req.body, ["dryRun", "lookbackDays", "maxConcurrentJobsPerDirector"])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      if (req.body.dryRun !== undefined && typeof req.body.dryRun !== "boolean") {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      const dryRun = req.body.dryRun === true;
      const lookbackDays = req.body.lookbackDays === undefined
        ? DEFAULT_LOOKBACK_DAYS
        : Number(req.body.lookbackDays);
      if (!Number.isInteger(lookbackDays) || lookbackDays < 0 || lookbackDays > 14) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      const maxConcurrentJobsPerDirector = req.body.maxConcurrentJobsPerDirector === undefined
        ? DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR
        : Number(req.body.maxConcurrentJobsPerDirector);
      if (!Number.isInteger(maxConcurrentJobsPerDirector) || maxConcurrentJobsPerDirector < 1 ||
          maxConcurrentJobsPerDirector > 8) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      if (!(await agentExists(agentId))) return res.status(404).json({ error: "AGENT_NOT_FOUND" });

      const repo = getRepo();
      const records = await repo.listScheduleRecords(req.ownerId, { agentIds: [agentId] });
      if (records.length === 0) {
        // No persisted schedule: report honestly instead of inventing one.
        return res.status(409).json({ error: "DIRECTOR_SCHEDULE_NOT_CONFIGURED" });
      }
      const record = records[0];
      if (record.invalid) {
        return res.status(409).json({ error: record.invalidReason ?? "SCHEDULE_INPUT_INVALID" });
      }
      const channel = await channelForAgent(req.ownerId, agentId);
      const production = resolveProduction();
      const report = await runDirectorScheduleTick({
        ownerId: req.ownerId,
        schedules: [{ agentId, settings: record.settings }],
        scheduleRepository: repo,
        production: channel && production ? production : null,
        listJobStatuses: (id) => listJobStatuses(req.ownerId, id),
        quotaSnapshotProvider,
        now: now(),
        lookbackDays,
        maxConcurrentJobsPerDirector,
        dryRun,
        onDirectorPlanned: async ({ slot, releaseId, jobId, season, episode }) => {
          if (typeof recordAuditEvent !== "function") return;
          await recordAuditEvent(req.ownerId, "scheduled_production_queued", {
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
        await recordAuditEvent(req.ownerId, "production_schedule_tick", {
          agentId,
          lookbackDays,
          created: report.totals.created,
          delayed: report.totals.delayed,
          blocked: report.totals.blocked,
          skipped: report.totals.skipped,
          duplicates: report.totals.duplicates,
        });
      }
      return res.status(200).json(report);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = err?.code ?? err?.message;
      if (code === "SCHEDULER_REPOSITORY_REQUIRED") {
        return res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
      }
      logRouterError("DIRECTOR_SCHEDULE_RUN_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  return router;
}

export default createDirectorScheduleRouter;
