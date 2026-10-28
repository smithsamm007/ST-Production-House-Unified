import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import { PostgresCheckpointAdapter } from "../src/checkpoints/postgresCheckpointAdapter.js";

test("PostgreSQL 15 durable checkpoint restart and isolation", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL 15 URL is mandatory for checkpoint integration acceptance");
    t.diagnostic("PostgreSQL is not configured; live checkpoint integration is not run by the unit command");
    return;
  }

  const schema = `checkpoint_${process.pid}_${Date.now()}`;
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
    const agentId = `jarvis-checkpoint-${crypto.randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x'),($3,$4,'x')", [ownerA, `${ownerA}@test.invalid`, ownerB, `${ownerB}@test.invalid`]);
    await db.query("INSERT INTO agents(id,name,namespace) VALUES($1,$2,$3)", [agentId, `JARVIS_CP_${Date.now()}`, `st.jarvis.cp.${Date.now()}`]);

    const taskId = crypto.randomUUID();
    const storeA = new CheckpointStore(new PostgresCheckpointAdapter(db, { ownerId: ownerA, agentId }));
    const first = await storeA.write(taskId, { step: "research_complete", progress: 20, data: { sourceCount: 3 } });
    assert.equal(first.step, "research_complete");

    const restartedStore = new CheckpointStore(new PostgresCheckpointAdapter(db, { ownerId: ownerA, agentId }));
    assert.deepEqual(await restartedStore.resume(taskId), first);

    const otherOwnerStore = new CheckpointStore(new PostgresCheckpointAdapter(db, { ownerId: ownerB, agentId }));
    assert.equal(await otherOwnerStore.resume(taskId), null);
    await assert.rejects(
      otherOwnerStore.write(taskId, { step: "forged", progress: 100, data: {} }),
      /CHECKPOINT_SCOPE_MISMATCH/
    );

    const unchanged = await restartedStore.resume(taskId);
    assert.equal(unchanged.step, "research_complete");
    assert.equal((await db.query("SELECT version FROM job_checkpoints WHERE task_id=$1", [taskId])).rows[0].version, "1");
  } finally {
    if (pool) await pool.end().catch(() => {});
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await bootstrap.end();
  }
});
