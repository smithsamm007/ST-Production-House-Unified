/**
 * ST Production House — Director Workspace repository.
 *
 * Implements Master Blueprint sections 7–12 on top of sql/021:
 *   - ONE persistent owner<->director communication window per (owner, agent),
 *     lazily created, so Director #50 gets the same window as Director #01.
 *   - Append-only messages with explicit execution semantics:
 *     conversation | proposal | instruction | decision (section 10).
 *     Nothing here triggers production or publishing — conversation is not
 *     execution; decisions are recorded as evidence, not as actions.
 *   - Roadmap buckets now | next | future | ideas (section 11).
 *   - Isolated per-director memory entries, one per category (section 12).
 *
 * Security contract (AGENTS.md Rules 6, 15, 17):
 *   - Every query is parameterized and scoped by BOTH owner_id and agent_id:
 *     a cross-owner or cross-director read is indistinguishable from a
 *     missing row (generic 404 up the stack).
 *   - DTOs are explicit allowlists. Internal agent namespaces, secret-shaped
 *     fields and credential locators never serialize.
 *   - Portability: statements stay inside the SQL subset shared by the
 *     PostgreSQL adapter and the labeled demo adapter (single-table, no joins
 *     or scalar subqueries in SQL; multi-table assembly happens in JS).
 */

import { randomUUID } from "node:crypto";

export const MESSAGE_KINDS = Object.freeze(["conversation", "proposal", "instruction", "decision"]);
export const MESSAGE_SENDERS = Object.freeze(["owner", "director"]);
export const ROADMAP_BUCKETS = Object.freeze(["now", "next", "future", "ideas"]);
export const ROADMAP_ITEM_STATUSES = Object.freeze(["open", "accepted", "done", "dismissed"]);
export const MEMORY_CATEGORIES = Object.freeze([
  "universe_bible", "characters", "locations", "story_rules",
  "visual_identity", "voice_identity", "music_identity",
  "audience_insights", "owner_decisions", "production_history",
]);

const MAX_BODY_LENGTH = 8000;
const MAX_LIST_LIMIT = 200;

function boundedLimit(raw, fallback) {
  const n = Math.floor(Number(raw));
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIST_LIMIT);
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function conversationDto(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    createdAt: toIso(row.created_at),
  };
}

function messageDto(row) {
  return {
    id: String(row.id),
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    sender: row.sender,
    kind: row.kind,
    body: row.body,
    createdAt: toIso(row.created_at),
  };
}

function roadmapDto(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    bucket: row.bucket,
    title: row.title,
    detail: row.detail ?? null,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function memoryDto(row) {
  const content = typeof row.content === "string" ? safeParse(row.content) : row.content ?? {};
  return {
    id: row.id,
    agentId: row.agent_id,
    category: row.category,
    content,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 200) };
  }
}

export class DirectorWorkspaceRepository {
  constructor(dbAdapter) {
    if (!dbAdapter || typeof dbAdapter.query !== "function") {
      throw new Error("DIRECTOR_WORKSPACE_DB_ADAPTER_REQUIRED");
    }
    this.db = dbAdapter;
  }

  // ------------------------------------------------------------------
  // Communication window (sections 7–10)
  // ------------------------------------------------------------------

  /**
   * Returns the persistent conversation for (owner, agent), creating it on
   * first access. Two-step create tolerates the unique constraint racing
   * (unique owner/agent pair makes the window a true singleton).
   */
  async getOrCreateConversation(ownerId, agentId) {
    const existing = await this.db.query(
      "SELECT id, agent_id, created_at FROM director_conversations WHERE owner_id = $1 AND agent_id = $2;",
      [ownerId, agentId]
    );
    if (existing.rows[0]) return conversationDto(existing.rows[0]);

    await this.db.query(
      "INSERT INTO director_conversations (owner_id, agent_id) VALUES ($1, $2);",
      [ownerId, agentId]
    );
    const created = await this.db.query(
      "SELECT id, agent_id, created_at FROM director_conversations WHERE owner_id = $1 AND agent_id = $2;",
      [ownerId, agentId]
    );
    if (!created.rows[0]) throw new Error("CONVERSATION_CREATE_FAILED");
    return conversationDto(created.rows[0]);
  }

  /**
   * Appends one message to the conversation. The owner may send any kind;
   * director-sent rows are recorded verbatim (the runtime chat composer is a
   * future slice) and never auto-execute anything.
   */
  async appendMessage(ownerId, agentId, { sender, kind, body }) {
    if (!MESSAGE_SENDERS.includes(sender)) throw new Error("MESSAGE_VALIDATION_FAILED");
    if (!MESSAGE_KINDS.includes(kind)) throw new Error("MESSAGE_VALIDATION_FAILED");
    if (typeof body !== "string" || body.trim().length < 1 || body.length > MAX_BODY_LENGTH) {
      throw new Error("MESSAGE_VALIDATION_FAILED");
    }
    const conversation = await this.getOrCreateConversation(ownerId, agentId);
    await this.db.query(
      `INSERT INTO director_messages (conversation_id, owner_id, agent_id, sender, kind, body)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [conversation.id, ownerId, agentId, sender, kind, body.trim()]
    );
    const latest = await this.db.query(
      `SELECT id, conversation_id, agent_id, sender, kind, body, created_at
         FROM director_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1;`,
      [conversation.id]
    );
    return messageDto(latest.rows[0]);
  }

  async listMessages(ownerId, agentId, { limit = 100 } = {}) {
    const conversation = await this.getOrCreateConversation(ownerId, agentId);
    const bounded = boundedLimit(limit, 100);
    const result = await this.db.query(
      `SELECT id, conversation_id, agent_id, sender, kind, body, created_at
         FROM director_messages WHERE conversation_id = $1 ORDER BY id ASC LIMIT ${bounded};`,
      [conversation.id]
    );
    return result.rows.map(messageDto);
  }

  // ------------------------------------------------------------------
  // Roadmap (section 11)
  // ------------------------------------------------------------------

  async listRoadmap(ownerId, agentId, { bucket = null } = {}) {
    if (bucket !== null && !ROADMAP_BUCKETS.includes(bucket)) {
      throw new Error("ROADMAP_VALIDATION_FAILED");
    }
    const result = bucket === null
      ? await this.db.query(
          `SELECT id, agent_id, bucket, title, detail, status, created_at, updated_at
             FROM director_roadmap_items WHERE owner_id = $1 AND agent_id = $2
            ORDER BY created_at ASC;`,
          [ownerId, agentId]
        )
      : await this.db.query(
          `SELECT id, agent_id, bucket, title, detail, status, created_at, updated_at
             FROM director_roadmap_items WHERE owner_id = $1 AND agent_id = $2 AND bucket = $3
            ORDER BY created_at ASC;`,
          [ownerId, agentId, bucket]
        );
    return result.rows.map(roadmapDto);
  }

  async addRoadmapItem(ownerId, agentId, { bucket, title, detail = null }) {
    if (!ROADMAP_BUCKETS.includes(bucket)) throw new Error("ROADMAP_VALIDATION_FAILED");
    if (typeof title !== "string" || title.trim().length < 1 || title.length > 200) {
      throw new Error("ROADMAP_VALIDATION_FAILED");
    }
    if (detail !== null && (typeof detail !== "string" || detail.length > 2000)) {
      throw new Error("ROADMAP_VALIDATION_FAILED");
    }
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO director_roadmap_items (id, owner_id, agent_id, bucket, title, detail)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [id, ownerId, agentId, bucket, title.trim(), detail]
    );
    const created = await this.db.query(
      `SELECT id, agent_id, bucket, title, detail, status, created_at, updated_at
         FROM director_roadmap_items WHERE id = $1 AND owner_id = $2;`,
      [id, ownerId]
    );
    if (!created.rows[0]) throw new Error("ROADMAP_CREATE_FAILED");
    return roadmapDto(created.rows[0]);
  }

  /** Roadmap buckets move through open → accepted → done | dismissed. */
  async updateRoadmapItemStatus(ownerId, itemId, status) {
    if (!ROADMAP_ITEM_STATUSES.includes(status)) throw new Error("ROADMAP_VALIDATION_FAILED");
    const result = await this.db.query(
      "UPDATE director_roadmap_items SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2;",
      [itemId, ownerId, status]
    );
    if (!result.rowCount) return null;
    const updated = await this.db.query(
      `SELECT id, agent_id, bucket, title, detail, status, created_at, updated_at
         FROM director_roadmap_items WHERE id = $1 AND owner_id = $2;`,
      [itemId, ownerId]
    );
    return updated.rows[0] ? roadmapDto(updated.rows[0]) : null;
  }

  // ------------------------------------------------------------------
  // Memory (section 12)
  // ------------------------------------------------------------------

  async listMemory(ownerId, agentId) {
    const result = await this.db.query(
      `SELECT id, agent_id, category, content, created_at, updated_at
         FROM director_memory_entries WHERE owner_id = $1 AND agent_id = $2 ORDER BY category ASC;`,
      [ownerId, agentId]
    );
    return result.rows.map(memoryDto);
  }

  /**
   * Upserts one memory category (the unique (owner, agent, category) index
   * makes the entry a singleton per category).
   */
  async saveMemory(ownerId, agentId, { category, content }) {
    if (!MEMORY_CATEGORIES.includes(category)) throw new Error("MEMORY_VALIDATION_FAILED");
    if (content === null || typeof content !== "object" || Array.isArray(content)) {
      throw new Error("MEMORY_VALIDATION_FAILED");
    }
    const existing = await this.db.query(
      "SELECT id FROM director_memory_entries WHERE owner_id = $1 AND agent_id = $2 AND category = $3;",
      [ownerId, agentId, category]
    );
    if (existing.rows[0]) {
      await this.db.query(
        `UPDATE director_memory_entries SET content = $4, updated_at = now()
          WHERE owner_id = $1 AND agent_id = $2 AND category = $3;`,
        [ownerId, agentId, category, JSON.stringify(content)]
      );
    } else {
      await this.db.query(
        `INSERT INTO director_memory_entries (owner_id, agent_id, category, content)
         VALUES ($1, $2, $3, $4);`,
        [ownerId, agentId, category, JSON.stringify(content)]
      );
    }
    const saved = await this.db.query(
      `SELECT id, agent_id, category, content, created_at, updated_at
         FROM director_memory_entries WHERE owner_id = $1 AND agent_id = $2 AND category = $3;`,
      [ownerId, agentId, category]
    );
    if (!saved.rows[0]) throw new Error("MEMORY_SAVE_FAILED");
    return memoryDto(saved.rows[0]);
  }
}

export default DirectorWorkspaceRepository;
