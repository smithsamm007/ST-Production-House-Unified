/**
 * Director Workspace API tests — boots the labeled demo-backed app (same
 * truthful non-durable adapter used by previews), logs the seeded demo owner
 * in, and exercises the communication window, roadmap and memory routes.
 *
 * The env var must be set before the app module loads, so this file uses a
 * dynamic import. Node --test runs each file in its own process.
 */

process.env.STPH_DEMO_STORAGE = "1";

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const supertest = (await import("supertest")).default;
const { default: app, configureRuntime, finalizeRuntimeStartup } = await import("../src/catalog/server.js");

await configureRuntime();
await finalizeRuntimeStartup();

const DEMO_EMAIL = "owner@stproduction.demo";
const DEMO_PASSWORD = process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026";

const login = await supertest(app)
  .post("/api/auth/login")
  .send({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
assert.equal(login.status, 200, "demo owner login must succeed");

const cookieHeader = login.headers["set-cookie"]?.[0] ?? "";
const sessionToken = /session_token=([^;]+)/.exec(cookieHeader)?.[1] ?? "";
assert.ok(sessionToken, "login must set the session cookie");
const bearerAuth = { Authorization: `Bearer ${sessionToken}` };

test("communication window is authenticated and lazily created", async () => {
  const anon = await supertest(app).get("/api/directors/agent-01/conversation").expect(401);
  assert.equal(anon.body.error, "SESSION_TOKEN_REQUIRED");

  const created = await supertest(app)
    .get("/api/directors/agent-01/conversation")
    .set(bearerAuth)
    .expect(200);
  assert.ok(created.body.conversation.id, "window row is returned");
  assert.ok(Array.isArray(created.body.messages));

  const again = await supertest(app)
    .get("/api/directors/agent-01/conversation")
    .set(bearerAuth)
    .expect(200);
  assert.equal(again.body.conversation.id, created.body.conversation.id, "same persistent window");
});

test("messages round-trip with explicit kinds and reject unknown kinds", async () => {
  const recorded = await supertest(app)
    .post("/api/directors/agent-01/conversation")
    .set(bearerAuth)
    .send({ sender: "owner", kind: "conversation", body: "I want to introduce a new supernatural character." })
    .expect(201);
  assert.equal(recorded.body.kind, "conversation");

  const decision = await supertest(app)
    .post("/api/directors/agent-01/conversation")
    .set(bearerAuth)
    .send({ sender: "owner", kind: "decision", body: "Approved. Add it to the roadmap." })
    .expect(201);
  assert.equal(decision.body.kind, "decision");

  await supertest(app)
    .post("/api/directors/agent-01/conversation")
    .set(bearerAuth)
    .send({ sender: "owner", kind: "command", body: "publish everything now" })
    .expect(400, { error: "MESSAGE_VALIDATION_FAILED" });

  const history = await supertest(app)
    .get("/api/directors/agent-01/conversation")
    .set(bearerAuth)
    .expect(200);
  const kinds = history.body.messages.map((m) => m.kind);
  assert.ok(kinds.includes("conversation") && kinds.includes("decision"), "history persists");
});

test("roadmap buckets work end to end including the status lifecycle", async () => {
  const added = await supertest(app)
    .post("/api/directors/agent-01/roadmap")
    .set(bearerAuth)
    .send({ bucket: "next", title: "New character arc" })
    .expect(201);
  assert.equal(added.body.status, "open");

  const filtered = await supertest(app)
    .get("/api/directors/agent-01/roadmap?bucket=next")
    .set(bearerAuth)
    .expect(200);
  assert.ok(filtered.body.items.some((item) => item.id === added.body.id));

  const moved = await supertest(app)
    .patch(`/api/directors/roadmap/${added.body.id}`)
    .set(bearerAuth)
    .send({ status: "accepted" })
    .expect(200);
  assert.equal(moved.body.status, "accepted");

  await supertest(app)
    .post("/api/directors/agent-01/roadmap")
    .set(bearerAuth)
    .send({ bucket: "someday", title: "invalid" })
    .expect(400, { error: "ROADMAP_VALIDATION_FAILED" });

  await supertest(app)
    .patch("/api/directors/roadmap/00000000-0000-0000-0000-000000000000")
    .set(bearerAuth)
    .send({ status: "done" })
    .expect(404);
});

test("memory routes upsert isolated categories and validate input", async () => {
  const saved = await supertest(app)
    .put("/api/directors/agent-01/memory/characters")
    .set(bearerAuth)
    .send({ content: { name: "Vira", constraint: "morally ambiguous" } })
    .expect(200);
  assert.equal(saved.body.category, "characters");

  const listed = await supertest(app)
    .get("/api/directors/agent-01/memory")
    .set(bearerAuth)
    .expect(200);
  assert.ok(listed.body.entries.some((entry) => entry.category === "characters"));

  await supertest(app)
    .put("/api/directors/agent-01/memory/diaries")
    .set(bearerAuth)
    .send({ content: {} })
    .expect(400, { error: "MEMORY_VALIDATION_FAILED" });
});

test("unknown director resolves to 404, never to another director's data", async () => {
  await supertest(app)
    .get("/api/directors/agent-does-not-exist/conversation")
    .set(bearerAuth)
    .expect(404, { error: "AGENT_NOT_FOUND" });
  await supertest(app)
    .get("/api/directors/agent-does-not-exist/memory")
    .set(bearerAuth)
    .expect(404, { error: "AGENT_NOT_FOUND" });
});
