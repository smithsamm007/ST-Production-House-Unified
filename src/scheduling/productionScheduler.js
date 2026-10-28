/**
 * ST Production House — per-Director daily production scheduler.
 *
 * Owner master prompt: "PER-DIRECTOR EPISODE DURATION & DAILY PRODUCTION
 * SCHEDULER". This is the ONE scheduler: it extends the existing queue
 * (Hermes `production.start` → `ProductionRepository.createReleaseWithJob`)
 * by planning each Director's OWN persisted schedule instead of introducing a
 * second, competing queue.
 *
 * What it does, per enabled Director:
 *   1. reads that Director's persisted settings (duration, daily target,
 *      production days, start time, timezone);
 *   2. computes the eligible production dates and start instants in the
 *      Director's own timezone (DST-correct);
 *   3. for every DUE slot it claims a durable, UNIQUE slot reservation
 *      (owner, agent, local date, slot index) — a second run of the scheduler
 *      can therefore never create a second logical episode for that slot
 *      (AGENTS.md Rule 13, Rule 8);
 *   4. admits the slot only if real capacity exists: worker/queue concurrency
 *      limits and the provider-quota snapshot. Otherwise the slot is recorded
 *      `delayed`/`blocked` WITH a stable reason code — planned output is never
 *      reported as produced output;
 *   5. queues the planned episode through the existing repository path with
 *      the Director's configured duration carried on the job;
 *   6. bounds catch-up so a long outage cannot manufacture an uncontrolled
 *      backlog: at most `lookbackDays` missed dates are examined, and missed
 *      slots are recorded `skipped` (MISSED_SCHEDULE_WINDOW) rather than
 *      silently queued weeks of work.
 *
 * Honesty and safety (AGENTS.md Rules 1–3, 5, 7, 13, 16):
 *   - Nothing here publishes. Queued work lands in the existing owner-approval
 *     pipeline; live publishing still requires an unexpired owner approval.
 *   - Nothing is fabricated: a slot whose provider capacity is exhausted is
 *     delayed, a slot whose channel is unavailable is blocked, and every one
 *     of those states is persisted with its reason.
 *   - Director isolation: every read and write carries (ownerId, agentId) and
 *     a tick that processes several Directors keeps independent cursors — one
 *     Director's schedule can never modify another's queue or settings.
 *   - The scheduler is a PURE planner plus an injected-dependency tick: the
 *     repository, production repository, job-status lookup, quota snapshot and
 *     clock are all injected, so the whole contract is testable offline (and
 *     is proven that way in tests/productionScheduler.test.js).
 */

import {
  DIRECTOR_SCHEDULE_VERSION,
  NEXT_SLOT_HORIZON_DAYS,
  addDaysToDate,
  directorLocalDate,
  nextEligibleSlot,
  parseProductionDays,
  planDailySlots,
  validateDirectorScheduleInput,
  weekdayOfDate,
  describeProductionDays,
} from "./directorSchedule.js";

export const PRODUCTION_SCHEDULER_VERSION = "director_production_scheduler_v1";
export const PRODUCTION_SCHEDULER_CONTRACT_VERSION = DIRECTOR_SCHEDULE_VERSION;

/** Durable slot states (closed enum, introduced by sql/029). */
export const SLOT_STATES = Object.freeze(["pending", "queued", "delayed", "blocked", "skipped"]);

/** Stable reason codes explaining why a slot produced no episode (fail-closed). */
export const SCHEDULER_REASON_CODES = Object.freeze([
  "SLOT_ALREADY_CLAIMED",
  "CAPACITY_LIMIT_REACHED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PRODUCTION_UNAVAILABLE",
  "DIRECTOR_DISABLED",
  "PRODUCTION_SLOT_TAKEN",
  "SCHEDULE_QUEUE_FAILED",
  "MISSED_SCHEDULE_WINDOW",
]);

/** Only this many missed dates are examined per run (backlog bound). */
export const DEFAULT_LOOKBACK_DAYS = 1;

/**
 * Active (queued/leased/running) jobs admitted per Director before further
 * slots are DELAYED. Defaults to the largest offered daily preset (3) so an
 * owner-chosen 1/2/3-episode day queues in one tick, while a CUSTOM 4–6/day
 * target is capacity-serialized honestly: extra due slots are recorded
 * `delayed` (CAPACITY_LIMIT_REACHED) and re-attempted by later ticks, never
 * silently queued past real capacity (master prompt §6).
 */
export const DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR = 3;

const JOB_ACTIVE_STATUSES = Object.freeze(["queued", "leased", "running"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Count of a Director's jobs that currently occupy the queue. */
export function countActiveJobs(statuses) {
  if (!Array.isArray(statuses)) return 0;
  return statuses.filter((status) => JOB_ACTIVE_STATUSES.includes(status)).length;
}

/**
 * Pure plan for one Director over the bounded lookback window.
 *
 * Returns the local "today", every examined date with its eligible slots, the
 * slots that are DUE at `now` (oldest first), and the upcoming slots that are
 * planned but not yet due. No I/O, no clock except the injected `now`.
 */
export function planDirectorProductionWindow({
  settings,
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  horizonDays = NEXT_SLOT_HORIZON_DAYS,
}) {
  const normalized = validateDirectorScheduleInput(settings);
  if (!Number.isInteger(lookbackDays) || lookbackDays < 0 || lookbackDays > 14) {
    throw fail("SCHEDULE_INPUT_INVALID");
  }
  const localToday = directorLocalDate(now, normalized.timezone);
  const nowMs = now.getTime();

  const examined = [];
  const dueSlots = [];
  for (let offset = lookbackDays; offset >= 0; offset -= 1) {
    const dateString = addDaysToDate(localToday, -offset);
    const slots = planDailySlots({ settings: normalized, dateString });
    const eligible = normalized.productionDays.includes(weekdayOfDate(dateString));
    const dateIsPast = offset > 0;
    // A PAST date is never queued: it is examined only so the tick can record
    // WHY a missed slot produced nothing (bounded catch-up, no runaway
    // backlog). Only the Director's CURRENT local day yields due slots.
    const dateDue = dateIsPast
      ? []
      : slots.filter((slot) => new Date(slot.startsAt).getTime() <= nowMs);
    examined.push(Object.freeze({
      dateString,
      weekday: weekdayOfDate(dateString),
      eligible,
      past: dateIsPast,
      slots: [...slots],
      dueSlots: [...dateDue],
    }));
    for (const slot of dateDue) dueSlots.push(Object.freeze({ ...slot, scheduleDate: dateString }));
  }

  // Planned-but-not-yet-due slots are reported, never queued: the worker pool
  // has no start-time gate, so queueing early would run the episode before the
  // Director's chosen production time.
  const upcomingSlots = [];
  for (let offset = 0; offset <= horizonDays && upcomingSlots.length < normalized.episodesPerDay; offset += 1) {
    const dateString = addDaysToDate(localToday, offset);
    for (const slot of planDailySlots({ settings: normalized, dateString })) {
      if (upcomingSlots.length >= normalized.episodesPerDay) break;
      if (new Date(slot.startsAt).getTime() > nowMs) {
        upcomingSlots.push(Object.freeze({ ...slot, scheduleDate: dateString }));
      }
    }
  }

  return deepFreeze({
    schedulerVersion: PRODUCTION_SCHEDULER_VERSION,
    settings: normalized,
    localToday,
    examined,
    dueSlots,
    upcomingSlots,
    nextEligibleSlot: nextEligibleSlot({ settings: normalized, now, horizonDays }),
  });
}

/**
 * Capacity/quota admission for ONE due slot. Pure: all facts are injected.
 *
 *   quotaSnapshot: { state: "AVAILABLE" | "EXHAUSTED" | "UNKNOWN" } | null
 *
 * Returns { admitted, reasonCode } — EXHAUSTED is an honest delay, UNKNOWN is
 * admitted (the executor enforces quota at run time and reports the durable
 * wait truthfully; the scheduler never invents a block it cannot evidence).
 */
export function evaluateSlotAdmission({
  activeJobCount,
  maxConcurrentJobsPerDirector = DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR,
  quotaSnapshot = null,
}) {
  if (quotaSnapshot && quotaSnapshot.state === "EXHAUSTED") {
    return Object.freeze({ admitted: false, reasonCode: "PROVIDER_QUOTA_EXHAUSTED" });
  }
  const active = Number.isInteger(activeJobCount) ? activeJobCount : 0;
  if (active >= maxConcurrentJobsPerDirector) {
    return Object.freeze({ admitted: false, reasonCode: "CAPACITY_LIMIT_REACHED" });
  }
  return Object.freeze({ admitted: true, reasonCode: null });
}

/**
 * The next episode number for a channel: the highest planned episode in the
 * current season, plus one. Deterministic; falls back to season 1 / episode 1
 * when the channel has no releases yet.
 */
export function nextEpisodeSlot({ releases }) {
  const list = Array.isArray(releases) ? releases : [];
  if (list.length === 0) return Object.freeze({ season: 1, episode: 1 });
  const season = Math.max(...list.map((release) => Number(release.season) || 1));
  const sameSeason = list.filter((release) => Number(release.season) === season);
  const episode = Math.max(...sameSeason.map((release) => Number(release.episode) || 0)) + 1;
  return Object.freeze({ season, episode });
}

/**
 * Run one scheduler tick for the supplied Directors.
 *
 *   schedules            — [{ agentId, settings }] already-persisted settings
 *   scheduleRepository   — {
 *                            claimSlot({ ownerId, agentId, scheduleDate,
 *                                        slotIndex, episodeDurationSeconds }),
 *                            getSlot(ownerId, agentId, scheduleDate, slotIndex),
 *                            markSlot(ownerId, agentId, scheduleDate,
 *                                     slotIndex, { state, reasonCode,
 *                                       releaseId, jobId, season, episode })
 *                          }  (claimSlot returns { claimed: boolean })
 *   production           — ProductionRepository-like {
 *                            getChannel, listReleasesForChannel,
 *                            createReleaseWithJob }
 *   listJobStatuses      — async (agentId) => ["queued", "running", …]
 *   quotaSnapshotProvider— optional async (agentId) => { state } | null
 *   enabledAgents        — optional async () => [{ id, enabled }]
 *   onDirectorPlanned    — optional async ({ ownerId, agentId, slot,
 *                            releaseId, jobId }) => void  (audit hook)
 *
 * Returns a frozen, truthful report — created / delayed / blocked / skipped
 * are persisted rows, never intentions.
 */
export async function runDirectorScheduleTick({
  ownerId,
  schedules,
  scheduleRepository,
  production = null,
  listJobStatuses = null,
  quotaSnapshotProvider = null,
  enabledAgents = null,
  onDirectorPlanned = null,
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  maxConcurrentJobsPerDirector = DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR,
  dryRun = false,
} = {}) {
  if (typeof ownerId !== "string" || ownerId.length === 0) throw fail("SCHEDULE_INPUT_INVALID");
  if (!isPlainObject(scheduleRepository) || typeof scheduleRepository.claimSlot !== "function" ||
      typeof scheduleRepository.markSlot !== "function") {
    throw fail("SCHEDULER_REPOSITORY_REQUIRED");
  }
  if (!Array.isArray(schedules)) throw fail("SCHEDULE_INPUT_INVALID");

  const agentEnabledById = new Map();
  if (typeof enabledAgents === "function") {
    for (const agent of (await enabledAgents()) ?? []) {
      agentEnabledById.set(agent.id, agent.enabled === true);
    }
  }

  const directorReports = [];
  const totals = {
    directors: 0,
    pausedDirectors: 0,
    created: 0,
    delayed: 0,
    blocked: 0,
    skipped: 0,
    duplicates: 0,
    notYetDue: 0,
  };

  for (const entry of schedules) {
    if (!isPlainObject(entry) || typeof entry.agentId !== "string") throw fail("SCHEDULE_INPUT_INVALID");
    const settings = validateDirectorScheduleInput(entry.settings);
    totals.directors += 1;

    // PAUSED: no planned rows, no jobs, no side effects (master prompt §2E).
    if (!settings.scheduleEnabled) {
      totals.pausedDirectors += 1;
      directorReports.push(deepFreeze({
        agentId: entry.agentId,
        scheduleEnabled: false,
        episodeDurationSeconds: settings.episodeDurationSeconds,
        episodesPerDay: settings.episodesPerDay,
        productionDaysLabel: describeProductionDays(settings.productionDays),
        productionDays: [...settings.productionDays],
        timezone: settings.timezone,
        productionStartTime: settings.productionStartTime,
        localToday: directorLocalDate(now, settings.timezone),
        nextEligibleSlot: null,
        notYetDue: 0,
        created: 0,
        delayed: 0,
        blocked: 0,
        skipped: 0,
        duplicates: 0,
        slots: [],
      }));
      continue;
    }

    const window = planDirectorProductionWindow({ settings, now, lookbackDays });
    const agentEnabled = agentEnabledById.size === 0 ? true : agentEnabledById.get(entry.agentId) === true;

    // Channel + release context per Director (never shared across Directors).
    let channel = null;
    let releases = [];
    if (production && typeof production.getChannel === "function") {
      channel = await resolveChannel({ production, ownerId, agentId: entry.agentId });
      if (channel && typeof production.listReleasesForChannel === "function") {
        releases = (await production.listReleasesForChannel(ownerId, channel.id, { limit: 200 })) ?? [];
      }
    }
    let allocation = nextEpisodeSlot({ releases });

    let activeJobCount = 0;
    if (typeof listJobStatuses === "function") {
      activeJobCount = countActiveJobs(await listJobStatuses(entry.agentId));
    }
    let quotaSnapshot = null;
    if (typeof quotaSnapshotProvider === "function") {
      quotaSnapshot = await quotaSnapshotProvider(entry.agentId);
    }

    const slots = [];
    let created = 0;
    let delayed = 0;
    let blocked = 0;
    let skipped = 0;
    let duplicates = 0;

    /** Every examined past date with an eligible-but-unfilled slot set. */
    const missedDates = window.examined.filter((date) => date.past && date.eligible);

    for (const date of missedDates) {
      for (const slot of date.slots) {
        const claim = await claimOrRead({ scheduleRepository, ownerId, agentId: entry.agentId, slot, dateString: date.dateString, settings, dryRun });
        if (claim.mode !== "claimed") {
          duplicates += 1;
          continue;
        }
        if (!dryRun) {
          await scheduleRepository.markSlot(ownerId, entry.agentId, date.dateString, slot.slotIndex, {
            state: "skipped",
            reasonCode: "MISSED_SCHEDULE_WINDOW",
          });
        }
        skipped += 1;
        slots.push(deepFreeze({
          scheduleDate: date.dateString,
          slotIndex: slot.slotIndex,
          startsAt: slot.startsAt,
          state: "skipped",
          reasonCode: "MISSED_SCHEDULE_WINDOW",
          releaseId: null,
          jobId: null,
          season: null,
          episode: null,
        }));
      }
    }

    for (const slot of window.dueSlots) {
      const claim = await claimOrRead({
        scheduleRepository, ownerId, agentId: entry.agentId, slot,
        dateString: slot.scheduleDate, settings, dryRun,
      });
      if (claim.mode === "already") {
        // Idempotency: this (Director, local date, slot) already has a durable
        // outcome — a repeated run must never create a second logical episode.
        duplicates += 1;
        continue;
      }
      // `mode === "retry"`: the slot was DELAYED (capacity/quota) earlier and
      // stays due. It is re-attempted in place — a rescheduled eligible slot
      // never mints a second episode (Rule 8).

      const blockedReason = !agentEnabled
        ? "DIRECTOR_DISABLED"
        : (!production || !channel ? "PRODUCTION_UNAVAILABLE" : null);
      const admission = blockedReason
        ? Object.freeze({ admitted: false, reasonCode: blockedReason })
        : evaluateSlotAdmission({
            activeJobCount,
            maxConcurrentJobsPerDirector,
            quotaSnapshot,
          });

      if (!admission.admitted) {
        const state = blockedReason ? "blocked" : "delayed";
        if (!dryRun) {
          await scheduleRepository.markSlot(ownerId, entry.agentId, slot.scheduleDate, slot.slotIndex, {
            state,
            reasonCode: admission.reasonCode,
          });
        }
        if (state === "blocked") blocked += 1; else delayed += 1;
        slots.push(deepFreeze({
          scheduleDate: slot.scheduleDate,
          slotIndex: slot.slotIndex,
          startsAt: slot.startsAt,
          state,
          reasonCode: admission.reasonCode,
          releaseId: null,
          jobId: null,
          season: null,
          episode: null,
        }));
        continue;
      }

      const title = `${channel.displayName} · S${allocation.season}E${allocation.episode}`;
      let queued;
      try {
        queued = dryRun
          ? { release: { id: null }, jobId: null, conflict: false }
          : await production.createReleaseWithJob(ownerId, {
              channelId: channel.id,
              agentId: entry.agentId,
              title,
              season: allocation.season,
              episode: allocation.episode,
              episodeDurationSeconds: settings.episodeDurationSeconds,
            });
      } catch {
        queued = { failed: true };
      }

      if (queued?.failed) {
        if (!dryRun) {
          await scheduleRepository.markSlot(ownerId, entry.agentId, slot.scheduleDate, slot.slotIndex, {
            state: "blocked",
            reasonCode: "SCHEDULE_QUEUE_FAILED",
          });
        }
        blocked += 1;
        slots.push(deepFreeze({
          scheduleDate: slot.scheduleDate, slotIndex: slot.slotIndex, startsAt: slot.startsAt,
          state: "blocked", reasonCode: "SCHEDULE_QUEUE_FAILED",
          releaseId: null, jobId: null, season: null, episode: null,
        }));
        continue;
      }
      if (queued?.conflict) {
        if (!dryRun) {
          await scheduleRepository.markSlot(ownerId, entry.agentId, slot.scheduleDate, slot.slotIndex, {
            state: "blocked",
            reasonCode: "PRODUCTION_SLOT_TAKEN",
          });
        }
        blocked += 1;
        slots.push(deepFreeze({
          scheduleDate: slot.scheduleDate, slotIndex: slot.slotIndex, startsAt: slot.startsAt,
          state: "blocked", reasonCode: "PRODUCTION_SLOT_TAKEN",
          releaseId: null, jobId: null, season: null, episode: null,
        }));
        continue;
      }

      if (!dryRun) {
        await scheduleRepository.markSlot(ownerId, entry.agentId, slot.scheduleDate, slot.slotIndex, {
          state: "queued",
          reasonCode: null,
          releaseId: queued.release.id,
          jobId: queued.jobId ?? null,
          season: allocation.season,
          episode: allocation.episode,
        });
      }
      created += 1;
      activeJobCount += 1;
      slots.push(deepFreeze({
        scheduleDate: slot.scheduleDate,
        slotIndex: slot.slotIndex,
        startsAt: slot.startsAt,
        state: "queued",
        reasonCode: null,
        releaseId: queued.release?.id ?? null,
        jobId: queued.jobId ?? null,
        season: allocation.season,
        episode: allocation.episode,
      }));
      if (typeof onDirectorPlanned === "function" && !dryRun) {
        await onDirectorPlanned({
          ownerId,
          agentId: entry.agentId,
          slot,
          releaseId: queued.release?.id ?? null,
          jobId: queued.jobId ?? null,
          season: allocation.season,
          episode: allocation.episode,
        });
      }
      allocation = Object.freeze({ season: allocation.season, episode: allocation.episode + 1 });
    }

    totals.created += created;
    totals.delayed += delayed;
    totals.blocked += blocked;
    totals.skipped += skipped;
    totals.duplicates += duplicates;
    totals.notYetDue += window.upcomingSlots.length;

    directorReports.push(deepFreeze({
      agentId: entry.agentId,
      scheduleEnabled: true,
      episodeDurationSeconds: settings.episodeDurationSeconds,
      episodesPerDay: settings.episodesPerDay,
      productionDays: [...settings.productionDays],
      productionDaysLabel: describeProductionDays(settings.productionDays),
      productionStartTime: settings.productionStartTime,
      timezone: settings.timezone,
      localToday: window.localToday,
      nextEligibleSlot: window.nextEligibleSlot,
      notYetDue: window.upcomingSlots.length,
      created,
      delayed,
      blocked,
      skipped,
      duplicates,
      slots,
    }));
  }

  return deepFreeze({
    schedulerVersion: PRODUCTION_SCHEDULER_VERSION,
    contractVersion: PRODUCTION_SCHEDULER_CONTRACT_VERSION,
    ranAt: now.toISOString(),
    lookbackDays,
    maxConcurrentJobsPerDirector,
    dryRun: dryRun === true,
    totals,
    directors: directorReports,
  });
}

async function claimOrRead({ scheduleRepository, ownerId, agentId, slot, dateString, settings, dryRun }) {
  if (dryRun) return Object.freeze({ mode: "claimed", row: null });
  const claim = await scheduleRepository.claimSlot({
    ownerId,
    agentId,
    scheduleDate: dateString,
    slotIndex: slot.slotIndex,
    episodeDurationSeconds: settings.episodeDurationSeconds,
  });
  if (!isPlainObject(claim) || typeof claim.claimed !== "boolean") {
    throw fail("SCHEDULER_REPOSITORY_REQUIRED");
  }
  if (claim.claimed) return Object.freeze({ mode: "claimed", row: null });
  if (typeof scheduleRepository.getSlot === "function") {
    const row = await scheduleRepository.getSlot(ownerId, agentId, dateString, slot.slotIndex);
    // A DELAYED slot (capacity or provider quota) is transient by nature: it
    // is re-attempted while it is still due rather than permanently lost.
    if (row && row.state === "delayed") return Object.freeze({ mode: "retry", row });
  }
  return Object.freeze({ mode: "already", row: null });
}

/** Resolve the owner-scoped channel of one Director without cross-director leakage. */
async function resolveChannel({ production, ownerId, agentId }) {
  if (typeof production.listChannels === "function") {
    const channels = (await production.listChannels(ownerId)) ?? [];
    const mine = channels.filter((channel) => channel.agentId === agentId);
    if (mine.length === 0) return null;
    const channel = mine[0];
    if (typeof production.getChannel === "function") {
      return (await production.getChannel(ownerId, channel.id)) ?? channel;
    }
    return channel;
  }
  return null;
}

/**
 * Read model for the owner dashboard / Hermes planning input: the persisted
 * settings, the planned slots for the current local day, the counted slot
 * states (TRUTHFUL counters from persisted rows) and the Director's real job
 * and release counters. Never reports planned work as completed work.
 */
export function summarizeDirectorSchedule({
  agentId,
  settings,
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  slotCounts = {},
  jobStatuses = [],
  releases = [],
  lastSlot = null,
}) {
  const normalized = validateDirectorScheduleInput(settings);
  const window = planDirectorProductionWindow({ settings: normalized, now, lookbackDays });
  const releasesByStatus = {};
  for (const release of releases) {
    const status = typeof release.status === "string" ? release.status : "unknown";
    releasesByStatus[status] = (releasesByStatus[status] ?? 0) + 1;
  }
  const jobsByStatus = {};
  for (const status of jobStatuses) {
    if (typeof status !== "string") continue;
    jobsByStatus[status] = (jobsByStatus[status] ?? 0) + 1;
  }
  return deepFreeze({
    agentId,
    schedulerVersion: PRODUCTION_SCHEDULER_VERSION,
    scheduleEnabled: normalized.scheduleEnabled,
    episodeDurationSeconds: normalized.episodeDurationSeconds,
    episodesPerDay: normalized.episodesPerDay,
    productionDays: [...normalized.productionDays],
    productionDaysLabel: describeProductionDays(normalized.productionDays),
    productionStartTime: normalized.productionStartTime,
    timezone: normalized.timezone,
    localToday: window.localToday,
    todayPlannedSlots: window.examined.find((date) => date.dateString === window.localToday)?.slots ?? [],
    nextEligibleSlot: window.nextEligibleSlot,
    upcomingSlots: window.upcomingSlots,
    activeJobCount: countActiveJobs(jobStatuses),
    slots: {
      queued: slotCounts.queued ?? 0,
      delayed: slotCounts.delayed ?? 0,
      blocked: slotCounts.blocked ?? 0,
      skipped: slotCounts.skipped ?? 0,
      pending: slotCounts.pending ?? 0,
      total: slotCounts.total ?? 0,
    },
    jobsByStatus,
    releasesByStatus,
    completedReleases: (releasesByStatus.review ?? 0) + (releasesByStatus.published ?? 0),
    awaitingOwnerApproval: releasesByStatus.review ?? 0,
    publishedReleases: releasesByStatus.published ?? 0,
    lastSlot: lastSlot
      ? {
          scheduleDate: lastSlot.schedule_date ?? lastSlot.scheduleDate ?? null,
          slotIndex: Number(lastSlot.slot_index ?? lastSlot.slotIndex ?? 0),
          state: lastSlot.state ?? null,
          reasonCode: lastSlot.reason_code ?? lastSlot.reasonCode ?? null,
          releaseId: lastSlot.release_id ?? lastSlot.releaseId ?? null,
          jobId: lastSlot.job_id ?? lastSlot.jobId ?? null,
          season: lastSlot.season === null || lastSlot.season === undefined ? null : Number(lastSlot.season),
          episode: lastSlot.episode === null || lastSlot.episode === undefined ? null : Number(lastSlot.episode),
          updatedAt: lastSlot.updated_at ?? lastSlot.updatedAt ?? null,
        }
      : null,
  });
}

export default {
  runDirectorScheduleTick,
  planDirectorProductionWindow,
  summarizeDirectorSchedule,
};

// Re-exported so consumers of the scheduler need only one import surface.
export { parseProductionDays };
