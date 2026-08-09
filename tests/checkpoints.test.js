import test from "node:test";
import assert from "node:assert/strict";
import { CheckpointStore, CheckpointValidationError, CheckpointCorruptedError } from "../src/checkpoints/checkpointStore.js";

// Explicitly named test adapter to meet CheckpointStore constructor requirements
class TestCheckpointAdapter {
  constructor(sharedState = new Map()) {
    this.name = "TestCheckpointAdapter";
    this.store = sharedState;
  }
  async get(key) {
    return this.store.get(key) || null;
  }
  async set(key, value) {
    this.store.set(key, value);
  }
}

test("CheckpointStore - validates constructor arguments and adapter interface", () => {
  // Missing adapter
  assert.throws(
    () => new CheckpointStore(),
    /CheckpointStore requires a durable checkpoint adapter/
  );

  // Missing get method
  assert.throws(
    () => new CheckpointStore({ set: () => {} }),
    /Invalid checkpoint adapter interface/
  );

  // Missing set method
  assert.throws(
    () => new CheckpointStore({ get: () => {} }),
    /Invalid checkpoint adapter interface/
  );

  // Silent production in-memory fallback is prohibited
  const silentInMemoryProductionAdapter = {
    get: async () => null,
    set: async () => {},
    isInMemory: true
  };
  assert.throws(
    () => new CheckpointStore(silentInMemoryProductionAdapter),
    /Silent in-memory persistence is prohibited in production/
  );

  // Properly explicitly named test adapter works
  const ok = new CheckpointStore(new TestCheckpointAdapter());
  assert.ok(ok);
});

test("CheckpointStore - validates input during write", async () => {
  const store = new CheckpointStore(new TestCheckpointAdapter());

  // Missing taskId
  await assert.rejects(
    () => store.write("", { step: "init", progress: 0 }),
    CheckpointValidationError
  );

  // Missing step
  await assert.rejects(
    () => store.write("task-1", { step: "", progress: 10 }),
    CheckpointValidationError
  );

  // Progress out of bounds
  await assert.rejects(
    () => store.write("task-1", { step: "render", progress: -1 }),
    CheckpointValidationError
  );

  await assert.rejects(
    () => store.write("task-1", { step: "render", progress: 101 }),
    CheckpointValidationError
  );

  // Invalid data structure
  await assert.rejects(
    () => store.write("task-1", { step: "render", progress: 50, data: "not-an-object" }),
    CheckpointValidationError
  );

  // Malformed artifact references
  await assert.rejects(
    () => store.write("task-1", { step: "render", progress: 50, artifactRefs: [{ path: "/foo" }] }),
    CheckpointValidationError
  );
});

test("CheckpointStore - successfully writes, reads, and resumes checkpoints", async () => {
  const store = new CheckpointStore(new TestCheckpointAdapter());
  const taskId = "task-abc-123";

  const checkpointData = {
    step: "transcode",
    progress: 45,
    data: { currentFrame: 1200, codec: "h264" },
    artifactRefs: [{ path: "output.mp4", sha256: "hash123", type: "video" }],
    evidenceRefs: ["event-001"]
  };

  const written = await store.write(taskId, checkpointData);

  assert.equal(written.taskId, taskId);
  assert.equal(written.step, "transcode");
  assert.equal(written.progress, 45);
  assert.deepEqual(written.data, { currentFrame: 1200, codec: "h264" });
  assert.equal(written.artifactRefs[0].path, "output.mp4");
  assert.equal(written.evidenceRefs[0], "event-001");
  assert.ok(written.payloadHash);
  assert.ok(written.checksum);

  // Read checkpoint
  const retrieved = await store.read(taskId);
  assert.deepEqual(retrieved, written);

  // Resume checkpoint
  const resumed = await store.resume(taskId);
  assert.deepEqual(resumed, written);
});

test("CheckpointStore - deep copies and freezes data to prevent mutations", async () => {
  const store = new CheckpointStore(new TestCheckpointAdapter());
  const taskId = "task-mut";
  const myData = { nested: { val: 42 } };

  const written = await store.write(taskId, {
    step: "check",
    progress: 10,
    data: myData
  });

  // Check object is frozen
  assert.throws(() => {
    written.data.nested.val = 99;
  });

  // Modify source object, shouldn't affect store
  myData.nested.val = 100;
  const retrieved = await store.read(taskId);
  assert.equal(retrieved.data.nested.val, 42);
});

test("CheckpointStore - ensures data integrity and throws on corruption", async () => {
  const adapter = new TestCheckpointAdapter();
  const store = new CheckpointStore(adapter);
  const taskId = "task-integrity";

  await store.write(taskId, {
    step: "render",
    progress: 80,
    data: { frames: [1, 2, 3] }
  });

  // Tamper with underlying data directly in the store adapter
  const raw = await adapter.get(taskId);
  const parsed = JSON.parse(raw);
  parsed.progress = 81; // Modify field value without changing checksum

  await adapter.set(taskId, JSON.stringify(parsed));

  // Trying to read must fail due to corrupted checksum
  await assert.rejects(
    () => store.read(taskId),
    CheckpointCorruptedError
  );
});

test("CheckpointStore - handles write idempotency correctly", async () => {
  const store = new CheckpointStore(new TestCheckpointAdapter());
  const taskId = "task-idem";

  const cp = {
    step: "upload",
    progress: 90,
    data: { chunk: 9 }
  };

  const w1 = await store.write(taskId, cp);
  const w2 = await store.write(taskId, cp);

  assert.equal(w1.checksum, w2.checksum);
  assert.equal(w1.updatedAt, w2.updatedAt);
});

test("CheckpointStore - restart/resume durability across store instances with shared persistent backing", async () => {
  const sharedStorageBacking = new Map();

  // Spin up instance A and write a checkpoint
  const adapterA = new TestCheckpointAdapter(sharedStorageBacking);
  const storeA = new CheckpointStore(adapterA);
  const taskId = "durable-task-44";

  await storeA.write(taskId, {
    step: "transcode-step-2",
    progress: 60,
    data: { bitRate: "5000k" }
  });

  // Spin up completely separate instance B referencing the SAME sharedStorageBacking
  const adapterB = new TestCheckpointAdapter(sharedStorageBacking);
  const storeB = new CheckpointStore(adapterB);

  // Verify instance B recovers the exact state seamlessly
  const resumed = await storeB.resume(taskId);
  assert.equal(resumed.step, "transcode-step-2");
  assert.equal(resumed.progress, 60);
  assert.deepEqual(resumed.data, { bitRate: "5000k" });
});
