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
import { PostgresDispatchExecutionPermit } from "../src/providers/postgresDispatchExecutionPermit.js";

test("PostgreSQL 15 execution permit is atomic, restart-safe, scoped, revocable, and rollback-safe", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    if (process.env.CI || process.env.npm_lifecycle_event === "test:integration") assert.fail("PostgreSQL 15 URL is mandatory for execution permit acceptance");
    t.diagnostic("PostgreSQL is not configured"); return;
  }
  const schema = `dispatch_permit_${process.pid}_${Date.now()}`;
  const connection = { connectionString: dbUrl, connectionTimeoutMillis: 5000 };
  const bootstrap = new pg.Pool(connection); let pool;
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
    const db = new PostgresAdapter({}, pool);
    await new MigrationRunner(db).runMigrations();
    const ownerId = crypto.randomUUID();
    await db.query("INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x')", [ownerId, `${ownerId}@test.invalid`]);
    const agentId = "agent-01";
    const taskId = `dispatch-${crypto.randomBytes(32).toString("hex")}`;
    const store = new CheckpointStore(new PostgresCheckpointAdapter(db, { ownerId, agentId }));
    const waiting = await store.write(taskId, { step: "script_dispatch_waiting_for_quota", progress: 0,
      data: { state: "WAITING_FOR_QUOTA", ownerId, agentId, capability: "text_generation",
        capacityPolicy: "approved_free_only", providerSelection: "not_performed", executionStarted: false } });
    const quotaScope = { ownerId, agentId, slot: "emergency_1", provider: "p_local_fallback", credentialId: null };
    const quota = new PostgresQuotaRepository(db);
    await quota.configureQuota(quotaScope, { limit: 1, tier: "free" });
    const reservation = await quota.reserve({ ...quotaScope, idempotencyKey: `${taskId}:admission`, units: 1 });
    const admission = await new PostgresDispatchAdmissionLifecycle(db).claim({ reservation,
      checkpointTaskId: taskId, expectedPayloadHash: waiting.payloadHash });
    const input = { reservation, checkpointTaskId: taskId, expectedPayloadHash: admission.checkpointPayloadHash,
      capability: "text_generation", leaseOwner: "worker-1", permitKey: "attempt-1", leaseSeconds: 30 };
    const permit = new PostgresDispatchExecutionPermit(db);
    const concurrent = await Promise.all([permit.issue(input), permit.issue(input)]);
    assert.deepEqual(concurrent[0], concurrent[1]);
    assert.equal(concurrent[0].checkpointState, "DISPATCH_PERMITTED");
    assert.equal(concurrent[0].reservationStatus, "reserved");
    assert.equal(concurrent[0].executionStarted, false);
    assert.equal(concurrent[0].providerCallStarted, false);
    assert.equal((await quota.getQuotaState(quotaScope)).usageCount, 0);
    assert.deepEqual(await new PostgresDispatchExecutionPermit(db).issue(input), concurrent[0]);
    await assert.rejects(permit.issue({ ...input, permitKey: "attempt-2", leaseOwner: "worker-2" }), /DISPATCH_PERMIT_STALE_CHECKPOINT/);
    await assert.rejects(permit.issue({ ...input, reservation: { ...reservation, ownerId: crypto.randomUUID() } }), /DISPATCH_PERMIT_SCOPE_MISMATCH/);

    const active = await store.read(taskId);
    const rollbackAdapter = { withTransaction(callback) { return db.withTransaction((client) => callback({
      query(sql, params) { if (String(sql).includes("INSERT INTO evidence_events")) throw new Error("INJECTED_EVIDENCE_FAILURE");
        return client.query(sql, params); }
    })); } };
    const revokeInput = { ...input, expectedPayloadHash: active.payloadHash };
    await assert.rejects(new PostgresDispatchExecutionPermit(rollbackAdapter).revoke(revokeInput), /INJECTED_EVIDENCE_FAILURE/);
    assert.equal((await store.read(taskId)).data.state, "DISPATCH_PERMITTED");
    const revoked = await new PostgresDispatchExecutionPermit(db).revoke(revokeInput);
    assert.equal(revoked.checkpointState, "DISPATCH_ADMITTED");
    assert.equal(revoked.permitStatus, "revoked");
    assert.equal((await quota.getQuotaState(quotaScope)).reservedCount, 1);
    assert.equal((await quota.getQuotaState(quotaScope)).usageCount, 0);
    assert.deepEqual(await permit.revoke(revokeInput), revoked);

    const secondInput = { ...input, permitKey: "attempt-expiry", expectedPayloadHash: revoked.checkpointPayloadHash };
    await permit.issue(secondInput);
    const expiring = await store.read(taskId);
    const expiredRecord = await store.write(taskId, { step: expiring.step, progress: expiring.progress,
      data: { ...expiring.data, permitExpiresAt: "2000-01-01T00:00:00.000Z" },
      artifactRefs: expiring.artifactRefs, evidenceRefs: expiring.evidenceRefs });
    const expired = await new PostgresDispatchExecutionPermit(db).reclaimExpired({
      ...secondInput, expectedPayloadHash: expiredRecord.payloadHash
    });
    assert.equal(expired.checkpointState, "DISPATCH_ADMITTED");
    assert.equal(expired.permitStatus, "expired");
    assert.equal((await quota.getQuotaState(quotaScope)).reservedCount, 1);

    const intentPermitInput = { ...input, permitKey: "attempt-intent",
      expectedPayloadHash: expired.checkpointPayloadHash };
    await permit.issue(intentPermitInput);
    const intentReady = await store.read(taskId);
    const intentInput = { ...intentPermitInput, expectedPayloadHash: intentReady.payloadHash, intentKey: "intent-1" };
    await assert.rejects(new PostgresDispatchExecutionPermit(rollbackAdapter).redeem(intentInput), /INJECTED_EVIDENCE_FAILURE/);
    assert.equal((await store.read(taskId)).data.state, "DISPATCH_PERMITTED");

    const competing = await Promise.allSettled([
      new PostgresDispatchExecutionPermit(db).redeem(intentInput),
      new PostgresDispatchExecutionPermit(db).redeem({ ...intentInput, intentKey: "intent-2" })
    ]);
    assert.equal(competing.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(competing.filter((entry) => entry.status === "rejected").length, 1);
    const winningIndex = competing.findIndex((entry) => entry.status === "fulfilled");
    const created = competing[winningIndex].value;
    const winningInput = winningIndex === 0 ? intentInput : { ...intentInput, intentKey: "intent-2" };
    assert.equal(created.checkpointState, "DISPATCH_EXECUTION_INTENT");
    assert.equal(created.permitStatus, "consumed");
    assert.equal(created.executionIntentStatus, "ready");
    assert.equal(created.executionStarted, false);
    assert.equal(created.providerCallStarted, false);
    assert.equal((await quota.getQuotaState(quotaScope)).reservedCount, 1);
    assert.equal((await quota.getQuotaState(quotaScope)).usageCount, 0);
    assert.deepEqual(await new PostgresDispatchExecutionPermit(db).redeem(winningInput), created);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await bootstrap.end();
  }
});
