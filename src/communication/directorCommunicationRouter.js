/**
 * Express router for Director Communication (Owner -> Director AI responses).
 * Mounted at /api/director-comm
 */
import express from "express";
import path from "node:path";
import {
  DirectorCommunicationService,
  FileConversationStore,
  DIRECTOR_OUTCOMES,
} from "./directorCommunicationService.js";

export function createDirectorCommunicationRouter(options = {}) {
  const router = express.Router();
  const storagePath =
    options.storagePath ??
    path.join(process.cwd(), ".stph-data", "director-conversations.json");
  const service =
    options.service ??
    new DirectorCommunicationService({
      store: new FileConversationStore(storagePath),
    });

  router.get("/:agentId/messages", async (req, res) => {
    try {
      const messages = await service.getConversation(req.params.agentId);
      res.json({ agentId: req.params.agentId, messages });
    } catch (err) {
      res.status(500).json({
        outcome: DIRECTOR_OUTCOMES.ROUTING_FAILED,
        error: err?.message || "Failed to load conversation history.",
      });
    }
  });

  router.post("/:agentId/messages", async (req, res) => {
    try {
      const { body, kind, clientMessageId, channelName, charter } =
        req.body ?? {};
      const result = await service.handleOwnerMessage({
        agentId: req.params.agentId,
        body,
        kind,
        clientMessageId,
        channelName,
        charter,
      });
      const httpStatus =
        result.outcome === DIRECTOR_OUTCOMES.ROUTING_FAILED
          ? 400
          : result.outcome === DIRECTOR_OUTCOMES.TASK_REJECTED_WITH_REASON
          ? 422
          : result.outcome === DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE
          ? 503
          : 200;
      res.status(httpStatus).json(result);
    } catch (err) {
      res.status(500).json({
        outcome: DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE,
        error: err?.message || "Unexpected communication error.",
      });
    }
  });

  return router;
}
