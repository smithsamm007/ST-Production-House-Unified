/**
 * ST Production House — Owner Delegation & Unavailability Engine (Phase 2, v1.2).
 *
 * Enforces:
 *   - No response from Owner is NEVER consent.
 *   - Expired approval windows do NOT automatically authorize actions.
 *   - Owner-reserved decisions are permanently locked against delegation.
 *   - Every evaluation produces a full structured delegation record tied to
 *     the hash-chained evidence ledger.
 */

import { randomUUID } from "node:crypto";
import { ForgeEvidenceLedger } from "./permissionGateway.js";

export const OWNER_RESERVED_CATEGORIES = Object.freeze(
  new Set([
    "spending.above_limits",
    "credentials.new_account_connection",
    "security.global_governance_change",
    "data.destructive_deletion",
    "ownership.transfer",
    "deploy.production",
    "github.merge_outside_policy",
  ])
);

export class OwnerDelegationEngine {
  constructor({ evidenceLedger = new ForgeEvidenceLedger() } = {}) {
    this.evidenceLedger = evidenceLedger;
    this._ownerAvailability = "available";
    this._policies = new Map();
    this._records = [];
  }

  setOwnerAvailability(status) {
    if (status !== "available" && status !== "unavailable") {
      throw new Error("INVALID_OWNER_AVAILABILITY");
    }
    this._ownerAvailability = status;
    this.evidenceLedger.append({
      eventType: "OWNER_AVAILABILITY_CHANGED",
      actorId: "owner",
      payload: { availability: status },
    });
    return status;
  }

  getOwnerAvailability() {
    return this._ownerAvailability;
  }

  /**
   * Register an Owner-approved delegation policy for a non-reserved category.
   * Rejects any attempt to delegate an Owner-reserved category.
   */
  registerPolicy({ policyId, category, allowedActions, maxRisk = "medium", expiresAt }) {
    if (!policyId || !category || !Array.isArray(allowedActions) || allowedActions.length === 0) {
      throw new Error("INVALID_DELEGATION_POLICY");
    }
    if (OWNER_RESERVED_CATEGORIES.has(category)) {
      throw new Error(`OWNER_RESERVED_CATEGORY_CANNOT_BE_DELEGATED:${category}`);
    }
    const policy = Object.freeze({
      policyId,
      category,
      allowedActions: Object.freeze([...allowedActions]),
      maxRisk,
      expiresAt: expiresAt ?? null,
      active: true,
    });
    this._policies.set(policyId, policy);
    return policy;
  }

  revokePolicy(policyId) {
    const existing = this._policies.get(policyId);
    if (!existing) return false;
    this._policies.set(policyId, Object.freeze({ ...existing, active: false }));
    return true;
  }

  /**
   * Evaluate whether HERMES may execute a delegated action.
   * Produces a complete v1.2 delegation record with evidence reference.
   */
  evaluate({
    requestId = randomUUID(),
    actorId = "hermes",
    category,
    action,
    resource,
    decisionDeadline,
    policyId = null,
    riskAssessment = "low",
    now = new Date(),
  }) {
    const nowMs = now.getTime();
    const deadlineMs = decisionDeadline ? new Date(decisionDeadline).getTime() : null;
    const deadlineExpired = deadlineMs !== null && nowMs > deadlineMs;

    let authorizationResult = "DENIED";
    let rationale = "";
    let executionOutcome = "PAUSED_AWAITING_OWNER";

    if (OWNER_RESERVED_CATEGORIES.has(category)) {
      authorizationResult = "DENIED_OWNER_RESERVED";
      rationale = `Category '${category}' is strictly Owner-reserved and cannot be delegated even when Owner is unavailable or deadline expires.`;
      executionOutcome = "BLOCKED_OWNER_ONLY";
    } else if (this._ownerAvailability === "available") {
      authorizationResult = "DEFERRED_TO_OWNER";
      rationale = "Owner is currently available; Owner decisions take precedence over unavailability delegation.";
      executionOutcome = "AWAITING_OWNER_DECISION";
    } else {
      // Owner is unavailable: check explicit, active, unexpired policy
      const policy = policyId ? this._policies.get(policyId) : null;
      const policyExpired = policy?.expiresAt ? nowMs > new Date(policy.expiresAt).getTime() : false;

      if (!policy || !policy.active) {
        authorizationResult = deadlineExpired ? "DENIED_NO_ASSUMED_CONSENT" : "DENIED_NO_POLICY";
        rationale = deadlineExpired
          ? "Approval deadline expired with no active delegation policy. Silence is not consent; action paused."
          : "No active explicit delegation policy covers this request.";
        executionOutcome = "PAUSED_SAFE";
      } else if (policyExpired) {
        authorizationResult = "DENIED_POLICY_EXPIRED";
        rationale = `Delegation policy '${policy.policyId}' has expired; expired policies cannot authorize execution.`;
        executionOutcome = "PAUSED_SAFE";
      } else if (policy.category !== category || !policy.allowedActions.includes(action)) {
        authorizationResult = "DENIED_OUT_OF_SCOPE";
        rationale = `Action '${action}' in category '${category}' is outside delegation policy '${policy.policyId}'.`;
        executionOutcome = "PAUSED_SAFE";
      } else {
        authorizationResult = "AUTHORIZED_DELEGATED";
        rationale = `Explicit active delegation policy '${policy.policyId}' authorizes '${action}' during Owner unavailability.`;
        executionOutcome = "EXECUTED_WITHIN_DELEGATION";
      }
    }

    const evidence = this.evidenceLedger.append({
      eventType: "HERMES_DELEGATION_EVALUATED",
      actorId,
      payload: {
        requestId,
        category,
        action,
        resource,
        policyId,
        authorizationResult,
        executionOutcome,
      },
    });

    const record = Object.freeze({
      id: randomUUID(),
      request: requestId,
      action,
      resource,
      decisionDeadline: decisionDeadline ?? null,
      applicablePolicy: policyId,
      riskAssessment,
      authorizationResult,
      rationale,
      executionOutcome,
      evidenceRef: evidence.recordHash,
      timestamp: evidence.timestamp,
    });

    this._records.push(record);
    return record;
  }

  listRecords() {
    return [...this._records];
  }
}
