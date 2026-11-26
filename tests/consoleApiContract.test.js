import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import app from "../src/catalog/server.js";

/**
 * Console ↔ backend contract, exercised against the REAL Express app with no
 * session and no database. These assertions prove the console cannot obtain
 * production data without an Owner session, and that missing capabilities
 * answer honestly instead of returning invented data.
 */

const OWNER_ROUTES = [
  "/api/auth/me",
  "/api/agents",
  "/api/channels",
  "/api/productions",
  "/api/evidence",
  "/api/metrics",
  "/api/publishing-approvals/requests",
  "/api/scheduling/directors",
  "/api/hermes/overview",
  "/api/providers/catalog",
  "/api/connections/directors/agent-01",
  "/api/director-comm/agent-01/messages",
];

test("every Owner read route refuses an unauthenticated caller", async () => {
  for (const route of OWNER_ROUTES) {
    const response = await request(app).get(route);
    assert.equal(response.status, 401, `${route} must require a session`);
    assert.equal(response.body.error, "SESSION_TOKEN_REQUIRED", `${route} must fail closed`);
  }
});

test("Owner mutations refuse an unauthenticated caller before CSRF", async () => {
  const mutations = [
    ["post", "/api/channels"],
    ["post", "/api/productions"],
    ["put", "/api/scheduling/directors/agent-01"],
    ["post", "/api/director-comm/agent-01/messages"],
    ["post", "/api/auth/logout"],
  ];
  for (const [method, route] of mutations) {
    const response = await request(app)[method](route).send({});
    assert.equal(response.status, 401, `${method.toUpperCase()} ${route} must require a session`);
  }
});

test("login validates its payload instead of minting a session", async () => {
  const empty = await request(app).post("/api/auth/login").send({});
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, "EMAIL_AND_PASSWORD_REQUIRED");

  const extraField = await request(app)
    .post("/api/auth/login")
    .send({ email: "a@b.test", password: "x", ownerId: "spoofed-owner" });
  assert.equal(extraField.status, 400);
  assert.equal(extraField.body.error, "REQUEST_VALIDATION_FAILED");

  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: "a@b.test", password: "x" });
  // With storage unconfigured the backend must not pretend a login succeeded.
  assert.notEqual(response.status, 200);
  assert.equal(response.headers["set-cookie"], undefined);
});

test("an unknown API route returns a JSON 404 and never leaks the route inventory", async () => {
  const response = await request(app).get("/api/definitely-not-a-route");
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "NOT_FOUND" });
});

test("health reports the runtime it actually has, not a pleasant one", async () => {
  const response = await request(app).get("/api/health");
  assert.equal(response.status, 200);
  assert.equal(typeof response.body.storage, "string");
  assert.equal(typeof response.body.isDemoStorage, "boolean");
  assert.ok(["healthy", "degraded"].includes(response.body.status));
});

test("security headers are present on console responses", async () => {
  const response = await request(app).get("/api/health");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
});
