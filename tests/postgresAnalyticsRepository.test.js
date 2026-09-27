/**
 * Durable analytics store tests (Issue #194).
 *
 * Offline scope: the repository is exercised against the labeled demo
 * adapter (same SQL subset as the PostgreSQL adapter), so the append/get/
 * list contract, owner scoping, and honest fail-closed behavior are proven
 * without a real database. The CI PostgreSQL Integration suite applies
 * sql/027 on real PostgreSQL separately (see
 * tests/analyticsPostgres.integration.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { PostgresAnalyticsRepository } from "../src/analytics/postgresAnalyticsRepository.js";
import { AnalyticsService } from "../src/analytics/analyticsService.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

async function buildRepo() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  return { db, repo: new PostgresAnalyticsRepository(db) };
}

function makeRecord(overrides = {}) {
  return {
    recordId: randomUUID(),
    ownerId: "11111111-1111-4111-8111-111111111111",
    agentId: null,
    platformPostId: "yt_post_durable_1",
    platformUrl: "https://youtube.com/watch?v=yt_post_durable_1",
    platform: "youtube",
    metrics: { views: 100, watchTimeSeconds: 500, likes: 10, shares: 2, commentsCount: 1, impressions: 200 },
    metadata: { source: "platform_api" },
    collectedAt: new Date("2026-09-27T12:00:00.000Z").toISOString(),
    ...overrides,
  };
}

test("migration 027 applies on the demo adapter and the table is queryable", async () => {
  const { repo } = await buildRepo();
  const stored = await repo.append(makeRecord());
  assert.ok(stored.recordId);
  assert.equal(stored.platform, "youtube");
});

test("durable store: append persists and getByRecordId reads back the exact record", async () => {
  const { repo } = await buildRepo();
  const record = makeRecord();
  const stored = await repo.append(record);

  assert.equal(stored.recordId, record.recordId);
  assert.equal(stored.ownerId, record.ownerId);
  assert.equal(stored.platformPostId, record.platformPostId);
  assert.equal(stored.platformUrl, record.platformUrl);
  assert.equal(stored.platform, "youtube");
  assert.equal(stored.metrics.views, 100);
  assert.equal(stored.metrics.commentsCount, 1);
  assert.deepEqual(stored.metadata, { source: "platform_api" });

  const readBack = await repo.getByRecordId(record.ownerId, record.recordId);
  assert.equal(readBack.recordId, record.recordId);
  assert.equal(readBack.metrics.views, 100);
  assert.equal(readBack.collectedAt, record.collectedAt);
});

test("durable store: missing metrics persist as honest zero defaults", async () => {
  const { repo } = await buildRepo();
  const record = makeRecord({
    metrics: { views: 42 },
  });
  const stored = await repo.append(record);
  const read = await repo.getByRecordId(record.ownerId, record.recordId);
  assert.equal(read.metrics.views, 42);
  assert.equal(read.metrics.likes, 0);
  assert.equal(read.metrics.impressions, 0);
  assert.equal(stored.metrics.shares, 0);
});

test("durable store: cross-owner reads are indistinguishable from not-found (isolation)", async () => {
  const { repo } = await buildRepo();
  const record = makeRecord();
  await repo.append(record);

  const foreignRead = await repo.getByRecordId("22222222-2222-4222-8222-222222222222", record.recordId);
  assert.equal(foreignRead, null);
});

test("durable store: listByOwner returns only the requesting owner's records, newest first", async () => {
  const { repo } = await buildRepo();
  const ownerA = "11111111-1111-4111-8111-111111111111";
  const ownerB = "22222222-2222-4222-8222-222222222222";
  const first = await repo.append(makeRecord({ ownerId: ownerA, platformPostId: "yt_a_1" }));
  await repo.append(makeRecord({ ownerId: ownerB, platformPostId: "yt_b_1" }));
  const last = await repo.append(makeRecord({ ownerId: ownerA, platformPostId: "yt_a_2" }));

  const rows = await repo.listByOwner(ownerA);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.platformPostId), ["yt_a_2", "yt_a_1"]);
  assert.ok(rows.every((r) => r.ownerId === ownerA));

  // limit is validated and inlined only after validation
  assert.equal((await repo.listByOwner(ownerA, { limit: 1 })).length, 1);
  await assert.rejects(() => repo.listByOwner(ownerA, { limit: 0 }), /ANALYTICS_LIMIT_INVALID/);
  await assert.rejects(() => repo.listByOwner(ownerA, { limit: 5000 }), /ANALYTICS_LIMIT_INVALID/);
  assert.equal(first.recordId && last.recordId, last.recordId); // keep references honest
});

test("durable store: listByPost scopes by owner when provided", async () => {
  const { repo } = await buildRepo();
  const ownerA = "11111111-1111-4111-8111-111111111111";
  const ownerB = "22222222-2222-4222-8222-222222222222";
  await repo.append(makeRecord({ ownerId: ownerA, platformPostId: "yt_shared" }));
  await repo.append(makeRecord({ ownerId: ownerB, platformPostId: "yt_shared" }));

  const allRows = await repo.listByPost("yt_shared");
  assert.equal(allRows.length, 2);
  const scoped = await repo.listByPost("yt_shared", { ownerId: ownerA });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].ownerId, ownerA);
});

test("durable store: records survive a repository restart (durability over the same adapter)", async () => {
  const { db } = await buildRepo();
  const before = new PostgresAnalyticsRepository(db);
  const record = makeRecord();
  await before.append(record);

  // A NEW repository instance over the SAME storage reads the row back.
  const after = new PostgresAnalyticsRepository(db);
  const read = await after.getByRecordId(record.ownerId, record.recordId);
  assert.equal(read.recordId, record.recordId);
  assert.equal(read.metrics.views, 100);
});

test("durable store: unconfigured storage fails closed with a stable code", async () => {
  const repo = new PostgresAnalyticsRepository(null);
  await assert.rejects(() => repo.append(makeRecord()), /ANALYTICS_STORAGE_NOT_CONFIGURED/);
  await assert.rejects(() => repo.listByOwner("owner-01"), /ANALYTICS_STORAGE_NOT_CONFIGURED/);

  // Lazy resolution: an adapter factory is invoked per call.
  let calls = 0;
  const lazy = new PostgresAnalyticsRepository(() => {
    calls += 1;
    return null;
  });
  await assert.rejects(() => lazy.listByOwner("owner-01"), /ANALYTICS_STORAGE_NOT_CONFIGURED/);
  assert.ok(calls >= 1);
});

test("durable store: malformed records are rejected before persistence", async () => {
  const { repo } = await buildRepo();
  await assert.rejects(() => repo.append(null), /ANALYTICS_RECORD_INVALID/);
  await assert.rejects(() => repo.append({ ownerId: "o", platformPostId: "p" }), /ANALYTICS_RECORD_INVALID/);
});

test("service with durable storage: ingested records land in PostgreSQL and read back owner-scoped", async () => {
  const { repo } = await buildRepo();
  const ledger = new EvidenceLedger();
  const service = new AnalyticsService({ evidenceLedger: ledger, storage: repo });

  const record = await service.ingestAnalytics({
    ownerId: "11111111-1111-4111-8111-111111111111",
    platformPostId: "yt_svc_1",
    platformUrl: "https://youtube.com/watch?v=yt_svc_1",
    platform: "youtube",
    metrics: { views: 7 },
  });

  // Persisted beyond the service instance (a fresh service over the same
  // repository reads it back — the in-memory Map is NOT the store).
  const freshService = new AnalyticsService({ storage: repo });
  const read = await freshService.getRecord(record.ownerId, record.recordId);
  assert.equal(read.recordId, record.recordId);
  assert.equal(read.metrics.views, 7);

  const listed = await freshService.listByOwner(record.ownerId);
  assert.equal(listed.length, 1);

  // Evidence ledger still records the ingestion event.
  const kinds = ledger.list().map((e) => e.kind);
  assert.ok(kinds.includes("analytics_ingestion"));
});

test("service with durable storage: validation gates run BEFORE persistence (nothing stored on rejection)", async () => {
  const { repo } = await buildRepo();
  const service = new AnalyticsService({ storage: repo });
  const ownerId = "11111111-1111-4111-8111-111111111111";

  await assert.rejects(
    () =>
      service.ingestAnalytics({
        ownerId,
        platformPostId: "yt_bad",
        platformUrl: "https://youtube.com/watch?v=yt_bad",
        platform: "youtube",
        metrics: { views: -3 },
      }),
    (err) => {
      assert.equal(err.code, "INVALID_ANALYTICS_METRICS");
      return true;
    },
  );

  const rows = await service.listByOwner(ownerId);
  assert.equal(rows.length, 0);
});
