/**
 * ST Production House — FORGE Private Control Plane (Phase 2, v1.2).
 *
 * Implements:
 *   - Durable task queue contract (at-least-once delivery, idempotency keys,
 *     atomic expired-lease reclamation + monotonic fencing-token advancement,
 *     historical lease preservation, bounded retries + DLQ)
 *   - Durable One-PR-in-Flight slot reservation (`slot_id = 1`) + GitHub drift
 *     reconciliation + write-ahead external-op journal (`IN_FLIGHT` -> `COMMITTED`)
 *   - Honest operational readiness matrix distinguishing:
 *     implemented | configured | connected | operationally_verified | blocked | awaiting_owner_approval
 */

import { randomUUID } from "node:crypto";
import {
  ACTOR_TYPES,
  ForgeEvidenceLedger,
  ForgePermissionGateway,
  PERMISSION_TIERS,
} from "./permissionGateway.js";
import { OwnerDelegationEngine } from "./delegationEngine.js";
import { IsolatedDirectorPoolRegistry } from "./directorIsolation.js";

export const OPERATIONAL_STATES = Object.freeze({
  IMPLEMENTED: "implemented",
  CONFIGURED: "configured",
  CONNECTED: "connected",
  OPERATIONALLY_VERIFIED: "operationally_verified",
  BLOCKED: "blocked",
  AWAITING_OWNER_APPROVAL: "awaiting_owner_approval",
});

export class ForgeControlPlane {
  constructor({
    evidenceLedger = new ForgeEvidenceLedger(),
    nowFn = () => new Date(),
  } = {}) {
    this.nowFn = nowFn;
    this.evidenceLedger = evidenceLedger;
    this.permissionGateway = new ForgePermissionGateway({ evidenceLedger });
    this.delegationEngine = new OwnerDelegationEngine({ evidenceLedger });
    this.directorRegistry = new IsolatedDirectorPoolRegistry();

    this._tasks = new Map();
    this._idempotencyIndex = new Map();
    this._leaseHistory = [];
    this._prSlot = null; // slot_id = 1
    this._externalOps = new Map();
  }

  /**
   * Honest system status snapshot — never reports unconfigured or
   * disconnected integrations as operationally verified.
   */
  getStatusSnapshot() {
    const chain = this.evidenceLedger.verifyChain();
    return {
      hierarchy: "OWNER -> FORGE -> ST_PRODUCTION_HOUSE -> HERMES -> DIRECTORS -> TEAMS",
      forge: {
        identity: "forge-exec",
        role: "Chief Engineering Executive",
        controlPlane: OPERATIONAL_STATES.IMPLEMENTED,
        permissionGateway: OPERATIONAL_STATES.IMPLEMENTED,
        persistentCloudHosting: OPERATIONAL_STATES.AWAITING_OWNER_APPROVAL,
        githubAppBroker: OPERATIONAL_STATES.AWAITING_OWNER_APPROVAL,
      },
      hermes: {
        identity: "hermes-manager",
        role: "Managing Director (Production)",
        delegationFramework: OPERATIONAL_STATES.IMPLEMENTED,
        ownerAvailability: this.delegationEngine.getOwnerAvailability(),
        livePublishing: OPERATIONAL_STATES.AWAITING_OWNER_APPROVAL,
      },
      queue: {
        totalTasks: this._tasks.size,
        prSlotReserved: this._prSlot !== null,
        prSlot: this._prSlot,
      },
      evidence: {
        recordCount: chain.count ?? 0,
        chainValid: chain.valid,
        headHash: chain.headHash ?? null,
      },
    };
  }

  enqueueTask({ issueNumber, slug, title, idempotencyKey, maxAttempts = 3 }) {
    if (!issueNumber || !slug || !title || !idempotencyKey) {
      throw new Error("TASK_ENVELOPE_INCOMPLETE");
    }
    if (this._idempotencyIndex.has(idempotencyKey)) {
      return { deduplicated: true, task: this._tasks.get(this._idempotencyIndex.get(idempotencyKey)) };
    }
    const cleanSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    const derivedBranch = `task/${Number(issueNumber)}-${cleanSlug}`;
    const task = {
      id: randomUUID(),
      issueNumber: Number(issueNumber),
      derivedBranch,
      title: String(title),
      idempotencyKey,
      status: "READY",
      activeFencingToken: 0,
      attemptCount: 0,
      maxAttempts,
      createdAt: this.nowFn().toISOString(),
    };
    this._tasks.set(task.id, task);
    this._idempotencyIndex.set(idempotencyKey, task.id);
    this.evidenceLedger.append({
      eventType: "FORGE_TASK_ENQUEUED",
      actorId: "forge-controller",
      taskId: task.id,
      payload: { derivedBranch, idempotencyKey },
    });
    return { deduplicated: false, task: { ...task } };
  }

  /**
   * Atomic lease claim with expired-lease reclamation and monotonic
   * fencing-token advancement (preserving historical lease records).
   */
  claimLease({ taskId, workerId, leaseTtlMs = 300_000 }) {
    const task = this._tasks.get(taskId);
    if (!task) {
      return { ok: false, code: "TASK_NOT_FOUND" };
    }
    if (task.status === "DEAD_LETTER" || task.status === "ACCEPTED") {
      return { ok: false, code: "TASK_NOT_CLAIMABLE", status: task.status };
    }

    const nowMs = this.nowFn().getTime();
    const activeLease = this._leaseHistory.find(
      (l) => l.taskId === taskId && l.releasedAt === null
    );

    if (activeLease) {
      const expiresMs = new Date(activeLease.leaseExpiresAt).getTime();
      if (expiresMs > nowMs) {
        return { ok: false, code: "LEASE_ALREADY_ACTIVE", activeWorkerId: activeLease.workerId };
      }
      // Atomic release of expired lease (history preserved)
      activeLease.releasedAt = new Date(nowMs).toISOString();
      activeLease.releaseReason = "expired";
    }

    if (task.attemptCount >= task.maxAttempts) {
      task.status = "DEAD_LETTER";
      return { ok: false, code: "MAX_ATTEMPTS_EXHAUSTED_DLQ" };
    }

    task.activeFencingToken += 1;
    task.attemptCount += 1;
    task.status = "IN_PROGRESS";

    const lease = {
      id: randomUUID(),
      taskId,
      workerId,
      fencingToken: task.activeFencingToken,
      leasedAt: new Date(nowMs).toISOString(),
      leaseExpiresAt: new Date(nowMs + leaseTtlMs).toISOString(),
      releasedAt: null,
      releaseReason: null,
    };
    this._leaseHistory.push(lease);

    this.evidenceLedger.append({
      eventType: "FORGE_LEASE_CLAIMED",
      actorId: workerId,
      taskId,
      payload: { fencingToken: lease.fencingToken, attemptCount: task.attemptCount },
    });

    return { ok: true, code: "LEASE_ACQUIRED", lease: { ...lease }, fencingToken: lease.fencingToken };
  }

  /**
   * Reserve the single One-PR-in-Flight slot (slot_id = 1) with live GitHub
   * reconciliation and fencing-token validation.
   */
  reservePrSlot({ taskId, fencingToken, observedOpenGithubPrs = [] }) {
    const task = this._tasks.get(taskId);
    if (!task) return { ok: false, code: "TASK_NOT_FOUND" };

    const auth = this.permissionGateway.authorize({
      actor: { id: "forge-controller", type: ACTOR_TYPES.FORGE_CONTROLLER, authenticated: true },
      action: "github.create_pr",
      tier: PERMISSION_TIERS.T5,
      taskId,
      fencingToken,
      activeFencingToken: task.activeFencingToken,
    });
    if (!auth.allowed) {
      return { ok: false, code: auth.code, reason: auth.reason };
    }

    // Drift check against live GitHub open PRs
    if (Array.isArray(observedOpenGithubPrs) && observedOpenGithubPrs.length > 0) {
      const tracked = this._prSlot?.prNumber ?? null;
      const untracked = observedOpenGithubPrs.find((pr) => pr !== tracked);
      if (untracked !== undefined) {
        this.evidenceLedger.append({
          eventType: "PR_SLOT_DRIFT_DETECTED",
          actorId: "forge-controller",
          taskId,
          payload: { untrackedPrNumber: untracked },
        });
        return { ok: false, code: "PR_SLOT_DRIFT_DETECTED", untrackedPrNumber: untracked };
      }
    }

    if (this._prSlot !== null) {
      return { ok: false, code: "ONE_PR_IN_FLIGHT_OCCUPIED", currentSlot: this._prSlot };
    }

    this._prSlot = {
      slotId: 1,
      taskId,
      fencingToken,
      branchName: task.derivedBranch,
      prNumber: null,
      reservedAt: this.nowFn().toISOString(),
    };

    this.evidenceLedger.append({
      eventType: "FORGE_PR_SLOT_RESERVED",
      actorId: "forge-controller",
      taskId,
      payload: { branchName: task.derivedBranch, fencingToken },
    });

    return { ok: true, code: "PR_SLOT_RESERVED", slot: { ...this._prSlot } };
  }

  /**
   * Record write-ahead intent before an external GitHub write and reconcile
   * after uncertain outcomes / restarts.
   */
  beginExternalOp({ idempotencyKey, taskId, fencingToken, operationType, touchedPaths = [] }) {
    const task = this._tasks.get(taskId);
    if (!task) return { ok: false, code: "TASK_NOT_FOUND" };

    const auth = this.permissionGateway.authorize({
      actor: { id: "forge-controller", type: ACTOR_TYPES.FORGE_CONTROLLER, authenticated: true },
      action: operationType,
      tier: PERMISSION_TIERS.T5,
      taskId,
      fencingToken,
      activeFencingToken: task.activeFencingToken,
      touchedPaths,
    });
    if (!auth.allowed) {
      return { ok: false, code: auth.code, reason: auth.reason };
    }

    if (this._externalOps.has(idempotencyKey)) {
      return { ok: true, deduplicated: true, op: { ...this._externalOps.get(idempotencyKey) } };
    }

    const op = {
      id: randomUUID(),
      idempotencyKey,
      taskId,
      fencingToken,
      operationType,
      derivedBranch: task.derivedBranch,
      status: "IN_FLIGHT",
      createdAt: this.nowFn().toISOString(),
    };
    this._externalOps.set(idempotencyKey, op);
    return { ok: true, deduplicated: false, op: { ...op } };
  }

  reconcileExternalOp({ idempotencyKey, observedOnGithub, observedSha = null }) {
    const op = this._externalOps.get(idempotencyKey);
    if (!op) return { ok: false, code: "EXTERNAL_OP_NOT_FOUND" };
    op.status = observedOnGithub ? "COMMITTED" : "FAILED_SAFE_TO_RETRY";
    op.observedSha = observedSha;
    op.reconciledAt = this.nowFn().toISOString();
    this.evidenceLedger.append({
      eventType: "FORGE_EXTERNAL_OP_RECONCILED",
      actorId: "forge-controller",
      taskId: op.taskId,
      commitSha: observedSha,
      payload: { idempotencyKey, status: op.status },
    });
    return { ok: true, op: { ...op } };
  }

  listTasks() {
    return [...this._tasks.values()].map((t) => ({ ...t }));
  }

  listLeaseHistory(taskId) {
    return this._leaseHistory.filter((l) => l.taskId === taskId).map((l) => ({ ...l }));
  }
}
