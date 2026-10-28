import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { PostgresCheckpointAdapter } from "../src/checkpoints/postgresCheckpointAdapter.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import { PostgresWorkerResultStore } from "../src/workers/postgresWorkerResultStore.js";
import { WorkerRuntime } from "../src/workers/workerRuntime.js";
import { deterministicJarvisContentHandler } from "../src/jarvis/deterministicContentWorkflow.js";

test("PostgreSQL 15 JARVIS deterministic vertical slice", async (t) => {
  const dbUrl=process.env.POSTGRES_TEST_URL||process.env.DATABASE_URL;
  const required=Boolean(process.env.CI||process.env.npm_lifecycle_event==="test:integration"||dbUrl);
  if(!dbUrl){if(required)assert.fail("PostgreSQL 15 URL is mandatory for JARVIS acceptance");t.diagnostic("PostgreSQL is not configured; JARVIS integration is not run by unit command");return;}
  const schema=`jarvis_${process.pid}_${Date.now()}`;const connection={connectionString:dbUrl,connectionTimeoutMillis:5000};
  const bootstrap=new pg.Pool(connection);let pool;
  try{
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({...connection,options:`-c search_path=${schema},public`});
    const db=new PostgresAdapter({},pool);await new MigrationRunner(db).runMigrations();
    const ownerId=crypto.randomUUID();await db.query("INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x')",[ownerId,`${ownerId}@test.invalid`]);
    const taskId=crypto.randomUUID();const scope={ownerId,agentId:"agent-01"};
    const runtime=new WorkerRuntime({idempotencyStore:new PostgresWorkerResultStore(db,scope)});
    const checkpoints=new CheckpointStore(new PostgresCheckpointAdapter(db,scope));
    const work={taskId,jobType:"jarvis.content.outline.v1",agentId:"agent-01",payload:{publicBrand:"Raat Ki Awaaz",concept:"Ek purani gaon ki haveli mein baarish ki raat ek band radio bhavishya ki cheekhen sunata hai.",language:"hindi",targetMinutes:27},context:{ownerId}};
    const first=await runtime.run(work,deterministicJarvisContentHandler,{checkpointStore:checkpoints});
    assert.equal(first.status,"success");assert.equal(first.output.readiness,"outline_only");assert.equal(first.output.providerCalls.length,0);
    const restarted=new WorkerRuntime({idempotencyStore:new PostgresWorkerResultStore(db,scope)});
    const replay=await restarted.run(work,()=>{throw new Error("must not execute after restart");},{checkpointStore:checkpoints});
    assert.deepEqual(replay,first);assert.equal((await checkpoints.resume(taskId)).step,"outline_package_ready");
    const otherOwner=crypto.randomUUID();await db.query("INSERT INTO owners(id,email,password_hash) VALUES($1,$2,'x')",[otherOwner,`${otherOwner}@test.invalid`]);
    assert.equal(await new PostgresWorkerResultStore(db,{ownerId:otherOwner,agentId:"agent-01"}).get(taskId),null);
  }finally{if(pool)await pool.end().catch(()=>{});await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{});await bootstrap.end();}
});
