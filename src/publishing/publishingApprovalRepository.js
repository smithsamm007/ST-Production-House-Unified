/**
 * ST Production House — durable publishing-approval repository (D5).
 *
 * Every deadline, decision and notification transition lives in PostgreSQL and
 * is compared with `clock_timestamp()`. Application clocks are never the
 * authority: a restarted or skewed instance cannot extend or shorten the
 * five-hour Owner window.
 *
 * Concurrency contract:
 *   - Owner responses and HERMES deadline decisions serialize on the approval
 *     row (`SELECT … FOR UPDATE`). The first committed transition wins; the
 *     loser gets a stable code (OWNER_RESPONSE_WON / DECISION_ALREADY_TERMINAL)
 *     and writes nothing.
 *   - Deadline evaluation requires a live lease row whose fencing token matches
 *     the one returned by `claimExpiredApprovals`; a restarted or stale worker
 *     is rejected with FENCING_TOKEN_STALE.
 *   - Approval decisions re-read the delegation policy inside the finalizing
 *     transaction, so revoking a policy always takes effect before a new
 *     authorization is created.
 */

import crypto from "node:crypto";

export const OWNER_APPROVAL_WINDOW_SECONDS = 5 * 60 * 60;
/** Mirrors the existing owner-approval cap (ownerOperationsRouter ≤ 1h). */
export const PUBLISHING_AUTHORIZATION_TTL_SECONDS = 60 * 60;

export const APPROVAL_STATUS = Object.freeze({
  PENDING_NOTIFICATION: "PENDING_NOTIFICATION",
  AWAITING_OWNER: "AWAITING_OWNER",
  OWNER_APPROVED: "OWNER_APPROVED",
  OWNER_REJECTED: "OWNER_REJECTED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  HERMES_APPROVED: "HERMES_APPROVED",
  HERMES_REJECTED: "HERMES_REJECTED",
  SUPERSEDED: "SUPERSEDED",
  WITHDRAWN: "WITHDRAWN",
});

const TERMINAL = new Set([
  APPROVAL_STATUS.OWNER_APPROVED,
  APPROVAL_STATUS.OWNER_REJECTED,
  APPROVAL_STATUS.CHANGES_REQUESTED,
  APPROVAL_STATUS.HERMES_APPROVED,
  APPROVAL_STATUS.HERMES_REJECTED,
  APPROVAL_STATUS.SUPERSEDED,
  APPROVAL_STATUS.WITHDRAWN,
]);

export const OWNER_DECISIONS = Object.freeze(["APPROVE", "REJECT", "CHANGES_REQUESTED"]);
export const NOTIFICATION_KIND = Object.freeze({
  OWNER_APPROVAL_REQUEST: "OWNER_APPROVAL_REQUEST",
  HERMES_DECISION: "HERMES_DECISION",
});

export class ApprovalError extends Error {
  constructor(code, message, status = 409) {
    super(message ?? code);
    this.name = "ApprovalError";
    this.code = code;
    this.status = status;
  }
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function assertSha256(value, code = "ARTIFACT_HASH_INVALID") {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ApprovalError(code, "A lowercase hex SHA-256 is required.", 400);
  }
  return value;
}

function assertIdentifier(value, code, max = 200) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value) || value.length > max) {
    throw new ApprovalError(code, "A bounded safe identifier is required.", 400);
  }
  return value;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function mapApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key ?? null,
    ownerId: row.owner_id ?? null,
    directorId: row.director_id,
    universeId: row.universe_id,
    packageId: row.package_id,
    requestedAction: row.requested_action,
    artifactSha256: row.artifact_sha256,
    destinations: Array.isArray(row.destinations) ? [...row.destinations] : [],
    captionSnapshot: row.caption_snapshot ?? {},
    policyVersion: row.policy_version,
    delegatedPolicyId: row.delegated_policy_id,
    status: row.status,
    createdAt: iso(row.created_at),
    notifiedAt: iso(row.notified_at),
    deadlineAt: iso(row.deadline_at),
    ownerResponseAt: iso(row.owner_response_at),
    ownerResponseBy: row.owner_response_by ?? null,
    ownerResponseReason: row.owner_response_reason ?? null,
    hermesDecidedAt: iso(row.hermes_decided_at),
    hermesDecision: row.hermes_decision ?? null,
    decisionReasonCodes: Array.isArray(row.decision_reason_codes) ? [...row.decision_reason_codes] : [],
    decisionSummary: row.decision_summary ?? null,
    evaluatedChecks: row.evaluated_checks ?? null,
    decisionEvidenceHash: row.decision_evidence_hash ?? null,
    publishingAuthorized: row.publishing_authorized === true,
    authorizationExpiresAt: iso(row.authorization_expires_at),
    supersededBy: row.superseded_by ?? null,
    invalidatedAt: iso(row.invalidated_at),
    invalidationReason: row.invalidation_reason ?? null,
    serverNow: iso(row.server_now),
  };
}

export function mapNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    approvalId: row.approval_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    channel: row.channel,
    state: row.state,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    body: row.body ?? {},
    lastError: row.last_error ?? null,
    createdAt: iso(row.created_at),
    queuedAt: iso(row.queued_at),
    attemptedAt: iso(row.attempted_at),
    deliveredAt: iso(row.delivered_at),
    failedAt: iso(row.failed_at),
  };
}

export function mapPolicy(row) {
  if (!row) return null;
  return {
    policyId: row.policy_id,
    category: row.category,
    allowedActions: Array.isArray(row.allowed_actions) ? [...row.allowed_actions] : [],
    maxRisk: row.max_risk,
    active: row.active === true,
    expiresAt: iso(row.expires_at),
    policyVersion: Number(row.policy_version ?? 0),
    permitsLivePublishing: row.permits_live_publishing === true,
    revokedAt: iso(row.revoked_at),
  };
}

export function ownerNotificationDedupeKey(approvalId) {
  return `approval:${approvalId}:owner_request`;
}

export function decisionNotificationDedupeKey(approvalId) {
  return `approval:${approvalId}:hermes_decision`;
}

export class PostgresPublishingApprovalRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function") {
      throw new ApprovalError("POOL_REQUIRED", "A PostgreSQL pool is required.", 500);
    }
    this.pool = pool;
  }

  async _tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ policies
  async registerPolicy({
    policyId,
    category = "publishing",
    allowedActions = ["publishing.publish_publicly"],
    maxRisk = "medium",
    expiresAt = null,
    policyVersion = 1,
    permitsLivePublishing = true,
  }) {
    assertIdentifier(policyId, "POLICY_ID_INVALID");
    if (category !== "publishing") {
      // Only publishing may ever be delegated by this engine (D5 scope).
      throw new ApprovalError("POLICY_CATEGORY_NOT_DELEGABLE", "D5 delegates publishing only.", 400);
    }
    if (!Array.isArray(allowedActions) || allowedActions.length === 0) {
      throw new ApprovalError("POLICY_ACTIONS_REQUIRED", "Allowed actions are required.", 400);
    }
    if (allowedActions.length !== 1 || allowedActions[0] !== "publishing.publish_publicly") {
      throw new ApprovalError(
        "POLICY_ACTION_OUT_OF_SCOPE",
        "D5 policies may only carry publishing.publish_publicly.",
        400
      );
    }
    const { rows } = await this.pool.query(
      `INSERT INTO forge_delegation_policies
         (policy_id, category, allowed_actions, max_risk, active, expires_at, policy_version, permits_live_publishing)
       VALUES ($1, $2, $3, $4, true, $5::timestamptz, $6, $7)
       ON CONFLICT (policy_id) DO UPDATE
         SET category = EXCLUDED.category,
             allowed_actions = EXCLUDED.allowed_actions,
             max_risk = EXCLUDED.max_risk,
             expires_at = EXCLUDED.expires_at,
             policy_version = forge_delegation_policies.policy_version + 1,
             permits_live_publishing = EXCLUDED.permits_live_publishing,
             active = true,
             revoked_at = NULL
       RETURNING *`,
      [policyId, category, allowedActions, maxRisk, expiresAt, policyVersion, permitsLivePublishing]
    );
    return mapPolicy(rows[0]);
  }

  async revokePolicy(policyId) {
    assertIdentifier(policyId, "POLICY_ID_INVALID");
    const { rows } = await this.pool.query(
      `UPDATE forge_delegation_policies
          SET active = false, revoked_at = clock_timestamp()
        WHERE policy_id = $1
        RETURNING *`,
      [policyId]
    );
    return rows[0] ? mapPolicy(rows[0]) : null;
  }

  async getPolicy(policyId) {
    if (!policyId) return null;
    const { rows } = await this.pool.query(
      "SELECT * FROM forge_delegation_policies WHERE policy_id = $1",
      [policyId]
    );
    return rows[0] ? mapPolicy(rows[0]) : null;
  }

  /**
   * Policy validity for one exact request/action at one exact moment.
   * Used both by the evaluator (advisory) and inside the finalizing
   * transaction (authoritative).
   */
  evaluatePolicyAuthority({ policy, request, now = null }) {
    const reasons = [];
    if (!policy) return { permits: false, reasons: ["NO_DELEGATED_POLICY"] };
    const nowMs = now ? new Date(now).getTime() : Date.now();
    if (policy.active !== true || policy.revokedAt) reasons.push("POLICY_REVOKED");
    if (policy.category !== "publishing") reasons.push("POLICY_CATEGORY_OUT_OF_SCOPE");
    if (policy.permitsLivePublishing !== true) reasons.push("POLICY_DOES_NOT_PERMIT_LIVE_PUBLISHING");
    if (!policy.allowedActions.includes("publishing.publish_publicly")) {
      reasons.push("POLICY_ACTION_NOT_ALLOWED");
    }
    if (policy.expiresAt && nowMs > new Date(policy.expiresAt).getTime()) {
      reasons.push("POLICY_EXPIRED");
    }
    if (String(policy.policyVersion) !== String(request?.policyVersion)) {
      reasons.push("POLICY_VERSION_MISMATCH");
    }
    if (request?.delegatedPolicyId && policy.policyId !== request.delegatedPolicyId) {
      reasons.push("POLICY_ID_MISMATCH");
    }
    return { permits: reasons.length === 0, reasons };
  }

  // ---------------------------------------------------------------- approvals
  async createRequest({
    id = crypto.randomUUID(),
    idempotencyKey,
    ownerId,
    directorId,
    universeId = null,
    packageId = null,
    artifactSha256,
    destinations,
    captionSnapshot = {},
    policyVersion,
    delegatedPolicyId = null,
  }) {
    assertIdentifier(idempotencyKey, "IDEMPOTENCY_KEY_INVALID");
    assertSha256(artifactSha256);
    if (!Array.isArray(destinations) || destinations.length === 0 || destinations.length > 4) {
      throw new ApprovalError("DESTINATIONS_REQUIRED", "One to four destinations are required.", 400);
    }
    const unique = [...new Set(destinations.map((d) => String(d).toLowerCase()))];
    const allowed = new Set(["youtube", "instagram", "facebook", "snapchat"]);
    for (const destination of unique) {
      if (!allowed.has(destination)) {
        throw new ApprovalError("INVALID_PLATFORM_DESTINATION", `Unsupported destination: ${destination}`, 400);
      }
    }
    if (!ownerId) throw new ApprovalError("OWNER_REQUIRED", "Owner scope is required.", 400);
    if (!policyVersion) throw new ApprovalError("POLICY_VERSION_REQUIRED", "Policy version is required.", 400);

    const { rowCount, rows } = await this.pool.query(
      `INSERT INTO forge_publishing_approvals
         (id, idempotency_key, owner_id, director_id, universe_id, package_id,
          artifact_sha256, destinations, caption_snapshot, policy_version, delegated_policy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        id,
        idempotencyKey,
        ownerId,
        directorId,
        universeId,
        packageId,
        artifactSha256,
        unique,
        JSON.stringify(captionSnapshot ?? {}),
        String(policyVersion),
        delegatedPolicyId,
      ]
    );
    if (rowCount > 0) return { deduplicated: false, request: mapApproval(rows[0]) };

    const existing = await this.getRequestByIdempotencyKey(idempotencyKey);
    if (!existing || existing.artifactSha256 !== artifactSha256) {
      throw new ApprovalError(
        "IDEMPOTENCY_KEY_CONFLICT",
        "The idempotency key is already bound to a different artifact.",
        409
      );
    }
    return { deduplicated: true, request: existing };
  }

  async getRequest(approvalId) {
    const { rows } = await this.pool.query(
      "SELECT *, clock_timestamp() AS server_now FROM forge_publishing_approvals WHERE id = $1",
      [approvalId]
    );
    return rows[0] ? mapApproval(rows[0]) : null;
  }

  async getRequestByIdempotencyKey(idempotencyKey) {
    const { rows } = await this.pool.query(
      "SELECT *, clock_timestamp() AS server_now FROM forge_publishing_approvals WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    return rows[0] ? mapApproval(rows[0]) : null;
  }

  async listRequests({ ownerId, limit = 50 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT *, clock_timestamp() AS server_now
         FROM forge_publishing_approvals
        WHERE ($1::uuid IS NULL OR owner_id = $1::uuid)
        ORDER BY created_at DESC
        LIMIT $2`,
      [ownerId ?? null, Math.max(1, Math.min(200, limit))]
    );
    return rows.map(mapApproval);
  }

  // ------------------------------------------------------------- notifications
  async queueNotification({ approvalId, kind, body, channel = "owner_inbox", dedupeKey }) {
    if (!Object.values(NOTIFICATION_KIND).includes(kind)) {
      throw new ApprovalError("NOTIFICATION_KIND_INVALID", "Unknown notification kind.", 400);
    }
    const key = dedupeKey ?? (kind === NOTIFICATION_KIND.OWNER_APPROVAL_REQUEST
      ? ownerNotificationDedupeKey(approvalId)
      : decisionNotificationDedupeKey(approvalId));
    const { rowCount, rows } = await this.pool.query(
      `INSERT INTO forge_approval_notifications
         (approval_id, kind, dedupe_key, channel, state, body, queued_at)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, clock_timestamp())
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [approvalId, kind, key, channel, JSON.stringify(body ?? {})]
    );
    if (rowCount > 0) return { deduplicated: false, notification: mapNotification(rows[0]) };
    const existing = await this.getNotification(key);
    if (existing && existing.approvalId !== approvalId) {
      throw new ApprovalError("NOTIFICATION_DEDUPE_CONFLICT", "Dedupe key belongs to another approval.", 409);
    }
    return { deduplicated: true, notification: existing };
  }

  async getNotification(dedupeKey) {
    const { rows } = await this.pool.query(
      "SELECT * FROM forge_approval_notifications WHERE dedupe_key = $1",
      [dedupeKey]
    );
    return rows[0] ? mapNotification(rows[0]) : null;
  }

  async listNotifications(approvalId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM forge_approval_notifications
        WHERE approval_id = $1
        ORDER BY created_at ASC`,
      [approvalId]
    );
    return rows.map(mapNotification);
  }

  /**
   * Confirm delivery. Only THIS transition starts the five-hour clock, and the
   * deadline is derived from the confirmed delivery timestamp, never from the
   * request's creation time.
   */
  async markNotificationDelivered({ dedupeKey, at = null }) {
    return this._tx(async (client) => {
      const notif = await client.query(
        `UPDATE forge_approval_notifications
            SET state = 'delivered',
                attempts = attempts + 1,
                attempted_at = COALESCE($2::timestamptz, clock_timestamp()),
                delivered_at = COALESCE($2::timestamptz, clock_timestamp()),
                failed_at = NULL,
                last_error = NULL
          WHERE dedupe_key = $1
            AND state <> 'delivered'
          RETURNING *`,
        [dedupeKey, at]
      );
      if (notif.rowCount === 0) {
        const existing = await client.query(
          "SELECT * FROM forge_approval_notifications WHERE dedupe_key = $1",
          [dedupeKey]
        );
        if (!existing.rows[0]) {
          throw new ApprovalError("NOTIFICATION_NOT_FOUND", "Unknown notification.", 404);
        }
        return {
          deduplicated: true,
          notification: mapNotification(existing.rows[0]),
          request: null,
        };
      }
      const notification = mapNotification(notif.rows[0]);
      let request = null;
      if (notification.kind === NOTIFICATION_KIND.OWNER_APPROVAL_REQUEST) {
        const updated = await client.query(
          `UPDATE forge_publishing_approvals
              SET status = 'AWAITING_OWNER',
                  notified_at = $2::timestamptz,
                  deadline_at = $2::timestamptz + ($3 || ' seconds')::interval
            WHERE id = $1
              AND status = 'PENDING_NOTIFICATION'
            RETURNING *, clock_timestamp() AS server_now`,
          [notification.approvalId, notification.deliveredAt, String(OWNER_APPROVAL_WINDOW_SECONDS)]
        );
        request = updated.rows[0] ? mapApproval(updated.rows[0]) : null;
      }
      return { deduplicated: false, notification, request };
    });
  }

  async markNotificationFailed({ dedupeKey, error, at = null }) {
    const { rows } = await this.pool.query(
      `UPDATE forge_approval_notifications
          SET state = 'failed',
              attempts = attempts + 1,
              attempted_at = COALESCE($2::timestamptz, clock_timestamp()),
              failed_at = COALESCE($2::timestamptz, clock_timestamp()),
              last_error = left($3, 500)
        WHERE dedupe_key = $1
        RETURNING *`,
      [dedupeKey, at, String(error?.message ?? error ?? "NOTIFICATION_DELIVERY_FAILED")]
    );
    if (!rows[0]) throw new ApprovalError("NOTIFICATION_NOT_FOUND", "Unknown notification.", 404);
    return mapNotification(rows[0]);
  }

  /** Bounded retry: returns the queued row or refuses past max_attempts. */
  async retryNotification(dedupeKey) {
    const { rows } = await this.pool.query(
      `UPDATE forge_approval_notifications
          SET state = 'queued', queued_at = clock_timestamp()
        WHERE dedupe_key = $1
          AND state IN ('created', 'queued', 'failed')
          AND attempts < max_attempts
        RETURNING *`,
      [dedupeKey]
    );
    if (!rows[0]) {
      const existing = await this.getNotification(dedupeKey);
      if (!existing) throw new ApprovalError("NOTIFICATION_NOT_FOUND", "Unknown notification.", 404);
      // Already delivered: a retry is a no-op, not a second delivery.
      if (existing.state === "delivered") return existing;
      throw new ApprovalError("NOTIFICATION_RETRY_EXHAUSTED", "Delivery retries are exhausted.", 409);
    }
    return mapNotification(rows[0]);
  }

  // ------------------------------------------------------------ owner response
  async recordOwnerDecision({
    approvalId,
    ownerId,
    decision,
    artifactSha256,
    reason = null,
    at = null,
  }) {
    if (!OWNER_DECISIONS.includes(decision)) {
      throw new ApprovalError("OWNER_DECISION_INVALID", "APPROVE, REJECT or CHANGES_REQUESTED required.", 400);
    }
    assertSha256(artifactSha256, "ARTIFACT_HASH_REQUIRED");

    return this._tx(async (client) => {
      const current = await client.query(
        "SELECT * FROM forge_publishing_approvals WHERE id = $1 FOR UPDATE",
        [approvalId]
      );
      if (current.rowCount === 0) {
        throw new ApprovalError("APPROVAL_REQUEST_NOT_FOUND", "Unknown approval request.", 404);
      }
      const row = current.rows[0];
      if (row.owner_id !== ownerId) {
        throw new ApprovalError("OWNER_SCOPE_MISMATCH", "This request belongs to another Owner.", 403);
      }
      if (row.artifact_sha256 !== artifactSha256) {
        throw new ApprovalError(
          "ARTIFACT_HASH_MISMATCH",
          "The Owner decision must be bound to the request's exact artifact hash.",
          409
        );
      }
      if (row.invalidated_at || row.superseded_by) {
        throw new ApprovalError("APPROVAL_REQUEST_SUPERSEDED", "The request is no longer active.", 409);
      }
      if (row.owner_response_at) {
        const prior = row.status;
        const replayable =
          (decision === "APPROVE" && prior === APPROVAL_STATUS.OWNER_APPROVED) ||
          (decision === "REJECT" && prior === APPROVAL_STATUS.OWNER_REJECTED) ||
          (decision === "CHANGES_REQUESTED" && prior === APPROVAL_STATUS.CHANGES_REQUESTED);
        if (replayable) {
          const again = await client.query(
            "SELECT *, clock_timestamp() AS server_now FROM forge_publishing_approvals WHERE id = $1",
            [approvalId]
          );
          return { deduplicated: true, request: mapApproval(again.rows[0]) };
        }
        throw new ApprovalError("OWNER_DECISION_ALREADY_RECORDED", "A different Owner decision already exists.", 409);
      }
      if (TERMINAL.has(row.status)) {
        // HERMES decided first: the Owner response arrived too late.
        throw new ApprovalError(
          "OWNER_RESPONSE_TOO_LATE",
          "HERMES already recorded a terminal decision for this request.",
          409
        );
      }
      if (row.status !== APPROVAL_STATUS.AWAITING_OWNER) {
        throw new ApprovalError(
          "OWNER_WINDOW_NOT_OPEN",
          "The five-hour window has not started; Owner notification delivery is not confirmed.",
          409
        );
      }

      const status =
        decision === "APPROVE"
          ? APPROVAL_STATUS.OWNER_APPROVED
          : decision === "REJECT"
            ? APPROVAL_STATUS.OWNER_REJECTED
            : APPROVAL_STATUS.CHANGES_REQUESTED;
      const authorized = decision === "APPROVE";

      const updated = await client.query(
        `UPDATE forge_publishing_approvals
            SET status = $2,
                owner_response_at = COALESCE($3::timestamptz, clock_timestamp()),
                owner_response_by = $4,
                owner_response_reason = $5,
                publishing_authorized = $6,
                authorization_expires_at = CASE
                  WHEN $6 THEN COALESCE($3::timestamptz, clock_timestamp())
                                + ($7 || ' seconds')::interval
                  ELSE NULL END
          WHERE id = $1
          RETURNING *, clock_timestamp() AS server_now`,
        [
          approvalId,
          status,
          at,
          ownerId,
          reason,
          authorized,
          String(PUBLISHING_AUTHORIZATION_TTL_SECONDS),
        ]
      );

      await client.query(
        `INSERT INTO forge_publishing_decisions
           (approval_id, actor, decision, reason_codes, summary, evidence_refs)
         VALUES ($1, 'OWNER', $2, $3, $4, $5::jsonb)`,
        [
          approvalId,
          decision,
          reason ? [] : [],
          reason ? String(reason).slice(0, 1000) : "Owner decision recorded through the authenticated Owner session.",
          JSON.stringify([{ kind: "owner_session", ownerId }]),
        ]
      );

      return { deduplicated: false, request: mapApproval(updated.rows[0]) };
    });
  }

  // -------------------------------------------------------------- deadline work
  /**
   * Atomically lease expired requests. Only rows whose durable deadline has
   * passed (database time) and that have no live lease are claimable.
   */
  async claimExpiredApprovals({ workerId, leaseSeconds = 60, limit = 10 }) {
    assertIdentifier(workerId, "WORKER_ID_INVALID", 120);
    return this._tx(async (client) => {
      const claimed = await client.query(
        `WITH candidates AS (
           SELECT a.id
             FROM forge_publishing_approvals a
             LEFT JOIN forge_approval_deadline_leases l ON l.approval_id = a.id
            WHERE a.status = 'AWAITING_OWNER'
              AND a.deadline_at IS NOT NULL
              AND a.deadline_at <= clock_timestamp()
              AND a.invalidated_at IS NULL
              AND a.superseded_by IS NULL
              AND (l.approval_id IS NULL OR l.lease_expires_at <= clock_timestamp())
            ORDER BY a.deadline_at ASC
            LIMIT $1
            FOR UPDATE OF a SKIP LOCKED
         )
         INSERT INTO forge_approval_deadline_leases
           (approval_id, worker_id, fencing_token, lease_expires_at)
         SELECT c.id,
                $2,
                COALESCE((SELECT MAX(l2.fencing_token)
                            FROM forge_approval_deadline_leases l2
                           WHERE l2.approval_id = c.id), 0) + 1,
                clock_timestamp() + ($3 || ' seconds')::interval
           FROM candidates c
         ON CONFLICT (approval_id) DO UPDATE
           SET worker_id = EXCLUDED.worker_id,
               fencing_token = forge_approval_deadline_leases.fencing_token + 1,
               lease_expires_at = EXCLUDED.lease_expires_at,
               created_at = clock_timestamp()
         RETURNING approval_id, worker_id, fencing_token, lease_expires_at`,
        [Math.max(1, Math.min(100, limit)), workerId, String(Math.max(5, leaseSeconds))]
      );
      if (claimed.rowCount === 0) return [];
      const ids = claimed.rows.map((r) => r.approval_id);
      const approvals = await client.query(
        `SELECT *, clock_timestamp() AS server_now
           FROM forge_publishing_approvals
          WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      const byId = new Map(approvals.rows.map((r) => [r.id, mapApproval(r)]));
      const tokens = new Map(claimed.rows.map((r) => [r.approval_id, Number(r.fencing_token)]));
      return ids
        .filter((id) => byId.has(id))
        .map((id) => ({ request: byId.get(id), fencingToken: tokens.get(id) }));
    });
  }

  /**
   * Persist the terminal decision under the caller's lease. Revalidates the
   * Owner window, supersession and (for APPROVE) the delegation policy inside
   * the transaction. A failed policy revalidation is stored as an explicit
   * REJECT — never a silent approval.
   */
  async finalizeHermesDecision({
    approvalId,
    fencingToken,
    decision,
    reasonCodes = [],
    summary,
    evaluatedChecks = {},
    evidenceHash = null,
    evidenceRefs = [],
    workerId = null,
  }) {
    if (!["APPROVE", "REJECT"].includes(decision)) {
      throw new ApprovalError("HERMES_DECISION_INVALID", "HERMES must return APPROVE or REJECT.", 400);
    }
    return this._tx(async (client) => {
      const lease = await client.query(
        "SELECT * FROM forge_approval_deadline_leases WHERE approval_id = $1 FOR UPDATE",
        [approvalId]
      );
      if (lease.rowCount === 0) {
        throw new ApprovalError("LEASE_NOT_HELD", "No deadline lease is held for this request.", 409);
      }
      if (Number(lease.rows[0].fencing_token) !== Number(fencingToken)) {
        throw new ApprovalError("FENCING_TOKEN_STALE", "A newer worker lease superseded this one.", 409);
      }
      if (workerId && lease.rows[0].worker_id !== workerId) {
        throw new ApprovalError("LEASE_HELD_BY_OTHER_WORKER", "The lease belongs to another worker.", 409);
      }
      const liveLease = await client.query(
        "SELECT (lease_expires_at > clock_timestamp()) AS live FROM forge_approval_deadline_leases WHERE approval_id = $1",
        [approvalId]
      );
      if (liveLease.rows[0]?.live !== true) {
        throw new ApprovalError("LEASE_EXPIRED", "The deadline lease expired before the decision was written.", 409);
      }

      const current = await client.query(
        "SELECT *, clock_timestamp() AS server_now FROM forge_publishing_approvals WHERE id = $1 FOR UPDATE",
        [approvalId]
      );
      const row = current.rows[0];
      if (!row) throw new ApprovalError("APPROVAL_REQUEST_NOT_FOUND", "Unknown approval request.", 404);
      if (row.owner_response_at) {
        throw new ApprovalError("OWNER_RESPONSE_WON", "The Owner responded before HERMES decided.", 409);
      }
      if (TERMINAL.has(row.status)) {
        throw new ApprovalError("DECISION_ALREADY_TERMINAL", "A terminal decision already exists.", 409);
      }
      if (row.invalidated_at || row.superseded_by) {
        throw new ApprovalError("APPROVAL_REQUEST_SUPERSEDED", "The request is no longer active.", 409);
      }
      if (row.status !== APPROVAL_STATUS.AWAITING_OWNER) {
        throw new ApprovalError("OWNER_WINDOW_NOT_OPEN", "The Owner window has not started.", 409);
      }
      const expired = await client.query(
        "SELECT ($1::timestamptz IS NOT NULL AND $1::timestamptz <= clock_timestamp()) AS expired",
        [row.deadline_at]
      );
      if (expired.rows[0]?.expired !== true) {
        throw new ApprovalError("OWNER_WINDOW_NOT_EXPIRED", "The five-hour Owner window has not elapsed.", 409);
      }

      let finalDecision = decision;
      let finalSummary = String(summary ?? "HERMES delegated publishing decision.").slice(0, 1000);
      const finalReasons = [...reasonCodes];
      let policyVersion = null;

      if (finalDecision === "APPROVE") {
        const policyRow = row.delegated_policy_id
          ? await client.query(
              "SELECT * FROM forge_delegation_policies WHERE policy_id = $1 FOR SHARE",
              [row.delegated_policy_id]
            )
          : { rows: [] };
        const policy = policyRow.rows[0] ? mapPolicy(policyRow.rows[0]) : null;
        // Re-evaluate with DATABASE time so a revocation/expiry during the
        // evaluation window always wins over a stale APPROVE.
        const policyTime = await client.query("SELECT clock_timestamp() AS now");
        const authority = this.evaluatePolicyAuthority({
          policy,
          request: mapApproval(row),
          now: policyTime.rows[0].now,
        });
        policyVersion = policy ? policy.policyVersion : null;
        if (!authority.permits) {
          finalDecision = "REJECT";
          finalReasons.push("POLICY_NOT_ACTIVE_AT_DECISION", ...authority.reasons);
          finalSummary =
            "HERMES intended to approve, but the delegated publishing policy was not active at decision time. Publishing stays unauthorized.";
        }
      }

      const authorized = finalDecision === "APPROVE";
      const status = authorized ? APPROVAL_STATUS.HERMES_APPROVED : APPROVAL_STATUS.HERMES_REJECTED;

      const updated = await client.query(
        `UPDATE forge_publishing_approvals
            SET status = $2,
                hermes_decided_at = clock_timestamp(),
                hermes_decision = $3,
                decision_reason_codes = $4,
                decision_summary = $5,
                evaluated_checks = $6::jsonb,
                decision_evidence_hash = $7,
                publishing_authorized = $8,
                authorization_expires_at = CASE
                  WHEN $8 THEN clock_timestamp() + ($9 || ' seconds')::interval
                  ELSE NULL END
          WHERE id = $1
          RETURNING *, clock_timestamp() AS server_now`,
        [
          approvalId,
          status,
          finalDecision,
          finalReasons.length > 0 ? finalReasons : [],
          finalSummary,
          JSON.stringify(evaluatedChecks ?? {}),
          evidenceHash,
          authorized,
          String(PUBLISHING_AUTHORIZATION_TTL_SECONDS),
        ]
      );

      await client.query(
        `INSERT INTO forge_publishing_decisions
           (approval_id, actor, decision, reason_codes, summary, policy_id, policy_version,
            evidence_hash, evidence_refs)
         VALUES ($1, 'HERMES', $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          approvalId,
          finalDecision,
          finalReasons.length > 0 ? finalReasons : [],
          finalSummary,
          row.delegated_policy_id,
          policyVersion,
          evidenceHash,
          JSON.stringify(Array.isArray(evidenceRefs) ? evidenceRefs : []),
        ]
      );

      await client.query("DELETE FROM forge_approval_deadline_leases WHERE approval_id = $1", [approvalId]);

      return { request: mapApproval(updated.rows[0]), decision: finalDecision, authorizationGranted: authorized };
    });
  }

  async releaseExpiredLease(approvalId) {
    await this.pool.query(
      "DELETE FROM forge_approval_deadline_leases WHERE approval_id = $1 AND lease_expires_at <= clock_timestamp()",
      [approvalId]
    );
    return true;
  }

  async listDecisions(approvalId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM forge_publishing_decisions
        WHERE approval_id = $1
        ORDER BY decided_at ASC`,
      [approvalId]
    );
    return rows.map((row) => ({
      id: row.id,
      approvalId: row.approval_id,
      actor: row.actor,
      decision: row.decision,
      reasonCodes: [...(row.reason_codes ?? [])],
      summary: row.summary,
      policyId: row.policy_id,
      policyVersion: row.policy_version === null ? null : Number(row.policy_version),
      evidenceHash: row.evidence_hash,
      evidenceRefs: row.evidence_refs ?? [],
      decidedAt: iso(row.decided_at),
    }));
  }

  // ------------------------------------------------------- publishing safety
  /**
   * The publishing gate. Revalidates status, artifact binding, destination,
   * authorization expiry and — for delegated approvals — the live policy, all
   * against database time, immediately before any dispatch may proceed.
   */
  async verifyAuthorization({ approvalId, artifactSha256, destination }) {
    if (!approvalId) return { authorized: false, code: "APPROVAL_ID_REQUIRED" };
    const { rows } = await this.pool.query(
      `SELECT a.*,
              clock_timestamp() AS server_now,
              (a.authorization_expires_at IS NOT NULL
               AND a.authorization_expires_at > clock_timestamp()) AS authorization_live
         FROM forge_publishing_approvals a
        WHERE a.id = $1`,
      [approvalId]
    );
    const row = rows[0];
    if (!row) return { authorized: false, code: "APPROVAL_REQUEST_NOT_FOUND" };
    const request = mapApproval(row);
    if (request.invalidatedAt || request.supersededBy) {
      return { authorized: false, code: "APPROVAL_REQUEST_SUPERSEDED" };
    }
    if (![APPROVAL_STATUS.OWNER_APPROVED, APPROVAL_STATUS.HERMES_APPROVED].includes(request.status)) {
      return { authorized: false, code: "NO_ACTIVE_APPROVAL", status: request.status };
    }
    if (request.publishingAuthorized !== true) {
      return { authorized: false, code: "PUBLISHING_NOT_AUTHORIZED" };
    }
    if (row.authorization_live !== true) {
      return { authorized: false, code: "AUTHORIZATION_EXPIRED" };
    }
    if (typeof artifactSha256 !== "string" || artifactSha256 !== request.artifactSha256) {
      return { authorized: false, code: "ARTIFACT_HASH_MISMATCH" };
    }
    if (destination && !request.destinations.includes(String(destination).toLowerCase())) {
      return { authorized: false, code: "DESTINATION_NOT_AUTHORIZED" };
    }
    if (request.status === APPROVAL_STATUS.HERMES_APPROVED) {
      // Delegated authority is policy-bound: revalidate it at execution time.
      const policy = await this.getPolicy(request.delegatedPolicyId);
      const authority = this.evaluatePolicyAuthority({
        policy,
        request,
        now: row.server_now,
      });
      if (!authority.permits) {
        return { authorized: false, code: "DELEGATION_POLICY_NOT_ACTIVE", reasons: authority.reasons };
      }
    }
    return {
      authorized: true,
      code: "AUTHORIZED",
      approvalId,
      status: request.status,
      artifactSha256: request.artifactSha256,
      destination: destination ? String(destination).toLowerCase() : null,
      authorizationExpiresAt: request.authorizationExpiresAt,
      evidenceHash: request.decisionEvidenceHash,
    };
  }

  async invalidateRequest({ approvalId, reason }) {
    const { rows } = await this.pool.query(
      `UPDATE forge_publishing_approvals
          SET invalidated_at = clock_timestamp(),
              invalidation_reason = left($2, 500),
              publishing_authorized = false,
              authorization_expires_at = NULL
        WHERE id = $1
          AND invalidated_at IS NULL
        RETURNING *, clock_timestamp() AS server_now`,
      [approvalId, String(reason ?? "ARTIFACT_OR_REQUEST_INVALIDATED")]
    );
    if (!rows[0]) throw new ApprovalError("APPROVAL_REQUEST_NOT_FOUND", "Unknown or already invalidated request.", 404);
    return mapApproval(rows[0]);
  }
}
