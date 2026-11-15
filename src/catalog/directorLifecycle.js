/**
 * ST Production House — Director lifecycle vocabulary.
 *
 * sql/032 owns ONE authoritative lifecycle enum (`active | retired | suspended`).
 * This module adds no second status system: it derives the four business states
 * the product needs from that single column, so every caller agrees on what a
 * stored row means.
 *
 *   pending   -> suspended + suspended_note = PENDING_OWNER_ACTIVATION
 *                (seeded, never activated; Owner approval required)
 *   active    -> may originate new work
 *   suspended -> temporarily paused by an operator (blocked)
 *   retired   -> permanently retired (blocked)
 *
 * `pending` exists as a separate state because "seeded but not yet approved" and
 * "approved but paused" are different business situations with different
 * recovery paths, even though both block new work.
 */

export const DIRECTOR_LIFECYCLE = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  RETIRED: "retired",
});

/** Marker written by migration 034 for Directors awaiting Owner activation. */
export const PENDING_ACTIVATION_NOTE = "PENDING_OWNER_ACTIVATION";

/**
 * Valid transitions. Everything else is rejected, so a caller cannot move a
 * retired Director straight to active without an explicit reactivation decision,
 * and cannot express an unknown state at all.
 */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["active", "retired"]),
  active: Object.freeze(["suspended", "retired"]),
  suspended: Object.freeze(["active", "retired"]),
  retired: Object.freeze(["active"]),
});

function invalid(code, message) {
  // The code is always part of the message, so a thrown lifecycle error is
  // diagnosable from logs that only capture `message`.
  const error = new Error(message ? `${code}: ${message}` : code);
  error.code = code;
  return error;
}

/**
 * Derive the business lifecycle state of a canonical mapping row.
 *
 * @param {{status?: string, suspended_note?: string|null}} mapping
 * @returns {"pending"|"active"|"suspended"|"retired"}
 */
export function lifecycleStateOf(mapping) {
  if (!mapping || typeof mapping !== "object") {
    throw invalid("DIRECTOR_LIFECYCLE_ROW_INVALID", "lifecycle state requires a canonical mapping row");
  }
  const status = mapping.status;
  if (status === "active") return DIRECTOR_LIFECYCLE.ACTIVE;
  if (status === "retired") return DIRECTOR_LIFECYCLE.RETIRED;
  if (status === "suspended") {
    // The repository maps rows to camelCase (`suspendedNote`); accept both so a
    // raw SQL row and a repository row resolve to the same lifecycle state.
    const note = mapping.suspended_note ?? mapping.suspendedNote ?? null;
    return note === PENDING_ACTIVATION_NOTE
      ? DIRECTOR_LIFECYCLE.PENDING
      : DIRECTOR_LIFECYCLE.SUSPENDED;
  }
  throw invalid("DIRECTOR_LIFECYCLE_STATUS_UNKNOWN", `unknown canonical Director status: ${String(status)}`);
}

/** Only an active Director may originate new work. */
export function canOriginateWork(mapping) {
  return lifecycleStateOf(mapping) === DIRECTOR_LIFECYCLE.ACTIVE;
}

/**
 * The stable error for a blocked Director, distinguishing "waiting for the Owner"
 * from "paused" and "retired" so HERMES and the dashboard can say something true.
 */
export function blockedWorkError(mapping) {
  const state = lifecycleStateOf(mapping);
  if (state === DIRECTOR_LIFECYCLE.ACTIVE) return null;
  const code = state === DIRECTOR_LIFECYCLE.PENDING
    ? "CANONICAL_DIRECTOR_PENDING_ACTIVATION"
    : "CANONICAL_DIRECTOR_NOT_ACTIVE";
  return invalid(code, `Director lifecycle is "${state}": new work is refused`);
}

/** Throw unless `from -> to` is a documented transition. */
export function assertLifecycleTransition(from, to) {
  const allowed = LIFECYCLE_TRANSITIONS[from];
  if (!allowed) throw invalid("DIRECTOR_LIFECYCLE_STATE_INVALID", `unknown lifecycle state: ${String(from)}`);
  if (!allowed.includes(to)) {
    throw invalid("DIRECTOR_LIFECYCLE_TRANSITION_REJECTED", `lifecycle transition ${from} -> ${to} is not allowed`);
  }
  return true;
}
