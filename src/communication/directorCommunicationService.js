/**
 * ST Production House — Director Communication Service (Server-Side)
 *
 * Implements reliable Owner -> Director communication backed by Google AI Studio /
 * Gemini (@google/genai, default model: gemini-4-hydrogen) with:
 *   - Strict per-Director, per-Owner conversation isolation
 *   - Explicit outcome classification (never silently discards Owner messages)
 *   - Distinct system delivery acknowledgment vs. AI-generated Director response
 *   - Idempotent clientMessageId deduplication (no duplicate replies on retry/timeout)
 *   - Honest provider error/quota handling (never fabricates an AI reply on failure)
 *   - Durable persistence through a repository (PostgreSQL) or, for explicit
 *     local/test use only, a JSON file store; a failed write throws instead of
 *     pretending persistence succeeded.
 *
 * The caller supplies `ownerId`; the router derives it from the authenticated
 * Owner session. `channelName` / `charter` are server-side context, never taken
 * from the request body.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";

export const DIRECTOR_OUTCOMES = Object.freeze({
  DIRECTOR_RESPONDED: "DIRECTOR_RESPONDED",
  DIRECTOR_NEEDS_CLARIFICATION: "DIRECTOR_NEEDS_CLARIFICATION",
  TASK_ACCEPTED: "TASK_ACCEPTED",
  TASK_REJECTED_WITH_REASON: "TASK_REJECTED_WITH_REASON",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  ROUTING_FAILED: "ROUTING_FAILED",
});

export const MESSAGE_KINDS = Object.freeze([
  "conversation",
  "proposal",
  "instruction",
  "decision",
]);

export const VALID_AGENT_ID_RE = /^[A-Za-z0-9_-]{2,40}$/;
export const VALID_CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9_:.-]{8,80}$/;

/** Owner messages and Director replies are bounded (prompt + storage cost). */
export const MAX_MESSAGE_LENGTH = 4000;

/** Only this many turns are sent back to the provider (cost/quota bound). */
export const MAX_PROVIDER_HISTORY = 40;

/** Tests and single-process callers that do not pass an Owner scope. */
export const DEFAULT_OWNER_SCOPE = "local-owner";

/** Model id is configuration, never a silent fallback to a different model. */
export const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-4-hydrogen";

/**
 * Builds the Director-scoped system instruction passed to Gemini.
 * Enforces:
 *   - Natural language, informal messages, typos, and Hinglish understanding
 *   - Affiliate advertising protocol (preserve exact URL, never invent product info,
 *     ask only for missing details, clear affiliate disclosure, Rule 7 approval gate)
 *   - Rule 15 (Director internal name stays private to Owner/HERMES console)
 */
export function buildDirectorSystemInstruction({ agentId, channelName, charter }) {
  const universeContext = charter
    ? [
        `Channel / Universe: ${channelName || agentId}`,
        charter.logline ? `Logline: ${charter.logline}` : null,
        charter.premise ? `Premise: ${charter.premise}` : null,
        charter.visualStyle ? `Visual Style: ${charter.visualStyle}` : null,
        charter.pacing ? `Pacing: ${charter.pacing}` : null,
        charter.targetAudience ? `Target Audience: ${charter.targetAudience}` : null,
        Array.isArray(charter.continuityRules) && charter.continuityRules.length
          ? `Continuity Rules: ${charter.continuityRules.join("; ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : `Channel / Universe: ${channelName || agentId}`;

  return [
    `You are Independent Director "${agentId}" inside ST Production House, communicating privately with the OWNER (and HERMES when escalated).`,
    universeContext,
    "",
    "OPERATING CONTRACT:",
    "1. Understand natural-language instructions, including informal messages, spelling mistakes, and Hinglish.",
    "2. Stay strictly within your own creative universe and conversation history. Never reference or leak other Directors' data.",
    "3. AFFILIATE & ADVERTISING REQUESTS:",
    "   - Identify the product, brand/platform (e.g., Amazon affiliate), and target episode.",
    "   - Ask ONLY for missing information (for example, if the affiliate URL or exact product title is missing, ask for it).",
    "   - Preserve any provided affiliate URL verbatim — never alter, shorten, or fabricate a URL.",
    "   - Never invent product features, claims, or pricing not supplied by the Owner.",
    "   - Propose how to integrate the advertisement naturally into the episode without disrupting the story.",
    "   - Always include a clear affiliate advertising disclosure in the proposed placement.",
    "   - Never publish or commit to an external placement without explicit Owner Rule 7 approval.",
    "4. Keep responses concise, helpful, and direct.",
    "5. Prefix your response with an explicit outcome tag on the first line in brackets ONLY if appropriate, or respond naturally. Valid outcomes: [DIRECTOR_RESPONDED], [DIRECTOR_NEEDS_CLARIFICATION], [TASK_ACCEPTED], [TASK_REJECTED_WITH_REASON].",
  ].join("\n");
}

/**
 * Classifies the model's response text into one of the valid Director outcomes.
 */
export function classifyDirectorOutcome(rawText) {
  const text = String(rawText || "").trim();
  const tagMatch = text.match(
    /^\[(DIRECTOR_RESPONDED|DIRECTOR_NEEDS_CLARIFICATION|TASK_ACCEPTED|TASK_REJECTED_WITH_REASON)\]\s*/
  );
  if (tagMatch) {
    return {
      outcome: tagMatch[1],
      cleanText: text.slice(tagMatch[0].length).trim(),
    };
  }
  const lower = text.toLowerCase();
  if (
    lower.includes("please share") ||
    lower.includes("could you confirm") ||
    lower.includes("could you share") ||
    lower.includes("missing") ||
    lower.includes("please provide") ||
    text.includes("?")
  ) {
    return {
      outcome: DIRECTOR_OUTCOMES.DIRECTOR_NEEDS_CLARIFICATION,
      cleanText: text,
    };
  }
  return {
    outcome: DIRECTOR_OUTCOMES.DIRECTOR_RESPONDED,
    cleanText: text,
  };
}

/**
 * Maps a provider failure onto a stable, Owner-visible classification.
 *
 * Provider failures are deliberately separate from routing/validation failures:
 * a routing failure means the message never reached a Director, while a provider
 * failure means it was delivered and stored but the model could not answer.
 */
export function classifyProviderFailure(err) {
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status ?? 0) || null;
  const code = String(err?.code || err?.name || "").trim() || null;
  const rawMessage = String(err?.message || "Unknown provider error");

  const isTimeout =
    code === "PROVIDER_TIMEOUT" ||
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT" ||
    /timed out|timeout/i.test(rawMessage);
  if (isTimeout) {
    return Object.freeze({
      kind: "timeout",
      code: "PROVIDER_TIMEOUT",
      httpStatus: 504,
      retryable: true,
      detail: "The AI provider timed out before answering. No AI response was fabricated.",
    });
  }

  if (code === "API_KEY_MISSING" || status === 401 || status === 403) {
    return Object.freeze({
      kind: "credentials",
      code: "PROVIDER_NOT_CONFIGURED",
      httpStatus: 503,
      retryable: false,
      detail:
        "The server has no usable Gemini credential (GEMINI_API_KEY). The message was stored; no AI response was generated.",
    });
  }

  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(rawMessage)) {
    return Object.freeze({
      kind: "quota",
      code: "PROVIDER_QUOTA_EXHAUSTED",
      httpStatus: 503,
      retryable: true,
      detail:
        "The Gemini API quota is exhausted (429 RESOURCE_EXHAUSTED). The message was delivered and stored; no AI response was generated.",
    });
  }

  if (code === "EMPTY_PROVIDER_RESPONSE") {
    return Object.freeze({
      kind: "provider",
      code: "EMPTY_PROVIDER_RESPONSE",
      httpStatus: 502,
      retryable: true,
      detail: "The AI provider returned an empty response. No AI response was fabricated.",
    });
  }

  return Object.freeze({
    kind: "provider",
    code: "PROVIDER_ERROR",
    httpStatus: 502,
    retryable: Boolean(status && status >= 500),
    detail: "The AI provider is unavailable. The message was stored; no AI response was fabricated.",
  });
}

/** Removes anything that looks like a credential from provider text. */
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[REDACTED_API_KEY]")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/g, "Bearer [REDACTED]");
}

/**
 * Default server-side Google AI Studio / Gemini provider using @google/genai.
 *
 * The API key is read only from the server environment (or an injected value);
 * it is never returned, logged or serialized.
 */
export function createGeminiDirectorProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const timeoutMs = options.timeoutMs ?? 20000;

  return {
    name: "google-ai-studio-gemini",
    model,
    configured: Boolean(apiKey),
    async generateReply({ systemInstruction, history, message, signal }) {
      if (!apiKey) {
        const err = new Error("GEMINI_API_KEY is not configured on the server.");
        err.code = "API_KEY_MISSING";
        err.status = 503;
        throw err;
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          timeout: timeoutMs,
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      const boundedHistory = (history ?? []).slice(-MAX_PROVIDER_HISTORY);
      const contents = [
        ...boundedHistory.map((m) => ({
          role: m.sender === "owner" ? "user" : "model",
          parts: [{ text: m.body }],
        })),
        {
          role: "user",
          parts: [{ text: message }],
        },
      ];

      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          abortSignal: signal,
        },
      });

      const text = (response.text ?? "").trim();
      if (!text) {
        const err = new Error("Gemini returned an empty response body.");
        err.code = "EMPTY_PROVIDER_RESPONSE";
        err.status = 502;
        throw err;
      }

      return {
        text,
        // The provider reports the model that actually answered; fall back to
        // the configured id, never to a different model.
        model: response.modelVersion || model,
        responseId: response.responseId || null,
        usage: response.usageMetadata ?? null,
      };
    },
  };
}

/**
 * Durable JSON-file conversation store (explicit local/test use only).
 *
 * NOT suitable for the cloud: one file, whole-map read-modify-write, so two
 * instances overwrite each other. Production uses PostgresConversationRepository.
 */
export class FileConversationStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async loadAll() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if (err && err.code === "ENOENT") return {};
      throw err;
    }
  }

  async saveAll(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}

export class DirectorCommunicationService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.provider] - Gemini provider adapter
   * @param {Object} [options.repository] - Durable conversation repository (PostgreSQL)
   * @param {Object} [options.store] - Optional FileConversationStore (explicit local/test use)
   * @param {number} [options.timeoutMs=20000] - Provider timeout in ms
   * @param {number} [options.maxMessageLength=4000] - Owner message size limit
   * @param {Set<string>|string[]} [options.knownDirectors] - Optional allowlist of Director IDs
   */
  constructor(options = {}) {
    this.provider = options.provider ?? createGeminiDirectorProvider();
    this.repository = options.repository ?? null;
    this.store = options.store ?? null;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.maxMessageLength = options.maxMessageLength ?? MAX_MESSAGE_LENGTH;
    this.knownDirectors = options.knownDirectors
      ? new Set(options.knownDirectors)
      : null;
    this.conversations = new Map();
    this.processedClientIds = new Map(); // `${owner}:${agent}:${clientMessageId}` -> result
    this.inFlightClientIds = new Map(); // same key -> Promise
    this._loaded = false;
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.store) return;
    const saved = await this.store.loadAll();
    if (saved.conversations && typeof saved.conversations === "object") {
      for (const [agentId, list] of Object.entries(saved.conversations)) {
        if (Array.isArray(list)) {
          this.conversations.set(agentId, list);
        }
      }
    }
  }

  async _persist() {
    if (this.repository || !this.store) return;
    const obj = {};
    for (const [agentId, list] of this.conversations.entries()) {
      obj[agentId] = list;
    }
    await this.store.saveAll({ conversations: obj });
    // Confirm the bytes landed; a silent write failure must surface.
    const reloaded = await this.store.loadAll();
    if (!reloaded || typeof reloaded.conversations !== "object") {
      throw new Error("CONVERSATION_PERSIST_FAILED");
    }
  }

  async _history(ownerId, agentId) {
    if (this.repository) return this.repository.listMessages(ownerId, agentId);
    await this._ensureLoaded();
    return [...(this.conversations.get(agentId) ?? [])];
  }

  async _append(ownerId, agentId, message) {
    if (this.repository) return this.repository.appendMessage(ownerId, agentId, message);
    await this._ensureLoaded();
    const latest = this.conversations.get(agentId) ?? [];
    this.conversations.set(agentId, [...latest, message]);
    await this._persist();
    return { message, created: true };
  }

  _dedupeKey(ownerId, agentId, clientMessageId) {
    return `${ownerId}:${agentId}:${clientMessageId}`;
  }

  async getConversation(agentId, { ownerId = DEFAULT_OWNER_SCOPE } = {}) {
    if (!agentId || !VALID_AGENT_ID_RE.test(agentId)) return [];
    if (this.repository) return this.repository.listMessages(ownerId, agentId);
    await this._ensureLoaded();
    return [...(this.conversations.get(agentId) ?? [])];
  }

  async handleOwnerMessage({
    agentId,
    body,
    kind = "conversation",
    clientMessageId = null,
    channelName = null,
    charter = null,
    ownerId = DEFAULT_OWNER_SCOPE,
    correlationId = null,
  }) {
    await this._ensureLoaded();

    const trimmed = typeof body === "string" ? body.trim() : "";
    if (!agentId || !VALID_AGENT_ID_RE.test(agentId)) {
      return {
        outcome: DIRECTOR_OUTCOMES.ROUTING_FAILED,
        error: "Invalid or missing Director agentId.",
        errorCode: "DIRECTOR_ID_INVALID",
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    if (this.knownDirectors && !this.knownDirectors.has(agentId)) {
      return {
        outcome: DIRECTOR_OUTCOMES.ROUTING_FAILED,
        error: `Unknown Director "${agentId}". Message could not be routed.`,
        errorCode: "DIRECTOR_NOT_FOUND",
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    if (!MESSAGE_KINDS.includes(kind)) {
      return {
        outcome: DIRECTOR_OUTCOMES.TASK_REJECTED_WITH_REASON,
        error: `Unsupported message kind "${kind}".`,
        errorCode: "MESSAGE_KIND_INVALID",
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    if (!trimmed) {
      return {
        outcome: DIRECTOR_OUTCOMES.TASK_REJECTED_WITH_REASON,
        error: "Message body cannot be empty.",
        errorCode: "MESSAGE_EMPTY",
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    if (trimmed.length > this.maxMessageLength) {
      return {
        outcome: DIRECTOR_OUTCOMES.TASK_REJECTED_WITH_REASON,
        error: `Message body exceeds the ${this.maxMessageLength} character limit.`,
        errorCode: "MESSAGE_TOO_LONG",
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    const resolvedClientMessageId =
      typeof clientMessageId === "string" && clientMessageId.trim()
        ? clientMessageId.trim()
        : `cmid-${crypto.randomUUID()}`;
    if (!VALID_CLIENT_MESSAGE_ID_RE.test(resolvedClientMessageId)) {
      return {
        outcome: DIRECTOR_OUTCOMES.TASK_REJECTED_WITH_REASON,
        error: "clientMessageId must be 8-80 characters of [A-Za-z0-9_:.-].",
        errorCode: "CLIENT_MESSAGE_ID_INVALID",
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    const resolvedCorrelationId =
      typeof correlationId === "string" && correlationId.trim()
        ? correlationId.trim().slice(0, 80)
        : `corr-${crypto.randomUUID()}`;

    const dedupeKey = this._dedupeKey(ownerId, agentId, resolvedClientMessageId);
    if (this.processedClientIds.has(dedupeKey)) {
      return {
        ...this.processedClientIds.get(dedupeKey),
        deduplicated: true,
      };
    }
    if (this.inFlightClientIds.has(dedupeKey)) {
      const existing = await this.inFlightClientIds.get(dedupeKey);
      return { ...existing, deduplicated: true };
    }

    const runPromise = this._executeOwnerMessage({
      agentId,
      ownerId,
      trimmed,
      kind,
      clientMessageId: resolvedClientMessageId,
      correlationId: resolvedCorrelationId,
      channelName,
      charter,
    });

    this.inFlightClientIds.set(dedupeKey, runPromise);
    try {
      const result = await runPromise;
      this.processedClientIds.set(dedupeKey, result);
      return result;
    } finally {
      this.inFlightClientIds.delete(dedupeKey);
    }
  }

  async _executeOwnerMessage({
    agentId,
    ownerId,
    trimmed,
    kind,
    clientMessageId,
    correlationId,
    channelName,
    charter,
  }) {
    // A retry after a restart or on another instance replays the durable result
    // instead of generating a second reply.
    if (this.repository) {
      const existing = await this.repository.findDelivery(ownerId, agentId, clientMessageId);
      if (existing?.directorResponse) {
        return {
          outcome: existing.directorResponse.outcome ?? DIRECTOR_OUTCOMES.DIRECTOR_RESPONDED,
          ownerMessage: existing.ownerMessage,
          deliveryAck: null,
          directorResponse: existing.directorResponse,
          error: null,
          correlationId,
          deduplicated: true,
        };
      }
    }

    const now = new Date().toISOString();
    const history = await this._history(ownerId, agentId);
    const modelHistory = history.filter(
      (m) => m.source === "owner" || m.source === "director_ai"
    );

    const ownerMessage = {
      id: `msg-${crypto.randomUUID()}`,
      agentId,
      kind,
      sender: "owner",
      source: "owner",
      clientMessageId,
      correlationId,
      body: trimmed,
      timestamp: now,
    };

    const deliveryAck = {
      id: `ack-${crypto.randomUUID()}`,
      agentId,
      kind: "conversation",
      sender: "director",
      source: "system_delivery_ack",
      clientMessageId,
      correlationId,
      body: `[System Delivery Ack] Message received and routed to Director ${agentId}. Awaiting AI Director response.`,
      timestamp: now,
    };

    const storedOwner = await this._append(ownerId, agentId, ownerMessage);
    const durableOwner = storedOwner?.message ?? ownerMessage;
    if (storedOwner && storedOwner.created === false && this.repository) {
      const raced = await this.repository.findDelivery(ownerId, agentId, clientMessageId);
      if (raced?.directorResponse) {
        return {
          outcome: raced.directorResponse.outcome ?? DIRECTOR_OUTCOMES.DIRECTOR_RESPONDED,
          ownerMessage: raced.ownerMessage,
          deliveryAck: null,
          directorResponse: raced.directorResponse,
          error: null,
          correlationId,
          deduplicated: true,
        };
      }
    }

    const systemInstruction = buildDirectorSystemInstruction({
      agentId,
      channelName,
      charter,
    });

    const startedAt = Date.now();
    const controller = new AbortController();
    let timer = null;
    try {
      const providerPromise = this.provider.generateReply({
        agentId,
        systemInstruction,
        history: modelHistory,
        message: trimmed,
        signal: controller.signal,
      });

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(
            `Director ${agentId} AI provider timed out after ${this.timeoutMs}ms.`
          );
          err.code = "PROVIDER_TIMEOUT";
          err.status = 504;
          controller.abort();
          reject(err);
        }, this.timeoutMs);
      });

      const aiResult = await Promise.race([providerPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      const latencyMs = Date.now() - startedAt;
      const { outcome, cleanText } = classifyDirectorOutcome(aiResult.text);
      const directorResponse = {
        id: `dir-${crypto.randomUUID()}`,
        agentId,
        kind:
          outcome === DIRECTOR_OUTCOMES.TASK_ACCEPTED
            ? "decision"
            : outcome === DIRECTOR_OUTCOMES.DIRECTOR_NEEDS_CLARIFICATION
            ? "proposal"
            : "conversation",
        sender: "director",
        source: "director_ai",
        outcome,
        model: aiResult.model || this.provider.model || null,
        providerResponseId: aiResult.responseId ?? null,
        usage: aiResult.usage ?? null,
        clientMessageId,
        correlationId,
        latencyMs,
        body: cleanText,
        timestamp: new Date().toISOString(),
      };

      const storedReply = await this._append(ownerId, agentId, directorResponse);
      const durableReply = storedReply?.message ?? directorResponse;
      if (storedReply && storedReply.created === false && this.repository) {
        // Another instance persisted the reply first: return that one, never a
        // duplicate or an overwrite.
        const raced = await this.repository.findDelivery(ownerId, agentId, clientMessageId);
        if (raced?.directorResponse) {
          return {
            outcome: raced.directorResponse.outcome ?? outcome,
            ownerMessage: raced.ownerMessage,
            deliveryAck,
            directorResponse: raced.directorResponse,
            error: null,
            correlationId,
            deduplicated: true,
          };
        }
      }

      return {
        outcome,
        ownerMessage: durableOwner,
        deliveryAck,
        directorResponse: durableReply,
        error: null,
        correlationId,
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      const latencyMs = Date.now() - startedAt;
      const failure = classifyProviderFailure(err);

      const systemErrorMessage = {
        id: `err-${crypto.randomUUID()}`,
        agentId,
        kind: "conversation",
        sender: "director",
        source: "system_error",
        outcome: DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE,
        errorCode: failure.code,
        clientMessageId,
        correlationId,
        latencyMs,
        body: `[Provider Unavailable] ${failure.detail}`,
        timestamp: new Date().toISOString(),
      };

      const storedError = await this._append(ownerId, agentId, systemErrorMessage);
      const durableError = storedError?.message ?? systemErrorMessage;

      return {
        outcome: DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE,
        ownerMessage: durableOwner,
        deliveryAck,
        directorResponse: durableError,
        error: failure.detail,
        errorCode: failure.code,
        retryable: failure.retryable,
        httpStatus: failure.httpStatus,
        correlationId,
      };
    }
  }
}
