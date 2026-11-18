/**
 * ST Production House — Live Publishing 5-Hour Owner Approval Timeout
 *
 * Policy contract:
 *   - Owner response window: 5 hours (18,000,000 ms) from durable `notifiedAt`.
 *   - Silence from the Owner is NEVER interpreted as approval.
 *   - If the Owner does not approve or reject within 5 hours, HERMES assumes
 *     delegated decision-making authority ONLY for that specific request AND
 *     ONLY when an explicitly configured, active, unexpired publishing policy
 *     permits execution.
 *   - HERMES must independently evaluate all 7 mandatory checks:
 *       productionQc, platformPolicy, copyright, legal,
 *       advertisingDisclosure, privacy, safety.
 *   - Explicit decision: APPROVE (all 7 pass + policy permits) or REJECT
 *     (any failure, missing evidence, or unacceptable risk).
 *   - Records decision, reasoning, policy checks, SHA-256 evidence hash, and
 *     queues an Owner notification.
 *   - Durable across server restarts via FilePublishingTimeoutStore.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const OWNER_APPROVAL_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

export const MANDATORY_PUBLISHING_CHECKS = Object.freeze([
  "productionQc",
  "platformPolicy",
  "copyright",
  "legal",
  "advertisingDisclosure",
  "privacy",
  "safety",
]);

export class FilePublishingTimeoutStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : { requests: {}, notifications: [] };
    } catch (err) {
      if (err && err.code === "ENOENT") return { requests: {}, notifications: [] };
      throw err;
    }
  }

  async save(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

export class HermesPublishingTimeoutEngine {
  constructor(options = {}) {
    this.store = options.store ?? null;
    this.requests = new Map();
    this.notifications = [];
    this._loaded = false;
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.store) return;
    const saved = await this.store.load();
    if (saved.requests && typeof saved.requests === "object") {
      for (const [id, req] of Object.entries(saved.requests)) {
        this.requests.set(id, req);
      }
    }
    if (Array.isArray(saved.notifications)) {
      this.notifications = saved.notifications;
    }
  }

  async _persist() {
    if (!this.store) return;
    const requestsObj = {};
    for (const [id, req] of this.requests.entries()) {
      requestsObj[id] = req;
    }
    await this.store.save({
      requests: requestsObj,
      notifications: this.notifications,
    });
  }

  async registerPublishingRequest({
    requestId = crypto.randomUUID(),
    directorId,
    artifactHash,
    destination,
    notifiedAt = new Date().toISOString(),
    delegatedPolicyId = null,
  }) {
    await this._ensureLoaded();
    if (!directorId || !artifactHash || !destination) {
      throw new Error("INVALID_PUBLISHING_REQUEST: directorId, artifactHash, and destination are required.");
    }
    const notifiedMs = new Date(notifiedAt).getTime();
    if (!Number.isFinite(notifiedMs)) {
      throw new Error("INVALID_NOTIFIED_AT_TIMESTAMP");
    }
    const record = {
      requestId,
      directorId,
      artifactHash,
      destination,
      notifiedAt: new Date(notifiedMs).toISOString(),
      ownerDeadlineAt: new Date(notifiedMs + OWNER_APPROVAL_WINDOW_MS).toISOString(),
      delegatedPolicyId,
      status: "AWAITING_OWNER",
      ownerDecision: null,
      hermesDecision: null,
    };
    this.requests.set(requestId, record);
    await this._persist();
    return record;
  }

  async recordOwnerDecision({ requestId, decision, decidedAt = new Date().toISOString() }) {
    await this._ensureLoaded();
    const record = this.requests.get(requestId);
    if (!record) throw new Error(`PUBLISHING_REQUEST_NOT_FOUND:${requestId}`);
    if (decision !== "APPROVE" && decision !== "REJECT") {
      throw new Error("INVALID_OWNER_DECISION");
    }
    record.ownerDecision = { decision, decidedAt };
    record.status = decision === "APPROVE" ? "OWNER_APPROVED" : "OWNER_REJECTED";
    await this._persist();
    return record;
  }

  async getRequest(requestId) {
    await this._ensureLoaded();
    return this.requests.get(requestId) ?? null;
  }

  async getOwnerNotifications() {
    await this._ensureLoaded();
    return [...this.notifications];
  }

  /**
   * Evaluates whether the 5-hour Owner response window has elapsed and, if so,
   * executes HERMES's independent evaluation for this single publishing request.
   */
  async evaluateTimeoutDelegation({
    requestId,
    policy = null,
    checks = {},
    now = new Date(),
  }) {
    await this._ensureLoaded();
    const record = this.requests.get(requestId);
    if (!record) {
      throw new Error(`PUBLISHING_REQUEST_NOT_FOUND:${requestId}`);
    }

    if (record.ownerDecision) {
      return {
        status: "OWNER_DECIDED",
        decision: record.ownerDecision.decision,
        requestId,
        note: "Owner decision already recorded; HERMES delegation does not apply.",
      };
    }

    const nowMs = new Date(now).getTime();
    const deadlineMs = new Date(record.ownerDeadlineAt).getTime();
    if (nowMs < deadlineMs) {
      return {
        status: "AWAITING_OWNER",
        decision: null,
        requestId,
        remainingMs: deadlineMs - nowMs,
        note: "Still within the 5-hour Owner approval window.",
      };
    }

    // 5-hour window has elapsed. Silence is NEVER approval.
    const policyExpired =
      policy?.expiresAt && nowMs > new Date(policy.expiresAt).getTime();
    const policyPermits =
      Boolean(policy) &&
      policy.active === true &&
      !policyExpired &&
      policy.permitsLivePublishing === true &&
      (!record.delegatedPolicyId || policy.policyId === record.delegatedPolicyId);

    const failedChecks = [];
    const evaluatedChecks = {};

    for (const checkName of MANDATORY_PUBLISHING_CHECKS) {
      const entry = checks?.[checkName];
      const passed =
        Boolean(entry) &&
        entry.passed === true &&
        typeof entry.evidence === "string" &&
        entry.evidence.trim().length > 0;
      evaluatedChecks[checkName] = {
        passed,
        evidence: entry?.evidence ?? null,
        reason: passed ? "VERIFIED" : entry?.reason || "MISSING_OR_FAILED_REQUIREMENT",
      };
      if (!passed) {
        failedChecks.push(checkName);
      }
    }

    let decision = "REJECT";
    let reasoning = "";

    if (!policyPermits) {
      decision = "REJECT";
      reasoning =
        "Owner did not respond within the 5-hour window, and no active, unexpired HERMES delegated publishing policy permits execution. Silence is never approval.";
    } else if (failedChecks.length > 0) {
      decision = "REJECT";
      reasoning = `HERMES independent evaluation rejected publishing: mandatory requirement(s) failed or lacked evidence [${failedChecks.join(", ")}].`;
    } else {
      decision = "APPROVE";
      reasoning =
        "Owner did not respond within 5 hours; active HERMES delegated publishing policy applies and all 7 mandatory QC, platform, copyright, legal, disclosure, privacy, and safety checks passed.";
    }

    const decidedAt = new Date(nowMs).toISOString();
    const evidenceHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          requestId,
          directorId: record.directorId,
          artifactHash: record.artifactHash,
          destination: record.destination,
          decision,
          evaluatedChecks,
          decidedAt,
        })
      )
      .digest("hex");

    const hermesDecision = {
      actor: "HERMES",
      decision,
      reasoning,
      policyId: policy?.policyId ?? null,
      policyPermits,
      evaluatedChecks,
      failedChecks,
      evidenceHash,
      decidedAt,
      delegationScope: "SINGLE_REQUEST_ONLY",
      grantsUnrestrictedPublishing: false,
      grantsSpendingAuthority: false,
      grantsAccountConnection: false,
      overridesOwnerReserved: false,
    };

    record.hermesDecision = hermesDecision;
    record.status =
      decision === "APPROVE"
        ? "HERMES_DELEGATED_APPROVED"
        : "HERMES_DELEGATED_REJECTED";

    const notification = {
      id: `notif-${crypto.randomUUID()}`,
      recipient: "OWNER",
      requestId,
      directorId: record.directorId,
      decision,
      reasoning,
      evidenceHash,
      notifiedAt: decidedAt,
    };
    this.notifications.push(notification);
    await this._persist();

    return {
      status: record.status,
      decision,
      hermesDecision,
      notification,
    };
  }
}
