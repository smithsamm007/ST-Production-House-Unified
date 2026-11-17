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
      return { deduplicated: true, task: existing.rows[0] };
    }
    const inserted = await this.pool.query(
      `INSERT INTO forge_tasks (issue_number, derived_branch, title, idempotency_key, max_attempts)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [Number(issueNumber), derivedBranch, String(title), idempotencyKey, maxAttempts]
    );
    return { deduplicated: false, task: inserted.rows[0] };
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
        return { ok: false, code: "LEASE_ALREADY_ACTIVE", activeLease: activeRes.rows[0] };
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
      return { ok: true, code: "LEASE_ACQUIRED", fencingToken: nextToken, lease: leaseRes.rows[0] };
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
