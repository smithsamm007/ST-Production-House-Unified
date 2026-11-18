/**
 * ST Production House — Authenticated FORGE Control Plane Express Router (Phase 2).
 *
 * Enforces:
 *   - Owner session authentication on all routes
 *   - CSRF validation on mutating requests (POST/PUT/PATCH/DELETE)
 *   - Input validation & safe-DTO allowlisted responses (Rule 17)
 *
 * The application mounts this router behind its real Owner authentication and
 * CSRF validation and supplies `verifyCsrf` as an async verifier that consults
 * the validated session token; `await` is required, so an async verifier is
 * supported. The default below (token header present) is only a fallback for
 * standalone mounting and is NOT used by the application mount.
 */

import express from "express";

export function createForgeControlRouter({
  controlPlane,
  authenticateSession,
  verifyCsrf = (req) => Boolean(req.headers["x-csrf-token"]),
} = {}) {
  if (!controlPlane) {
    throw new Error("FORGE_CONTROL_PLANE_REQUIRED");
  }
  if (typeof authenticateSession !== "function") {
    throw new Error("AUTHENTICATE_SESSION_REQUIRED");
  }

  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  // Secure HTTP headers on all control-plane responses
  router.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Require authenticated Owner session on all routes
  router.use((req, res, next) => {
    const session = authenticateSession(req);
    if (!session || !session.authenticated || session.role !== "owner") {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authenticated Owner session required." });
    }
    req.ownerSession = session;
    return next();
  });

  // Require a validated CSRF token on mutations (async-capable verifier)
  router.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      let csrfOk = false;
      try {
        csrfOk = (await verifyCsrf(req)) === true;
      } catch {
        csrfOk = false;
      }
      if (!csrfOk) {
        return res.status(403).json({ code: "CSRF_TOKEN_REQUIRED", message: "Valid CSRF token required for mutations." });
      }
    }
    return next();
  });

  router.get("/status", async (req, res, next) => {
    try {
      const snapshot = await controlPlane.getFullStatusSnapshot();
      return res.status(200).json(snapshot);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/tasks", async (req, res, next) => {
    try {
      const tasks = await controlPlane.listTasks();
      return res.status(200).json({ tasks });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/tasks", async (req, res, next) => {
    const { issueNumber, slug, title, idempotencyKey } = req.body ?? {};
    if (!issueNumber || !slug || !title || !idempotencyKey) {
      return res.status(400).json({ code: "INVALID_TASK_ENVELOPE", message: "issueNumber, slug, title, and idempotencyKey are required." });
    }
    try {
      const result = await controlPlane.enqueueTask({ issueNumber, slug, title, idempotencyKey });
      return res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/authorize", (req, res) => {
    const decision = controlPlane.permissionGateway.authorize(req.body);
    return res.status(decision.allowed ? 200 : 403).json(decision);
  });

  router.post("/delegation/evaluate", (req, res) => {
    const { category, action, resource, decisionDeadline, policyId, riskAssessment } = req.body ?? {};
    if (!category || !action || !resource) {
      return res.status(400).json({ code: "INVALID_DELEGATION_REQUEST", message: "category, action, and resource are required." });
    }
    const record = controlPlane.delegationEngine.evaluate({
      category,
      action,
      resource,
      decisionDeadline,
      policyId,
      riskAssessment,
    });
    return res.status(200).json(record);
  });

  router.get("/evidence", (_req, res) => {
    return res.status(200).json({
      verification: controlPlane.evidenceLedger.verifyChain(),
      records: controlPlane.evidenceLedger.list(),
    });
  });

  return router;
}
