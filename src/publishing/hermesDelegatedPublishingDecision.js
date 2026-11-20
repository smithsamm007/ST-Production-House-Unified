/**
 * ST Production House — HERMES delegated publishing decision (D5).
 *
 * PURE evaluation: no clock reads beyond the supplied `now`, no I/O, no
 * repository access. The caller supplies the request, the delegation policy and
 * the collected evidence; this module answers one question:
 *
 *   "May HERMES authorize THIS publishing request, for THIS artifact and THESE
 *    destinations, under the ACTIVE delegated policy — or must it reject?"
 *
 * Silence is never approval: reaching this evaluator at all requires an expired
 * Owner window; a missing/failed check is a REJECT, never an implicit pass.
 */

import crypto from "node:crypto";
import { OWNER_APPROVAL_WINDOW_SECONDS } from "./publishingApprovalRepository.js";

/**
 * Every mandatory check must carry `{ passed: true, evidence: "<non-empty>" }`.
 * Anything else — missing entry, passed:false, empty evidence — fails closed.
 */
export const DELEGATED_PUBLISHING_CHECKS = Object.freeze([
  "artifactIntegrity",
  "productionQc",
  "mediaIntegrity",
  "copyrightLicensing",
  "rightsClearance",
  "privacy",
  "platformPolicy",
  "advertisingDisclosure",
  "metadata",
  "duplicateProtection",
  "ownerRestrictions",
]);

/** Authority HERMES must never acquire through a publishing delegation. */
export const OWNER_RESERVED_ACTIONS = Object.freeze([
  "credentials.change_owner",
  "credentials.new_account_connection",
  "spending.commit",
  "security.global_governance_change",
  "security.disable_controls",
  "policy.change_delegation",
  "data.destructive_deletion",
  "ownership.transfer",
  "deploy.production",
  "approvals.bypass",
]);

const ALLOWED_ACTION = "publishing.publish_publicly";

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * @returns {{decision:"APPROVE"|"REJECT", reasonCodes:string[], summary:string,
 *            evaluatedChecks:object, failedChecks:string[], policyPermits:boolean,
 *            evidenceHash:string, authority:object}}
 */
export function evaluateDelegatedPublishingDecision({
  request,
  policy,
  checks = {},
  now = new Date(),
  policyPermits = null,
  policyReasons = [],
  artifactSha256 = null,
}) {
  if (!request || typeof request !== "object") {
    throw new Error("APPROVAL_REQUEST_REQUIRED");
  }
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("EVALUATION_TIME_INVALID");

  const reasonCodes = [];
  const failedChecks = [];
  const evaluatedChecks = {};

  for (const name of DELEGATED_PUBLISHING_CHECKS) {
    const entry = checks?.[name];
    const passed =
      Boolean(entry) &&
      entry.passed === true &&
      typeof entry.evidence === "string" &&
      entry.evidence.trim().length > 0;
    evaluatedChecks[name] = {
      passed,
      evidence: passed ? entry.evidence.trim() : null,
      reasonCode: passed ? null : entry?.reasonCode || "MISSING_OR_UNVERIFIED_EVIDENCE",
    };
    if (!passed) {
      failedChecks.push(name);
      reasonCodes.push(`CHECK_FAILED:${name}`);
    }
  }

  // Artifact + destination binding: the request itself is the authority.
  if (!/^[a-f0-9]{64}$/.test(request.artifactSha256 ?? "")) {
    reasonCodes.push("ARTIFACT_HASH_INVALID");
  }
  if (artifactSha256 && artifactSha256 !== request.artifactSha256) {
    reasonCodes.push("ARTIFACT_CHANGED_SINCE_REQUEST");
  }
  if (!Array.isArray(request.destinations) || request.destinations.length === 0) {
    reasonCodes.push("DESTINATIONS_MISSING");
  }
  if (request.requestedAction !== ALLOWED_ACTION) {
    reasonCodes.push("ACTION_OUT_OF_DELEGATION_SCOPE");
  }
  if (OWNER_RESERVED_ACTIONS.includes(request.requestedAction)) {
    reasonCodes.push("OWNER_RESERVED_AUTHORITY");
  }

  // Deadline semantics: never evaluate inside the Owner window, and require a
  // confirmed delivery timestamp to exist at all.
  if (!request.notifiedAt) {
    reasonCodes.push("OWNER_NOTIFICATION_NOT_DELIVERED");
  }
  const deadlineMs = request.deadlineAt ? new Date(request.deadlineAt).getTime() : NaN;
  if (!Number.isFinite(deadlineMs)) {
    reasonCodes.push("DEADLINE_MISSING");
  } else if (nowMs < deadlineMs) {
    reasonCodes.push("OWNER_WINDOW_STILL_OPEN");
  } else if (deadlineMs - new Date(request.notifiedAt).getTime() !== OWNER_APPROVAL_WINDOW_SECONDS * 1000) {
    reasonCodes.push("DEADLINE_NOT_FIVE_HOURS");
  }
  if (request.ownerResponseAt) {
    reasonCodes.push("OWNER_ALREADY_RESPONDED");
  }

  const permits =
    typeof policyPermits === "boolean" ? policyPermits : approximatePolicyPermits(policy, request, nowMs);
  if (!permits) {
    reasonCodes.push("POLICY_NOT_ACTIVE", ...policyReasons);
  }

  const decision = reasonCodes.length === 0 ? "APPROVE" : "REJECT";
  const summary =
    decision === "APPROVE"
      ? "Owner did not respond within five hours. HERMES APPROVED this single publishing request: the artifact and destinations match the request, all mandatory checks carry verifiable evidence, and the active delegated policy authorizes it."
      : `HERMES REJECTED this publishing request: ${reasonCodes.join(", ")}. Silence is not consent and missing evidence is never treated as passed.`;

  const evidenceHash = sha256Hex({
    approvalId: request.id ?? null,
    directorId: request.directorId ?? null,
    artifactSha256: request.artifactSha256 ?? null,
    destinations: request.destinations ?? [],
    policyId: policy?.policyId ?? null,
    policyVersion: policy?.policyVersion ?? null,
    decision,
    reasonCodes,
    evaluatedChecks,
    now: new Date(nowMs).toISOString(),
  });

  return {
    decision,
    reasonCodes: [...new Set(reasonCodes)],
    summary,
    evaluatedChecks,
    failedChecks,
    policyPermits: permits,
    evidenceHash,
    authority: {
      actor: "HERMES",
      scope: "SINGLE_REQUEST_ONLY",
      action: request.requestedAction ?? null,
      approvalId: request.id ?? null,
      policyId: policy?.policyId ?? null,
      policyVersion: policy?.policyVersion ?? null,
      grantsUnrestrictedPublishing: false,
      grantsSpendingAuthority: false,
      grantsAccountConnection: false,
      grantsSecurityAuthority: false,
      grantsPolicyChangeAuthority: false,
      overridesOwnerReserved: false,
      overridesOwnerRejection: false,
    },
  };
}

/**
 * Local, dependency-free mirror of the repository's policy authority check.
 * The repository re-validates against database time inside the finalizing
 * transaction; this copy only keeps the evaluator pure and testable.
 */
export function approximatePolicyPermits(policy, request, nowMs) {
  if (!policy) return false;
  if (policy.active !== true) return false;
  if (policy.revokedAt) return false;
  if (policy.category !== "publishing") return false;
  if (policy.permitsLivePublishing !== true) return false;
  if (!Array.isArray(policy.allowedActions) || !policy.allowedActions.includes(ALLOWED_ACTION)) {
    return false;
  }
  if (policy.expiresAt && nowMs > new Date(policy.expiresAt).getTime()) return false;
  if (String(policy.policyVersion) !== String(request?.policyVersion)) return false;
  if (request?.delegatedPolicyId && policy.policyId !== request.delegatedPolicyId) return false;
  return true;
}

/**
 * Authority boundary assertions for anything that is NOT a publishing decision.
 * Returns a denial record instead of throwing so callers can audit the attempt.
 */
export function classifyDelegatedAction({ action, category = "publishing" }) {
  const reserved = OWNER_RESERVED_ACTIONS.includes(action);
  const publishing = action === ALLOWED_ACTION && category === "publishing";
  return {
    action,
    category,
    allowed: publishing && !reserved,
    code: reserved
      ? "OWNER_RESERVED_AUTHORITY"
      : publishing
        ? "DELEGABLE_PUBLISHING_ONLY"
        : "OUT_OF_DELEGATION_SCOPE",
    note: reserved
      ? "Owner-reserved decisions can never be delegated, regardless of elapsed time."
      : publishing
        ? "Delegable: publishing is the only action this window covers, bound to one request."
        : "Only publishing.publish_publicly may be delegated by this engine.",
  };
}
