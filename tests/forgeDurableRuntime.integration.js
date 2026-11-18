/**
 * FORGE durable runtime — PostgreSQL 15 acceptance (D3).
 *
 * Runs against a disposable database created from the canonical migration set
 * and dropped afterwards. Covers the seven required scenarios:
 *   A restart recovery · B concurrent instances · C fencing · D idempotency
 *   E PR slot · F external-operation reconciliation · G PostgreSQL failure
 *
 * Nothing here touches a persistent database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { PostgresForgeRepository } from "../src/forge/postgresForgeRepository.js";
import { ForgeControlPlane } from "../src/forge/forgeControlPlane.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";

test(
  "PostgreSQL 15 FORGE durable runtime: restart, concurrency, fencing, idempotency, PR slot, reconciliation, failure",
  { skip: !POSTGRES_URL ? "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" : false },
  async () => {
    const created = await createDisposableDatabase(POSTGRES_URL, "stph_acceptance");
    const pool = new pg.Pool({ connectionString: created.connectionString, max: 10 });
    const auxiliaryPools = [];
    const instancePool = () => {
      const aux = new pg.Pool({ connectionString: created.connectionString, max: 4 });
      auxiliaryPools.push(aux);
      return aux;
    };
    try {
      const migrations = await new MigrationRunner(new PostgresAdapter({}, pool)).runMigrations();
      assert.ok(migrations.appliedCount > 0, "canonical migrations must apply");

      const repo = new PostgresForgeRepository(pool);
      const workerA = await repo.registerWorker({ workerKey: `d3-a-${Date.now()}`, role: "coder" });
      const workerB = await repo.registerWorker({ workerKey: `d3-b-${Date.now()}`, role: "coder" });

      const stamp = Date.now();

      /* ---------------------------------------------------------------- Test A */
      const plane1 = new ForgeControlPlane({ repository: repo });
      const { task: taskA } = await plane1.enqueueTask({
        issueNumber: 401,
        slug: "restart-recovery",
        title: "Restart recovery",
        idempotencyKey: `d3-a-${stamp}`,
      });
      assert.ok(taskA.id);

      const leaseA = await plane1.claimLease({ taskId: taskA.id, workerId: workerA.id, leaseTtlSeconds: 120 });
      assert.equal(leaseA.ok, true);
      assert.equal(leaseA.fencingToken, 1);

      const checkpoint = await plane1.recordCheckpoint({
        taskId: taskA.id,
        fencingToken: leaseA.fencingToken,
        sequence: 1,
        state: { stage: "planning", note: "checkpoint before restart" },
      });
      assert.equal(checkpoint.ok, true);

      // Restart: a brand-new control plane and repository over the same database.
      const restartedRepo = new PostgresForgeRepository(instancePool());
      const plane2 = new ForgeControlPlane({ repository: restartedRepo });

      const recovered = await plane2.listTasks();
      const recoveredTask = recovered.find((task) => task.id === taskA.id);
      assert.ok(recoveredTask, "the task survives the restart");
      assert.equal(recoveredTask.status, "IN_PROGRESS");
      assert.equal(recoveredTask.activeFencingToken, 1);
      assert.equal(recoveredTask.attemptCount, 1);

      const recoveredCheckpoint = await restartedRepo.getLatestCheckpoint(taskA.id, leaseA.fencingToken);
      assert.equal(recoveredCheckpoint.sequence, 1);
      assert.equal(recoveredCheckpoint.state.stage, "planning");

      const persistence = await plane2.getPersistenceStatus();
      assert.equal(persistence.adapter, "postgres");
      assert.equal(persistence.durable, true);
      assert.equal(persistence.verified, true);

      /* ---------------------------------------------------------------- Test B */
      const { task: taskB } = await plane1.enqueueTask({
        issueNumber: 402,
        slug: "concurrent-claims",
        title: "Concurrent claims",
        idempotencyKey: `d3-b-${stamp}`,
      });
      const planeOtherInstance = new ForgeControlPlane({
        repository: new PostgresForgeRepository(instancePool()),
      });

      const [claim1, claim2] = await Promise.all([
        plane1.claimLease({ taskId: taskB.id, workerId: workerA.id, leaseTtlSeconds: 60 }),
        planeOtherInstance.claimLease({ taskId: taskB.id, workerId: workerB.id, leaseTtlSeconds: 60 }),
      ]);
      const winners = [claim1, claim2].filter((claim) => claim.ok === true);
      const losers = [claim1, claim2].filter((claim) => claim.ok === false);
      assert.equal(winners.length, 1, "exactly one instance may hold the lease");
      assert.equal(losers.length, 1);
      assert.equal(losers[0].code, "LEASE_ALREADY_ACTIVE");

      const activeLeaseRows = await pool.query(
        "SELECT count(*)::integer AS count FROM forge_worker_leases WHERE task_id = $1 AND released_at IS NULL",
        [taskB.id]
      );
      assert.equal(activeLeaseRows.rows[0].count, 1);

      /* ---------------------------------------------------------------- Test C */
      const { task: taskC } = await plane1.enqueueTask({
        issueNumber: 403,
        slug: "fencing",
        title: "Fencing",
        idempotencyKey: `d3-c-${stamp}`,
      });
      const stale = await plane1.claimLease({ taskId: taskC.id, workerId: workerA.id, leaseTtlSeconds: 0 });
      assert.equal(stale.ok, true);
      assert.equal(stale.fencingToken, 1);

      const fresh = await plane1.claimLease({ taskId: taskC.id, workerId: workerB.id, leaseTtlSeconds: 60 });
      assert.equal(fresh.ok, true);
      assert.equal(fresh.fencingToken, 2, "fencing tokens increase monotonically");

      const staleCheckpoint = await plane1.recordCheckpoint({
        taskId: taskC.id,
        fencingToken: 1,
        sequence: 2,
        state: { stage: "stale" },
      });
      assert.equal(staleCheckpoint.ok, false);
      assert.equal(staleCheckpoint.code, "FENCING_TOKEN_STALE");

      const staleComplete = await plane1.completeTask({
        taskId: taskC.id,
        fencingToken: 1,
        outcome: "SUCCEEDED",
        result: { staged: true },
      });
      assert.equal(staleComplete.ok, false);
      assert.equal(staleComplete.code, "FENCING_TOKEN_STALE");

      const committed = await plane1.completeTask({
        taskId: taskC.id,
        fencingToken: 2,
        outcome: "SUCCEEDED",
        result: { artifact: "sha256:abc" },
      });
      assert.equal(committed.ok, true);
      assert.equal(committed.status, "ACCEPTED");

      const staleResultRows = await pool.query(
        "SELECT count(*)::integer AS count FROM forge_task_results WHERE task_id = $1",
        [taskC.id]
      );
      assert.equal(staleResultRows.rows[0].count, 1, "only the current holder's result is stored");

      /* ---------------------------------------------------------------- Test D */
      const idempotencyKey = `d3-d-${stamp}`;
      const concurrentEnqueues = await Promise.all([
        plane1.enqueueTask({ issueNumber: 404, slug: "idempotent", title: "Idempotent", idempotencyKey }),
        planeOtherInstance.enqueueTask({ issueNumber: 404, slug: "idempotent", title: "Idempotent", idempotencyKey }),
        plane1.enqueueTask({ issueNumber: 404, slug: "idempotent", title: "Idempotent", idempotencyKey }),
      ]);
      const duplicateRows = await pool.query(
        "SELECT count(*)::integer AS count FROM forge_tasks WHERE idempotency_key = $1",
        [idempotencyKey]
      );
      assert.equal(duplicateRows.rows[0].count, 1, "one logical task per idempotency key");
      assert.ok(concurrentEnqueues.some((entry) => entry.deduplicated === true));

      /* ---------------------------------------------------------------- Test E */
      // Expire the active lease so the reclaim path (not a fresh task) is used.
      await pool.query(
        "UPDATE forge_worker_leases SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE task_id = $1 AND released_at IS NULL",
        [taskB.id]
      );
      const slotTask = await plane1.claimLease({ taskId: taskB.id, workerId: workerA.id, leaseTtlSeconds: 0 });
      assert.equal(slotTask.ok, true, "expired lease is reclaimed atomically");
      const slotToken = slotTask.fencingToken;

      const reserved = await plane1.reservePrSlot({
        taskId: taskB.id,
        fencingToken: slotToken,
        branchName: "task/402-concurrent-claims",
      });
      assert.equal(reserved.ok, true);
      assert.equal(reserved.code, "PR_SLOT_RESERVED");

      // A different task with its own active lease must not take slot 1.
      const otherTask = await plane1.enqueueTask({
        issueNumber: 405,
        slug: "pr-slot-conflict",
        title: "PR slot conflict",
        idempotencyKey: `d3-e2-${stamp}`,
      });
      const otherLease = await plane1.claimLease({
        taskId: otherTask.task.id,
        workerId: workerB.id,
        leaseTtlSeconds: 60,
      });
      const conflict = await plane1.reservePrSlot({
        taskId: otherTask.task.id,
        fencingToken: otherLease.fencingToken,
        branchName: "task/405-pr-slot-conflict",
      });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.code, "ONE_PR_IN_FLIGHT_OCCUPIED");

      // Watchdog expiry is an alert, not permission to release.
      await pool.query(
        "UPDATE forge_pr_slots SET expires_at = clock_timestamp() - interval '1 hour' WHERE slot_id = 1"
      );
      const overdue = await plane1.getPrSlot();
      assert.equal(overdue.watchdogOverdue, true);
      assert.equal(overdue.taskId, taskB.id, "the slot is still held by its owner");

      await assert.rejects(
        () => plane1.releasePrSlot({ taskId: taskB.id, fencingToken: slotToken, prState: "open" }),
        /PR_SLOT_RELEASE_UNCONFIRMED/
      );

      const released = await plane1.releasePrSlot({
        taskId: taskB.id,
        fencingToken: slotToken,
        prState: "merged",
      });
      assert.equal(released.ok, true);
      assert.equal((await plane1.getPrSlot()).taskId, null);

      /* ---------------------------------------------------------------- Test F */
      const opKey = `d3-f-${stamp}`;
      const op = await plane1.beginExternalOp({
        idempotencyKey: opKey,
        taskId: taskB.id,
        fencingToken: slotToken,
        operationType: "github.push_branch",
        targetBranch: "task/402-concurrent-claims",
        expectedTreeSha: "b".repeat(40),
      });
      assert.equal(op.ok, true);
      assert.equal(op.op.status, "IN_FLIGHT");

      const duplicateOp = await plane1.beginExternalOp({
        idempotencyKey: opKey,
        taskId: taskB.id,
        fencingToken: slotToken,
        operationType: "github.push_branch",
        targetBranch: "task/402-concurrent-claims",
      });
      assert.equal(duplicateOp.deduplicated, true);

      // Restart with no authoritative GitHub client: the write stays IN_FLIGHT.
      const noProbe = await plane2.reconcileOnBoot({ instanceId: "d3-boot-unverified" });
      const unverifiedCodes = noProbe.decisions.map((decision) => decision.code);
      assert.ok(unverifiedCodes.includes("EXTERNAL_OP_UNVERIFIED"));
      const stillInflight = await plane2.repository.listInflightExternalOps();
      assert.equal(stillInflight.length >= 1, true, "an unverifiable write is never replayed or dropped");

      // With authoritative state present, the operation is reconciled as COMMITTED.
      const probed = await plane2.reconcileOnBoot({
        instanceId: "d3-boot-verified",
        githubProbe: async (input) =>
          input.idempotencyKey === opKey
            ? { state: "present", sha: "c".repeat(40) }
            : { state: "unverified" },
      });
      assert.ok(probed.decisions.some((decision) => decision.code === "EXTERNAL_OP_RECONCILED_COMMITTED"));

      const reconciledOp = await pool.query(
        "SELECT status, observed_sha FROM forge_external_ops WHERE idempotency_key = $1",
        [opKey]
      );
      assert.equal(reconciledOp.rows[0].status, "COMMITTED");
      assert.equal(reconciledOp.rows[0].observed_sha, "c".repeat(40));

      const lastReconciliation = await repo.lastReconciliation();
      assert.ok(lastReconciliation, "boot reconciliation is recorded durably");
      assert.equal(lastReconciliation.instanceId, "d3-boot-verified");

      /* ---------------------------------------------------------------- Test G */
      const deadPool = new pg.Pool({
        connectionString: "postgresql://stph:stph@127.0.0.1:1/stph",
        connectionTimeoutMillis: 400,
      });
      try {
        const deadPlane = new ForgeControlPlane({
          repository: new PostgresForgeRepository(deadPool),
        });
        const deadStatus = await deadPlane.getPersistenceStatus();
        assert.equal(deadStatus.durable, false);
        assert.equal(deadStatus.ready, false);
        assert.equal(deadStatus.reason, "POSTGRES_UNAVAILABLE");
        assert.equal(deadPlane.storageAdapter, "postgres");

        await assert.rejects(
          () =>
            deadPlane.enqueueTask({
              issueNumber: 406,
              slug: "unavailable",
              title: "Unavailable",
              idempotencyKey: `d3-g-${stamp}`,
            }),
          /ECONNREFUSED|connect|timeout/i,
          "an unreachable database fails loudly instead of fabricating a task"
        );
      } finally {
        await deadPool.end().catch(() => {});
      }
    } finally {
      for (const aux of auxiliaryPools) await aux.end().catch(() => {});
      await pool.end().catch(() => {});
      assert.equal(await dropDisposableDatabase(POSTGRES_URL, created.name), true);
    }
  }
);
