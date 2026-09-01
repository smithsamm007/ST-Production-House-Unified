import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createOwnerApp } from "../src/api/ownerServer.js";

const VALID_BOOTSTRAP_TOKEN = "0123456789abcdef0123456789abcdef"; // 32 bytes

test("GET /healthz returns 200 {ok: true} without authentication", async () => {
  const app = createOwnerApp();
  const res = await request(app).get("/healthz").expect(200);
  assert.deepEqual(res.body, { ok: true });
});

test("POST /session/start fails if env/option STPH_BOOTSTRAP_TOKEN is invalid or <32 bytes", async () => {
  const app = createOwnerApp({ bootstrapToken: "short_token" });
  const res = await request(app)
    .post("/session/start")
    .send({ token: "short_token" })
    .expect(401);
  assert.equal(res.body.error, "UNAUTHORIZED");
});

test("POST /session/start fails with wrong bootstrap token", async () => {
  const app = createOwnerApp({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });
  const res = await request(app)
    .post("/session/start")
    .send({ token: "wrong_bootstrap_token_1234567890123" })
    .expect(401);
  assert.equal(res.body.error, "UNAUTHORIZED");
});

test("POST /session/start succeeds with valid bootstrap token and issues session token", async () => {
  const app = createOwnerApp({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });
  const res = await request(app)
    .post("/session/start")
    .send({ bootstrapToken: VALID_BOOTSTRAP_TOKEN })
    .expect(200);

  assert.equal(res.body.status, "success");
  assert.ok(res.body.token);
  assert.equal(res.body.token.length, 64); // 32 bytes hex = 64 characters
  assert.ok(res.body.expiresAt);
});

test("requireAuth middleware blocks unauthenticated requests to /agents and /charters", async () => {
  const app = createOwnerApp({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });

  const resAgents = await request(app).get("/agents").expect(401);
  assert.equal(resAgents.body.error, "UNAUTHORIZED");

  const resCharters = await request(app).get("/charters").expect(401);
  assert.equal(resCharters.body.error, "UNAUTHORIZED");
});

test("requireAuth middleware allows access with valid session token", async () => {
  const app = createOwnerApp({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });

  const startRes = await request(app)
    .post("/session/start")
    .send({ token: VALID_BOOTSTRAP_TOKEN })
    .expect(200);

  const sessionToken = startRes.body.token;

  const agentsRes = await request(app)
    .get("/agents")
    .set("Authorization", `Bearer ${sessionToken}`)
    .expect(200);

  assert.ok(Array.isArray(agentsRes.body));
  assert.ok(agentsRes.body.length > 0);

  const chartersRes = await request(app)
    .get("/charters")
    .set("Authorization", `Bearer ${sessionToken}`)
    .expect(200);

  assert.ok(Array.isArray(chartersRes.body));
  assert.ok(chartersRes.body.length > 0);
});

test("requireAuth rejects expired session tokens", async () => {
  // Set TTL to -1ms so session immediately expires
  const app = createOwnerApp({ bootstrapToken: VALID_BOOTSTRAP_TOKEN, ttlMs: -1 });

  const startRes = await request(app)
    .post("/session/start")
    .send({ token: VALID_BOOTSTRAP_TOKEN })
    .expect(200);

  const sessionToken = startRes.body.token;

  const agentsRes = await request(app)
    .get("/agents")
    .set("Authorization", `Bearer ${sessionToken}`)
    .expect(401);

  assert.equal(agentsRes.body.error, "UNAUTHORIZED");
});

test("Per-IP rate limiter triggers 429 on 4th bad attempt within 1 minute", async () => {
  const app = createOwnerApp({ bootstrapToken: VALID_BOOTSTRAP_TOKEN });

  // 3 bad attempts (401)
  await request(app).get("/agents").expect(401);
  await request(app).get("/agents").set("Authorization", "Bearer bad1").expect(401);
  await request(app).get("/agents").set("Authorization", "Bearer bad2").expect(401);

  // 4th bad attempt -> 429
  const res = await request(app).get("/agents").set("Authorization", "Bearer bad3").expect(429);
  assert.equal(res.body.error, "TOO_MANY_REQUESTS");
});

test("Unknown endpoints return generic 404 without stack traces", async () => {
  const app = createOwnerApp();
  const res = await request(app).get("/unknown-route-123").expect(404);
  assert.deepEqual(res.body, { error: "NOT_FOUND" });
});
