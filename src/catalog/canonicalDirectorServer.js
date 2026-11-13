/**
 * ST Production House — Owner API: canonical Director registry lifecycle (Phase 2A).
 *
 * Mounted at /api/canonical-directors behind `authenticateOwner`:
 *
 *   GET  /                       -> every mapping (active first)
 *   GET  /active                 -> active mappings + the 50-active invariant
 *   GET  /:code                  -> one mapping by canonical Director code
 *   POST /:code/activate         -> activate (CSRF; cap-locked; owner role)
 *   POST /:code/retire           -> retire in place (CSRF; owner role)
 *   POST /:code/suspend          -> suspend (CSRF; owner role)
 *
 * Security contract (AGENTS.md Rules 1, 5, 6, 15, 17):
 *   - Owner identity is SERVER-authoritative (req.ownerId from the session).
 *   - Mutations require the per-session CSRF token and always write an audit event.
 *   - The canonical code space is closed; unknown codes are a generic 404.
 *   - Responses use the repository's explicit DTO allowlist (no raw rows).
 *   - Without configured storage the routes degrade honestly with 503.
 */

import { Router } from "express";
import { verifyCsrfToken, requireOwnerRole } from "./ownerAuthentication.js";
import {
  CanonicalDirectorRepository,
  ACTIVE_DIRECTOR_CAP,
  CANONICAL_DIRECTOR_CODES,
  PRESERVED_UNDERLYING_AGENT_IDS,
  NEW_UNDERLYING_AGENT_IDS,
} from "./canonicalDirectorRepository.js";

const CANONICAL_CODE_PATTERN = /^[A-Z][A-Z0-9_ -]{0,49}$/;

const ALLOWED_ERROR_CODES = new Set([
  "CANONICAL_DIRECTOR_CODE_INVALID",
  "CANONICAL_DIRECTOR_NOT_FOUND",
  "CANONICAL_DIRECTOR_NOT_ACTIVE",
  "ACTIVE_DIRECTOR_CAP_REACHED",
  "MAPPING_ALREADY_EXISTS",
  "STATUS_INVALID",
  "UNDERLYING_AGENT_INVALID",
  "INSUFFICIENT_PRIVILEGES",
]);

function hasOnlyFields(value, allowed) {
  if (value === undefined || value === null) return true;
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
  // Code only: messages can carry storage detail.
  console.error(JSON.stringify({ event, code: err?.code ?? "UNKNOWN" }));
}

function sendStorageError(res, err) {
  if (err?.code === "STORAGE_NOT_CONFIGURED") {
    return res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
  }
  return null;
}

function publicCode(err) {
  const code = typeof err?.code === "string" ? err.code : null;
  return code && ALLOWED_ERROR_CODES.has(code) ? code : null;
}

/** HTTP status per stable code. Unknown failures stay generic 500. */
function statusForCode(code) {
  switch (code) {
    case "CANONICAL_DIRECTOR_NOT_FOUND":
    case "CANONICAL_DIRECTOR_CODE_INVALID":
      return 404;
    case "CANONICAL_DIRECTOR_NOT_ACTIVE":
    case "ACTIVE_DIRECTOR_CAP_REACHED":
    case "MAPPING_ALREADY_EXISTS":
      return 409;
    case "INSUFFICIENT_PRIVILEGES":
      return 403;
    case "STATUS_INVALID":
    case "UNDERLYING_AGENT_INVALID":
      return 400;
    default:
      return 500;
  }
}

export function createCanonicalDirectorRouter({ db, recordAuditEvent } = {}) {
  // `db` may be an adapter or a lazy () => adapter: the server mounts routers at
  // module load, before configureRuntime() assigns the adapter.
  const resolveDb = typeof db === "function" ? db : () => db;

  function getRepo() {
    const adapter = resolveDb();
    if (!adapter || typeof adapter.query !== "function") {
      const error = new Error("STORAGE_NOT_CONFIGURED");
      error.code = "STORAGE_NOT_CONFIGURED";
      throw error;
    }
    return new CanonicalDirectorRepository(adapter);
  }

  async function audit(ownerId, action, detail) {
    if (typeof recordAuditEvent !== "function") return;
    try {
      await recordAuditEvent(ownerId, action, detail);
    } catch {
      // Auditing must never turn an honest lifecycle response into a 500.
    }
  }

  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const repo = getRepo();
      const mappings = await repo.listAll();
      const activeCount = mappings.filter((mapping) => mapping.status === "active").length;
      return res.status(200).json({
        count: mappings.length,
        activeCount,
        activeCap: ACTIVE_DIRECTOR_CAP,
        canonicalCodes: [...CANONICAL_DIRECTOR_CODES],
        preservedUnderlyingAgentIds: [...PRESERVED_UNDERLYING_AGENT_IDS],
        newUnderlyingAgentIds: [...NEW_UNDERLYING_AGENT_IDS],
        mappings,
      });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("CANONICAL_DIRECTORS_LIST_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.get("/active", async (req, res) => {
    try {
      const repo = getRepo();
      const active = await repo.listActive();
      return res.status(200).json({
        count: active.length,
        activeCap: ACTIVE_DIRECTOR_CAP,
        mappings: active,
      });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("CANONICAL_DIRECTORS_ACTIVE_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.get("/:code", async (req, res) => {
    try {
      if (!CANONICAL_CODE_PATTERN.test(req.params.code)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const mapping = await getRepo().findByCode(req.params.code);
      if (!mapping) return res.status(404).json({ error: "NOT_FOUND" });
      return res.status(200).json(mapping);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = publicCode(err);
      if (code === "CANONICAL_DIRECTOR_CODE_INVALID" || code === "CANONICAL_DIRECTOR_NOT_FOUND") {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      logRouterError("CANONICAL_DIRECTOR_GET_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/:code/activate", requireCsrf, async (req, res) => {
    try {
      if (!CANONICAL_CODE_PATTERN.test(req.params.code)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      if (!hasOnlyFields(req.body, ["underlyingAgentId"])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      await requireOwnerRole(req.ownerId, "owner");
      const mapping = await getRepo().activateMapping(req.params.code, {
        underlyingAgentId: req.body?.underlyingAgentId ?? null,
      });
      await audit(req.ownerId, "canonical_director_activated", {
        canonicalDirectorCode: mapping.canonicalDirectorCode,
        underlyingAgentId: mapping.underlyingAgentId,
      });
      return res.status(200).json(mapping);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = publicCode(err);
      if (code) return res.status(statusForCode(code)).json({ error: code });
      logRouterError("CANONICAL_DIRECTOR_ACTIVATE_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/:code/retire", requireCsrf, async (req, res) => {
    try {
      if (!CANONICAL_CODE_PATTERN.test(req.params.code)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      if (!hasOnlyFields(req.body, ["retiredReason"])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      await requireOwnerRole(req.ownerId, "owner");
      const mapping = await getRepo().retireMapping(req.params.code, {
        retiredReason: req.body?.retiredReason ?? null,
      });
      await audit(req.ownerId, "canonical_director_retired", {
        canonicalDirectorCode: mapping.canonicalDirectorCode,
        underlyingAgentId: mapping.underlyingAgentId,
        retiredReason: mapping.retiredReason,
      });
      return res.status(200).json(mapping);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = publicCode(err);
      if (code) return res.status(statusForCode(code)).json({ error: code });
      logRouterError("CANONICAL_DIRECTOR_RETIRE_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/:code/suspend", requireCsrf, async (req, res) => {
    try {
      if (!CANONICAL_CODE_PATTERN.test(req.params.code)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      if (!hasOnlyFields(req.body, ["suspendedNote"])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      await requireOwnerRole(req.ownerId, "owner");
      const mapping = await getRepo().suspendMapping(req.params.code, {
        suspendedNote: req.body?.suspendedNote ?? null,
      });
      await audit(req.ownerId, "canonical_director_suspended", {
        canonicalDirectorCode: mapping.canonicalDirectorCode,
        underlyingAgentId: mapping.underlyingAgentId,
      });
      return res.status(200).json(mapping);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = publicCode(err);
      if (code) return res.status(statusForCode(code)).json({ error: code });
      logRouterError("CANONICAL_DIRECTOR_SUSPEND_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  return router;
}
