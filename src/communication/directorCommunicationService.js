/**
 * ST Production House — Director Communication Service (Server-Side)
 *
 * Implements reliable Owner -> Director communication backed by Google AI Studio /
 * Gemini (@google/genai, model: gemini-4-hydrogen) with:
 *   - Strict per-Director conversation isolation (no cross-Director leakage)
 *   - Explicit outcome classification (never silently discards Owner messages)
 *   - Distinct system delivery acknowledgment vs. AI-generated Director response
 *   - Idempotent clientMessageId deduplication (no duplicate replies on retry/timeout)
 *   - Honest provider error/quota handling (never fabricates an AI reply on failure)
 *   - Optional durable JSON file persistence across application restarts
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

export const VALID_AGENT_ID_RE = /^[A-Za-z0-9_-]{2,40}$/;

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
 * Default server-side Google AI Studio / Gemini provider using @google/genai.
 */
export function createGeminiDirectorProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = options.model ?? "gemini-4-hydrogen";

  return {
    name: "google-ai-studio-gemini",
    model,
    async generateReply({ systemInstruction, history, message }) {
      if (!apiKey) {
        const err = new Error(
          "GEMINI_API_KEY is not configured on the server. Check Settings > Secrets."
        );
        err.code = "API_KEY_MISSING";
        err.status = 503;
        throw err;
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      const contents = [
        ...history.map((m) => ({
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
        },
      });

      const text = (response.text ?? "").trim();
      if (!text) {
        const err = new Error("Gemini returned an empty response body.");
        err.code = "EMPTY_PROVIDER_RESPONSE";
        err.status = 502;
        throw err;
      }

      return { text, model };
    },
  };
}

/**
 * Durable JSON-file conversation store (survives application restart).
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
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

export class DirectorCommunicationService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.provider] - Gemini provider adapter
   * @param {Object} [options.store] - Optional FileConversationStore for restart durability
   * @param {number} [options.timeoutMs=20000] - Provider timeout in ms
   * @param {Set<string>|string[]} [options.knownDirectors] - Optional allowlist of Director IDs
   */
  constructor(options = {}) {
    this.provider = options.provider ?? createGeminiDirectorProvider();
    this.store = options.store ?? null;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.knownDirectors = options.knownDirectors
      ? new Set(options.knownDirectors)
      : null;
    this.conversations = new Map();
    this.processedClientIds = new Map(); // clientMessageId -> result
    this.inFlightClientIds = new Map(); // clientMessageId -> Promise
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
    if (!this.store) return;
    const obj = {};
    for (const [agentId, list] of this.conversations.entries()) {
      obj[agentId] = list;
    }
    await this.store.saveAll({ conversations: obj });
  }

  async getConversation(agentId) {
    await this._ensureLoaded();
    if (!agentId || !VALID_AGENT_ID_RE.test(agentId)) return [];
    return [...(this.conversations.get(agentId) ?? [])];
  }

  async handleOwnerMessage({
    agentId,
    body,
    kind = "conversation",
    clientMessageId = null,
    channelName = null,
    charter = null,
  }) {
    await this._ensureLoaded();

    const trimmed = typeof body === "string" ? body.trim() : "";
    if (!agentId || !VALID_AGENT_ID_RE.test(agentId)) {
      return {
        outcome: DIRECTOR_OUTCOMES.ROUTING_FAILED,
        error: "Invalid or missing Director agentId.",
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    if (this.knownDirectors && !this.knownDirectors.has(agentId)) {
      return {
        outcome: DIRECTOR_OUTCOMES.ROUTING_FAILED,
        error: `Unknown Director "${agentId}". Message could not be routed.`,
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    if (!trimmed) {
      return {
        outcome: DIRECTOR_OUTCOMES.TASK_REJECTED_WITH_REASON,
        error: "Message body cannot be empty.",
        ownerMessage: null,
        deliveryAck: null,
        directorResponse: null,
      };
    }

    const dedupeKey = clientMessageId ? `${agentId}:${clientMessageId}` : null;
    if (dedupeKey && this.processedClientIds.has(dedupeKey)) {
      return {
        ...this.processedClientIds.get(dedupeKey),
        deduplicated: true,
      };
    }
    if (dedupeKey && this.inFlightClientIds.has(dedupeKey)) {
      const existing = await this.inFlightClientIds.get(dedupeKey);
      return { ...existing, deduplicated: true };
    }

    const runPromise = this._executeOwnerMessage({
      agentId,
      trimmed,
      kind,
      clientMessageId: clientMessageId || crypto.randomUUID(),
      channelName,
      charter,
    });

    if (dedupeKey) {
      this.inFlightClientIds.set(dedupeKey, runPromise);
    }

    try {
      const result = await runPromise;
      if (dedupeKey) {
        this.processedClientIds.set(dedupeKey, result);
      }
      return result;
    } finally {
      if (dedupeKey) {
        this.inFlightClientIds.delete(dedupeKey);
      }
    }
  }

  async _executeOwnerMessage({
    agentId,
    trimmed,
    kind,
    clientMessageId,
    channelName,
    charter,
  }) {
    const now = new Date().toISOString();
    const history = this.conversations.get(agentId) ?? [];
    // Only pass actual conversational turns (owner + director_ai) to Gemini
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
      body: `[System Delivery Ack] Message received and routed to Director ${agentId}. Awaiting AI Director response.`,
      timestamp: now,
    };

    const updatedHistory = [...history, ownerMessage];
    this.conversations.set(agentId, updatedHistory);
    await this._persist();

    const systemInstruction = buildDirectorSystemInstruction({
      agentId,
      channelName,
      charter,
    });

    let timedOut = false;
    let timer = null;
    try {
      const providerPromise = this.provider.generateReply({
        agentId,
        systemInstruction,
        history: modelHistory,
        message: trimmed,
      });

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const err = new Error(
            `Director ${agentId} AI provider timed out after ${this.timeoutMs}ms.`
          );
          err.code = "PROVIDER_TIMEOUT";
          err.status = 504;
          reject(err);
        }, this.timeoutMs);
      });

      const aiResult = await Promise.race([providerPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      // Guard: if a late promise ever resolved after timeout, do not append duplicate
      if (timedOut) {
        throw Object.assign(new Error("Late response ignored after timeout."), {
          code: "PROVIDER_TIMEOUT",
          status: 504,
        });
      }

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
        model: aiResult.model || this.provider.model || "gemini-4-hydrogen",
        clientMessageId,
        body: cleanText,
        timestamp: new Date().toISOString(),
      };

      const latest = this.conversations.get(agentId) ?? [];
      this.conversations.set(agentId, [...latest, directorResponse]);
      await this._persist();

      return {
        outcome,
        ownerMessage,
        deliveryAck,
        directorResponse,
        error: null,
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      const status = err?.status ?? err?.statusCode ?? 503;
      const isQuota =
        status === 429 ||
        /RESOURCE_EXHAUSTED|quota|rate limit/i.test(String(err?.message || ""));
      const errorDetail = isQuota
        ? `Gemini API quota exhausted (429 RESOURCE_EXHAUSTED). Your message was delivered to Director ${agentId}, but no AI response could be generated.`
        : `AI provider unavailable (${err?.code || status}): ${err?.message || "Unknown provider error"}. Your message was saved, and no AI response was fabricated.`;

      const systemErrorMessage = {
        id: `err-${crypto.randomUUID()}`,
        agentId,
        kind: "conversation",
        sender: "director",
        source: "system_error",
        outcome: DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE,
        clientMessageId,
        body: `[Provider Unavailable] ${errorDetail}`,
        timestamp: new Date().toISOString(),
      };

      const latest = this.conversations.get(agentId) ?? [];
      this.conversations.set(agentId, [...latest, systemErrorMessage]);
      await this._persist();

      return {
        outcome: DIRECTOR_OUTCOMES.PROVIDER_UNAVAILABLE,
        ownerMessage,
        deliveryAck,
        directorResponse: systemErrorMessage,
        error: errorDetail,
      };
    }
  }
}
