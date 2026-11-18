/**
 * Director Communication — abuse protection.
 *
 * The comm endpoints spend provider quota per call, so they carry a tighter
 * limiter than the global API bucket. This file runs with a limit of two to
 * prove 429 behaviour without sending a provider request (no key is configured,
 * so each accepted message is honestly recorded as PROVIDER_UNAVAILABLE).
 */
process.env.STPH_DEMO_STORAGE = "1";
process.env.DIRECTOR_COMM_RATE_LIMIT_PER_MINUTE = "2";
delete process.env.GEMINI_API_KEY;

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const supertest = (await import("supertest")).default;
const { default: app, configureRuntime, finalizeRuntimeStartup } = await import(
  "../src/catalog/server.js"
);

await configureRuntime();
await finalizeRuntimeStartup();

const login = await supertest(app)
  .post("/api/auth/login")
  .send({
    email: "owner@stproduction.demo",
    password: process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026",
  });
assert.equal(login.status, 200);
const token = /session_token=([^;]+)/.exec(login.headers["set-cookie"]?.[0] ?? "")?.[1] ?? "";
assert.ok(token, "login must set the session cookie");
const auth = { Authorization: `Bearer ${token}` };

const agents = await supertest(app).get("/api/agents").set(auth);
const agentId = (Array.isArray(agents.body) ? agents.body : agents.body.agents ?? [])[0]?.id;
assert.ok(agentId, "demo storage must seed a Director");

test("the Director communication limiter rejects the third message in the window", async () => {
  const send = (index) =>
    supertest(app)
      .post(`/api/director-comm/${agentId}/messages`)
      .set({ ...auth, "Content-Type": "application/json" })
      .send({ body: `message ${index}`, kind: "conversation", clientMessageId: `cmid-rate-000${index}` });

  const first = await send(1);
  const second = await send(2);
  const third = await send(3);

  assert.equal(first.status, 503, "no provider key: stored and reported honestly");
  assert.equal(second.status, 503);
  assert.equal(third.status, 429);
  assert.equal(third.body.error, "TOO_MANY_REQUESTS_TRY_AGAIN_LATER");
  assert.ok(Number(third.headers["retry-after"]) > 0, "Retry-After is advertised");

  // The limiter is per-route: unrelated authenticated routes are unaffected.
  const health = await supertest(app).get("/api/agents").set(auth);
  assert.equal(health.status, 200);
});
