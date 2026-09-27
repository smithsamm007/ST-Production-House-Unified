import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createOwnerApp } from "../src/api/ownerServer.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

const VALID_BOOTSTRAP_TOKEN = "0123456789abcdef0123456789abcdef"; // 32 bytes
const VALID_ARTIFACT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const AGENT_ID = "agent-01";

// ---------------------------------------------------------------------------
// Server-side fixtures: transports and stores. None of these are reachable
// from request bodies by contract — the tests assert that too.
// ---------------------------------------------------------------------------

/** Resolves the owner's configured 4-slot provider policy for one agent. */
class FakeProviderSmokeTransport {
  constructor({ slotsByAgent = null, failResolve = false } = {}) {
    this.calls = [];
    this.failResolve = failResolve;
    this.slotsByAgent = slotsByAgent;
  }
  async getTaskProviderSlots({ ownerId, agentId }) {
    this.calls.push({ ownerId, agentId });
    if (this.failResolve) throw new Error("SECRET_MANAGER_DOWN");
    if (this.slotsByAgent) return this.slotsByAgent;
    return [
      { slot: "primary", kind: "remote", provider: "p_remote_1", credentialRef: { agentId, slot: "primary", secretLocator: "vault://secret1" } },
      { slot: "secondary", kind: "remote", provider: "p_remote_2", credentialRef: { agentId, slot: "secondary", secretLocator: "opaque://secret2" } },
      { slot: "tertiary", kind: "remote", provider: "p_remote_3", credentialRef: { agentId, slot: "tertiary", secretLocator: "vault://secret3" } },
      { slot: "open_source_emergency", kind: "local_open_source", provider: "p_local_fallback", credentialRef: null },
    ];
  }
  // Executor shape: invoked by runProviderSmokeTest per slot.
  async execute(args) {
    return this.executor(args);
  }
}

function okRemoteExecutor() {
  return async ({ slot }) => {
    if (slot === "primary") {
      return {
        providerResponseId: "pr_resp_ok_1",
        providerResponseSha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        output: "SMOKE_OK",
      };
    }
    throw new Error("UNEXPECTED_SLOT_CALL");
  };
}

/** Genuine private-first publisher receipt (Rule 1 evidence). */
const okPublisher = {
  publish: async () => ({
    platformPostId: "yt_priv_1001",
    platformUrl: "https://youtube.com/watch?v=yt_priv_1001",
    rawResponse: JSON.stringify({ privacy: "private", id: "yt_priv_1001" }),
  }),
};

function publishingIdentity(agentId = AGENT_ID) {
  return {
    agentId,
    agent: { id: agentId, name: "InternalNameNeverPublic" },
    // Profile-only identity path: active status + a public brand name that
    // never collides with the internal agent name (Rule 15).
    profile: {
      agentId,
      publicBrandName: "Public Studio Brand",
      publicDisplayName: "Studio Brand",
      status: "active",
    },
    primarySocialAccount: null,
  };
}

class MemoryOpsDb {
  constructor() {
    this.name = "MemoryOpsDb";
    this.auditRows = [];
    this.analyticsRows = [];
  }
  async query(text, params) {
    if (text.startsWith("INSERT INTO owner_control_audit")) {
      this.auditRows.push({
        ownerId: params[0],
        agentId: params[1],
        action: params[2],
        detail: JSON.parse(params[3]),
      });
      return { rowCount: 1, rows: [] };
    }
    // Durable analytics table (sql/027) emulation: same contract the demo
    // adapter satisfies for the repository's single-table SQL subset.
    if (text.startsWith("INSERT INTO owner_analytics_records")) {
      const row = {
        id: this.analyticsRows.length + 1,
        record_id: params[0],
        owner_id: params[1],
        agent_id: params[2],
        platform_post_id: params[3],
        platform_url: params[4],
        platform: params[5],
        views: Number(params[6]),
        watch_time_seconds: Number(params[7]),
        likes: Number(params[8]),
        shares: Number(params[9]),
        comments_count: Number(params[10]),
        impressions: Number(params[11]),
        metadata: params[12],
        collected_at: params[13],
      };
      this.analyticsRows.push(row);
      return { rowCount: 1, rows: [row] };
    }
    if (text.startsWith("SELECT * FROM owner_analytics_records")) {
      let rows = [...this.analyticsRows];
      const recordIdMatch = text.match(/record_id = \$(\d+)/);
      if (recordIdMatch) rows = rows.filter((r) => r.record_id === params[Number(recordIdMatch[1]) - 1]);
      const ownerMatch = text.match(/owner_id = \$(\d+)/);
      if (ownerMatch) rows = rows.filter((r) => r.owner_id === params[Number(ownerMatch[1]) - 1]);
      const limitMatch = text.match(/LIMIT (\d+)/);
      if (limitMatch) rows = rows.slice(0, Number(limitMatch[1]));
      return { rowCount: rows.length, rows };
    }
    throw new Error(`MEMORY_DB_UNEXPECTED_QUERY: ${text.slice(0, 40)}`);
  }
}

// ---------------------------------------------------------------------------
// App/session bootstrap helpers
// ---------------------------------------------------------------------------

async function createSession(app) {
  const res = await request(app)
    .post("/session/start")
    .send({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });
  assert.equal(res.status, 200);
  return { token: res.body.token, csrfToken: res.body.csrfToken };
}

function buildApp(overrides = {}) {
  const evidenceLedger = overrides.evidenceLedger ?? new EvidenceLedger();
  const db = overrides.db ?? new MemoryOpsDb();
  const app = createOwnerApp({
    bootstrapToken: VALID_BOOTSTRAP_TOKEN,
    bootstrapOwnerId: "owner-alpha",
    evidenceLedger,
    dbAdapter: db,
    ...overrides,
  });
  return { app, evidenceLedger, db };
}

// ---------------------------------------------------------------------------
// POST /ops/providers/:agentId/smoke-test
// ---------------------------------------------------------------------------

test("provider smoke test route: requires authentication", async () => {
  const { app } = buildApp({ providerSmokeTransport: new FakeProviderSmokeTransport() });
  const res = await request(app).post(`/ops/providers/${AGENT_ID}/smoke-test`).send({});
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "UNAUTHORIZED");
});

test("provider smoke test route: requires a valid CSRF token", async () => {
  const { app } = buildApp({ providerSmokeTransport: new FakeProviderSmokeTransport() });
  const { token } = await createSession(app);
  const res = await request(app)
    .post(`/ops/providers/${AGENT_ID}/smoke-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", "not-the-real-token-value")
    .send({});
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "CSRF_TOKEN_INVALID");
});

test("provider smoke test route: runs with server-side transport, records audit + evidence, and serializes the allowlist DTO", async () => {
  const transport = new FakeProviderSmokeTransport();
  transport.executor = okRemoteExecutor();
  const { app, db, evidenceLedger } = buildApp({ providerSmokeTransport: transport });
  const { token, csrfToken } = await createSession(app);

  const res = await request(app)
    .post(`/ops/providers/${AGENT_ID}/smoke-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({});

  assert.equal(res.status, 200);
  const smoke = res.body.smokeTest;
  assert.equal(smoke.status, "verified_success");
  assert.equal(smoke.selectedSlot, "primary");
  assert.equal(smoke.selectedProvider, "p_remote_1");
  assert.equal(smoke.receipt.providerResponseId, "pr_resp_ok_1");
  // DTO allowlist: only attempt evidence, no raw provider payloads or
  // credential material.
  assert.deepEqual(Object.keys(smoke).sort(), [
    "agentId", "attempts", "receipt", "selectedProvider", "selectedSlot", "smokeTestId", "status", "taskId",
  ]);
  assert.deepEqual(Object.keys(smoke.attempts[0]).sort(), ["errorCode", "kind", "outcome", "provider", "slot"]);

  // Transport resolved slots for the SESSION owner + requested agent only.
  assert.deepEqual(transport.calls, [{ ownerId: "owner-alpha", agentId: AGENT_ID }]);

  // Rule 6 audit + evidence.
  assert.equal(db.auditRows.length, 1);
  assert.equal(db.auditRows[0].action, "provider_smoke_test");
  assert.equal(db.auditRows[0].ownerId, "owner-alpha");
  assert.equal(db.auditRows[0].agentId, AGENT_ID);
  const kinds = evidenceLedger.list().map((e) => e.kind);
  assert.ok(kinds.includes("owner_provider_smoke_test"));
  assert.ok(kinds.includes("provider_smoke_test"));
});

test("provider smoke test route: degrades honestly with 503 when the transport is not configured", async () => {
  const { app } = buildApp({});
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post(`/ops/providers/${AGENT_ID}/smoke-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "PROVIDER_SMOKE_TRANSPORT_UNAVAILABLE");
});

test("provider smoke test route: transport resolution failure is an honest 503, never a fabricated run", async () => {
  const transport = new FakeProviderSmokeTransport({ failResolve: true });
  const { app } = buildApp({ providerSmokeTransport: transport });
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post(`/ops/providers/${AGENT_ID}/smoke-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "PROVIDER_SMOKE_TRANSPORT_UNAVAILABLE");
  // Secret-manager internals never leak into the response body.
  assert.ok(!JSON.stringify(res.body).includes("SECRET_MANAGER_DOWN"));
});

test("provider smoke test route: rejects client-supplied slots/executor/credentialRef (client-driven execution forbidden)", async () => {
  const transport = new FakeProviderSmokeTransport();
  transport.executor = okRemoteExecutor();
  const { app } = buildApp({ providerSmokeTransport: transport });
  const { token, csrfToken } = await createSession(app);

  for (const poisoned of [
    { slots: [] },
    { executor: "console" },
    { transport: "http://attacker" },
    { credentialRef: { agentId: AGENT_ID, slot: "primary", secretLocator: "vault://evil" } },
  ]) {
    const res = await request(app)
      .post(`/ops/providers/${AGENT_ID}/smoke-test`)
      .set("Authorization", `Bearer ${token}`)
      .set("x-csrf-token", csrfToken)
      .send(poisoned);
    assert.equal(res.status, 400, JSON.stringify(poisoned));
    assert.equal(res.body.error, "CLIENT_TRANSPORT_FORBIDDEN");
  }
  // Nothing executed, nothing audited.
  assert.equal(transport.calls.length, 0);
});

test("provider smoke test route: cross-agent slot layout fails closed (invalid provider policy → 422)", async () => {
  // Slots for a DIFFERENT agent: the broker policy check must reject them.
  // The service surfaces a stable INVALID_PROVIDER_POLICY code — it never
  // details WHY a slot layout is invalid (no configuration oracle).
  const foreignSlots = [
    { slot: "primary", kind: "remote", provider: "p_remote_1", credentialRef: { agentId: "agent-99", slot: "primary", secretLocator: "vault://s1" } },
    { slot: "secondary", kind: "remote", provider: "p_remote_2", credentialRef: { agentId: AGENT_ID, slot: "secondary", secretLocator: "vault://s2" } },
    { slot: "tertiary", kind: "remote", provider: "p_remote_3", credentialRef: { agentId: AGENT_ID, slot: "tertiary", secretLocator: "vault://s3" } },
    { slot: "open_source_emergency", kind: "local_open_source", provider: "p_local_fallback", credentialRef: null },
  ];
  const transport = new FakeProviderSmokeTransport({ slotsByAgent: foreignSlots });
  transport.executor = okRemoteExecutor();
  const { app, db } = buildApp({ providerSmokeTransport: transport });
  const { token, csrfToken } = await createSession(app);

  const res = await request(app)
    .post(`/ops/providers/${AGENT_ID}/smoke-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({});

  assert.equal(res.status, 422);
  assert.equal(res.body.error, "INVALID_PROVIDER_POLICY");
  // No success is ever recorded for a failed verification pass.
  assert.equal(db.auditRows.length, 0);
});

test("provider smoke test route: all providers failing yields a truthful 422, never a fabricated success", async () => {
  const transport = new FakeProviderSmokeTransport();
  transport.executor = async () => { throw new Error("REMOTE_DOWN"); };
  const { app, db } = buildApp({ providerSmokeTransport: transport });
  const { token, csrfToken } = await createSession(app);

  const res = await request(app)
    .post(`/ops/providers/${AGENT_ID}/smoke-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({});

  assert.equal(res.status, 422);
  assert.equal(res.body.error, "ALL_PROVIDERS_FAILED");
  assert.equal(db.auditRows.length, 0);
});

// ---------------------------------------------------------------------------
// POST /ops/publishing/:agentId/private-test
// ---------------------------------------------------------------------------

test("private publishing test route: runs private-first with server-resolved identity, audit, and evidence", async () => {
  const { app, db, evidenceLedger } = buildApp({
    publishingPublisher: okPublisher,
    resolvePublishingIdentity: async ({ ownerId, agentId, destination }) => {
      assert.equal(ownerId, "owner-alpha");
      assert.equal(agentId, AGENT_ID);
      assert.equal(destination, "youtube");
      return publishingIdentity();
    },
  });
  const { token, csrfToken } = await createSession(app);

  const res = await request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      artifactSha256: VALID_ARTIFACT_HASH,
      destination: "youtube",
      captionSnapshot: { text: "Private-first test Reel" },
    });

  assert.equal(res.status, 200);
  const body = res.body.publishingTest;
  assert.equal(body.status, "platform_verified");
  assert.equal(body.published, true);
  assert.equal(body.mode, "private");
  assert.equal(body.publicAttribution, "Public Studio Brand");
  assert.deepEqual(Object.keys(body).sort(), [
    "agentId", "destination", "mode", "platformPostId", "platformUrl", "providerResponseSha256", "publicAttribution", "published", "requestId", "status", "testId",
  ]);

  assert.equal(db.auditRows.length, 1);
  assert.equal(db.auditRows[0].action, "private_publishing_test");
  const kinds = evidenceLedger.list().map((e) => e.kind);
  assert.ok(kinds.includes("owner_private_publishing_test"));
  assert.ok(kinds.includes("platform_publish"));
});

test("private publishing test route: public mode is rejected (private-first only)", async () => {
  const { app } = buildApp({ publishingPublisher: okPublisher });
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      artifactSha256: VALID_ARTIFACT_HASH,
      destination: "youtube",
      captionSnapshot: { text: "should not happen" },
      mode: "public",
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "PRIVATE_FIRST_MODE_REQUIRED");
});

test("private publishing test route: invalid artifact hash and unsupported destinations are rejected", async () => {
  const { app } = buildApp({ publishingPublisher: okPublisher });
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const badHash = await request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set(headers)
    .send({ artifactSha256: "deadbeef", destination: "youtube", captionSnapshot: {} });
  assert.equal(badHash.status, 400);
  assert.equal(badHash.body.error, "VERIFIED_ARTIFACT_REQUIRED");

  const badPlatform = await request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set(headers)
    .send({ artifactSha256: VALID_ARTIFACT_HASH, destination: "tiktok", captionSnapshot: {} });
  assert.equal(badPlatform.status, 400);
  assert.equal(badPlatform.body.error, "INVALID_PLATFORM_DESTINATION");
});

test("private publishing test route: internal agent names in captions are blocked (Rule 15) with a clean 422", async () => {
  const { app, db } = buildApp({
    publishingPublisher: okPublisher,
    resolvePublishingIdentity: async () => publishingIdentity(),
  });
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      artifactSha256: VALID_ARTIFACT_HASH,
      destination: "youtube",
      captionSnapshot: { text: "made by JARVIS" },
    });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "AGENT_NAME_LEAKAGE_DENIED");
  assert.equal(db.auditRows.length, 0);
});

test("private publishing test route: unconfigured publisher degrades honestly (503)", async () => {
  const { app } = buildApp({});
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      artifactSha256: VALID_ARTIFACT_HASH,
      destination: "youtube",
      captionSnapshot: { text: "private test" },
    });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "PUBLISHING_TRANSPORT_UNAVAILABLE");
});

test("private publishing test route: unresolved public identity fails closed (422) and never fabricates attribution", async () => {
  const { app, db } = buildApp({ publishingPublisher: okPublisher });
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      artifactSha256: VALID_ARTIFACT_HASH,
      destination: "youtube",
      captionSnapshot: { text: "private test" },
    });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
  assert.equal(db.auditRows.length, 0);
});

test("private publishing test route: publisher and publishingService cannot come from the request", async () => {
  const { app } = buildApp({ publishingPublisher: okPublisher });
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post(`/ops/publishing/${AGENT_ID}/private-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      artifactSha256: VALID_ARTIFACT_HASH,
      destination: "youtube",
      captionSnapshot: {},
      publisher: { publish: async () => ({}) },
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "CLIENT_TRANSPORT_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// POST /ops/analytics/ingest + GET /ops/analytics
// ---------------------------------------------------------------------------

test("analytics ingest: records genuine metrics with audit row and reads back owner-scoped", async () => {
  const { app, db } = buildApp({});
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const res = await request(app)
    .post("/ops/analytics/ingest")
    .set(headers)
    .send({
      platformPostId: "yt_post_777",
      platformUrl: "https://youtube.com/watch?v=yt_post_777",
      platform: "youtube",
      metrics: { views: 1200, likes: 40 },
    });
  assert.equal(res.status, 201);
  const record = res.body.record;
  assert.equal(record.platformPostId, "yt_post_777");
  assert.equal(record.metrics.views, 1200);
  assert.equal(record.metrics.likes, 40);
  assert.equal(record.metrics.shares, 0); // missing metrics zero-fill honestly
  assert.deepEqual(Object.keys(record).sort(), [
    "collectedAt", "metrics", "ownerId", "platform", "platformPostId", "platformUrl", "recordId",
  ]);
  assert.equal(db.auditRows.length, 1);
  assert.equal(db.auditRows[0].action, "analytics_ingest");  const read = await request(app).get("/ops/analytics").set("Authorization", `Bearer ${token}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.count, 1);
  assert.equal(read.body.records[0].platformPostId, "yt_post_777");
  // The metadata field never serializes (internal capture only, Rule 17).
  assert.ok(!( "metadata" in read.body.records[0]));

  // DURABILITY (Issue #194): the row lives in the DB adapter, not a
  // process Map — a completely FRESH router+service over the same adapter
  // reads the same record back.
  const freshApp = createOwnerApp({
    bootstrapToken: VALID_BOOTSTRAP_TOKEN,
    bootstrapOwnerId: "owner-alpha",
    dbAdapter: db,
  });
  const freshSession = await request(freshApp)
    .post("/session/start")
    .send({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });
  const freshRead = await request(freshApp)
    .get("/ops/analytics")
    .set("Authorization", `Bearer ${freshSession.body.token}`);
  assert.equal(freshRead.status, 200);
  assert.equal(freshRead.body.count, 1);
  assert.equal(freshRead.body.records[0].recordId, record.recordId);
});

test("analytics ingest: negative or non-integer metrics are rejected (no invented numbers)", async () => {
  const { app } = buildApp({});
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const negative = await request(app)
    .post("/ops/analytics/ingest")
    .set(headers)
    .send({
      platformPostId: "yt_post_778",
      platformUrl: "https://youtube.com/watch?v=yt_post_778",
      platform: "youtube",
      metrics: { views: -5 },
    });
  assert.equal(negative.status, 422);
  assert.equal(negative.body.error, "INVALID_ANALYTICS_METRICS");

  const fractional = await request(app)
    .post("/ops/analytics/ingest")
    .set(headers)
    .send({
      platformPostId: "yt_post_779",
      platformUrl: "https://youtube.com/watch?v=yt_post_779",
      platform: "youtube",
      metrics: { views: 1.5 },
    });
  assert.equal(fractional.status, 422);
  assert.equal(fractional.body.error, "INVALID_ANALYTICS_METRICS");
});

test("analytics ingest: non-HTTPS platform URLs are rejected", async () => {
  const { app } = buildApp({});
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post("/ops/analytics/ingest")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      platformPostId: "yt_post_780",
      platformUrl: "http://youtube.com/watch?v=yt_post_780",
      platform: "youtube",
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_PLATFORM_URL");
});

test("analytics ingest: internal agent names and secret locators in metadata are blocked (Rules 15/17)", async () => {
  const { app, db } = buildApp({});
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const leak = await request(app)
    .post("/ops/analytics/ingest")
    .set(headers)
    .send({
      platformPostId: "yt_post_781",
      platformUrl: "https://youtube.com/watch?v=yt_post_781",
      platform: "youtube",
      metadata: { note: "created by SHERLOCK" },
    });
  assert.equal(leak.status, 422);
  assert.equal(leak.body.error, "AGENT_NAME_LEAKAGE_DENIED");

  const secret = await request(app)
    .post("/ops/analytics/ingest")
    .set(headers)
    .send({
      platformPostId: "yt_post_782",
      platformUrl: "https://youtube.com/watch?v=yt_post_782",
      platform: "youtube",
      metadata: { key: "vault://secret" },
    });
  assert.equal(secret.status, 422);
  assert.equal(secret.body.error, "SECRET_LEAKAGE_DENIED");
  assert.equal(db.auditRows.length, 0);
});

// ---------------------------------------------------------------------------
// Cross-cutting owner scoping
// ---------------------------------------------------------------------------

test("analytics ingest with failing storage degrades honestly (503), never a fabricated write", async () => {
  const failingDb = {
    name: "FailingOpsDb",
    async query(text) {
      if (text.startsWith("INSERT INTO owner_analytics_records")) {
        throw new Error("PG_CONNECTION_RESET");
      }
      throw new Error(`MEMORY_DB_UNEXPECTED_QUERY: ${text.slice(0, 40)}`);
    },
  };
  const { app } = buildApp({ dbAdapter: failingDb });
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post("/ops/analytics/ingest")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({
      platformPostId: "yt_post_fail",
      platformUrl: "https://youtube.com/watch?v=yt_post_fail",
      platform: "youtube",
      metrics: { views: 5 },
    });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "INTERNAL_SERVER_ERROR");
});

test("client-supplied ownerId mismatch is rejected (server-authoritative scoping)", async () => {
  const transport = new FakeProviderSmokeTransport();
  transport.executor = okRemoteExecutor();
  const { app } = buildApp({ providerSmokeTransport: transport });
  const { token, csrfToken } = await createSession(app);
  const headers = { Authorization: `Bearer ${token}`, "x-csrf-token": csrfToken };

  const smoke = await request(app)
    .post(`/ops/providers/${AGENT_ID}/smoke-test`)
    .set(headers)
    .send({ ownerId: "owner-beta" });
  assert.equal(smoke.status, 403);
  assert.equal(smoke.body.error, "SCOPE_MISMATCH");

  const ingest = await request(app)
    .post("/ops/analytics/ingest")
    .set(headers)
    .send({
      ownerId: "owner-beta",
      platformPostId: "yt_post_783",
      platformUrl: "https://youtube.com/watch?v=yt_post_783",
      platform: "youtube",
    });
  assert.equal(ingest.status, 403);
  assert.equal(ingest.body.error, "SCOPE_MISMATCH");
});

test("unavailable audit adapter degrades honestly with 503 (no silent mutations)", async () => {
  const transport = new FakeProviderSmokeTransport();
  transport.executor = okRemoteExecutor();
  // dbAdapter: null flows through the overrides spread (no audit store).
  const { app } = buildApp({ providerSmokeTransport: transport, dbAdapter: null });
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post(`/ops/providers/${AGENT_ID}/smoke-test`)
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "DATABASE_ADAPTER_UNAVAILABLE");
});

test("invalid agent id parameter fails closed", async () => {
  const { app } = buildApp({ providerSmokeTransport: new FakeProviderSmokeTransport() });
  const { token, csrfToken } = await createSession(app);
  const res = await request(app)
    .post("/ops/providers/not%20valid!!/smoke-test")
    .set("Authorization", `Bearer ${token}`)
    .set("x-csrf-token", csrfToken)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "AGENT_ID_INVALID");
});
