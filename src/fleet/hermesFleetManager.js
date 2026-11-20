/**
 * ST Production House — HERMES fleet manager (Day 5 / D7).
 *
 * HERMES coordinates the Director fleet. This service is the ONLY management
 * surface that performs lifecycle actions and task assignment, and it keeps the
 * authority boundary explicit:
 *
 *   - Activation, resumption and retirement are OWNER decisions. HERMES cannot
 *     call them; the service refuses with DIRECTOR_NOT_AUTHORIZED.
 *   - Pause and suspension are operational safety actions HERMES may take.
 *   - Routine assignment is HERMES/AUTONOMOUS, but assigning the PUBLISHING
 *     stage is OWNER_POLICY_CONTROLLED and goes through the Day 3 authority
 *     matrix (`publishing.publish_publicly` + an unexpired Owner approval).
 *     Without a valid approval it is refused — never "gated later".
 *
 * Every action is durable and audited by the repository (actor, previous state,
 * new state, reason, correlation id, policy reference).
 */

import {
  classifyHermesAction,
  canHermesExecute,
  AUTHORITY_OWNER_POLICY,
} from "../manager/authorityMatrix.js";
import {
  DIRECTOR_LIFECYCLE_STATES,
  FLEET_ERROR,
  FleetError,
  WORK_CAPABLE_STATES,
  assertActor,
  assertCorrelationId,
  assertDirectorId,
  assertReason,
  evaluateReadiness,
  isKnownStage,
} from "./fleetPolicy.js";

const OWNER_ONLY_ACTIONS = Object.freeze([
  "activate",
  "resume",
  "retire",
  "request_retirement",
  "owner_authorization",
]);

export class HermesFleetManager {
  constructor({ repository, clock = () => new Date() } = {}) {
    if (!repository) throw new Error("FLEET_REPOSITORY_REQUIRED");
    this.repository = repository;
    this.clock = clock;
  }

  #assertOwner(actor, action) {
    if (OWNER_ONLY_ACTIONS.includes(action) && actor.role !== "OWNER") {
      throw new FleetError(
        FLEET_ERROR.DIRECTOR_NOT_AUTHORIZED,
        `HERMES cannot perform '${action}': it is an Owner decision.`,
        403
      );
    }
  }

  /** Fleet list plus the health that its own records justify. */
  async listFleet() {
    const snapshot = await this.repository.fleetSnapshot();
    return snapshot;
  }

  async inspectDirector({ directorId }) {
    assertDirectorId(directorId);
    const [director, audit, projects, tasks, escalations] = await Promise.all([
      this.repository.getDirector(directorId),
      this.repository.listAudit(directorId, { limit: 50 }),
      this.repository.listProjects(directorId),
      this.repository.listTasks({ directorId, limit: 100 }),
      this.repository.listEscalations({ directorId, limit: 20 }),
    ]);
    if (!director) {
      throw new FleetError(FLEET_ERROR.DIRECTOR_NOT_FOUND, "Director not found.", 404);
    }
    return {
      director,
      readiness: evaluateReadiness(director),
      workCapable: WORK_CAPABLE_STATES.includes(director.lifecycleState),
      projects,
      tasks,
      escalations,
      audit,
    };
  }

  async readiness({ directorId }) {
    const director = await this.repository.getDirector(directorId);
    if (!director) throw new FleetError(FLEET_ERROR.DIRECTOR_NOT_FOUND, "Director not found.", 404);
    return { directorId, lifecycleState: director.lifecycleState, ...evaluateReadiness(director) };
  }

  async #transition({ directorId, action, to, actor, correlationId, reason, policyRef }) {
    assertActor(actor);
    assertCorrelationId(correlationId);
    assertReason(reason);
    this.#assertOwner(actor, action);
    const director = await this.repository.transition({
      directorId,
      to,
      reason,
      actor,
      correlationId,
      policyRef,
    });
    return { action, director };
  }

  activateDirector(args) {
    return this.#transition({ ...args, action: "activate", to: DIRECTOR_LIFECYCLE_STATES.ACTIVE, policyRef: "OWNER_ACTIVATION" });
  }

  pauseDirector(args) {
    return this.#transition({ ...args, action: "pause", to: DIRECTOR_LIFECYCLE_STATES.PAUSED, policyRef: "HERMES_OPERATIONAL_PAUSE" });
  }

  resumeDirector(args) {
    return this.#transition({ ...args, action: "resume", to: DIRECTOR_LIFECYCLE_STATES.ACTIVE, policyRef: "OWNER_RESUME" });
  }

  suspendDirector(args) {
    return this.#transition({ ...args, action: "suspend", to: DIRECTOR_LIFECYCLE_STATES.SUSPENDED, policyRef: "HERMES_SAFETY_SUSPENSION" });
  }

  requestRetirement(args) {
    return this.#transition({ ...args, action: "request_retirement", to: DIRECTOR_LIFECYCLE_STATES.RETIRING, policyRef: "OWNER_RETIREMENT_REQUEST" });
  }

  retireDirector(args) {
    return this.#transition({ ...args, action: "retire", to: DIRECTOR_LIFECYCLE_STATES.RETIRED, policyRef: "OWNER_RETIREMENT_COMPLETE" });
  }

  /**
   * Assign one production task. Refused for a non-ACTIVE Director, when a
   * mandatory dependency or its evidence is missing, and when the stage is
   * owner-restricted without a valid unexpired Owner approval.
   */
  async assignTask({ directorId, taskId, actor, correlationId, reason = "HERMES fleet scheduling", ownerApproval = null }) {
    assertActor(actor);
    assertCorrelationId(correlationId);
    assertDirectorId(directorId);
    assertReason(reason);

    const task = await this.repository.getTask({ directorId, taskId });
    if (!task) throw new FleetError(FLEET_ERROR.TASK_NOT_FOUND, "Task not found for this Director.", 404);
    if (!isKnownStage(task.stage)) {
      throw new FleetError(FLEET_ERROR.TASK_NOT_ASSIGNABLE, "Unknown production stage.", 409);
    }

    if (task.stage === "PUBLISHING" || task.stage === "OWNER_APPROVAL") {
      // Owner rejection is absolute: no delegation, approval or deadline can
      // override it (Day 3 boundary).
      if (ownerApproval && (ownerApproval.rejected === true || ownerApproval.decision === "REJECTED")) {
        throw new FleetError(
          FLEET_ERROR.DIRECTOR_NOT_AUTHORIZED,
          "The Owner rejected this request; a rejection cannot be overridden.",
          403
        );
      }
      const classification = classifyHermesAction("publishing.publish_publicly");
      const permitted = canHermesExecute(classification, ownerApproval, { now: this.clock() });
      if (!permitted) {
        throw new FleetError(
          FLEET_ERROR.DIRECTOR_NOT_AUTHORIZED,
          "Publishing requires an unexpired Owner approval bound to this artifact and destination.",
          403,
          { authority: AUTHORITY_OWNER_POLICY, action: classification.action }
        );
      }
      // Binding revalidation: an approval with no artifact hash / destination is
      // not permission to publish that artifact anywhere.
      if (
        typeof ownerApproval.artifactHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(ownerApproval.artifactHash) ||
        typeof ownerApproval.destination !== "string" ||
        ownerApproval.destination.trim().length === 0
      ) {
        throw new FleetError(
          FLEET_ERROR.DIRECTOR_NOT_AUTHORIZED,
          "The Owner approval must be bound to an artifact hash and a destination before execution.",
          403,
          { binding: "artifact_hash_destination" }
        );
      }
    }

    const assigned = await this.repository.assignTask({ directorId, taskId, actor, correlationId, reason });
    return { action: "assign_task", task: assigned };
  }

  async cancelTask({ directorId, taskId, actor, correlationId, reason = "Cancelled by HERMES" }) {
    assertActor(actor);
    assertCorrelationId(correlationId);
    return this.repository.cancelTask({ directorId, taskId, actor, correlationId, reason });
  }

  async fleetSummary() {
    const snapshot = await this.repository.fleetSnapshot();
    return {
      generatedAt: snapshot.generatedAt,
      capacity: snapshot.capacity,
      counts: snapshot.counts,
      workers: {
        total: snapshot.workers.total,
        live: snapshot.workers.live,
        expired: snapshot.workers.expired,
      },
      blockedDirectors: snapshot.directors
        .filter((row) => row.healthState === "BLOCKED" || row.healthState === "OFFLINE")
        .map((row) => ({ directorId: row.directorId, healthState: row.healthState, escalationCode: row.escalationCode })),
    };
  }

  /** Director workload from task rows (never from planned work). */
  async workload({ directorId }) {
    assertDirectorId(directorId);
    const tasks = await this.repository.listTasks({ directorId, limit: 200 });
    const byStatus = {};
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    return {
      directorId,
      total: tasks.length,
      byStatus,
      active: tasks.filter((task) => ["ASSIGNED", "RUNNING"].includes(task.status)).length,
      queued: tasks.filter((task) => ["QUEUED", "RETRY_SCHEDULED"].includes(task.status)).length,
      blocked: tasks.filter((task) => task.status === "BLOCKED").length,
    };
  }
}
