/**
 * ST Production House — genuine external analytics ingestion service.
 *
 * Records REAL platform-collected metrics (Module 26): no locally invented
 * numbers, no fabricated engagement counts (Rules 1–2). The service layer
 * owns validation + integrity gates; persistence is delegated to an
 * injected storage repository.
 *
 * Storage (Issue #194):
 *   - `storage` injected at construction: the durable
 *     PostgresAnalyticsRepository (sql/027 owner_analytics_records) in
 *     production.
 *   - Without an injected repository the process-lifetime in-memory Map
 *     remains as the labeled DEMO transport (non-durable, never claimed
 *     as durable) so the complete product runs without a DB server.
 *   - All operations are async so the call shape is identical for the
 *     in-memory and PostgreSQL transports; the `/ops` routes already
 *     await every service call.
 *
 * Contract rules (AGENTS.md):
 *   - Honest evidence only: the service validates non-negative integer
 *     metrics (no invented or fractional numbers), HTTPS-only platform
 *     URLs, and the four allowlisted platforms.
 *   - Rule 15/17: internal agent names and secret-shaped material in the
 *     payload are rejected BEFORE any persistence (fail closed).
 *   - Owner scoping is caller-enforced server-side: every read below is
 *     scoped by the requesting owner through the storage layer.
 */

import { randomUUID } from "node:crypto";

const AGENT_NAME_PATTERN = /\b(?:JARVIS|SHERLOCK|LAKME|VEDA|PANCHI|NEWTON)\b/i;
const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization)/i;
const ALLOWED_PLATFORMS = new Set(["youtube", "instagram", "facebook", "snapchat"]);

export class AnalyticsServiceError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "AnalyticsServiceError";
    this.code = code;
    this.details = details;
  }
}

export class AnalyticsService {
  // Labeled demo transport: non-durable, process-lifetime only. Production
  // injects PostgresAnalyticsRepository as `storage` (Issue #194).
  #demoRecords = new Map();
  #storage;
  #evidenceLedger;

  constructor({ evidenceLedger = null, storage = null } = {}) {
    this.#evidenceLedger = evidenceLedger;
    this.#storage = storage;
  }

  async ingestAnalytics({
    ownerId,
    agentId,
    platformPostId,
    platformUrl,
    platform,
    metrics = {},
    metadata = {}
  }) {
    if (!ownerId || typeof ownerId !== "string" || ownerId.trim().length === 0) {
      throw new AnalyticsServiceError("Owner ID is required", "OWNER_ID_REQUIRED");
    }
    if (!platformPostId || typeof platformPostId !== "string" || platformPostId.trim().length === 0) {
      throw new AnalyticsServiceError("Platform post ID is required", "PLATFORM_POST_ID_REQUIRED");
    }
    if (!platformUrl || typeof platformUrl !== "string" || !/^https:\/\//i.test(platformUrl)) {
      throw new AnalyticsServiceError("Valid HTTPS platform URL is required", "INVALID_PLATFORM_URL");
    }
    if (!platform || !ALLOWED_PLATFORMS.has(platform.toLowerCase())) {
      throw new AnalyticsServiceError(`Unsupported platform: ${platform}`, "INVALID_PLATFORM");
    }

    // Rule 15 & Rule 17 checks on inputs/metadata
    const payloadSerialized = JSON.stringify({ ownerId, platformPostId, platformUrl, metadata });
    if (AGENT_NAME_PATTERN.test(payloadSerialized)) {
      throw new AnalyticsServiceError("Internal agent name leaked in analytics payload", "AGENT_NAME_LEAKAGE_DENIED");
    }
    if (SECRET_LIKE.test(payloadSerialized)) {
      throw new AnalyticsServiceError("Secret token or locator detected in analytics payload", "SECRET_LEAKAGE_DENIED");
    }

    // Validate metrics: non-negative integers only
    const metricFields = ["views", "watchTimeSeconds", "likes", "shares", "commentsCount", "impressions"];
    const sanitizedMetrics = {};

    for (const field of metricFields) {
      const val = metrics[field];
      if (val === undefined || val === null) {
        sanitizedMetrics[field] = 0;
      } else if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
        throw new AnalyticsServiceError(
          `Metric '${field}' must be a non-negative integer`,
          "INVALID_ANALYTICS_METRICS"
        );
      } else {
        sanitizedMetrics[field] = val;
      }
    }

    const recordId = randomUUID();
    const collectedAt = new Date().toISOString();

    const record = Object.freeze({
      recordId,
      ownerId,
      agentId: agentId ?? null,
      platformPostId,
      platformUrl,
      platform: platform.toLowerCase(),
      metrics: Object.freeze(sanitizedMetrics),
      metadata: Object.freeze({ ...(metadata ?? {}) }),
      collectedAt
    });

    // Durable path (Issue #194): delegate to the injected storage
    // repository. Failures surface truthfully (no in-memory fallback that
    // would pretend a lost write succeeded).
    if (this.#storage) {
      const stored = await this.#storage.append(record);
      this.#appendEvidence(stored);
      return stored;
    }

    this.#demoRecords.set(recordId, record);
    this.#appendEvidence(record);
    return record;
  }

  #appendEvidence(record) {
    if (this.#evidenceLedger) {
      this.#evidenceLedger.append({
        subjectId: record.platformPostId,
        kind: "analytics_ingestion",
        classification: "genuine_external_analytics",
        payload: {
          recordId: record.recordId,
          ownerId: record.ownerId,
          platformPostId: record.platformPostId,
          platform: record.platform,
          views: record.metrics.views,
          collectedAt: record.collectedAt
        }
      });
    }
  }

  async getRecord(ownerId, recordId) {
    if (this.#storage) {
      return this.#storage.getByRecordId(ownerId, recordId);
    }
    const record = this.#demoRecords.get(recordId) ?? null;
    return record && record.ownerId === ownerId ? record : null;
  }

  async listByPost(platformPostId, { ownerId, limit } = {}) {
    if (this.#storage) {
      return this.#storage.listByPost(platformPostId, { ownerId, limit });
    }
    const results = [];
    for (const record of this.#demoRecords.values()) {
      if (record.platformPostId === platformPostId && (ownerId === undefined || record.ownerId === ownerId)) {
        results.push(record);
      }
    }
    return results;
  }

  async listByOwner(ownerId, { limit } = {}) {
    if (this.#storage) {
      return this.#storage.listByOwner(ownerId, { limit });
    }
    const results = [];
    for (const record of this.#demoRecords.values()) {
      if (record.ownerId === ownerId) {
        results.push(record);
      }
    }
    return results;
  }
}
