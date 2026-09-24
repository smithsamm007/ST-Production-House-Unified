/**
 * ST Production House — Owner API: Hermes manager command center.
 *
 * Issue #166. Authenticated routes exposing the Hermes decision layer:
 *
 *   GET  /overview        → counts by outcome/category, refusals, last decision
 *   GET  /decisions       → auditable decision history (safe DTO)
 *   POST /decisions       → record one decision (CSRF; authority enforced
 *                           SERVER-side; payload secret-gate)
 *   POST /decisions/:decisionNumber/complete
 *                         → honest completion (CSRF; EXECUTED only with a
 *                           ledger-verified evidence receipt — Rule 1)
 *   GET  /authority       → the frozen authority matrix (transparency)
 *
 * Security contract (AGENTS.md Rules 5, 6, 15, 17):
 * - Mount behind authenticateOwner; mutations require a per-session CSRF
 *   token; every state change writes an audit event.
 * - The payload secret-gate runs SERVER-side: secret-shaped fields/values
 *   are rejected before any record exists. Hermes never sees or holds
 *   secret values — it addresses credentials by REFERENCE only.
 * - Decision records are internal artifacts; the DTO is an explicit
 *   allowlist (Rule 15/17). No public output is produced here.
 * - No network I/O is added; without storage the routes degrade honestly
 *   with 503 (Rules 1–3).
 */

import { Router } from "express";
import { verifyCsrfToken } from "../catalog/ownerAuthentication.js";
import {
  HermesManager,
  HERMES_DECISION_CATEGORIES,
} from "../manager/hermesManager.js";
import { PostgresHermesDecisionStore } from "../manager/postgresHermesDecisionStore.js";
import { createHermesJobBridge } from "../manager/hermesJobBridge.js";
import {
  HERMES_AUTHORITY_MATRIX,
  AUTHORITY_AUTONOMOUS,
  AUTHORITY_OWNER_POLICY,
  AUTHORITY_PROHIBITED,
} from "../manager/authorityMatrix.js";

const DECISION_NUMBER_PATTERN = /^\d+$/;
const MAX_LIST_LIMIT = 200;

function hasOnlyFields(value, allowed) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

async function requireCsrf(req, res, next) {
  try {
    await verifyCsrfToken(req.session?.id, req.headers["x-csrf-token"]);
    return next();
  } catch {
    return res.status(403).json({ error: "CSRF_TOKEN_INVALID" });
  }
}

function logRouterError(event, err) {
  console.error(JSON.stringify({ event, error: err?.message ?? String(err) }));
}

function sendStorageError(res, err) {
  if (err?.code === "STORAGE_NOT_CONFIGURED") {
    return res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
  }
  return null;
}

export function createHermesRouter({ recordAuditEvent, fetchEvidence, productionRepository, evidenceLedger, db } = {}) {
  // Durable store (Issue #172): PostgresHermesDecisionStore over sql/023 when
  // a db adapter is injected. WITHOUT a db the router degrades HONESTLY — it
  // constructs no fake persistence and refuses decision writes with 503
  // (Rules 1–3). The in-memory store remains only for explicitly-labeled
  // demo/test transports.
  let manager = null;
  if (db !== undefined) {
    const store = new PostgresHermesDecisionStore({ db });
    manager = new HermesManager(store, {
      nextDecisionNumber: () => store.nextDecisionNumber(),
    });
  }
  const requireManager = () => {
    if (!manager) {
      const error = new Error("STORAGE_NOT_CONFIGURED");
      error.code = "STORAGE_NOT_CONFIGURED";
      throw error;
    }
    return manager;
  };
  const router = Router();

  router.get("/authority", (req, res) => {
    const matrix = {};
    for (const [action, authority] of Object.entries(HERMES_AUTHORITY_MATRIX)) {
      matrix[action] = authority;
    }
    return res.status(200).json({
      authorityClasses: {
        AUTONOMOUS: AUTHORITY_AUTONOMOUS,
        OWNER_POLICY_CONTROLLED: AUTHORITY_OWNER_POLICY,
        PROHIBITED: AUTHORITY_PROHIBITED,
      },
      matrix,
      note: "Unknown actions are classified PROHIBITED (fail closed). Prohibited actions cannot be executed even with an owner approval.",
    });
  });

  router.get("/overview", async (req, res) => {
    try {
      return res.status(200).json(await requireManager().overview());
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("HERMES_OVERVIEW_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.get("/decisions", async (req, res) => {
    try {
      const limitRaw = Number(req.query.limit);
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      if (category !== undefined && !HERMES_DECISION_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: "DECISION_CATEGORY_INVALID" });
      }
      const decisions = await requireManager().listDecisions({
        limit: Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIST_LIMIT) : 50,
        category,
      });
      return res.status(200).json({ count: decisions.length, decisions });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("HERMES_DECISIONS_LIST_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/decisions", requireCsrf, async (req, res) => {
    try {
      if (!hasOnlyFields(req.body, ["action", "directorId", "category", "reason", "payload", "credentialRequest", "ownerApproval"])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      const decision = await requireManager().decide(req.body);
      if (typeof recordAuditEvent === "function") {
        await recordAuditEvent(req.ownerId, "hermes_decision_recorded", {
          decisionNumber: decision.decisionNumber,
          action: decision.action,
          authority: decision.authority,
          outcome: decision.outcome,
          directorId: decision.directorId,
        });
      }
      return res.status(201).json(decision);
    } catch (err) {
      const code = err?.code ?? err?.message;
      if ([
        "DECISION_INPUT_REQUIRED",
        "PAYLOAD_TYPE_INVALID",
        "PAYLOAD_TOO_DEEP",
        "PAYLOAD_TOO_LARGE",
        "PAYLOAD_VALUE_TOO_LONG",
        "SECRET_VALUE_REJECTED",
        "SECRET_FIELD_REJECTED",
        "CREDENTIAL_REQUEST_INVALID",
        "DIRECTOR_ID_INVALID",
        "DECISION_CATEGORY_INVALID",
        "DECISION_REASON_REQUIRED",
        "HERMES_ACTION_REQUIRED",
      ].includes(code)) {
        return res.status(400).json({ error: code });
      }
      if (sendStorageError(res, err)) return;
      logRouterError("HERMES_DECISION_CREATE_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/decisions/:decisionNumber/complete", requireCsrf, async (req, res) => {
    try {
      if (!DECISION_NUMBER_PATTERN.test(req.params.decisionNumber)) {
        return res.status(400).json({ error: "DECISION_NUMBER_INVALID" });
      }
      if (!hasOnlyFields(req.body, ["succeeded", "evidenceReceiptId", "errorCode", "detail"])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      const decisionNumber = Number.parseInt(req.params.decisionNumber, 10);
      const decision = await requireManager().completeDecision(decisionNumber, {
        succeeded: req.body.succeeded,
        evidenceReceiptId: req.body.evidenceReceiptId,
        errorCode: req.body.errorCode,
        detail: req.body.detail,
        // Rule 1: completion is verified against the injected evidence
        // lookup (the real ledger, wired by server.js). The lookup exposes
        // only a found/verified boolean — never secret material, never
        // mutable history. Without an injected lookup, completion cannot
        // claim success: it fails closed below.
        fetchEvidence: fetchEvidence ?? (async () => ({ found: false })),
      });
      if (typeof recordAuditEvent === "function") {
        await recordAuditEvent(req.ownerId, "hermes_decision_completed", {
          decisionNumber: decision.decisionNumber,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
        });
      }
      return res.status(200).json(decision);
    } catch (err) {
      const code = err?.code ?? err?.message;
      if ([
        "DECISION_NUMBER_INVALID",
        "DECISION_RESULT_REQUIRED",
        "DECISION_NOT_FOUND",
        "DECISION_NOT_EXECUTING",
        "EVIDENCE_RECEIPT_REQUIRED",
        "EVIDENCE_LOOKUP_REQUIRED",
      ].includes(code)) {
        return res.status(400).json({ error: code });
      }
      if (sendStorageError(res, err)) return;
      logRouterError("HERMES_DECISION_COMPLETE_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/decisions/:decisionNumber/execute", requireCsrf, async (req, res) => {
    try {
      if (!DECISION_NUMBER_PATTERN.test(req.params.decisionNumber)) {
        return res.status(400).json({ error: "DECISION_NUMBER_INVALID" });
      }
      const bridge = createHermesJobBridge({
        production: typeof productionRepository === "function" ? productionRepository() : productionRepository,
        evidence: evidenceLedger,
      });
      const result = await bridge(manager, req.ownerId, Number.parseInt(req.params.decisionNumber, 10));
      if (typeof recordAuditEvent === "function" && result.status === "QUEUED") {
        await recordAuditEvent(req.ownerId, "hermes_decision_executed", {
          decisionNumber: result.decision.decisionNumber,
          releaseId: result.release.id,
          jobId: result.jobId,
        }).catch(() => {});
      }
      // HTTP mapping mirrors the honest outcome model: QUEUED → 201 (work
      // exists), REFUSED → 409 (terminal decision, nothing executed),
      // FAILED → 200 (the execution was recorded honestly; the response
      // body carries the FAILED decision record — not an HTTP-level error).
      if (result.status === "REFUSED") {
        return res.status(409).json({ error: result.errorCode, decision: result.decision });
      }
      return res.status(result.status === "QUEUED" ? 201 : 200).json(result);
    } catch (err) {
      const code = err?.code ?? err?.message;
      if (code === "DECISION_NOT_FOUND") {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      if (code === "DECISION_NUMBER_INVALID") {
        return res.status(400).json({ error: code });
      }
      if (sendStorageError(res, err)) return;
      if (code === "HERMES_BRIDGE_PRODUCTION_REPO_REQUIRED" || code === "HERMES_BRIDGE_EVIDENCE_REQUIRED") {
        return res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
      }
      logRouterError("HERMES_DECISION_EXECUTE_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  return router;
}
