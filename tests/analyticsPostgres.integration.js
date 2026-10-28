/**
 * Durable analytics store — real PostgreSQL integration (Issue #194).
 *
 * Acceptance on live PostgreSQL 15: sql/027 applies, ingested records are
 * durably persisted across service/repository restarts, append-only
 * enforcement blocks UPDATE/DELETE, and cross-owner isolation holds.
 * Skipped honestly (with a diagnostic) when PostgreSQL is not configured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { PostgresAnalyticsRepository } from "../src/analytics/postgresAnalyticsRepository.js";
import { AnalyticsService } from "../src/analytics/analyticsService.js";

test("PostgreSQL 15 durable analytics: restart durability, append-only, owner isolation", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL 15 URL is mandatory for analytics integration acceptance");
    t.diagnostic("PostgreSQL is not configured; live analytics integration is not run by the unit command");
    return;
  }

  const schema = `analytics_${process.pid}_${Date.now()}`;
  const connection = { connectionString: dbUrl, connectionTimeoutMillis: 5000 };
  const bootstrap = new pg.Pool(connection);
  let pool;
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
    const db = new PostgresAdapter({}, pool);
    await new MigrationRunner(db).runMigrations();

    const ownerA = crypto.randomUUID();
    const ownerB = crypto.randomUUID();
    await db.query(
      "INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x'),($3,$4,'x')",
      [ownerA, `${ownerA}@test.invalid`, ownerB, `${ownerB}@test.invalid`],
    );

    // Ingest through the SERVICE bound to the durable repository.
    const before = new AnalyticsService({ storage: new PostgresAnalyticsRepository(db) });
    const record = await before.ingestAnalytics({
      ownerId: ownerA,
      agentId: null,
      platformPostId: "yt_live_1",
      platformUrl: "https://youtube.com/watch?v=yt_live_1",
      platform: "youtube",
      metrics: { views: 1234, likes: 40, commentsCount: 3 },
      metadata: { source: "integration_test" },
    });

    // RESTART durability: a brand-new repository + service over the same
    // database reads the exact record back.
    const after = new AnalyticsService({ storage: new PostgresAnalyticsRepository(db) });
    const read = await after.getRecord(ownerA, record.recordId);
    assert.equal(read.recordId, record.recordId);
    assert.equal(read.platformPostId, "yt_live_1");
    assert.equal(read.metrics.views, 1234);
    assert.equal(read.metrics.likes, 40);
    assert.equal(read.metrics.commentsCount, 3);
    assert.equal(read.metrics.shares, 0);
    assert.deepEqual(read.metadata, { source: "integration_test" });

    // Owner isolation: a different owner cannot read or list the record.
    assert.equal(await after.getRecord(ownerB, record.recordId), null);
    assert.equal((await after.listByOwner(ownerB)).length, 0);
    assert.equal((await after.listByPost("yt_live_1", { ownerId: ownerB })).length, 0);
    assert.equal((await after.listByOwner(ownerA)).length, 1);

    // Append-only enforcement (Rule 1): UPDATE and DELETE are impossible.
    const physicalId = (
      await db.query("SELECT id FROM owner_analytics_records WHERE record_id = $1", [record.recordId])
    ).rows[0].id;
    await assert.rejects(
      () => db.query("UPDATE owner_analytics_records SET views = 0 WHERE id = $1", [physicalId]),
      /APPEND_ONLY_VIOLATION/,
    );
    await assert.rejects(
      () => db.query("DELETE FROM owner_analytics_records WHERE id = $1", [physicalId]),
      /APPEND_ONLY_VIOLATION/,
    );

    // DB-level metric bounds: a negative metric cannot exist even if a
    // future caller bypassed the service gate (defense in depth).
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO owner_analytics_records
             (record_id, owner_id, platform_post_id, platform_url, platform, views)
           VALUES ($1, $2, 'yt_bad', 'https://youtube.com/watch?v=yt_bad', 'youtube', -5)`,
          [crypto.randomUUID(), ownerA],
        ),
      /owner_analytics_records_views_check/,
    );

    // A second ingestion for the same post appends a NEW snapshot row —
    // history is never rewritten.
    await after.ingestAnalytics({
      ownerId: ownerA,
      platformPostId: "yt_live_1",
      platformUrl: "https://youtube.com/watch?v=yt_live_1",
      platform: "youtube",
      metrics: { views: 2000 },
    });
    assert.equal((await after.listByPost("yt_live_1", { ownerId: ownerA })).length, 2);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await bootstrap.end();
  }
});
