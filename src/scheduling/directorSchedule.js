/**
 * ST Production House — per-Director episode & production schedule contract.
 *
 * Owner master prompt: "PER-DIRECTOR EPISODE DURATION & DAILY PRODUCTION
 * SCHEDULER". This module is the PURE, deterministic contract layer:
 *
 *   - the allowed episode durations (30 / 40 / 50 minutes → 1800 / 2400 /
 *     3000 seconds) and the default for a newly created Director (40 min);
 *   - the daily episode target (1, 2, 3, or a custom positive integer within
 *     a validated safe limit) — always treated as a SCHEDULING TARGET, never
 *     as a guarantee that the system can render that many episodes;
 *   - production days (every day, five days per week, or a custom weekday
 *     set), a preferred start time, and an IANA timezone;
 *   - an explicit enable/pause flag;
 *   - fail-closed validation with stable error codes, and the DST-aware
 *     conversion of (local date + local start time + timezone) → real UTC
 *     instants.
 *
 * Honesty and safety (AGENTS.md Rules 1–3, 15, 17):
 *   - No clock reads except the explicitly injected `now`; no I/O; no
 *     provider access. Identical input always yields identical output.
 *   - Saving or enabling a schedule is INTENT only. Nothing in this module
 *     queues, runs, or publishes anything — no publishing path exists here,
 *     and the owner-approval gate (Rule 7) is untouched.
 *   - Internal agent names never appear: the schedule DTO is an explicit
 *     allowlist of scheduling fields.
 *   - Timezone handling is DST-correct: local times are interpreted in the
 *     Director's own zone, so a 09:00 start stays 09:00 local across a
 *     daylight-saving transition (the UTC instant moves, the local wall clock
 *     does not). A local time that does not exist (spring-forward gap) is
 *     resolved to the instant the zone maps it to and flagged as adjusted —
 *     never silently shifted to an unrelated hour.
 */

export const DIRECTOR_SCHEDULE_VERSION = "director_schedule_v1";

/** Episode durations the owner may select, in SECONDS. Closed set. */
export const EPISODE_DURATION_OPTIONS_SECONDS = Object.freeze([1800, 2400, 3000]);

/** Seconds → the owner-facing minutes label (30 / 40 / 50). */
export const EPISODE_DURATION_MINUTES = Object.freeze({
  1800: 30,
  2400: 40,
  3000: 50,
});

/** Default for newly created Directors: 40 minutes (owner master prompt §2A). */
export const DEFAULT_EPISODE_DURATION_SECONDS = 2400;

/** Daily episode targets offered in the UI (a custom integer is also valid). */
export const EPISODES_PER_DAY_OPTIONS = Object.freeze([1, 2, 3]);

/**
 * Validated safe limit for a custom daily target. The limit exists so a
 * mis-typed value cannot ask the queue for unbounded work: the roster is
 * bounded, and the scheduler admits each slot against real capacity anyway.
 */
export const EPISODES_PER_DAY_SAFE_LIMIT = 6;

export const DEFAULT_EPISODES_PER_DAY = 1;

/** ISO weekdays, 1 = Monday … 7 = Sunday. */
export const ISO_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

export const WEEKDAY_LABELS = Object.freeze({
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
});

/** Named presets the owner can pick; a custom set is stored the same way. */
export const PRODUCTION_DAY_PRESETS = Object.freeze({
  every_day: Object.freeze([1, 2, 3, 4, 5, 6, 7]),
  five_days_per_week: Object.freeze([1, 2, 3, 4, 5]),
});

export const DEFAULT_PRODUCTION_DAYS = PRODUCTION_DAY_PRESETS.every_day;
export const DEFAULT_PRODUCTION_START_TIME = "09:00";
/** Fallback timezone, used only when the owner configured none (project convention). */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";
/**
 * A schedule is persisted DISABLED by default: creating or editing a Director
 * must never start production or publishing as a side effect (master prompt
 * §2E). Enabling is an explicit owner act.
 */
export const DEFAULT_SCHEDULE_ENABLED = false;

/** How far ahead the "next eligible slot" search may look (bounded). */
export const NEXT_SLOT_HORIZON_DAYS = 21;

const TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
// Region/City (Asia/Kolkata) or a single-segment zone (UTC). The real gate is
// `Intl.DateTimeFormat`, which rejects anything the runtime cannot resolve.
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINUTES_PER_DAY = 24 * 60;

export const SCHEDULE_ERROR_CODES = Object.freeze([
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

function scheduleError(code) {
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

/** True when the string names a timezone the runtime can actually resolve. */
export function isKnownTimezone(timezone) {
  if (typeof timezone !== "string" || !TIMEZONE_PATTERN.test(timezone) || timezone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** True when the value is one of the three owner-selectable durations. */
export function isSelectableEpisodeDuration(seconds) {
  return Number.isInteger(seconds) && EPISODE_DURATION_OPTIONS_SECONDS.includes(seconds);
}

/** Owner-facing label for a duration, e.g. "40 minutes". */
export function episodeDurationLabel(seconds) {
  const minutes = EPISODE_DURATION_MINUTES[seconds];
  return typeof minutes === "number" ? `${minutes} minutes` : null;
}

/**
 * Normalize an episodes-per-day value. Accepts a number or a numeric string
 * (the dashboard sends the raw form value) and enforces the safe limit.
 */
function normalizeEpisodesPerDay(raw) {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (!Number.isInteger(value) || value < 1 || value > EPISODES_PER_DAY_SAFE_LIMIT) {
    throw scheduleError("SCHEDULE_EPISODES_PER_DAY_INVALID");
  }
  return value;
}

/** Normalize a duration value (seconds). Minutes shorthand is NOT accepted. */
function normalizeEpisodeDuration(raw) {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (!isSelectableEpisodeDuration(value)) throw scheduleError("SCHEDULE_DURATION_INVALID");
  return value;
}

/**
 * Normalize the production-day list: accepts ISO weekday numbers or the
 * three-letter tokens (mon..sun). Returns a sorted, duplicate-free array.
 */
export function normalizeProductionDays(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ISO_WEEKDAYS.length) {
    throw scheduleError("SCHEDULE_PRODUCTION_DAYS_INVALID");
  }
  const days = new Set();
  for (const entry of raw) {
    let day = null;
    if (Number.isInteger(entry)) {
      day = entry;
    } else if (typeof entry === "string") {
      const trimmed = entry.trim().toLowerCase();
      if (/^[1-7]$/.test(trimmed)) {
        day = Number(trimmed);
      } else {
        const index = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(trimmed.slice(0, 3));
        if (index !== -1) day = index + 1;
      }
    }
    if (!Number.isInteger(day) || !ISO_WEEKDAYS.includes(day)) {
      throw scheduleError("SCHEDULE_PRODUCTION_DAYS_INVALID");
    }
    days.add(day);
  }
  if (days.size === 0) throw scheduleError("SCHEDULE_PRODUCTION_DAYS_INVALID");
  return Object.freeze([...days].sort((a, b) => a - b));
}

/** Parse the stored compact form ('1,2,3,4,5') back into weekday numbers. */
export function parseProductionDays(stored) {
  if (typeof stored !== "string" || stored.trim() === "") {
    throw scheduleError("SCHEDULE_PRODUCTION_DAYS_INVALID");
  }
  return normalizeProductionDays(stored.split(",").map((part) => part.trim()));
}

/** Serialize weekday numbers into the stored compact form ('1,2,3,4,5'). */
export function serializeProductionDays(days) {
  return normalizeProductionDays(days).join(",");
}

/** Validate a local start time ('HH:MM', 24-hour clock). */
export function normalizeProductionStartTime(raw) {
  if (typeof raw !== "string" || !TIME_PATTERN.test(raw.trim())) {
    throw scheduleError("SCHEDULE_START_TIME_INVALID");
  }
  return raw.trim();
}

function normalizeTimezone(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TIMEZONE;
  if (typeof raw !== "string" || !isKnownTimezone(raw.trim())) {
    throw scheduleError("SCHEDULE_TIMEZONE_INVALID");
  }
  return raw.trim();
}

/**
 * Validate one Director schedule submission end to end.
 *
 * Accepts the owner-facing payload (partial updates allowed: omitted fields
 * fall back to the documented defaults/new-Director values) and returns the
 * frozen, normalized settings the repository persists. Unknown fields fail
 * closed — a schedule is configuration, so surprises must throw.
 *
 * Stable codes: SCHEDULE_INPUT_INVALID, SCHEDULE_FIELD_UNKNOWN,
 * SCHEDULE_DURATION_INVALID, SCHEDULE_EPISODES_PER_DAY_INVALID,
 * SCHEDULE_PRODUCTION_DAYS_INVALID, SCHEDULE_START_TIME_INVALID,
 * SCHEDULE_TIMEZONE_INVALID, SCHEDULE_ENABLED_INVALID.
 */
export function validateDirectorScheduleInput(input, base = null) {
  if (!isPlainObject(input)) throw scheduleError("SCHEDULE_INPUT_INVALID");
  const allowed = [
    "episodeDurationSeconds",
    "episodeDurationMinutes",
    "episodesPerDay",
    "productionDays",
    "productionStartTime",
    "timezone",
    "scheduleEnabled",
  ];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw scheduleError("SCHEDULE_FIELD_UNKNOWN");
  }

  const fallback = isPlainObject(base) ? base : null;

  let episodeDurationSeconds;
  if (input.episodeDurationSeconds !== undefined && input.episodeDurationSeconds !== null) {
    episodeDurationSeconds = normalizeEpisodeDuration(input.episodeDurationSeconds);
  } else if (input.episodeDurationMinutes !== undefined && input.episodeDurationMinutes !== null) {
    const minutes = Number(input.episodeDurationMinutes);
    const match = EPISODE_DURATION_OPTIONS_SECONDS.find((seconds) => EPISODE_DURATION_MINUTES[seconds] === minutes);
    if (match === undefined) throw scheduleError("SCHEDULE_DURATION_INVALID");
    episodeDurationSeconds = match;
  } else {
    episodeDurationSeconds = fallback?.episodeDurationSeconds ?? DEFAULT_EPISODE_DURATION_SECONDS;
  }

  const episodesPerDay = input.episodesPerDay === undefined || input.episodesPerDay === null
    ? fallback?.episodesPerDay ?? DEFAULT_EPISODES_PER_DAY
    : normalizeEpisodesPerDay(input.episodesPerDay);

  const productionDays = input.productionDays === undefined || input.productionDays === null
    ? (() => {
        if (fallback?.productionDays === undefined || fallback?.productionDays === null) {
          return DEFAULT_PRODUCTION_DAYS;
        }
        return Array.isArray(fallback.productionDays)
          ? normalizeProductionDays(fallback.productionDays)
          : parseProductionDays(fallback.productionDays);
      })()
    : normalizeProductionDays(input.productionDays);

  const productionStartTime = input.productionStartTime === undefined || input.productionStartTime === null
    ? fallback?.productionStartTime ?? DEFAULT_PRODUCTION_START_TIME
    : normalizeProductionStartTime(input.productionStartTime);

  const timezone = input.timezone === undefined || input.timezone === null
    ? normalizeTimezone(fallback?.timezone ?? DEFAULT_TIMEZONE)
    : normalizeTimezone(input.timezone);

  let scheduleEnabled;
  if (input.scheduleEnabled === undefined || input.scheduleEnabled === null) {
    scheduleEnabled = typeof fallback?.scheduleEnabled === "boolean"
      ? fallback.scheduleEnabled
      : DEFAULT_SCHEDULE_ENABLED;
  } else if (typeof input.scheduleEnabled === "boolean") {
    scheduleEnabled = input.scheduleEnabled;
  } else if (input.scheduleEnabled === "true" || input.scheduleEnabled === "false") {
    scheduleEnabled = input.scheduleEnabled === "true";
  } else {
    throw scheduleError("SCHEDULE_ENABLED_INVALID");
  }

  return deepFreeze({
    episodeDurationSeconds,
    episodesPerDay,
    productionDays,
    productionStartTime,
    timezone,
    scheduleEnabled,
  });
}

/**
 * The safe-DTO projection of one persisted `director_schedules` row
 * (Rules 15/17: explicit allowlist — no internal agent names, no free text).
 * A row that fails validation is surfaced as `invalid: true` with a stable
 * reason instead of being silently repaired (the DB CHECK is the real gate).
 */
export function directorScheduleDto(row) {
  if (!isPlainObject(row)) throw scheduleError("SCHEDULE_INPUT_INVALID");
  const settings = {
    episodeDurationSeconds: row.episode_duration_seconds,
    episodesPerDay: row.episodes_per_day,
    productionDays: row.production_days,
    productionStartTime: row.production_start_time,
    timezone: row.timezone,
    scheduleEnabled: row.schedule_enabled === true,
  };
  let normalized = null;
  let invalidReason = null;
  try {
    normalized = validateDirectorScheduleInput({
      episodeDurationSeconds: Number(settings.episodeDurationSeconds),
      episodesPerDay: Number(settings.episodesPerDay),
      productionDays: parseProductionDays(String(settings.productionDays)),
      productionStartTime: String(settings.productionStartTime),
      timezone: String(settings.timezone),
      scheduleEnabled: settings.scheduleEnabled,
    });
  } catch (err) {
    invalidReason = err?.code ?? "SCHEDULE_INPUT_INVALID";
  }
  return Object.freeze({
    agentId: row.agent_id,
    configured: true,
    invalid: normalized === null,
    invalidReason,
    episodeDurationSeconds: normalized?.episodeDurationSeconds ?? null,
    episodeDurationMinutes: normalized
      ? EPISODE_DURATION_MINUTES[normalized.episodeDurationSeconds] ?? null
      : null,
    episodesPerDay: normalized?.episodesPerDay ?? null,
    productionDays: normalized ? [...normalized.productionDays] : [],
    productionDaysLabel: normalized ? describeProductionDays(normalized.productionDays) : null,
    productionStartTime: normalized?.productionStartTime ?? null,
    timezone: normalized?.timezone ?? null,
    scheduleEnabled: normalized?.scheduleEnabled ?? false,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

/** The unpersisted default schedule for a Director that has none yet. */
export function defaultDirectorScheduleDto(agentId) {
  const settings = validateDirectorScheduleInput({});
  return Object.freeze({
    agentId,
    configured: false,
    invalid: false,
    invalidReason: null,
    episodeDurationSeconds: settings.episodeDurationSeconds,
    episodeDurationMinutes: EPISODE_DURATION_MINUTES[settings.episodeDurationSeconds],
    episodesPerDay: settings.episodesPerDay,
    productionDays: [...settings.productionDays],
    productionDaysLabel: describeProductionDays(settings.productionDays),
    productionStartTime: settings.productionStartTime,
    timezone: settings.timezone,
    scheduleEnabled: settings.scheduleEnabled,
    createdAt: null,
    updatedAt: null,
  });
}

/** Human-readable production-day summary ("Every day", "Mon–Fri", custom). */
export function describeProductionDays(days) {
  const normalized = Array.isArray(days) ? days : parseProductionDays(String(days));
  if (normalized.length === 7) return "Every day";
  if (normalized.join(",") === PRODUCTION_DAY_PRESETS.five_days_per_week.join(",")) return "Monday–Friday";
  if (normalized.join(",") === "6,7") return "Weekends";
  return normalized.map((day) => WEEKDAY_LABELS[day].slice(0, 3)).join(", ");
}

// ---------------------------------------------------------------------------
// Timezone-aware slot arithmetic (DST-correct, no library, no I/O)
// ---------------------------------------------------------------------------

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** The wall-clock parts a timezone shows for an instant. */
export function zonedParts(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const { type, value } of formatter.formatToParts(instant)) {
    if (["year", "month", "day", "hour", "minute", "second"].includes(type)) {
      parts[type] = Number.parseInt(value, 10);
    }
  }
  // `hour12: false` can render midnight as 24 in some ICU versions.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

/** 'YYYY-MM-DD' as seen in `timezone` at `instant`. */
export function localDateString(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** The ISO weekday (1 = Monday … 7 = Sunday) of a 'YYYY-MM-DD' date. */
export function weekdayOfDate(dateString) {
  assertDateString(dateString);
  const [year, month, day] = dateString.split("-").map((value) => Number.parseInt(value, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  const isoWeekday = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  return isoWeekday;
}

function assertDateString(dateString) {
  if (typeof dateString !== "string" || !DATE_PATTERN.test(dateString)) {
    throw scheduleError("SCHEDULE_DATE_INVALID");
  }
  const [year, month, day] = dateString.split("-").map((value) => Number.parseInt(value, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw scheduleError("SCHEDULE_DATE_INVALID");
  }
}

/** 'YYYY-MM-DD' shifted by `days` (pure calendar arithmetic, UTC-based). */
export function addDaysToDate(dateString, days) {
  assertDateString(dateString);
  const [year, month, day] = dateString.split("-").map((value) => Number.parseInt(value, 10));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Resolve (local date, local time, timezone) to the REAL UTC instant.
 *
 * The offset is discovered by fixing the point against the zone's own
 * rendering of it (three bounded correction rounds), so the result is correct
 * across daylight-saving transitions: 09:00 local is 09:00 local before AND
 * after a transition, and the UTC instant moves accordingly.
 *
 * A local time that does not exist (spring-forward gap) cannot be represented:
 * the zone maps it to the instant it becomes valid, and `dstAdjusted` reports
 * that honestly instead of pretending the requested wall clock existed.
 */
export function resolveLocalStartInstant({ dateString, timeString, timeZone }) {
  assertDateString(dateString);
  const time = normalizeProductionStartTime(timeString);
  if (!isKnownTimezone(timeZone)) throw scheduleError("SCHEDULE_TIMEZONE_INVALID");
  const [hours, minutes] = time.split(":").map((value) => Number.parseInt(value, 10));
  const [year, month, day] = dateString.split("-").map((value) => Number.parseInt(value, 10));
  const requestedWallClockMs = Date.UTC(year, month - 1, day, hours, minutes, 0);

  let instantMs = requestedWallClockMs;
  for (let round = 0; round < 3; round += 1) {
    const parts = zonedParts(new Date(instantMs), timeZone);
    const renderedAsUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const correction = requestedWallClockMs - renderedAsUtcMs;
    if (correction === 0) break;
    instantMs += correction;
  }

  const finalParts = zonedParts(new Date(instantMs), timeZone);
  const finalWallClockMinutes = finalParts.hour * 60 + finalParts.minute;
  const requestedWallClockMinutes = hours * 60 + minutes;
  return Object.freeze({
    instant: new Date(instantMs),
    iso: new Date(instantMs).toISOString(),
    localDate: localDateString(new Date(instantMs), timeZone),
    localTime: `${String(finalParts.hour).padStart(2, "0")}:${String(finalParts.minute).padStart(2, "0")}`,
    dstAdjusted: finalWallClockMinutes !== requestedWallClockMinutes,
  });
}

/**
 * Which date a due instant belongs to, in the Director's own zone. The
 * scheduler decides "today" from the zone, never from the host clock's zone,
 * so a Director in America/New_York does not lose a day to the server's UTC
 * boundary.
 */
export function directorLocalDate(instant, timeZone) {
  return localDateString(instant, timeZone);
}

/**
 * The daily slot plan for one local date. Slot N starts at
 * `productionStartTime + N × slotSpacingMinutes`, where the spacing is the
 * remaining production-day time divided evenly across the daily target
 * (capped at 8 h, floored at 1 minute). Every slot therefore starts inside
 * the Director's own local day, so a 2- or 3-episode day really does become
 * due on that day instead of spilling past midnight and being reported as
 * missed.
 *
 * Pure: same settings + date ⇒ identical instants.
 */
export function planDailySlots({ settings, dateString }) {
  const normalized = validateDirectorScheduleInput(settings);
  assertDateString(dateString);
  if (!normalized.productionDays.includes(weekdayOfDate(dateString))) {
    return Object.freeze([]);
  }
  const [startHour, startMinute] = normalized.productionStartTime.split(":").map((value) => Number.parseInt(value, 10));
  const baseMinutes = startHour * 60 + startMinute;
  const remainingMinutes = MINUTES_PER_DAY - baseMinutes;
  const spacingMinutes = Math.max(1, Math.min(480, Math.floor(remainingMinutes / normalized.episodesPerDay)));

  const slots = [];
  for (let index = 0; index < normalized.episodesPerDay; index += 1) {
    const offsetMinutes = index * spacingMinutes;
    // A slot whose start falls past midnight carries into the NEXT local date
    // but stays part of THIS production date's plan (slotIndex is scoped to
    // the plan date), so an N-episode day really yields N distinct slots and
    // never silently drops a slot the owner asked for.
    const slotDate = addDaysToDate(dateString, Math.floor((baseMinutes + offsetMinutes) / MINUTES_PER_DAY));
    const minutesIntoDay = (baseMinutes + offsetMinutes) % MINUTES_PER_DAY;
    const timeString = `${String(Math.floor(minutesIntoDay / 60)).padStart(2, "0")}:${String(minutesIntoDay % 60).padStart(2, "0")}`;
    const resolved = resolveLocalStartInstant({ dateString: slotDate, timeString, timeZone: normalized.timezone });
    slots.push(Object.freeze({
      slotIndex: index,
      localDate: slotDate,
      localTime: timeString,
      startsAt: resolved.iso,
      dstAdjusted: resolved.dstAdjusted,
      episodeDurationSeconds: normalized.episodeDurationSeconds,
    }));
  }
  return Object.freeze(slots);
}

/**
 * The next eligible production slot at or after `now`, searching a bounded
 * horizon. Returns null when the Director's schedule is paused or every
 * configured weekday lies beyond the horizon — never an invented date.
 */
export function nextEligibleSlot({ settings, now = new Date(), horizonDays = NEXT_SLOT_HORIZON_DAYS }) {
  const normalized = validateDirectorScheduleInput(settings);
  if (!normalized.scheduleEnabled) return null;
  const today = directorLocalDate(now, normalized.timezone);
  for (let offset = 0; offset <= Math.max(0, horizonDays); offset += 1) {
    const dateString = addDaysToDate(today, offset);
    for (const slot of planDailySlots({ settings: normalized, dateString })) {
      if (new Date(slot.startsAt).getTime() >= now.getTime()) return slot;
    }
  }
  return null;
}

/** The next local date (today included) matching the Director's production days. */
export function nextProductionDate({ settings, now = new Date(), horizonDays = NEXT_SLOT_HORIZON_DAYS }) {
  const normalized = validateDirectorScheduleInput(settings);
  const today = directorLocalDate(now, normalized.timezone);
  for (let offset = 0; offset <= Math.max(0, horizonDays); offset += 1) {
    const dateString = addDaysToDate(today, offset);
    if (normalized.productionDays.includes(weekdayOfDate(dateString))) return dateString;
  }
  return null;
}

export default {
  validateDirectorScheduleInput,
  nextEligibleSlot,
  planDailySlots,
  directorScheduleDto,
};
