/**
 * ST Production House — PostgreSQL-backed analytics record store (Issue #194).
 *
 * Durable implementation of the analytics storage contract over sql/027
 * `owner_analytics_records`:
 *
 *   append(record)                -> stored record (immutable row)
 *   getByRecordId(ownerId, id)    -> record | null (owner-scoped)
 *   listByOwner(ownerId, {limit}) -> records, newest first
 *   listByPost(platformPostId, {limit}) -> records, newest first
 *
 * Contract rules (AGENTS.md):
 *   - Append-only (Rule 1): the table's trigger rejects UPDATE/DELETE
 *     (APPEND_ONLY_VIOLATION). A later collection for the same post is a
 *     NEW row — analytics history is never rewritten.
 *   - Parameterized SQL only; single-table statements inside the SQL subset
 *     shared by the PostgreSQL adapter and the labeled demo adapter (which
 *     the offline tests use): no joins, no subqueries, inlined VALIDATED
 *     integer LIMITs.
 *   - Rule 17: the store persists only what the service emits (the service
 *     gate already rejected secret-shaped material and internal agent names
 *     upstream); it never reads env vars or credential material. The
 *     serialized record shape matches the service's frozen record exactly:
 *     recordId/ownerId/agentId/platformPostId/platformUrl/platform/metrics/
 *     metadata/collectedAt — no locator, no secret, no internal name.
 *   - Lazy adapter resolution (adapter OR () => adapter) so the API can
 *     mount at module load; without storage everything fails closed with
 *     ANALYTICS_STORAGE_NOT_CONFIGURED (honest 503 up the stack — Rules 1–3).
 */

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

const METRIC_FIELDS = Object.freeze([
  "views",
  "watchTimeSeconds",
  "likes",
  "shares",
  "commentsCount",
  "impressions",
]);

function storeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeParseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) || Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function boundedLimit(limit) {
  const value = limit === undefined || limit === null ? DEFAULT_LIST_LIMIT : Number(limit);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw storeError("ANALYTICS_LIMIT_INVALID");
  }
  return value;
}

/** DB row -> the service's frozen record shape (camelCase allowlist). */
function rowToRecord(row) {
  if (!row) return null;
  const metrics = {};
  for (const field of METRIC_FIELDS) {
    metrics[field] = Number(row[field === "commentsCount" ? "comments_count" : field] ?? 0);
  }
  return Object.freeze({
    recordId: row.record_id,
    ownerId: row.owner_id,
    agentId: row.agent_id ?? null,
    platformPostId: row.platform_post_id,
    platformUrl: row.platform_url,
    platform: row.platform,
    metrics: Object.freeze(metrics),
    metadata: Object.freeze(safeParseJson(row.metadata, {})),
    collectedAt: toIso(row.collected_at),
  });
}

export class PostgresAnalyticsRepository {
  // lazily resolved adapter (adapter or () => adapter)
  #dbRef;

  constructor(db) {
    this.#dbRef = db;
  }

  #requireDb() {
    const db = typeof this.#dbRef === "function" ? this.#dbRef() : this.#dbRef;
    if (!db || typeof db.query !== "function") {
      throw storeError("ANALYTICS_STORAGE_NOT_CONFIGURED");
    }
    return db;
  }

  /**
   * Persist one validated analytics record. The service has already
   * enforced every validation gate (owner, URL, platform, non-negative
   * integer metrics, Rule 15/17 leakage); this layer trusts but re-binds
   * the exact persisted shape.
   */
  async append(record) {
    const db = this.#requireDb();
    if (!record || typeof record !== "object") {
      throw storeError("ANALYTICS_RECORD_INVALID");
    }
    if (typeof record.recordId !== "string" || record.recordId.length === 0) {
      throw storeError("ANALYTICS_RECORD_INVALID");
    }
    if (typeof record.ownerId !== "string" || record.ownerId.length === 0) {
      throw storeError("ANALYTICS_RECORD_INVALID");
    }
    if (typeof record.platformPostId !== "string" || record.platformPostId.length === 0) {
      throw storeError("ANALYTICS_RECORD_INVALID");
    }

    const metrics = isPlainObject(record.metrics) ? record.metrics : {};
    const metadata = isPlainObject(record.metadata) ? record.metadata : {};

    const res = await db.query(
      `INSERT INTO owner_analytics_records
         (record_id, owner_id, agent_id, platform_post_id, platform_url,
          platform, views, watch_time_seconds, likes, shares, comments_count,
          impressions, metadata, collected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
       RETURNING *`,
      [
        record.recordId,
        record.ownerId,
        record.agentId ?? null,
        record.platformPostId,
        record.platformUrl,
        record.platform,
        Number(metrics.views ?? 0),
        Number(metrics.watchTimeSeconds ?? 0),
        Number(metrics.likes ?? 0),
        Number(metrics.shares ?? 0),
        Number(metrics.commentsCount ?? 0),
        Number(metrics.impressions ?? 0),
        JSON.stringify(metadata),
        record.collectedAt ?? new Date().toISOString(),
      ],
    );
    return rowToRecord(res.rows[0]);
  }

  /** One record by its UUID, scoped to the requesting owner. */
  async getByRecordId(ownerId, recordId) {
    const db = this.#requireDb();
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      throw storeError("ANALYTICS_OWNER_INVALID");
    }
    if (typeof recordId !== "string" || recordId.length === 0) {
      throw storeError("ANALYTICS_RECORD_ID_INVALID");
    }
    const res = await db.query(
      "SELECT * FROM owner_analytics_records WHERE record_id = $1 AND owner_id = $2 LIMIT 1",
      [recordId, ownerId],
    );
    return rowToRecord(res.rows[0] ?? null);
  }

  /** Newest-first records for one owner (server-authoritative scope). */
  async listByOwner(ownerId, { limit } = {}) {
    const db = this.#requireDb();
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      throw storeError("ANALYTICS_OWNER_INVALID");
    }
    const safeLimit = boundedLimit(limit);
    const res = await db.query(
      `SELECT * FROM owner_analytics_records WHERE owner_id = $1 ORDER BY id DESC LIMIT ${safeLimit}`,
      [ownerId],
    );
    return res.rows.map(rowToRecord);
  }

  /** Newest-first records for one platform post (owner-scoped when given). */
  async listByPost(platformPostId, { ownerId, limit } = {}) {
    const db = this.#requireDb();
    if (typeof platformPostId !== "string" || platformPostId.length === 0) {
      throw storeError("ANALYTICS_POST_ID_INVALID");
    }
    const safeLimit = boundedLimit(limit);
    const params = [platformPostId];
    let where = "platform_post_id = $1";
    if (ownerId !== undefined) {
      if (typeof ownerId !== "string" || ownerId.length === 0) {
        throw storeError("ANALYTICS_OWNER_INVALID");
      }
      params.push(ownerId);
      where += ` AND owner_id = $${params.length}`;
    }
    const res = await db.query(
      `SELECT * FROM owner_analytics_records WHERE ${where} ORDER BY id DESC LIMIT ${safeLimit}`,
      params,
    );
    return res.rows.map(rowToRecord);
  }
}

export default PostgresAnalyticsRepository;
