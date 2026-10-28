/**
 * Per-Director daily production scheduler — contract tests.
 *
 * Fully offline: the schedule repository, production repository, job-status
 * lookup, quota snapshot and clock are injected fakes, so the scheduler's
 * idempotency, capacity/quota honesty, pause/resume behaviour, backlog bound,
 * timezone/date-boundary handling and Director isolation are all proven without
 * a database, a worker, or a provider.
 *
 * Honesty (Rule 1): every assertion here reads what the tick PERSISTED or
 * RETURNED — no test asserts a claim that the scheduler did not record.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR,
  SLOT_STATES,
  countActiveJobs,
  evaluateSlotAdmission,
  nextEpisodeSlot,
  planDirectorProductionWindow,
  runDirectorScheduleTick,
  summarizeDirectorSchedule,
} from "../src/scheduling/productionScheduler.js";
import { validateDirectorScheduleInput } from "../src/scheduling/directorSchedule.js";

const VEDA_LIKE = Object.freeze({
  episodeDurationSeconds: 2400,
  episodesPerDay: 1,
  productionDays: [1, 2, 3, 4, 5, 6, 7],
  productionStartTime: "09:00",
  timezone: "Asia/Kolkata",
  scheduleEnabled: true,
});
const COSMOS_LIKE = Object.freeze({
  episodeDurationSeconds: 1800,
  episodesPerDay: 2,
  productionDays: [1, 2, 3, 4, 5],
  productionStartTime: "09:00",
  timezone: "Asia/Kolkata",
  scheduleEnabled: true,
});
const CUSTOM_LIKE = Object.freeze({
  episodeDurationSeconds: 3000,
  episodesPerDay: 1,
  productionDays: [3, 6],
  productionStartTime: "06:30",
  timezone: "UTC",
  scheduleEnabled: true,
});

function settings(overrides = {}) {
  return validateDirectorScheduleInput({ ...VEDA_LIKE, ...overrides });
}

/** In-memory schedule repository (same contract as sql/029 via DirectorScheduleRepository). */
function makeScheduleRepository(seed = []) {
  const slots = new Map(seed.map((row) => [`${row.agentId}|${row.scheduleDate}|${row.slotIndex}`, { ...row }]));
  return {
    slots,
    get rows() { return [...slots.values()]; },
    async claimSlot({ ownerId, agentId, scheduleDate, slotIndex, episodeDurationSeconds }) {
      const key = `${agentId}|${scheduleDate}|${slotIndex}`;
      if (slots.has(key)) return Object.freeze({ claimed: false });
      slots.set(key, {
        ownerId,
        agentId,
        scheduleDate,
        slotIndex,
        episodeDurationSeconds,
        state: "pending",
        reasonCode: null,
        releaseId: null,
        jobId: null,
        season: null,
        episode: null,
      });
      return Object.freeze({ claimed: true });
    },
    async getSlot(ownerId, agentId, scheduleDate, slotIndex) {
      return slots.get(`${agentId}|${scheduleDate}|${slotIndex}`) ?? null;
    },
    async markSlot(ownerId, agentId, scheduleDate, slotIndex, patch) {
      const key = `${agentId}|${scheduleDate}|${slotIndex}`;
      const row = slots.get(key);
      if (!row) return false;
      Object.assign(row, patch);
      return true;
    },
  };
}

/** In-memory production repository: real rows, no fabrication. */
function makeProduction({ channels = [], releases = [] } = {}) {
  const created = [];
  const releaseRows = [...releases];
  return {
    created,
    releases: releaseRows,
    async listChannels() {
      return channels.map((channel) => ({ ...channel }));
    },
    async getChannel(ownerId, channelId) {
      const channel = channels.find((item) => item.id === channelId);
      return channel ? { ...channel } : null;
    },
    async listReleasesForChannel(ownerId, channelId) {
      return releaseRows.filter((release) => release.channelId === channelId).map((release) => ({ ...release }));
    },
    async createReleaseWithJob(ownerId, { channelId, agentId, title, season, episode, episodeDurationSeconds }) {
      if (releaseRows.some((release) => release.channelId === channelId && release.season === season && release.episode === episode)) {
        return { conflict: true };
      }
      const release = {
        id: `release-${created.length + 1}`,
        channelId,
        season,
        episode,
        status: "planned",
        title,
      };
      releaseRows.push(release);
      const job = {
        id: `job-${created.length + 1}`,
        agentId,
        capability: "episode_production",
        status: "queued",
        payload: { releaseId: release.id, channelId, title, season, episode, episodeDurationSeconds },
      };
      created.push({ release, job });
      return { release, jobId: job.id };
    },
  };
}

function harness({ scheduleEntries, now, channels, releases, lookbackDays, maxConcurrentJobsPerDirector, quotaSnapshotProvider, jobStatuses = [] } = {}) {
  const repository = makeScheduleRepository();
  const production = makeProduction({ channels, releases });
  return {
    repository,
    production,
    run: (overrides = {}) => runDirectorScheduleTick({
      ownerId: "owner-1",
      schedules: scheduleEntries,
      scheduleRepository: repository,
      production,
      listJobStatuses: async () => jobStatuses,
      quotaSnapshotProvider: quotaSnapshotProvider ?? null,
      now,
      lookbackDays,
      maxConcurrentJobsPerDirector,
      dryRun: false,
      ...overrides,
    }),
  };
}

const CHANNEL_JARVIS = Object.freeze({ id: "chan-1", agentId: "agent-01", displayName: "Nightfall Ward" });
const CHANNEL_COSMOS = Object.freeze({ id: "chan-2", agentId: "agent-02", displayName: "Cosmos Files" });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("slot states and reason codes are closed; capacity admission fails honest", () => {
  assert.deepEqual([...SLOT_STATES], ["pending", "queued", "delayed", "blocked", "skipped"]);
  assert.equal(DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR, 3, "the largest offered daily preset fits in one tick");
  assert.equal(countActiveJobs(["queued", "running", "leased", "succeeded", "failed"]), 3);
  assert.equal(countActiveJobs(null), 0);

  assert.deepEqual(evaluateSlotAdmission({ activeJobCount: 0, maxConcurrentJobsPerDirector: 2 }), { admitted: true, reasonCode: null });
  assert.deepEqual(
    evaluateSlotAdmission({ activeJobCount: 2, maxConcurrentJobsPerDirector: 2 }),
    { admitted: false, reasonCode: "CAPACITY_LIMIT_REACHED" },
  );
  assert.deepEqual(
    evaluateSlotAdmission({ activeJobCount: 0, maxConcurrentJobsPerDirector: 2, quotaSnapshot: { state: "EXHAUSTED" } }),
    { admitted: false, reasonCode: "PROVIDER_QUOTA_EXHAUSTED" },
  );
  // UNKNOWN quota is admitted: the executor enforces quota at run time and
  // reports the durable wait truthfully; the scheduler never invents a block.
  assert.equal(
    evaluateSlotAdmission({ activeJobCount: 0, maxConcurrentJobsPerDirector: 2, quotaSnapshot: { state: "UNKNOWN" } }).admitted,
    true,
  );

  assert.deepEqual(nextEpisodeSlot({ releases: [] }), { season: 1, episode: 1 });
  assert.deepEqual(
    nextEpisodeSlot({ releases: [{ season: 1, episode: 4 }, { season: 1, episode: 7 }, { season: 2, episode: 1 }] }),
    { season: 2, episode: 2 },
  );
});

test("the window plan reports due and upcoming slots against the Director's own timezone", () => {
  const plan = planDirectorProductionWindow({
    settings: settings({ episodesPerDay: 2, productionDays: [1] }),
    now: new Date("2026-10-12T06:00:00.000Z"), // 11:30 IST Monday
    lookbackDays: 1,
  });
  assert.equal(plan.localToday, "2026-10-12");
  assert.equal(plan.dueSlots.length, 1, "09:00 IST slot is due; 16:30 IST is not");
  assert.equal(plan.dueSlots[0].localTime, "09:00");
  assert.equal(plan.upcomingSlots.length, 2, "only the daily target's worth of upcoming slots is planned");
  assert.equal(plan.upcomingSlots[0].localTime, "16:30");
  assert.equal(plan.examined.filter((date) => date.past).length, 1, "yesterday is examined for the backlog bound");
  for (const date of plan.examined.filter((entry) => entry.past)) {
    assert.equal(date.dueSlots.length, 0, "a past date is never queued");
  }
});

// ---------------------------------------------------------------------------
// Frequency, production days, custom weekdays
// ---------------------------------------------------------------------------

test("one episode per day creates exactly one planned job with the configured duration", async () => {
  const h = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings() }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-12T04:00:00.000Z"), // 09:30 IST Monday
  });
  const report = await h.run();
  assert.equal(report.totals.created, 1);
  assert.equal(report.totals.delayed, 0);
  assert.equal(h.production.created.length, 1);
  assert.equal(h.production.created[0].job.payload.episodeDurationSeconds, 2400, "configured duration is stamped on the job");
  assert.equal(h.production.created[0].release.season, 1);
  assert.equal(h.production.created[0].release.episode, 1);
  assert.equal(h.production.created[0].job.status, "queued");

  // The tick also records WHY yesterday's untouched slot produced nothing.
  const slot = h.repository.rows.find((row) => row.scheduleDate === "2026-10-12");
  assert.equal(slot.state, "queued");
  assert.equal(slot.scheduleDate, "2026-10-12");
  assert.equal(slot.slotIndex, 0);
  assert.equal(slot.episodeDurationSeconds, 2400);
  assert.equal(slot.releaseId, h.production.created[0].release.id);
});

test("two and three episodes per day create that many DISTINCT eligible slots", async () => {
  // Late in the Director's local production day (19:30 IST on Tuesday): every
  // one of that day's slots is already due.
  const late = new Date("2026-10-13T14:00:00.000Z");

  const two = harness({
    scheduleEntries: [{ agentId: "agent-02", settings: settings(COSMOS_LIKE) }],
    channels: [CHANNEL_COSMOS],
    now: late,
    lookbackDays: 0,
  });
  const twoReport = await two.run();
  assert.equal(twoReport.totals.created, 2);
  assert.deepEqual(two.repository.rows.map((row) => row.slotIndex).sort(), [0, 1], "two distinct slot indexes");
  assert.equal(two.production.created[0].job.payload.episodeDurationSeconds, 1800);
  assert.deepEqual(
    two.production.created.map((entry) => entry.release.episode).sort((a, b) => a - b),
    [1, 2],
  );

  const three = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings({ episodesPerDay: 3 }) }],
    channels: [CHANNEL_JARVIS],
    now: late,
    lookbackDays: 0,
    maxConcurrentJobsPerDirector: 3,
  });
  const threeReport = await three.run();
  assert.equal(threeReport.totals.created, 3);
  assert.deepEqual(three.repository.rows.map((row) => row.slotIndex).sort(), [0, 1, 2]);
  assert.deepEqual(
    three.production.created.map((entry) => entry.release.episode).sort((a, b) => a - b),
    [1, 2, 3],
    "each slot allocates the next episode number",
  );
  assert.equal(new Set(three.production.created.map((entry) => entry.release.id)).size, 3);
});

test("five-day, seven-day and custom weekday schedules are respected", async () => {
  // Saturday 2026-10-17: only the 7-day director is eligible.
  const saturday = new Date("2026-10-17T05:00:00.000Z");
  const sevenDay = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings() }],
    channels: [CHANNEL_JARVIS],
    now: saturday,
    lookbackDays: 0,
  });
  assert.equal((await sevenDay.run()).totals.created, 1);

  const fiveDay = harness({
    scheduleEntries: [{ agentId: "agent-02", settings: settings(COSMOS_LIKE) }],
    channels: [CHANNEL_COSMOS],
    now: saturday,
    lookbackDays: 0,
  });
  const fiveDayReport = await fiveDay.run();
  assert.equal(fiveDayReport.totals.created, 0, "Mon–Fri director does not produce on Saturday");
  assert.equal(fiveDayReport.directors[0].nextEligibleSlot.localDate, "2026-10-19", "next Monday");

  // Custom set [Wednesday, Saturday], 06:30 UTC.
  const custom = harness({
    scheduleEntries: [{ agentId: "agent-03", settings: settings(CUSTOM_LIKE) }],
    channels: [{ id: "chan-3", agentId: "agent-03", displayName: "Custom House" }],
    now: new Date("2026-10-17T07:00:00.000Z"), // Saturday, after 06:30 UTC
    lookbackDays: 0,
  });
  const customReport = await custom.run();
  assert.equal(customReport.totals.created, 1);
  assert.equal(custom.production.created[0].job.payload.episodeDurationSeconds, 3000);
  assert.equal(customReport.directors[0].productionDaysLabel, "Wed, Sat");
});

test("timezone and date boundaries follow the Director, not the server clock", async () => {
  const instant = new Date("2026-10-12T02:00:00.000Z"); // Sun 22:00 in New York, Mon 07:30 in Kolkata

  const kolkata = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings({ productionDays: [1], productionStartTime: "06:00" }) }],
    channels: [CHANNEL_JARVIS],
    now: instant,
    lookbackDays: 0,
  });
  const kolkataReport = await kolkata.run();
  assert.equal(kolkataReport.directors[0].localToday, "2026-10-12");
  assert.equal(kolkataReport.totals.created, 1, "Monday 06:00 IST already passed");

  const newYorkSettings = settings({ timezone: "America/New_York", productionDays: [7], productionStartTime: "09:00" });
  const newYork = harness({
    scheduleEntries: [{ agentId: "agent-02", settings: newYorkSettings }],
    channels: [CHANNEL_COSMOS],
    now: instant,
    lookbackDays: 0,
  });
  const newYorkReport = await newYork.run();
  assert.equal(newYorkReport.directors[0].localToday, "2026-10-11", "still Sunday in New York");
  assert.equal(newYorkReport.totals.created, 1, "Sunday 09:00 EDT = 13:00Z, already past at 02:00Z Monday");

  // Sunday 07:00 local (11:00Z): the same Director's slot is NOT yet due.
  const early = harness({
    scheduleEntries: [{ agentId: "agent-02", settings: newYorkSettings }],
    channels: [CHANNEL_COSMOS],
    now: new Date("2026-10-11T11:00:00.000Z"),
    lookbackDays: 0,
  });
  const earlyReport = await early.run();
  assert.equal(earlyReport.directors[0].localToday, "2026-10-11");
  assert.equal(earlyReport.totals.created, 0);
  assert.equal(earlyReport.directors[0].notYetDue, 1);
  assert.equal(early.production.created.length, 0, "a not-yet-due slot is planned, never queued early");
});

// ---------------------------------------------------------------------------
// Idempotency, capacity, quota, backlog
// ---------------------------------------------------------------------------

test("duplicate scheduler runs never create duplicate jobs or releases", async () => {
  const h = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings() }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-12T04:00:00.000Z"),
  });
  const first = await h.run();
  const second = await h.run();
  const third = await h.run();

  assert.equal(first.totals.created, 1);
  assert.equal(second.totals.created, 0);
  assert.equal(third.totals.created, 0);
  assert.equal(second.totals.duplicates, 2, "both the yesterday-missed row and today's queued row were already recorded");
  assert.equal(h.production.created.length, 1, "exactly one release + job exist after three runs");
  assert.equal(h.repository.rows.length, 2, "one durable slot row per examined date (today + yesterday)");
  assert.equal(h.repository.rows.find((row) => row.scheduleDate === "2026-10-12").state, "queued");

  // A QUEUED slot is never re-created.
  const afterQueued = await h.run();
  assert.equal(afterQueued.totals.created, 0);
  assert.equal(h.production.created.length, 1);
});

test("concurrent scheduling does not exceed the configured per-Director limit", async () => {
  const h = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings({ episodesPerDay: 3 }) }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-13T14:00:00.000Z"), // three due slots
    lookbackDays: 0,
    maxConcurrentJobsPerDirector: 1,
  });
  const report = await h.run();
  assert.equal(report.totals.created, 1, "one active job is admitted");
  assert.equal(report.totals.delayed, 2, "the remaining due slots are delayed, not queued");
  assert.equal(h.production.created.length, 1);
  const delayed = h.repository.rows.filter((row) => row.state === "delayed");
  assert.equal(delayed.length, 2);
  for (const row of delayed) assert.equal(row.reasonCode, "CAPACITY_LIMIT_REACHED");

  // Once capacity frees up, the DELAYED slots are re-attempted in place — the
  // same durable slot, never a duplicate episode (Rule 8).
  const retried = await runDirectorScheduleTick({
    ownerId: "owner-1",
    schedules: [{ agentId: "agent-01", settings: settings({ episodesPerDay: 3 }) }],
    scheduleRepository: h.repository,
    production: h.production,
    listJobStatuses: async () => [], // the earlier job completed
    now: new Date("2026-10-13T14:05:00.000Z"),
    lookbackDays: 0,
    maxConcurrentJobsPerDirector: 3,
  });
  assert.equal(retried.totals.created, 2, "both delayed slots are queued once capacity allows");
  assert.equal(h.production.created.length, 3, "three episodes total — one per durable slot");
  assert.equal(new Set(h.production.created.map((entry) => entry.release.id)).size, 3);

  // An already-loaded queue delays everything honestly.
  const saturated = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings() }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-12T04:00:00.000Z"),
    jobStatuses: ["queued", "running", "leased"],
  });
  const saturatedReport = await saturated.run();
  assert.equal(saturatedReport.totals.created, 0);
  assert.equal(saturatedReport.totals.delayed, 1);
  assert.equal(saturated.production.created.length, 0, "nothing is queued past the limit");
});

test("provider quota exhaustion delays work honestly and fabricates nothing", async () => {
  const h = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings() }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-12T04:00:00.000Z"),
    quotaSnapshotProvider: async () => ({ state: "EXHAUSTED" }),
  });
  const report = await h.run();
  assert.equal(report.totals.created, 0);
  assert.equal(report.totals.delayed, 1);
  assert.equal(h.production.created.length, 0);
  const delayedRow = h.repository.rows.find((row) => row.scheduleDate === "2026-10-12");
  assert.equal(delayedRow.state, "delayed");
  assert.equal(delayedRow.reasonCode, "PROVIDER_QUOTA_EXHAUSTED");
  assert.equal(delayedRow.releaseId, null, "no release is invented while the provider is exhausted");

  // A Director with no channel is BLOCKED (not delayed): a missing dependency
  // is never disguised as a capacity wait.
  const noChannel = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings() }],
    channels: [],
    now: new Date("2026-10-12T04:00:00.000Z"),
  });
  const blockedReport = await noChannel.run();
  assert.equal(blockedReport.totals.blocked, 1);
  const blockedRow = noChannel.repository.rows.find((row) => row.scheduleDate === "2026-10-12");
  assert.equal(blockedRow.state, "blocked");
  assert.equal(blockedRow.reasonCode, "PRODUCTION_UNAVAILABLE");
});

test("missed runs are bounded and recorded as skipped, never as an uncontrolled backlog", async () => {
  const h = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings() }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-15T04:00:00.000Z"), // Thursday; lookback covers only Wednesday
    lookbackDays: 1,
  });
  const report = await h.run();
  assert.equal(report.totals.created, 1, "today's due slot is queued");
  assert.equal(report.totals.skipped, 1, "exactly one missed date is examined and recorded");
  const skipped = h.repository.rows.filter((row) => row.state === "skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].scheduleDate, "2026-10-14");
  assert.equal(skipped[0].reasonCode, "MISSED_SCHEDULE_WINDOW");
  assert.equal(h.production.created.length, 1, "no catch-up episodes are queued for the missed date");

  // A wide lookback still cannot exceed one slot per examined date per run.
  const wide = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings() }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-15T04:00:00.000Z"),
    lookbackDays: 3,
  });
  const wideReport = await wide.run();
  assert.equal(wideReport.totals.skipped, 3);
  assert.equal(wideReport.totals.created, 1);
  assert.equal(wide.production.created.length, 1);

  // An out-of-range lookback is refused (fail closed).
  await assert.rejects(() => h.run({ lookbackDays: 99 }), /SCHEDULE_INPUT_INVALID/);
});

// ---------------------------------------------------------------------------
// Pause, dry run, isolation
// ---------------------------------------------------------------------------

test("pausing a schedule prevents future job creation; resuming restores it", async () => {
  const paused = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings({ scheduleEnabled: false }) }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-12T04:00:00.000Z"),
  });
  const pausedReport = await paused.run();
  assert.equal(pausedReport.totals.pausedDirectors, 1);
  assert.equal(pausedReport.totals.created, 0);
  assert.equal(paused.production.created.length, 0);
  assert.equal(paused.repository.rows.length, 0, "a paused schedule writes NOTHING");
  assert.equal(pausedReport.directors[0].scheduleEnabled, false);
  assert.equal(pausedReport.directors[0].nextEligibleSlot, null);

  const resumed = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings({ scheduleEnabled: true }) }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-12T04:00:00.000Z"),
  });
  assert.equal((await resumed.run()).totals.created, 1);
});

test("a dry run reports the plan and writes nothing", async () => {
  const h = harness({
    scheduleEntries: [{ agentId: "agent-01", settings: settings({ episodesPerDay: 2 }) }],
    channels: [CHANNEL_JARVIS],
    now: new Date("2026-10-13T14:00:00.000Z"), // 19:30 IST Tuesday: both slots due
    lookbackDays: 1,
  });
  const report = await h.run({ dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.totals.created, 2, "the plan reports the two due slots");
  assert.equal(h.production.created.length, 0, "no release is created");
  assert.equal(h.repository.rows.length, 0, "no slot row is written");
});

test("one Director's schedule never leaks into another Director's queue or settings", async () => {
  const repository = makeScheduleRepository();
  const production = makeProduction({ channels: [CHANNEL_JARVIS, CHANNEL_COSMOS] });
  const now = new Date("2026-10-13T14:00:00.000Z");
  const run = (schedules) => runDirectorScheduleTick({
    ownerId: "owner-1",
    schedules,
    scheduleRepository: repository,
    production,
    listJobStatuses: async () => [],
    now,
    lookbackDays: 0,
  });

  const report = await run([
    { agentId: "agent-01", settings: settings({ episodeDurationSeconds: 2400 }) },
    { agentId: "agent-02", settings: settings({ ...COSMOS_LIKE, episodeDurationSeconds: 3000 }) },
  ]);
  // Both Directors are due at 19:30 IST Tuesday: agent-01 one slot, agent-02 two.

  const jarvisJobs = production.created.filter((entry) => entry.job.agentId === "agent-01");
  const cosmosJobs = production.created.filter((entry) => entry.job.agentId === "agent-02");
  assert.equal(jarvisJobs.length, 1);
  assert.equal(cosmosJobs.length, 2);
  for (const entry of jarvisJobs) assert.equal(entry.job.payload.episodeDurationSeconds, 2400);
  for (const entry of cosmosJobs) assert.equal(entry.job.payload.episodeDurationSeconds, 3000);
  assert.equal(new Set(production.created.map((entry) => entry.release.channelId)).size, 2, "each Director keeps its own channel");
  assert.equal(report.directors.length, 2);
  assert.equal(report.directors[0].agentId, "agent-01");
  assert.equal(report.directors[1].agentId, "agent-02");
  for (const row of repository.rows) {
    assert.ok(row.agentId === "agent-01" || row.agentId === "agent-02");
  }

  // Re-running schedules only ONE Director leaves the other Director's rows
  // and jobs exactly as they were.
  const before = production.created.length;
  await run([{ agentId: "agent-01", settings: settings({ episodeDurationSeconds: 2400 }) }]);
  assert.equal(production.created.length, before);
});

// ---------------------------------------------------------------------------
// Observability counters
// ---------------------------------------------------------------------------

test("schedule summaries report planned slots and real counters — never planned-as-completed", () => {
  const summary = summarizeDirectorSchedule({
    agentId: "agent-01",
    settings: settings({ episodesPerDay: 2, scheduleEnabled: true }),
    now: new Date("2026-10-12T06:00:00.000Z"),
    slotCounts: { queued: 3, delayed: 1, blocked: 2, skipped: 4, pending: 0, total: 10 },
    jobStatuses: ["queued", "running", "succeeded"],
    releases: [
      { status: "review" },
      { status: "review" },
      { status: "published" },
      { status: "planned" },
    ],
  });
  assert.equal(summary.scheduleEnabled, true);
  assert.equal(summary.episodeDurationSeconds, 2400);
  assert.equal(summary.episodesPerDay, 2);
  assert.equal(summary.slots.queued, 3);
  assert.equal(summary.slots.delayed, 1);
  assert.equal(summary.slots.total, 10);
  assert.equal(summary.activeJobCount, 2, "only queued/leased/running count as active");
  assert.equal(summary.completedReleases, 3, "review + published are completed production");
  assert.equal(summary.awaitingOwnerApproval, 2);
  assert.equal(summary.publishedReleases, 1);
  assert.equal(summary.todayPlannedSlots.length, 2);
  assert.ok(summary.nextEligibleSlot.startsAt);

  const paused = summarizeDirectorSchedule({ agentId: "agent-01", settings: settings({ scheduleEnabled: false }) });
  assert.equal(paused.nextEligibleSlot, null);
});
