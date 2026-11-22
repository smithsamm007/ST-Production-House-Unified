/**
 * ST Production House — Owner publishing-approval API (D5).
 *
 * Mounted in production behind the same Owner session gate, Owner-role check
 * and CSRF guard as the FORGE control plane. The router never trusts a
 * client-supplied owner identity: the Owner id comes from the authenticated
 * session that the mount resolved.
 *
 * Routes (all JSON):
 *   POST /requests                       submit a live publishing request
 *   GET  /requests                       Owner-scoped request list
 *   GET  /requests/:id                   request + notification + decision state
 *   POST /requests/:id/notify            retry bounded Owner notification
 *   POST /requests/:id/owner-decision    APPROVE | REJECT | CHANGES_REQUESTED
 *   POST /requests/:id/invalidate        bind-break (artifact changed / withdrawn)
 *   GET  /requests/:id/authorization     publishing gate revalidation
 *   POST /deadline/run                   run one durable deadline cycle
 *   POST /policies                       register a delegated publishing policy
 *   POST /policies/:policyId/revoke      revoke it
 */

import express from "express";

import {
  ApprovalError,
  NOTIFICATION_KIND,
  mapNotification,
  ownerNotificationDedupeKey,
} from "../publishing/publishingApprovalRepository.js";
import { buildOwnerApprovalRequestNotification } from "../publishing/publishingApprovalDeadlineWorker.js";

const SHA256 = /^[a-f0-9]{64}$/;
const PLATFORMS = new Set(["youtube", "instagram", "facebook", "snapchat", "bilibili"]);

function fail(res, code, message, status = 400) {
  return res.status(status).json({ code, message: message ?? code });
}

function publicError(error) {
  if (error instanceof ApprovalError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return { code: error?.code ?? "APPROVAL_REQUEST_FAILED", message: "The approval request could not be processed.", status: 500 };
}

function requireString(value, code, { max = 200, pattern = null } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ApprovalError(code, "A bounded string is required.", 400);
  }
  if (pattern && !pattern.test(value)) throw new ApprovalError(code, "Value has an invalid format.", 400);
  return value;
}

/** Sanitized DTO: no owner email, no secrets, no internal provider material. */
export function approvalDto(request, notifications = [], decisions = []) {
  if (!request) return null;
  return {
    approvalId: request.id,
    directorId: request.directorId,
    universeId: request.universeId,
    packageId: request.packageId,
    requestedAction: request.requestedAction,
    artifactSha256: request.artifactSha256,
    destinations: request.destinations,
    policyVersion: request.policyVersion,
    delegatedPolicyId: request.delegatedPolicyId,
    status: request.status,
    createdAt: request.createdAt,
    notifiedAt: request.notifiedAt,
    deadlineAt: request.deadlineAt,
    ownerResponseAt: request.ownerResponseAt,
    ownerResponseReason: request.ownerResponseReason,
    hermesDecision: request.hermesDecision,
    hermesDecidedAt: request.hermesDecidedAt,
    decisionReasonCodes: request.decisionReasonCodes,
    decisionSummary: request.decisionSummary,
    evaluatedChecks: request.evaluatedChecks ?? null,
    decisionEvidenceHash: request.decisionEvidenceHash,
    publishingAuthorized: request.publishingAuthorized,
    authorizationExpiresAt: request.authorizationExpiresAt,
    invalidatedAt: request.invalidatedAt,
    supersededBy: request.supersededBy,
    notifications: notifications.map((n) => ({
      kind: n.kind,
      channel: n.channel,
      state: n.state,
      attempts: n.attempts,
      deliveredAt: n.deliveredAt,
      failedAt: n.failedAt,
      lastError: n.lastError ? "DELIVERY_FAILED" : null,
    })),
    decisions: decisions.map((d) => ({
      actor: d.actor,
      decision: d.decision,
      reasonCodes: d.reasonCodes,
      summary: d.summary,
      policyId: d.policyId,
      policyVersion: d.policyVersion,
      evidenceHash: d.evidenceHash,
      decidedAt: d.decidedAt,
    })),
  };
}

export function createPublishingApprovalRouter({
  repository,
  worker,
  verifyCsrf = () => false,
  getOwnerId = (req) => req?.forgeSession?.id ?? null,
  appendEvidence = null,
  logger = console,
}) {
  if (!repository) throw new Error("APPROVAL_REPOSITORY_REQUIRED");
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  const guard = (handler) => async (req, res) => {
    try {
      const ownerId = getOwnerId(req);
      if (!ownerId) return fail(res, "UNAUTHORIZED", "Authenticated Owner session required.", 401);
      const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
      if (mutation && verifyCsrf(req) !== true) {
        return fail(res, "CSRF_REJECTED", "A valid CSRF token is required for mutations.", 403);
      }
      await handler(req, res, ownerId);
    } catch (error) {
      const shaped = publicError(error);
      if (shaped.status >= 500) {
        logger.error?.(
          JSON.stringify({ level: "error", code: shaped.code, message: error?.message ?? null })
        );
      }
      return fail(res, shaped.code, shaped.message, shaped.status);
    }
  };

  const loadScoped = async (req, res) => {
    const request = await repository.getRequest(req.params.id);
    if (!request) {
      fail(res, "APPROVAL_REQUEST_NOT_FOUND", "Unknown approval request.", 404);
      return null;
    }
    const ownerId = getOwnerId(req);
    if (request.ownerId !== ownerId) {
      fail(res, "APPROVAL_REQUEST_NOT_FOUND", "Unknown approval request.", 404);
      return null;
    }
    return request;
  };

  const deliverInitial = async (notification) => {
    try {
      await worker.deliver(notification);
    } catch {
      // Delivery failure is recorded on the row by the worker; never invented.
    }
    return repository.getNotification(notification.dedupeKey);
  };

  // --------------------------------------------------------------- requests
  router.post(
    "/requests",
    guard(async (req, res, ownerId) => {
      const body = req.body ?? {};
      if (body.ownerId !== undefined && body.ownerId !== ownerId) {
        throw new ApprovalError("SCOPE_MISMATCH", "Client-supplied owner identity is refused.", 403);
      }
      const artifactSha256 = requireString(body.artifactSha256, "ARTIFACT_HASH_REQUIRED", {
        max: 64,
        pattern: SHA256,
      });
      if (!Array.isArray(body.destinations) || body.destinations.length === 0) {
        throw new ApprovalError("DESTINATIONS_REQUIRED", "One or more destinations are required.", 400);
      }
      for (const destination of body.destinations) {
        if (typeof destination !== "string" || !PLATFORMS.has(destination.toLowerCase())) {
          throw new ApprovalError("INVALID_PLATFORM_DESTINATION", "Unsupported destination.", 400);
        }
      }
      const policyVersion = requireString(body.policyVersion, "POLICY_VERSION_REQUIRED", { max: 40 });

      const { request, deduplicated } = await repository.createRequest({
        idempotencyKey: requireString(body.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED", { max: 200 }),
        ownerId,
        directorId: requireString(body.directorId, "DIRECTOR_ID_REQUIRED", { max: 80 }),
        universeId: body.universeId ?? null,
        packageId: body.packageId ?? null,
        artifactSha256,
        destinations: body.destinations,
        captionSnapshot: body.captionSnapshot ?? {},
        policyVersion,
        delegatedPolicyId: body.delegatedPolicyId ?? null,
      });

      const { notification } = await repository.queueNotification({
        approvalId: request.id,
        kind: NOTIFICATION_KIND.OWNER_APPROVAL_REQUEST,
        dedupeKey: ownerNotificationDedupeKey(request.id),
        body: buildOwnerApprovalRequestNotification(request),
      });
      const delivered = await deliverInitial(notification);
      const current = (await repository.getRequest(request.id)) ?? request;

      return res.status(deduplicated ? 200 : 201).json({
        deduplicated,
        request: approvalDto(
          current,
          await repository.listNotifications(current.id),
          await repository.listDecisions(current.id)
        ),
        notification: delivered ? mapNotification(delivered) : null,
      });
    })
  );

  router.get(
    "/requests",
    guard(async (req, res, ownerId) => {
      const requests = await repository.listRequests({ ownerId, limit: 100 });
      return res.status(200).json({ count: requests.length, requests: requests.map((r) => approvalDto(r)) });
    })
  );

  router.get(
    "/requests/:id",
    guard(async (req, res) => {
      const request = await loadScoped(req, res);
      if (!request) return;
      return res.status(200).json({
        request: approvalDto(
          request,
          await repository.listNotifications(request.id),
          await repository.listDecisions(request.id)
        ),
      });
    })
  );

  router.post(
    "/requests/:id/notify",
    guard(async (req, res) => {
      const request = await loadScoped(req, res);
      if (!request) return;
      const dedupeKey = ownerNotificationDedupeKey(request.id);
      const notification = await repository.retryNotification(dedupeKey);
      await deliverInitial(notification);
      const current = await repository.getRequest(request.id);
      return res.status(200).json({
        request: approvalDto(
          current,
          await repository.listNotifications(current.id),
          await repository.listDecisions(current.id)
        ),
      });
    })
  );

  router.post(
    "/requests/:id/owner-decision",
    guard(async (req, res, ownerId) => {
      const request = await loadScoped(req, res);
      if (!request) return;
      const body = req.body ?? {};
      const decision = requireString(body.decision, "OWNER_DECISION_INVALID", { max: 20 });
      if (!["APPROVE", "REJECT", "CHANGES_REQUESTED"].includes(decision)) {
        throw new ApprovalError("OWNER_DECISION_INVALID", "APPROVE, REJECT or CHANGES_REQUESTED required.", 400);
      }
      const artifactSha256 = requireString(body.artifactSha256, "ARTIFACT_HASH_REQUIRED", {
        max: 64,
        pattern: SHA256,
      });
      const { request: updated, deduplicated } = await repository.recordOwnerDecision({
        approvalId: request.id,
        ownerId,
        decision,
        artifactSha256,
        reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
      });
      if (appendEvidence) {
        try {
          await appendEvidence({
            subjectId: request.id,
            kind: "owner_publishing_decision",
            classification: "owner_authorized_publishing_decision",
            payload: {
              approvalId: request.id,
              ownerId,
              decision,
              artifactSha256,
              directorId: request.directorId,
            },
          });
        } catch {
          // Evidence append failure never fabricates an approval; the durable
          // decision row above remains the authoritative record.
        }
      }
      return res.status(200).json({
        deduplicated,
        request: approvalDto(
          updated,
          await repository.listNotifications(updated.id),
          await repository.listDecisions(updated.id)
        ),
      });
    })
  );

  router.post(
    "/requests/:id/invalidate",
    guard(async (req, res) => {
      const request = await loadScoped(req, res);
      if (!request) return;
      const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
      const updated = await repository.invalidateRequest({
        approvalId: request.id,
        reason: reason ?? "OWNER_INVALIDATED_REQUEST",
      });
      return res.status(200).json({ request: approvalDto(updated) });
    })
  );

  router.get(
    "/requests/:id/authorization",
    guard(async (req, res) => {
      const request = await loadScoped(req, res);
      if (!request) return;
      const artifactSha256 = typeof req.query.artifactSha256 === "string" ? req.query.artifactSha256 : null;
      const destination = typeof req.query.destination === "string" ? req.query.destination : null;
      const result = await repository.verifyAuthorization({
        approvalId: request.id,
        artifactSha256,
        destination,
      });
      return res.status(result.authorized ? 200 : 409).json(result);
    })
  );

  // ----------------------------------------------------------- deadline work
  router.post(
    "/deadline/run",
    guard(async (req, res) => {
      const summary = await worker.runOnce();
      return res.status(200).json({ cycle: summary });
    })
  );

  // ----------------------------------------------------------------- policies
  router.post(
    "/policies",
    guard(async (req, res) => {
      const body = req.body ?? {};
      const policy = await repository.registerPolicy({
        policyId: requireString(body.policyId, "POLICY_ID_INVALID", { max: 200 }),
        category: "publishing",
        allowedActions: ["publishing.publish_publicly"],
        maxRisk: typeof body.maxRisk === "string" ? body.maxRisk : "medium",
        expiresAt: body.expiresAt ?? null,
        policyVersion: Number.isInteger(body.policyVersion) ? body.policyVersion : 1,
        permitsLivePublishing: body.permitsLivePublishing !== false,
      });
      return res.status(201).json({ policy });
    })
  );

  router.post(
    "/policies/:policyId/revoke",
    guard(async (req, res) => {
      const policy = await repository.revokePolicy(req.params.policyId);
      if (!policy) return fail(res, "POLICY_NOT_FOUND", "Unknown delegated policy.", 404);
      return res.status(200).json({ policy });
    })
  );

  router.use((req, res) => fail(res, "NOT_FOUND", "Unknown approval route.", 404));

  return router;
}
