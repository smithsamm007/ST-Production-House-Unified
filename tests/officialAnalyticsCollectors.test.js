/**
 * Official analytics collectors — offline tests (S-M39-01).
 *
 * Verifies the governed translation layer between a REAL official API
 * response body and AnalyticsService ingestion: strict shapes, identity
 * binding, fail-closed metrics, provenance metadata, and the honest
 * unavailable registration for providers whose official response shape is
 * not verified in this repository. Fully offline: no network call, no real
 * account, and the response bodies are fixed scripted fixtures.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_ANALYTICS_COLLECTORS,
  collectOfficialAnalytics,
  OFFICIAL_COLLECTOR_UNAVAILABLE,
  OFFICIAL_COLLECTOR_PARSE_ERROR,
  RESPONSE_IDENTITY_MISMATCH,
} from "../src/analytics/officialApiCollector.js";
import { AnalyticsService } from "../src/analytics/analyticsService.js";

const OWNER_ID = "owner-collect-e2e";

// ---------------------------------------------------------------------------
// Registry honesty
// ---------------------------------------------------------------------------

test("the collector registry is frozen and keyed by ingest-allowlisted platforms, keyed honestly", () => {
  assert.ok(Object.isFrozen(OFFICIAL_ANALYTICS_COLLECTORS));
  assert.deepEqual(
    Object.keys(OFFICIAL_ANALYTICS_COLLECTORS).sort(),
    ["bilibili", "facebook", "instagram", "snapchat", "youtube"],
  );
  // Snap/bilibili carry NO invented parser: null + stable reason + doc pointer.
  for (const key of ["snapchat", "bilibili"]) {
    const collector = OFFICIAL_ANALYTICS_COLLECTORS[key];
    assert.equal(collector.parser, null, `${key} has no invented response parser`);
    assert.equal(collector.unavailableReason, "OFFICIAL_RESPONSE_SHAPE_UNVERIFIED");
    assert.match(collector.docUrl, /^https:/);
  }
  for (const key of ["youtube", "instagram", "facebook"]) {
    assert.match(OFFICIAL_ANALYTICS_COLLECTORS[key].docUrl, /^https:/, `${key} cites its official docs`);
    assert.equal(typeof OFFICIAL_ANALYTICS_COLLECTORS[key].normalize, "function");
  }
});

// ---------------------------------------------------------------------------
// YouTube official shape (videos.list statistics)
// ---------------------------------------------------------------------------

test("youtube: string-encoded official statistics normalize with identity binding", () => {
  const body = {
    kind: "youtube#videoListResponse",
    items: [{ kind: "youtube#video", id: "yt_vid_1001", statistics: { viewCount: "1500", likeCount: "110", favoriteCount: "0", commentCount: "12" } }],
  };
  const collected = collectOfficialAnalytics({
    platform: "youtube",
    responseBody: body,
    ownerId: OWNER_ID,
    agentId: "agent-01",
    platformPostId: "yt_vid_1001",
    platformUrl: "https://www.youtube.com/watch?v=yt_vid_1001",
  });
  assert.equal(collected.metrics.views, 1500);
  assert.equal(collected.metrics.likes, 110);
  assert.equal(collected.metrics.commentsCount, 12);
  // Metrics the official shape does NOT carry are absent (ingest defaults 0),
  // never invented.
  assert.equal(collected.metrics.watchTimeSeconds, undefined);
  assert.equal(collected.metrics.impressions, undefined);
  assert.equal(collected.metrics.collector, undefined, "collector name lives in metadata, not metrics");
  assert.match(collected.metadata.collectorEnvelopeSha256, /^[a-f0-9]{64}$/);
  assert.match(collected.metadata.collector, /youtube_video_statistics/);
});

test("youtube: a body about ANOTHER post fails closed (RESPONSE_IDENTITY_MISMATCH)", async () => {
  const body = { items: [{ id: "yt_other_video", statistics: { viewCount: "999" } }] };
  assert.throws(
    () => collectOfficialAnalytics({
      platform: "youtube",
      responseBody: body,
      ownerId: OWNER_ID,
      platformPostId: "yt_vid_1001",
      platformUrl: "https://www.youtube.com/watch?v=yt_vid_1001",
    }),
    (error) => error.code === RESPONSE_IDENTITY_MISMATCH,
    "metrics for a different post can never be ingested for this one",
  );
});

test("youtube: malformed or metric-invalid bodies fail closed", () => {
  assert.throws(
    () => collectOfficialAnalytics({
      platform: "youtube", responseBody: { items: [] }, ownerId: OWNER_ID,
      platformPostId: "yt_vid_1001", platformUrl: "https://www.youtube.com/watch?v=yt_vid_1001",
    }),
    (error) => error.code === OFFICIAL_COLLECTOR_PARSE_ERROR,
  );
  const negative = { items: [{ id: "yt_vid_1001", statistics: { viewCount: "-5" } }] };
  assert.throws(
    () => collectOfficialAnalytics({
      platform: "youtube", responseBody: negative, ownerId: OWNER_ID,
      platformPostId: "yt_vid_1001", platformUrl: "https://www.youtube.com/watch?v=yt_vid_1001",
    }),
    (error) => error.code === OFFICIAL_COLLECTOR_PARSE_ERROR,
  );
  const fractional = { items: [{ id: "yt_vid_1001", statistics: { viewCount: "12.5" } }] };
  assert.throws(
    () => collectOfficialAnalytics({
      platform: "youtube", responseBody: fractional, ownerId: OWNER_ID,
      platformPostId: "yt_vid_1001", platformUrl: "https://www.youtube.com/watch?v=yt_vid_1001",
    }),
    (error) => error.code === OFFICIAL_COLLECTOR_PARSE_ERROR,
  );
});

// ---------------------------------------------------------------------------
// Meta official shape (/{id}/insights)
// ---------------------------------------------------------------------------

test("facebook: official insights series normalize through the explicit metric map", () => {
  const body = {
    data: [
      { name: "post_impressions", period: "lifetime", values: [{ value: 2400 }, { value: 2500 }] },
      { name: "post_video_views", period: "lifetime", values: [{ value: 1800 }] },
      { name: "post_reactions_like_total", period: "lifetime", values: [{ value: 140 }] },
      { name: "post_comments", period: "lifetime", values: [{ value: 21 }] },
      { name: "post_clicks", period: "lifetime", values: [{ value: 30 }] }, // not mapped → ignored, never coerced
    ],
  };
  const collected = collectOfficialAnalytics({
    platform: "facebook",
    responseBody: body,
    ownerId: OWNER_ID,
    platformPostId: "fb_video_1",
    platformUrl: "https://www.facebook.com/watch/?v=fb_video_1",
  });
  assert.equal(collected.metrics.views, 1800);
  assert.equal(collected.metrics.impressions, 2500, "the LAST series value is the most recent");
  assert.equal(collected.metrics.likes, 140);
  assert.equal(collected.metrics.commentsCount, 21);
  assert.equal(collected.metadata.collector, "meta_graph_insights");
});

test("instagram: professional-account metric names map explicitly; unmapped stay absent", () => {
  const body = {
    data: [
      { name: "views", period: "day", values: [{ value: 800 }] },
      { name: "reach", period: "day", values: [{ value: 350 }] },
      { name: "likes", period: "day", values: [{ value: 95 }] },
      { name: "comments", period: "day", values: [{ value: 8 }] },
      { name: "saves", period: "day", values: [{ value: 40 }] }, // official metric not in the ingestion set → ignored
    ],
  };
  const collected = collectOfficialAnalytics({
    platform: "instagram",
    responseBody: body,
    ownerId: OWNER_ID,
    platformPostId: "ig_media_1",
    platformUrl: "https://www.instagram.com/reel/ig_media_1/",
  });
  assert.equal(collected.metrics.views, 800);
  assert.equal(collected.metrics.impressions, 350, "reach maps to impressions honestly");
  assert.equal(collected.metrics.likes, 95);
  assert.equal(collected.metrics.commentsCount, 8);
});

test("meta insights: unbound post identity from the caller history fails closed; missing data array fails closed", () => {
  assert.throws(
    () => collectOfficialAnalytics({
      platform: "instagram", responseBody: { data: [{ name: "views", values: [{ value: 1 }] }] },
      ownerId: OWNER_ID, platformPostId: "", platformUrl: "https://www.instagram.com/reel/ig_media_1/",
    }),
    (error) => error.code === OFFICIAL_COLLECTOR_PARSE_ERROR,
  );
  assert.throws(
    () => collectOfficialAnalytics({
      platform: "facebook", responseBody: { items: [] }, ownerId: OWNER_ID,
      platformPostId: "fb_video_1", platformUrl: "https://www.facebook.com/watch/?v=fb_video_1",
    }),
    (error) => error.code === OFFICIAL_COLLECTOR_PARSE_ERROR,
  );
});

// ---------------------------------------------------------------------------
// Unverified providers + the real ingestion boundary
// ---------------------------------------------------------------------------

test("unverified providers report stable OFFICIAL_COLLECTOR_UNAVAILABLE, never a fabricated parse", () => {
  for (const platform of ["snapchat", "bilibili"]) {
    assert.throws(
      () => collectOfficialAnalytics({
        platform, responseBody: { whatever: true }, ownerId: OWNER_ID,
        platformPostId: "pid", platformUrl: "https://www.snapchat.com/spotlight/pid",
      }),
      (error) => error.code === OFFICIAL_COLLECTOR_UNAVAILABLE,
    );
  }
  assert.throws(
    () => collectOfficialAnalytics({
      platform: "tiktok", responseBody: {}, ownerId: OWNER_ID,
      platformPostId: "pid", platformUrl: "https://www.tiktok.com/x",
    }),
    (error) => error.code === OFFICIAL_COLLECTOR_UNAVAILABLE,
    "unregistered platforms are unavailable, never guessed",
  );
});

test("official collection drives the REAL ingestion path with provenance metadata", async () => {
  const service = new AnalyticsService();
  const collected = collectOfficialAnalytics({
    platform: "youtube",
    responseBody: { items: [{ id: "yt_vid_e2e", statistics: { viewCount: "320", likeCount: "30", commentCount: "4" } }] },
    ownerId: OWNER_ID,
    agentId: "agent-01",
    platformPostId: "yt_vid_e2e",
    platformUrl: "https://www.youtube.com/watch?v=yt_vid_e2e",
  });
  const record = await service.ingestAnalytics(collected);
  assert.equal(record.metrics.views, 320);
  assert.equal(record.metrics.likes, 30);
  assert.equal(record.metadata.collector, "youtube_video_statistics");
  assert.match(record.metadata.collectorEnvelopeSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () => service.ingestAnalytics({ ...collected, metrics: { ...collected.metrics, views: -1 } }),
    (error) => error.code === "INVALID_ANALYTICS_METRICS",
    "the service's own non-negative-integer gate stays intact",
  );
});
