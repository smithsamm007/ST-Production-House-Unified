/**
 * ST Production House — timezone-correct reporting schedule (Day 4 / D6).
 *
 * Durable scheduling is decided from database time; this module only converts
 * between that instant and the configured local wall clock. It uses the
 * runtime's own IANA database through Intl, so Asia/Kolkata (UTC+05:30, no
 * DST) and any other zone resolve without a new dependency.
 *
 * Every function is pure and unit-testable.
 */

export const DEFAULT_REPORT_TIMEZONE = "Asia/Kolkata";
export const DEFAULT_LOCAL_HOUR = 8;
export const DEFAULT_LOCAL_MINUTE = 0;
export const DEFAULT_MISSED_RUN_POLICY = "RUN_ONCE_ON_RECOVERY";
export const MISSED_RUN_POLICIES = Object.freeze(["RUN_ONCE_ON_RECOVERY", "SKIP"]);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length < 3 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(timeZone) {
  if (!isValidTimeZone(timeZone)) {
    const error = new Error("REPORT_TIMEZONE_INVALID");
    error.code = "REPORT_TIMEZONE_INVALID";
    throw error;
  }
  return timeZone;
}

function partsOf(date, timeZone) {
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
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some ICU builds emit 24 for midnight; normalize to 0.
    hour: parts.hour === "24" ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

function offsetMs(date, timeZone) {
  const parts = partsOf(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function parseDateString(dateString) {
  const match = DATE_RE.exec(String(dateString));
  if (!match) {
    const error = new Error("REPORT_DATE_INVALID");
    error.code = "REPORT_DATE_INVALID";
    throw error;
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function formatDateString({ year, month, day }) {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDateString(date, timeZone = DEFAULT_REPORT_TIMEZONE) {
  const parts = partsOf(new Date(date), assertTimeZone(timeZone));
  return formatDateString(parts);
}

/** Local wall-clock parts of an instant in a zone. */
export function localDateTimeParts(date, timeZone = DEFAULT_REPORT_TIMEZONE) {
  const parts = partsOf(new Date(date), assertTimeZone(timeZone));
  return { ...parts, dateString: formatDateString(parts) };
}

/** Add whole days to a local calendar date without timezone drift. */
export function addLocalDays(dateString, days) {
  const { year, month, day } = parseDateString(dateString);
  const shifted = new Date(Date.UTC(year, month - 1, day + Number(days), 12, 0, 0));
  return formatDateString({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/** Convert a local wall-clock date/time in a zone to its UTC instant. */
export function zonedDateTimeToUtc({
  dateString,
  hour = 0,
  minute = 0,
  timeZone = DEFAULT_REPORT_TIMEZONE,
}) {
  assertTimeZone(timeZone);
  const { year, month, day } = parseDateString(dateString);
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes settle the offset for zones that change offset near the guess.
  let instant = guess - offsetMs(new Date(guess), timeZone);
  instant = guess - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/**
 * Next occurrence of the configured local time strictly AFTER `from`.
 * Handles a non-existent local time (DST spring-forward) by stepping to the
 * next day until the local hour/minute matches.
 */
export function nextRunAt({
  from = new Date(),
  timeZone = DEFAULT_REPORT_TIMEZONE,
  hour = DEFAULT_LOCAL_HOUR,
  minute = DEFAULT_LOCAL_MINUTE,
} = {}) {
  assertTimeZone(timeZone);
  const fromDate = new Date(from);
  if (Number.isNaN(fromDate.getTime())) {
    const error = new Error("REPORT_CLOCK_INVALID");
    error.code = "REPORT_CLOCK_INVALID";
    throw error;
  }
  let dateString = localDateString(fromDate, timeZone);
  for (let step = 0; step < 4; step += 1) {
    const candidate = zonedDateTimeToUtc({ dateString, hour, minute, timeZone });
    const candidateParts = partsOf(candidate, timeZone);
    if (candidate.getTime() > fromDate.getTime() && candidateParts.hour === hour && candidateParts.minute === minute) {
      return candidate;
    }
    dateString = addLocalDays(dateString, 1);
  }
  throw new Error("REPORT_SCHEDULE_UNRESOLVABLE");
}

/** Half-open UTC reporting window for one local reporting date. */
export function windowForReportDate({ reportDate, timeZone = DEFAULT_REPORT_TIMEZONE }) {
  assertTimeZone(timeZone);
  const start = zonedDateTimeToUtc({ dateString: reportDate, hour: 0, minute: 0, timeZone });
  const end = zonedDateTimeToUtc({
    dateString: addLocalDays(reportDate, 1),
    hour: 0,
    minute: 0,
    timeZone,
  });
  return { windowStart: start, windowEnd: end };
}

/** True when the durable next-run instant is at or before the database clock. */
export function isScheduleDue({ nextRunAt: nextRun, now = new Date() }) {
  if (!nextRun) return false;
  const next = new Date(nextRun);
  if (Number.isNaN(next.getTime())) return false;
  return next.getTime() <= new Date(now).getTime();
}

/**
 * Reporting date of a due run: the LOCAL date on which the run was scheduled,
 * not the date the process eventually woke up.
 */
export function reportDateForScheduledRun({ nextRunAt: nextRun, timeZone = DEFAULT_REPORT_TIMEZONE }) {
  return localDateString(new Date(nextRun), timeZone);
}
