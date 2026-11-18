/**
 * ST Production House — PostgreSQL conversation repository for the Director
 * Communication Engine (sql/041_director_comm_messages).
 *
 * Contract:
 *   - One row per message (never a whole-conversation blob), so two server
 *     instances append instead of overwriting each other's history.
 *   - `seq bigserial` is the total order for every instance.
 *   - UNIQUE (owner_id, agent_id, client_message_id, role) is the idempotency
 *     contract; insert conflicts are resolved by reading the winning row.
 *   - Every query is scoped by BOTH owner_id and agent_id, so another Owner or
 *     another Director reads nothing (an empty list, not a 403 oracle).
 *   - A failed write throws: persistence is never implied.
 */

import { randomUUID } from "node:crypto";

export const COMM_ROLES = Object.freeze(["owner", "director"]);
export const COMM_SOURCES = Object.freeze(["owner", "director_ai", "system_error"]);

const MAX_LIST_LIMIT = 500;

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function messageDto(row) {
  return {
    id: String(row.id),
    agentId: row.agent_id,
    kind: row.kind,
    sender: row.role === "owner" ? "owner" : "director",
    source: row.source,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.model ? { model: row.model } : {}),
    clientMessageId: row.client_message_id,
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.latency_ms === null || row.latency_ms === undefined
      ? {}
      : { latencyMs: Number(row.latency_ms) }),
    body: row.body,
    timestamp: toIso(row.created_at),
  };
}

export class PostgresConversationRepository {
  constructor(dbAdapter) {
    if (!dbAdapter || typeof dbAdapter.query !== "function") {
      throw new Error("DIRECTOR_COMM_DB_ADAPTER_REQUIRED");
    }
    this.db = dbAdapter;
  }

  async listMessages(ownerId, agentId, { limit = MAX_LIST_LIMIT } = {}) {
    const bounded = Math.min(
      Math.max(Number.isSafeInteger(Number(limit)) ? Number(limit) : MAX_LIST_LIMIT, 1),
      MAX_LIST_LIMIT
    );
    const result = await this.db.query(
      `SELECT seq, id, agent_id, client_message_id, role, kind, source, outcome, model,
              correlation_id, latency_ms, body, created_at
         FROM director_comm_messages
        WHERE owner_id = $1 AND agent_id = $2
        ORDER BY seq ASC
        LIMIT ${bounded};`,
      [ownerId, agentId]
    );
    return result.rows.map(messageDto);
  }

  /**
   * Appends one message. Returns `{ message, created }`; `created === false`
   * means another instance already persisted this exact
   * (owner, agent, clientMessageId, role) row — the stored row is returned so
   * callers never overwrite or duplicate it.
   */
  async appendMessage(ownerId, agentId, message) {
    if (!message || typeof message !== "object") {
      throw new Error("DIRECTOR_COMM_MESSAGE_INVALID");
    }
    const role = message.sender === "owner" ? "owner" : "director";
    if (!COMM_ROLES.includes(role)) throw new Error("DIRECTOR_COMM_MESSAGE_INVALID");
    if (!COMM_SOURCES.includes(message.source)) {
      throw new Error("DIRECTOR_COMM_MESSAGE_INVALID");
    }
    if (typeof message.body !== "string" || message.body.trim().length === 0) {
      throw new Error("DIRECTOR_COMM_MESSAGE_INVALID");
    }

    const id = message.id || `msg-${randomUUID()}`;
    const inserted = await this.db.query(
      `INSERT INTO director_comm_messages
         (id, owner_id, agent_id, client_message_id, role, kind, source, outcome, model,
          correlation_id, latency_ms, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (owner_id, agent_id, client_message_id, role) DO NOTHING;`,
      [
        id,
        ownerId,
        agentId,
        message.clientMessageId,
        role,
        message.kind,
        message.source,
        message.outcome ?? null,
        message.model ?? null,
        message.correlationId ?? null,
        Number.isFinite(message.latencyMs) ? Math.max(0, Math.round(message.latencyMs)) : null,
        message.body.trim(),
      ]
    );

    const created = inserted.rowCount === 0 ? false : true;
    const stored = await this.db.query(
      `SELECT seq, id, agent_id, client_message_id, role, kind, source, outcome, model,
              correlation_id, latency_ms, body, created_at
         FROM director_comm_messages
        WHERE owner_id = $1 AND agent_id = $2 AND client_message_id = $3 AND role = $4
        ORDER BY seq ASC
        LIMIT 1;`,
      [ownerId, agentId, message.clientMessageId, role]
    );
    if (!stored.rows[0]) throw new Error("DIRECTOR_COMM_PERSIST_FAILED");
    return { message: messageDto(stored.rows[0]), created };
  }

  /**
   * Returns the durable pair for one client message id, or null when nothing
   * has been stored yet. `directorResponse` is null while the reply is still
   * pending (e.g. the process died after storing the Owner message).
   */
  async findDelivery(ownerId, agentId, clientMessageId) {
    if (!clientMessageId) return null;
    const result = await this.db.query(
      `SELECT seq, id, agent_id, client_message_id, role, kind, source, outcome, model,
              correlation_id, latency_ms, body, created_at
         FROM director_comm_messages
        WHERE owner_id = $1 AND agent_id = $2 AND client_message_id = $3
        ORDER BY seq ASC;`,
      [ownerId, agentId, clientMessageId]
    );
    if (!result.rows.length) return null;
    const ownerRow = result.rows.find((row) => row.role === "owner");
    const directorRow = result.rows.find((row) => row.role === "director");
    if (!ownerRow) return null;
    return {
      ownerMessage: messageDto(ownerRow),
      directorResponse: directorRow ? messageDto(directorRow) : null,
    };
  }
}
