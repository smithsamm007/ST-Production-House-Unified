import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createOwnerApp } from "../src/api/ownerServer.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

const VALID_BOOTSTRAP_TOKEN = "0123456789abcdef0123456789abcdef"; // 32 bytes

// ---------------------------------------------------------------------------
// In-memory job control store honoring the sql/010+017 state machine
// ---------------------------------------------------------------------------

const JOB_ID_A = "11111111-1111-4111-8111-111111111111";
const JOB_ID_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID_FOREIGN = "33333333-3333-4333-8333-333333333333";
const PAUSE_ID_SEED = "44444444-4444-4444-8444-444444444444";

function toDbRowShape(job) {
  // Mirror the Postgres row shape that jobControlStore implementations return
  // (snake_case columns), so the DTO layer is exercised exactly as in production.
  return {
    id: job.id,
    agent_id: job.agentId,
    capability: job.capability,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    max_attempts: job.maxAttempts,
    lease_owner: job.leaseOwner,
    lease_expires_at: job.leaseExpiresAt,
    next_attempt_at: job.nextAttemptAt,
    updated_at: job.updatedAt,
    created_at: job.createdAt,
  };
}

class MemoryJobControlStore {
  constructor() {
    this.name = "MemoryJobControlStore";
    this.jobs = new Map([
      [
        JOB_ID_A,
        {
          id: JOB_ID_A,
          agentId: "agent-01",
          capability: "tts_render",
          idempotencyKey: "job-a",
          status: "failed",
          priority: 100,
          attempts: 3,
          maxAttempts: 3,
          leaseOwner: null,
          leaseExpiresAt: null,
          payload: {},
          createdAt: "2026-09-14T00:00:00Z",
          updatedAt: "2026-09-14T00:00:00Z",
          nextAttemptAt: null,
        },
      ],
      [
        JOB_ID_B,
        {
          id: JOB_ID_B,
          agentId: "agent-01",
          capability: "render_shorts",
          idempotencyKey: "job-b",
          status: "queued",
          priority: 100,
          attempts: 0,
          maxAttempts: 3,
          leaseOwner: null,
          leaseExpiresAt: null,
          payload: {},
          createdAt: "2026-09-14T00:00:00Z",
          updatedAt: "2026-09-14T00:00:00Z",
          nextAttemptAt: null,
        },
      ],
      [
        JOB_ID_FOREIGN,
        {
          id: JOB_ID_FOREIGN,
          agentId: "agent-01",
          capability: "other_owner_job",
          idempotencyKey: "job-foreign",
          status: "dead_letter",
          priority: 100,
          attempts: 3,
          maxAttempts: 3,
          leaseOwner: null,
          leaseExpiresAt: null,
          payload: {},
          createdAt: "2026-09-14T00:00:00Z",
          updatedAt: "2026-09-14T00:00:00Z",
          nextAttemptAt: null,
        },
      ],
    ]);
    this.ownerOfJob = new Map([
      [JOB_ID_A, "owner-alpha"],
      [JOB_ID_B, "owner-alpha"],
      [JOB_ID_FOREIGN, "owner-beta"],
    ]);
    this.auditRows = [];
    this.approvalRows = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "pending",
        destination: "youtube:channel-123",
        caption_snapshot: "A caption snapshot",
        mode: "draft",
        artifact_sha256: "a".repeat(64),
        artifact_kind: "video_longform",
        job_capability: "publish_video",
        created_at: "2026-09-14T00:00:00Z",
        approval_expires_at: "2026-09-15T00:00:00Z",
        owner_id: "owner-alpha",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "pending",
        destination: "instagram:reels",
        caption_snapshot: "Another caption",
        mode: "draft",
        artifact_sha256: "b".repeat(64),
        artifact_kind: "video_short",
        job_capability: "publish_reel",
        created_at: "2026-09-14T00:00:00Z",
        approval_expires_at: null,
        owner_id: "owner-beta",
      },
    ];
    this.pauseRows = [
      {
        id: PAUSE_ID_SEED,
        scope_type: "agent",
        agent_id: "agent-01",
        operation: null,
        reason_code: "OWNER_REQUEST",
        active: true,
        created_at: "2026-09-14T00:00:00Z",
        cleared_at: null,
        owner_id: "owner-alpha",
      },
    ];
    this.retryCalls = [];
    this.cancelCalls = [];
  }

  async getJobForOwner(ownerId, jobId) {
    const job = this.jobs.get(jobId);
    if (!job || this.ownerOfJob.get(jobId) !== ownerId) return null;
    return toDbRowShape(job);
  }

  async retryJob(ownerId, jobId, fromStatus, audit) {
    this.retryCalls.push({ ownerId, jobId, fromStatus, audit });
    return this.#transition(ownerId, jobId, fromStatus, "queued", audit);
  }

  async cancelJob(ownerId, jobId, fromStatus, audit) {
    this.cancelCalls.push({ ownerId, jobId, fromStatus, audit });
    return this.#transition(ownerId, jobId, fromStatus, "owner_cancelled", audit);
  }

  #transition(ownerId, jobId, fromStatus, toStatus, audit) {
    const job = this.jobs.get(jobId);
    if (!job || this.ownerOfJob.get(jobId) !== ownerId) return null;
    if (job.status !== fromStatus) return null;
    // Mirror the 010+017 trigger: terminal states never transition again.
    const TERMINAL = new Set(["succeeded", "dead_letter", "owner_cancelled"]);
    if (TERMINAL.has(job.status) && job.status !== toStatus) return null;
    job.status = toStatus;
    job.updatedAt = "2026-09-14T12:00:00Z";
    this.auditRows.push({ ...audit, ownerId, agentId: job.agentId, jobId, fromStatus, toStatus });
    return toDbRowShape(job);
  }

  async listPendingApprovals(ownerId, limit) {
    return this.approvalRows
      .filter((row) => row.owner_id === ownerId && row.status === "pending")
      .slice(0, limit);
  }

  async listActivePauses(ownerId) {
    return this.pauseRows.filter((row) => row.owner_id === ownerId && row.active);
  }
}

class MemoryDbAdapter {
  constructor() {
    this.name = "MemoryDbAdapter";
    this.auditRows = [];
    this.query = this.query.bind(this);
  }
  async query(text, params) {
    if (text.startsWith("INSERT INTO owner_control_audit")) {
      this.auditRows.push({
        ownerId: params[0],
        agentId: params[1],
        jobId: params[2],
        action: params[3],
        fromStatus: params[4],
        toStatus: params[5],
        detail: JSON.parse(params[6]),
      });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`MEMORY_DB_UNEXPECTED_QUERY: ${text.slice(0, 40)}`);
  }
}

class FakeResilienceRepository {
  constructor() {
    this.name = "FakeResilienceRepository";
    this.setCalls = [];
    this.clearCalls = [];
  }
  async setPause(scope, decision) {
    this.setCalls.push({ scope, decision });
    if (scope.scopeType === "agent" && !scope.agentId) throw new Error("AGENT_ID_REQUIRED");
    return {
      id: "55555555-5555-4555-8555-555555555555",
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      scopeType: scope.scopeType,
      operation: scope.operation,
      reasonCode: decision.reasonCode,
      active: true,
    };
  }
  async clearPause(scope, decision) {
    this.clearCalls.push({ scope, decision });
    return { id: scope.pauseId, active: false };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeApp({ store = new MemoryJobControlStore(), resilience = new FakeResilienceRepository(), db = new MemoryDbAdapter(), evidenceLedger = new EvidenceLedger() } = {}) {
  return createOwnerApp({
    bootstrapToken: VALID_BOOTSTRAP_TOKEN,
    bootstrapOwnerId: "owner-alpha",
    jobControlStore: store,
    resilienceRepository: resilience,
    dbAdapter: db,
    evidenceLedger,
  });
}

async function startSession(app) {
  const res = await request(app)
    .post("/session/start")
    .send({ token: VALID_BOOTSTRAP_TOKEN })
    .expect(200);
  return { token: res.body.token, csrfToken: res.body.csrfToken };
}

// ---------------------------------------------------------------------------
// Session + CSRF issuance
// ---------------------------------------------------------------------------

test("session start issues a CSRF token alongside the session token", async () => {
  const app = makeApp();
  const { token, csrfToken } = await startSession(app);
  assert.ok(typeof token === "string" && token.length > 0);
  assert.ok(typeof csrfToken === "string" && csrfToken.length >= 32);
});

// ---------------------------------------------------------------------------
// Authentication and CSRF on all mutations
// ---------------------------------------------------------------------------

test("control routes reject unauthenticated requests on every route", async () => {
  const app = makeApp();
  const resApprovals = await request(app).get("/control/approvals").expect(401);
  assert.equal(resApprovals.body.error, "UNAUTHORIZED");
  const resRetry = await request(app).post(`/control/jobs/${JOB_ID_A}/retry`).expect(401);
  assert.equal(resRetry.body.error, "UNAUTHORIZED");
  const resPause = await request(app).post("/control/pauses").expect(401);
  assert.equal(resPause.body.error, "UNAUTHORIZED");
});

test("mutations require a valid CSRF token; session token alone is not enough", async () => {
  const app = makeApp();
  const { token } = await startSession(app);
  const res = await request(app)
    .post(`/control/jobs/${JOB_ID_A}/retry`)
    .set("Authorization", `Bearer ${token}`)
    .send({})
    .expect(403);
  assert.equal(res.body.error, "CSRF_TOKEN_INVALID");
});

test("a wrong CSRF token is rejected", async () => {
  const app = makeApp();
  const { token, csrfToken } = await startSession(app);
  const wrong = `${csrfToken.slice(0, -1)}${csrfToken.endsWith("a") ? "b" : "a"}`;
  const resWrong = await request(app)
    .post(`/control/jobs/${JOB_ID_B}/cancel`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", wrong)
    .send({})
    .expect(403);
  assert.equal(resWrong.body.error, "CSRF_TOKEN_INVALID");
});

// ---------------------------------------------------------------------------
// Owner scoping (server-authoritative identity)
// ---------------------------------------------------------------------------

test("cross-owner jobs are indistinguishable 404s and never retried", async () => {
  const store = new MemoryJobControlStore();
  const app = makeApp({ store });
  const { token, csrfToken } = await startSession(app);

  const res = await request(app)
    .post(`/control/jobs/${JOB_ID_FOREIGN}/retry`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({})
    .expect(404);
  assert.equal(res.body.error, "NOT_FOUND");
  assert.equal(store.retryCalls.length, 0);
});

test("client-supplied ownerId cannot select another owner's pause scope", async () => {
  const resilience = new FakeResilienceRepository();
  const app = makeApp({ resilience });
  const { token, csrfToken } = await startSession(app);
  const res = await request(app)
    .post("/control/pauses")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({ ownerId: "owner-beta", scopeType: "global_owner", reasonCode: "OWNER_REQUEST", approvalId: "approval-1" })
    .expect(403);
  assert.equal(res.body.error, "SCOPE_MISMATCH");
  assert.equal(resilience.setCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Job control state machine
// ---------------------------------------------------------------------------

test("retry requeues a failed job to queued and records an audit row + evidence", async () => {
  const store = new MemoryJobControlStore();
  const db = new MemoryDbAdapter();
  const evidenceLedger = new EvidenceLedger();
  const app = makeApp({ store, db, evidenceLedger });
  const { token, csrfToken } = await startSession(app);

  const res = await request(app)
    .post(`/control/jobs/${JOB_ID_A}/retry`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({})
    .expect(200);

  assert.equal(res.body.job.status, "queued");
  assert.equal(res.body.job.id, JOB_ID_A);
  assert.deepEqual(Object.keys(res.body.job).sort(), [
    "agentId", "attempts", "capability", "id", "leaseExpiresAt", "leaseOwner",
    "maxAttempts", "nextAttemptAt", "priority", "status", "updatedAt",
  ]);
  assert.equal(res.body.job.agentId, "agent-01");

  // Audit row: same transaction contract (Rule 6)
  assert.equal(store.auditRows.length, 1);
  assert.equal(store.auditRows[0].action, "job_retry");
  assert.equal(store.auditRows[0].fromStatus, "failed");
  assert.equal(store.auditRows[0].toStatus, "queued");

  // Evidence ledger event
  const classifications = evidenceLedger.list().map((event) => event.classification);
  assert.ok(classifications.includes("owner_authorized_recovery"));
});

test("retry rejects non-retryable states with a 409 and no mutation", async () => {
  const store = new MemoryJobControlStore();
  const app = makeApp({ store });
  const { token, csrfToken } = await startSession(app);

  const res = await request(app)
    .post(`/control/jobs/${JOB_ID_B}/retry`) // queued is not retryable
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({})
    .expect(409);
  assert.equal(res.body.error, "JOB_NOT_RETRYABLE");
  assert.equal(store.retryCalls.length, 0);
  assert.equal(store.auditRows.length, 0);
});

test("cancel transitions a queued job to owner_cancelled and records the audit row", async () => {
  const store = new MemoryJobControlStore();
  const app = makeApp({ store });
  const { token, csrfToken } = await startSession(app);

  const res = await request(app)
    .post(`/control/jobs/${JOB_ID_B}/cancel`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({})
    .expect(200);
  assert.equal(res.body.job.status, "owner_cancelled");
  assert.equal(store.auditRows.length, 1);
  assert.equal(store.auditRows[0].action, "job_cancel");
  assert.equal(store.auditRows[0].fromStatus, "queued");
  assert.equal(store.auditRows[0].toStatus, "owner_cancelled");
});

test("cancel rejects terminal states with a 409 and no mutation", async () => {
  const store = new MemoryJobControlStore();
  const app = makeApp({ store });
  const { token, csrfToken } = await startSession(app);

  // First cancel the queued job so it becomes owner_cancelled (terminal)
  await request(app)
    .post(`/control/jobs/${JOB_ID_B}/cancel`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({})
    .expect(200);

  const res = await request(app)
    .post(`/control/jobs/${JOB_ID_B}/cancel`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({})
    .expect(409);
  assert.equal(res.body.error, "JOB_NOT_CANCELLABLE");
  assert.equal(store.cancelCalls.length, 1); // only the first cancel mutated
});

test("malformed job ids yield a clean 400 allowlisted code", async () => {
  const app = makeApp();
  const { token, csrfToken } = await startSession(app);
  const res = await request(app)
    .post("/control/jobs/not-a-uuid/retry")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({})
    .expect(400);
  assert.equal(res.body.error, "JOB_ID_INVALID");
});

// ---------------------------------------------------------------------------
// Approval queue (read-only, Rule 17 allowlist)
// ---------------------------------------------------------------------------

test("approval queue lists only the session owner's pending approvals", async () => {
  const store = new MemoryJobControlStore();
  const app = makeApp({ store });
  const { token } = await startSession(app);

  const res = await request(app)
    .get("/control/approvals")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(res.body.ownerId, "owner-alpha");
  assert.equal(res.body.count, 1);
  assert.equal(res.body.approvals[0].destination, "youtube:channel-123");
  assert.deepEqual(Object.keys(res.body.approvals[0]).sort(), [
    "approvalExpiresAt", "artifactKind", "artifactSha256", "captionSnapshot",
    "createdAt", "destination", "id", "jobCapability", "mode", "status",
  ]);
});

test("approval queue rejects malformed limit values", async () => {
  const app = makeApp();
  const { token } = await startSession(app);
  const res = await request(app)
    .get("/control/approvals?limit=9999")
    .set("Authorization", `Bearer ${token}`)
    .expect(400);
  assert.equal(res.body.error, "QUERY_INVALID");
});

// ---------------------------------------------------------------------------
// Emergency pause (reuses the production resilience contract)
// ---------------------------------------------------------------------------

test("set pause delegates to the resilience repository and reflects in the pause list", async () => {
  const store = new MemoryJobControlStore();
  const resilience = new FakeResilienceRepository();
  const db = new MemoryDbAdapter();
  const app = makeApp({ store, resilience, db });
  const { token, csrfToken } = await startSession(app);

  const res = await request(app)
    .post("/control/pauses")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({ scopeType: "global_owner", reasonCode: "OWNER_REQUEST", approvalId: "approval-2026" })
    .expect(201);
  assert.equal(res.body.pause.active, true);
  assert.deepEqual(Object.keys(res.body.pause).sort(), ["active", "agentId", "id", "operation", "reasonCode", "scopeType"]);
  assert.equal(resilience.setCalls.length, 1);
  assert.equal(resilience.setCalls[0].decision.authorizedOwnerId, "owner-alpha");
  assert.equal(db.auditRows.filter((row) => row.action === "emergency_pause_set").length, 1);

  const listRes = await request(app)
    .get("/control/pauses")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(listRes.body.count, 1); // seeded agent pause
  assert.equal(listRes.body.pauses[0].scopeType, "agent");
});

test("set pause validates scope/reason allowlists and rejects secret-bearing approval ids", async () => {
  const resilience = new FakeResilienceRepository();
  const app = makeApp({ resilience });
  const { token, csrfToken } = await startSession(app);
  const auth = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const badScope = await request(app)
    .post("/control/pauses")
    .set(auth)
    .send({ scopeType: "everything", reasonCode: "OWNER_REQUEST", approvalId: "a" })
    .expect(400);
  assert.equal(badScope.body.error, "PAUSE_SCOPE_INVALID");

  const badReason = await request(app)
    .post("/control/pauses")
    .set(auth)
    .send({ scopeType: "agent", agentId: "agent-01", reasonCode: "WHY_NOT", approvalId: "a" })
    .expect(400);
  assert.equal(badReason.body.error, "PAUSE_REASON_INVALID");

  const secretApproval = await request(app)
    .post("/control/pauses")
    .set(auth)
    .send({ scopeType: "global_owner", reasonCode: "OWNER_REQUEST", approvalId: "vault://st/secret" })
    .expect(400);
  assert.equal(secretApproval.body.error, "APPROVAL_ID_INVALID");

  const missingAgent = await request(app)
    .post("/control/pauses")
    .set(auth)
    .send({ scopeType: "agent", reasonCode: "OWNER_REQUEST", approvalId: "a" })
    .expect(400);
  assert.equal(missingAgent.body.error, "AGENT_ID_INVALID");
  assert.equal(resilience.setCalls.length, 0);
});

test("clear pause requires an approval id and delegates to the resilience repository", async () => {
  const resilience = new FakeResilienceRepository();
  const db = new MemoryDbAdapter();
  const app = makeApp({ resilience, db });
  const { token, csrfToken } = await startSession(app);
  const auth = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const missing = await request(app)
    .post(`/control/pauses/${PAUSE_ID_SEED}/clear`)
    .set(auth)
    .send({})
    .expect(400);
  assert.equal(missing.body.error, "APPROVAL_ID_INVALID");

  const res = await request(app)
    .post(`/control/pauses/${PAUSE_ID_SEED}/clear`)
    .set(auth)
    .send({ approvalId: "approval-2026" })
    .expect(200);
  assert.equal(res.body.pause.active, false);
  assert.equal(resilience.clearCalls.length, 1);
  assert.equal(db.auditRows.filter((row) => row.action === "emergency_pause_cleared").length, 1);
});

test("malformed pause ids yield a clean 400", async () => {
  const app = makeApp();
  const { token, csrfToken } = await startSession(app);
  const res = await request(app)
    .post("/control/pauses/abc/clear")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({ approvalId: "approval-2026" })
    .expect(400);
  assert.equal(res.body.error, "PAUSE_ID_INVALID");
});

// ---------------------------------------------------------------------------
// Honest degradation of dependencies
// ---------------------------------------------------------------------------

test("pause mutations degrade honestly with 503 when the resilience repository is unavailable", async () => {
  const app = makeApp({ resilience: null });
  const { token, csrfToken } = await startSession(app);
  const res = await request(app)
    .post("/control/pauses")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({ scopeType: "global_owner", reasonCode: "OWNER_REQUEST", approvalId: "approval-2026" })
    .expect(503);
  assert.equal(res.body.error, "RESILIENCE_REPOSITORY_UNAVAILABLE");
});

test("pause mutations degrade honestly with 503 when the audit database is unavailable", async () => {
  const app = makeApp({ db: null });
  const { token, csrfToken } = await startSession(app);
  const res = await request(app)
    .post("/control/pauses")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({ scopeType: "global_owner", reasonCode: "OWNER_REQUEST", approvalId: "approval-2026" })
    .expect(503);
  assert.equal(res.body.error, "DATABASE_ADAPTER_UNAVAILABLE");
});

test("control routes degrade honestly with 503 when no job control store is configured", async () => {
  const app = createOwnerApp({ bootstrapToken: VALID_BOOTSTRAP_TOKEN, bootstrapOwnerId: "owner-alpha" });
  const res = await request(app)
    .post("/session/start")
    .send({ token: VALID_BOOTSTRAP_TOKEN })
    .expect(200);
  const auth = { Authorization: `Bearer ${res.body.token}`, "x-csrf-token": res.body.csrfToken };
  const resRetry = await request(app).post(`/control/jobs/${JOB_ID_A}/retry`).set(auth).send({}).expect(503);
  assert.equal(resRetry.body.error, "JOB_CONTROL_STORE_UNAVAILABLE");
  const resApprovals = await request(app).get("/control/approvals").set(auth).expect(503);
  assert.equal(resApprovals.body.error, "JOB_CONTROL_STORE_UNAVAILABLE");
});

// ---------------------------------------------------------------------------
// Migration file sanity (R1: append-only file exists, additive)
// ---------------------------------------------------------------------------

test("migration 017 adds the owner_cancelled status and audit table additively", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../sql/017_owner_job_control.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'owner_cancelled'"));
  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS owner_control_audit"));
  assert.ok(!sql.includes("DROP TABLE")); // additive only
  assert.ok(!sql.includes("DELETE FROM")); // never destroys data
});
