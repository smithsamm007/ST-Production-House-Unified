import test from "node:test";
import assert from "node:assert/strict";
import { WorkerRuntime } from "../src/workers/workerRuntime.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import { deterministicJarvisContentHandler } from "../src/jarvis/deterministicContentWorkflow.js";

class TestStore {
  constructor(name) { this.name=name; this.store=new Map(); }
  async get(key) { return this.store.get(key) || null; }
  async set(key,value) { this.store.set(key,value); }
}

function envelope(overrides={}) {
  return { taskId:"jarvis-local-1", jobType:"jarvis.content.outline.v1", agentId:"agent-01",
    payload:{publicBrand:"Raat Ki Awaaz",concept:"Ek sunsaan pahadi hostel mein har raat band kamre se kisi bachche ki ghanti sunai deti hai.",language:"hinglish",targetMinutes:27,...overrides},
    context:{ownerId:"owner-test"} };
}

test("JARVIS local slice creates a truthful outline-only package and exactly three Shorts plans", async () => {
  const results=new TestStore("TestIdempotencyStore");
  const checkpoints=new CheckpointStore(new TestStore("TestCheckpointAdapter"));
  const runtime=new WorkerRuntime({idempotencyStore:results,isTestEnv:true});
  const result=await runtime.run(envelope(),deterministicJarvisContentHandler,{checkpointStore:checkpoints});
  assert.equal(result.status,"success");
  assert.equal(result.output.readiness,"outline_only");
  assert.equal(result.output.providerCalls.length,0);
  assert.equal(result.output.publication.status,"not_requested");
  assert.deepEqual(result.output.shortsPlan,["opening_hook","high_tension_moment","cliffhanger_teaser"]);
  assert.equal((await checkpoints.resume("jarvis-local-1")).step,"outline_package_ready");
  assert.deepEqual(await runtime.run(envelope(),()=>{throw new Error("must not rerun");}),result);
});

test("JARVIS local slice rejects wrong agent, unsafe duration, and secret-like briefs", async () => {
  const context={agentId:"agent-02",jobType:"jarvis.content.outline.v1",payload:envelope().payload,heartbeat(){},checkpoint:async()=>{}};
  await assert.rejects(deterministicJarvisContentHandler(context),/SCOPE_MISMATCH/);
  await assert.rejects(deterministicJarvisContentHandler({...context,agentId:"agent-01",payload:{...context.payload,targetMinutes:10}}),/DURATION_INVALID/);
  await assert.rejects(deterministicJarvisContentHandler({...context,agentId:"agent-01",payload:{...context.payload,concept:"This owner concept includes password=hunter2 and must be rejected immediately."}}),/SECRET_REJECTED/);
});
