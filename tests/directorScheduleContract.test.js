/**
 * Per-Director episode duration & production schedule — contract tests.
 *
 * Proves the PURE, deterministic contract offline (no DB, no network, no
 * clock except injected instants): defaults for a new Director, the three
 * selectable durations, the validated daily-target limit, production-day
 * presets and custom weekday sets, start-time/timezone validation, fail-closed
 * rejection of invalid values, and DST-correct resolution of local start times
 * to real UTC instants.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EPISODE_DURATION_SECONDS,
  DEFAULT_EPISODES_PER_DAY,
  DEFAULT_PRODUCTION_DAYS,
  DEFAULT_PRODUCTION_START_TIME,
  DEFAULT_SCHEDULE_ENABLED,
  DEFAULT_TIMEZONE,
  EPISODE_DURATION_MINUTES,
  EPISODE_DURATION_OPTIONS_SECONDS,
  EPISODES_PER_DAY_SAFE_LIMIT,
  PRODUCTION_DAY_PRESETS,
  addDaysToDate,
  defaultDirectorScheduleDto,
  describeProductionDays,
  directorLocalDate,
  directorScheduleDto,
  episodeDurationLabel,
  isKnownTimezone,
  nextEligibleSlot,
  nextProductionDate,
  normalizeProductionDays,
  parseProductionDays,
  planDailySlots,
  resolveLocalStartInstant,
  serializeProductionDays,
  validateDirectorScheduleInput,
  weekdayOfDate,
} from "../src/scheduling/directorSchedule.js";

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

/** Owner-facing defaults every new Director starts from. */
const DEFAULTS = Object.freeze({
  episodeDurationSeconds: 2400,
  episodesPerDay: 1,
  productionDays: [1, 2, 3, 4, 5, 6, 7],
  productionStartTime: "09:00",
  timezone: KOLKATA,
  scheduleEnabled: false,
});

function settings(overrides = {}) {
  return validateDirectorScheduleInput({ ...DEFAULTS, ...overrides });
}

// ---------------------------------------------------------------------------
// Defaults and allowed values
// ---------------------------------------------------------------------------

test("new-Director defaults are the documented ones (40 min, 1/day, every day, 09:00, Asia/Kolkata, paused)", () => {
  assert.equal(DEFAULT_EPISODE_DURATION_SECONDS, 2400);
  assert.equal(DEFAULT_EPISODES_PER_DAY, 1);
  assert.deepEqual([...DEFAULT_PRODUCTION_DAYS], [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(DEFAULT_PRODUCTION_START_TIME, "09:00");
  assert.equal(DEFAULT_TIMEZONE, "Asia/Kolkata");
  assert.equal(DEFAULT_SCHEDULE_ENABLED, false, "a new schedule is persisted PAUSED (never starts production)");

  const normalized = validateDirectorScheduleInput({});
  assert.deepEqual(normalized, DEFAULTS);

  const dto = defaultDirectorScheduleDto("agent-07");
  assert.equal(dto.configured, false);
  assert.equal(dto.episodeDurationSeconds, 2400);
  assert.equal(dto.episodeDurationMinutes, 40);
  assert.equal(dto.productionDaysLabel, "Every day");
  assert.equal(dto.scheduleEnabled, false);
});

test("duration accepts exactly 30, 40 and 50 minutes (and minutes shorthand maps to seconds)", () => {
  assert.deepEqual([...EPISODE_DURATION_OPTIONS_SECONDS], [1800, 2400, 3000]);
  assert.equal(EPISODE_DURATION_MINUTES[1800], 30);
  assert.equal(EPISODE_DURATION_MINUTES[2400], 40);
  assert.equal(EPISODE_DURATION_MINUTES[3000], 50);
  assert.equal(episodeDurationLabel(3000), "50 minutes");

  for (const [minutes, seconds] of [[30, 1800], [40, 2400], [50, 3000]]) {
    assert.equal(validateDirectorScheduleInput({ episodeDurationMinutes: minutes }).episodeDurationSeconds, seconds);
    assert.equal(validateDirectorScheduleInput({ episodeDurationSeconds: seconds }).episodeDurationSeconds, seconds);
    assert.equal(validateDirectorScheduleInput({ episodeDurationSeconds: String(seconds) }).episodeDurationSeconds, seconds);
  }
});

test("invalid durations and unknown fields are rejected with stable codes", () => {
  for (const bad of [1234, 0, -1800, 1890, 3600, 1.5, null, undefined, "forty", NaN, Infinity]) {
    if (bad === null || bad === undefined) {
      // omitted values fall back to the default rather than throwing
      assert.equal(validateDirectorScheduleInput({ episodeDurationSeconds: bad }).episodeDurationSeconds, 2400);
      continue;
    }
    assert.throws(
      () => validateDirectorScheduleInput({ episodeDurationSeconds: bad }),
      (err) => err.code === "SCHEDULE_DURATION_INVALID",
      `duration ${String(bad)} must be rejected`,
    );
  }
  assert.throws(() => validateDirectorScheduleInput({ episodeDurationMinutes: 45 }), (err) => err.code === "SCHEDULE_DURATION_INVALID");
  assert.throws(() => validateDirectorScheduleInput({ durationSeconds: 2400 }), (err) => err.code === "SCHEDULE_FIELD_UNKNOWN");
  assert.throws(() => validateDirectorScheduleInput(null), (err) => err.code === "SCHEDULE_INPUT_INVALID");
  assert.throws(() => validateDirectorScheduleInput({ scheduleEnabled: "yes" }), (err) => err.code === "SCHEDULE_ENABLED_INVALID");
});

test("daily frequency accepts 1, 2, 3 and custom integers up to the validated safe limit", () => {
  for (const count of [1, 2, 3, 4, 5, 6]) {
    assert.equal(validateDirectorScheduleInput({ episodesPerDay: count }).episodesPerDay, count);
    assert.equal(validateDirectorScheduleInput({ episodesPerDay: String(count) }).episodesPerDay, count);
  }
  assert.equal(EPISODES_PER_DAY_SAFE_LIMIT, 6);
  for (const bad of [0, -1, 7, 100, 1.5, "many", null]) {
    if (bad === null) {
      assert.equal(validateDirectorScheduleInput({ episodesPerDay: bad }).episodesPerDay, 1);
      continue;
    }
    assert.throws(
      () => validateDirectorScheduleInput({ episodesPerDay: bad }),
      (err) => err.code === "SCHEDULE_EPISODES_PER_DAY_INVALID",
      `episodes/day ${String(bad)} must be rejected`,
    );
  }
});

test("production days accept presets and custom weekday sets (numbers or tokens)", () => {
  assert.deepEqual([...PRODUCTION_DAY_PRESETS.every_day], [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...PRODUCTION_DAY_PRESETS.five_days_per_week], [1, 2, 3, 4, 5]);

  const custom = normalizeProductionDays([1, 3, 5]);
  assert.deepEqual([...custom], [1, 3, 5]);
  assert.equal(serializeProductionDays(custom), "1,3,5");
  assert.deepEqual([...parseProductionDays("1,3,5")], [1, 3, 5]);
  assert.deepEqual([...normalizeProductionDays(["mon", "WED", "fri"])], [1, 3, 5]);
  assert.deepEqual([...normalizeProductionDays([7, 6, 6])], [6, 7], "duplicates collapse, order is canonical");

  assert.equal(describeProductionDays([1, 2, 3, 4, 5, 6, 7]), "Every day");
  assert.equal(describeProductionDays([1, 2, 3, 4, 5]), "Monday–Friday");
  assert.equal(describeProductionDays([1, 3]), "Mon, Wed");

  for (const bad of [[], [0], [8], [1, 1, 1, 1, 1, 1, 1, 1], ["someday"], "1,2", [1.5]]) {
    assert.throws(
      () => normalizeProductionDays(bad),
      (err) => err.code === "SCHEDULE_PRODUCTION_DAYS_INVALID",
      `production days ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("start time, timezone and pause flag are validated fail-closed", () => {
  assert.equal(validateDirectorScheduleInput({ productionStartTime: "23:59" }).productionStartTime, "23:59");
  assert.equal(validateDirectorScheduleInput({ productionStartTime: "00:00" }).productionStartTime, "00:00");
  // Surrounding whitespace from a form field is trimmed, never accepted as part
  // of the stored value.
  assert.equal(validateDirectorScheduleInput({ productionStartTime: " 09:00 " }).productionStartTime, "09:00");
  for (const bad of ["24:00", "9:00", "09:60", "09", "morning", "", "09:00:00"]) {
    assert.throws(
      () => validateDirectorScheduleInput({ productionStartTime: bad }),
      (err) => err.code === "SCHEDULE_START_TIME_INVALID",
      `start time ${JSON.stringify(bad)} must be rejected`,
    );
  }

  assert.equal(isKnownTimezone("Asia/Kolkata"), true);
  assert.equal(isKnownTimezone("America/New_York"), true);
  assert.equal(isKnownTimezone("UTC"), true, "the single-segment zone is real and resolvable");
  assert.equal(isKnownTimezone("Not/AZone"), false, "Intl is the authoritative gate");
  assert.equal(isKnownTimezone("Kolkata"), false);
  assert.equal(isKnownTimezone(""), false);
  for (const bad of ["Kolkata", "Asia/Kolkata/extra/deep", "Mars/Olympus", 42]) {
    assert.throws(
      () => validateDirectorScheduleInput({ timezone: bad }),
      (err) => err.code === "SCHEDULE_TIMEZONE_INVALID",
      `timezone ${JSON.stringify(bad)} must be rejected`,
    );
  }
  // An omitted timezone falls back to the documented default.
  assert.equal(validateDirectorScheduleInput({ timezone: null }).timezone, "Asia/Kolkata");

  assert.equal(validateDirectorScheduleInput({ scheduleEnabled: true }).scheduleEnabled, true);
  assert.equal(validateDirectorScheduleInput({ scheduleEnabled: false }).scheduleEnabled, false);
  assert.throws(() => validateDirectorScheduleInput({ scheduleEnabled: 1 }), (err) => err.code === "SCHEDULE_ENABLED_INVALID");
});

test("settings round-trip through the persisted row shape (safe DTO, no agent names)", () => {
  const row = {
    agent_id: "agent-11",
    episode_duration_seconds: 1800,
    episodes_per_day: 2,
    production_days: "1,2,3,4,5",
    production_start_time: "06:15",
    timezone: NEW_YORK,
    schedule_enabled: true,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
  };
  const dto = directorScheduleDto(row);
  assert.deepEqual(Object.keys(dto).sort(), [
    "agentId", "configured", "createdAt", "episodeDurationMinutes", "episodeDurationSeconds",
    "episodesPerDay", "invalid", "invalidReason", "productionDays", "productionDaysLabel",
    "productionStartTime", "scheduleEnabled", "timezone", "updatedAt",
  ]);
  assert.equal(dto.agentId, "agent-11");
  assert.equal(dto.episodeDurationSeconds, 1800);
  assert.equal(dto.episodeDurationMinutes, 30);
  assert.equal(dto.configured, true);
  assert.equal(dto.invalid, false);
  assert.equal(dto.productionDaysLabel, "Monday–Friday");
  assert.equal(dto.scheduleEnabled, true);

  // A corrupted row is surfaced as invalid instead of being silently repaired.
  const broken = directorScheduleDto({ ...row, episode_duration_seconds: 1234 });
  assert.equal(broken.invalid, true);
  assert.equal(broken.invalidReason, "SCHEDULE_DURATION_INVALID");
  assert.equal(broken.episodeDurationSeconds, null);
});

// ---------------------------------------------------------------------------
// Timezone / DST arithmetic
// ---------------------------------------------------------------------------

test("local dates and weekdays are computed in the Director's own timezone", () => {
  assert.equal(weekdayOfDate("2026-10-12"), 1, "2026-10-12 is a Monday");
  assert.equal(weekdayOfDate("2026-10-11"), 7, "2026-10-11 is a Sunday");
  assert.equal(addDaysToDate("2026-10-31", 1), "2026-11-01");
  assert.equal(addDaysToDate("2026-01-01", -1), "2025-12-31");

  // 2026-10-12T02:00Z is still 2026-10-11 in New York (UTC-4) but already
  // 2026-10-12 in Kolkata (UTC+5:30) — the date boundary follows the Director.
  const instant = new Date("2026-10-12T02:00:00.000Z");
  assert.equal(directorLocalDate(instant, NEW_YORK), "2026-10-11");
  assert.equal(directorLocalDate(instant, KOLKATA), "2026-10-12");
});

test("DST: 09:00 local stays 09:00 local while the UTC instant moves", () => {
  const summer = resolveLocalStartInstant({ dateString: "2026-06-10", timeString: "09:00", timeZone: NEW_YORK });
  const winter = resolveLocalStartInstant({ dateString: "2026-01-14", timeString: "09:00", timeZone: NEW_YORK });
  assert.equal(summer.iso, "2026-06-10T13:00:00.000Z", "EDT (UTC-4)");
  assert.equal(winter.iso, "2026-01-14T14:00:00.000Z", "EST (UTC-5)");
  assert.equal(summer.localTime, "09:00");
  assert.equal(winter.localTime, "09:00");
  assert.equal(summer.dstAdjusted, false);
  assert.equal(winter.dstAdjusted, false);

  // Kolkata has no DST: the instant is stable year round.
  const kolkata = resolveLocalStartInstant({ dateString: "2026-06-10", timeString: "09:00", timeZone: KOLKATA });
  assert.equal(kolkata.iso, "2026-06-10T03:30:00.000Z");
});

test("DST: a non-existent local time (spring-forward gap) is reported as adjusted, never silently wrong", () => {
  // US DST 2026 begins 2026-03-08 at 02:00 local: 02:30 does not exist.
  const gap = resolveLocalStartInstant({ dateString: "2026-03-08", timeString: "02:30", timeZone: NEW_YORK });
  assert.equal(gap.dstAdjusted, true);
  assert.equal(gap.localTime, "03:30", "the zone maps the requested time forward by the offset shift");
  assert.ok(new Date(gap.iso).getTime() > Date.parse("2026-03-08T06:00:00Z"));

  // The autumn fold (2026-11-01 01:30 happens twice) still resolves to 01:30 local.
  const fold = resolveLocalStartInstant({ dateString: "2026-11-01", timeString: "01:30", timeZone: NEW_YORK });
  assert.equal(fold.localTime, "01:30");
  assert.equal(fold.dstAdjusted, false);
});

test("daily slots are deterministic, spaced inside the production day, and honour the weekday set", () => {
  const weekly = settings({ episodesPerDay: 3, productionDays: [1, 2, 3, 4, 5], productionStartTime: "09:00" });
  const monday = planDailySlots({ settings: weekly, dateString: "2026-10-12" });
  assert.equal(monday.length, 3, "three distinct slots for a 3-episode day");
  assert.deepEqual(monday.map((slot) => slot.localTime), ["09:00", "14:00", "19:00"]);
  assert.deepEqual(monday.map((slot) => slot.slotIndex), [0, 1, 2]);
  assert.deepEqual(monday.map((slot) => slot.localDate), ["2026-10-12", "2026-10-12", "2026-10-12"]);
  // Every slot of the daily target starts inside the Director's own local day.
  for (const slot of monday) assert.ok(slot.localTime >= "09:00" && slot.localTime <= "23:59");

  const two = planDailySlots({ settings: settings({ episodesPerDay: 2, productionDays: [1] }), dateString: "2026-10-12" });
  assert.deepEqual(two.map((slot) => slot.localTime), ["09:00", "16:30"]);
  const six = planDailySlots({
    settings: settings({ episodesPerDay: 6, productionDays: [1], productionStartTime: "00:00" }),
    dateString: "2026-10-12",
  });
  assert.equal(six.length, 6);
  assert.deepEqual(six.map((slot) => slot.localTime), ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"]);
  assert.deepEqual(monday.map((slot) => slot.episodeDurationSeconds), [2400, 2400, 2400]);
  assert.equal(planDailySlots({ settings: weekly, dateString: "2026-10-11" }).length, 0, "Sunday is not a production day");

  const again = planDailySlots({ settings: weekly, dateString: "2026-10-12" });
  assert.deepEqual(again, monday, "identical settings + date ⇒ identical slots");

  const single = planDailySlots({
    settings: settings({ episodesPerDay: 1, productionDays: [7] }),
    dateString: "2026-10-11",
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].localTime, "09:00");
});

test("next eligible slot / next production date respect the pause flag, weekday set and timezone", () => {
  const now = new Date("2026-10-12T04:00:00.000Z"); // 09:30 IST on Monday
  const paused = settings({ productionDays: [1], scheduleEnabled: false });
  assert.equal(nextEligibleSlot({ settings: paused, now }), null);

  const running = settings({ productionDays: [1], scheduleEnabled: true });
  const next = nextEligibleSlot({ settings: running, now });
  assert.equal(next.startsAt, "2026-10-19T03:30:00.000Z", "next Monday 09:00 IST (today's slot already passed)");
  assert.equal(next.slotIndex, 0);

  const fridayOnly = settings({ productionDays: [5], scheduleEnabled: true });
  assert.equal(nextEligibleSlot({ settings: fridayOnly, now }).localDate, "2026-10-16");
  assert.equal(nextProductionDate({ settings: fridayOnly, now }), "2026-10-16");
  assert.equal(nextProductionDate({ settings: settings({ productionDays: [1], timezone: NEW_YORK }), now }), "2026-10-12");
});
