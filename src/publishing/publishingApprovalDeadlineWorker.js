/**
 * ST Production House — durable five-hour deadline worker (D5).
 *
 * The worker does not own the deadline: PostgreSQL does. Each cycle leases
 * expired requests atomically (`FOR UPDATE SKIP LOCKED`), re-reads the request
 * and deadline inside the finalizing transaction, and writes exactly one
 * terminal decision. A restart, a crashed cycle or two concurrent instances
 * therefore produce the same durable outcome.
 *
 * The in-process interval is only a TRIGGER — never the authority. `runOnce()`
 * is safe to call from a timer, from a boot hook, or from an HTTP ops route.
 */

import crypto from "node:crypto";
import { evaluateDelegatedPublishingDecision } from "./hermesDelegatedPublishingDecision.js";
import {
  NOTIFICATION_KIND,
  decisionNotificationDedupeKey,
} from "./publishingApprovalRepository.js";

/** Outcomes where the worker must write nothing: someone else owns the truth. */
export const NON_RETRYABLE_SKIP_CODES = Object.freeze([
  "OWNER_RESPONSE_WON",
  "DECISION_ALREADY_TERMINAL",
  "OWNER_WINDOW_NOT_EXPIRED",
  "OWNER_WINDOW_NOT_OPEN",
  "APPROVAL_REQUEST_SUPERSEDED",
  "APPROVAL_REQUEST_NOT_FOUND",
  "FENCING_TOKEN_STALE",
  "LEASE_EXPIRED",
  "LEASE_HELD_BY_OTHER_WORKER",
  "LEASE_NOT_HELD",
]);

export function buildOwnerApprovalRequestNotification(request) {
  return {
    kind: NOTIFICATION_KIND.OWNER_APPROVAL_REQUEST,
    recipient: "OWNER",
    approvalId: request.id,
    directorId: request.directorId,
    universeId: request.universeId,
    packageId: request.packageId,
    destinations: request.destinations,
    artifactSha256: request.artifactSha256,
    requestedAt: request.createdAt,
    windowHours: 5,
    reviewReference: `/api/publishing-approvals/requests/${request.id}`,
    message:
      "A Director submitted a live publishing request. Approve, reject or request changes within five hours of this notification.",
  };
}

export function buildHermesDecisionNotification(request) {
  return {
    kind: NOTIFICATION_KIND.HERMES_DECISION,
    recipient: "OWNER",
    approvalId: request.id,
    directorId: request.directorId,
    packageId: request.packageId,
    decision: request.hermesDecision,
    decidedAt: request.hermesDecidedAt,
    destinations: request.destinations,
    artifactSha256: request.artifactSha256,
    reasonCodes: request.decisionReasonCodes,
    summary: request.decisionSummary,
    evidenceHash: request.decisionEvidenceHash,
    publishingAuthorized: request.publishingAuthorized,
    message:
      request.hermesDecision === "APPROVE"
        ? "Owner did not respond within five hours. HERMES approved this single request under the active delegated publishing policy."
        : "Owner did not respond within five hours. HERMES rejected this request; publishing is not authorized.",
  };
}

/**
 * Default channel: the durable Owner inbox (the notification row itself, read
 * back after commit). This is in-app delivery only — no email/SMS/push channel
 * is configured, and nothing here claims one is.
 */
export function createOwnerInboxNotifier({ repository }) {
  return {
    channel: "owner_inbox",
    async deliver({ notification }) {
      const persisted = await repository.getNotification(notification.dedupeKey);
      if (!persisted || persisted.id !== notification.id) {
        throw new Error("OWNER_INBOX_NOT_DURABLE");
      }
      return { channel: "owner_inbox", verified: true };
    },
  };
}

export class PublishingApprovalDeadlineWorker {
  constructor({
    repository,
    checksProvider = null,
    notifier = null,
    instanceId = `approval-worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
    leaseSeconds = 60,
    batchSize = 10,
    logger = console,
  } = {}) {
    if (!repository) throw new Error("APPROVAL_REPOSITORY_REQUIRED");
    this.repository = repository;
    this.checksProvider = checksProvider ?? (async () => ({}));
    this.notifier = notifier ?? createOwnerInboxNotifier({ repository });
    this.instanceId = instanceId;
    this.leaseSeconds = leaseSeconds;
    this.batchSize = batchSize;
    this.logger = logger;
    this._timer = null;
    this._running = false;
  }

  async runOnce() {
    if (this._running) return { skippedCycle: true, reason: "CYCLE_ALREADY_RUNNING" };
    this._running = true;
    const summary = {
      instanceId: this.instanceId,
      claimed: 0,
      approved: 0,
      rejected: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };
    try {
      const claimed = await this.repository.claimExpiredApprovals({
        workerId: this.instanceId,
        leaseSeconds: this.leaseSeconds,
        limit: this.batchSize,
      });
      summary.claimed = claimed.length;
      for (const item of claimed) {
        const outcome = await this._processOne(item);
        summary[outcome.outcome] += 1;
        summary.results.push(outcome);
      }
      return summary;
    } finally {
      this._running = false;
    }
  }

  async _processOne({ request, fencingToken }) {
    let checks = {};
    let checksError = null;
    try {
      checks = (await this.checksProvider({ request, repository: this.repository })) ?? {};
    } catch (error) {
      // Unavailable evidence is NEVER "passed": the evaluator rejects it.
      checksError = error?.message ?? "EVIDENCE_PROVIDER_FAILED";
      checks = {};
    }

    const policy = request.delegatedPolicyId
      ? await this.repository.getPolicy(request.delegatedPolicyId)
      : null;
    const policyAuthority = this.repository.evaluatePolicyAuthority({ policy, request });

    const evaluation = evaluateDelegatedPublishingDecision({
      request,
      policy,
      checks,
      now: new Date(),
      policyPermits: policyAuthority.permits,
      policyReasons: policyAuthority.reasons,
    });

    const reasonCodes = [...evaluation.reasonCodes];
    if (checksError) reasonCodes.push("EVIDENCE_PROVIDER_UNAVAILABLE");

    let finalized;
    try {
      finalized = await this.repository.finalizeHermesDecision({
        approvalId: request.id,
        fencingToken,
        decision: evaluation.decision,
        reasonCodes,
        summary: evaluation.summary,
        evaluatedChecks: evaluation.evaluatedChecks,
        evidenceHash: evaluation.evidenceHash,
        evidenceRefs: [
          { kind: "hermes_evaluation", evidenceHash: evaluation.evidenceHash },
          ...(checksError ? [{ kind: "evidence_provider_error", code: checksError }] : []),
        ],
        workerId: this.instanceId,
      });
    } catch (error) {
      if (NON_RETRYABLE_SKIP_CODES.includes(error?.code)) {
        return {
          outcome: "skipped",
          approvalId: request.id,
          code: error.code,
          fencingToken,
        };
      }
      return {
        outcome: "failed",
        approvalId: request.id,
        code: error?.code ?? "FINALIZE_FAILED",
        message: error?.message ?? null,
        fencingToken,
      };
    }

    const decision = finalized.request;
    let notificationState = "not_queued";
    try {
      const { notification } = await this.repository.queueNotification({
        approvalId: decision.id,
        kind: NOTIFICATION_KIND.HERMES_DECISION,
        dedupeKey: decisionNotificationDedupeKey(decision.id),
        body: buildHermesDecisionNotification(decision),
      });
      notificationState = await this._deliver(notification);
    } catch (error) {
      notificationState = `failed:${error?.code ?? "NOTIFICATION_ERROR"}`;
    }

    return {
      outcome: finalized.decision === "APPROVE" ? "approved" : "rejected",
      approvalId: decision.id,
      status: decision.status,
      decision: finalized.decision,
      reasonCodes: decision.decisionReasonCodes,
      authorizationGranted: finalized.authorizationGranted,
      notificationState,
      fencingToken,
    };
  }

  async _deliver(notification) {
    try {
      await this.notifier.deliver({ notification });
      const delivered = await this.repository.markNotificationDelivered({
        dedupeKey: notification.dedupeKey,
      });
      return delivered.notification?.state ?? "delivered";
    } catch (error) {
      const failed = await this.repository.markNotificationFailed({
        dedupeKey: notification.dedupeKey,
        error,
      });
      this.logger.warn?.(
        JSON.stringify({
          level: "warn",
          code: "APPROVAL_NOTIFICATION_DELIVERY_FAILED",
          approvalId: notification.approvalId,
          kind: notification.kind,
          state: failed.state,
        })
      );
      return failed.state;
    }
  }

  /** Delivery entry point used by the HTTP layer for the initial request. */
  async deliver(notification) {
    return this._deliver(notification);
  }

  start({ intervalMs = 30_000 } = {}) {
    if (this._timer) return this._timer;
    this._timer = setInterval(() => {
      this.runOnce().catch((error) => {
        this.logger.error?.(
          JSON.stringify({
            level: "error",
            code: "APPROVAL_DEADLINE_CYCLE_FAILED",
            message: error?.message ?? "unknown",
          })
        );
      });
    }, intervalMs);
    // Never hold the process open for a scheduler tick.
    this._timer.unref?.();
    return this._timer;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
