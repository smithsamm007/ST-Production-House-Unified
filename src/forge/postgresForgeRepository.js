/**
 * ST Production House — PostgreSQL 15 Repository for FORGE Control Plane (Phase 2.7, v1.2).
 *
 * Uses parameterized SQL, `clock_timestamp()` for lease expiry inside
 * transactions, `pg_advisory_xact_lock` for serialized evidence chain appends,
 * and dedicated non-privileged `st_dir_*` roles for Director RLS isolation.
 */

import { computeEvidenceHash } from "./permissionGateway.js";
import { deriveDirectorDbRole } from "./directorIsolation.js";

const EVIDENCE_CHAIN_ADVISORY_LOCK_KEY = 42038199;

function asIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Row → the same camelCase task shape the in-memory adapter returns. */
export function mapForgeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    issueNumber: row.issue_number,
    derivedBranch: row.derived_branch,
    title: row.title,
    status: row.status,
    priority: row.priority,
    idempotencyKey: row.idempotency_key,
    activeFencingToken: Number(row.active_fencing_token),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextRunAt: asIso(row.next_run_at),
    cancelRequested: row.cancel_requested,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapLease(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    fencingToken: Number(row.fencing_token),
    leasedAt: asIso(row.leased_at),
    leaseExpiresAt: asIso(row.lease_expires_at),
    releasedAt: asIso(row.released_at),
    releaseReason: row.release_reason,
  };
}

function mapPrSlot(row) {
  if (!row) return null;
  return {
    slotId: row.slot_id,
    taskId: row.reserved_by_task_id,
    fencingToken: row.fencing_token === null ? null : Number(row.fencing_token),
    branchName: row.branch_name,
    prNumber: row.pr_number,
    reservedAt: asIso(row.reserved_at),
    expiresAt: asIso(row.expires_at),
    watchdogOverdue: row.watchdog_overdue === true,
  };
}

function mapExternalOp(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    fencingToken: Number(row.fencing_token),
    operationType: row.operation_type,
    targetBranch: row.target_branch,
    expectedTreeSha: row.expected_tree_sha,
    observedSha: row.observed_sha,
    status: row.status,
    createdAt: asIso(row.created_at),
    reconciledAt: asIso(row.reconciled_at),
  };
}

export class PostgresForgeRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new Error("POSTGRES_POOL_REQUIRED");
    }
    this.pool = pool;
  }

  async enqueueTask({ issueNumber, slug, title, idempotencyKey, maxAttempts = 3 }) {
    const cleanSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    const derivedBranch = `task/${Number(issueNumber)}-${cleanSlug}`;
    const existing = await this.pool.query(
      "SELECT * FROM forge_tasks WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      return { deduplicated: true, task: mapForgeTask(existing.rows[0]) };
    }
    // Multi-instance safe: two instances racing the same idempotency key must
    // produce one logical task, not a unique-violation error.
    const inserted = await this.pool.query(
      `INSERT INTO forge_tasks (issue_number, derived_branch, title, idempotency_key, max_attempts)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [Number(issueNumber), derivedBranch, String(title), idempotencyKey, maxAttempts]
    );
    if (inserted.rows[0]) {
      return { deduplicated: false, task: mapForgeTask(inserted.rows[0]) };
    }
    const raced = await this.pool.query(
      "SELECT * FROM forge_tasks WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    return { deduplicated: true, task: mapForgeTask(raced.rows[0]) };
  }

  async registerWorker({ workerKey, role, runtimeEnv = "isolated_container" }) {
    const res = await this.pool.query(
      `INSERT INTO forge_workers (worker_key, role, runtime_env)
       VALUES ($1, $2, $3)
       ON CONFLICT (worker_key) DO UPDATE SET last_heartbeat_at = clock_timestamp()
       RETURNING *`,
      [workerKey, role, runtimeEnv]
    );
    return res.rows[0];
  }

  /**
   * Single atomic transaction:
   *  1. Lock task row (`FOR UPDATE`).
   *  2. Reclaim expired active lease using `clock_timestamp()`.
   *  3. Increment `active_fencing_token` and insert new active lease row.
   */
  async claimLease({ taskId, workerId, leaseTtlSeconds = 300 }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const taskRes = await client.query(
        "SELECT * FROM forge_tasks WHERE id = $1 FOR UPDATE",
        [taskId]
      );
      if (taskRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, code: "TASK_NOT_FOUND" };
      }
      const task = taskRes.rows[0];

      // Release expired lease atomically before checking for an active unexpired lease
      await client.query(
        `UPDATE forge_worker_leases
            SET released_at = clock_timestamp(), release_reason = 'expired'
          WHERE task_id = $1
            AND released_at IS NULL
            AND lease_expires_at <= clock_timestamp()`,
        [taskId]
      );

      const activeRes = await client.query(
        "SELECT * FROM forge_worker_leases WHERE task_id = $1 AND released_at IS NULL",
        [taskId]
      );
      if (activeRes.rows.length > 0) {
        await client.query("ROLLBACK");
        return { ok: false, code: "LEASE_ALREADY_ACTIVE", activeLease: mapLease(activeRes.rows[0]) };
      }

      if (task.attempt_count >= task.max_attempts) {
        await client.query(
          "UPDATE forge_tasks SET status = 'DEAD_LETTER', updated_at = clock_timestamp() WHERE id = $1",
          [taskId]
        );
        await client.query("COMMIT");
        return { ok: false, code: "MAX_ATTEMPTS_EXHAUSTED_DLQ" };
      }

      const updatedTask = await client.query(
        `UPDATE forge_tasks
            SET active_fencing_token = active_fencing_token + 1,
                attempt_count = attempt_count + 1,
                status = 'IN_PROGRESS',
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [taskId]
      );
      const nextToken = Number(updatedTask.rows[0].active_fencing_token);

      const leaseRes = await client.query(
        `INSERT INTO forge_worker_leases (task_id, worker_id, fencing_token, lease_expires_at)
         VALUES ($1, $2, $3, clock_timestamp() + ($4 || ' seconds')::interval)
         RETURNING *`,
        [taskId, workerId, nextToken, String(leaseTtlSeconds)]
      );
      await client.query("COMMIT");
      return { ok: true, code: "LEASE_ACQUIRED", fencingToken: nextToken, lease: mapLease(leaseRes.rows[0]) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Serialized append-only evidence record with `pg_advisory_xact_lock`
   * guaranteeing linear hash chaining under concurrency.
   */
  async appendEvidence({ eventType, actorId, taskId = null, commitSha = null, payload = {} }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [EVIDENCE_CHAIN_ADVISORY_LOCK_KEY]);
      const headRes = await client.query(
        "SELECT chain_seq, record_hash FROM forge_evidence_records ORDER BY chain_seq DESC LIMIT 1"
      );
      const prevHash = headRes.rows.length > 0 ? headRes.rows[0].record_hash : "0".repeat(64);
      const nextSeq = headRes.rows.length > 0 ? Number(headRes.rows[0].chain_seq) + 1 : 1;
      const timestamp = new Date().toISOString();
      const recordHash = computeEvidenceHash(prevHash, {
        chainSeq: nextSeq,
        eventType,
        actorId,
        taskId,
        commitSha,
        payload,
        timestamp,
      });

      const inserted = await client.query(
        `INSERT INTO forge_evidence_records (task_id, event_type, actor_id, commit_sha, prev_hash, record_hash, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING *`,
        [taskId, eventType, actorId, commitSha, prevHash, recordHash, JSON.stringify(payload)]
      );
      await client.query("COMMIT");
      return inserted.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /* ------------------------------------------------------------------ runtime */

  /** Real connectivity probe. Durable status is only ever claimed from this. */
  async probe() {
    const res = await this.pool.query(
      "SELECT 1 AS ok, clock_timestamp() AS database_time"
    );
    return {
      ok: res.rows[0]?.ok === 1,
      databaseTime: asIso(res.rows[0]?.database_time),
    };
  }

  async listTasks({ limit = 50 } = {}) {
    const res = await this.pool.query(
      "SELECT * FROM forge_tasks ORDER BY created_at DESC LIMIT $1",
      [Math.max(1, Math.min(200, Number(limit) || 50))]
    );
    return res.rows.map(mapForgeTask);
  }

  async getTask(taskId) {
    const res = await this.pool.query("SELECT * FROM forge_tasks WHERE id = $1", [taskId]);
    return mapForgeTask(res.rows[0]);
  }

  async getRuntimeStatus() {
    const [taskCounts, leaseStats, opStats, slotRes, checkpointCount, reconciliation] =
      await Promise.all([
        this.pool.query(
          "SELECT status, count(*)::integer AS count FROM forge_tasks GROUP BY status"
        ),
        this.pool.query(
          `SELECT
             count(*) FILTER (WHERE released_at IS NULL)::integer AS active,
             count(*) FILTER (WHERE released_at IS NULL AND lease_expires_at <= clock_timestamp())::integer AS expired
           FROM forge_worker_leases`
        ),
        this.pool.query(
          `SELECT
             count(*) FILTER (WHERE status = 'IN_FLIGHT')::integer AS inflight,
             count(*) FILTER (WHERE status = 'COMMITTED')::integer AS committed,
             count(*) FILTER (WHERE status = 'FAILED_SAFE_TO_RETRY')::integer AS failed
           FROM forge_external_ops`
        ),
        this.pool.query(
          `SELECT *, (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS watchdog_overdue
             FROM forge_pr_slots WHERE slot_id = 1`
        ),
        this.pool.query("SELECT count(*)::integer AS count FROM forge_task_checkpoints"),
        this.lastReconciliation(),
      ]);

    const tasksByStatus = {};
    for (const row of taskCounts.rows) tasksByStatus[row.status] = row.count;

    return {
      tasks: { total: Object.values(tasksByStatus).reduce((a, b) => a + b, 0), byStatus: tasksByStatus },
      leases: {
        active: leaseStats.rows[0]?.active ?? 0,
        expiredActive: leaseStats.rows[0]?.expired ?? 0,
      },
      externalOps: {
        inflight: opStats.rows[0]?.inflight ?? 0,
        committed: opStats.rows[0]?.committed ?? 0,
        failedSafeToRetry: opStats.rows[0]?.failed ?? 0,
      },
      prSlot: mapPrSlot(slotRes.rows[0]),
      checkpoints: checkpointCount.rows[0]?.count ?? 0,
      lastReconciliation: reconciliation,
    };
  }

  /* --------------------------------------------------------- checkpoints/results */

  async recordCheckpoint({ taskId, fencingToken, sequence, state = {} }) {
    if (!Number.isInteger(sequence) || sequence <= 0) {
      throw new Error("CHECKPOINT_SEQUENCE_INVALID");
    }
    const inserted = await this.pool.query(
      `INSERT INTO forge_task_checkpoints (task_id, fencing_token, sequence, state)
       SELECT $1, $2, $3, $4::jsonb
        WHERE EXISTS (SELECT 1 FROM forge_tasks WHERE id = $1 AND active_fencing_token = $2)
       ON CONFLICT (task_id, fencing_token, sequence) DO NOTHING
       RETURNING *`,
      [taskId, fencingToken, sequence, JSON.stringify(state)]
    );
    if (inserted.rows[0]) {
      return { ok: true, code: "CHECKPOINT_RECORDED", checkpoint: inserted.rows[0] };
    }
    const task = await this.getTask(taskId);
    if (!task) return { ok: false, code: "TASK_NOT_FOUND" };
    if (Number(task.activeFencingToken) !== Number(fencingToken)) {
      return { ok: false, code: "FENCING_TOKEN_STALE" };
    }
    const existing = await this.pool.query(
      "SELECT * FROM forge_task_checkpoints WHERE task_id = $1 AND fencing_token = $2 AND sequence = $3",
      [taskId, fencingToken, sequence]
    );
    return { ok: true, code: "CHECKPOINT_ALREADY_RECORDED", checkpoint: existing.rows[0] };
  }

  async getLatestCheckpoint(taskId, fencingToken = null) {
    const res = fencingToken
      ? await this.pool.query(
          "SELECT * FROM forge_task_checkpoints WHERE task_id = $1 AND fencing_token = $2 ORDER BY sequence DESC LIMIT 1",
          [taskId, fencingToken]
        )
      : await this.pool.query(
          "SELECT * FROM forge_task_checkpoints WHERE task_id = $1 ORDER BY sequence DESC LIMIT 1",
          [taskId]
        );
    return res.rows[0] ?? null;
  }

  /**
   * Terminal result commit. Only the current fencing token with a live lease may
   * commit; every other attempt is rejected, so a stale worker can never
   * overwrite the holder's outcome.
   */
  async completeTask({ taskId, fencingToken, outcome, result = {} }) {
    if (!["SUCCEEDED", "FAILED"].includes(outcome)) {
      throw new Error("TASK_OUTCOME_INVALID");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const taskRes = await client.query(
        "SELECT * FROM forge_tasks WHERE id = $1 FOR UPDATE",
        [taskId]
      );
      if (taskRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, code: "TASK_NOT_FOUND" };
      }
      const task = taskRes.rows[0];
      if (Number(task.active_fencing_token) !== Number(fencingToken)) {
        await client.query("ROLLBACK");
        return { ok: false, code: "FENCING_TOKEN_STALE" };
      }

      const leaseRes = await client.query(
        `SELECT * FROM forge_worker_leases
          WHERE task_id = $1 AND fencing_token = $2 AND released_at IS NULL
            AND lease_expires_at > clock_timestamp()
          FOR UPDATE`,
        [taskId, fencingToken]
      );
      if (leaseRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, code: "LEASE_NOT_ACTIVE" };
      }
      const lease = leaseRes.rows[0];

      const resultRes = await client.query(
        `INSERT INTO forge_task_results (task_id, worker_id, fencing_token, outcome, result)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (task_id, fencing_token) DO NOTHING
         RETURNING *`,
        [taskId, lease.worker_id, fencingToken, outcome, JSON.stringify(result)]
      );

      let nextStatus;
      if (outcome === "SUCCEEDED") {
        nextStatus = "ACCEPTED";
      } else if (task.attempt_count >= task.max_attempts) {
        nextStatus = "DEAD_LETTER";
      } else {
        nextStatus = "READY";
      }

      const updated = await client.query(
        `UPDATE forge_tasks
            SET status = $2,
                next_run_at = CASE WHEN $2 = 'READY'
                                   THEN clock_timestamp() + (($3 * 60) || ' seconds')::interval
                                   ELSE next_run_at END,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [taskId, nextStatus, Number(task.attempt_count)]
      );

      await client.query(
        `UPDATE forge_worker_leases
            SET released_at = clock_timestamp(), release_reason = $3
          WHERE task_id = $1 AND fencing_token = $2 AND released_at IS NULL`,
        [taskId, fencingToken, outcome === "SUCCEEDED" ? "completed" : "failed"]
      );

      await client.query("COMMIT");
      return {
        ok: true,
        code: "TASK_COMPLETED",
        status: nextStatus,
        result: resultRes.rows[0] ?? null,
        task: mapForgeTask(updated.rows[0]),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listExpiredActiveLeases() {
    const res = await this.pool.query(
      `SELECT l.*, t.derived_branch
         FROM forge_worker_leases l
         JOIN forge_tasks t ON t.id = l.task_id
        WHERE l.released_at IS NULL AND l.lease_expires_at <= clock_timestamp()
        ORDER BY l.lease_expires_at ASC`
    );
    return res.rows.map((row) => ({ ...mapLease(row), derivedBranch: row.derived_branch }));
  }

  /* --------------------------------------------------------------- PR slot (DB) */

  async getPrSlot() {
    const res = await this.pool.query(
      `SELECT *, (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS watchdog_overdue
         FROM forge_pr_slots WHERE slot_id = 1`
    );
    return mapPrSlot(res.rows[0]);
  }

  async reservePrSlot({ taskId, fencingToken, branchName, ttlSeconds = 900 }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const slotRes = await client.query(
        "SELECT * FROM forge_pr_slots WHERE slot_id = 1 FOR UPDATE"
      );
      const slot = slotRes.rows[0];
      const taskRes = await client.query(
        "SELECT * FROM forge_tasks WHERE id = $1 FOR UPDATE",
        [taskId]
      );
      if (taskRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, code: "TASK_NOT_FOUND" };
      }
      if (Number(taskRes.rows[0].active_fencing_token) !== Number(fencingToken)) {
        await client.query("ROLLBACK");
        return { ok: false, code: "FENCING_TOKEN_STALE" };
      }

      if (slot.reserved_by_task_id) {
        const sameHolder =
          slot.reserved_by_task_id === taskId &&
          Number(slot.fencing_token) === Number(fencingToken);
        await client.query("ROLLBACK");
        return sameHolder
          ? { ok: true, code: "PR_SLOT_ALREADY_HELD", slot: mapPrSlot(slot) }
          : { ok: false, code: "ONE_PR_IN_FLIGHT_OCCUPIED", slot: mapPrSlot(slot) };
      }

      const updated = await client.query(
        `UPDATE forge_pr_slots
            SET reserved_by_task_id = $1,
                fencing_token = $2,
                branch_name = $3,
                reserved_at = clock_timestamp(),
                expires_at = clock_timestamp() + ($4 || ' seconds')::interval
          WHERE slot_id = 1
          RETURNING *, (expires_at <= clock_timestamp()) AS watchdog_overdue`,
        [taskId, fencingToken, branchName, String(ttlSeconds)]
      );
      await client.query("COMMIT");
      return { ok: true, code: "PR_SLOT_RESERVED", slot: mapPrSlot(updated.rows[0]) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Release requires authoritative platform state (merged/closed). An expired
   * watchdog timestamp alone is never permission to release an uncertain slot.
   */
  async releasePrSlot({ taskId, fencingToken, prState }) {
    if (!["merged", "closed"].includes(prState)) {
      throw new Error("PR_SLOT_RELEASE_UNCONFIRMED");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const slotRes = await client.query(
        "SELECT * FROM forge_pr_slots WHERE slot_id = 1 FOR UPDATE"
      );
      const slot = slotRes.rows[0];
      if (!slot.reserved_by_task_id) {
        await client.query("ROLLBACK");
        return { ok: false, code: "PR_SLOT_NOT_HELD" };
      }
      if (
        slot.reserved_by_task_id !== taskId ||
        Number(slot.fencing_token) !== Number(fencingToken)
      ) {
        await client.query("ROLLBACK");
        return { ok: false, code: "FENCING_TOKEN_STALE" };
      }
      const updated = await client.query(
        `UPDATE forge_pr_slots
            SET reserved_by_task_id = NULL, fencing_token = NULL, branch_name = NULL,
                pr_number = NULL, reserved_at = NULL, expires_at = NULL
          WHERE slot_id = 1
          RETURNING *, false AS watchdog_overdue`
      );
      await client.query("COMMIT");
      return { ok: true, code: "PR_SLOT_RELEASED", slot: mapPrSlot(updated.rows[0]) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /* -------------------------------------------------- external-operation journal */

  async beginExternalOp({
    idempotencyKey,
    taskId,
    fencingToken,
    operationType,
    targetBranch,
    expectedTreeSha = null,
  }) {
    const taskRes = await this.pool.query(
      "SELECT active_fencing_token FROM forge_tasks WHERE id = $1",
      [taskId]
    );
    if (taskRes.rows.length === 0) return { ok: false, code: "TASK_NOT_FOUND" };
    if (Number(taskRes.rows[0].active_fencing_token) !== Number(fencingToken)) {
      return { ok: false, code: "FENCING_TOKEN_STALE" };
    }

    const inserted = await this.pool.query(
      `INSERT INTO forge_external_ops
         (idempotency_key, task_id, fencing_token, operation_type, target_branch, expected_tree_sha)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [idempotencyKey, taskId, fencingToken, operationType, targetBranch, expectedTreeSha]
    );
    if (inserted.rows[0]) {
      return { ok: true, deduplicated: false, op: mapExternalOp(inserted.rows[0]) };
    }
    const existing = await this.pool.query(
      "SELECT * FROM forge_external_ops WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    return { ok: true, deduplicated: true, op: mapExternalOp(existing.rows[0]) };
  }

  async reconcileExternalOp({ idempotencyKey, observedOnGithub, observedSha = null }) {
    const updated = await this.pool.query(
      `UPDATE forge_external_ops
          SET status = $2, observed_sha = $3, reconciled_at = clock_timestamp()
        WHERE idempotency_key = $1 AND status = 'IN_FLIGHT'
        RETURNING *`,
      [
        idempotencyKey,
        observedOnGithub ? "COMMITTED" : "FAILED_SAFE_TO_RETRY",
        observedSha,
      ]
    );
    if (updated.rows[0]) return { ok: true, op: mapExternalOp(updated.rows[0]) };

    const existing = await this.pool.query(
      "SELECT * FROM forge_external_ops WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    if (!existing.rows[0]) return { ok: false, code: "EXTERNAL_OP_NOT_FOUND" };
    return { ok: true, deduplicated: true, op: mapExternalOp(existing.rows[0]) };
  }

  async listInflightExternalOps() {
    const res = await this.pool.query(
      "SELECT * FROM forge_external_ops WHERE status = 'IN_FLIGHT' ORDER BY created_at ASC"
    );
    return res.rows.map(mapExternalOp);
  }

  /* ------------------------------------------------------------ reconciliation */

  async recordReconciliation({ instanceId, decisions = [], degradedReason = null }) {
    const res = await this.pool.query(
      `INSERT INTO forge_reconciliations (instance_id, finished_at, decisions, degraded_reason)
       VALUES ($1, clock_timestamp(), $2::jsonb, $3)
       RETURNING *`,
      [String(instanceId), JSON.stringify(decisions), degradedReason]
    );
    const row = res.rows[0];
    return {
      id: row.id,
      instanceId: row.instance_id,
      startedAt: asIso(row.started_at),
      finishedAt: asIso(row.finished_at),
      decisions: row.decisions,
      degradedReason: row.degraded_reason,
    };
  }

  async lastReconciliation() {
    const res = await this.pool.query(
      "SELECT * FROM forge_reconciliations ORDER BY started_at DESC LIMIT 1"
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      instanceId: row.instance_id,
      startedAt: asIso(row.started_at),
      finishedAt: asIso(row.finished_at),
      decisions: row.decisions,
      degradedReason: row.degraded_reason,
    };
  }

  /**
   * Provision a non-superuser, NOBYPASSRLS, NOINHERIT Director runtime role
   * (`st_dir_<directorId>`) with scoped DML on `forge_director_isolated_records`.
   */
  async provisionDirectorRuntimeRole(directorId) {
    const roleName = deriveDirectorDbRole(directorId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
            CREATE ROLE ${roleName} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOLOGIN;
          END IF;
        END
        $$;
      `);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON forge_director_isolated_records TO ${roleName}`);
      await client.query("COMMIT");
      return { roleName };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
