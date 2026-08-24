import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import { PostgresCheckpointAdapter } from "../src/checkpoints/postgresCheckpointAdapter.js";
import { PostgresQuotaRepository } from "../src/quotas/postgresQuotaRepository.js";
import { PostgresDispatchAdmissionLifecycle } from "../src/providers/postgresDispatchAdmissionLifecycle.js";

test("PostgreSQL 15 admission claim/release is atomic, restart-safe, and rollback-safe", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    if (process.env.CI || process.env.npm_lifecycle_event === "test:integration") {
      assert.fail("PostgreSQL 15 URL is mandatory for dispatch admission lifecycle acceptance");
    }
    t.diagnostic("PostgreSQL is not configured");
    return;
  }

  const schema = `dispatch_admission_lifecycle_${process.pid}_${Date.now()}`;
  const connection = { connectionString: dbUrl, connectionTimeoutMillis: 5000 };
  const bootstrap = new pg.Pool(connection);
  let pool;
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
    const db = new PostgresAdapter({}, pool);
    await new MigrationRunner(db).runMigrations();

    const ownerId = crypto.randomUUID();
    await db.query("INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x')", [
      ownerId,
      `${ownerId}@test.invalid`
    ]);
    const agentId = "agent-01";
    const taskId = `dispatch-${"a".repeat(64)}`;
    const checkpointStore = new CheckpointStore(new PostgresCheckpointAdapter(db, { ownerId, agentId }));
    const waiting = await checkpointStore.write(taskId, {
      step: "script_dispatch_waiting_for_quota",
      progress: 0,
      data: {
        schemaVersion: 1,
        state: "WAITING_FOR_QUOTA",
        ownerId,
        agentId,
        capability: "text_generation",
        capacityPolicy: "approved_free_only",
        providerSelection: "not_performed",
        executionStarted: false
      }
    });

    const quotaScope = {
      ownerId,
      agentId,
      slot: "emergency_1",
      provider: "p_local_fallback",
      credentialId: null
    };
    const quota = new PostgresQuotaRepository(db);
    await quota.configureQuota(quotaScope, { limit: 2, tier: "free" });
    const firstReservation = await quota.reserve({
      ...quotaScope,
      idempotencyKey: `${taskId}:dispatch-admission:p_local_fallback`,
      units: 1
    });
    const competingReservation = await quota.reserve({
      ...quotaScope,
      idempotencyKey: `${taskId}:competing`,
      units: 1
    });
    const lifecycle = new PostgresDispatchAdmissionLifecycle(db);
    const input = {
      reservation: firstReservation,
      checkpointTaskId: taskId,
      expectedPayloadHash: waiting.payloadHash
    };

    const concurrent = await Promise.all([lifecycle.claim(input), lifecycle.claim(input)]);
    assert.deepEqual(concurrent[0], concurrent[1]);
    assert.equal(concurrent[0].checkpointState, "DISPATCH_ADMITTED");
    assert.equal(concurrent[0].reservationStatus, "reserved");
    assert.equal(concurrent[0].executionStarted, false);
    assert.equal(concurrent[0].providerCallStarted, false);
    assert.equal((await quota.getQuotaState(quotaScope)).usageCount, 0);
    assert.equal((await quota.getQuotaState(quotaScope)).reservedCount, 2);

    const admitted = await checkpointStore.read(taskId);
    const restarted = new PostgresDispatchAdmissionLifecycle(db);
    assert.deepEqual(await restarted.claim(input), concurrent[0]);
    await assert.rejects(
      restarted.claim({
        reservation: competingReservation,
        checkpointTaskId: taskId,
        expectedPayloadHash: waiting.payloadHash
      }),
      /DISPATCH_ADMISSION_STALE_CHECKPOINT/
    );

    const rollbackAdapter = {
      withTransaction(callback) {
        return db.withTransaction((client) => callback({
          query(sql, params) {
            if (String(sql).includes("INSERT INTO evidence_events")) {
              throw new Error("INJECTED_EVIDENCE_FAILURE");
            }
            return client.query(sql, params);
          }
        }));
      }
    };
    await assert.rejects(
      new PostgresDispatchAdmissionLifecycle(rollbackAdapter).release({
        reservation: firstReservation,
        checkpointTaskId: taskId,
        expectedPayloadHash: admitted.payloadHash
      }),
      /INJECTED_EVIDENCE_FAILURE/
    );
    assert.equal((await quota.getQuotaState(quotaScope)).reservedCount, 2);
    assert.equal((await checkpointStore.read(taskId)).data.state, "DISPATCH_ADMITTED");

    const releaseInput = {
      reservation: firstReservation,
      checkpointTaskId: taskId,
      expectedPayloadHash: admitted.payloadHash
    };
    const released = await restarted.release(releaseInput);
    assert.equal(released.checkpointState, "WAITING_FOR_QUOTA");
    assert.equal(released.reservationStatus, "released");
    assert.equal((await quota.getQuotaState(quotaScope)).reservedCount, 1);
    assert.equal((await quota.getQuotaState(quotaScope)).usageCount, 0);
    assert.deepEqual(await restarted.release(releaseInput), released);

    await quota.release(competingReservation);
    assert.equal((await quota.getQuotaState(quotaScope)).reservedCount, 0);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await bootstrap.end();
  }
});
