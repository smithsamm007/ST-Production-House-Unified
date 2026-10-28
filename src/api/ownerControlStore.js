/**
 * ST Production House — Durable owner-control store (S-M18-02 backend).
 *
 * Implements the store contract consumed by `createOwnerControlRouter`:
 *
 *   getJobForOwner(ownerId, jobId)        → job row or null
 *   retryJob(ownerId, jobId, fromStatus, { action, detail })
 *   cancelJob(ownerId, jobId, fromStatus, { action, detail })
 *   listPendingApprovals(ownerId, limit)  → approval rows
 *   listActivePauses(ownerId)             → active emergency_pauses rows
 *
 * Security contract (AGENTS.md Rules 6, 13, 17):
 * - Every query is parameterized; owner scoping is always part of the WHERE
 *   clause, so a cross-owner job/pause is indistinguishable from a missing one.
 * - retry/cancel change status and write the owner_control_audit row inside
 *   ONE transaction: a mutation without its audit row cannot exist.
 * - Status transitions are re-validated here against the same legal
 *   transitions the sql/010 + sql/017 triggers enforce, so the in-memory
 *   demo adapter and PostgreSQL behave identically.
 * - Outbound rows are plain objects with snake_case DB column names, exactly
 *   the shape the router's DTO allowlists project.
 */

import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Legal requeue/cancel transitions, mirroring sql/017 enforce_job_status_transition.
const RETRYABLE_FROM = new Set(["failed", "dead_letter"]);
const CANCELLABLE_FROM = new Set(["queued", "leased", "running"]);

export function isRetryableStatus(status) {
  return RETRYABLE_FROM.has(status);
}

export function isCancellableStatus(status) {
  return CANCELLABLE_FROM.has(status);
}

export class PostgresOwnerControlStore {
  constructor(dbAdapter, evidenceLedger = null) {
    if (!dbAdapter || typeof dbAdapter.query !== "function" || typeof dbAdapter.withTransaction !== "function") {
      throw new Error("POSTGRES_TRANSACTION_ADAPTER_REQUIRED");
    }
    this.db = dbAdapter;
    this.ledger = evidenceLedger;
    this.name = "PostgresOwnerControlStore";
  }

  async getJobForOwner(ownerId, jobId) {
    const result = await this.db.query(
      `SELECT * FROM jobs WHERE id = $1 AND owner_id = $2;`,
      [jobId, ownerId]
    );
    return result.rows[0] ?? null;
  }

  async listJobsForOwner(ownerId, { limit = 100 } = {}) {
    const bounded = Math.min(Math.max(1, Number(limit) || 100), 200);
    const result = await this.db.query(
      `SELECT * FROM jobs WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2;`,
      [ownerId, bounded]
    );
    return result.rows;
  }

  async #transitionWithAudit(ownerId, jobId, fromStatus, toStatus, { action, detail } = {}) {
    return this.db.withTransaction(async (client) => {
      const locked = await client.query(
        `SELECT * FROM jobs WHERE id = $1 AND owner_id = $2 FOR UPDATE;`,
        [jobId, ownerId]
      );
      if (locked.rowCount !== 1) return null;
      const job = locked.rows[0];
      if (job.status !== fromStatus) return null; // concurrent change: fail closed

      const updated = await client.query(
        `UPDATE jobs
            SET status = $2,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING *;`,
        [jobId, toStatus]
      );

      await client.query(
        `INSERT INTO owner_control_audit (owner_id, agent_id, job_id, action, from_status, to_status, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [ownerId, job.agent_id, jobId, action, fromStatus, toStatus, JSON.stringify(detail ?? {})]
      );

      if (this.ledger) {
        const { appendEvidenceEventXact } = await import("../jobs/retry/retryManager.js");
        await appendEvidenceEventXact(client, {
          subjectId: jobId,
          kind: toStatus === "queued" ? "owner_job_retry" : "owner_job_cancel",
          classification: toStatus === "queued" ? "owner_authorized_recovery" : "owner_authorized_cancel",
          payload: {
            jobId,
            agentId: job.agent_id,
            ownerId,
            fromStatus,
            toStatus,
            action,
          },
        });
      }

      return updated.rows[0];
    });
  }

  async retryJob(ownerId, jobId, fromStatus, meta = {}) {
    if (!RETRYABLE_FROM.has(fromStatus)) throw new Error("JOB_NOT_RETRYABLE");
    return this.#transitionWithAudit(ownerId, jobId, fromStatus, "queued", {
      action: "job_retry",
      detail: meta.detail ?? {},
    });
  }

  async cancelJob(ownerId, jobId, fromStatus, meta = {}) {
    if (!CANCELLABLE_FROM.has(fromStatus)) throw new Error("JOB_NOT_CANCELLABLE");
    return this.#transitionWithAudit(ownerId, jobId, fromStatus, "owner_cancelled", {
      action: "job_cancel",
      detail: meta.detail ?? {},
    });
  }

  async listPendingApprovals(ownerId, limit = 50) {
    const bounded = Math.min(Math.max(1, Number(limit) || 50), 200);
    const result = await this.db.query(
      `SELECT pr.*, a.sha256 AS artifact_sha256, a.kind AS artifact_kind
         FROM publishing_requests pr
         LEFT JOIN artifacts a ON a.id = pr.artifact_id
        WHERE pr.status = 'pending'
          AND pr.approval_expires_at IS NULL
          AND EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.owner_id = $1
                   AND (j.payload->>'publishingRequestId') = pr.id::text
              )
        ORDER BY pr.created_at DESC
        LIMIT $2;`,
      [ownerId, bounded]
    );
    return result.rows;
  }

  async listActivePauses(ownerId) {
    const result = await this.db.query(
      `SELECT * FROM emergency_pauses WHERE owner_id = $1 AND active = true ORDER BY created_at DESC;`,
      [ownerId]
    );
    return result.rows;
  }
}

/**
 * Demo store over the demo adapter (or any adapter exposing the same
 * interface). Labeled NON-PRODUCTION: storage is process-local and cleared on
 * restart. All production guarantees (parameterized queries, owner scoping,
 * audit-in-transaction) are enforced identically because they live in this
 * module, not in the driver.
 */
export class DemoOwnerControlStore extends PostgresOwnerControlStore {
  constructor(adapter, evidenceLedger = null) {
    super(adapter, evidenceLedger);
    this.name = "DemoOwnerControlStore";
  }
}

// Demo adapter SQL uses explicit ids; keep UUID format for API validation.
export function newJobId() {
  return randomUUID();
}

export function isValidJobId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}
