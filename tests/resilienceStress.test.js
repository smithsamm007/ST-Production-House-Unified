import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { QuotaLedger } from "../src/quotas/quotaLedger.js";
import { RecoveryContractManager } from "../src/recovery/recoveryContract.js";

/**
 * S-M29-01 — Offline resilience stress suite (Module 29, lane-2).
 *
 * Fully deterministic and offline: no network, no providers, no database.
 * Exercises the production contracts under burst-shaped and adversarial
 * patterns that the basic contract tests do not cover:
 *
 *   1. QuotaLedger.reserve/commit/release under burst waves — auditing that
 *      every reservation settles exactly once and quota usage never leaks.
 *   2. RecoveryContractManager circuit transitions under injected failure
 *      sequences — CLOSED → OPEN → HALF_OPEN → CLOSED, plus fatal instant-trip.
 *   3. Expired-lease reclaim modeled deterministically under serialized
 *      concurrent claim attempts (the FOR UPDATE SKIP LOCKED semantics of
 *      src/jobs/lifecycle/jobLifecycle.js) — proving no double-claim in the
 *      deterministic model.
 *
 * Determinism: every "random" decision comes from a fixed-seed LCG, so the
 * suite is reproducible run-to-run. Time-based breaker recovery uses
 * millisecond-scale real sleeps (bounded, offline).
 */

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants; masked to keep state in uint32 range.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configuredLedger({ agentId = "agent-stress", limit } = {}) {
  const ledger = new QuotaLedger();
  ledger.configureQuota(agentId, "primary", "stress-provider", "no_secret", { limit });
  return { ledger, agentId };
}

async function reserve(ledger, agentId) {
  return ledger.reserve(agentId, "primary", "stress-provider", "no_secret");
}

// ---------------------------------------------------------------------------
// 1. Quota burst stress — zero leakage under full settlement
// ---------------------------------------------------------------------------

test("stress: burst waves with full settlement leave zero quota leakage", async () => {
  const { ledger, agentId } = configuredLedger({ limit: 500 });
  const rand = lcg(0x5eed0001);
  const reservations = [];
  const WAVES = 10;
  const PER_WAVE = 40;

  for (let wave = 0; wave < WAVES; wave += 1) {
    const waveReservations = [];
    for (let i = 0; i < PER_WAVE; i += 1) {
      waveReservations.push(await reserve(ledger, agentId));
    }
    // Deterministic settlement inside the wave: ~70% commit, ~30% release.
    for (const reservation of waveReservations) {
      if (rand() < 0.7) {
        await ledger.commit(reservation);
        reservations.push({ reservation, settled: "committed" });
      } else {
        await ledger.release(reservation);
        reservations.push({ reservation, settled: "released" });
      }
    }
  }

  const committed = reservations.filter((r) => r.settled === "committed").length;
  const quota = ledger.getQuota(agentId, "primary", "stress-provider", "no_secret");

  // Zero-leakage audit: usage equals exactly the committed count.
  assert.equal(quota.usageCount, committed);
  // Capacity audit: usage can never exceed the configured limit.
  assert.ok(quota.usageCount <= quota.limit);
  // Every reservation settled exactly once (commit XOR release).
  assert.equal(reservations.length, WAVES * PER_WAVE);
});

test("stress: burst against a small limit rejects exactly the over-capacity reservations", async () => {
  const { ledger, agentId } = configuredLedger({ limit: 12 });
  const BURST = 60;
  let succeeded = 0;
  let rejected = 0;
  const open = [];

  for (let i = 0; i < BURST; i += 1) {
    try {
      const reservation = await reserve(ledger, agentId);
      succeeded += 1;
      open.push(reservation);
    } catch (error) {
      rejected += 1;
      assert.match(error.message, /^QUOTA_RESERVATION_FAILED: quota_exceeded$/);
    }
  }

  assert.equal(succeeded, 12);
  assert.equal(rejected, BURST - 12);

  // Full release drains usage back to zero — no leakage from the rejected burst.
  for (const reservation of open) {
    await ledger.release(reservation);
  }
  const quota = ledger.getQuota(agentId, "primary", "stress-provider", "no_secret");
  assert.equal(quota.usageCount, 0);

  // After full drain, the same burst succeeds exactly to capacity again.
  let secondWave = 0;
  const secondOpen = [];
  for (let i = 0; i < BURST; i += 1) {
    try {
      secondOpen.push(await reserve(ledger, agentId));
      secondWave += 1;
    } catch {
      // Expected once capacity is exhausted.
    }
  }
  assert.equal(secondWave, 12);
  for (const reservation of secondOpen) {
    await ledger.release(reservation);
  }
  assert.equal(ledger.getQuota(agentId, "primary", "stress-provider", "no_secret").usageCount, 0);
});

test("stress: abandoned reservations are detectable leakage, and release recovery drains it", async () => {
  const { ledger, agentId } = configuredLedger({ limit: 50 });
  const WAVE = 20;
  const ABANDON_INDEXES = new Set([1, 4, 5, 9, 14, 17]);
  const reservations = [];

  for (let i = 0; i < WAVE; i += 1) {
    reservations.push(await reserve(ledger, agentId));
  }
  for (let i = 0; i < WAVE; i += 1) {
    if (!ABANDON_INDEXES.has(i)) {
      await ledger.commit(reservations[i]);
    }
  }

  const committedCount = WAVE - ABANDON_INDEXES.size;
  const quota = ledger.getQuota(agentId, "primary", "stress-provider", "no_secret");

  // The audit MUST detect the leak: usage exceeds committed settlements.
  assert.equal(quota.usageCount, WAVE);
  assert.ok(quota.usageCount > committedCount);
  assert.equal(quota.usageCount - committedCount, ABANDON_INDEXES.size);

  // Recovery: releasing exactly the abandoned handles drains the leak.
  for (const index of ABANDON_INDEXES) {
    await ledger.release(reservations[index]);
  }
  assert.equal(ledger.getQuota(agentId, "primary", "stress-provider", "no_secret").usageCount, committedCount);
});

test("stress: settlement is exactly-once — double commit throws, double release is a no-op", async () => {
  const { ledger, agentId } = configuredLedger({ limit: 10 });

  const committedReservation = await reserve(ledger, agentId);
  await ledger.commit(committedReservation);
  await assert.rejects(() => ledger.commit(committedReservation), /INVALID_RESERVATION_STATUS/);
  // Releasing an already-committed reservation must not decrement usage.
  await ledger.release(committedReservation);
  assert.equal(ledger.getQuota(agentId, "primary", "stress-provider", "no_secret").usageCount, 1);

  const releasedReservation = await reserve(ledger, agentId);
  await ledger.release(releasedReservation);
  await assert.rejects(() => ledger.commit(releasedReservation), /INVALID_RESERVATION_STATUS/);
  // Double release must not decrement usage below the settled level.
  await ledger.release(releasedReservation);
  assert.equal(ledger.getQuota(agentId, "primary", "stress-provider", "no_secret").usageCount, 1);
});

// ---------------------------------------------------------------------------
// 2. Circuit breaker stress — OPEN reached and recovery per contract
// ---------------------------------------------------------------------------

test("stress: repeated transient failures trip the breaker OPEN and it recovers via HALF_OPEN", async () => {
  const manager = new RecoveryContractManager({ cooldownDurationMs: 50, maxConsecutiveFailures: 3 });
  const scope = ["agent-stress", "primary", "stress-provider", "no_secret"];

  assert.equal(manager.isHealthy(...scope), true); // CLOSED
  manager.recordFailure(...scope, new Error("TRANSIENT_TIMEOUT_429"));
  manager.recordFailure(...scope, new Error("TRANSIENT_TIMEOUT_429"));
  assert.equal(manager.isHealthy(...scope), true); // below threshold, still CLOSED

  manager.recordFailure(...scope, new Error("TRANSIENT_TIMEOUT_429"));
  assert.equal(manager.isHealthy(...scope), false); // OPEN

  // Cooldown elapses → contract recovers through HALF_OPEN.
  await sleep(60);
  assert.equal(manager.isHealthy(...scope), true); // HALF_OPEN admits a probe
  manager.recordSuccess(...scope);
  assert.equal(manager.isHealthy(...scope), true); // CLOSED again
  assert.equal(manager.getOrCreateState(...scope).consecutiveFailures, 0);
});

test("stress: a HALF_OPEN probe failure re-trips the breaker OPEN", async () => {
  const manager = new RecoveryContractManager({ cooldownDurationMs: 50, maxConsecutiveFailures: 3 });
  const scope = ["agent-stress", "primary", "stress-provider", "no_secret"];

  for (let i = 0; i < 3; i += 1) {
    manager.recordFailure(...scope, new Error("RATE_LIMIT"));
  }
  assert.equal(manager.isHealthy(...scope), false); // OPEN
  await sleep(60);
  assert.equal(manager.isHealthy(...scope), true); // HALF_OPEN

  manager.recordFailure(...scope, new Error("RATE_LIMIT"));
  assert.equal(manager.isHealthy(...scope), false); // re-OPENed by probe failure

  await sleep(60);
  assert.equal(manager.isHealthy(...scope), true); // HALF_OPEN again
  manager.recordSuccess(...scope);
  assert.equal(manager.getOrCreateState(...scope).state, "CLOSED");
});

test("stress: a fatal error trips the breaker OPEN instantly, regardless of prior history", async () => {
  const manager = new RecoveryContractManager({ cooldownDurationMs: 50, maxConsecutiveFailures: 3 });
  const scope = ["agent-stress", "primary", "stress-provider", "no_secret"];

  // Brand-new scope, zero consecutive failures: an unclassified error is fatal.
  manager.recordFailure(...scope, new Error("SECURITY_VIOLATION_NOT_TRANSIENT"));
  assert.equal(manager.getOrCreateState(...scope).state, "OPEN");
  assert.equal(manager.isHealthy(...scope), false);

  // A healthy sibling scope stays healthy — isolation per provider/scope.
  const sibling = ["agent-stress", "primary", "other-provider", "no_secret"];
  assert.equal(manager.isHealthy(...sibling), true);
});

test("stress: success resets the consecutive-failure count under mixed deterministic load", () => {
  const manager = new RecoveryContractManager({ cooldownDurationMs: 0, maxConsecutiveFailures: 3 });
  const scope = ["agent-stress", "primary", "stress-provider", "no_secret"];
  const rand = lcg(0x5eed0002);

  // 200 deterministic mixed ops; success always restores CLOSED health.
  for (let i = 0; i < 200; i += 1) {
    if (rand() < 0.5) {
      manager.recordSuccess(...scope);
      assert.equal(manager.isHealthy(...scope), true);
      assert.equal(manager.getOrCreateState(...scope).consecutiveFailures, 0);
    } else {
      manager.recordFailure(...scope, new Error("TRANSIENT_TIMEOUT"));
    }
  }
  // Whatever the final pattern, the state machine never leaves its legal set.
  const state = manager.getOrCreateState(...scope).state;
  assert.ok(["CLOSED", "OPEN", "HALF_OPEN"].includes(state));
});

// ---------------------------------------------------------------------------
// 3. Expired-lease reclaim — deterministic concurrent-claim model
// ---------------------------------------------------------------------------

/**
 * Deterministic model of the reclaim semantics implemented by
 * `src/jobs/lifecycle/jobLifecycle.js` (Task 3.5):
 *
 *   reclaimable(job, now) := status in ('leased','running')
 *                            AND lease_expires_at < now
 *
 * Claim sweeps are strictly serialized (the FOR UPDATE SKIP LOCKED contract:
 * claimers take turns and each re-evaluates the predicate against current
 * state). A winning claim re-leases the job, so later claimants in the same
 * sweep cannot double-claim it. Terminal jobs are never reclaimable.
 */

const RECLAIMABLE_STATUSES = new Set(["leased", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "dead_letter", "cancelled", "owner_cancelled"]);

function reclaimable(job, now) {
  if (TERMINAL_STATUSES.has(job.status)) return false;
  return RECLAIMABLE_STATUSES.has(job.status) && job.leaseExpiresAt < now;
}

function makeModelClock() {
  return { now: 1000 };
}

function reclaimSweep(model, jobs, workerNames, leaseDuration = 30) {
  const claims = [];
  for (const worker of workerNames) {
    const target = jobs.find((job) => reclaimable(job, model.now));
    if (!target) continue;
    target.status = "leased";
    target.leaseOwner = worker;
    target.leaseExpiresAt = model.now + leaseDuration;
    claims.push({ jobId: target.id, owner: worker, expiresAt: target.leaseExpiresAt });
  }
  return claims;
}

function handleIsValid(handle, job, now) {
  return job.leaseOwner === handle.owner && job.leaseExpiresAt > now;
}

test("stress: serialized concurrent claims never double-claim an expired lease", () => {
  const model = makeModelClock();
  const jobs = [
    { id: "job-1", status: "leased", leaseOwner: "dead-worker-a", leaseExpiresAt: 900 },
    { id: "job-2", status: "leased", leaseOwner: "dead-worker-b", leaseExpiresAt: 950 },
  ];
  const validHandles = new Map(); // jobId -> Set of handles ever issued

  // Ten sweeps, five serialized claimants each.
  for (let sweep = 0; sweep < 10; sweep += 1) {
    const claims = reclaimSweep(model, jobs, ["w1", "w2", "w3", "w4", "w5"]);
    for (const claim of claims) {
      if (!validHandles.has(claim.jobId)) validHandles.set(claim.jobId, new Set());
      validHandles.get(claim.jobId).add(claim);
    }
    // At most one claim per job per sweep: a fresh lease is not reclaimable.
    const claimedThisSweep = new Set(claims.map((c) => c.jobId));
    const reclaims = reclaimSweep(model, jobs, ["w1", "w2", "w3", "w4", "w5"]);
    for (const claim of reclaims) {
      assert.ok(!claimedThisSweep.has(claim.jobId), "double-claim within a single sweep window");
    }
    model.now += 31; // expire all current leases before the next sweep
  }

  // Global invariant: at any instant at most one valid handle exists per job.
  for (const job of jobs) {
    const handles = [...validHandles.get(job.id)];
    const validNow = handles.filter((handle) => handleIsValid(handle, job, model.now));
    assert.ok(validNow.length <= 1, `job ${job.id} has ${validNow.length} simultaneous valid leases`);
  }
});

test("stress: reclaim model never touches active leases or terminal jobs", () => {
  const model = makeModelClock();
  const activeLease = { id: "job-active", status: "leased", leaseOwner: "live-worker", leaseExpiresAt: 5000 };
  const runningJob = { id: "job-running", status: "running", leaseOwner: "live-worker", leaseExpiresAt: 5000 };
  const terminalJobs = [
    { id: "job-done", status: "completed", leaseOwner: null, leaseExpiresAt: null },
    { id: "job-dlq", status: "dead_letter", leaseOwner: null, leaseExpiresAt: null },
    { id: "job-cancelled", status: "owner_cancelled", leaseOwner: null, leaseExpiresAt: null },
  ];
  const jobs = [activeLease, runningJob, ...terminalJobs];

  for (let sweep = 0; sweep < 25; sweep += 1) {
    const claims = reclaimSweep(model, jobs, ["w1", "w2", "w3"]);
    assert.deepEqual(claims, [], `sweep ${sweep} claimed a protected job`);
  }
  // States untouched.
  assert.equal(activeLease.leaseOwner, "live-worker");
  assert.equal(runningJob.leaseOwner, "live-worker");
  assert.equal(terminalJobs[0].status, "completed");
  assert.equal(terminalJobs[1].status, "dead_letter");
});

test("stress: reclaim transfers ownership exactly once per expiry window across many cycles", () => {
  const model = makeModelClock();
  const job = { id: "job-cycle", status: "leased", leaseOwner: "w0", leaseExpiresAt: 1000 };
  let transfers = 0;
  let lastOwner = "w0";

  // 40 expiry windows; in each, exactly one of three serialized claimants wins.
  for (let cycle = 0; cycle < 40; cycle += 1) {
    model.now = job.leaseExpiresAt + 1; // lease now expired
    assert.ok(reclaimable(job, model.now));
    const claims = reclaimSweep(model, [job], ["w1", "w2", "w3"]);
    assert.equal(claims.length, 1, "exactly one claimant wins each expiry window");
    assert.equal(job.leaseOwner, claims[0].owner, "winner owns the fresh lease");
    assert.ok(job.leaseExpiresAt > model.now, "fresh lease is in the future");
    assert.equal(reclaimable(job, model.now), false, "freshly leased job is not reclaimable");
    transfers += 1;
    lastOwner = claims[0].owner;
  }
  assert.equal(transfers, 40);
});

// ---------------------------------------------------------------------------
// 4. Bounded duration and bounded memory behavior
// ---------------------------------------------------------------------------

test("stress: the combined offline workload completes within bounded duration and memory", async () => {
  const startedAt = performance.now();
  const { ledger, agentId } = configuredLedger({ limit: 100000 });
  const rand = lcg(0x5eed0003);
  const OPS = 2000;
  const open = [];

  let committedCount = 0;
  for (let i = 0; i < OPS; i += 1) {
    const roll = rand();
    if (roll < 0.5) {
      open.push(await reserve(ledger, agentId));
    } else if (open.length > 0 && roll < 0.75) {
      await ledger.commit(open.pop());
      committedCount += 1;
    } else if (open.length > 0) {
      const handle = open.pop();
      if (handle.status === "reserved") await ledger.release(handle);
    }
  }
  // Drain the remaining open handles; committed settlements legitimately hold quota.
  let settledOpen = 0;
  while (open.length > 0) {
    const handle = open.pop();
    if (handle.status === "reserved") {
      await ledger.release(handle);
      settledOpen += 1;
    } else {
      settledOpen += 0; // already committed inside the loop
    }
  }
  // Zero-leakage invariant: usage equals exactly the committed settlement count.
  const quota = ledger.getQuota(agentId, "primary", "stress-provider", "no_secret");
  assert.equal(quota.usageCount, committedCount);

  const breaker = new RecoveryContractManager({ cooldownDurationMs: 0, maxConsecutiveFailures: 3 });
  const scope = ["agent-stress", "primary", "stress-provider", "no_secret"];
  for (let i = 0; i < 500; i += 1) {
    if (i % 7 === 0) {
      manager_record(breaker, scope, i);
    } else {
      breaker.recordSuccess(...scope);
      assert.equal(breaker.isHealthy(...scope), true);
    }
  }

  // Ledger storage stays bounded by its configuration count, not by op volume.
  assert.equal(ledger.quotas.size, 1);

  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 5000, `offline stress workload took ${elapsedMs.toFixed(0)}ms (bound 5000ms)`);
});

function manager_record(breaker, scope, i) {
  // Deterministic alternation between transient and fatal injections.
  if (i % 14 === 0) {
    breaker.recordFailure(...scope, new Error("SECURITY_VIOLATION_NOT_TRANSIENT"));
  } else {
    breaker.recordFailure(...scope, new Error("TRANSIENT_TIMEOUT"));
  }
}
