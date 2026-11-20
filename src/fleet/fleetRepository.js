/**
 * ST Production House — Director fleet repository (Day 5 / D7).
 *
 * Durable PostgreSQL custody for:
 *   - the Director fleet registry and its append-only audit history,
 *   - Director-owned projects, production tasks, dependencies, fenced leases and
 *     stage evidence,
 *   - registered worker runtimes and their heartbeats,
 *   - fleet escalations.
 *
 * Isolation contract
 * ------------------
 * Every Director-scoped read and write takes an explicit `directorId` and adds
 * `director_id = $n` to the SQL. A caller that asks for another Director's row
 * receives `null` / `TASK_NOT_FOUND` / `PROJECT_NOT_FOUND` — "not found" and
 * "not yours" are indistinguishable, exactly like the Director communication
 * routes. The database independently enforces the same boundary through FORCE
 * ROW LEVEL SECURITY bound to `current_user` (sql/045 + sql/039).
 *
 * Concurrency contract
 * --------------------
 * Claims use `FOR UPDATE SKIP LOCKED`; at-most-one active lease per task is a
 * partial unique index; completion and checkpoints are fenced by a monotonically
 * increasing token, and a stale token is rejected rather than silently applied.
 * All lease/expiry comparisons use `clock_timestamp()`; application clocks are
 * never trusted.
 */

import { randomUUID } from "node:crypto";

import {
  DIRECTOR_LIFECYCLE_STATES,
  FLEET_CAPACITY,
  FLEET_ERROR,
  FleetError,
  WORK_CAPABLE_STATES,
  assertActor,
  assertCorrelationId,
  assertDependencyEdge,
  assertDirectorId,
  assertReason,
  assertTransitionAllowed,
  dependenciesOf,
  downstreamStagesOf,
  evaluateReadiness,
  evidenceRequiredFor,
  isKnownStage,
  STAGE_HASH_REQUIRED,
  FLEET_HEALTH_STATE,
  HEARTBEAT_TTL_SECONDS,
  classifyDirectorHealth,
  escalationCodeForHealth,
  ESCALATION_THRESHOLDS,
} from "./fleetPolicy.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json(value) {
  return value === undefined ? {} : value;
}

// --------------------------------------------------------------------- DTOs

export function directorDto(row) {
  if (!row) return null;
  return Object.freeze({
    directorId: row.director_id,
    underlyingAgentId: row.underlying_agent_id ?? null,
    displayName: row.display_name,
    universeName: row.universe_name ?? null,
    niche: row.niche ?? null,
    genres: row.genres ?? [],
    contentFormats: row.content_formats ?? [],
    languages: row.languages ?? [],
    targetAudience: row.target_audience ?? null,
    creativeDirection: row.creative_direction ?? null,
    lifecycleState: row.lifecycle_state,
    readiness: row.readiness ?? {},
    readinessCheckedAt: iso(row.readiness_checked_at),
    teamConfig: row.team_config ?? {},
    productionConfig: row.production_config ?? {},
    providerConfig: row.provider_config ?? {},
    platformConnections: row.platform_connections ?? {},
    ownerAuthorizedAt: iso(row.owner_authorized_at),
    stateReason: row.state_reason ?? null,
    version: Number(row.version ?? 1),
    lastActivityAt: iso(row.last_activity_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function projectDto(row) {
  if (!row) return null;
  return Object.freeze({
    projectId: row.id,
    directorId: row.director_id,
    projectKey: row.project_key,
    universeId: row.universe_id,
    title: row.title,
    state: row.state,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function taskDto(row) {
  if (!row) return null;
  return Object.freeze({
    taskId: row.id,
    directorId: row.director_id,
    projectId: row.project_id,
    universeId: row.universe_id,
    stage: row.stage,
    taskType: row.task_type,
    status: row.status,
    priority: Number(row.priority),
    idempotencyKey: row.idempotency_key,
    assignmentReason: row.assignment_reason ?? null,
    assignedAt: iso(row.assigned_at),
    dueAt: iso(row.due_at),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    activeFencingToken: Number(row.active_fencing_token),
    nextRunAt: iso(row.next_run_at),
    cancelRequested: row.cancel_requested === true,
    providerRequirement: row.provider_requirement ?? null,
    providerState: row.provider_state,
    blockedReason: row.blocked_reason ?? null,
    lastError: row.last_error ?? null,
    resultRef: row.result_ref ?? null,
    correlationId: row.correlation_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function evidenceDto(row) {
  return Object.freeze({
    evidenceId: row.id,
    taskId: row.task_id,
    directorId: row.director_id,
    stage: row.stage,
    evidenceType: row.evidence_type,
    artifactHash: row.artifact_hash ?? null,
    payload: row.payload ?? {},
    createdAt: iso(row.created_at),
  });
}

export function auditDto(row) {
  return Object.freeze({
    auditId: row.id,
    directorId: row.director_id,
    action: row.action,
    previousState: row.previous_state ?? null,
    newState: row.new_state ?? null,
    reason: row.reason,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    correlationId: row.correlation_id,
    policyRef: row.policy_ref ?? null,
    createdAt: iso(row.created_at),
  });
}

// ------------------------------------------------------------------ helpers

/** Bounded exponential backoff with deterministic jitter derived from the task. */
export function retryDelaySeconds(attemptCount, taskId = "") {
  const base = Math.min(5 * 2 ** Math.max(0, attemptCount - 1), 300);
  let seed = 0;
  for (const character of String(taskId)) seed = (seed * 31 + character.charCodeAt(0)) % 997;
  const jitter = Math.floor((base * 0.2 * seed) / 997);
  return base + jitter;
}

export class PostgresDirectorFleetRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
      throw new Error("DIRECTOR_FLEET_POOL_REQUIRED");
    }
    this.pool = pool;
  }

  async _tx(fn, { isolation = null } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : "BEGIN");
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

  async #audit(client, { directorId, action, previousState = null, newState = null, reason, actor, correlationId, policyRef = null }) {
    await client.query(
      `INSERT INTO director_fleet_audit
         (director_id, action, previous_state, new_state, reason, actor_id, actor_role, correlation_id, policy_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [directorId, action, previousState, newState, reason, actor.id, actor.role, correlationId, policyRef]
    );
  }

  async #requireDirector(client, directorId, { forUpdate = false } = {}) {
    assertDirectorId(directorId);
    const { rows } = await client.query(
      `SELECT * FROM director_fleet WHERE director_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [directorId]
    );
    if (!rows[0]) {
      throw new FleetError(FLEET_ERROR.DIRECTOR_NOT_FOUND, "Director not found.", 404);
    }
    return rows[0];
  }

  // -------------------------------------------------------------- registry

  /**
   * Register a Director. Registration never activates: it records DRAFT (or the
   * supplied pre-activation state) plus an audit event. The capacity invariant
   * (50 non-retired Directors) is enforced here and by the database trigger.
   */
  async registerDirector({
    directorId,
    displayName,
    universeName = null,
    niche = null,
    genres = [],
    contentFormats = [],
    languages = [],
    targetAudience = null,
    creativeDirection = null,
    underlyingAgentId = null,
    teamConfig = {},
    productionConfig = {},
    providerConfig = {},
    platformConnections = {},
    lifecycleState = DIRECTOR_LIFECYCLE_STATES.DRAFT,
    actor,
    correlationId,
    reason = "Director registered",
  }) {
    assertDirectorId(directorId);
    assertActor(actor);
    assertCorrelationId(correlationId);
    if (![DIRECTOR_LIFECYCLE_STATES.DRAFT, DIRECTOR_LIFECYCLE_STATES.CONFIGURED].includes(lifecycleState)) {
      throw new FleetError(
        FLEET_ERROR.DIRECTOR_TRANSITION_INVALID,
        "A Director can only be registered as DRAFT or CONFIGURED; activation is a separate audited action.",
        409
      );
    }
    if (typeof displayName !== "string" || displayName.trim().length === 0 || displayName.length > 120) {
      throw new FleetError("DIRECTOR_NAME_INVALID", "A display name of 1–120 characters is required.", 400);
    }

    return this._tx(async (client) => {
      const occupied = await client.query(
        `SELECT count(*)::int AS count FROM director_fleet WHERE lifecycle_state <> 'RETIRED'`
      );
      if (Number(occupied.rows[0]?.count ?? 0) >= FLEET_CAPACITY) {
        throw new FleetError(
          FLEET_ERROR.DIRECTOR_FLEET_CAPACITY_REACHED,
          `The fleet capacity of ${FLEET_CAPACITY} registered Directors is reached.`,
          409
        );
      }
      let row;
      try {
        const inserted = await client.query(
          `INSERT INTO director_fleet
             (director_id, underlying_agent_id, display_name, universe_name, niche, genres,
              content_formats, languages, target_audience, creative_direction, lifecycle_state,
              team_config, production_config, provider_config, platform_connections)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11,
                   $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb)
           RETURNING *`,
          [
            directorId,
            underlyingAgentId,
            displayName.trim(),
            universeName,
            niche,
            JSON.stringify(genres ?? []),
            JSON.stringify(contentFormats ?? []),
            JSON.stringify(languages ?? []),
            targetAudience,
            creativeDirection,
            lifecycleState,
            JSON.stringify(json(teamConfig)),
            JSON.stringify(json(productionConfig)),
            JSON.stringify(json(providerConfig)),
            JSON.stringify(json(platformConnections)),
          ]
        );
        row = inserted.rows[0];
      } catch (error) {
        if (error?.code === "23505" || /duplicate key/i.test(error?.message ?? "")) {
          throw new FleetError(FLEET_ERROR.DIRECTOR_ALREADY_EXISTS, "A Director with that id already exists.", 409);
        }
        if (/DIRECTOR_FLEET_CAPACITY_REACHED/.test(error?.message ?? "")) {
          throw new FleetError(
            FLEET_ERROR.DIRECTOR_FLEET_CAPACITY_REACHED,
            `The fleet capacity of ${FLEET_CAPACITY} registered Directors is reached.`,
            409
          );
        }
        throw error;
      }

      await this.#audit(client, {
        directorId,
        action: "DIRECTOR_REGISTERED",
        previousState: null,
        newState: row.lifecycle_state,
        reason,
        actor,
        correlationId,
        policyRef: "FLEET_CAPACITY_50",
      });
      return directorDto(row);
    });
  }

  async getDirector(directorId) {
    assertDirectorId(directorId);
    const { rows } = await this.pool.query("SELECT * FROM director_fleet WHERE director_id = $1", [directorId]);
    return directorDto(rows[0]);
  }

  async listDirectors({ lifecycleState = null } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM director_fleet
        WHERE ($1::text IS NULL OR lifecycle_state = $1)
        ORDER BY director_id ASC`,
      [lifecycleState]
    );
    return rows.map(directorDto);
  }

  async listAudit(directorId, { limit = 50 } = {}) {
    assertDirectorId(directorId);
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    const { rows } = await this.pool.query(
      `SELECT * FROM director_fleet_audit
        WHERE director_id = $1
        ORDER BY created_at DESC, id ASC
        LIMIT ${bounded}`,
      [directorId]
    );
    return rows.map(auditDto);
  }

  /** Update persisted configuration. This never changes the lifecycle state. */
  async updateConfiguration({ directorId, patch = {}, actor, correlationId, reason = "Director configuration updated" }) {
    assertDirectorId(directorId);
    assertActor(actor);
    assertCorrelationId(correlationId);

    const allowed = {
      displayName: "display_name",
      universeName: "universe_name",
      niche: "niche",
      targetAudience: "target_audience",
      creativeDirection: "creative_direction",
      underlyingAgentId: "underlying_agent_id",
      genres: "genres",
      contentFormats: "content_formats",
      languages: "languages",
      teamConfig: "team_config",
      productionConfig: "production_config",
      providerConfig: "provider_config",
      platformConnections: "platform_connections",
    };
    const assignments = [];
    const values = [directorId];
    for (const [key, column] of Object.entries(allowed)) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (["genres", "contentFormats", "languages", "teamConfig", "productionConfig", "providerConfig", "platformConnections"].includes(key)) {
        if (value !== null && (typeof value !== "object" || (Array.isArray(value) === false && key !== "teamConfig" && key !== "productionConfig" && key !== "providerConfig" && key !== "platformConnections"))) {
          throw new FleetError("DIRECTOR_CONFIGURATION_INVALID", `${key} must be an array or object.`, 400);
        }
        values.push(JSON.stringify(value ?? (Array.isArray(value) ? [] : {})));
        assignments.push(`${column} = $${values.length}::jsonb`);
      } else {
        if (value !== null && typeof value !== "string") {
          throw new FleetError("DIRECTOR_CONFIGURATION_INVALID", `${key} must be a string or null.`, 400);
        }
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      }
    }
    if (assignments.length === 0) {
      throw new FleetError("DIRECTOR_CONFIGURATION_EMPTY", "No supported configuration field was supplied.", 400);
    }

    return this._tx(async (client) => {
      const current = await this.#requireDirector(client, directorId, { forUpdate: true });
      const { rows } = await client.query(
        `UPDATE director_fleet
            SET ${assignments.join(", ")},
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE director_id = $1
          RETURNING *`,
        values
      );
      await this.#audit(client, {
        directorId,
        action: "DIRECTOR_CONFIGURATION_UPDATED",
        previousState: current.lifecycle_state,
        newState: rows[0].lifecycle_state,
        reason,
        actor,
        correlationId,
      });
      return directorDto(rows[0]);
    });
  }

  /** Owner authorization is the last readiness gate; it is never implied. */
  async setOwnerAuthorization({ directorId, authorized, actor, correlationId, reason = null }) {
    assertDirectorId(directorId);
    assertActor(actor);
    assertCorrelationId(correlationId);
    if (actor.role !== "OWNER") {
      throw new FleetError(
        FLEET_ERROR.DIRECTOR_NOT_AUTHORIZED,
        "Only the Owner can authorize a Director for activation.",
        403
      );
    }
    return this._tx(async (client) => {
      await this.#requireDirector(client, directorId, { forUpdate: true });
      const { rows } = await client.query(
        `UPDATE director_fleet
            SET owner_authorized_at = CASE WHEN $2::boolean THEN clock_timestamp() ELSE NULL END,
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE director_id = $1
          RETURNING *`,
        [directorId, authorized === true]
      );
      await this.#audit(client, {
        directorId,
        action: authorized ? "DIRECTOR_OWNER_AUTHORIZED" : "DIRECTOR_OWNER_AUTHORIZATION_WITHDRAWN",
        previousState: rows[0].lifecycle_state,
        newState: rows[0].lifecycle_state,
        reason: reason ?? (authorized ? "Owner authorized activation." : "Owner withdrew activation authorization."),
        actor,
        correlationId,
      });
      return directorDto(rows[0]);
    });
  }

  /**
   * The single lifecycle transition path. Locks the row, validates the transition,
   * re-evaluates readiness for READY/ACTIVE from persisted configuration, writes
   * the new state and appends an audit record — all in one transaction.
   */
  async transition({ directorId, to, reason, actor, correlationId, policyRef = null }) {
    assertDirectorId(directorId);
    assertActor(actor);
    assertCorrelationId(correlationId);
    assertReason(reason);

    return this._tx(async (client) => {
      const current = await this.#requireDirector(client, directorId, { forUpdate: true });
      const from = current.lifecycle_state;
      assertTransitionAllowed(from, to);

      if (to === DIRECTOR_LIFECYCLE_STATES.READY || to === DIRECTOR_LIFECYCLE_STATES.ACTIVE) {
        const readiness = evaluateReadiness(directorDto(current));
        if (!readiness.ready) {
          throw new FleetError(
            FLEET_ERROR.DIRECTOR_NOT_READY,
            `Director is not ready: ${readiness.missing.join(", ")}.`,
            409,
            { missing: readiness.missing }
          );
        }
      }

      const { rows } = await client.query(
        `UPDATE director_fleet
            SET lifecycle_state = $2,
                state_reason = $3,
                readiness = CASE WHEN $2 IN ('READY','ACTIVE') THEN $4::jsonb ELSE readiness END,
                readiness_checked_at = CASE WHEN $2 IN ('READY','ACTIVE') THEN clock_timestamp() ELSE readiness_checked_at END,
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE director_id = $1
          RETURNING *`,
        [
          directorId,
          to,
          reason,
          JSON.stringify(evaluateReadiness(directorDto(current))),
        ]
      );
      await this.#audit(client, {
        directorId,
        action: "DIRECTOR_STATE_CHANGED",
        previousState: from,
        newState: to,
        reason,
        actor,
        correlationId,
        policyRef,
      });
      return directorDto(rows[0]);
    });
  }

  /** Convenience wrappers with explicit, audited intent. */
  async activateDirector(args) {
    return this.transition({ ...args, to: DIRECTOR_LIFECYCLE_STATES.ACTIVE, policyRef: args.policyRef ?? "SPECIALIZED_ACTIVATION" });
  }

  async pauseDirector(args) {
    return this.transition({ ...args, to: DIRECTOR_LIFECYCLE_STATES.PAUSED, policyRef: args.policyRef ?? "SUSPEND_WORK" });
  }

  async resumeDirector(args) {
    return this.transition({ ...args, to: DIRECTOR_LIFECYCLE_STATES.ACTIVE, policyRef: args.policyRef ?? "RESUME_WORK" });
  }

  async suspendDirector(args) {
    return this.transition({ ...args, to: DIRECTOR_LIFECYCLE_STATES.SUSPENDED, policyRef: args.policyRef ?? "SECURITY_SUSPENSION" });
  }

  async requestRetirement(args) {
    return this.transition({ ...args, to: DIRECTOR_LIFECYCLE_STATES.RETIRING, policyRef: args.policyRef ?? "RETIREMENT_REQUESTED" });
  }

  async retireDirector(args) {
    return this.transition({ ...args, to: DIRECTOR_LIFECYCLE_STATES.RETIRED, policyRef: args.policyRef ?? "RETIREMENT_COMPLETE" });
  }

  /** True when HERMES may assign work to this Director right now. */
  async isWorkCapable(directorId) {
    const director = await this.getDirector(directorId);
    return Boolean(director && WORK_CAPABLE_STATES.includes(director.lifecycleState));
  }

  // -------------------------------------------------------------- projects

  async createProject({ directorId, projectKey, universeId, title, actor = { id: "system", role: "SYSTEM" }, correlationId = randomUUID() }) {
    assertDirectorId(directorId);
    if (typeof projectKey !== "string" || projectKey.length === 0 || projectKey.length > 120) {
      throw new FleetError("PROJECT_KEY_INVALID", "A project key of 1–120 characters is required.", 400);
    }
    if (typeof universeId !== "string" || universeId.length === 0 || universeId.length > 120) {
      throw new FleetError("PROJECT_UNIVERSE_INVALID", "A universe id of 1–120 characters is required.", 400);
    }
    if (typeof title !== "string" || title.length === 0 || title.length > 200) {
      throw new FleetError("PROJECT_TITLE_INVALID", "A title of 1–200 characters is required.", 400);
    }

    return this._tx(async (client) => {
      const director = await this.#requireDirector(client, directorId);
      if (director.lifecycle_state === DIRECTOR_LIFECYCLE_STATES.RETIRED) {
        throw new FleetError(FLEET_ERROR.DIRECTOR_NOT_WORK_CAPABLE, "A retired Director cannot own new projects.", 409);
      }
      const { rows } = await client.query(
        `INSERT INTO director_projects (director_id, project_key, universe_id, title)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (director_id, project_key) DO NOTHING
         RETURNING *`,
        [directorId, projectKey, universeId, title]
      );
      if (rows[0]) return projectDto(rows[0]);
      const existing = await client.query(
        "SELECT * FROM director_projects WHERE director_id = $1 AND project_key = $2",
        [directorId, projectKey]
      );
      if (!existing.rows[0]) {
        throw new FleetError("PROJECT_CREATE_FAILED", "The project could not be created.", 500);
      }
      return projectDto(existing.rows[0]);
    });
  }

  /** Director-scoped read: another Director's project is `null`, never a leak. */
  async getProject({ directorId, projectId }) {
    assertDirectorId(directorId);
    if (typeof projectId !== "string" || !UUID.test(projectId)) return null;
    const { rows } = await this.pool.query(
      "SELECT * FROM director_projects WHERE id = $1 AND director_id = $2",
      [projectId, directorId]
    );
    return projectDto(rows[0]);
  }

  async listProjects(directorId, { limit = 100 } = {}) {
    assertDirectorId(directorId);
    const bounded = Math.max(1, Math.min(200, Number(limit) || 100));
    const { rows } = await this.pool.query(
      `SELECT * FROM director_projects
        WHERE director_id = $1
        ORDER BY created_at DESC
        LIMIT ${bounded}`,
      [directorId]
    );
    return rows.map(projectDto);
  }

  // ----------------------------------------------------------------- tasks

  /**
   * Idempotent task creation. The unique idempotency key is the contract: the
   * same key returns the same durable task, never a duplicate.
   */
  async createTask({
    directorId,
    projectId,
    stage,
    taskType = "production",
    priority = 100,
    idempotencyKey,
    correlationId,
    dependsOnTaskIds = [],
    dueAt = null,
    maxAttempts = 3,
    providerRequirement = null,
    assignmentReason = null,
  }) {
    assertDirectorId(directorId);
    if (!isKnownStage(stage)) {
      throw new FleetError(FLEET_ERROR.TASK_NOT_ASSIGNABLE, `Unknown production stage: ${stage}`, 400);
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new FleetError("TASK_IDEMPOTENCY_KEY_INVALID", "An idempotency key of 8–200 characters is required.", 400);
    }
    const correlation = correlationId ?? randomUUID();
    assertCorrelationId(correlation);

    return this._tx(async (client) => {
      const director = await this.#requireDirector(client, directorId);
      if (director.lifecycle_state === DIRECTOR_LIFECYCLE_STATES.RETIRED) {
        throw new FleetError(FLEET_ERROR.DIRECTOR_NOT_WORK_CAPABLE, "A retired Director cannot receive tasks.", 409);
      }
      const project = await client.query(
        "SELECT * FROM director_projects WHERE id = $1 AND director_id = $2",
        [projectId, directorId]
      );
      if (!project.rows[0]) {
        throw new FleetError(FLEET_ERROR.PROJECT_NOT_FOUND, "Project not found for this Director.", 404);
      }

      const existingKey = await client.query(
        "SELECT * FROM director_tasks WHERE idempotency_key = $1 LIMIT 1",
        [idempotencyKey]
      );
      if (existingKey.rows[0]) {
        if (existingKey.rows[0].director_id !== directorId) {
          throw new FleetError(
            "TASK_IDEMPOTENCY_CONFLICT",
            "That idempotency key belongs to a different Director.",
            409
          );
        }
        return { deduplicated: true, task: taskDto(existingKey.rows[0]) };
      }

      let inserted;
      // A unique violation aborts the whole transaction, so the recovery read
      // needs a savepoint rather than a bare catch.
      await client.query("SAVEPOINT task_insert");
      try {
        inserted = await client.query(
          `INSERT INTO director_tasks
             (director_id, project_id, universe_id, stage, task_type, priority, idempotency_key,
              assignment_reason, due_at, max_attempts, provider_requirement, correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            directorId,
            projectId,
            project.rows[0].universe_id,
            stage,
            taskType,
            Math.max(1, Math.min(1000, Number(priority) || 100)),
            idempotencyKey,
            assignmentReason,
            dueAt,
            Math.max(1, Math.min(10, Number(maxAttempts) || 3)),
            providerRequirement,
            correlation,
          ]
        );
      } catch (error) {
        if (error?.code === "23505" || /duplicate key/i.test(error?.message ?? "")) {
          await client.query("ROLLBACK TO SAVEPOINT task_insert");
          const existing = await client.query(
            "SELECT * FROM director_tasks WHERE idempotency_key = $1 AND director_id = $2",
            [idempotencyKey, directorId]
          );
          if (!existing.rows[0]) {
            throw new FleetError(
              "TASK_IDEMPOTENCY_CONFLICT",
              "That idempotency key belongs to a different Director.",
              409
            );
          }
          return { deduplicated: true, task: taskDto(existing.rows[0]) };
        }
        throw error;
      }
      await client.query("RELEASE SAVEPOINT task_insert");

      const task = inserted.rows[0];
      for (const dependsOnTaskId of dependsOnTaskIds) {
        const upstream = await client.query(
          "SELECT * FROM director_tasks WHERE id = $1 AND director_id = $2 AND project_id = $3",
          [dependsOnTaskId, directorId, projectId]
        );
        if (!upstream.rows[0]) {
          throw new FleetError(
            FLEET_ERROR.TASK_DEPENDENCY_UNSATISFIED,
            "A declared dependency is not a task of this Director's project.",
            409
          );
        }
        assertDependencyEdge(stage, upstream.rows[0].stage);
        await client.query(
          `INSERT INTO director_task_dependencies (task_id, depends_on_task_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [task.id, dependsOnTaskId]
        );
      }
      return { deduplicated: false, task: taskDto(inserted.rows[0]) };
    });
  }

  async getTask({ directorId, taskId }) {
    assertDirectorId(directorId);
    if (typeof taskId !== "string" || !UUID.test(taskId)) return null;
    const { rows } = await this.pool.query(
      "SELECT * FROM director_tasks WHERE id = $1 AND director_id = $2",
      [taskId, directorId]
    );
    return taskDto(rows[0]);
  }

  async listTasks({ directorId, status = null, stage = null, limit = 100 }) {
    assertDirectorId(directorId);
    const bounded = Math.max(1, Math.min(200, Number(limit) || 100));
    const { rows } = await this.pool.query(
      `SELECT * FROM director_tasks
        WHERE director_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR stage = $3)
        ORDER BY created_at DESC
        LIMIT ${bounded}`,
      [directorId, status, stage]
    );
    return rows.map(taskDto);
  }

  async listDependencies(taskId) {
    if (typeof taskId !== "string" || !UUID.test(taskId)) return [];
    const { rows } = await this.pool.query(
      "SELECT depends_on_task_id FROM director_task_dependencies WHERE task_id = $1",
      [taskId]
    );
    return rows.map((row) => row.depends_on_task_id);
  }

  /**
   * Dependency validation, evaluated from persisted evidence:
   *   1. every explicitly declared dependency task must be COMPLETED,
   *   2. every upstream stage of this stage in the same project must be COMPLETED,
   *   3. each completed upstream stage must have produced its required evidence.
   */
  async #dependencyCheck(client, task) {
    const declared = await client.query(
      `SELECT t.id, t.stage, t.status
         FROM director_task_dependencies d
         JOIN director_tasks t ON t.id = d.depends_on_task_id
        WHERE d.task_id = $1`,
      [task.id]
    );
    const unmet = declared.rows.filter((row) => row.status !== "COMPLETED");
    if (unmet.length > 0) {
      return {
        ok: false,
        code: FLEET_ERROR.TASK_DEPENDENCY_UNSATISFIED,
        reason: `Declared dependencies are not complete: ${unmet.map((row) => row.stage).join(", ")}.`,
      };
    }

    for (const stage of dependenciesOf(task.stage)) {
      const upstream = await client.query(
        `SELECT id, status FROM director_tasks
          WHERE director_id = $1 AND project_id = $2 AND stage = $3
          ORDER BY (status = 'COMPLETED') DESC, created_at DESC
          LIMIT 1`,
        [task.director_id, task.project_id, stage]
      );
      if (!upstream.rows[0] || upstream.rows[0].status !== "COMPLETED") {
        return {
          ok: false,
          code: FLEET_ERROR.TASK_DEPENDENCY_UNSATISFIED,
          reason: `Upstream stage ${stage} is not completed with evidence.`,
        };
      }
      const evidence = await this.#evidenceStatus(client, upstream.rows[0].id, stage);
      if (!evidence.ok) {
        return { ok: false, code: FLEET_ERROR.TASK_DEPENDENCY_UNSATISFIED, reason: evidence.reason };
      }
    }
    return { ok: true };
  }

  async #assertDependenciesSatisfied(client, task) {
    const status = await this.#dependencyCheck(client, task);
    if (!status.ok) throw new FleetError(status.code, status.reason, 409);
  }

  /** Non-throwing evidence evaluation, so a claim can persist an honest block. */
  async #evidenceStatus(client, taskId, stage) {
    const required = evidenceRequiredFor(stage);
    const { rows } = await client.query(
      "SELECT evidence_type, artifact_hash FROM director_task_evidence WHERE task_id = $1",
      [taskId]
    );
    const present = new Set(rows.map((row) => row.evidence_type));
    const missing = required.filter((type) => !present.has(type));
    if (missing.length > 0) {
      return {
        ok: false,
        code: FLEET_ERROR.TASK_STAGE_EVIDENCE_MISSING,
        reason: `Stage ${stage} has no evidence for: ${missing.join(", ")}.`,
      };
    }
    if (STAGE_HASH_REQUIRED.includes(stage)) {
      const hashed = rows.some((row) => typeof row.artifact_hash === "string" && HASH.test(row.artifact_hash));
      if (!hashed) {
        return {
          ok: false,
          code: FLEET_ERROR.TASK_STAGE_EVIDENCE_MISSING,
          reason: `Stage ${stage} requires a verified artifact hash.`,
        };
      }
    }
    return { ok: true, rows };
  }

  async #assertEvidencePresent(client, taskId, stage, { code = FLEET_ERROR.TASK_STAGE_EVIDENCE_MISSING } = {}) {
    const status = await this.#evidenceStatus(client, taskId, stage);
    if (!status.ok) throw new FleetError(code, status.reason, 409);
    return status.rows;
  }

  /**
   * HERMES assigns a task: HERMES-authenticated, transactional, and refused for a
   * Director that is not ACTIVE or when dependencies/evidence are unavailable.
   */
  async assignTask({ directorId, taskId, actor, correlationId, reason = "Assigned by HERMES" }) {
    assertDirectorId(directorId);
    assertActor(actor);
    assertCorrelationId(correlationId);
    assertReason(reason);

    return this._tx(async (client) => {
      const director = await this.#requireDirector(client, directorId);
      if (!WORK_CAPABLE_STATES.includes(director.lifecycle_state)) {
        throw new FleetError(
          FLEET_ERROR.DIRECTOR_NOT_WORK_CAPABLE,
          `Director is ${director.lifecycle_state}; work can only be assigned to an ACTIVE Director.`,
          409
        );
      }
      const found = await client.query(
        "SELECT * FROM director_tasks WHERE id = $1 AND director_id = $2 FOR UPDATE",
        [taskId, directorId]
      );
      const task = found.rows[0];
      if (!task) throw new FleetError(FLEET_ERROR.TASK_NOT_FOUND, "Task not found for this Director.", 404);
      if (!["CREATED", "QUEUED", "RETRY_SCHEDULED"].includes(task.status)) {
        throw new FleetError(FLEET_ERROR.TASK_NOT_ASSIGNABLE, `Task is ${task.status} and cannot be assigned.`, 409);
      }
      await this.#assertDependenciesSatisfied(client, task);

      const { rows } = await client.query(
        `UPDATE director_tasks
            SET status = 'QUEUED',
                assignment_reason = $2,
                assigned_at = clock_timestamp(),
                next_run_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [taskId, reason]
      );
      await this.#audit(client, {
        directorId,
        action: "DIRECTOR_TASK_ASSIGNED",
        previousState: task.status,
        newState: "QUEUED",
        reason,
        actor,
        correlationId,
        policyRef: "HERMES_FLEET_SCHEDULING",
      });
      return taskDto(rows[0]);
    });
  }

  /**
   * Atomically claim one due task. Two workers can never receive the same task:
   * the candidate row is locked with SKIP LOCKED and the lease is unique per task.
   */
  async claimTask({ workerKey, leaseSeconds = 60, directorId = null }) {
    if (typeof workerKey !== "string" || workerKey.length === 0 || workerKey.length > 120) {
      throw new FleetError("WORKER_KEY_INVALID", "A worker key is required.", 400);
    }
    const lease = Math.max(5, Math.min(3600, Number(leaseSeconds) || 60));
    return this._tx(async (client) => {
      const candidate = await client.query(
        `SELECT * FROM director_tasks
          WHERE status IN ('QUEUED','RETRY_SCHEDULED')
            AND cancel_requested = FALSE
            AND next_run_at <= clock_timestamp()
            AND ($1::text IS NULL OR director_id = $1)
          ORDER BY priority ASC, next_run_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [directorId]
      );
      const task = candidate.rows[0];
      if (!task) return null;

      if (task.provider_state === "QUOTA_EXHAUSTED" || task.provider_state === "UNAVAILABLE") {
        await client.query(
          `UPDATE director_tasks
              SET status = 'BLOCKED',
                  blocked_reason = $2,
                  next_run_at = clock_timestamp() + interval '15 minutes',
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [task.id, `PROVIDER_${task.provider_state}`]
        );
        return {
          claimed: false,
          blocked: true,
          code: FLEET_ERROR.PROVIDER_UNAVAILABLE,
          directorId: task.director_id,
          taskId: task.id,
        };
      }

      // Non-throwing evaluation: a failed statement would abort the transaction,
      // so the block decision must be taken from a returned status.
      const dependencies = await this.#dependencyCheck(client, task);
      if (!dependencies.ok) {
        await client.query(
          `UPDATE director_tasks
              SET status = 'BLOCKED', blocked_reason = $2, updated_at = clock_timestamp()
            WHERE id = $1`,
          [task.id, dependencies.code]
        );
        return {
          claimed: false,
          blocked: true,
          code: dependencies.code,
          directorId: task.director_id,
          taskId: task.id,
        };
      }

      const updated = await client.query(
        `UPDATE director_tasks
            SET status = 'RUNNING',
                active_fencing_token = active_fencing_token + 1,
                attempt_count = attempt_count + 1,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [task.id]
      );
      const leased = updated.rows[0];
      await client.query(
        `INSERT INTO director_task_leases (task_id, worker_key, fencing_token, lease_expires_at)
         VALUES ($1, $2, $3, clock_timestamp() + ($4::int * interval '1 second'))`,
        [task.id, workerKey, leased.active_fencing_token, lease]
      );
      return {
        claimed: true,
        workerKey,
        task: taskDto(leased),
        fencingToken: Number(leased.active_fencing_token),
      };
    });
  }

  async #assertActiveLease(client, { taskId, workerKey, fencingToken }) {
    const { rows } = await client.query(
      `SELECT * FROM director_task_leases
        WHERE task_id = $1 AND released_at IS NULL
        FOR UPDATE`,
      [taskId]
    );
    const lease = rows[0];
    if (!lease) {
      throw new FleetError(FLEET_ERROR.TASK_LEASE_NOT_ACTIVE, "No active lease for this task.", 409);
    }
    if (Number(lease.fencing_token) !== Number(fencingToken)) {
      throw new FleetError(FLEET_ERROR.TASK_FENCING_TOKEN_STALE, "The fencing token is stale.", 409);
    }
    if (workerKey && lease.worker_key !== workerKey) {
      throw new FleetError(FLEET_ERROR.TASK_FENCING_TOKEN_STALE, "The lease belongs to another worker.", 409);
    }
    const expired = await client.query(
      "SELECT ($1::timestamptz <= clock_timestamp()) AS expired",
      [lease.lease_expires_at]
    );
    if (expired.rows[0]?.expired === true) {
      throw new FleetError(FLEET_ERROR.TASK_LEASE_NOT_ACTIVE, "The lease has expired.", 409);
    }
    return lease;
  }

  /**
   * Complete a task. Completion requires its stage evidence and, for media
   * stages, a verified artifact hash. A queued task or a called handler is never
   * completion.
   */
  async completeTask({ directorId, taskId, workerKey, fencingToken, resultRef, evidence = [], correlationId = randomUUID() }) {
    assertDirectorId(directorId);
    if (typeof resultRef !== "string" || resultRef.length === 0 || resultRef.length > 300) {
      throw new FleetError(FLEET_ERROR.TASK_RESULT_REQUIRED, "A result reference is required.", 400);
    }
    if (!Array.isArray(evidence)) {
      throw new FleetError("TASK_EVIDENCE_INVALID", "Evidence must be a list.", 400);
    }

    return this._tx(async (client) => {
      const found = await client.query(
        "SELECT * FROM director_tasks WHERE id = $1 AND director_id = $2 FOR UPDATE",
        [taskId, directorId]
      );
      const task = found.rows[0];
      if (!task) throw new FleetError(FLEET_ERROR.TASK_NOT_FOUND, "Task not found for this Director.", 404);
      if (task.status !== "RUNNING") {
        throw new FleetError(FLEET_ERROR.TASK_NOT_ASSIGNABLE, `Task is ${task.status}, not RUNNING.`, 409);
      }
      await this.#assertActiveLease(client, { taskId, workerKey, fencingToken });

      for (const entry of evidence) {
        if (!entry || typeof entry.evidenceType !== "string") {
          throw new FleetError("TASK_EVIDENCE_INVALID", "Each evidence entry needs an evidenceType.", 400);
        }
        if (entry.artifactHash !== undefined && entry.artifactHash !== null && !HASH.test(String(entry.artifactHash))) {
          throw new FleetError("TASK_EVIDENCE_HASH_INVALID", "Artifact hash must be 64 lowercase hex characters.", 400);
        }
        await client.query(
          `INSERT INTO director_task_evidence (task_id, director_id, stage, evidence_type, artifact_hash, payload)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (task_id, evidence_type) DO UPDATE
             SET artifact_hash = EXCLUDED.artifact_hash,
                 payload = EXCLUDED.payload
           WHERE director_task_evidence.director_id = EXCLUDED.director_id`,
          [taskId, directorId, task.stage, entry.evidenceType, entry.artifactHash ?? null, JSON.stringify(entry.payload ?? {})]
        );
      }

      await this.#assertEvidencePresent(client, taskId, task.stage);

      const { rows } = await client.query(
        `UPDATE director_tasks
            SET status = 'COMPLETED',
                result_ref = $2,
                blocked_reason = NULL,
                last_error = NULL,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [taskId, resultRef]
      );
      await client.query(
        `UPDATE director_task_leases
            SET released_at = clock_timestamp(), release_reason = 'completed'
          WHERE task_id = $1 AND released_at IS NULL`,
        [taskId]
      );
      await client.query(
        "UPDATE director_fleet SET last_activity_at = clock_timestamp(), updated_at = clock_timestamp() WHERE director_id = $1",
        [directorId]
      );
      await client.query(
        "UPDATE director_projects SET state = 'IN_PRODUCTION', updated_at = clock_timestamp() WHERE id = $1 AND state = 'PLANNED'",
        [task.project_id]
      );
      await this.#audit(client, {
        directorId,
        action: "DIRECTOR_TASK_COMPLETED",
        previousState: "RUNNING",
        newState: "COMPLETED",
        reason: `Stage ${task.stage} completed with evidence.`,
        actor: { id: workerKey ?? "worker", role: "SYSTEM" },
        correlationId,
      });
      return taskDto(rows[0]);
    });
  }

  /** Honest failure: bounded retries, then dead letter. Never an infinite loop. */
  async failTask({ directorId, taskId, workerKey, fencingToken, error = "TASK_FAILED", retryable = true, correlationId = randomUUID() }) {
    assertDirectorId(directorId);
    return this._tx(async (client) => {
      const found = await client.query(
        "SELECT * FROM director_tasks WHERE id = $1 AND director_id = $2 FOR UPDATE",
        [taskId, directorId]
      );
      const task = found.rows[0];
      if (!task) throw new FleetError(FLEET_ERROR.TASK_NOT_FOUND, "Task not found for this Director.", 404);
      if (task.status !== "RUNNING") {
        throw new FleetError(FLEET_ERROR.TASK_NOT_ASSIGNABLE, `Task is ${task.status}, not RUNNING.`, 409);
      }
      await this.#assertActiveLease(client, { taskId, workerKey, fencingToken });

      const exhausted = Number(task.attempt_count) >= Number(task.max_attempts);
      const deadLetter = !retryable || exhausted;
      const nextStatus = deadLetter ? "DEAD_LETTER" : "RETRY_SCHEDULED";
      const delay = deadLetter ? 0 : retryDelaySeconds(Number(task.attempt_count), task.id);

      const { rows } = await client.query(
        `UPDATE director_tasks
            SET status = $2,
                last_error = left($3, 300),
                blocked_reason = CASE WHEN $2 = 'DEAD_LETTER' THEN 'RETRY_EXHAUSTED' ELSE blocked_reason END,
                next_run_at = CASE WHEN $4::int > 0
                                   THEN clock_timestamp() + ($4::int * interval '1 second')
                                   ELSE next_run_at END,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [taskId, nextStatus, String(error), delay]
      );
      await client.query(
        `UPDATE director_task_leases
            SET released_at = clock_timestamp(), release_reason = 'failed'
          WHERE task_id = $1 AND released_at IS NULL`,
        [taskId]
      );
      await this.#audit(client, {
        directorId,
        action: deadLetter ? "DIRECTOR_TASK_DEAD_LETTER" : "DIRECTOR_TASK_RETRY_SCHEDULED",
        previousState: "RUNNING",
        newState: nextStatus,
        reason: String(error).slice(0, 300),
        actor: { id: workerKey ?? "worker", role: "SYSTEM" },
        correlationId,
      });
      return taskDto(rows[0]);
    });
  }

  /**
   * Provider quota exhaustion is a blocked state with a cooldown, not a retry
   * loop: attempts are not incremented and the task waits for the reset window.
   */
  async markProviderBlocked({ directorId, taskId, providerState = "QUOTA_EXHAUSTED", cooldownSeconds = 900, detail = null }) {
    assertDirectorId(directorId);
    if (!["UNAVAILABLE", "QUOTA_EXHAUSTED"].includes(providerState)) {
      throw new FleetError("PROVIDER_STATE_INVALID", "Unknown provider state.", 400);
    }
    const cooldown = Math.max(60, Math.min(86_400, Number(cooldownSeconds) || 900));
    const { rows } = await this.pool.query(
      `UPDATE director_tasks
          SET status = 'BLOCKED',
              provider_state = $3,
              blocked_reason = $4,
              next_run_at = clock_timestamp() + ($5::int * interval '1 second'),
              updated_at = clock_timestamp()
        WHERE id = $1 AND director_id = $2
        RETURNING *`,
      [taskId, directorId, providerState, (detail ?? `PROVIDER_${providerState}`).slice(0, 300), cooldown]
    );
    if (!rows[0]) throw new FleetError(FLEET_ERROR.TASK_NOT_FOUND, "Task not found for this Director.", 404);
    return taskDto(rows[0]);
  }

  /**
   * Cancellation. Running work is flagged (the worker's next fenced call refuses
   * to commit a result) and dependent tasks are blocked, so cancellation never
   * leaves an orphan downstream stage executing against missing input.
   */
  async cancelTask({ directorId, taskId, reason = "Cancelled by Owner", actor, correlationId }) {
    assertDirectorId(directorId);
    assertActor(actor);
    assertCorrelationId(correlationId);
    return this._tx(async (client) => {
      const found = await client.query(
        "SELECT * FROM director_tasks WHERE id = $1 AND director_id = $2 FOR UPDATE",
        [taskId, directorId]
      );
      const task = found.rows[0];
      if (!task) throw new FleetError(FLEET_ERROR.TASK_NOT_FOUND, "Task not found for this Director.", 404);
      if (["COMPLETED", "CANCELLED", "DEAD_LETTER"].includes(task.status)) {
        throw new FleetError(FLEET_ERROR.TASK_NOT_CANCELLABLE, `Task is already ${task.status}.`, 409);
      }
      const immediate = ["CREATED", "QUEUED", "RETRY_SCHEDULED", "BLOCKED", "ASSIGNED"].includes(task.status);
      const nextStatus = immediate ? "CANCELLED" : task.status;
      await client.query(
        `UPDATE director_tasks
            SET status = $2, cancel_requested = TRUE,
                blocked_reason = CASE WHEN $2 = 'CANCELLED' THEN 'CANCELLED_BY_ACTOR' ELSE blocked_reason END,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [taskId, nextStatus]
      );
      if (immediate) {
        await client.query(
          `UPDATE director_task_leases SET released_at = clock_timestamp(), release_reason = 'cancelled'
            WHERE task_id = $1 AND released_at IS NULL`,
          [taskId]
        );
      }

      const dependents = await client.query(
        `SELECT t.id, t.status FROM director_tasks t
           JOIN director_task_dependencies d ON d.task_id = t.id
          WHERE d.depends_on_task_id = $1`,
        [taskId]
      );
      const propagated = [];
      for (const dependent of dependents.rows) {
        if (["COMPLETED", "CANCELLED"].includes(dependent.status)) continue;
        await client.query(
          `UPDATE director_tasks
              SET status = 'BLOCKED', blocked_reason = 'TASK_DEPENDENCY_CANCELLED', updated_at = clock_timestamp()
            WHERE id = $1`,
          [dependent.id]
        );
        propagated.push(dependent.id);
      }

      await this.#audit(client, {
        directorId,
        action: "DIRECTOR_TASK_CANCELLED",
        previousState: task.status,
        newState: nextStatus,
        reason,
        actor,
        correlationId,
      });
      const refreshed = await client.query("SELECT * FROM director_tasks WHERE id = $1", [taskId]);
      return { task: taskDto(refreshed.rows[0]), propagatedTaskIds: propagated };
    });
  }

  /** Restart recovery: expire leases with the database clock and requeue honestly. */
  async recoverExpiredLeases({ directorId = null } = {}) {
    return this._tx(async (client) => {
      const expired = await client.query(
        `SELECT l.id AS lease_id, l.task_id, l.fencing_token
           FROM director_task_leases l
           JOIN director_tasks t ON t.id = l.task_id
          WHERE l.released_at IS NULL
            AND l.lease_expires_at <= clock_timestamp()
            AND ($1::text IS NULL OR t.director_id = $1)
          FOR UPDATE OF l SKIP LOCKED`,
        [directorId]
      );
      const recovered = [];
      for (const lease of expired.rows) {
        await client.query(
          `UPDATE director_task_leases
              SET released_at = clock_timestamp(), release_reason = 'expired'
            WHERE id = $1`,
          [lease.lease_id]
        );
        const taskRow = await client.query(
          "SELECT * FROM director_tasks WHERE id = $1 FOR UPDATE",
          [lease.task_id]
        );
        const task = taskRow.rows[0];
        if (!task || task.status !== "RUNNING") {
          recovered.push({ taskId: lease.task_id, outcome: "LEASE_RELEASED_ONLY" });
          continue;
        }
        const exhausted = Number(task.attempt_count) >= Number(task.max_attempts);
        await client.query(
          `UPDATE director_tasks
              SET status = $2,
                  blocked_reason = CASE WHEN $2 = 'DEAD_LETTER' THEN 'LEASE_EXPIRED_RETRY_EXHAUSTED' ELSE NULL END,
                  next_run_at = clock_timestamp(),
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [lease.task_id, exhausted ? "DEAD_LETTER" : "RETRY_SCHEDULED"]
        );
        recovered.push({
          taskId: lease.task_id,
          outcome: exhausted ? "DEAD_LETTER" : "RETRY_SCHEDULED",
        });
      }
      return recovered;
    });
  }

  // --------------------------------------------------------------- evidence

  async addEvidence({ directorId, taskId, evidenceType, artifactHash = null, payload = {} }) {
    assertDirectorId(directorId);
    if (typeof evidenceType !== "string" || evidenceType.length === 0 || evidenceType.length > 80) {
      throw new FleetError("TASK_EVIDENCE_INVALID", "An evidence type of 1–80 characters is required.", 400);
    }
    if (artifactHash !== null && !HASH.test(String(artifactHash))) {
      throw new FleetError("TASK_EVIDENCE_HASH_INVALID", "Artifact hash must be 64 lowercase hex characters.", 400);
    }
    const task = await this.getTask({ directorId, taskId });
    if (!task) throw new FleetError(FLEET_ERROR.TASK_NOT_FOUND, "Task not found for this Director.", 404);
    const { rows } = await this.pool.query(
      `INSERT INTO director_task_evidence (task_id, director_id, stage, evidence_type, artifact_hash, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (task_id, evidence_type) DO UPDATE
         SET artifact_hash = EXCLUDED.artifact_hash, payload = EXCLUDED.payload
       RETURNING *`,
      [taskId, directorId, task.stage, evidenceType, artifactHash, JSON.stringify(payload ?? {})]
    );
    return evidenceDto(rows[0]);
  }

  async listEvidence({ directorId, taskId }) {
    assertDirectorId(directorId);
    if (typeof taskId !== "string" || !UUID.test(taskId)) return [];
    const { rows } = await this.pool.query(
      "SELECT * FROM director_task_evidence WHERE task_id = $1 AND director_id = $2 ORDER BY created_at ASC",
      [taskId, directorId]
    );
    return rows.map(evidenceDto);
  }

  async listProjectEvidence({ directorId, projectId }) {
    assertDirectorId(directorId);
    const { rows } = await this.pool.query(
      `SELECT e.* FROM director_task_evidence e
         JOIN director_tasks t ON t.id = e.task_id
        WHERE t.project_id = $1 AND e.director_id = $2
        ORDER BY e.created_at ASC`,
      [projectId, directorId]
    );
    return rows.map(evidenceDto);
  }

  // ---------------------------------------------------------------- workers

  /** Heartbeat from an actual registered runtime. A browser is never a worker. */
  async heartbeatWorker({ workerKey, instanceId, role = "production", metadata = {} }) {
    if (typeof workerKey !== "string" || workerKey.length === 0 || workerKey.length > 120) {
      throw new FleetError("WORKER_KEY_INVALID", "A worker key is required.", 400);
    }
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new FleetError("WORKER_INSTANCE_REQUIRED", "An instance id is required.", 400);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO director_workers (worker_key, instance_id, role, status, metadata)
       VALUES ($1, $2, $3, 'active', $4::jsonb)
       ON CONFLICT (worker_key) DO UPDATE
         SET instance_id = EXCLUDED.instance_id,
             role = EXCLUDED.role,
             status = 'active',
             last_heartbeat_at = clock_timestamp(),
             metadata = EXCLUDED.metadata
       RETURNING *`,
      [workerKey, instanceId, role, JSON.stringify(metadata ?? {})]
    );
    return {
      workerKey: rows[0].worker_key,
      instanceId: rows[0].instance_id,
      role: rows[0].role,
      status: rows[0].status,
      lastHeartbeatAt: iso(rows[0].last_heartbeat_at),
    };
  }

  async listWorkers({ ttlSeconds = HEARTBEAT_TTL_SECONDS } = {}) {
    const ttl = Math.max(1, Number(ttlSeconds) || HEARTBEAT_TTL_SECONDS);
    const { rows } = await this.pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (clock_timestamp() - last_heartbeat_at))::int AS age_seconds
         FROM director_workers
        ORDER BY worker_key ASC`
    );
    return rows.map((row) => ({
      workerKey: row.worker_key,
      instanceId: row.instance_id,
      role: row.role,
      status: row.status,
      lastHeartbeatAt: iso(row.last_heartbeat_at),
      ageSeconds: Number(row.age_seconds ?? 0),
      expired: Number(row.age_seconds ?? 0) > ttl,
    }));
  }

  /** Mark genuinely expired runtimes offline (database clock, no guessing). */
  async expireWorkers({ ttlSeconds = HEARTBEAT_TTL_SECONDS } = {}) {
    const ttl = Math.max(1, Number(ttlSeconds) || HEARTBEAT_TTL_SECONDS);
    const { rows } = await this.pool.query(
      `UPDATE director_workers
          SET status = 'offline'
        WHERE status <> 'offline'
          AND last_heartbeat_at <= clock_timestamp() - ($1::int * interval '1 second')
        RETURNING worker_key, instance_id`,
      [ttl]
    );
    return rows.map((row) => ({ workerKey: row.worker_key, instanceId: row.instance_id }));
  }

  // ----------------------------------------------------------------- health

  /**
   * Fleet snapshot derived exclusively from persisted rows: lifecycle state,
   * task counts by status, oldest queue age, provider blocks and real worker
   * heartbeats. Nothing is inferred from planned work.
   */
  async fleetSnapshot({ heartbeatTtlSeconds = HEARTBEAT_TTL_SECONDS } = {}) {
    const ttl = Math.max(1, Number(heartbeatTtlSeconds) || HEARTBEAT_TTL_SECONDS);
    const [directors, counters, providerBlocks, workers] = await Promise.all([
      this.listDirectors(),
      this.pool.query(
        `SELECT director_id,
                count(*) FILTER (WHERE status IN ('ASSIGNED','RUNNING'))::int AS active_tasks,
                count(*) FILTER (WHERE status IN ('QUEUED','RETRY_SCHEDULED'))::int AS queued_tasks,
                count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked_tasks,
                count(*) FILTER (WHERE status IN ('FAILED','DEAD_LETTER'))::int AS failed_tasks,
                count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_tasks,
                count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_tasks,
                max(EXTRACT(EPOCH FROM (clock_timestamp() - created_at)))::int AS oldest_task_seconds,
                min(CASE WHEN status IN ('QUEUED','RETRY_SCHEDULED')
                         THEN EXTRACT(EPOCH FROM (clock_timestamp() - next_run_at)) END)::int AS oldest_queued_seconds
           FROM director_tasks
          GROUP BY director_id`
      ),
      this.pool.query(
        `SELECT director_id, count(*)::int AS count
           FROM director_tasks
          WHERE provider_state IN ('UNAVAILABLE','QUOTA_EXHAUSTED')
            AND status NOT IN ('COMPLETED','CANCELLED')
          GROUP BY director_id`
      ),
      this.listWorkers({ ttlSeconds: ttl }),
    ]);

    const counterByDirector = new Map(counters.rows.map((row) => [row.director_id, row]));
    const providerByDirector = new Map(providerBlocks.rows.map((row) => [row.director_id, Number(row.count)]));
    const liveWorkerAges = workers.filter((worker) => !worker.expired && worker.status !== "offline");
    const youngestHeartbeatAge =
      liveWorkerAges.length > 0 ? Math.min(...liveWorkerAges.map((worker) => worker.ageSeconds)) : null;

    const directorRows = directors.map((director) => {
      const row = counterByDirector.get(director.directorId) ?? {};
      const activeTasks = Number(row.active_tasks ?? 0);
      const queuedTasks = Number(row.queued_tasks ?? 0);
      const blockedTasks = Number(row.blocked_tasks ?? 0);
      const failedTasks = Number(row.failed_tasks ?? 0);
      const providerBlocked = (providerByDirector.get(director.directorId) ?? 0) > 0;
      const healthState = classifyDirectorHealth({
        director,
        activeTasks,
        queuedTasks,
        blockedTasks,
        failedTasks,
        oldestQueuedSeconds: row.oldest_queued_seconds === null || row.oldest_queued_seconds === undefined
          ? null
          : Number(row.oldest_queued_seconds),
        providerBlocked,
        heartbeatAgeSeconds: youngestHeartbeatAge,
      });
      return {
        directorId: director.directorId,
        displayName: director.displayName,
        universeName: director.universeName,
        niche: director.niche,
        lifecycleState: director.lifecycleState,
        healthState,
        activeTasks,
        queuedTasks,
        blockedTasks,
        failedTasks,
        completedTasks: Number(row.completed_tasks ?? 0),
        cancelledTasks: Number(row.cancelled_tasks ?? 0),
        providerBlocked,
        oldestQueuedSeconds:
          row.oldest_queued_seconds === null || row.oldest_queued_seconds === undefined
            ? null
            : Number(row.oldest_queued_seconds),
        lastActivityAt: director.lastActivityAt,
        escalationCode: escalationCodeForHealth(healthState, {
          providerBlocked,
          failedTasks,
        }),
      };
    });

    const counts = {
      total: directorRows.length,
      draft: directorRows.filter((row) => row.lifecycleState === "DRAFT").length,
      configured: directorRows.filter((row) => row.lifecycleState === "CONFIGURED").length,
      ready: directorRows.filter((row) => row.lifecycleState === "READY").length,
      active: directorRows.filter((row) => row.lifecycleState === "ACTIVE").length,
      paused: directorRows.filter((row) => row.lifecycleState === "PAUSED").length,
      suspended: directorRows.filter((row) => row.lifecycleState === "SUSPENDED").length,
      retiring: directorRows.filter((row) => row.lifecycleState === "RETIRING").length,
      retired: directorRows.filter((row) => row.lifecycleState === "RETIRED").length,
      withActiveTasks: directorRows.filter((row) => row.activeTasks > 0).length,
      withBlockedTasks: directorRows.filter((row) => row.blockedTasks > 0).length,
      withFailedTasks: directorRows.filter((row) => row.failedTasks > 0).length,
      providerBlocked: directorRows.filter((row) => row.providerBlocked).length,
      healthy: directorRows.filter((row) => row.healthState === FLEET_HEALTH_STATE.HEALTHY).length,
      degraded: directorRows.filter((row) => row.healthState === FLEET_HEALTH_STATE.DEGRADED).length,
      blocked: directorRows.filter((row) => row.healthState === FLEET_HEALTH_STATE.BLOCKED).length,
      offline: directorRows.filter((row) => row.healthState === FLEET_HEALTH_STATE.OFFLINE).length,
      notConfigured: directorRows.filter((row) => row.healthState === FLEET_HEALTH_STATE.NOT_CONFIGURED).length,
    };

    return {
      generatedAt: new Date().toISOString(),
      counts,
      directors: directorRows,
      workers: {
        total: workers.length,
        live: liveWorkerAges.length,
        expired: workers.filter((worker) => worker.expired).length,
        heartbeatTtlSeconds: ttl,
        items: workers,
      },
      capacity: { limit: FLEET_CAPACITY, used: counts.total - counts.retired },
    };
  }

  async recordEscalation({ directorId = null, code, severity = "warn", detail, dedupeKey, notificationEventId = null }) {
    if (typeof code !== "string" || code.length === 0) {
      throw new FleetError("ESCALATION_CODE_INVALID", "An escalation code is required.", 400);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO director_fleet_escalations
         (director_id, code, severity, detail, dedupe_key, notification_event_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO UPDATE
         SET detail = EXCLUDED.detail,
             notification_event_id = COALESCE(director_fleet_escalations.notification_event_id, EXCLUDED.notification_event_id)
       RETURNING *`,
      [directorId, code, severity, String(detail).slice(0, 500), dedupeKey, notificationEventId]
    );
    return {
      escalationId: rows[0].id,
      directorId: rows[0].director_id,
      code: rows[0].code,
      severity: rows[0].severity,
      detail: rows[0].detail,
      notificationEventId: rows[0].notification_event_id,
      createdAt: iso(rows[0].created_at),
    };
  }

  async listEscalations({ directorId = null, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    const { rows } = await this.pool.query(
      `SELECT * FROM director_fleet_escalations
        WHERE ($1::text IS NULL OR director_id = $1)
        ORDER BY created_at DESC
        LIMIT ${bounded}`,
      [directorId]
    );
    return rows.map((row) => ({
      escalationId: row.id,
      directorId: row.director_id,
      code: row.code,
      severity: row.severity,
      detail: row.detail,
      notificationEventId: row.notification_event_id,
      createdAt: iso(row.created_at),
    }));
  }

  /** Owner-visible production picture per project, from task + evidence rows. */
  async projectOverview({ directorId }) {
    assertDirectorId(directorId);
    const projects = await this.listProjects(directorId);
    const { rows } = await this.pool.query(
      `SELECT project_id,
              stage,
              count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked,
              count(*) FILTER (WHERE status IN ('FAILED','DEAD_LETTER'))::int AS failed,
              count(*) FILTER (WHERE status IN ('QUEUED','RETRY_SCHEDULED','RUNNING','ASSIGNED'))::int AS in_flight
         FROM director_tasks
        WHERE director_id = $1
        GROUP BY project_id, stage`,
      [directorId]
    );
    const evidence = await this.pool.query(
      `SELECT t.project_id, count(*)::int AS verified
         FROM director_task_evidence e
         JOIN director_tasks t ON t.id = e.task_id
        WHERE e.director_id = $1 AND e.artifact_hash IS NOT NULL
        GROUP BY t.project_id`,
      [directorId]
    );
    const verifiedByProject = new Map(evidence.rows.map((row) => [row.project_id, Number(row.verified)]));
    return projects.map((project) => {
      const stages = rows.filter((row) => row.project_id === project.projectId);
      return {
        ...project,
        stages: stages.map((row) => ({
          stage: row.stage,
          completed: Number(row.completed),
          blocked: Number(row.blocked),
          failed: Number(row.failed),
          inFlight: Number(row.in_flight),
        })),
        confirmedCompletedStages: stages.reduce((total, row) => total + Number(row.completed), 0),
        verifiedArtifactCount: verifiedByProject.get(project.projectId) ?? 0,
      };
    });
  }

  /** Downstream stages that a cancellation must consider (graph-level safety). */
  stagesAfter(stage) {
    return downstreamStagesOf(stage);
  }
}

export { directorDto as mapDirector, taskDto as mapTask, escalationCodeForHealth, ESCALATION_THRESHOLDS };
