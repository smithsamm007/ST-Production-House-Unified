/**
 * Express router for Director Communication (Owner -> Director AI responses).
 *
 * Mounted at /api/director-comm behind the existing Owner session middleware,
 * the existing CSRF middleware (mutative requests only) and a dedicated rate
 * limiter. Every request is Owner-scoped and Director-scoped; the router never
 * trusts a Director id, a charter or a channel name from the client without
 * resolving the Director server-side.
 *
 * Failure contract:
 *   400 DIRECTOR_ID_INVALID / REQUEST_VALIDATION_FAILED / MESSAGE_KIND_INVALID
 *   404 DIRECTOR_NOT_FOUND               (unknown or unauthorized Director)
 *   413 MESSAGE_TOO_LONG                 (size limit)
 *   422 MESSAGE_EMPTY
 *   429 TOO_MANY_REQUESTS_TRY_AGAIN_LATER (limiter, when mounted)
 *   502/503/504 provider failure, classified, with outcome PROVIDER_UNAVAILABLE
 */
import express from "express";
import crypto from "node:crypto";
import {
  DirectorCommunicationService,
  DIRECTOR_OUTCOMES,
  MESSAGE_KINDS,
  VALID_AGENT_ID_RE,
  redactSecrets,
} from "./directorCommunicationService.js";

const ALLOWED_POST_FIELDS = Object.freeze(["body", "kind", "clientMessageId"]);

function correlationIdOf(req) {
  const supplied = req.headers["x-correlation-id"];
  if (typeof supplied === "string" && /^[A-Za-z0-9_:.-]{8,80}$/.test(supplied)) {
    return supplied;
  }
  return `corr-${crypto.randomUUID()}`;
}

function hasOnlyFields(payload, allowed) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return Object.keys(payload).every((key) => allowed.includes(key));
}

function statusForOutcome(result) {
  if (result.outcome === DIRECTOR_OUTCOMES.ROUTING_FAILED) {
    return result.errorCode === "DIRECTOR_NOT_FOUND" ? 404 : 400;
  }
  if (result.outcome === DIRECTOR_OUTCOMES.TASK_REJECTED_WITH_REASON) {
    if (result.errorCode === "MESSAGE_TOO_LONG") return 413;
    if (result.errorCode === "MESSAGE_EMPTY") return 422;
    return 400;
  }
  if (result.outcome === DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE) {
    return Number.isInteger(result.httpStatus) ? result.httpStatus : 503;
  }
  return 200;
}

export function createDirectorCommunicationRouter(options = {}) {
  if (typeof options.resolveDirector !== "function") {
    // Fail closed by construction: without a server-side Director resolver an
    // arbitrary agentId would route to a conversation that does not exist.
    throw new Error("DIRECTOR_RESOLVER_REQUIRED");
  }

  const router = express.Router();
  const resolveDirector = options.resolveDirector;
  const loadDirectorContext =
    typeof options.loadDirectorContext === "function" ? options.loadDirectorContext : null;
  const csrf = typeof options.csrf === "function" ? options.csrf : null;
  const service =
    options.service ??
    new DirectorCommunicationService({ knownDirectors: options.knownDirectors });

  router.use((req, res, next) => {
    if (!req.ownerId && !req.owner?.id) {
      // The router is always mounted behind authenticateOwner; if that wiring is
      // ever lost, refuse instead of serving an unscoped conversation.
      return res.status(401).json({ error: "SESSION_TOKEN_REQUIRED" });
    }
    const correlationId = correlationIdOf(req);
    req.correlationId = correlationId;
    res.setHeader("X-Correlation-Id", correlationId);
    next();
  });

  async function authorizeDirector(req, res) {
    const agentId = String(req.params.agentId ?? "");
    if (!VALID_AGENT_ID_RE.test(agentId)) {
      res.status(400).json({ error: "DIRECTOR_ID_INVALID" });
      return null;
    }
    const director = await resolveDirector(agentId);
    if (!director) {
      // Unknown and unauthorized are deliberately indistinguishable.
      res.status(404).json({ error: "DIRECTOR_NOT_FOUND" });
      return null;
    }
    return director;
  }

  router.get("/:agentId/messages", async (req, res) => {
    try {
      const director = await authorizeDirector(req, res);
      if (!director) return;
      const messages = await service.getConversation(req.params.agentId, {
        ownerId: req.ownerId,
      });
      res.json({
        agentId: req.params.agentId,
        messages,
        correlationId: req.correlationId,
      });
    } catch (err) {
      req.log?.error?.({ code: "DIRECTOR_COMM_READ_FAILED", message: err?.message });
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  const postHandlers = [];
  if (csrf) postHandlers.push(csrf);
  postHandlers.push(async (req, res) => {
    try {
      if (!hasOnlyFields(req.body ?? {}, ALLOWED_POST_FIELDS)) {
        // charter/channelName are server-side context: accepting them from a
        // client would let a caller rewrite the Director's system instruction.
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      const director = await authorizeDirector(req, res);
      if (!director) return;

      const { body, kind = "conversation", clientMessageId = null } = req.body ?? {};
      if (!MESSAGE_KINDS.includes(kind)) {
        return res.status(400).json({ error: "MESSAGE_KIND_INVALID" });
      }
      if (typeof body !== "string") {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      if (clientMessageId !== null && typeof clientMessageId !== "string") {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }

      let directorContext = { channelName: null, charter: null };
      if (loadDirectorContext) {
        try {
          directorContext = (await loadDirectorContext(req.ownerId, req.params.agentId)) ?? directorContext;
        } catch (err) {
          req.log?.warn?.({ code: "DIRECTOR_CONTEXT_UNAVAILABLE", message: err?.message });
        }
      }

      const result = await service.handleOwnerMessage({
        agentId: req.params.agentId,
        ownerId: req.ownerId,
        body,
        kind,
        clientMessageId,
        correlationId: req.correlationId,
        channelName: directorContext.channelName ?? null,
        charter: directorContext.charter ?? null,
      });

      const httpStatus = statusForOutcome(result);
      if (typeof options.onOutcome === "function") {
        try {
          options.onOutcome({
            ownerId: req.ownerId,
            agentId: req.params.agentId,
            outcome: result.outcome,
            errorCode: result.errorCode ?? null,
            correlationId: req.correlationId,
            model: result.directorResponse?.model ?? null,
            latencyMs: result.directorResponse?.latencyMs ?? null,
            deduplicated: Boolean(result.deduplicated),
          });
        } catch {
          // Observability must never change the response.
        }
      }
      const payload = { ...result, correlationId: req.correlationId };
      if (payload.error) payload.error = redactSecrets(payload.error);
      res.status(httpStatus).json(payload);
    } catch (err) {
      req.log?.error?.({ code: "DIRECTOR_COMM_WRITE_FAILED", message: err?.message });
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/:agentId/messages", ...postHandlers);

  return router;
}
