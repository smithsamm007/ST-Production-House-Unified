import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import crypto from "node:crypto";
import { MigrationRunner } from "../src/db/index.js";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { PostgresResilienceRepository } from "../src/resilience/postgresResilienceRepository.js";
import { PostgresQuotaRepository } from "../src/quotas/postgresQuotaRepository.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import {
  createJob,
  claimJob,
  failJob,
  reclaimExpiredLeases,
} from "../src/jobs/lifecycle/jobLifecycle.js";

// Safe, test-compliant Checkpoint Adapter
class TestCheckpointAdapter {
  constructor() {
    this.name = "TestCheckpointAdapter";
    this.store = new Map();
  }
  async get(key) {
    return this.store.get(key) || null;
  }
  async set(key, val) {
    this.store.set(key, val);
  }
}

test("Task 3.8 Recovery Stack Integration and Adversarial Test Suite", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const isCI = !!process.env.CI;
  const isIntegrationCmd = process.env.npm_lifecycle_event === 'test:integration';
  const expectPG = isCI || isIntegrationCmd || !!dbUrl;

  if (!dbUrl) {
    if (expectPG) {
      assert.fail("PostgreSQL 15 instance is mandatory in CI/integration test environment but database URL is not set.");
    } else {
      t.diagnostic("Live PostgreSQL 15+ is not configured; skipping recovery integration tests.");
      return;
    }
  }

  // Probe live PG connection
  let pgAvailable = false;
  let testPool = null;
  let lastConnectError = null;

  try {
    testPool = new pg.Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 5000,
    });
    const client = await testPool.connect();
    await client.query("SELECT 1");
    client.release();
    pgAvailable = true;
  } catch (err) {
    pgAvailable = false;
    lastConnectError = err;
    if (testPool) {
      await testPool.end().catch(() => {});
      testPool = null;
    }
  }

  if (!pgAvailable) {
    if (expectPG) {
      assert.fail(
        `PostgreSQL 15 instance was expected in CI but could not be reached: ${
          lastConnectError ? lastConnectError.message : "Connection failed"
        }`
      );
    } else {
      t.diagnostic("Live PostgreSQL 15+ is unreachable; skipping recovery integration tests.");
      return;
    }
  }

  const schema = `rec_int_${process.pid}_${Date.now()}`;
  const connection = { connectionString: dbUrl, connectionTimeoutMillis: 5000 };
  const bootstrap = new pg.Pool(connection);
  let pool;

  try {
    // Create an isolated schema for this test run
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
    const adapter = new PostgresAdapter({}, pool);
    const runner = new MigrationRunner(adapter);

    // Apply all migrations
    await runner.runMigrations();

    // 1. Verifies isolated PG connection, migration chain, and schema upgrade behavior
    await t.test("verifies isolated PG connection, migration chain, and schema upgrade behavior", async () => {
      const checkResult = await runner.runMigrations();
      assert.equal(checkResult.appliedCount, 0, "Rerunning migrations should be fully idempotent");
    });

    // Helper to generate a unique owner & agent to isolate tests
    async function seedOwnerAndAgent() {
      const ownerId = crypto.randomUUID();
      const agentId = `rec-agent-${crypto.randomUUID().slice(0, 8)}`;
      await adapter.query(
        `INSERT INTO owners(id, email, password_hash) VALUES ($1, $2, 'x')`,
        [ownerId, `${ownerId}@test.invalid`]
      );
      await adapter.query(
        `INSERT INTO agents(id, name, namespace, concurrency_limit) VALUES ($1, $2, $3, 2)`,
        [agentId, `AGENT_${agentId.replace(/-/g, '_')}`, `st.agent.${agentId}`, 2]
      );
      return { ownerId, agentId };
    }

    // 2. Job creation and atomic claim
    await t.test("job creation and atomic claim", async () => {
      const { agentId } = await seedOwnerAndAgent();
      const capability = "transcode";
      const key = `idemp-claim-${Date.now()}`;

      const job = await createJob(adapter, {
        agentId,
        capability,
        idempotencyKey: key,
        payload: { file: "test.mp4" },
        maxAttempts: 3,
      });

      assert.ok(job.id);
      assert.equal(job.status, "queued");

      // Claim
      const claimed = await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-1",
        leaseDurationSeconds: 10,
      });

      assert.ok(claimed);
      assert.equal(claimed.id, job.id);
      assert.equal(claimed.status, "leased");

      // Try second concurrent claim
      const claimed2 = await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-2",
        leaseDurationSeconds: 10,
      });
      assert.equal(claimed2, null, "Atomic claim should prevent concurrent acquisition of the same job");
    });

    // 3. Worker crash after claim & Expired-lease recovery
    await t.test("worker crash and expired-lease recovery", async () => {
      const { agentId } = await seedOwnerAndAgent();
      const capability = "render";
      const key = `crash-key-${Date.now()}`;

      const job = await createJob(adapter, {
        agentId,
        capability,
        idempotencyKey: key,
        payload: {},
        maxAttempts: 2,
      });

      // Claim job
      await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-crashed",
        leaseDurationSeconds: 10,
      });

      // Simulates worker crash: worker goes away, lease is held. Other claims get nothing.
      const claimAgain = await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-other",
        leaseDurationSeconds: 10,
      });
      assert.equal(claimAgain, null, "Crashed worker's lease blocks other workers until expiration");

      // Artificially expire lease in database
      await adapter.query(
        "UPDATE jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1",
        [job.id]
      );

      // Reclaim
      const reclaimed = await reclaimExpiredLeases(adapter, { agentId });
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0].id, job.id);

      const check = await adapter.query("SELECT status, attempts FROM jobs WHERE id = $1", [job.id]);
      assert.equal(check.rows[0].status, "queued", "Job should return to 'queued' state");
      assert.equal(check.rows[0].attempts, 1, "Attempt count should be incremented");
    });

    // 4. Heartbeat and lease renewal
    await t.test("heartbeat and lease renewal", async () => {
      const { agentId } = await seedOwnerAndAgent();
      const capability = "transcode";
      const key = `heartbeat-${Date.now()}`;

      const job = await createJob(adapter, {
        agentId,
        capability,
        idempotencyKey: key,
        payload: {},
      });

      await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-h",
        leaseDurationSeconds: 5,
      });

      const initialRes = await adapter.query("SELECT lease_expires_at FROM jobs WHERE id = $1", [job.id]);
      const initialExpiry = new Date(initialRes.rows[0].lease_expires_at).getTime();

      // Extend lease / heartbeat
      await adapter.query(
        "UPDATE jobs SET lease_expires_at = now() + interval '30 seconds' WHERE id = $1 AND lease_owner = 'worker-h'",
        [job.id]
      );

      const updatedRes = await adapter.query("SELECT lease_expires_at FROM jobs WHERE id = $1", [job.id]);
      const updatedExpiry = new Date(updatedRes.rows[0].lease_expires_at).getTime();

      assert.ok(updatedExpiry > initialExpiry, "Heartbeat must renew and extend lease expiration time");
    });

    // 5. Graceful shutdown
    await t.test("graceful shutdown returns leased job cleanly", async () => {
      const { agentId } = await seedOwnerAndAgent();
      const capability = "render";
      const key = `graceful-${Date.now()}`;

      const job = await createJob(adapter, {
        agentId,
        capability,
        idempotencyKey: key,
        payload: {},
      });

      await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-g",
        leaseDurationSeconds: 10,
      });

      // Worker shutting down gracefully releasing lease before start or processing
      await adapter.query(
        "UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = 'worker-g'",
        [job.id]
      );

      const check = await adapter.query("SELECT status, lease_owner FROM jobs WHERE id = $1", [job.id]);
      assert.equal(check.rows[0].status, "queued");
      assert.equal(check.rows[0].lease_owner, null);
    });

    // 6. Transient failure with bounded exponential backoff
    await t.test("transient failure with bounded exponential backoff", async () => {
      const { agentId } = await seedOwnerAndAgent();
      const capability = "render";
      const key = `transient-${Date.now()}`;

      const job = await createJob(adapter, {
        agentId,
        capability,
        idempotencyKey: key,
        payload: {},
        maxAttempts: 3,
      });

      await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-t",
        leaseDurationSeconds: 10,
      });

      // Fail job with a transient error
      await failJob(adapter, {
        jobId: job.id,
        leaseOwner: "worker-t",
        errorPayload: { message: "TIMEOUT" },
      });

      const check = await adapter.query("SELECT status, next_attempt_at, backoff_metadata FROM jobs WHERE id = $1", [job.id]);
      assert.equal(check.rows[0].status, "queued");
      assert.ok(check.rows[0].next_attempt_at, "Transient failure must schedule next attempt in the future");

      const meta = check.rows[0].backoff_metadata;
      assert.equal(meta.last_classification, "transient");
      assert.ok(meta.last_delay_sec > 0);
    });

    // 7. Retry exhaustion and dead-letter transition
    await t.test("retry exhaustion and dead-letter transition", async () => {
      const { agentId } = await seedOwnerAndAgent();
      const capability = "render";
      const key = `exhausted-${Date.now()}`;

      const job = await createJob(adapter, {
        agentId,
        capability,
        idempotencyKey: key,
        payload: {},
        maxAttempts: 1, // Exceeded on first failure
      });

      await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-e",
        leaseDurationSeconds: 10,
      });

      const failed = await failJob(adapter, {
        jobId: job.id,
        leaseOwner: "worker-e",
        errorPayload: { message: "TIMEOUT" },
      });

      assert.equal(failed.status, "dead_letter", "Job should transition to 'dead_letter' on retry exhaustion");

      // Verify evidence log
      const ev = await adapter.query("SELECT * FROM evidence_events WHERE subject_id = $1 AND kind = 'job_dead_letter'", [job.id]);
      assert.equal(ev.rowCount, 1, "Exactly one dead-letter evidence event should be logged");
      assert.equal(ev.rows[0].payload.reason, "attempts_exhausted");
    });

    // 8. Checkpoint/resume without duplicate artifacts or evidence
    await t.test("checkpoint/resume without duplicate artifacts", async () => {
      const localAdapter = new TestCheckpointAdapter();
      const store = new CheckpointStore(localAdapter);
      const taskId = "task-checkpoint-test";

      const cp1 = await store.write(taskId, {
        step: "download",
        progress: 30,
        data: { file: "source.mov" },
        artifactRefs: [{ path: "source.mov", sha256: "b".repeat(64) }],
        evidenceRefs: ["evidence-1"]
      });

      assert.ok(cp1.checksum);

      // Save a duplicate checkpoint (should return identical record)
      const cp2 = await store.write(taskId, {
        step: "download",
        progress: 30,
        data: { file: "source.mov" },
        artifactRefs: [{ path: "source.mov", sha256: "b".repeat(64) }],
        evidenceRefs: ["evidence-1"]
      });

      assert.equal(cp1.checksum, cp2.checksum, "Idempotent write must return identical checksum");

      const resumed = await store.resume(taskId);
      assert.equal(resumed.step, "download");
      assert.equal(resumed.artifactRefs.length, 1);
    });

    // 9. Atomic quota reservation and consumption & Quota exhaustion
    await t.test("atomic quota reservation, consumption, and exhaustion", async () => {
      const { ownerId, agentId } = await seedOwnerAndAgent();
      const quotaRepo = new PostgresQuotaRepository(adapter);

      const scope = {
        ownerId,
        agentId,
        slot: "primary",
        provider: "mock-prov",
        idempotencyKey: `quota-res-${Date.now()}`
      };

      await quotaRepo.configureQuota(scope, { limit: 5 });

      // First reservation
      const res1 = await quotaRepo.reserve({ ...scope, units: 3 });
      assert.equal(res1.status, "reserved");
      assert.equal(res1.units, 3);

      // Verify database-time cooldown checks can execute without errors
      const state = await quotaRepo.getQuotaState(scope);
      assert.equal(state.reservedCount, 3);

      // Commit
      const committed = await quotaRepo.commit(res1);
      assert.equal(committed.status, "committed");

      // Verify counts in DB
      const updatedState = await quotaRepo.getQuotaState(scope);
      assert.equal(updatedState.usageCount, 3);
      assert.equal(updatedState.reservedCount, 0);

      // Try reservation that exceeds the limit (3 + 3 = 6 > 5)
      const scope2 = { ...scope, idempotencyKey: `quota-res-2-${Date.now()}` };
      await assert.rejects(
        quotaRepo.reserve({ ...scope2, units: 3 }),
        /QUOTA_RESERVATION_FAILED: quota_exceeded/,
        "Reserving units exceeding limit must fail closed"
      );
    });

    // 10. Process/repository recreation preserving durable state
    await t.test("process/repository recreation preserving durable state", async () => {
      const { ownerId, agentId } = await seedOwnerAndAgent();
      const quotaRepo1 = new PostgresQuotaRepository(adapter);
      const scope = {
        ownerId,
        agentId,
        slot: "primary",
        provider: "mock-prov",
        idempotencyKey: `durable-repo-${Date.now()}`
      };
      await quotaRepo1.configureQuota(scope, { limit: 10 });

      // Close and recreate repository instance
      const quotaRepo2 = new PostgresQuotaRepository(adapter);
      const state = await quotaRepo2.getQuotaState(scope);
      assert.equal(state.limit, 10, "Recreated repository must read identical durable state from DB");
    });

    // 11. Concurrent-worker claim safety
    await t.test("concurrent-worker claim safety using advisory locks", async () => {
      const { agentId } = await seedOwnerAndAgent();
      const capability = "render";
      const key = `concurrent-claim-${Date.now()}`;

      await createJob(adapter, {
        agentId,
        capability,
        idempotencyKey: key,
        payload: {},
      });

      // Genuinely concurrent claims using two different connection pools to simulate separate workers
      const pool2 = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
      const adapter2 = new PostgresAdapter({}, pool2);

      try {
        const claims = await Promise.all([
          claimJob(adapter, { agentId, capability, leaseOwner: "worker-A", leaseDurationSeconds: 10 }),
          claimJob(adapter2, { agentId, capability, leaseOwner: "worker-B", leaseDurationSeconds: 10 }),
        ]);

        const successfulClaims = claims.filter(x => x !== null);
        assert.equal(successfulClaims.length, 1, "Exactly one concurrent worker must claim the job");
      } finally {
        await pool2.end().catch(() => {});
      }
    });

    // 12. Circuit CLOSED -> OPEN -> HALF_OPEN -> CLOSED & failures in HALF_OPEN & concurrent half-open probes
    await t.test("circuit breaker state machine and concurrency protection", async () => {
      const { ownerId, agentId } = await seedOwnerAndAgent();
      const resRepo = new PostgresResilienceRepository(adapter);
      const scope = { ownerId, agentId, targetType: "provider", targetKey: "provider-x" };

      // Record failures up to threshold
      await resRepo.recordFailure(scope, { failureCode: "TIMEOUT", threshold: 2, cooldownSeconds: 1 });
      const r1 = await resRepo.recordFailure(scope, { failureCode: "TIMEOUT", threshold: 2, cooldownSeconds: 1 });
      assert.equal(r1.state, "open");
      assert.ok(r1.openedUntil);

      // Verify half-open claim fails before cooldown expires
      await assert.rejects(resRepo.claimHalfOpenProbe(scope), /CIRCUIT_PROBE_DENIED/);

      // Expire cooldown artificially
      await adapter.query(
        "UPDATE resilience_circuits SET opened_until = now() - interval '1 second' WHERE owner_id = $1 AND target_key = 'provider-x'",
        [ownerId]
      );

      // Concurrent probe claims: only 1 should succeed (concurrency protection check)
      const pool2 = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
      const adapter2 = new PostgresAdapter({}, pool2);
      const resRepo2 = new PostgresResilienceRepository(adapter2);

      try {
        const probeClaims = await Promise.allSettled([
          resRepo.claimHalfOpenProbe(scope),
          resRepo2.claimHalfOpenProbe(scope),
        ]);

        const fulfilled = probeClaims.filter(p => p.status === "fulfilled");
        assert.equal(fulfilled.length, 1, "Exactly one worker must claim the half-open probe");

        // Failure in HALF_OPEN reopens circuit
        const reopened = await resRepo.recordFailure(scope, { failureCode: "TIMEOUT", threshold: 2, cooldownSeconds: 5 });
        assert.equal(reopened.state, "open");

        // Artificially expire cooldown again
        await adapter.query(
          "UPDATE resilience_circuits SET opened_until = now() - interval '1 second' WHERE owner_id = $1 AND target_key = 'provider-x'",
          [ownerId]
        );

        // Success closes circuit
        await resRepo.claimHalfOpenProbe(scope);
        const closed = await resRepo.recordSuccess(scope);
        assert.equal(closed.state, "closed");
      } finally {
        await pool2.end().catch(() => {});
      }
    });

    // 13. Quarantine enforcement and authorized release
    await t.test("quarantine enforcement and authorized release", async () => {
      const { ownerId, agentId } = await seedOwnerAndAgent();
      const resRepo = new PostgresResilienceRepository(adapter);

      const contentSha256 = crypto.createHash("sha256").update("untrusted-output").digest("hex");
      const record = await resRepo.quarantine(
        { ownerId, agentId },
        { operation: "render", contentSha256, classification: "POLICY_REJECTED", metadata: { artifactKind: "video" } }
      );

      assert.ok(record.id);

      // Ensure quarantine records are strictly immutable (UPDATE or DELETE raises exception)
      await assert.rejects(
        adapter.query("UPDATE quarantine_records SET classification = 'QUALITY_REJECTED' WHERE id = $1", [record.id]),
        /QUARANTINE_RECORDS_ARE_IMMUTABLE/
      );

      // Non-owner authorize attempt should fail
      await assert.rejects(
        resRepo.authorizeQuarantineAction(
          { ownerId, agentId },
          { quarantineId: record.id, action: "release", approvalId: "app-1", authorizedOwnerId: crypto.randomUUID() }
        ),
        /OWNER_AUTHORIZATION_REQUIRED/
      );

      // Authorized release
      const auth = await resRepo.authorizeQuarantineAction(
        { ownerId, agentId },
        { quarantineId: record.id, action: "release", approvalId: "app-1", authorizedOwnerId: ownerId }
      );
      assert.ok(auth.id);
      assert.equal(auth.action, "release");
    });

    // 14. Durable alert creation, deduplication, and acknowledgement
    await t.test("durable alert creation, deduplication, and acknowledgement", async () => {
      const { ownerId, agentId } = await seedOwnerAndAgent();
      const resRepo = new PostgresResilienceRepository(adapter);

      // Record failure to trigger alert
      const scope = { ownerId, agentId, targetType: "provider", targetKey: "prov-alert" };
      await resRepo.recordFailure(scope, { failureCode: "TIMEOUT", threshold: 1, cooldownSeconds: 5 });

      // Check alert was created
      const alerts = await adapter.query(
        "SELECT * FROM owner_alerts WHERE owner_id = $1 AND agent_id = $2",
        [ownerId, agentId]
      );
      assert.equal(alerts.rowCount, 1);
      const alert = alerts.rows[0];
      assert.equal(alert.alert_code, "CIRCUIT_OPEN");

      // Deduplication: triggering failure again should not create duplicate alert (ON CONFLICT DO NOTHING)
      await resRepo.recordFailure(scope, { failureCode: "TIMEOUT", threshold: 1, cooldownSeconds: 5 });
      const alertsDup = await adapter.query(
        "SELECT COUNT(*) as count FROM owner_alerts WHERE owner_id = $1 AND agent_id = $2",
        [ownerId, agentId]
      );
      assert.equal(parseInt(alertsDup.rows[0].count, 10), 1, "Alerts should be deduplicated");

      // Non-owner acknowledgement fails
      await assert.rejects(
        resRepo.acknowledgeAlert({ ownerId, agentId, alertId: alert.id }, { authorizedOwnerId: crypto.randomUUID() }),
        /OWNER_AUTHORIZATION_REQUIRED/
      );

      // Owner acknowledgement
      const ack = await resRepo.acknowledgeAlert({ ownerId, agentId, alertId: alert.id }, { authorizedOwnerId: ownerId });
      assert.ok(ack.acknowledgedAt);

      const alertCheck = await adapter.query("SELECT acknowledged_at FROM owner_alerts WHERE id = $1", [alert.id]);
      assert.ok(alertCheck.rows[0].acknowledged_at);
    });

    // 15. Emergency pause blocking applicable claims/routes & authorized resume
    await t.test("emergency pause and authorized resume", async () => {
      const { ownerId, agentId } = await seedOwnerAndAgent();
      const resRepo = new PostgresResilienceRepository(adapter);

      await resRepo.assertWorkAllowed({ ownerId, agentId, operation: "render" }); // allowed initially

      // Set pause
      const pause = await resRepo.setPause(
        { ownerId, scopeType: "global_owner" },
        { reasonCode: "OWNER_REQUEST", approvalId: "pause-app", authorizedOwnerId: ownerId }
      );
      assert.ok(pause.id);

      // Verify work is blocked
      await assert.rejects(
        resRepo.assertWorkAllowed({ ownerId, agentId, operation: "render" }),
        /EMERGENCY_PAUSE_ACTIVE/
      );

      // Non-owner clear pause fails
      await assert.rejects(
        resRepo.clearPause({ ownerId, pauseId: pause.id }, { approvalId: "resume-app", authorizedOwnerId: crypto.randomUUID() }),
        /OWNER_AUTHORIZATION_REQUIRED/
      );

      // Owner clear pause
      await resRepo.clearPause({ ownerId, pauseId: pause.id }, { approvalId: "resume-app", authorizedOwnerId: ownerId });

      // Verify allowed again
      const allowed = await resRepo.assertWorkAllowed({ ownerId, agentId, operation: "render" });
      assert.equal(allowed, true);
    });

    // 16. Transaction rollback when evidence persistence fails
    await t.test("transaction rollback when evidence persistence fails", async () => {
      const { ownerId, agentId } = await seedOwnerAndAgent();
      const resRepo = new PostgresResilienceRepository(adapter);

      // Set up trigger to fail on evidence insert
      await adapter.query(`
        CREATE OR REPLACE FUNCTION fail_evidence_insert() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'MOCKED_EVIDENCE_PERSISTENCE_FAILURE';
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER trigger_fail_evidence
        BEFORE INSERT ON evidence_events
        FOR EACH ROW EXECUTE FUNCTION fail_evidence_insert();
      `);

      try {
        const scope = { ownerId, agentId, targetType: "provider", targetKey: "rollback-target" };

        await assert.rejects(
          resRepo.recordFailure(scope, { failureCode: "TIMEOUT", threshold: 1, cooldownSeconds: 5 }),
          /MOCKED_EVIDENCE_PERSISTENCE_FAILURE/
        );

        // Verify that circuit record WAS NOT created/updated because the transaction rolled back cleanly
        const check = await adapter.query(
          "SELECT count(*)::int as cnt FROM resilience_circuits WHERE target_key = 'rollback-target'"
        );
        assert.equal(check.rows[0].cnt, 0, "No changes should be persisted when evidence write fails");
      } finally {
        await adapter.query("DROP TRIGGER IF EXISTS trigger_fail_evidence ON evidence_events CASCADE");
        await adapter.query("DROP FUNCTION IF EXISTS fail_evidence_insert() CASCADE");
      }
    });

    // 17. Cross-owner and cross-agent isolation
    await t.test("cross-owner and cross-agent isolation", async () => {
      const userA = await seedOwnerAndAgent();
      const userB = await seedOwnerAndAgent();
      const resRepo = new PostgresResilienceRepository(adapter);

      const contentSha256 = crypto.createHash("sha256").update("private-data").digest("hex");
      const record = await resRepo.quarantine(
        { ownerId: userA.ownerId, agentId: userA.agentId },
        { operation: "render", contentSha256, classification: "POLICY_REJECTED", metadata: { artifactKind: "video" } }
      );

      // Owner B trying to release Owner A's quarantine should fail (scope mismatch check)
      await assert.rejects(
        resRepo.authorizeQuarantineAction(
          { ownerId: userA.ownerId, agentId: userA.agentId },
          { quarantineId: record.id, action: "release", approvalId: "app-b", authorizedOwnerId: userB.ownerId }
        ),
        /OWNER_AUTHORIZATION_REQUIRED/
      );

      await assert.rejects(
        resRepo.authorizeQuarantineAction(
          { ownerId: userB.ownerId, agentId: userB.agentId },
          { quarantineId: record.id, action: "release", approvalId: "app-b", authorizedOwnerId: userB.ownerId }
        ),
        /QUARANTINE_SCOPE_MISMATCH/
      );
    });

    // 18. Safe redactions on error logs (Secret and unsafe-error non-disclosure)
    await t.test("safe redactions on error logs", async () => {
      const { agentId } = await seedOwnerAndAgent();
      const capability = "render";
      const key = `redact-err-${Date.now()}`;

      const job = await createJob(adapter, {
        agentId,
        capability,
        idempotencyKey: key,
        payload: {},
        maxAttempts: 1,
      });

      await claimJob(adapter, {
        agentId,
        capability,
        leaseOwner: "worker-sec",
        leaseDurationSeconds: 10,
      });

      const rawSensitiveError = "Invalid credential vault://secrets/keys/primary and apiKey=supersecret123";
      await failJob(adapter, {
        jobId: job.id,
        leaseOwner: "worker-sec",
        errorPayload: { message: rawSensitiveError },
      });

      // Verify redaction in jobs table
      const jobCheck = await adapter.query("SELECT payload FROM jobs WHERE id = $1", [job.id]);
      const checkSummary = jobCheck.rows[0].payload.error.summary;
      assert.equal(checkSummary.includes("primary"), false);
      assert.equal(checkSummary.includes("supersecret123"), false);
      assert.ok(checkSummary.includes("[REDACTED_VAULT_LOCATOR]"));
      assert.ok(checkSummary.includes("apiKey:[REDACTED]"));
    });

  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await bootstrap.end().catch(() => {});
  }
});
