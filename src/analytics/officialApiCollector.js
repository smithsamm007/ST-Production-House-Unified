/**
 * ST Production House — OFFICIAL analytics collector contract (offline
 * portion, Module 26 / S-M39-01).
 *
 * The repository already ingests analytics through AnalyticsService
 * (Module 26, sql/027 `owner_analytics_records`). What was missing is the
 * GOVERNED translation layer between a REAL official platform API response
 * body and that ingestion record: this module defines strict per-platform
 * normalizers, validates the metrics fail closed, binds the response to the
 * expected post identity where the official shape carries one, and records
 * provenance (which official response shape was parsed and the official
 * documentation URL it came from).
 *
 * Honesty boundaries (AGENTS.md Rules 1–3, 17):
 *   - This is the OFFLINE contract only: it normalizes a response BODY the
 *     caller already obtained through an official authenticated API call.
 *     No networking here; live collection stays owner-gated (Issue #118,
 *     S-M26-LIVE).
 *   - A provider whose official analytics response shape has NOT been
 *     verified against official documentation is registered with
 *     `collector: null` and `unavailableReason` — it is never silently
 *     "supported" with an invented shape (the Bilibili precedent).
 *   - Metric values that are negative, non-integer, or unparsable fail
 *     closed; nothing is coerced into a fabricated number.
 *   - Where the official response carries the platform post id (YouTube
 *     `videos.list` items[].id), it MUST match the expected post — a body
 *     about another post can never be ingested for this one
 *     (RESPONSE_IDENTITY_MISMATCH).
 *
 * Official shapes normalized here (verified against official documentation):
 *   - YouTube Data API v3 `videos.list` `statistics` — string-encoded
 *     counters (viewCount/likeCount/commentCount); watch time and
 *     impressions are NOT part of this shape and are absent, never
 *     invented. Docs: https://developers.google.com/youtube/v3/docs/videos
 *   - Meta Graph API `/{id}/insights` — `{ data: [{ name, period,
 *     values: [{ value }, ...] }] }` (Page video and IG professional
 *     metric names mapped explicitly). Docs:
 *     https://developers.facebook.com/docs/instagram-platform/insights
 *     https://developers.facebook.com/docs/pages-api/insights
 */

import { createHash } from "node:crypto";

export const OFFICIAL_COLLECTOR_PARSE_ERROR = "OFFICIAL_COLLECTOR_PARSE_ERROR";
export const OFFICIAL_COLLECTOR_UNAVAILABLE = "OFFICIAL_COLLECTOR_UNAVAILABLE";
export const RESPONSE_IDENTITY_MISMATCH = "RESPONSE_IDENTITY_MISMATCH";

function collectorError(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** A digit-string or number becomes a non-negative integer; anything else fails closed. */
function nonNegativeInteger(value, metric) {
  if (value === undefined || value === null) return 0;
  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    parsed = Number(value);
  } else {
    throw collectorError(OFFICIAL_COLLECTOR_PARSE_ERROR, `${metric} is not a non-negative integer`);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw collectorError(OFFICIAL_COLLECTOR_PARSE_ERROR, `${metric} is not a non-negative integer`);
  }
  return parsed;
}

/**
 * The frozen collector registry, keyed by the SAME platform keys the
 * ingestion service allowlists. `normalize(body, context)` → metrics object
 * for AnalyticsService.ingestAnalytics.
 */
export const OFFICIAL_ANALYTICS_COLLECTORS = Object.freeze({
  youtube: Object.freeze({
    parser: "youtube_video_statistics",
    docUrl: "https://developers.google.com/youtube/v3/docs/videos",
    normalize(body, context) {
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw collectorError(OFFICIAL_COLLECTOR_PARSE_ERROR, "youtube body must be an object");
      }
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items || items.length !== 1 || body.items[0] === null || typeof body.items[0] !== "object") {
        throw collectorError(OFFICIAL_COLLECTOR_PARSE_ERROR, "youtube body must carry exactly one item");
      }
      const item = items[0];
      // Identity binding: the official response names the video it describes.
      if (typeof item.id !== "string" || item.id !== context.platformPostId) {
        throw collectorError(RESPONSE_IDENTITY_MISMATCH, "the response describes a different post");
      }
      const stats = item.statistics && typeof item.statistics === "object" ? item.statistics : {};
      // ONLY metrics this official shape carries. watchTimeSeconds,
      // impressions, and shares are NOT in videos.list statistics — they are
      // left absent (ingest defaults 0) and never invented here.
      return Object.freeze({
        views: nonNegativeInteger(stats.viewCount, "views"),
        likes: nonNegativeInteger(stats.likeCount, "likes"),
        commentsCount: nonNegativeInteger(stats.commentCount, "commentsCount"),
      });
    },
  }),

  facebook: Object.freeze({
    parser: "meta_graph_insights",
    docUrl: "https://developers.facebook.com/docs/pages-api/insights",
    normalize(body, context) {
      return normalizeMetaInsights(body, context, {
        "post_impressions": "impressions",
        "post_impressions_unique": "impressions",
        "post_video_views": "views",
        "post_reactions_like_total": "likes",
        "post_comments": "commentsCount",
      });
    },
  }),

  instagram: Object.freeze({
    parser: "meta_graph_insights",
    docUrl: "https://developers.facebook.com/docs/instagram-platform/insights",
    normalize(body, context) {
      return normalizeMetaInsights(body, context, {
        "views": "views",
        "reach": "impressions",
        "likes": "likes",
        "comments": "commentsCount",
      });
    },
  }),

  /**
   * Snap Spotlight insights: the official analytics response shape is not
   * verified in this repository's documentation set, so NO parser is
   * invented. Live snapchat collection stays unavailable until the official
   * shape is verified from Snap's documentation (honest-unavailable, the
   * Bilibili identity precedent).
   */
  snapchat: Object.freeze({
    parser: null,
    unavailableReason: "OFFICIAL_RESPONSE_SHAPE_UNVERIFIED",
    docUrl: "https://developers.snap.com/",
  }),
  /**
   * Bilibili: same honesty gate — platform analytics endpoints/shapes for
   * archive statistics are not verified here. Recorded as unavailable.
   */
  bilibili: Object.freeze({
    parser: null,
    unavailableReason: "OFFICIAL_RESPONSE_SHAPE_UNVERIFIED",
    docUrl: "https://member.bilibili.com/",
  }),
});

/** Meta `{data:[{name,period,values:[{value}]}]}` shape (Page + IG insights). */
function normalizeMetaInsights(body, context, metricNameMap) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw collectorError(OFFICIAL_COLLECTOR_PARSE_ERROR, "meta body must be an object");
  }
  const rows = Array.isArray(body.data) ? body.data : null;
  if (!rows) throw collectorError(OFFICIAL_COLLECTOR_PARSE_ERROR, "meta body must carry a data array");
  const metrics = {};
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw collectorError(OFFICIAL_COLLECTOR_PARSE_ERROR, "meta insight row must be an object");
    }
    const target = metricNameMap[row.name];
    if (!target) continue; // unknown official metric names are ignored, never coerced
    // Official values are ordered series; the LAST value is the most recent.
    const values = Array.isArray(row.values) ? row.values : null;
    if (!values || values.length === 0) continue;
    const latest = values[values.length - 1];
    const raw = latest && typeof latest === "object" ? latest.value : undefined;
    if (raw === undefined) continue;
    const normalized = nonNegativeInteger(raw, row.name);
    if (metrics[target] === undefined || normalized > metrics[target]) metrics[target] = normalized;
  }
  for (const target of new Set(Object.values(metricNameMap))) {
    if (metrics[target] !== undefined) continue;
    // Absent metrics stay ABSENT: ingestAnalytics defaults them to 0 and the
    // record's provenance records which official metrics were actually seen.
    metrics[target] = 0;
  }
  // Identity: insight rows do not carry the post id, so the caller-supplied
  // expected id is the binding (record-level, not response-level).
  if (!context.platformPostId || !(context.platformUrl ?? "").startsWith("https://")) {
    throw collectorError(OFFICIAL_COLLECTOR_PARSE_ERROR, "meta collection needs post identity from the ingestion context");
  }
  return Object.freeze(metrics);
}

/**
 * Collect metrics from ONE official API response body.
 *
 * Returns the EXACT argument object for AnalyticsService.ingestAnalytics
 * (owner scoping stays in the service), with provenance metadata:
 *   metadata.collector = parser name; metadata.collectorEnvelopeSha256 =
 *   SHA-256 of the raw response body (evidence of WHAT was parsed — the raw
 *   body is never persisted).
 *
 * Throws stable codes: OFFICIAL_COLLECTOR_UNAVAILABLE (unverified platform),
 * RESPONSE_IDENTITY_MISMATCH (wrong post), OFFICIAL_COLLECTOR_PARSE_ERROR
 * (malformed/metric-invalid body).
 */
export function collectOfficialAnalytics({
  platform,
  responseBody,
  ownerId,
  agentId,
  platformPostId,
  platformUrl,
} = {}) {
  const collector = OFFICIAL_ANALYTICS_COLLECTORS[typeof platform === "string" ? platform.toLowerCase() : ""];
  if (!collector) {
    throw collectorError(OFFICIAL_COLLECTOR_UNAVAILABLE, `no collector registered for ${platform}`);
  }
  if (collector.parser === null) {
    throw collectorError(OFFICIAL_COLLECTOR_UNAVAILABLE, collector.unavailableReason);
  }
  const metrics = collector.normalize(responseBody, { platformPostId, platformUrl });
  const envelopeSha256 = createHash("sha256")
    .update(JSON.stringify(responseBody ?? null))
    .digest("hex");
  return Object.freeze({
    ownerId,
    agentId: agentId ?? null,
    platformPostId,
    platformUrl,
    platform: platform.toLowerCase(),
    metrics,
    metadata: Object.freeze({
      collector: collector.parser,
      collectorEnvelopeSha256: envelopeSha256,
    }),
  });
}
