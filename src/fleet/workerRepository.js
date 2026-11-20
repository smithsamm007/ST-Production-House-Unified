/**
 * ST Production House — durable worker registry and fenced execution repository
 * (Day 6).
 *
 * This is FORGE's technical custody of Director worker runtimes. It owns:
 *   - registration, capability/stage scope and the worker state machine,
 *   - append-only worker lifecycle audit,
 *   - capability- and scope-checked task claiming through the Day 5 fenced claim,
 *   - lease renewal, lease release, checkpoints and lease-violation records,
 *   - evidence-gated completion and classified failure.
 *
 * It never invents a heartbeat, never promotes a queued task to completed, and
 * never lets a worker act outside its registered Director scope. Task state is
 * always changed by the fenced `PostgresDirectorFleetRepository` operations, not
 * by an unguarded UPDATE from a worker.
 */

import { randomUUID } from "node:crypto";

import { PostgresDirectorFleetRepository } from "./fleetRepository.js";
import { FLEET_ERROR, FleetError, HEARTBEAT_TTL_SECONDS } from "./fleetPolicy.js";
import {
  FAILURE_CLASS,
  STAGE_ERROR,
  classifyFailure,
  validateEvidenceEntry,
} from "../worker/evidenceContract.js";

export const WORKER_STATE = Object.freeze({
  REGISTERED: "REGISTERED",
  STARTING: "STARTING",
  IDLE: "IDLE",
  BUSY: "BUSY",
  DEGRADED: "DEGRADED",
  DRAINING: "DRAINING",
  OFFLINE: "OFFLINE",
  STOPPED: "STOPPED",
});

export const WORKER_STATE_LIST = Object.freeze(Object.values(WORKER_STATE));

/** A runtime that may claim new work. DRAINING/STOPPED/OFFLINE may not. */
export const CLAIMING_STATES = Object.freeze([
  WORKER_STATE.REGISTERED,
  WORKER_STATE.STARTING,
  WORKER_STATE.IDLE,
  WORKER_STATE.BUSY,
  WORKER_STATE.DEGRADED,
]);

export const WORKER_ERROR = Object.freeze({
  WORKER_KEY_INVALID: "WORKER_KEY_INVALID",
  WORKER_INSTANCE_REQUIRED: "WORKER_INSTANCE_REQUIRED",
  WORKER_INSTANCE_MISMATCH: "WORKER_INSTANCE_MISMATCH",
  WORKER_KEY_IN_USE: "WORKER_KEY_IN_USE",
  WORKER_NOT_FOUND: "WORKER_NOT_FOUND",
  WORKER_NOT_CLAIMING: "WORKER_NOT_CLAIMING",
  WORKER_STATE_INVALID: "WORKER_STATE_INVALID",
  WORKER_STATE_TRANSITION_INVALID: "WORKER_STATE_TRANSITION_INVALID",
  WORKER_CAPABILITY_INVALID: "WORKER_CAPABILITY_INVALID",
  WORKER_SCOPE_DENIED: "WORKER_SCOPE_DENIED",
  LEASE_LOST: "LEASE_LOST",
  CHECKPOINT_INVALID: "CHECKPOINT_INVALID",
});

const WORKER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,119}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertWorkerKey(workerKey) {
  if (typeof workerKey !== "string" || !WORKER_KEY.test(workerKey)) {
    throw new FleetError(WORKER_ERROR.WORKER_KEY_INVALID, "A worker key of 2–120 safe characters is required.", 400);
  }
  return workerKey;
}

function assertActor(actor) {
  if (!actor || typeof actor.id !== "string" || actor.id.length === 0) {
    throw new FleetError(FLEET_ERROR.ACTOR_REQUIRED, "An authenticated actor is required.", 401);
  }
  const role = actor.role ?? "SYSTEM";
  if (!["OWNER", "HERMES", "FORGE", "SYSTEM"].includes(role)) {
    throw new FleetError(FLEET_ERROR.ACTOR_REQUIRED, "Unknown actor role.", 403);
  }
  return { id: actor.id, role };
}

function assertCorrelation(correlationId) {
  if (typeof correlationId !== "string" || !UUID.test(correlationId)) {
    throw new FleetError(FLEET_ERROR.CORRELATION_ID_REQUIRED, "A correlation id (UUID) is required.", 400);
  }
  return correlationId;
}

/** Legal worker state transitions. Anything not listed is refused. */
export const WORKER_TRANSITIONS = Object.freeze({
  REGISTERED: Object.freeze(["STARTING", "IDLE", "DRAINING", "OFFLINE", "STOPPED"]),
  STARTING: Object.freeze(["IDLE", "BUSY", "DEGRADED", "DRAINING", "OFFLINE", "STOPPED"]),
  IDLE: Object.freeze(["BUSY", "DEGRADED", "DRAINING", "OFFLINE", "STOPPED"]),
  BUSY: Object.freeze(["IDLE", "DEGRADED", "DRAINING", "OFFLINE", "STOPPED"]),
  DEGRADED: Object.freeze(["IDLE", "BUSY", "DRAINING", "OFFLINE", "STOPPED"]),
  DRAINING: Object.freeze(["IDLE", "STOPPED", "OFFLINE", "REGISTERED"]),
  OFFLINE: Object.freeze(["REGISTERED", "STARTING", "IDLE", "STOPPED"]),
  STOPPED: Object.freeze(["REGISTERED", "STARTING"]),
});

export class PostgresDirectorWorkerRepository {
  constructor(pool, { fleet = null, heartbeatTtlSeconds = HEARTBEAT_TTL_SECONDS } = {}) {
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
      throw new Error("DIRECTOR_WORKER_POOL_REQUIRED");
    }
    this.pool = pool;
    this.fleet = fleet ?? new PostgresDirectorFleetRepository(pool);
    this.heartbeatTtlSeconds = heartbeatTtlSeconds;
  }

  async _audit(client, { workerKey, action, previousState = null, newState = null, reason, actor, correlationId, detail = {} }) {
    await client.query(
      `INSERT INTO director_worker_events
         (worker_key, action, previous_state, new_state, reason, actor_id, actor_role, correlation_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [workerKey, action, previousState, newState, reason, actor.id, actor.role, correlationId, JSON.stringify(detail ?? {})]
    );
  }

  workerDto(row) {
    return Object.freeze({
      workerKey: row.worker_key,
      workerType: row.worker_type,
      instanceId: row.instance_id,
      runtimeInstanceId: row.runtime_instance_id ?? row.instance_id,
      role: row.role,
      state: row.state,
      status: row.status,
      stageTypes: row.stage_types ?? [],
      capabilities: row.capabilities ?? [],
      directorScope: row.director_scope ?? [],
      configVersion: Number(row.config_version ?? 1),
      currentTaskId: row.current_task_id ?? null,
      currentDirectorId: row.current_director_id ?? null,
      lastHeartbeatAt: iso(row.last_heartbeat_at),
      heartbeatAgeSeconds: row.age_seconds === undefined ? null : Number(row.age_seconds),
      registeredAt: iso(row.registered_at),
      lastCompletedTaskId: row.last_completed_task_id ?? null,
      lastCompletedAt: iso(row.last_completed_at),
      lastFailureAt: iso(row.last_failure_at),
      lastFailure: row.last_failure ?? null,
      failureCount: Number(row.failure_count ?? 0),
      leaseViolationCount: Number(row.lease_violation_count ?? 0),
      restartRequestedAt: iso(row.restart_requested_at),
      drainedAt: iso(row.drained_at),
      stoppedAt: iso(row.stopped_at),
      metadata: row.metadata ?? {},
    });
  }

  /**
   * Durable registration. Re-registering the same runtime is idempotent; a
   * different instance claiming a live worker key is refused, so two processes
   * can never share one lease identity.
   */
  async registerWorker({
    workerKey,
    workerType = "production_worker",
    instanceId,
    runtimeInstanceId = null,
    role = "production",
    stageTypes = [],
    capabilities = [],
    directorScope = [],
    configVersion = 1,
    metadata = {},
    actor = { id: "forge", role: "FORGE" },
    correlationId = randomUUID(),
    reason = "Worker runtime registered",
  }) {
    assertWorkerKey(workerKey);
    if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 200) {
      throw new FleetError(WORKER_ERROR.WORKER_INSTANCE_REQUIRED, "A runtime instance id is required.", 400);
    }
    assertActor(actor);
    assertCorrelation(correlationId);

    return this.fleet._tx(async (client) => {
      const existing = await client.query(
        `SELECT *, EXTRACT(EPOCH FROM (clock_timestamp() - last_heartbeat_at))::int AS age_seconds
           FROM director_workers WHERE worker_key = $1 FOR UPDATE`,
        [workerKey]
      );
      const row = existing.rows[0];
      if (row && row.instance_id !== instanceId) {
        const live = Number(row.age_seconds ?? 0) <= this.heartbeatTtlSeconds && ![WORKER_STATE.OFFLINE, WORKER_STATE.STOPPED].includes(row.state);
        if (live) {
          throw new FleetError(
            WORKER_ERROR.WORKER_KEY_IN_USE,
            "That worker key belongs to a live runtime with a different instance id.",
            409
          );
        }
      }

      const upsert = await client.query(
        `INSERT INTO director_workers
           (worker_key, instance_id, role, status, metadata, worker_type, runtime_instance_id,
            stage_types, capabilities, director_scope, state, config_version, registered_at,
            last_heartbeat_at, drained_at, stopped_at, restart_requested_at)
         VALUES ($1, $2, $3, 'active', $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                 'REGISTERED', $10, clock_timestamp(), clock_timestamp(), NULL, NULL, NULL)
         ON CONFLICT (worker_key) DO UPDATE
           SET instance_id = EXCLUDED.instance_id,
               role = EXCLUDED.role,
               status = 'active',
               state = 'REGISTERED',
               worker_type = EXCLUDED.worker_type,
               runtime_instance_id = EXCLUDED.runtime_instance_id,
               stage_types = EXCLUDED.stage_types,
               capabilities = EXCLUDED.capabilities,
               director_scope = EXCLUDED.director_scope,
               config_version = EXCLUDED.config_version,
               metadata = EXCLUDED.metadata,
               last_heartbeat_at = clock_timestamp(),
               drained_at = NULL,
               stopped_at = NULL,
               restart_requested_at = NULL
         RETURNING *, 0 AS age_seconds`,
        [
          workerKey,
          instanceId,
          role,
          JSON.stringify(metadata ?? {}),
          workerType,
          runtimeInstanceId ?? instanceId,
          JSON.stringify(stageTypes ?? []),
          JSON.stringify(capabilities ?? []),
          JSON.stringify(directorScope ?? []),
          Math.max(1, Number(configVersion) || 1),
        ]
      );

      await this._audit(client, {
        workerKey,
        action: row ? "WORKER_REREGISTERED" : "WORKER_REGISTERED",
        previousState: row?.state ?? null,
        newState: WORKER_STATE.REGISTERED,
        reason,
        actor,
        correlationId,
        detail: { workerType, stageTypes, capabilities, directorScope, configVersion },
      });
      return { registered: !row, duplicate: Boolean(row), worker: this.workerDto(upsert.rows[0]) };
    });
  }

  async getWorker(workerKey) {
    assertWorkerKey(workerKey);
    const { rows } = await this.pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (clock_timestamp() - last_heartbeat_at))::int AS age_seconds
         FROM director_workers WHERE worker_key = $1`,
      [workerKey]
    );
    return rows[0] ? this.workerDto(rows[0]) : null;
  }

  async listWorkers({ ttlSeconds = this.heartbeatTtlSeconds } = {}) {
    const ttl = Math.max(1, Number(ttlSeconds) || this.heartbeatTtlSeconds);
    const { rows } = await this.pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (clock_timestamp() - last_heartbeat_at))::int AS age_seconds
         FROM director_workers ORDER BY worker_key ASC`
    );
    return rows.map((row) => ({
      ...this.workerDto(row),
      expired: Number(row.age_seconds ?? 0) > ttl,
      online:
        ![WORKER_STATE.OFFLINE, WORKER_STATE.STOPPED].includes(row.state) && Number(row.age_seconds ?? 0) <= ttl,
    }));
  }

  async workerHistory({ workerKey, limit = 50 }) {
    assertWorkerKey(workerKey);
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    const { rows } = await this.pool.query(
      `SELECT * FROM director_worker_events
        WHERE worker_key = $1 ORDER BY created_at DESC, id ASC LIMIT ${bounded}`,
      [workerKey]
    );
    return rows.map((row) => ({
      eventId: row.id,
      workerKey: row.worker_key,
      action: row.action,
      previousState: row.previous_state,
      newState: row.new_state,
      reason: row.reason,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      correlationId: row.correlation_id,
      detail: row.detail,
      createdAt: iso(row.created_at),
    }));
  }

  /** Heartbeat is a database-clock fact, not a claim about the process. */
  async heartbeat({ workerKey, instanceId, state = null, metadata = null }) {
    assertWorkerKey(workerKey);
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new FleetError(WORKER_ERROR.WORKER_INSTANCE_REQUIRED, "A runtime instance id is required.", 400);
    }
    const current = await this.getWorker(workerKey);
    if (!current) throw new FleetError(WORKER_ERROR.WORKER_NOT_FOUND, "Worker is not registered.", 404);
    if (current.instanceId !== instanceId) {
      throw new FleetError(WORKER_ERROR.WORKER_INSTANCE_MISMATCH, "The heartbeat instance does not own this worker key.", 409);
    }
    const nextState = state ?? current.state;
    if (!WORKER_STATE_LIST.includes(nextState)) {
      throw new FleetError(WORKER_ERROR.WORKER_STATE_INVALID, "Unknown worker state.", 400);
    }
    if (nextState !== current.state && !(WORKER_TRANSITIONS[current.state] ?? []).includes(nextState)) {
      throw new FleetError(
        WORKER_ERROR.WORKER_STATE_TRANSITION_INVALID,
        `Worker transition ${current.state} -> ${nextState} is not permitted.`,
        409
      );
    }
    const { rows } = await this.pool.query(
      `UPDATE director_workers
          SET last_heartbeat_at = clock_timestamp(),
              state = $2,
              status = CASE WHEN $2 IN ('DRAINING') THEN 'draining'
                            WHEN $2 IN ('OFFLINE','STOPPED') THEN 'offline'
                            ELSE 'active' END,
              metadata = COALESCE($3::jsonb, metadata)
        WHERE worker_key = $1
        RETURNING *, 0 AS age_seconds`,
      [workerKey, nextState, metadata ? JSON.stringify(metadata) : null]
    );
    return { ...this.workerDto(rows[0]), restartRequested: Boolean(rows[0].restart_requested_at) };
  }

  async setState({ workerKey, state, reason, actor = { id: "forge", role: "FORGE" }, correlationId = randomUUID() }) {
    assertWorkerKey(workerKey);
    assertActor(actor);
    assertCorrelation(correlationId);
    if (!WORKER_STATE_LIST.includes(state)) {
      throw new FleetError(WORKER_ERROR.WORKER_STATE_INVALID, "Unknown worker state.", 400);
    }
    return this.fleet._tx(async (client) => {
      const { rows } = await client.query("SELECT * FROM director_workers WHERE worker_key = $1 FOR UPDATE", [workerKey]);
      const row = rows[0];
      if (!row) throw new FleetError(WORKER_ERROR.WORKER_NOT_FOUND, "Worker is not registered.", 404);
      if (row.state === state) return this.workerDto(row);
      if (!(WORKER_TRANSITIONS[row.state] ?? []).includes(state)) {
        throw new FleetError(
          WORKER_ERROR.WORKER_STATE_TRANSITION_INVALID,
          `Worker transition ${row.state} -> ${state} is not permitted.`,
          409
        );
      }
      const updated = await client.query(
        `UPDATE director_workers
            SET state = $2,
                status = CASE WHEN $2 = 'DRAINING' THEN 'draining'
                              WHEN $2 IN ('OFFLINE','STOPPED') THEN 'offline'
                              ELSE 'active' END,
                drained_at = CASE WHEN $2 = 'DRAINING' THEN clock_timestamp() ELSE drained_at END,
                stopped_at = CASE WHEN $2 = 'STOPPED' THEN clock_timestamp() ELSE stopped_at END
          WHERE worker_key = $1
          RETURNING *, 0 AS age_seconds`,
        [workerKey, state]
      );
      await this._audit(client, {
        workerKey,
        action: "WORKER_STATE_CHANGED",
        previousState: row.state,
        newState: state,
        reason,
        actor,
        correlationId,
      });
      return this.workerDto(updated.rows[0]);
    });
  }

  /** Owner-requested drain: the runtime stops claiming and finishes in-flight work. */
  async drain({ workerKey, reason = "Owner requested drain", actor, correlationId = randomUUID() }) {
    assertWorkerKey(workerKey);
    assertActor(actor);
    assertCorrelation(correlationId);
    const worker = await this.getWorker(workerKey);
    if (!worker) throw new FleetError(WORKER_ERROR.WORKER_NOT_FOUND, "Worker is not registered.", 404);
    const drained = await this.setState({ workerKey, state: WORKER_STATE.DRAINING, reason, actor, correlationId });
    const { rows } = await this.pool.query(
      `UPDATE director_workers SET restart_requested_at = NULL WHERE worker_key = $1
       RETURNING restart_requested_at`,
      [workerKey]
    );
    return { worker: { ...drained, restartRequestedAt: iso(rows[0]?.restart_requested_at) } };
  }

  /**
   * Record a durable restart request. A live runtime sees it on its next
   * heartbeat and shuts down gracefully; this is not a process kill and does not
   * pretend the worker is already stopped.
   */
  async requestRestart({ workerKey, reason = "Owner requested restart", actor, correlationId = randomUUID() }) {
    assertWorkerKey(workerKey);
    assertActor(actor);
    assertCorrelation(correlationId);
    return this.fleet._tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE director_workers SET restart_requested_at = clock_timestamp()
          WHERE worker_key = $1 RETURNING *`,
        [workerKey]
      );
      if (!rows[0]) throw new FleetError(WORKER_ERROR.WORKER_NOT_FOUND, "Worker is not registered.", 404);
      await this._audit(client, {
        workerKey,
        action: "WORKER_RESTART_REQUESTED",
        previousState: rows[0].state,
        newState: rows[0].state,
        reason,
        actor,
        correlationId,
      });
      return { workerKey, restartRequestedAt: iso(rows[0].restart_requested_at) };
    });
  }

  // ------------------------------------------------------------------ claiming

  /**
   * Capability-, state- and scope-checked claim. The actual atomic claim is the
   * Day 5 fenced claim (SKIP LOCKED + unique active lease); this method only
   * decides whether this worker is allowed to ask.
   */
  async claimTask({ workerKey, leaseSeconds = 60, directorId = null, maxPerDirector = null }) {
    assertWorkerKey(workerKey);
    const worker = await this.getWorker(workerKey);
    if (!worker) throw new FleetError(WORKER_ERROR.WORKER_NOT_FOUND, "Worker is not registered.", 404);
    if (!CLAIMING_STATES.includes(worker.state)) {
      return { claimed: false, reason: WORKER_ERROR.WORKER_NOT_CLAIMING, workerState: worker.state };
    }
    if (worker.expired) {
      throw new FleetError(WORKER_ERROR.WORKER_NOT_CLAIMING, "Worker heartbeat expired; re-register before claiming.", 409);
    }
    if (directorId && worker.directorScope.length > 0 && !worker.directorScope.includes(directorId)) {
      throw new FleetError(WORKER_ERROR.WORKER_SCOPE_DENIED, "This worker is not scoped to that Director.", 403);
    }
    const effectiveDirector = directorId ?? (worker.directorScope.length === 1 ? worker.directorScope[0] : null);
    const claim = await this.fleet.claimTask({
      workerKey,
      leaseSeconds,
      directorId: effectiveDirector,
      allowedStages: worker.stageTypes,
      requireActiveDirector: true,
      maxPerActivePerDirector: maxPerDirector,
      directorScope: worker.directorScope,
    });
    if (claim?.claimed) {
      await this.pool.query(
        `UPDATE director_workers
            SET state = 'BUSY', status = 'active', current_task_id = $2, current_director_id = $3,
                last_heartbeat_at = clock_timestamp()
          WHERE worker_key = $1`,
        [workerKey, claim.task.taskId, claim.task.directorId]
      );
    }
    return claim;
  }

  async renewLease({ workerKey, taskId, fencingToken, leaseSeconds = 60 }) {
    assertWorkerKey(workerKey);
    if (typeof taskId !== "string" || !UUID.test(taskId)) {
      throw new FleetError(FLEET_ERROR.TASK_NOT_FOUND, "Task not found.", 404);
    }
    const lease = Math.max(5, Math.min(3600, Number(leaseSeconds) || 60));
    const { rows } = await this.pool.query(
      `UPDATE director_task_leases
          SET lease_expires_at = clock_timestamp() + ($4::int * interval '1 second')
        WHERE task_id = $1
          AND worker_key = $2
          AND fencing_token = $3
          AND released_at IS NULL
          AND lease_expires_at > clock_timestamp()
        RETURNING lease_expires_at, fencing_token`,
      [taskId, workerKey, Number(fencingToken), lease]
    );
    if (!rows[0]) {
      await this.recordLeaseViolation({
        taskId,
        workerKey,
        presentedToken: Number(fencingToken),
        code: WORKER_ERROR.LEASE_LOST,
        detail: "Lease renewal refused: lease lost, expired or owned by another worker.",
      });
      throw new FleetError(WORKER_ERROR.LEASE_LOST, "Lease renewal refused: the lease is no longer valid.", 409);
    }
    return { taskId, fencingToken: Number(rows[0].fencing_token), leaseExpiresAt: iso(rows[0].lease_expires_at) };
  }

  async releaseLease({ taskId, workerKey, fencingToken, reason = "restart" }) {
    if (!["completed", "expired", "cancelled", "failed", "reclaimed", "restart"].includes(reason)) {
      throw new FleetError(WORKER_ERROR.LEASE_LOST, "Unknown lease release reason.", 400);
    }
    const { rows } = await this.pool.query(
      `UPDATE director_task_leases
          SET released_at = clock_timestamp(), release_reason = $4
        WHERE task_id = $1 AND worker_key = $2 AND fencing_token = $3 AND released_at IS NULL
        RETURNING task_id`,
      [taskId, workerKey, Number(fencingToken), reason]
    );
    if (rows[0] && workerKey) {
      await this.pool.query(
        `UPDATE director_workers
            SET current_task_id = NULL, current_director_id = NULL,
                state = CASE WHEN state = 'BUSY' THEN 'IDLE' ELSE state END,
                last_heartbeat_at = clock_timestamp()
          WHERE worker_key = $1 AND current_task_id = $2`,
        [workerKey, taskId]
      );
    }
    return { released: Boolean(rows[0]) };
  }

  async recordLeaseViolation({ taskId, workerKey = null, presentedToken = null, activeToken = null, code, detail }) {
    try {
      await this.pool.query(
        `INSERT INTO director_lease_violations (task_id, worker_key, presented_token, active_token, code, detail)
         VALUES ($1, $2, $3, $4, $5, left($6, 300))`,
        [taskId ?? null, workerKey, presentedToken, activeToken, code, String(detail ?? code)]
      );
      if (workerKey) {
        await this.pool.query(
          "UPDATE director_workers SET lease_violation_count = lease_violation_count + 1 WHERE worker_key = $1",
          [workerKey]
        );
      }
    } catch {
      // The violation ledger must never mask the refusal it describes.
    }
  }

  // --------------------------------------------------------------- checkpoints

  async writeCheckpoint({ taskId, workerKey, fencingToken, key, payload = {} }) {
    if (typeof key !== "string" || key.length === 0 || key.length > 120) {
      throw new FleetError(WORKER_ERROR.CHECKPOINT_INVALID, "A checkpoint key of 1–120 characters is required.", 400);
    }
    const lease = await this.pool.query(
      `SELECT fencing_token FROM director_task_leases
        WHERE task_id = $1 AND worker_key = $2 AND fencing_token = $3
          AND released_at IS NULL AND lease_expires_at > clock_timestamp()`,
      [taskId, workerKey, Number(fencingToken)]
    );
    if (!lease.rows[0]) {
      throw new FleetError(WORKER_ERROR.LEASE_LOST, "Checkpoint refused: the lease is no longer valid.", 409);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO director_task_checkpoints (task_id, worker_key, fencing_token, checkpoint_key, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (task_id, checkpoint_key) DO NOTHING
       RETURNING *`,
      [taskId, workerKey, Number(fencingToken), key, JSON.stringify(payload ?? {})]
    );
    if (rows[0]) {
      await this.pool.query("UPDATE director_tasks SET last_checkpoint_key = $2, updated_at = clock_timestamp() WHERE id = $1", [
        taskId,
        key,
      ]);
      return { created: true, checkpoint: this.#checkpointDto(rows[0]) };
    }
    const existing = await this.pool.query(
      "SELECT * FROM director_task_checkpoints WHERE task_id = $1 AND checkpoint_key = $2",
      [taskId, key]
    );
    return { created: false, checkpoint: existing.rows[0] ? this.#checkpointDto(existing.rows[0]) : null };
  }

  #checkpointDto(row) {
    return Object.freeze({
      checkpointId: row.id,
      taskId: row.task_id,
      workerKey: row.worker_key,
      fencingToken: Number(row.fencing_token),
      key: row.checkpoint_key,
      payload: row.payload ?? {},
      createdAt: iso(row.created_at),
    });
  }

  async listCheckpoints(taskId) {
    if (typeof taskId !== "string" || !UUID.test(taskId)) return [];
    const { rows } = await this.pool.query(
      "SELECT * FROM director_task_checkpoints WHERE task_id = $1 ORDER BY created_at ASC",
      [taskId]
    );
    return rows.map((row) => this.#checkpointDto(row));
  }

  async latestCheckpoint(taskId) {
    if (typeof taskId !== "string" || !UUID.test(taskId)) return null;
    const { rows } = await this.pool.query(
      "SELECT * FROM director_task_checkpoints WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1",
      [taskId]
    );
    return rows[0] ? this.#checkpointDto(rows[0]) : null;
  }

  // ------------------------------------------------------- completion/failure

  /** Completion must pass the evidence contract; a fenced refusal is recorded. */
  async completeTask({
    directorId,
    taskId,
    workerKey,
    fencingToken,
    resultRef,
    evidence = [],
    allowTestFixtures = false,
    correlationId = randomUUID(),
  }) {
    for (const entry of evidence) {
      const check = validateEvidenceEntry(entry);
      if (!check.ok) {
        throw new FleetError("TASK_EVIDENCE_INVALID", check.errors.join("; "), 400);
      }
    }
    try {
      const task = await this.fleet.completeTask({
        directorId,
        taskId,
        workerKey,
        fencingToken,
        resultRef,
        evidence,
        allowTestFixtures,
        correlationId,
      });
      if (workerKey) {
        await this.pool.query(
          `UPDATE director_workers
              SET state = CASE WHEN state IN ('DRAINING','OFFLINE','STOPPED') THEN state ELSE 'IDLE' END,
                  current_task_id = NULL,
                  current_director_id = NULL,
                  last_completed_task_id = $2,
                  last_completed_at = clock_timestamp(),
                  last_heartbeat_at = clock_timestamp()
            WHERE worker_key = $1`,
          [workerKey, taskId]
        );
      }
      return task;
    } catch (error) {
      if (["TASK_FENCING_TOKEN_STALE", "TASK_LEASE_NOT_ACTIVE", FLEET_ERROR.TASK_FENCING_TOKEN_STALE, FLEET_ERROR.TASK_LEASE_NOT_ACTIVE].includes(error?.code)) {
        await this.recordLeaseViolation({
          taskId,
          workerKey,
          presentedToken: Number(fencingToken),
          code: error.code,
          detail: "Fenced completion refused: stale token or inactive lease.",
        });
        await this.pool.query("UPDATE director_workers SET current_task_id = NULL, current_director_id = NULL WHERE worker_key = $1", [
          workerKey,
        ]);
      }
      throw error;
    }
  }

  /**
   * Classified failure. A provider condition blocks with a cooldown and does not
   * consume an attempt; a permanent validation failure is terminal immediately.
   */
  async failTask({
    directorId,
    taskId,
    workerKey,
    fencingToken,
    error = "STAGE_EXECUTION_FAILED",
    retryable = null,
    cooldownSeconds = 900,
    correlationId = randomUUID(),
  }) {
    const classification = classifyFailure(error, { retryable });
    try {
      if (classification.failureClass === FAILURE_CLASS.PROVIDER) {
        await this.pool.query(
          `UPDATE director_task_leases SET released_at = clock_timestamp(), release_reason = 'failed'
            WHERE task_id = $1 AND worker_key = $2 AND fencing_token = $3 AND released_at IS NULL`,
          [taskId, workerKey, Number(fencingToken)]
        );
        const blocked = await this.fleet.markProviderBlocked({
          directorId,
          taskId,
          providerState: classification.providerState,
          cooldownSeconds,
          detail: String(error),
        });
        await this.#recordWorkerFailure(workerKey, taskId, error);
        return { task: blocked, classification, blocked: true };
      }
      const task = await this.fleet.failTask({
        directorId,
        taskId,
        workerKey,
        fencingToken,
        error,
        retryable: classification.retryable,
        correlationId,
      });
      await this.#recordWorkerFailure(workerKey, taskId, error, task.status === "DEAD_LETTER");
      return { task, classification, blocked: false };
    } catch (caught) {
      if ([FLEET_ERROR.TASK_FENCING_TOKEN_STALE, FLEET_ERROR.TASK_LEASE_NOT_ACTIVE].includes(caught?.code)) {
        await this.recordLeaseViolation({
          taskId,
          workerKey,
          presentedToken: Number(fencingToken),
          code: caught.code,
          detail: "Fenced failure report refused: stale token or inactive lease.",
        });
      }
      throw caught;
    }
  }

  async #recordWorkerFailure(workerKey, taskId, error, deadLetter = false) {
    if (!workerKey) return;
    await this.pool.query(
      `UPDATE director_workers
          SET state = CASE WHEN state IN ('DRAINING','OFFLINE','STOPPED') THEN state
                           WHEN $3::boolean THEN 'DEGRADED' ELSE 'IDLE' END,
              current_task_id = NULL,
              current_director_id = NULL,
              failure_count = failure_count + 1,
              last_failure_at = clock_timestamp(),
              last_failure = left($2, 300),
              last_heartbeat_at = clock_timestamp()
        WHERE worker_key = $1`,
      [workerKey, String(error), deadLetter]
    );
    await this.pool.query(
      "INSERT INTO director_worker_events (worker_key, action, reason, actor_id, actor_role, correlation_id, detail) VALUES ($1, 'WORKER_TASK_FAILED', left($2,300), 'worker', 'SYSTEM', gen_random_uuid(), $3::jsonb)",
      [workerKey, String(error), JSON.stringify({ taskId, deadLetter })]
    ).catch(() => {});
  }

  /** Durable marker that a handler actually began (queueing is not starting). */
  async recordExecutionStarted({ workerKey, taskId, stage, fencingToken }) {
    try {
      await this.pool.query(
        `INSERT INTO director_worker_events
           (worker_key, action, reason, actor_id, actor_role, correlation_id, detail)
         VALUES ($1, 'WORKER_TASK_STARTED', $2, 'worker', 'SYSTEM', gen_random_uuid(), $3::jsonb)`,
        [workerKey, `Executing stage ${stage}`, JSON.stringify({ taskId, stage, fencingToken: Number(fencingToken) })]
      );
      return true;
    } catch {
      // Execution must not be blocked by an audit insert failure; the metric is
      // then simply lower than reality, never higher.
      return false;
    }
  }

  // ------------------------------------------------------------- supervision

  async listDeadLetters({ directorId = null, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    const { rows } = await this.pool.query(
      `SELECT id, director_id, project_id, stage, status, attempt_count, max_attempts,
              last_error, blocked_reason, updated_at
         FROM director_tasks
        WHERE status = 'DEAD_LETTER'
          AND ($1::text IS NULL OR director_id = $1)
        ORDER BY updated_at DESC
        LIMIT ${bounded}`,
      [directorId]
    );
    return rows.map((row) => ({
      taskId: row.id,
      directorId: row.director_id,
      projectId: row.project_id,
      stage: row.stage,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      lastError: row.last_error,
      blockedReason: row.blocked_reason,
      updatedAt: iso(row.updated_at),
    }));
  }

  /** Every count below is a GROUP BY over durable rows — never an estimate. */
  async metrics({ ttlSeconds = this.heartbeatTtlSeconds } = {}) {
    const ttl = Math.max(1, Number(ttlSeconds) || this.heartbeatTtlSeconds);
    const [workers, workerStates, tasks, leases, evidence, providerBlocked, perDirector, oldestPending, started] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE state NOT IN ('OFFLINE','STOPPED')
                                   AND last_heartbeat_at > clock_timestamp() - ($1::int * interval '1 second'))::int AS online,
                count(*) FILTER (WHERE state = 'BUSY')::int AS busy,
                count(*) FILTER (WHERE state = 'DRAINING')::int AS draining,
                count(*) FILTER (WHERE state IN ('OFFLINE','STOPPED')
                                    OR last_heartbeat_at <= clock_timestamp() - ($1::int * interval '1 second'))::int AS offline,
                count(*) FILTER (WHERE state = 'DEGRADED')::int AS degraded,
                coalesce(sum(failure_count), 0)::int AS failures,
                coalesce(sum(lease_violation_count), 0)::int AS lease_violation_count
           FROM director_workers`,
        [ttl]
      ),
      this.pool.query("SELECT state, count(*)::int AS count FROM director_workers GROUP BY state"),
      this.pool.query(
        `SELECT coalesce(sum(claim_count), 0)::int AS claimed,
                count(*) FILTER (WHERE status = 'COMPLETED' AND claim_count > 0)::int AS completed,
                count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_total,
                count(*) FILTER (WHERE attempt_count > 1)::int AS retried,
                count(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_lettered,
                count(*) FILTER (WHERE last_error IS NOT NULL AND status IN ('RETRY_SCHEDULED','DEAD_LETTER','FAILED'))::int AS failed,
                count(*) FILTER (WHERE status IN ('QUEUED','RETRY_SCHEDULED'))::int AS queued,
                count(*) FILTER (WHERE status = 'RUNNING')::int AS running
           FROM director_tasks`
      ),
      this.pool.query(
        `SELECT count(*) FILTER (WHERE released_at IS NULL)::int AS active,
                count(*) FILTER (WHERE release_reason IN ('expired','reclaimed','restart'))::int AS recovered
           FROM director_task_leases`
      ),
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE test_fixture = FALSE)::int AS production_eligible,
                count(*) FILTER (WHERE test_fixture = TRUE)::int AS test_fixtures,
                count(DISTINCT stage)::int AS stage_types
           FROM director_task_evidence
          WHERE handler_name IS NOT NULL`
      ),
      this.pool.query(
        `SELECT count(*)::int AS count FROM director_tasks
          WHERE provider_state IN ('UNAVAILABLE','QUOTA_EXHAUSTED')
            AND status NOT IN ('COMPLETED','CANCELLED')`
      ),
      this.pool.query(
        `SELECT director_id,
                count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
                count(*) FILTER (WHERE status IN ('RUNNING','QUEUED','RETRY_SCHEDULED'))::int AS in_flight,
                count(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_lettered
           FROM director_tasks GROUP BY director_id ORDER BY director_id`
      ),
      this.pool.query(
        `SELECT max(EXTRACT(EPOCH FROM (clock_timestamp() - next_run_at)))::int AS seconds
           FROM director_tasks WHERE status IN ('QUEUED','RETRY_SCHEDULED')`
      ),
      this.pool.query(
        `SELECT count(*)::int AS count,
                count(DISTINCT detail->>'stage')::int AS stage_types
           FROM director_worker_events WHERE action = 'WORKER_TASK_STARTED'`
      ),
    ]);
    const violations = await this.pool.query("SELECT count(*)::int AS count FROM director_lease_violations");
    const stageTypes = await this.pool.query(
      "SELECT DISTINCT stage FROM director_task_evidence WHERE handler_name IS NOT NULL ORDER BY stage"
    );
    return {
      generatedAt: new Date().toISOString(),
      heartbeatTtlSeconds: ttl,
      workers: {
        registered: Number(workers.rows[0]?.total ?? 0),
        online: Number(workers.rows[0]?.online ?? 0),
        offline: Number(workers.rows[0]?.offline ?? 0),
        busy: Number(workers.rows[0]?.busy ?? 0),
        draining: Number(workers.rows[0]?.draining ?? 0),
        degraded: Number(workers.rows[0]?.degraded ?? 0),
        recordedFailureCount: Number(workers.rows[0]?.failures ?? 0),
        byState: Object.fromEntries(workerStates.rows.map((row) => [row.state, Number(row.count)])),
      },
      tasks: {
        claimed: Number(tasks.rows[0]?.claimed ?? 0),
        running: Number(tasks.rows[0]?.running ?? 0),
        completed: Number(tasks.rows[0]?.completed ?? 0),
        completedTotal: Number(tasks.rows[0]?.completed_total ?? 0),
        failed: Number(tasks.rows[0]?.failed ?? 0),
        retried: Number(tasks.rows[0]?.retried ?? 0),
        deadLettered: Number(tasks.rows[0]?.dead_lettered ?? 0),
        queued: Number(tasks.rows[0]?.queued ?? 0),
        recoveredAfterRestart: Number(leases.rows[0]?.recovered ?? 0),
        handlerStarted: Number(started.rows[0]?.count ?? 0),
        handlerStartedStageTypes: Number(started.rows[0]?.stage_types ?? 0),
        activeLeases: Number(leases.rows[0]?.active ?? 0),
        providerBlocked: Number(providerBlocked.rows[0]?.count ?? 0),
        oldestPendingSeconds:
          oldestPending.rows[0]?.seconds === null || oldestPending.rows[0]?.seconds === undefined
            ? null
            : Number(oldestPending.rows[0].seconds),
      },
      evidence: {
        records: Number(evidence.rows[0]?.total ?? 0),
        productionEligible: Number(evidence.rows[0]?.production_eligible ?? 0),
        testFixtures: Number(evidence.rows[0]?.test_fixtures ?? 0),
        stageTypesExecuted: stageTypes.rows.map((row) => row.stage),
      },
      leaseViolations: {
        recorded: Number(violations.rows[0]?.count ?? 0),
        workerCounters: Number(workers.rows[0]?.lease_violation_count ?? 0),
      },
      perDirector: perDirector.rows.map((row) => ({
        directorId: row.director_id,
        completed: Number(row.completed),
        inFlight: Number(row.in_flight),
        deadLettered: Number(row.dead_lettered),
      })),
    };
  }
}

export { UUID as WORKER_TASK_UUID_PATTERN, STAGE_ERROR };
