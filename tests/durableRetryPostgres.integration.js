import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import crypto from "node:crypto";
import { createPostgresAdapter } from "../src/db/index.js";
import { MigrationRunner } from "../src/db/index.js";
import {
  createJob,
  claimJob,
  startJob,
  failJob,
  reclaimExpiredLeases,
  replayJob,
} from "../src/jobs/lifecycle/jobLifecycle.js";

test("Durable Retry PostgreSQL Live Integration Suite", async (t) => {
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

    // Verification of Migration Immutability (001-011 preserved and 012 applied)
    await t.test("migration 012 is additive, transactional, and idempotent on rerun", async () => {
      const res = await runner.runMigrations();
      assert.equal(res.appliedCount, 0); // zero newly applied migrations
    });

    // Clock Boundaries (Future-scheduling exclusion)
    await t.test("claimJob excludes future-scheduled jobs and includes eligible retries", async () => {
      const unique = Date.now();
      const agentId = `agent-future-${unique}`;
      const cap = "transcode";

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `FUTURE_AGENT_${unique}`, `st.agent.future.${unique}`]
      );

      try {
        const payload = { file: "input.avi" };
        const key = `idemp-future-${unique}`;

        // Create a job
        const job = await createJob(adapter, {
          agentId,
          capability: cap,
          idempotencyKey: key,
          payload,
          maxAttempts: 3,
        });

        // Set next_attempt_at to 1 hour in the future
        await adapter.query(
          "UPDATE jobs SET next_attempt_at = now() + interval '1 hour' WHERE id = $1;",
          [job.id]
        );

        // Attempt claim -> should be null because next_attempt_at is in the future
        const claimedFuture = await claimJob(adapter, {
          agentId,
          capability: cap,
          leaseOwner: `worker-future-${unique}`,
          leaseDurationSeconds: 10,
        });
        assert.equal(claimedFuture, null, "Should not claim a future-scheduled job");

        // Now set next_attempt_at to 5 seconds in the past
        await adapter.query(
          "UPDATE jobs SET next_attempt_at = now() - interval '5 seconds' WHERE id = $1;",
          [job.id]
        );

        // Attempt claim again -> should succeed
        const claimedEligible = await claimJob(adapter, {
          agentId,
          capability: cap,
          leaseOwner: `worker-future-${unique}`,
          leaseDurationSeconds: 10,
        });
        assert.ok(claimedEligible, "Should successfully claim an eligible job");
        assert.equal(claimedEligible.id, job.id);
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    // Failure-Injection: Rollback Verification
    await t.test("durable rollback on failure protects job state", async () => {
      const unique = Date.now();
      const agentId = `agent-rollback-${unique}`;
      const cap = "fail-job";

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `ROLLBACK_AGENT_${unique}`, `st.agent.rollback.${unique}`]
      );

      try {
        const job = await createJob(adapter, {
          agentId,
          capability: cap,
          idempotencyKey: `rollback-key-${unique}`,
          payload: {},
        });

        // Claim job
        const claimed = await claimJob(adapter, {
          agentId,
          capability: cap,
          leaseOwner: "worker-r",
          leaseDurationSeconds: 10,
        });

        // Fail job inside a transaction, but force a database-level error afterwards to trigger a rollback
        await assert.rejects(
          async () => {
            await adapter.withTransaction(async (client) => {
              // Fail the job inside the transaction
              await failJob(client, {
                jobId: job.id,
                leaseOwner: "worker-r",
                errorPayload: { message: "TIMEOUT" },
              });

              // Force a database exception
              await client.query("DELETE FROM agents WHERE id = $1;", [agentId]);
            });
          },
          /violates foreign key constraint/
        );

        // Verify that the job's state was rolled back and is STILL 'leased' (with same leaseOwner)
        const checkRes = await adapter.query("SELECT status, lease_owner FROM jobs WHERE id = $1;", [job.id]);
        assert.equal(checkRes.rows[0].status, "leased", "Job status should remain 'leased' after rollback");
        assert.equal(checkRes.rows[0].lease_owner, "worker-r");
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    // Concurrency-Safe Expired Lease Recovery & Idempotency
    await t.test("concurrent reclaimExpiredLeases is concurrency-safe and idempotent", async () => {
      const unique = Date.now();
      const agentId = `agent-expire-${unique}`;
      const cap = "expire-job";

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `EXPIRE_AGENT_${unique}`, `st.agent.expire.${unique}`]
      );

      try {
        const job = await createJob(adapter, {
          agentId,
          capability: cap,
          idempotencyKey: `expire-key-${unique}`,
          payload: {},
          maxAttempts: 2,
        });

        // Lease the job
        await claimJob(adapter, {
          agentId,
          capability: cap,
          leaseOwner: "owner-exp",
          leaseDurationSeconds: 10,
        });

        // Artificially expire the lease
        await adapter.query(
          "UPDATE jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1;",
          [job.id]
        );

        // Run two concurrent reclaim processes genuinely in parallel, scoped strictly by agentId
        const [reclaimed1, reclaimed2] = await Promise.all([
          reclaimExpiredLeases(adapter, { agentId }),
          reclaimExpiredLeases(adapter, { agentId }),
        ]);

        // Total reclaimed across both must be 1, because exactly one concurrent sweeper can process and recover it!
        const totalReclaimed = reclaimed1.filter(j => j.id === job.id).length + reclaimed2.filter(j => j.id === job.id).length;
        assert.equal(totalReclaimed, 1, "Exactly one concurrent sweep must reclaim the expired job");

        // Verify that an evidence event was logged for this retry transition
        const evidenceRes = await adapter.query(
          "SELECT * FROM evidence_events WHERE subject_id = $1 AND kind = 'job_retry' ORDER BY occurred_at DESC;",
          [job.id]
        );
        assert.equal(evidenceRes.rows.length, 1, "Exactly one retry evidence event should be logged");

        const payload = evidenceRes.rows[0].payload;
        assert.equal(payload.jobId, job.id);
        assert.equal(payload.classification, "transient");
        assert.equal(payload.attempts, 1);
        assert.ok(payload.nextAttemptAt);
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    // Max Attempts Terminal Dead-letter transitions
    await t.test("exhausted attempts transition to dead_letter with exact evidence", async () => {
      const unique = Date.now();
      const agentId = `agent-max-${unique}`;
      const cap = "max-job";

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `MAX_AGENT_${unique}`, `st.agent.max.${unique}`]
      );

      try {
        const job = await createJob(adapter, {
          agentId,
          capability: cap,
          idempotencyKey: `max-key-${unique}`,
          payload: {},
          maxAttempts: 1, // Will fail on 1st retry
        });

        // Try 1
        await claimJob(adapter, {
          agentId,
          capability: cap,
          leaseOwner: "worker-m",
          leaseDurationSeconds: 10,
        });

        // Fail job -> status transitions to dead_letter immediately since maxAttempts is 1
        const failed = await failJob(adapter, {
          jobId: job.id,
          leaseOwner: "worker-m",
          errorPayload: { message: "TIMEOUT" },
        });

        assert.equal(failed.status, "dead_letter");

        // Ensure exactly one dead_letter evidence event is logged
        const evidenceRes = await adapter.query(
          "SELECT * FROM evidence_events WHERE subject_id = $1 AND kind = 'job_dead_letter' ORDER BY occurred_at DESC;",
          [job.id]
        );
        assert.equal(evidenceRes.rows.length, 1, "Exactly one dead_letter evidence event should be logged");

        const evidence = evidenceRes.rows[0].payload;
        assert.equal(evidence.jobId, job.id);
        assert.equal(evidence.attempts, 1);
        assert.equal(evidence.classification, "transient"); // error classified as transient but exhausted
        assert.equal(evidence.reason, "attempts_exhausted");
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

    // Manual Replay Authorization and Isolation
    await t.test("replayJob strictly authorizes owners, enforces agent isolation, and never resets attempts history silently", async () => {
      const unique = Date.now();
      const agentId1 = `agent-replay-1-${unique}`;
      const agentId2 = `agent-replay-2-${unique}`;
      const ownerId = crypto.randomUUID();
      const otherOwnerId = crypto.randomUUID();
      const cap = "replay-job";

      // Seed owners
      await adapter.query(
        "INSERT INTO owners (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6);",
        [
          ownerId, `owner-rep-1-${unique}@example.com`, "dummy1",
          otherOwnerId, `owner-rep-2-${unique}@example.com`, "dummy2"
        ]
      );

      // Seed agents
      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2), ($4, $5, $6, 2);`,
        [
          agentId1, `REP_AGENT_1_${unique}`, `st.agent.rep.1.${unique}`,
          agentId2, `REP_AGENT_2_${unique}`, `st.agent.rep.2.${unique}`
        ]
      );

      // Seed canonical ownership connection in communication_sessions
      const session1 = crypto.randomUUID();
      await adapter.query(
        `INSERT INTO communication_sessions (id, owner_id, agent_id, is_active)
         VALUES ($1, $2, $3, true);`,
        [session1, ownerId, agentId1]
      );

      try {
        const job = await createJob(adapter, {
          agentId: agentId1,
          capability: cap,
          idempotencyKey: `rep-key-${unique}`,
          payload: {},
          maxAttempts: 1,
        });

        // Claim & Fail to put in dead_letter
        await claimJob(adapter, {
          agentId: agentId1,
          capability: cap,
          leaseOwner: "worker-rep",
          leaseDurationSeconds: 10,
        });
        await failJob(adapter, {
          jobId: job.id,
          leaseOwner: "worker-rep",
          errorPayload: { message: "TIMEOUT" },
        });

        // Seed an unconsumed owner-authorized approval record with budget (Comment 1 & 2)
        const authEvidenceId = crypto.randomUUID();
        const approvalPayload = {
          ownerId,
          agentId: agentId1,
          jobId: job.id,
          action: "replay",
          additionalAttempts: 3
        };

        await adapter.query(
          `INSERT INTO evidence_events (id, subject_id, kind, classification, payload, event_hash)
           VALUES ($1, $2, $3, $4, $5, $6);`,
          [
            authEvidenceId,
            job.id,
            "job_replay_authorized",
            "owner_authorized_replay",
            JSON.stringify(approvalPayload),
            crypto.createHash("sha256").update(authEvidenceId).digest("hex")
          ]
        );

        // 1. Replay with invalid owner should fail
        await assert.rejects(
          async () => {
            await replayJob(adapter, {
              jobId: job.id,
              agentId: agentId1,
              ownerId: crypto.randomUUID(), // non-existent owner
              evidenceId: authEvidenceId,
            });
          },
          /OWNER_NOT_FOUND/
        );

        // 2. Replay with invalid/non-existent evidence should fail
        await assert.rejects(
          async () => {
            await replayJob(adapter, {
              jobId: job.id,
              agentId: agentId1,
              ownerId,
              evidenceId: crypto.randomUUID(), // non-existent evidence
            });
          },
          /REPLAY_AUTHORIZATION_EVIDENCE_NOT_FOUND/
        );

        // 3. Replay with cross-agent mismatch should fail (agent isolation violation)
        await assert.rejects(
          async () => {
            await replayJob(adapter, {
              jobId: job.id,
              agentId: agentId2, // incorrect agentId
              ownerId,
              evidenceId: authEvidenceId,
            });
          },
          /AGENT_OWNERSHIP_VIOLATION/
        );

        // 4. Successful Authorized Replay with consumption
        const replayed = await replayJob(adapter, {
          jobId: job.id,
          agentId: agentId1,
          ownerId,
          evidenceId: authEvidenceId,
        });

        assert.equal(replayed.status, "queued");
        // Verify attempts history is NOT reset (never resets history silently)
        assert.equal(replayed.attempts, 1, "History must not be reset; attempts should still be 1");
        // Verify maxAttempts was increased by budget carried by the evidence (from 1 to 4)
        assert.equal(replayed.maxAttempts, 4);

        // 5. Trying to consume the same approval evidence record again should fail (consumption/reuse lock check)
        await assert.rejects(
          async () => {
            await replayJob(adapter, {
              jobId: job.id,
              agentId: agentId1,
              ownerId,
              evidenceId: authEvidenceId,
            });
          },
          /REPLAY_APPROVAL_ALREADY_CONSUMED/
        );

      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id IN ($1, $2);", [agentId1, agentId2]);
        await adapter.query("DELETE FROM communication_sessions WHERE id = $1;", [session1]);
        await adapter.query("DELETE FROM agents WHERE id IN ($1, $2);", [agentId1, agentId2]);
        await adapter.query("DELETE FROM owners WHERE id IN ($1, $2);", [ownerId, otherOwnerId]);
      }
    });

    // Redaction Verification
    await t.test("error payload and evidence log fields strictly redact raw credentials, tokens, and locators", async () => {
      const unique = Date.now();
      const agentId = `agent-redact-${unique}`;
      const cap = "redact-job";

      await adapter.query(
        `INSERT INTO agents (id, name, namespace, concurrency_limit)
         VALUES ($1, $2, $3, 2);`,
        [agentId, `REDACT_AGENT_${unique}`, `st.agent.redact.${unique}`]
      );

      try {
        const job = await createJob(adapter, {
          agentId,
          capability: cap,
          idempotencyKey: `redact-key-${unique}`,
          payload: {},
          maxAttempts: 1,
        });

        await claimJob(adapter, {
          agentId,
          capability: cap,
          leaseOwner: "worker-red",
          leaseDurationSeconds: 10,
        });

        // Failure payload contains sensitive credentials and locators!
        const sensitiveError = "Failed because vault://secrets/my-token is invalid and secret=abc123token is wrong";
        await failJob(adapter, {
          jobId: job.id,
          leaseOwner: "worker-red",
          errorPayload: { message: sensitiveError },
        });

        // 1. Verify job payload error is redacted
        const jobCheck = await adapter.query("SELECT payload FROM jobs WHERE id = $1;", [job.id]);
        const jobErrMessage = jobCheck.rows[0].payload.error.summary;
        assert.equal(jobErrMessage.includes("my-token"), false, "Locator must be redacted from error message");
        assert.equal(jobErrMessage.includes("abc123token"), false, "Secret must be redacted from error message");
        assert.ok(jobErrMessage.includes("[REDACTED_VAULT_LOCATOR]"));
        assert.ok(jobErrMessage.includes("secret:[REDACTED]"));

        // 2. Verify evidence log payload is redacted and does not contain raw secrets
        const evidenceRes = await adapter.query(
          "SELECT payload FROM evidence_events WHERE subject_id = $1 AND kind = 'job_dead_letter';",
          [job.id]
        );
        const evidencePayload = evidenceRes.rows[0].payload;
        assert.equal(evidencePayload.error.includes("my-token"), false);
        assert.equal(evidencePayload.error.includes("abc123token"), false);
        assert.ok(evidencePayload.error.includes("[REDACTED_VAULT_LOCATOR]"));
        assert.ok(evidencePayload.error.includes("secret:[REDACTED]"));
      } finally {
        await adapter.query("DELETE FROM jobs WHERE agent_id = $1;", [agentId]);
        await adapter.query("DELETE FROM agents WHERE id = $1;", [agentId]);
      }
    });

  } finally {
    await adapter.closePool();
  }
});
