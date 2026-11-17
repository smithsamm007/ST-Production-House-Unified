/**
 * ST Production House — FORGE Centralized Permission Gateway (Phase 2, v1.2).
 *
 * Deny-by-default authorization service enforcing:
 *   - Permission tiers T0..T7 (with T6a/T6b/T6c split and T1 read separation)
 *   - Actor role boundaries (owner, forge_controller, forge_coder, forge_qa,
 *     forge_reviewer, forge_security, hermes, director)
 *   - Coding-worker GitHub write prohibition (v1.2 Condition 1)
 *   - Default rejection of `.github/workflows/**` modifications
 *   - Separation of coding and review/approval (`authorWorkerId !== reviewerWorkerId`)
 *   - Monotonic fencing-token verification on mutable operations
 *   - Hard budget/quota ceiling checks (zero silent paid failover)
 *   - Canonical JSON SHA-256 hash-chained audit evidence records
 */

import { createHash, randomUUID } from "node:crypto";

export const EVIDENCE_DOMAIN_SEPARATOR = "stph.forge.evidence.v1";

export const PERMISSION_TIERS = Object.freeze({
  T0: "T0",   // Owner-reserved / discovery-governed
  T1: "T1",   // Read-only observation (repo, logs, CI status)
  T2: "T2",   // Analyze, diagnose, plan
  T3: "T3",   // Prepare drafts, patches, RFCs
  T4: "T4",   // Reversible sandboxed internal execution (tests, lint, local build)
  T5: "T5",   // Controlled internal modification (controller-brokered branch/PR/backlog)
  T6A: "T6a", // Authorized CI / workflow dispatch
  T6B: "T6b", // Approved staging / non-production external action
  T6C: "T6c", // Outbound notifications & HERMES bridge events
  T7: "T7",   // Owner-restricted: merge, prod deploy, spending, credentials, security, delete
});

export const VALID_TIERS = Object.freeze(new Set(Object.values(PERMISSION_TIERS)));

export const ACTOR_TYPES = Object.freeze({
  OWNER: "owner",
  FORGE_CONTROLLER: "forge_controller",
  FORGE_CODER: "forge_coder",
  FORGE_QA: "forge_qa",
  FORGE_REVIEWER: "forge_reviewer",
  FORGE_SECURITY: "forge_security",
  HERMES: "hermes",
  DIRECTOR: "director",
});

/**
 * Closed role-to-tier allowlist (deny-by-default).
 * Any actor/tier pair not listed here is unconditionally DENIED.
 */
const ROLE_ALLOWED_TIERS = Object.freeze({
  [ACTOR_TYPES.OWNER]: new Set(Object.values(PERMISSION_TIERS)),
  [ACTOR_TYPES.FORGE_CONTROLLER]: new Set([
    PERMISSION_TIERS.T1,
    PERMISSION_TIERS.T2,
    PERMISSION_TIERS.T3,
    PERMISSION_TIERS.T4,
    PERMISSION_TIERS.T5,
    PERMISSION_TIERS.T6A,
    PERMISSION_TIERS.T6B,
    PERMISSION_TIERS.T6C,
  ]),
  [ACTOR_TYPES.FORGE_CODER]: new Set([
    PERMISSION_TIERS.T1,
    PERMISSION_TIERS.T2,
    PERMISSION_TIERS.T3,
    PERMISSION_TIERS.T4,
  ]),
  [ACTOR_TYPES.FORGE_QA]: new Set([
    PERMISSION_TIERS.T1,
    PERMISSION_TIERS.T2,
    PERMISSION_TIERS.T4,
  ]),
  [ACTOR_TYPES.FORGE_REVIEWER]: new Set([
    PERMISSION_TIERS.T1,
    PERMISSION_TIERS.T2,
    PERMISSION_TIERS.T3,
  ]),
  [ACTOR_TYPES.FORGE_SECURITY]: new Set([
    PERMISSION_TIERS.T1,
    PERMISSION_TIERS.T2,
    PERMISSION_TIERS.T4,
  ]),
  [ACTOR_TYPES.HERMES]: new Set([
    PERMISSION_TIERS.T1,
    PERMISSION_TIERS.T2,
    PERMISSION_TIERS.T3,
    PERMISSION_TIERS.T4,
    PERMISSION_TIERS.T6C,
  ]),
  [ACTOR_TYPES.DIRECTOR]: new Set([
    PERMISSION_TIERS.T1,
    PERMISSION_TIERS.T2,
    PERMISSION_TIERS.T3,
    PERMISSION_TIERS.T4,
  ]),
});

const GITHUB_WRITE_ACTIONS = Object.freeze(
  new Set([
    "github.push_branch",
    "github.create_pr",
    "github.update_pr",
    "github.update_labels",
  ])
);

const OWNER_RESERVED_ACTIONS = Object.freeze(
  new Set([
    "spending.commit",
    "billing.activate_paid_service",
    "credentials.bind_oauth",
    "credentials.change_owner",
    "security.change_governance",
    "database.destructive_operation",
    "github.merge_pr",
    "deploy.production",
    "ownership.transfer",
  ])
);

/** Deterministic canonical JSON serialization (sorted keys, UTF-8). */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** Domain-separated SHA-256 digest over canonical bytes. */
export function computeEvidenceHash(prevHash, payload) {
  const canonical = canonicalJson(payload);
  return createHash("sha256")
    .update(`${EVIDENCE_DOMAIN_SEPARATOR}|${prevHash}|${canonical}`, "utf8")
    .digest("hex");
}

/**
 * Append-only in-memory hash-chained evidence ledger matching the v1.2
 * PostgreSQL `forge_evidence_records` contract.
 */
export class ForgeEvidenceLedger {
  constructor() {
    this._records = [];
    this._lastHash = "0".repeat(64);
  }

  append({ eventType, actorId, taskId = null, commitSha = null, payload = {} }) {
    const seq = this._records.length + 1;
    const prevHash = this._lastHash;
    const timestamp = new Date().toISOString();
    const body = {
      chainSeq: seq,
      eventType,
      actorId,
      taskId,
      commitSha,
      payload,
      timestamp,
    };
    const recordHash = computeEvidenceHash(prevHash, body);
    const record = Object.freeze({
      id: randomUUID(),
      ...body,
      prevHash,
      recordHash,
    });
    this._records.push(record);
    this._lastHash = recordHash;
    return record;
  }

  list() {
    return [...this._records];
  }

  verifyChain() {
    let expectedPrev = "0".repeat(64);
    for (const rec of this._records) {
      if (rec.prevHash !== expectedPrev) {
        return { valid: false, brokenAtSeq: rec.chainSeq, reason: "PREV_HASH_MISMATCH" };
      }
      const body = {
        chainSeq: rec.chainSeq,
        eventType: rec.eventType,
        actorId: rec.actorId,
        taskId: rec.taskId,
        commitSha: rec.commitSha,
        payload: rec.payload,
        timestamp: rec.timestamp,
      };
      const recomputed = computeEvidenceHash(rec.prevHash, body);
      if (recomputed !== rec.recordHash) {
        return { valid: false, brokenAtSeq: rec.chainSeq, reason: "RECORD_HASH_TAMPERED" };
      }
      expectedPrev = rec.recordHash;
    }
    return { valid: true, count: this._records.length, headHash: expectedPrev };
  }
}

export class ForgePermissionGateway {
  constructor({ evidenceLedger = new ForgeEvidenceLedger() } = {}) {
    this.evidenceLedger = evidenceLedger;
    this._decisions = [];
  }

  /**
   * Evaluate an authorization request. Always fails closed (deny-by-default)
   * and appends an auditable decision + evidence record.
   */
  authorize(request) {
    const decision = this._evaluate(request);
    const evidence = this.evidenceLedger.append({
      eventType: "FORGE_AUTHZ_DECISION",
      actorId: request?.actor?.id ?? "unknown",
      taskId: request?.taskId ?? null,
      payload: {
        actorType: request?.actor?.type ?? "unknown",
        action: request?.action ?? "unknown",
        tier: request?.tier ?? "unknown",
        resource: request?.resource ?? null,
        allowed: decision.allowed,
        code: decision.code,
        reason: decision.reason,
      },
    });
    const record = Object.freeze({
      id: randomUUID(),
      ...decision,
      evidenceRef: evidence.recordHash,
      timestamp: evidence.timestamp,
    });
    this._decisions.push(record);
    return record;
  }

  listDecisions() {
    return [...this._decisions];
  }

  _evaluate(req) {
    if (!req || typeof req !== "object") {
      return { allowed: false, code: "DENY_MALFORMED_REQUEST", reason: "Authorization request is required." };
    }
    const {
      actor,
      action,
      tier,
      resource = {},
      fencingToken = null,
      activeFencingToken = null,
      budget = null,
      ownerApproval = null,
      touchedPaths = [],
      reviewContext = null,
    } = req;

    if (!actor || !actor.authenticated || !actor.id || !actor.type) {
      return { allowed: false, code: "DENY_UNAUTHENTICATED", reason: "Authenticated actor identity is required." };
    }
    if (typeof action !== "string" || action.trim() === "") {
      return { allowed: false, code: "DENY_MISSING_ACTION", reason: "Action identifier is required." };
    }
    if (!VALID_TIERS.has(tier)) {
      return { allowed: false, code: "DENY_UNKNOWN_TIER", reason: `Unrecognized permission tier: ${String(tier)}.` };
    }

    // 1. T0 / T7 & Owner-reserved actions strictly require Owner actor or explicit valid Owner approval
    if (
      tier === PERMISSION_TIERS.T0 ||
      tier === PERMISSION_TIERS.T7 ||
      OWNER_RESERVED_ACTIONS.has(action)
    ) {
      if (actor.type !== ACTOR_TYPES.OWNER) {
        const hasValidApproval =
          ownerApproval &&
          ownerApproval.approvedBy === ACTOR_TYPES.OWNER &&
          ownerApproval.action === action &&
          ownerApproval.expiresAt &&
          new Date(ownerApproval.expiresAt).getTime() > Date.now();
        if (!hasValidApproval) {
          return {
            allowed: false,
            code: "DENY_OWNER_RESERVED",
            reason: `Action '${action}' (${tier}) is Owner-reserved and requires explicit unexpired Owner authorization.`,
          };
        }
      }
    }

    // 2. Role-to-tier check (deny-by-default)
    const allowedTiers = ROLE_ALLOWED_TIERS[actor.type];
    if (!allowedTiers || !allowedTiers.has(tier)) {
      return {
        allowed: false,
        code: "DENY_TIER_FOR_ROLE",
        reason: `Actor type '${actor.type}' is not permitted to execute tier '${tier}'.`,
      };
    }

    // 3. Coding workers never receive GitHub write permissions (v1.2 Condition 1)
    if (GITHUB_WRITE_ACTIONS.has(action) && actor.type !== ACTOR_TYPES.FORGE_CONTROLLER && actor.type !== ACTOR_TYPES.OWNER) {
      return {
        allowed: false,
        code: "DENY_WORKER_GITHUB_WRITE",
        reason: `Only FORGE Controller/Broker may execute '${action}'; workers have read-only GitHub access.`,
      };
    }

    // 4. Reject `.github/workflows/**` changes by default unless Owner explicitly approves
    if (Array.isArray(touchedPaths) && touchedPaths.some((p) => String(p).startsWith(".github/workflows/"))) {
      if (actor.type !== ACTOR_TYPES.OWNER && !ownerApproval?.allowWorkflowChanges) {
        return {
          allowed: false,
          code: "DENY_WORKFLOW_MODIFICATION",
          reason: "Modifications to .github/workflows/** are denied by default without explicit Owner policy.",
        };
      }
    }

    // 5. Separation of duties: coding worker cannot approve its own work
    if (action === "review.submit_verdict" && reviewContext) {
      if (
        !reviewContext.authorWorkerId ||
        !reviewContext.reviewerWorkerId ||
        reviewContext.authorWorkerId === reviewContext.reviewerWorkerId
      ) {
        return {
          allowed: false,
          code: "DENY_SELF_APPROVAL",
          reason: "A coding worker cannot review or approve its own commits.",
        };
      }
    }

    // 6. Resource ownership isolation for Directors
    if (actor.type === ACTOR_TYPES.DIRECTOR && resource.directorId && resource.directorId !== actor.directorId) {
      return {
        allowed: false,
        code: "DENY_CROSS_DIRECTOR_ACCESS",
        reason: `Director '${actor.directorId}' cannot access resource owned by '${resource.directorId}'.`,
      };
    }

    // 7. Fencing token verification for leased mutable operations
    if (activeFencingToken !== null) {
      if (fencingToken === null || Number(fencingToken) !== Number(activeFencingToken)) {
        return {
          allowed: false,
          code: "DENY_STALE_FENCING_TOKEN",
          reason: `Stale fencing token (${fencingToken}) rejected; active token is ${activeFencingToken}.`,
        };
      }
    }

    // 8. Budget / quota guard (never silently exceed limits or switch to paid)
    if (budget && typeof budget === "object") {
      if (budget.costTier === "paid" && !budget.ownerApprovedPaid) {
        return {
          allowed: false,
          code: "DENY_UNAPPROVED_PAID_PROVIDER",
          reason: "Paid provider usage requires explicit Owner authorization.",
        };
      }
      if (typeof budget.used === "number" && typeof budget.limit === "number" && budget.used >= budget.limit) {
        return {
          allowed: false,
          code: "DENY_QUOTA_EXHAUSTED",
          reason: `Quota ceiling reached (${budget.used}/${budget.limit}).`,
        };
      }
    }

    return {
      allowed: true,
      code: "ALLOW",
      reason: `Authorized '${action}' at tier '${tier}' for '${actor.type}'.`,
    };
  }
}
