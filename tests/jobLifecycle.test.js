import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { MigrationRunner } from "../src/db/index.js";
import { createPostgresAdapter } from "../src/db/index.js";
import {
  createJob,
  claimJob,
  renewLease,
  startJob,
  completeJob,
  failJob,
  reclaimExpiredLeases,
} from "../src/jobs/lifecycle/jobLifecycle.js";

// ==========================================
// 1. In-Memory Mock Database for Unit Tests
// ==========================================
class MockDatabase {
  constructor() {
    this.agents = [
      { id: "agent-01", name: "JARVIS", concurrency_limit: 2 },
      { id: "agent-03", name: "LAKME", concurrency_limit: 1 },
    ];
    this.jobs = [];
    this.queries = [];
  }

  async query(text, params = []) {
    this.queries.push({ text, params });
    const normalized = text.trim().replace(/\s+/g, " ");

    // Custom Mock Helper to simulate expired lease (check this first!)
    if (normalized.startsWith("UPDATE jobs SET lease_expires_at = now() -")) {
      const [id] = params;
      const job = this.jobs.find((j) => j.id === id);
      if (job) {
        job.lease_expires_at = new Date(Date.now() - 5000).toISOString();
      }
      return { rowCount: 1, rows: [] };
    }

    // INSERT INTO jobs
    if (normalized.startsWith("INSERT INTO jobs")) {
      const [id, agentId, capability, idempotencyKey, priority, maxAttempts, payloadStr] = params;
      const payload = JSON.parse(payloadStr);

      const existing = this.jobs.find((j) => j.idempotency_key === idempotencyKey);
      if (existing) {
        return { rowCount: 0, rows: [] };
      }

      const newJob = {
        id,
        agent_id: agentId,
        capability,
        idempotency_key: idempotencyKey,
        status: "queued",
        priority: priority || 100,
        attempts: 0,
        max_attempts: maxAttempts || 3,
        lease_owner: null,
        lease_expires_at: null,
        payload,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.jobs.push(newJob);
      return { rowCount: 1, rows: [newJob] };
    }

    // SELECT * FROM jobs WHERE idempotency_key
    if (normalized.startsWith("SELECT * FROM jobs WHERE idempotency_key = $1")) {
      const [key] = params;
      const match = this.jobs.find((j) => j.idempotency_key === key);
      return { rowCount: match ? 1 : 0, rows: match ? [match] : [] };
    }

    // SELECT concurrency_limit FROM agents
    if (normalized.startsWith("SELECT concurrency_limit FROM agents WHERE id = $1")) {
      const [agentId] = params;
      const agent = this.agents.find((a) => a.id === agentId);
      return { rowCount: agent ? 1 : 0, rows: agent ? [agent] : [] };
    }

    // SELECT count(*)::integer AS active_count FROM jobs
    if (normalized.includes("SELECT count(*)::integer AS active_count FROM jobs")) {
      const [agentId] = params;
      const activeJobs = this.jobs.filter((j) => {
        if (j.agent_id !== agentId) return false;
        if (!["leased", "running"].includes(j.status)) return false;
        if (!j.lease_expires_at) return true;
        return new Date(j.lease_expires_at) >= new Date();
      });
      return { rowCount: 1, rows: [{ active_count: activeJobs.length }] };
    }

    // SELECT id FROM jobs (next claimable job)
    if (normalized.includes("SELECT id FROM jobs") && normalized.includes("status = 'queued'")) {
      const [agentId, capability] = params;
      // Filter out those with attempts >= max_attempts
      const queuedJobs = this.jobs
        .filter((j) => j.agent_id === agentId && j.capability === capability && j.status === "queued" && j.attempts < j.max_attempts)
        .sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return new Date(a.created_at) - new Date(b.created_at);
        });

      if (queuedJobs.length === 0) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [{ id: queuedJobs[0].id }] };
    }

    // UPDATE jobs SET status = 'leased'
    if (normalized.startsWith("UPDATE jobs SET status = 'leased'")) {
      const [id, leaseOwner, durationSeconds] = params;
      const job = this.jobs.find((j) => j.id === id);
      if (job) {
        job.status = "leased";
        job.lease_owner = leaseOwner;
        job.lease_expires_at = new Date(Date.now() + durationSeconds * 1000).toISOString();
        job.attempts += 1;
        job.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [job] };
      }
      return { rowCount: 0, rows: [] };
    }

    // UPDATE jobs SET lease_expires_at
    if (normalized.startsWith("UPDATE jobs SET lease_expires_at")) {
      const [id, leaseOwner, durationSeconds] = params;
      const job = this.jobs.find(
        (j) => j.id === id && j.lease_owner === leaseOwner && ["leased", "running"].includes(j.status)
      );
      if (job) {
        // Mock checking already expired lease
        if (job.lease_expires_at && new Date(job.lease_expires_at) < new Date()) {
          return { rowCount: 0, rows: [] }; // Simulation of already expired lease rejection
        }
        job.lease_expires_at = new Date(Date.now() + durationSeconds * 1000).toISOString();
        job.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [job] };
      }
      return { rowCount: 0, rows: [] };
    }

    // UPDATE jobs SET status = 'running'
    if (normalized.startsWith("UPDATE jobs SET status = 'running'")) {
      const [id, leaseOwner] = params;
      const job = this.jobs.find((j) => j.id === id && j.lease_owner === leaseOwner && j.status === "leased");
      if (job) {
        job.status = "running";
        job.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [job] };
      }
      return { rowCount: 0, rows: [] };
    }

    // UPDATE jobs SET status = 'succeeded'
    if (normalized.startsWith("UPDATE jobs SET status = 'succeeded'")) {
      const [id, leaseOwner, resultStr] = params;
      const job = this.jobs.find(
        (j) => j.id === id && j.lease_owner === leaseOwner && j.status === "running"
      );
      if (job) {
        job.status = "succeeded";
        job.payload.result = JSON.parse(resultStr);
        job.lease_owner = null;
        job.lease_expires_at = null;
        job.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [job] };
      }
      return { rowCount: 0, rows: [] };
    }

    // SELECT attempts, max_attempts FROM jobs FOR UPDATE (or job details select)
    if (normalized.includes("FROM jobs WHERE id = $1") && normalized.includes("lease_owner = $2")) {
      const [id, leaseOwner] = params;
      const job = this.jobs.find(
        (j) => j.id === id && j.lease_owner === leaseOwner && ["leased", "running"].includes(j.status)
      );
      if (job) {
        return {
          rowCount: 1,
          rows: [{
            agent_id: job.agent_id,
            capability: job.capability,
            attempts: job.attempts,
            max_attempts: job.max_attempts,
            payload: job.payload,
            backoff_metadata: job.backoff_metadata || {}
          }]
        };
      }
      return { rowCount: 0, rows: [] };
    }

    // SELECT event_hash FROM evidence_events
    if (normalized.includes("FROM evidence_events")) {
      return { rowCount: 0, rows: [] };
    }

    // INSERT INTO evidence_events
    if (normalized.startsWith("INSERT INTO evidence_events")) {
      return { rowCount: 1, rows: [] };
    }

    // UPDATE jobs SET status = 'failed'
    if (normalized.startsWith("UPDATE jobs SET status = 'failed'")) {
      const [id, leaseOwner, errorStr] = params;
      const job = this.jobs.find(
        (j) => j.id === id && j.lease_owner === leaseOwner && ["leased", "running"].includes(j.status)
      );
      if (job) {
        job.status = "failed";
        job.payload.error = JSON.parse(errorStr);
        job.lease_owner = null;
        job.lease_expires_at = null;
        job.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [job] };
      }
      return { rowCount: 0, rows: [] };
    }

    // UPDATE jobs SET status = 'dead_letter'
    if (normalized.startsWith("UPDATE jobs SET status = 'dead_letter'")) {
      const [id] = params;
      const job = this.jobs.find((j) => j.id === id);
      if (job) {
        job.status = "dead_letter";
        job.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [job] };
      }
      return { rowCount: 0, rows: [] };
    }

    // UPDATE jobs SET status = 'queued'
    if (normalized.startsWith("UPDATE jobs SET status = 'queued'")) {
      const [id] = params;
      const job = this.jobs.find((j) => j.id === id);
      if (job) {
        job.status = "queued";
        job.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [job] };
      }
      return { rowCount: 0, rows: [] };
    }

    // SELECT id, lease_owner, attempts, max_attempts FROM jobs WHERE status IN ('leased', 'running') AND lease_expires_at < now()
    if (normalized.includes("lease_expires_at < now()")) {
      const expired = this.jobs.filter((j) => {
        if (!["leased", "running"].includes(j.status)) return false;
        return j.lease_expires_at && new Date(j.lease_expires_at) < new Date();
      });
      return {
        rowCount: expired.length,
        rows: expired.map((j) => ({
          id: j.id,
          lease_owner: j.lease_owner,
          attempts: j.attempts,
          max_attempts: j.max_attempts,
        })),
      };
    }

    return { rowCount: 0, rows: [] };
  }
}

// ==========================================
// 2. Main Unit Test Suite
// ==========================================
test("Job Lifecycle Contract — Mock/Unit Suite", async (t) => {
  const db = new MockDatabase();

  await t.test("idempotent job creation returns same job on duplicate key", async () => {
    const payload = { videoId: "v-1" };
    const job1 = await createJob(db, {
      agentId: "agent-01",
      capability: "render-reel",
      idempotencyKey: "idemp-001",
      payload,
    });

    assert.ok(job1.id);
    assert.equal(job1.status, "queued");
    assert.deepEqual(job1.payload, payload);

    // Re-create identical job with same key
    const job2 = await createJob(db, {
      agentId: "agent-01",
      capability: "render-reel",
      idempotencyKey: "idemp-001",
      payload: { differentPayload: true },
    });

    // Should return original job with original payload
    assert.equal(job2.id, job1.id);
    assert.deepEqual(job2.payload, payload);
  });

  await t.test("concurrency limit prevents exceeding maximum parallel jobs per agent", async () => {
    db.jobs = [];

    // Create 3 queued jobs
    await createJob(db, { agentId: "agent-01", capability: "render", idempotencyKey: "k-1", payload: {} });
    await createJob(db, { agentId: "agent-01", capability: "render", idempotencyKey: "k-2", payload: {} });
    await createJob(db, { agentId: "agent-01", capability: "render", idempotencyKey: "k-3", payload: {} });

    // Claim 1st
    const c1 = await claimJob(db, { agentId: "agent-01", capability: "render", leaseOwner: "w-1", leaseDurationSeconds: 10 });
    assert.ok(c1);
    assert.equal(c1.status, "leased");
    assert.equal(c1.leaseOwner, "w-1");

    // Claim 2nd
    const c2 = await claimJob(db, { agentId: "agent-01", capability: "render", leaseOwner: "w-2", leaseDurationSeconds: 10 });
    assert.ok(c2);

    // Claim 3rd — should block and return null because concurrency limit of 2 is reached
    const c3 = await claimJob(db, { agentId: "agent-01", capability: "render", leaseOwner: "w-3", leaseDurationSeconds: 10 });
    assert.equal(c3, null);

    // Transition 1st to running and complete it
    await startJob(db, { jobId: c1.id, leaseOwner: "w-1" });
    await completeJob(db, { jobId: c1.id, leaseOwner: "w-1", resultPayload: { ok: true } });

    // Claim 3rd again — should succeed now that active count is 1
    const c3Retry = await claimJob(db, { agentId: "agent-01", capability: "render", leaseOwner: "w-3", leaseDurationSeconds: 10 });
    assert.ok(c3Retry);
    assert.equal(c3Retry.idempotencyKey, "k-3");
  });

  await t.test("lease renewal extends expiry correctly", async () => {
    db.jobs = [];
    const job = await createJob(db, { agentId: "agent-01", capability: "render", idempotencyKey: "renew-k", payload: {} });
    const claimed = await claimJob(db, { agentId: "agent-01", capability: "render", leaseOwner: "w-1", leaseDurationSeconds: 5 });

    const prevExpiry = new Date(claimed.leaseExpiresAt);

    // Renew lease for 30s
    const renewed = await renewLease(db, { jobId: claimed.id, leaseOwner: "w-1", leaseDurationSeconds: 30 });
    const newExpiry = new Date(renewed.leaseExpiresAt);

    assert.ok(newExpiry > prevExpiry);
  });

  await t.test("renewLease rejects already-expired leases", async () => {
    db.jobs = [];
    const job = await createJob(db, { agentId: "agent-01", capability: "render", idempotencyKey: "renew-exp-k", payload: {} });
    const claimed = await claimJob(db, { agentId: "agent-01", capability: "render", leaseOwner: "w-1", leaseDurationSeconds: 5 });

    // Force expiration in mock using the specific matcher
    await db.query("UPDATE jobs SET lease_expires_at = now() - 5000 WHERE id = $1;", [claimed.id]);

    // Attempt renew should throw since the lease has already expired
    await assert.rejects(
      async () => {
        await renewLease(db, { jobId: claimed.id, leaseOwner: "w-1", leaseDurationSeconds: 30 });
      },
      /LEASE_NOT_FOUND_OR_EXPIRED_OR_OWNER_MISMATCH/
    );
  });

  await t.test("retry limits and dead-letter state transitions", async () => {
    db.jobs = [];
    const job = await createJob(db, {
      agentId: "agent-03", // limit = 1
      capability: "post",
      idempotencyKey: "retry-k",
      payload: {},
      maxAttempts: 2,
    });

    // Try 1
    const c1 = await claimJob(db, { agentId: "agent-03", capability: "post", leaseOwner: "worker", leaseDurationSeconds: 5 });
    assert.equal(c1.attempts, 1);

    // Fail job -> status transitions back to queued because attempts (1) < max_attempts (2)
    const failed1 = await failJob(db, { jobId: c1.id, leaseOwner: "worker", errorPayload: { err: "first error TIMEOUT" } });
    assert.equal(failed1.status, "queued");

    // Try 2
    const c2 = await claimJob(db, { agentId: "agent-03", capability: "post", leaseOwner: "worker", leaseDurationSeconds: 5 });
    assert.equal(c2.attempts, 2);

    // Fail job -> status transitions to dead_letter because attempts (2) >= max_attempts (2)
    const failed2 = await failJob(db, { jobId: c2.id, leaseOwner: "worker", errorPayload: { err: "terminal error TIMEOUT" } });
    assert.equal(failed2.status, "dead_letter");
    assert.equal(failed2.leaseOwner, null);
  });

  await t.test("reclaimExpiredLeases handles timed out leases", async () => {
    db.jobs = [];
    const job = await createJob(db, { agentId: "agent-01", capability: "render", idempotencyKey: "expire-k", payload: {}, maxAttempts: 1 });
    const claimed = await claimJob(db, { agentId: "agent-01", capability: "render", leaseOwner: "w-timeout", leaseDurationSeconds: 5 });

    // Force expiration in mock using the specific matcher
    await db.query("UPDATE jobs SET lease_expires_at = now() - 5000 WHERE id = $1;", [claimed.id]);

    const reclaimed = await reclaimExpiredLeases(db);
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].status, "dead_letter"); // maxAttempts is 1, so it goes to dead_letter directly
  });
});

// ==========================================
// 3. PostgreSQL 15 Live Integration Suite
// ==========================================
test("Job Lifecycle Contract — Live PG Suite", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const isCI = !!process.env.CI;
  const isIntegrationCmd = process.env.npm_lifecycle_event === 'test:integration';
  const expectPG = isCI || isIntegrationCmd || !!dbUrl;

  if (!dbUrl) {
    if (expectPG) {
      assert.fail("PostgreSQL 15 instance is mandatory in CI/integration test environment but database URL is not set.");
    } else {
      t.diagnostic("Live PostgreSQL 15+ is not configured; skipping integration tests.");
      return;
    }
  }

  const adapter = createPostgresAdapter({ connectionString: dbUrl });

  try {
    const runner = new MigrationRunner(adapter);
    await runner.runMigrations();

    // Verification of Item 7.1: Migration Rerun (running twice is fully idempotent)
    await t.test("migration 010 rerun is fully idempotent", async () => {
      const res = await runner.runMigrations();
      assert.equal(res.appliedCount, 0); // zero newly applied migrations
    });

    await t.test("idempotent job creation in real PG", async () => {
      const unique = Date.now();
      const agentId = `agent-life-test-idemp-${unique}`;

      // Register unique agent
      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `LIFECYCLE_IDEMP_AGENT_${unique}`, `st.agent.lifecycle.idemp.${unique}`]
      );

      try {
        const key = `pg-idemp-${unique}`;
        const payload = { target: "episode_5" };

        const j1 = await createJob(adapter, {
          agentId,
          capability: "assemble",
          idempotencyKey: key,
          payload,
        });

        assert.ok(j1.id);
        assert.equal(j1.status, "queued");

        const j2 = await createJob(adapter, {
          agentId,
          capability: "assemble",
          idempotencyKey: key,
          payload: { changed: true },
        });

        assert.equal(j2.id, j1.id);
        assert.deepEqual(j2.payload.target, "episode_5"); // original payload is retained
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    await t.test("respects concurrency limits and concurrent claims on real PostgreSQL", async () => {
      const unique = Date.now();
      const agentId = `agent-life-test-concur-${unique}`;
      const cap = "assemble";

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `LIFECYCLE_CONCUR_AGENT_${unique}`, `st.agent.lifecycle.concur.${unique}`]
      );

      try {
        // Create 3 jobs
        await createJob(adapter, { agentId, capability: cap, idempotencyKey: `c-key-1-${unique}`, payload: {} });
        await createJob(adapter, { agentId, capability: cap, idempotencyKey: `c-key-2-${unique}`, payload: {} });
        await createJob(adapter, { agentId, capability: cap, idempotencyKey: `c-key-3-${unique}`, payload: {} });

        // Claim first job
        const c1 = await claimJob(adapter, { agentId, capability: cap, leaseOwner: `w1-${unique}`, leaseDurationSeconds: 15 });
        assert.ok(c1);
        assert.equal(c1.status, "leased");

        // Claim second job
        const c2 = await claimJob(adapter, { agentId, capability: cap, leaseOwner: `w2-${unique}`, leaseDurationSeconds: 15 });
        assert.ok(c2);

        // Try to claim third job — must return null (concurrency limit of 2 reached)
        const c3 = await claimJob(adapter, { agentId, capability: cap, leaseOwner: `w3-${unique}`, leaseDurationSeconds: 15 });
        assert.equal(c3, null);

        // Transition to running & complete first job
        await startJob(adapter, { jobId: c1.id, leaseOwner: `w1-${unique}` });
        await completeJob(adapter, { jobId: c1.id, leaseOwner: `w1-${unique}`, resultPayload: { file: "output.mp4" } });

        // Claim third job again — should succeed now that one active slot has opened up
        const c3Retry = await claimJob(adapter, { agentId, capability: cap, leaseOwner: `w3-${unique}`, leaseDurationSeconds: 15 });
        assert.ok(c3Retry);
        assert.equal(c3Retry.idempotencyKey, `c-key-3-${unique}`);

        // Clean up tests
        await startJob(adapter, { jobId: c2.id, leaseOwner: `w2-${unique}` });
        await completeJob(adapter, { jobId: c2.id, leaseOwner: `w2-${unique}`, resultPayload: {} });
        await startJob(adapter, { jobId: c3Retry.id, leaseOwner: `w3-${unique}` });
        await completeJob(adapter, { jobId: c3Retry.id, leaseOwner: `w3-${unique}`, resultPayload: {} });
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    await t.test("genuinely simultaneous Promise.all concurrent-claim on real PostgreSQL", async () => {
      const unique = Date.now();
      const agentId = `agent-life-test-simul-${unique}`;
      const cap = "simul-assemble";

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 1);`,
        [agentId, `LIFECYCLE_SIMUL_AGENT_${unique}`, `st.agent.lifecycle.simul.${unique}`]
      );

      try {
        // Create 3 queued jobs
        await createJob(adapter, { agentId, capability: cap, idempotencyKey: `simul-key-1-${unique}`, payload: {} });
        await createJob(adapter, { agentId, capability: cap, idempotencyKey: `simul-key-2-${unique}`, payload: {} });
        await createJob(adapter, { agentId, capability: cap, idempotencyKey: `simul-key-3-${unique}`, payload: {} });

        // Genuinely simultaneous claims
        const claims = await Promise.all([
          claimJob(adapter, { agentId, capability: cap, leaseOwner: `w1-${unique}`, leaseDurationSeconds: 15 }),
          claimJob(adapter, { agentId, capability: cap, leaseOwner: `w2-${unique}`, leaseDurationSeconds: 15 }),
          claimJob(adapter, { agentId, capability: cap, leaseOwner: `w3-${unique}`, leaseDurationSeconds: 15 }),
        ]);

        // Exactly 1 claim should have succeeded, and the other 2 must be null (due to concurrency limit of 1 and FOR UPDATE locking)
        const successfulClaims = claims.filter(c => c !== null);
        assert.equal(successfulClaims.length, 1);

        // Clean up
        const successful = successfulClaims[0];
        await startJob(adapter, { jobId: successful.id, leaseOwner: successful.leaseOwner });
        await completeJob(adapter, { jobId: successful.id, leaseOwner: successful.leaseOwner, resultPayload: {} });
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    await t.test("strict database-level job status transitions trigger verification", async () => {
      const unique = Date.now();
      const agentId = `agent-life-test-trans-${unique}`;

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `LIFECYCLE_TRANS_AGENT_${unique}`, `st.agent.lifecycle.trans.${unique}`]
      );

      try {
        const j = await createJob(adapter, {
          agentId,
          capability: "trigger-test",
          idempotencyKey: `trg-${unique}`,
          payload: {},
        });

        // Try transition from queued directly to running (illegal)
        await assert.rejects(
          async () => {
            await adapter.query("UPDATE jobs SET status = 'running' WHERE id = $1;", [j.id]);
          },
          /Invalid transition from queued to running/
        );

        // Transition queued -> leased (legal)
        const claimed = await claimJob(adapter, {
          agentId,
          capability: "trigger-test",
          leaseOwner: `owner-${unique}`,
          leaseDurationSeconds: 10,
        });
        assert.ok(claimed);

        // Try transition from leased directly to succeeded (illegal - must be started/running first)
        await assert.rejects(
          async () => {
            await adapter.query("UPDATE jobs SET status = 'succeeded' WHERE id = $1;", [j.id]);
          },
          /Invalid transition from leased to succeeded/
        );

        // Transition leased -> running (legal)
        await startJob(adapter, { jobId: j.id, leaseOwner: `owner-${unique}` });

        // Transition running -> succeeded (legal)
        await completeJob(adapter, { jobId: j.id, leaseOwner: `owner-${unique}`, resultPayload: {} });

        // Try transition succeeded -> queued (illegal)
        await assert.rejects(
          async () => {
            await adapter.query("UPDATE jobs SET status = 'queued' WHERE id = $1;", [j.id]);
          },
          /Cannot transition from terminal status succeeded to queued/
        );
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    await t.test("retry limits and dead-lettering in real PG", async () => {
      const unique = Date.now();
      const agentId = `agent-life-test-retry-${unique}`;

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `LIFECYCLE_RETRY_AGENT_${unique}`, `st.agent.lifecycle.retry.${unique}`]
      );

      try {
        const j = await createJob(adapter, {
          agentId,
          capability: "retry-limit-test",
          idempotencyKey: `retry-limit-${unique}`,
          payload: {},
          maxAttempts: 2,
        });

        // Claim & Fail 1
        const c1 = await claimJob(adapter, { agentId, capability: "retry-limit-test", leaseOwner: `worker-${unique}`, leaseDurationSeconds: 10 });
        assert.equal(c1.attempts, 1);
        const f1 = await failJob(adapter, { jobId: j.id, leaseOwner: `worker-${unique}`, errorPayload: { err: "first TIMEOUT" } });
        assert.equal(f1.status, "queued");

        // Claim & Fail 2
        const c2 = await claimJob(adapter, { agentId: "agent-life-test-retry-" + unique, capability: "retry-limit-test", leaseOwner: `worker-${unique}`, leaseDurationSeconds: 10 });
        assert.equal(c2.attempts, 2);
        const f2 = await failJob(adapter, { jobId: j.id, leaseOwner: `worker-${unique}`, errorPayload: { err: "second TIMEOUT" } });
        assert.equal(f2.status, "dead_letter");

        // Attempt to claim a dead_letter job (attempts >= max_attempts) should yield null
        const c3 = await claimJob(adapter, { agentId, capability: "retry-limit-test", leaseOwner: `worker-${unique}`, leaseDurationSeconds: 10 });
        assert.equal(c3, null);
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    await t.test("renewLease rejects already-expired leases in real PG", async () => {
      const unique = Date.now();
      const agentId = `agent-life-test-renew-exp-${unique}`;

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `LIFECYCLE_RENEW_EXP_AGENT_${unique}`, `st.agent.lifecycle.renew.exp.${unique}`]
      );

      try {
        const j = await createJob(adapter, {
          agentId,
          capability: "renew-exp-test",
          idempotencyKey: `renew-exp-${unique}`,
          payload: {},
        });

        const claimed = await claimJob(adapter, {
          agentId,
          capability: "renew-exp-test",
          leaseOwner: `owner-${unique}`,
          leaseDurationSeconds: 10,
        });

        // Explicitly force expiration in real PG database
        await adapter.query(
          "UPDATE jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1;",
          [j.id]
        );

        // Attempting to renew an already-expired lease should fail/throw in SQL
        await assert.rejects(
          async () => {
            await renewLease(adapter, {
              jobId: j.id,
              leaseOwner: `owner-${unique}`,
              leaseDurationSeconds: 10,
            });
          },
          /LEASE_NOT_FOUND_OR_EXPIRED_OR_OWNER_MISMATCH/
        );
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    await t.test("reclaims expired leases in real PG", async () => {
      const unique = Date.now();
      const agentId = `agent-life-test-reclaim-${unique}`;

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `LIFECYCLE_RECLAIM_AGENT_${unique}`, `st.agent.lifecycle.reclaim.${unique}`]
      );

      try {
        const j = await createJob(adapter, {
          agentId,
          capability: "expire-test",
          idempotencyKey: `exp-${unique}`,
          payload: {},
          maxAttempts: 2,
        });

        // Claim job with valid lease duration
        const c1 = await claimJob(adapter, {
          agentId,
          capability: "expire-test",
          leaseOwner: `exp-owner-${unique}`,
          leaseDurationSeconds: 10,
        });
        assert.ok(c1);

        // Explicitly expire the lease in the database
        await adapter.query(
          "UPDATE jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1;",
          [j.id]
        );

        // Reclaim expired lease
        const reclaimed = await reclaimExpiredLeases(adapter);
        assert.ok(reclaimed.length >= 1);

        const targetReclaimed = reclaimed.find((job) => job.id === j.id);
        assert.ok(targetReclaimed);
        assert.equal(targetReclaimed.status, "queued"); // was try 1, so it is back to queued
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

  } finally {
    await adapter.closePool();
  }
});
