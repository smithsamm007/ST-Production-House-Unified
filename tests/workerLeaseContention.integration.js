/**
 * Durable queue + lease behaviour on LIVE PostgreSQL (Phase 3 evidence).
 *
 * Proves, against a real database rather than a fake, that:
 *   1. concurrent claimants never double-claim one job
 *      (`FOR UPDATE SKIP LOCKED` — exactly one winner out of N racers);
 *   2. a crashed worker does not lose its job: an expired lease is
 *      reclaimable by another worker;
 *   3. `idempotency_key UNIQUE` makes a duplicate enqueue impossible
 *      (Rule 13 — a retried request cannot create a second logical job);
 *   4. the database trigger enforces the legal job-status transitions
 *      (Rule 5 — no invented states);
 *   5. a checkpoint written before a "restart" resumes from durable storage,
 *      and a finished (terminal) job is never re-claimed.
 *
 * Runs only under the integration command (`npm run test:integration`) or when
 * a PostgreSQL URL is configured; it creates and drops its own isolated schema
 * so it never touches production-shaped data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import { PostgresCheckpointAdapter } from "../src/checkpoints/postgresCheckpointAdapter.js";
import { JobRepository, configureRepositoryAdapter } from "../src/catalog/repositories.js";

test("durable worker leases: contention, expiry recovery, idempotency, checkpoints", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL URL is mandatory for durable-queue acceptance");
    t.diagnostic("PostgreSQL is not configured; live lease verification is not run by the unit command");
    return;
  }

  const schema = `lease_${process.pid}_${Date.now()}`;
  const connection = { connectionString: dbUrl, connectionTimeoutMillis: 5000 };
  const bootstrap = new pg.Pool(connection);
  let pool = null;
  let pgAvailable = true;
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  } catch (error) {
    pgAvailable = false;
    t.diagnostic(`PostgreSQL unreachable for durable-lease verification: ${error.message}`);
  }
  if (!pgAvailable) {
    await bootstrap.end().catch(() => {});
    if (required) assert.fail("PostgreSQL URL was configured but the database could not be reached");
    return;
  }

  try {
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
    const db = new PostgresAdapter({}, pool);
    await new MigrationRunner(db).runMigrations();
    configureRepositoryAdapter(db);

    const ownerId = crypto.randomUUID();
    const agentId = `agent-lease-${crypto.randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x')", [ownerId, `${ownerId}@test.invalid`]);
    await db.query("INSERT INTO agents(id,name,namespace) VALUES($1,$2,$3)", [agentId, `LEASE_${Date.now()}`, `st.lease.${Date.now()}`]);

    const jobs = new JobRepository();
    const capability = "episode_production";
    const idempotencyKey = `lease-proof-${crypto.randomUUID()}`;
    const created = await jobs.create({
      agentId,
      capability,
      idempotency_key: idempotencyKey,
      payload: { releaseId: "release-lease-proof", stage: "audio" },
    });
    assert.equal(created.status, "queued");

    // 1. Eight concurrent claimants, one job.
    const future = new Date(Date.now() + 60_000).toISOString();
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        jobs.claimLease(agentId, capability, `worker-${index}`, future)
      )
    );
    const winners = claims.filter(Boolean);
    assert.equal(winners.length, 1, "exactly one concurrent claimant may hold the lease");
    assert.equal(winners[0].id, created.id);
    assert.equal(winners[0].status, "leased");
    assert.equal(Number(winners[0].attempts), 1, "a claim increments the durable attempt counter");
    const winnerOwner = winners[0].lease_owner;

    // No second job of this capability may be claimed while the lease is live.
    assert.equal(await jobs.claimLease(agentId, capability, "worker-late", future), null);

    // 2. Lease expiry: a crashed worker's job becomes reclaimable.
    await db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [created.id]);
    const recovered = await jobs.claimLease(agentId, capability, "worker-recovery", future);
    assert.equal(recovered?.id, created.id, "an expired lease must be reclaimable after worker loss");
    assert.notEqual(recovered.lease_owner, winnerOwner);
    assert.equal(Number(recovered.attempts), 2);

    // 3. Idempotency key uniqueness: the same request cannot enqueue a second job.
    await assert.rejects(
      () => jobs.create({ agentId, capability, idempotency_key: idempotencyKey, payload: { again: true } }),
      (error) => error.code === "23505" || /duplicate key/i.test(error.message)
    );

    // 4. Legal transitions are database-enforced (leased → running → succeeded).
    await jobs.updateStatus(created.id, "running");
    await jobs.updateStatus(created.id, "succeeded");
    await assert.rejects(
      () => jobs.updateStatus(created.id, "queued"),
      (error) => /Cannot transition from terminal status/.test(error.message),
      "a terminal job must not be reopened by a status write"
    );

    // 5. A terminal job is never re-claimed, and a checkpoint survives a restart.
    await db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [created.id]);
    assert.equal(await jobs.claimLease(agentId, capability, "worker-after-terminal", future), null);

    const taskId = crypto.randomUUID();
    const firstStore = new CheckpointStore(new PostgresCheckpointAdapter(db, { ownerId, agentId }));
    const written = await firstStore.write(taskId, { step: "audio_complete", progress: 40, data: { artifactSha: "a".repeat(64) } });
    const restartedStore = new CheckpointStore(new PostgresCheckpointAdapter(db, { ownerId, agentId }));
    assert.deepEqual(await restartedStore.resume(taskId), written, "resume must read the durable checkpoint, not re-run the stage");

    t.diagnostic(
      `LEASE_PROOF claimants=8 winners=1 recoveries=1 terminalReclaim=0 idempotencyKeying=unique checkpointResume=durable storage=${schema}`
    );
  } finally {
    if (pool) await pool.end().catch(() => {});
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await bootstrap.end().catch(() => {});
  }
});
