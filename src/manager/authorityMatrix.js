/**
 * ST Production House — Hermes manager authority matrix.
 *
 * Issue #166: Hermes is the ST MANAGER layer between the Owner and the
 * Directors. It holds DECISION AUTHORITY, never unrestricted access:
 *
 *   OWNER (ultimate authority)
 *     └── HERMES (manager: decides, coordinates, prioritizes)
 *           └── DIRECTORS (independent content units, up to 50)
 *                 └── WORKERS / PROVIDERS (execution layer)
 *
 * The matrix below is the ONLY authority surface. It is frozen, closed, and
 * fail-closed: an action that is not explicitly listed is refused — the
 * manager can never discover a new power at runtime.
 *
 * Authority classes:
 *   AUTONOMOUS             — Hermes decides and executes within owner-defined
 *                            limits (quotas, schedules, per-agent policies).
 *   OWNER_POLICY_CONTROLLED — Hermes may PROPOSE; execution requires an
 *                            explicit, unexpired owner approval/decision
 *                            reference (Rules 7/8/9). The owner's standing
 *                            policy, not Hermes, is the authority here.
 *   PROHIBITED             — structurally refused. Never executable by
 *                            Hermes, with or without approval (Rules 4/5/6,
 *                            15, 17; append-only evidence).
 *
 * The manager NEVER sees secret values. It addresses credentials by
 * REFERENCE ("JARVIS / Gemini / production"); the credential broker resolves
 * the reference and supplies the credential directly to the authorized
 * adapter (Rules 4/5/17).
 */

export const AUTHORITY_AUTONOMOUS = "AUTONOMOUS";
export const AUTHORITY_OWNER_POLICY = "OWNER_POLICY_CONTROLLED";
export const AUTHORITY_PROHIBITED = "PROHIBITED";

/**
 * The closed authority matrix. Keys are the exact action identifiers Hermes
 * may ever request. Additions require a new governed slice + migration of
 * this table through review — never a runtime extension.
 */
export const HERMES_AUTHORITY_MATRIX = Object.freeze({
  // ------------------------------------------------------- production
  "production.start": AUTHORITY_AUTONOMOUS,
  "production.stop": AUTHORITY_AUTONOMOUS,
  "production.retry": AUTHORITY_AUTONOMOUS,
  "production.qc_run": AUTHORITY_AUTONOMOUS,
  "production.generate_media": AUTHORITY_AUTONOMOUS,
  "production.generate_script": AUTHORITY_AUTONOMOUS,
  // ----------------------------------------------------- scheduling
  "schedule.change": AUTHORITY_AUTONOMOUS,
  "schedule.prioritize_director": AUTHORITY_AUTONOMOUS,
  "schedule.select_topic": AUTHORITY_AUTONOMOUS,
  "schedule.assign_research": AUTHORITY_AUTONOMOUS,
  // ------------------------------------------------------ providers
  "provider.select": AUTHORITY_AUTONOMOUS,
  "provider.rotate_failed": AUTHORITY_AUTONOMOUS,
  "provider.use_fallback": AUTHORITY_AUTONOMOUS,
  "provider.read_health": AUTHORITY_AUTONOMOUS,
  "provider.read_quota": AUTHORITY_AUTONOMOUS,
  // ----------------------------------------------------- resources
  "resources.rebalance_workload": AUTHORITY_AUTONOMOUS,
  "resources.send_to_dlq": AUTHORITY_AUTONOMOUS,
  "resources.read_backlog": AUTHORITY_AUTONOMOUS,
  "resources.read_analytics": AUTHORITY_AUTONOMOUS,
  "resources.read_costs": AUTHORITY_AUTONOMOUS,

  // ------------------------------------------- owner-policy controlled
  "publishing.publish_publicly": AUTHORITY_OWNER_POLICY,
  "publishing.change_destination": AUTHORITY_OWNER_POLICY,
  "data.delete_critical": AUTHORITY_OWNER_POLICY,
  "spending.commit": AUTHORITY_OWNER_POLICY,

  // ------------------------------------------------------- prohibited
  "secrets.read_values": AUTHORITY_PROHIBITED,
  "secrets.export_keys": AUTHORITY_PROHIBITED,
  "credentials.change_owner": AUTHORITY_PROHIBITED,
  "security.disable_controls": AUTHORITY_PROHIBITED,
  "audit.modify_ledger": AUTHORITY_PROHIBITED,
  "approvals.bypass": AUTHORITY_PROHIBITED,
});

/** Stable machine-readable reason codes. */
export const AUTHORITY_DECISION_REASONS = Object.freeze({
  AUTONOMOUS: "AUTONOMOUS_WITHIN_OWNER_LIMITS",
  OWNER_POLICY: "OWNER_APPROVAL_REQUIRED",
  PROHIBITED: "PROHIBITED_BY_AUTHORITY_MATRIX",
  UNKNOWN: "UNKNOWN_ACTION_NOT_IN_MATRIX",
});

/**
 * Classify one action. Pure; throws on malformed input rather than
 * defaulting to any authority class (fail closed).
 */
export function classifyHermesAction(action) {
  if (typeof action !== "string" || action.length === 0) {
    throw new Error("HERMES_ACTION_REQUIRED");
  }
  const authority = HERMES_AUTHORITY_MATRIX[action];
  if (authority === undefined) {
    return {
      action,
      authority: AUTHORITY_PROHIBITED,
      executable: false,
      reason: AUTHORITY_DECISION_REASONS.UNKNOWN,
    };
  }
  return {
    action,
    authority,
    executable: authority === AUTHORITY_AUTONOMOUS,
    reason: AUTHORITY_DECISION_REASONS[authority === AUTHORITY_AUTONOMOUS
      ? "AUTONOMOUS"
      : authority === AUTHORITY_OWNER_POLICY
        ? "OWNER_POLICY"
        : "PROHIBITED"],
  };
}

/**
 * Bulk classifier for audit/dashboards. Never throws on unknown actions —
 * reports them as PROHIBITED/UNKNOWN so the owner sees attempts, not gaps.
 */
export function classifyHermesActions(actions) {
  const results = [];
  for (const action of actions ?? []) {
    try {
      results.push(classifyHermesAction(action));
    } catch {
      results.push({
        action: null,
        authority: AUTHORITY_PROHIBITED,
        executable: false,
        reason: AUTHORITY_DECISION_REASONS.UNKNOWN,
      });
    }
  }
  return results;
}

/**
 * True when the manager layer may proceed with the action NOW:
 *   - AUTONOMOUS: always true (owner limits are enforced downstream by
 *     quotas, schedules, and per-agent policies — not by this flag).
 *   - OWNER_POLICY_CONTROLLED: true ONLY with a structurally valid,
 *     unexpired owner approval reference.
 *   - PROHIBITED: false, unconditionally — even an approval cannot grant it.
 */
export function canHermesExecute(classification, ownerApproval = null, { now = new Date() } = {}) {
  if (!classification || typeof classification !== "object") {
    throw new Error("HERMES_CLASSIFICATION_REQUIRED");
  }
  if (classification.authority === AUTHORITY_PROHIBITED) {
    return false;
  }
  if (classification.authority === AUTHORITY_AUTONOMOUS) {
    return true;
  }
  // OWNER_POLICY_CONTROLLED: require an approval object with owner id and a
  // parseable, future expiry. Anything else fails closed.
  if (!ownerApproval || typeof ownerApproval !== "object") return false;
  if (typeof ownerApproval.ownerId !== "string" || ownerApproval.ownerId.length === 0) return false;
  if (typeof ownerApproval.expiresAt !== "string" || Number.isNaN(Date.parse(ownerApproval.expiresAt))) return false;
  return new Date(ownerApproval.expiresAt) > now;
}
