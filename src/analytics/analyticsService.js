import { createHash, randomUUID } from "node:crypto";

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
  #records = new Map();
  #evidenceLedger;

  constructor({ evidenceLedger = null } = {}) {
    this.#evidenceLedger = evidenceLedger;
  }

  ingestAnalytics({
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
      collectedAt
    });

    this.#records.set(recordId, record);

    if (this.#evidenceLedger) {
      this.#evidenceLedger.append({
        subjectId: platformPostId,
        kind: "analytics_ingestion",
        classification: "genuine_external_analytics",
        payload: {
          recordId,
          ownerId,
          platformPostId,
          platform: record.platform,
          views: sanitizedMetrics.views,
          collectedAt
        }
      });
    }

    return record;
  }

  getRecord(recordId) {
    return this.#records.get(recordId) ?? null;
  }

  listByPost(platformPostId) {
    const results = [];
    for (const record of this.#records.values()) {
      if (record.platformPostId === platformPostId) {
        results.push(record);
      }
    }
    return results;
  }

  listByOwner(ownerId) {
    const results = [];
    for (const record of this.#records.values()) {
      if (record.ownerId === ownerId) {
        results.push(record);
      }
    }
    return results;
  }
}
