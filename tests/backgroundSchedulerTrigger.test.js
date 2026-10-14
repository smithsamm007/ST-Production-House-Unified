/**
 * Tests for the durable background scheduler trigger (sql/029):
 *   - `src/scheduling/backgroundSchedulerTrigger.js`
 *   - the `listAllEnabledScheduleRecords` read added to the schedule repository
 *
 * Everything below runs OFFLINE: no database, no providers, no network. The
 * cross-owner tick drives the REAL `runDirectorScheduleTick` through injected
 * repository/production stubs, so the same idempotent claim semantics the
 * owner route uses are what the background trigger exercises.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createBackgroundSchedulerTrigger,
  parseSchedulerIntervalMinutes,
  runAllDirectorScheduleTicks,
  DEFAULT_SCHEDULER_INTERVAL_MINUTES,
  SCHEDULE_TRIGGER_ENABLED_ENV,
} from "../src/scheduling/backgroundSchedulerTrigger.js";
import {
  BACKGROUND_TICK_AUDIT_EVENTS,
} from "../src/scheduling/backgroundSchedulerTrigger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-05T10:30:00Z"); // Monday 10:30 UTC — 09:00 slot is due.
const SCHEDULE = Object.freeze({
  episodeDurationSeconds: 2400,
  episodesPerDay: 1,
  productionDays: [1, 2, 3, 4, 5, 6, 7],
  productionStartTime: "09:00",
  timezone: "UTC",
  scheduleEnabled: true,
});

function record(ownerId, agentId, { invalid = false, enabled = true } = {}) {
  return {
    ownerId,
    agentId,
    settings: invalid ? null : { ...SCHEDULE, scheduleEnabled: enabled },
    invalid,
    invalidReason: invalid ? "SCHEDULE_DURATION_INVALID" : null,
    row: {},
  };
}

/** Real-shaped repository stub keyed by (owner, agent) so isolation is provable. */
function stubRepository(options = {}) {
  const { claimed = true, failOnOwner = null } = options;
  const calls = { claims: [], marks: [] };
  const repo = {
    async claimSlot(input) {
      calls.claims.push({ ...input });
      if (failOnOwner && input.ownerId === failOnOwner) {
        throw Object.assign(new Error("STORAGE_FAILED"), { code: "STORAGE_FAILED" });
      }
      return { claimed };
    },
    async getSlot() {
      return null;
    },
    async markSlot(ownerId, agentId, scheduleDate, slotIndex, update) {
      calls.marks.push({ ownerId, agentId, scheduleDate, slotIndex, ...update });
    },
  };
  return { repo, calls };
}

function stubProduction(owners) {
  const calls = { releases: [] };
  return {
    calls,
    async listChannels(ownerId) {
      const owner = owners.find((o) => o.ownerId === ownerId);
      return owner ? owner.channels : [];
    },
    async getChannel(ownerId, channelId) {
      const owner = owners.find((o) => o.ownerId === ownerId);
      const channel = owner?.channels.find((c) => c.id === channelId);
      return channel ?? null;
    },
    async listReleasesForChannel(ownerId, channelId, { limit } = {}) {
      calls.releases.push({ ownerId, channelId, limit });
      return [];
    },
    async createReleaseWithJob(ownerId, payload) {
      calls.releases.push({ ownerId, ...payload, created: true });
      return { release: { id: `release-${calls.releases.length}` }, jobId: `job-${calls.releases.length}`, conflict: false };
    },
  };
}

const TWO_OWNERS = [
  { ownerId: "owner-A", agentId: "agent-01", channels: [{ id: "ch-A", agentId: "agent-01", displayName: "Alpha" }] },
  { ownerId: "owner-B", agentId: "agent-02", channels: [{ id: "ch-B", agentId: "agent-02", displayName: "Beta" }] },
];

// ---------------------------------------------------------------------------
// parseSchedulerIntervalMinutes — pure, fail-safe default
// ---------------------------------------------------------------------------

test("interval parser accepts bounded integers and parses strings", () => {
  assert.equal(parseSchedulerIntervalMinutes("15"), 15);
  assert.equal(parseSchedulerIntervalMinutes("42"), 42);
  assert.equal(parseSchedulerIntervalMinutes("1440"), 1440);
  assert.equal(parseSchedulerIntervalMinutes(undefined), DEFAULT_SCHEDULER_INTERVAL_MINUTES);
});

test("interval parser falls back on every invalid input (no NaN, no zero)", () => {
  for (const bad of ["abc", "", "0", "-5", "1441", "3.5", null, {}, "3600"]) {
    assert.equal(parseSchedulerIntervalMinutes(bad), DEFAULT_SCHEDULER_INTERVAL_MINUTES, `fallback for ${String(bad)}`);
  }
  assert.equal(parseSchedulerIntervalMinutes("0", 7), 7);
  assert.equal(parseSchedulerIntervalMinutes("9999", 7), 7);
});

// ---------------------------------------------------------------------------
// createBackgroundSchedulerTrigger — fail-closed construction
// ---------------------------------------------------------------------------

test("trigger construction fails closed without a tick or a sane interval", () => {
  assert.throws(() => createBackgroundSchedulerTrigger({ intervalMinutes: 15 }), /SCHEDULER_TRIGGER_TICK_REQUIRED/);
  assert.throws(() => createBackgroundSchedulerTrigger({ tick: async () => ({}), intervalMinutes: 0 }), /SCHEDULER_TRIGGER_INTERVAL_INVALID/);
  assert.throws(() => createBackgroundSchedulerTrigger({ tick: async () => ({}), intervalMinutes: 5000 }), /SCHEDULER_TRIGGER_INTERVAL_INVALID/);
});

test("trigger start/stop drives the injected timer exactly once per interval", async () => {
  const timers = { created: [], cleared: [] };
  const timer = {
    setIntervalFn(fn, ms) {
      timers.created.push({ fn, ms });
      return { unref() {} };
    },
    clearIntervalFn(h) {
      timers.cleared.push(h);
    },
  };
  let runs = 0;
  const trigger = createBackgroundSchedulerTrigger({
    tick: async () => {
      runs += 1;
      return { totals: { created: 1 }, ownersTouched: 1, invalidSchedules: 0 };
    },
    intervalMinutes: 20,
    runOnStart: false,
    timer,
  });

  const started = trigger.start();
  assert.equal(started.started, true);
  assert.equal(started.intervalMinutes, 20);
  assert.equal(timers.created.length, 1);
  assert.equal(timers.created[0].ms, 20 * 60_000, "interval is converted to milliseconds");
  assert.equal(runs, 0, "runOnStart=false does not tick immediately");

  const outcome = await timers.created[0].fn();
  assert.equal(runs, 1);
  assert.equal(outcome.created, 1);
  const status = trigger.status();
  assert.equal(status.completedCount, 1);
  assert.equal(status.startedCount, 1);
  assert.ok(status.lastRunStartedAt && status.lastRunFinishedAt, "run accounting is recorded");
  assert.equal(status.running, false);

  trigger.stop();
  assert.equal(trigger.status().stopped, true);
  assert.equal(timers.cleared.length, 1, "the interval is cleared on stop");
  // Re-starts are allowed but never double-schedule: one and only one interval.
  trigger.start();
  assert.equal(timers.created.length, 1, "start() after start() does not add a second timer");
  assert.equal(trigger.status().started, true);
});

test("a failing tick is counted, never thrown out of the timer", async () => {
  const timers = { created: [] };
  const timer = {
    setIntervalFn(fn) {
      timers.created.push(fn);
      return { unref() {} };
    },
    clearIntervalFn() {},
  };
  const trigger = createBackgroundSchedulerTrigger({
    tick: async () => {
      throw Object.assign(new Error("boom"), { code: "SCHEDULE_TRIGGER_TICK_FAILED" });
    },
    intervalMinutes: 5,
    runOnStart: false,
    timer,
  });
  trigger.start();
  await timers.created[0]();
  const status = trigger.status();
  assert.equal(status.failedCount, 1);
  assert.equal(status.completedCount, 0);
  assert.equal(status.lastError, "SCHEDULE_TRIGGER_TICK_FAILED");
  assert.equal(status.lastOutcome, null);
});

test("an overlapping tick is skipped and counted, never double-run", async () => {
  let releaseTick;
  const gate = new Promise((resolve) => { releaseTick = resolve; });
  let invocations = 0;
  const trigger = createBackgroundSchedulerTrigger({
    tick: async () => {
      invocations += 1;
      await gate;
      return { totals: { created: invocations } };
    },
    intervalMinutes: 5,
    runOnStart: false,
    timer: { setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {} },
  });
  trigger.start();

  const first = trigger.runNow();
  const second = await trigger.runNow();
  assert.equal(second, null, "a tick while one is running returns null without running");
  assert.equal(trigger.status().skippedOverlappingCount, 1);

  releaseTick();
  await first;
  assert.equal(trigger.status().completedCount, 1);
  assert.equal(trigger.status().lastOutcome.created, 1);
});

// ---------------------------------------------------------------------------
// runAllDirectorScheduleTicks — cross-owner orchestration through the REAL tick
// ---------------------------------------------------------------------------

test("one durable tick claims due slots for every owner, scoped per owner", async () => {
  const { repo, calls } = stubRepository();
  const production = stubProduction(TWO_OWNERS);
  const audit = [];
  const jobStatusCalls = [];
  const rows = [record(TWO_OWNERS[0].ownerId, "agent-01"), record(TWO_OWNERS[1].ownerId, "agent-02")];

  const report = await runAllDirectorScheduleTicks({
    rowsProvider: async () => rows,
    scheduleRepository: () => repo,
    productionRepository: production,
    listJobStatuses: async (ownerId, agentId) => {
      jobStatusCalls.push({ ownerId, agentId });
      return [];
    },
    recordAuditEvent: async (ownerId, event, payload) => audit.push({ ownerId, event, payload }),
    now: NOW,
  });

  assert.equal(report.totals.owners, 2);
  assert.equal(report.totals.created, 2, "each owner's due slot queued exactly once");
  assert.equal(report.totals.ownerFailures, 0);
  assert.deepEqual(report.invalidSchedules, []);
  assert.equal(report.schemaVersion, "background_schedule_tick_v1");

  // Production writes are per-owner releases.
  assert.equal(production.calls.releases.filter((r) => r.created).length, 2);
  assert.ok(production.calls.releases.filter((r) => r.created).every((r) => r.episodeDurationSeconds === 2400),
    "the Director's configured episode duration reaches the queued job");

  // The job-status lookup is called with the owning owner, not a stale one.
  assert.deepEqual(jobStatusCalls.map((c) => c.ownerId).sort(), ["owner-A", "owner-B"]);
  assert.deepEqual(jobStatusCalls.map((c) => c.agentId).sort(), ["agent-01", "agent-02"]);

  // With the default lookback of 1 the tick also EXAMINES yesterday's
  // eligible-but-unfilled slot and durably marks it skipped
  // (MISSED_SCHEDULE_WINDOW) — bounded catch-up, never an extra episode.
  const today = (c) => c.scheduleDate === "2026-01-05";
  const yesterday = (c) => c.scheduleDate === "2026-01-04";
  assert.deepEqual(
    calls.claims.filter(today).map((c) => `${c.ownerId}:${c.agentId}`).sort(),
    ["owner-A:agent-01", "owner-B:agent-02"],
  );
  assert.deepEqual(
    calls.marks.filter(today).map((m) => `${m.ownerId}:${m.agentId}`).sort(),
    ["owner-A:agent-01", "owner-B:agent-02"],
  );
  // Only the OWNER's current local day is queued; past days are skipped.
  assert.equal(
    calls.marks.filter(yesterday).length, 2,
    "yesterday's unfilled slots are durably marked skipped for each Director",
  );
  assert.ok(calls.marks.filter(yesterday).every((m) => m.reasonCode === "MISSED_SCHEDULE_WINDOW" && m.state === "skipped"));

  // Audit: one queued event + one tick event per owner, addressed to that owner.
  assert.equal(audit.filter((a) => a.event === BACKGROUND_TICK_AUDIT_EVENTS.queuedEvent).length, 2);
  assert.equal(audit.filter((a) => a.event === BACKGROUND_TICK_AUDIT_EVENTS.tickEvent).length, 2);
  assert.deepEqual(
    audit.filter((a) => a.event === BACKGROUND_TICK_AUDIT_EVENTS.queuedEvent)
      .map((a) => `${a.ownerId}:${a.payload.agentId}`).sort(),
    ["owner-A:agent-01", "owner-B:agent-02"],
  );
  const queued = audit.find((a) => a.event === BACKGROUND_TICK_AUDIT_EVENTS.queuedEvent && a.ownerId === "owner-A");
  assert.equal(queued.payload.agentId, "agent-01");
  assert.equal(queued.payload.season, 1);
  assert.equal(queued.payload.episode, 1);
});

test("invalid and paused rows never schedule anything", async () => {
  const { repo, calls } = stubRepository();
  const report = await runAllDirectorScheduleTicks({
    rowsProvider: async () => [
      record("owner-A", "agent-01", { invalid: true }),
      record("owner-A", "agent-02", { enabled: false }),
    ],
    scheduleRepository: () => repo,
    productionRepository: stubProduction([]),
    now: NOW,
  });
  assert.deepEqual(report.invalidSchedules, ["agent-01"]);
  assert.equal(report.ownersTouched, 1, "only the owner with a valid row is touched");
  assert.equal(report.totals.pausedDirectors, 1, "a paused Director is counted, never queued");
  assert.equal(report.totals.created, 0);
  assert.equal(calls.claims.length, 0);
});

test("one owner failing storage does not stop the other owners", async () => {
  const { repo } = stubRepository({ failOnOwner: "owner-B" });
  const report = await runAllDirectorScheduleTicks({
    rowsProvider: async () => [record("owner-A", "agent-01"), record("owner-B", "agent-02")],
    scheduleRepository: () => repo,
    productionRepository: stubProduction(TWO_OWNERS),
    now: NOW,
  });
  assert.equal(report.totals.ownerFailures, 1);
  assert.equal(report.totals.created, 1, "owner-A still queued its due slot");
  assert.equal(report.ownerReports.find((r) => r.ownerId === "owner-B").ownershipFailureCode, "STORAGE_FAILED");
});

test("an already-claimed slot is a counted duplicate, never a second episode", async () => {
  const { repo } = stubRepository({ claimed: false });
  const report = await runAllDirectorScheduleTicks({
    rowsProvider: async () => [record("owner-A", "agent-01")],
    scheduleRepository: () => repo,
    productionRepository: stubProduction([TWO_OWNERS[0]]),
    now: NOW,
  });
  assert.equal(report.totals.created, 0);
  // Lookback day + today's slot are BOTH idempotent re-reads of a claimed slot.
  assert.equal(report.totals.duplicates, 2);
});

test("without a db or rowsProvider the tick fails closed with a stable code", async () => {
  await assert.rejects(() => runAllDirectorScheduleTicks({}), /STORAGE_NOT_CONFIGURED/);
});

// ---------------------------------------------------------------------------
// Repository read used by the default (db-backed) path — behaviour contract
// ---------------------------------------------------------------------------

test("listAllEnabledScheduleRecords filters on schedule_enabled and keeps the owner on each record", async () => {
  const rows = [
    { owner_id: "owner-A", agent_id: "agent-01", schedule_enabled: true, episode_duration_seconds: 2400, episodes_per_day: 1, production_days: "1,2", production_start_time: "09:00", timezone: "UTC" },
    { owner_id: "owner-A", agent_id: "agent-02", schedule_enabled: false, episode_duration_seconds: 2400, episodes_per_day: 1, production_days: "1,2", production_start_time: "09:00", timezone: "UTC" },
  ];
  const { DirectorScheduleRepository } = await import("../src/catalog/scheduleRepository.js");
  // The stub emulates the SQL's WHERE schedule_enabled = TRUE, exactly as the
  // real statement does (the repository does not re-filter in JS on purpose).
  const repo = new DirectorScheduleRepository({
    query: async () => ({ rows: rows.filter((r) => r.schedule_enabled === true) }),
  });
  const records = await repo.listAllEnabledScheduleRecords();
  assert.equal(records.length, 1, "disabled rows are never scheduled");
  assert.equal(records[0].ownerId, "owner-A");
  assert.equal(records[0].agentId, "agent-01");
  assert.equal(records[0].settings.timezone, "UTC");

  const repoInvalid = new DirectorScheduleRepository({
    query: async () => ({ rows: [{ ...rows[0], production_days: "not,valid" }] }),
  });
  const bad = await repoInvalid.listAllEnabledScheduleRecords();
  assert.equal(bad[0].invalid, true);
  assert.equal(bad[0].settings, null);
});

// ---------------------------------------------------------------------------
// Env gate contract — the trigger stays OFF unless the operator opts in
// ---------------------------------------------------------------------------

test("the env gate name is stable so deployments cannot drift", () => {
  assert.equal(SCHEDULE_TRIGGER_ENABLED_ENV, "STPH_ENABLE_SCHEDULE_TRIGGER");
});
