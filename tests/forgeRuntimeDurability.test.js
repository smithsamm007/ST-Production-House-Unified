/**
 * FORGE durable-runtime adapter contract (no database).
 *
 * These tests prove the control plane never *looks* durable without a real
 * storage adapter and a successful probe, delegates every durable operation to
 * the injected repository, fails closed in production without persistence, and
 * reconciles uncertain boot state without inventing repairs.
 *
 * PostgreSQL behaviour itself is covered by
 * tests/forgeDurableRuntime.integration.js (skipped without a database).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ForgeControlPlane } from "../src/forge/forgeControlPlane.js";
import { createForgePersistenceGuard } from "../src/catalog/server.js";

function createFakeRepository(overrides = {}) {
  const state = {
    tasks: [],
    expiredLeases: [],
    inflightOps: [],
    slot: { slotId: 1, taskId: null, fencingToken: null, prNumber: null, branchName: null, watchdogOverdue: false },
    reconciled: [],
    released: [],
    records: [],
    enqueued: [],
    claimed: [],
  };

  const repository = {
    state,
    probe: async () => ({ ok: true, databaseTime: "2026-11-18T00:00:00.000Z" }),
    listTasks: async () => state.tasks,
    getRuntimeStatus: async () => ({
      tasks: { total: state.tasks.length, byStatus: {} },
      leases: { active: 0, expiredActive: state.expiredLeases.length },
      externalOps: { inflight: state.inflightOps.length, committed: 0, failedSafeToRetry: 0 },
      prSlot: state.slot,
      checkpoints: 0,
      lastReconciliation: null,
    }),
    enqueueTask: async (args) => {
      state.enqueued.push(args);
      return { deduplicated: false, task: { id: "pg-task-1", derivedBranch: `task/${args.issueNumber}-${args.slug}` } };
    },
    claimLease: async (args) => {
      state.claimed.push(args);
      return { ok: true, code: "LEASE_ACQUIRED", fencingToken: 7, lease: { fencingToken: 7 } };
    },
    listExpiredActiveLeases: async () => state.expiredLeases,
    listInflightExternalOps: async () => state.inflightOps,
    getPrSlot: async () => state.slot,
    reconcileExternalOp: async (args) => {
      state.reconciled.push(args);
      return { ok: true, op: { idempotencyKey: args.idempotencyKey } };
    },
    releasePrSlot: async (args) => {
      state.released.push(args);
      return { ok: true, code: "PR_SLOT_RELEASED" };
    },
    recordReconciliation: async (args) => {
      state.records.push(args);
      return { ...args, id: "recon-1" };
    },
    ...overrides,
  };
  return repository;
}

test("a control plane without a repository reports itself non-durable", async () => {
  const plane = new ForgeControlPlane();
  const persistence = await plane.getPersistenceStatus();

  assert.equal(persistence.adapter, "local-memory");
  assert.equal(persistence.durable, false);
  assert.equal(persistence.verified, false);
  assert.equal(persistence.reason, "LOCAL_MEMORY_ADAPTER_NON_DURABLE");

  const snapshot = await plane.getFullStatusSnapshot();
  assert.equal(snapshot.queue.adapter, "local-memory");
  assert.equal(snapshot.queue.durable, false);
  assert.equal(snapshot.persistence.durable, false);
});

test("a repository object alone is not durability: probe failure reports degraded", async () => {
  const repository = createFakeRepository({
    probe: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const plane = new ForgeControlPlane({ repository });
  const persistence = await plane.getPersistenceStatus();

  assert.equal(persistence.adapter, "postgres");
  assert.equal(persistence.durable, false);
  assert.equal(persistence.ready, false);
  assert.equal(persistence.reason, "POSTGRES_UNAVAILABLE");
});

test("a healthy probe reports durable with the real runtime facts", async () => {
  const repository = createFakeRepository();
  repository.state.tasks.push({ id: "t1", status: "READY" });
  const plane = new ForgeControlPlane({ repository });

  const persistence = await plane.getPersistenceStatus();
  assert.equal(persistence.adapter, "postgres");
  assert.equal(persistence.durable, true);
  assert.equal(persistence.verified, true);
  assert.equal(persistence.databaseTime, "2026-11-18T00:00:00.000Z");
  assert.equal(persistence.runtime.tasks.total, 1);
});

test("durable operations are delegated to the repository, not kept in memory", async () => {
  const repository = createFakeRepository();
  const plane = new ForgeControlPlane({ repository });

  const enqueued = await plane.enqueueTask({
    issueNumber: 294,
    slug: "durable",
    title: "Durable task",
    idempotencyKey: "idem-294",
  });
  assert.equal(enqueued.task.id, "pg-task-1");
  assert.equal(repository.state.enqueued.length, 1);

  const lease = await plane.claimLease({ taskId: "pg-task-1", workerId: "worker-1", leaseTtlMs: 120_000 });
  assert.equal(lease.fencingToken, 7);
  assert.equal(repository.state.claimed[0].leaseTtlSeconds, 120);

  const tasks = await plane.listTasks();
  assert.deepEqual(tasks, repository.state.tasks);
});

test("production without persistence fails closed; demo/local keeps working", () => {
  const guard = createForgePersistenceGuard({ isProduction: true, isDurable: false });
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  let nextCalled = false;
  guard({}, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "FORGE_PERSISTENCE_UNAVAILABLE");

  const permissive = createForgePersistenceGuard({ isProduction: false, isDurable: false });
  let passed = false;
  permissive({}, {}, () => {
    passed = true;
  });
  assert.equal(passed, true);
});

test("boot reconciliation never releases an unverified PR slot or replays an unverified write", async () => {
  const repository = createFakeRepository();
  repository.state.inflightOps = [{ idempotencyKey: "op-1", operationType: "github.push_branch" }];
  repository.state.slot = {
    slotId: 1,
    taskId: "task-1",
    fencingToken: 3,
    prNumber: 90,
    branchName: "task/1-x",
    watchdogOverdue: true,
  };
  const plane = new ForgeControlPlane({ repository });

  const result = await plane.reconcileOnBoot({ instanceId: "boot-1" });
  const codes = result.decisions.map((decision) => decision.code);

  assert.equal(result.durable, true);
  assert.ok(codes.includes("EXTERNAL_OP_UNVERIFIED"));
  assert.ok(codes.includes("PR_SLOT_WATCHDOG_OVERDUE_HELD"));
  assert.equal(repository.state.reconciled.length, 0, "no write is replayed without evidence");
  assert.equal(repository.state.released.length, 0, "an overdue watchdog is not permission to release");
  assert.equal(repository.state.records.length, 1, "the reconciliation attempt itself is recorded");
});

test("boot reconciliation uses authoritative probe results when available", async () => {
  const repository = createFakeRepository();
  repository.state.inflightOps = [
    { idempotencyKey: "op-present", operationType: "github.push_branch" },
    { idempotencyKey: "op-absent", operationType: "github.create_pr" },
  ];
  repository.state.slot = {
    slotId: 1,
    taskId: "task-2",
    fencingToken: 5,
    prNumber: 91,
    branchName: "task/2-y",
    watchdogOverdue: false,
  };
  const plane = new ForgeControlPlane({ repository });

  const githubProbe = async (input) => {
    if (input.idempotencyKey === "op-present") return { state: "present", sha: "a".repeat(40) };
    if (input.idempotencyKey === "op-absent") return { state: "absent" };
    return { state: "unverified", prState: "merged" };
  };

  const result = await plane.reconcileOnBoot({ instanceId: "boot-2", githubProbe });
  const codes = result.decisions.map((decision) => decision.code);

  assert.ok(codes.includes("EXTERNAL_OP_RECONCILED_COMMITTED"));
  assert.ok(codes.includes("EXTERNAL_OP_SAFE_TO_RETRY"));
  assert.ok(codes.includes("PR_SLOT_RELEASED_ON_AUTHORITATIVE_STATE"));
  assert.equal(repository.state.released[0].prState, "merged");
});
