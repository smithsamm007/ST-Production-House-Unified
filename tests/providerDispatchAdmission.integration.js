import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { PostgresQuotaRepository } from "../src/quotas/postgresQuotaRepository.js";
import { reserveApprovedFreeDispatchAdmission } from "../src/providers/dispatchAdmission.js";

test("PostgreSQL 15 admission is restart-safe, idempotent, scoped, and cap-bounded", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    if (process.env.CI || process.env.npm_lifecycle_event === "test:integration") {
      assert.fail("PostgreSQL 15 URL is mandatory for dispatch admission acceptance");
    }
    t.diagnostic("PostgreSQL is not configured");
    return;
  }

  const schema = `dispatch_admission_${process.pid}_${Date.now()}`;
  const connection = { connectionString: dbUrl, connectionTimeoutMillis: 5000 };
  const bootstrap = new pg.Pool(connection);
  let pool;
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
    const db = new PostgresAdapter({}, pool);
    await new MigrationRunner(db).runMigrations();

    const ownerId = crypto.randomUUID();
    await db.query(
      "INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x')",
      [ownerId, `${ownerId}@test.invalid`]
    );

    const quotaScope = {
      ownerId,
      agentId: "agent-01",
      slot: "emergency_1",
      provider: "p_local_fallback",
      credentialId: null
    };
    const repository = new PostgresQuotaRepository(db);
    await repository.configureQuota(quotaScope, { limit: 1, tier: "free" });

    const makeCheckpoint = (suffix) => ({
      taskId: `dispatch-${suffix.repeat(64)}`,
      data: {
        state: "WAITING_FOR_QUOTA",
        ownerId,
        agentId: "agent-01",
        capability: "text_generation",
        capacityPolicy: "approved_free_only",
        providerSelection: "not_performed",
        executionStarted: false
      }
    });
    const capacitySnapshot = [{
      providerId: "p_local_fallback",
      agentId: "agent-01",
      approved: true,
      available: true,
      costMode: "zero"
    }];
    const candidate = {
      ownerId,
      agentId: "agent-01",
      capability: "text_generation",
      providerId: "p_local_fallback",
      slot: "emergency_1",
      credentialId: null
    };

    const args = {
      checkpoint: makeCheckpoint("a"),
      agentPolicy: "agent-01",
      capacitySnapshot,
      candidate,
      quotaLedger: repository
    };
    const first = await reserveApprovedFreeDispatchAdmission(args);
    const restarted = await reserveApprovedFreeDispatchAdmission({
      ...args,
      quotaLedger: new PostgresQuotaRepository(db)
    });
    assert.deepEqual(restarted, first);
    assert.equal(first.executionStarted, false);
    assert.equal(first.providerCallStarted, false);

    await assert.rejects(
      reserveApprovedFreeDispatchAdmission({
        ...args,
        checkpoint: makeCheckpoint("b")
      }),
      /quota_exceeded/
    );
    assert.equal((await repository.getQuotaState(quotaScope)).reservedCount, 1);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await bootstrap.end();
  }
});
