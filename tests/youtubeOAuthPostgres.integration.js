/**
 * YouTube OAuth lifecycle — PostgreSQL 15 integration tests (Issue #206).
 *
 * Runs the real migrations (including sql/028) against a live PostgreSQL 15+
 * instance and verifies what an in-memory adapter cannot prove: real CHECK
 * constraints, real UNIQUE constraints, real atomic conditional UPDATE
 * (single-use state), and real FK scoping.
 *
 * Honest skip policy (same as postgresIntegration.integration.js): when no
 * PostgreSQL is configured outside CI / npm run test:integration, the suite
 * reports a diagnostic skip instead of pretending to verify.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { runMigrations } from "../src/db/migrationRunner.js";
import {
  YouTubeOAuthRepository,
  OAUTH_PROVIDER_KEY,
} from "../src/catalog/youtubeOAuthRepository.js";

const REDIRECT_URI = "https://dashboard.stproduction.test/api/youtube/callback";

test("YouTube OAuth lifecycle on live PostgreSQL 15", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const isCI = !!process.env.CI;
  const isIntegrationCmd = process.env.npm_lifecycle_event === "test:integration";
  const expectPG = isCI || !!dbUrl || isIntegrationCmd;

  let testPool = null;
  let pgAvailable = false;
  let lastConnectError = null;

  if (dbUrl || process.env.PGHOST || isCI) {
    try {
      testPool = new pg.Pool({
        connectionString: dbUrl || "postgresql://st_app:st_test_password@localhost:5432/st_production_test",
        host: process.env.PGHOST,
        port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        connectionTimeoutMillis: 5000,
      });
      const client = await testPool.connect();
      await client.query("SELECT 1");
      client.release();
      pgAvailable = true;
    } catch (err) {
      lastConnectError = err;
      if (testPool) {
        await testPool.end().catch(() => {});
        testPool = null;
      }
    }
  }

  if (!pgAvailable) {
    if (expectPG) {
      assert.fail(
        `PostgreSQL 15 instance was expected in CI/integration test environment but could not be reached: ${lastConnectError ? lastConnectError.message : "Connection failed"}`,
      );
    } else {
      t.diagnostic(
        "[YOUTUBE_OAUTH_INTEGRATION] NOTICE: Live PostgreSQL 15+ instance is not configured locally. " +
        "Unit tests passed. Run with POSTGRES_TEST_URL=... to execute live integration tests.",
      );
      return;
    }
  }

  const adapter = new PostgresAdapter({}, testPool);
  await runMigrations(adapter);

  const ownerId = randomUUID();
  const repo = new YouTubeOAuthRepository(adapter);

  await adapter.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `oauth-pg-${ownerId.slice(0, 8)}@integration.test`, "x".repeat(64), "owner", "authenticated"],
  );

  t.after(async () => {
    // FK ON DELETE CASCADE removes both OAuth tables' rows for this owner.
    await adapter.query("DELETE FROM owners WHERE id = $1", [ownerId]).catch(() => {});
    await testPool.end().catch(() => {});
  });

  await t.test("migrations created the OAuth tables with their constraints", async () => {
    const tables = await adapter.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('youtube_oauth_states', 'youtube_director_accounts') ORDER BY table_name",
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      ["youtube_director_accounts", "youtube_oauth_states"],
    );
  });

  await t.test("state lifecycle: insert, atomic single-use claim, replay rejection, binding scoping", async () => {
    const stateHash = randomUUID().replaceAll("-", "").repeat(2).slice(0, 64); // 64 hex
    await repo.insertState({ stateHash, ownerId, agentId: "agent-01", redirectUri: REDIRECT_URI, expiresAt: new Date(Date.now() + 60_000) });

    const found = await repo.findStateByHash(stateHash);
    assert.equal(found.ownerId, ownerId);
    assert.equal(found.consumedAt, null);

    assert.equal(await repo.claimState({ stateHash, ownerId, agentId: "agent-01", providerKey: OAUTH_PROVIDER_KEY }), true);
    assert.equal(await repo.claimState({ stateHash, ownerId, agentId: "agent-01", providerKey: OAUTH_PROVIDER_KEY }), false, "replay loses on real PG");
    const consumed = await repo.findStateByHash(stateHash);
    assert.ok(consumed.consumedAt, "consumed_at set by the atomic UPDATE");

    const otherHash = randomUUID().replaceAll("-", "").repeat(2).slice(0, 64);
    await repo.insertState({ stateHash: otherHash, ownerId, agentId: "agent-01", redirectUri: REDIRECT_URI, expiresAt: new Date(Date.now() + 60_000) });
    assert.equal(await repo.claimState({ stateHash: otherHash, ownerId, agentId: "agent-02", providerKey: OAUTH_PROVIDER_KEY }), false, "wrong director cannot claim");
    assert.equal(await repo.claimState({ stateHash: otherHash, ownerId: randomUUID(), agentId: "agent-01", providerKey: OAUTH_PROVIDER_KEY }), false, "wrong owner cannot claim");
    assert.equal(await repo.claimState({ stateHash: otherHash, ownerId, agentId: "agent-01", providerKey: "instagram" }), false, "wrong provider cannot claim");
  });

  await t.test("database CHECK constraints reject malformed states (defense in depth)", async () => {
    await assert.rejects(
      () => adapter.query(
        "INSERT INTO youtube_oauth_states (state_hash, owner_id, agent_id, redirect_uri, expires_at) VALUES ($1, $2, 'agent-01', $3, now() + interval '1 minute')",
        ["not-a-64-hex-hash", ownerId, REDIRECT_URI],
      ),
      /state_hash/,
      "the 64-hex state_hash CHECK is enforced by real PostgreSQL",
    );
    await assert.rejects(
      () => adapter.query(
        "INSERT INTO youtube_oauth_states (state_hash, owner_id, agent_id, redirect_uri, expires_at) VALUES ($1, $2, 'agent-01', $3, now() + interval '1 minute')",
        [randomUUID().replaceAll("-", "").repeat(2).slice(0, 64), ownerId, "http://insecure.test/cb"],
      ),
      /redirect_uri/,
      "the HTTPS-only redirect_uri CHECK is enforced by real PostgreSQL",
    );
  });

  await t.test("expiry cleanup removes only expired and spent states on real PG", async () => {
    const expiredHash = randomUUID().replaceAll("-", "").repeat(2).slice(0, 64);
    await repo.insertState({ stateHash: expiredHash, ownerId, agentId: "agent-01", redirectUri: REDIRECT_URI, expiresAt: new Date(Date.now() - 1000) });
    const deleted = await repo.deleteExpiredStates(ownerId, "agent-01", { now: new Date() });
    assert.ok(deleted >= 1, "expired state cleaned up");
    assert.equal(await repo.findStateByHash(expiredHash), null);
  });

  await t.test("account persistence: locator survives, DTO hides it, UNIQUE keeps one row", async () => {
    const locator = `opaque://pg-integration/${ownerId}/youtube/token`;
    const first = await repo.upsertAccount({
      ownerId, agentId: "agent-01", status: "connected",
      channelId: "UCpgchannel001", channelTitle: "PG Verified Channel", channelHandle: "@pg-handle",
      oauthScope: "https://www.googleapis.com/auth/youtube.readonly", tokenLocator: locator,
      tokenExpiresAt: new Date(Date.now() + 3600_000), verifiedAt: new Date(),
    });
    assert.equal(first.status, "connected");
    assert.ok(!JSON.stringify(first).includes("opaque://"), "DTO never serializes the locator");

    const raw = await repo.getAccountRow(ownerId, "agent-01");
    assert.equal(raw.token_locator, locator, "the raw row keeps the locator server-side only");

    // Rule 8: a failed attempt updates the same logical row, never duplicates it.
    await repo.upsertAccount({
      ownerId, agentId: "agent-01", status: "connected", channelId: "UCpgchannel001",
      tokenLocator: `opaque://pg-integration/${ownerId}/youtube/token-v2`,
    });
    const rows = await adapter.query(
      "SELECT count(*)::integer AS count FROM youtube_director_accounts WHERE owner_id = $1 AND agent_id = 'agent-01'",
      [ownerId],
    );
    assert.equal(rows.rows[0].count, 1, "UNIQUE (owner, agent, provider) enforces one logical account");

    assert.equal(await repo.getAccount(ownerId, "agent-02"), null, "no cross-director leakage");
    assert.equal(await repo.getAccount(randomUUID(), "agent-01"), null, "no cross-owner leakage");
  });

  await t.test("database CHECK constraints reject raw token material (Rule 17)", async () => {
    await assert.rejects(
      () => adapter.query(
        "INSERT INTO youtube_director_accounts (owner_id, agent_id, status, channel_id, token_locator) VALUES ($1, 'agent-02', 'connected', 'UCpgchannel002', $2)",
        [ownerId, "ya29.raw-access-token-material"],
      ),
      /token_locator/,
      "raw OAuth tokens are structurally unpersistable",
    );
  });

  await t.test("status transitions end honest: connected → disconnected with locator cleared", async () => {
    assert.equal(await repo.markDisconnected(ownerId, "agent-02"), false, "never-connected director is a no-op");
    assert.equal(await repo.markDisconnected(ownerId, "agent-01", { errorCode: null }), true);
    const row = await repo.getAccountRow(ownerId, "agent-01");
    assert.equal(row.status, "disconnected");
    assert.equal(row.token_locator, null);
    assert.ok(row.revoked_at, "revocation timestamp recorded");
    assert.equal((await repo.getAccount(ownerId, "agent-01")).status, "disconnected");
  });
});
