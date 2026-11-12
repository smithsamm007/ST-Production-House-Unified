/**
 * ST Production House — the ONE canonical JARVIS planning duration (Issue #262).
 *
 * WHY THIS EXISTS:
 *   The JARVIS deterministic chain validated `targetMinutes` as "25–30" in
 *   eight separate modules while the production pipeline planned 30 / 40 / 50
 *   minutes (1800 / 2400 / 3000 s, `src/scheduling/directorSchedule.js`). A
 *   40- or 50-minute package could not be planned at all, and a 27-minute plan
 *   was accepted even though no QC gate would ever measure it. Two duration
 *   contracts for one program length is a defect, not a preference.
 *
 * CONTRACT (fail-closed):
 *   - The selectable set is EXACTLY the Director episode-duration options; the
 *     list is derived from that module so the two can never drift again.
 *   - `assertJarvisTargetMinutes` throws the caller's stable error code for any
 *     value outside the closed set. Nothing is rounded, widened, or guessed.
 *   - Minutes are the owner-facing unit; seconds are the planning unit. Both
 *     helpers exist so callers never hand-roll `* 60`.
 *
 * This module is pure: no clock, no I/O, no provider.
 */

import {
  EPISODE_DURATION_OPTIONS_SECONDS,
  EPISODE_DURATION_MINUTES,
} from "../scheduling/directorSchedule.js";

/** Allowed planning targets in SECONDS (1800 / 2400 / 3000). */
export const JARVIS_TARGET_DURATIONS_SECONDS = Object.freeze([
  ...EPISODE_DURATION_OPTIONS_SECONDS,
]);

/** Allowed planning targets in MINUTES (30 / 40 / 50). */
export const JARVIS_TARGET_DURATIONS_MINUTES = Object.freeze([
  ...JARVIS_TARGET_DURATIONS_SECONDS.map((seconds) => seconds / 60),
]);

/** True when `value` is one of the closed set of planning targets (minutes). */
export function isJarvisTargetMinutes(value) {
  return Number.isInteger(value) && JARVIS_TARGET_DURATIONS_MINUTES.includes(value);
}

/** True when `value` is one of the closed set of planning targets (seconds). */
export function isJarvisTargetSeconds(value) {
  return Number.isInteger(value) && JARVIS_TARGET_DURATIONS_SECONDS.includes(value);
}

/**
 * Assert a minutes value against the closed set, throwing `code` when it is
 * not a canonical target. Callers keep their own stable error code so existing
 * failure surfaces stay unchanged.
 */
export function assertJarvisTargetMinutes(value, code) {
  if (!isJarvisTargetMinutes(value)) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return value;
}

/** Minutes → planning seconds for a canonical target (never for anything else). */
export function jarvisTargetSeconds(minutes, code = "JARVIS_TARGET_DURATION_INVALID") {
  assertJarvisTargetMinutes(minutes, code);
  return minutes * 60;
}

/** Owner-facing label for a canonical target, mirroring the schedule module. */
export function jarvisTargetLabel(minutes) {
  if (!isJarvisTargetMinutes(minutes)) return null;
  return EPISODE_DURATION_MINUTES[minutes * 60] === minutes ? `${minutes} minutes` : null;
}
