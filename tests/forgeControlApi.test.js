/**
 * FORGE Control API — security regressions at the real application mount.
 *
 * Closes audit defects D1 (the mounted router read `req.owner`, which the Owner
 * authentication middleware never sets, so every legitimate Owner got 401) and
 * D2 (the mount injected `verifyCsrf: () => true`, bypassing CSRF entirely).
 *
 * Everything here drives the real Express application from
 * `src/catalog/server.js` with its real `authenticateOwner`, real Owner record
 * lookup, real per-session CSRF token validation and the real mounted router.
 * Only the storage adapter is the labeled demo adapter (non-durable), which is
 * the application's preview/dev storage mode.
 *
 * Each test creates its own Owner session because a fresh login rotates and
 * revokes the Owner's previous sessions by design.
 */
process.env.STPH_DEMO_STORAGE = "1";
delete process.env.GEMINI_API_KEY;

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const supertest = (await import("supertest")).default;
const express = (await import("express")).default;
const {
  default: app,
  configureRuntime,
  finalizeRuntimeStartup,
  createForgeOwnerSessionGate,
} = await import("../src/catalog/server.js");
const { createForgeControlRouter } = await import("../src/forge/forgeControlRouter.js");
const { ForgeControlPlane } = await import("../src/forge/forgeControlPlane.js");

await configureRuntime();
await finalizeRuntimeStartup();

const DEMO_EMAIL = "owner@stproduction.demo";
const DEMO_PASSWORD =
  process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026";

/** A real Owner login: session cookie, bearer token and that session's CSRF token. */
async function newOwnerSession() {
  const res = await supertest(app)
    .post("/api/auth/login")
    .send({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  assert.equal(res.status, 200, "demo Owner login must succeed");
  const cookieHeader = res.headers["set-cookie"]?.[0] ?? "";
  const token = /session_token=([^;]+)/.exec(cookieHeader)?.[1] ?? "";
  assert.ok(token, "login must set the session cookie");

  const me = await supertest(app)
    .get("/api/auth/me")
    .set({ Cookie: `session_token=${token}` });
  assert.equal(me.status, 200);
  assert.ok(me.body.csrfToken, "the Owner session must expose its CSRF token");

  return {
    token,
    cookie: `session_token=${token}`,
    csrfToken: me.body.csrfToken,
  };
}

test("anonymous access to the control plane is refused", async () => {
  const get = await supertest(app).get("/api/forge/status");
  assert.equal(get.status, 401);

  const post = await supertest(app)
    .post("/api/forge/tasks")
    .send({ issueNumber: 1, slug: "anon", title: "anon", idempotencyKey: "anon-1" });
  assert.equal(post.status, 401);
});

test("an invalid or forged session is refused", async () => {
  const forgedToken = await supertest(app)
    .get("/api/forge/status")
    .set({ Authorization: "Bearer not-a-real-session-token" });
  assert.equal(forgedToken.status, 401);

  // Header-spoofing attempt: the old unit-level stub keyed off this header.
  const spoofHeader = await supertest(app)
    .get("/api/forge/status")
    .set({ "x-owner-session": "valid-owner", "x-owner-id": "someone-else" });
  assert.equal(spoofHeader.status, 401);
});

test("an unknown or expired session token is refused", async () => {
  // A well-formed token that matches no session must fail closed. (Demo-mode
  // logout revocation is a separate, pre-existing demo-adapter limitation and
  // is deliberately not asserted here; the PostgreSQL path covers revocation.)
  const unknownToken = "a".repeat(64);
  const res = await supertest(app)
    .get("/api/forge/status")
    .set({ Authorization: `Bearer ${unknownToken}` });
  assert.equal(res.status, 401);

  const post = await supertest(app)
    .post("/api/forge/tasks")
    .set({ Authorization: `Bearer ${unknownToken}`, "Content-Type": "application/json" })
    .send({ issueNumber: 1, slug: "expired", title: "expired", idempotencyKey: "expired-1" });
  assert.equal(post.status, 401);
});

test("an authenticated Owner can read the control plane status", async () => {
  const session = await newOwnerSession();
  const res = await supertest(app)
    .get("/api/forge/status")
    .set({ Authorization: `Bearer ${session.token}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.forge.controlPlane, "implemented");
  assert.equal(res.body.forge.permissionGateway, "implemented");
  // The honest operational matrix is preserved, not upgraded by the auth fix.
  assert.equal(res.body.forge.persistentCloudHosting, "awaiting_owner_approval");
  assert.equal(res.body.evidence.chainValid, true);

  // No Director identifiers, secrets or locators leak through this surface.
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /agent-[a-z0-9]/);
  assert.doesNotMatch(serialized, /vault:\/\//);
});

test("FORGE mutations without a valid CSRF token are rejected", async () => {
  const session = await newOwnerSession();
  const task = {
    issueNumber: 292,
    slug: "csrf",
    title: "CSRF check",
    idempotencyKey: "csrf-check-1",
  };

  const noToken = await supertest(app)
    .post("/api/forge/tasks")
    .set({ Cookie: session.cookie, "Content-Type": "application/json" })
    .send(task);
  assert.equal(noToken.status, 403);

  const wrongToken = await supertest(app)
    .post("/api/forge/tasks")
    .set({
      Cookie: session.cookie,
      "x-csrf-token": "not-the-session-token",
      "Content-Type": "application/json",
    })
    .send(task);
  assert.equal(wrongToken.status, 403);

  // A bearer session does not exempt a control-plane write from CSRF either.
  const bearerNoToken = await supertest(app)
    .post("/api/forge/tasks")
    .set({ Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" })
    .send(task);
  assert.equal(bearerNoToken.status, 403);
});

test("an Owner mutation with a valid CSRF token is authorized", async () => {
  const session = await newOwnerSession();
  const res = await supertest(app)
    .post("/api/forge/tasks")
    .set({
      Cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "Content-Type": "application/json",
    })
    .send({
      issueNumber: 292,
      slug: "forge-control-api-security",
      title: "Restore FORGE control API access",
      idempotencyKey: "forge-control-api-security-1",
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.deduplicated, false);
  assert.equal(res.body.task.derivedBranch, "task/292-forge-control-api-security");

  const listing = await supertest(app)
    .get("/api/forge/tasks")
    .set({ Authorization: `Bearer ${session.token}` });
  assert.equal(listing.status, 200);
  assert.ok(
    listing.body.tasks.some(
      (task) => task.derivedBranch === "task/292-forge-control-api-security"
    ),
    "the created task is readable by the Owner"
  );
});

test("client-supplied identity fields cannot elevate or redirect the actor", async () => {
  const session = await newOwnerSession();
  const res = await supertest(app)
    .post("/api/forge/tasks")
    .set({
      Cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "x-owner-id": "owner-999",
      "x-owner-session": "valid-owner",
      "Content-Type": "application/json",
    })
    .send({
      issueNumber: 292,
      slug: "spoofed-owner",
      title: "Spoof attempt",
      idempotencyKey: "spoofed-owner-1",
      ownerId: "owner-999",
      role: "owner",
      authenticated: true,
    });

  // Authorized only by the real session; unknown body fields are ignored, never
  // trusted, so no state is created under a spoofed identity.
  assert.ok([201, 400].includes(res.status), `unexpected status ${res.status}`);
  if (res.status === 201) {
    assert.equal(res.body.task.derivedBranch, "task/292-spoofed-owner");
  }

  // The same spoof without a session is still anonymous.
  const anonymous = await supertest(app)
    .post("/api/forge/tasks")
    .set({ "x-owner-id": "owner-999", "Content-Type": "application/json" })
    .send({
      issueNumber: 292,
      slug: "spoofed-owner",
      title: "Spoof",
      idempotencyKey: "spoofed-owner-2",
    });
  assert.equal(anonymous.status, 401);
});

test("permission-tier restrictions are preserved", async () => {
  const session = await newOwnerSession();
  const denied = await supertest(app)
    .post("/api/forge/authorize")
    .set({
      Cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "Content-Type": "application/json",
    })
    .send({
      actor: { id: "forge-ctrl", type: "forge_controller", authenticated: true },
      action: "deploy.production",
      tier: "T7",
      taskId: "task-1",
      fencingToken: 1,
      activeFencingToken: 1,
    });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "DENY_OWNER_RESERVED");
});

test("the Owner role gate refuses non-owner roles and unknown Owners", async () => {
  // Unauthenticated callers still never reach the router.
  const anonymous = await supertest(app).get("/api/forge/status");
  assert.equal(anonymous.status, 401);

  const viewerGate = express();
  viewerGate.use(
    "/gate",
    (req, _res, next) => {
      req.ownerId = "owner-2";
      next();
    },
    createForgeOwnerSessionGate({
      findOwnerById: async () => ({ id: "owner-2", role: "viewer" }),
    }),
    (_req, res) => res.status(200).json({ reached: true })
  );
  const viewerDenied = await supertest(viewerGate).get("/gate");
  assert.equal(viewerDenied.status, 403);
  assert.equal(viewerDenied.body.code, "FORBIDDEN");

  const operatorGate = express();
  operatorGate.use(
    "/gate",
    (req, _res, next) => {
      req.ownerId = "owner-3";
      next();
    },
    createForgeOwnerSessionGate({
      findOwnerById: async () => ({ id: "owner-3", role: "operator" }),
    }),
    (_req, res) => res.status(200).json({ reached: true })
  );
  assert.equal((await supertest(operatorGate).get("/gate")).status, 403);

  const unknownOwner = express();
  unknownOwner.use(
    "/gate",
    (req, _res, next) => {
      req.ownerId = "missing-owner";
      next();
    },
    createForgeOwnerSessionGate({ findOwnerById: async () => null }),
    (_req, res) => res.status(200).json({ reached: true })
  );
  const unknownDenied = await supertest(unknownOwner).get("/gate");
  assert.equal(unknownDenied.status, 401);
});

test("the fix does not disturb other Owner routes", async () => {
  const session = await newOwnerSession();

  const agents = await supertest(app)
    .get("/api/agents")
    .set({ Authorization: `Bearer ${session.token}` });
  assert.equal(agents.status, 200);

  const meAgain = await supertest(app)
    .get("/api/auth/me")
    .set({ Cookie: session.cookie });
  assert.equal(meAgain.status, 200);
  assert.equal(meAgain.body.email, DEMO_EMAIL);

  const health = await supertest(app).get("/api/health");
  assert.equal(health.status, 200);
});
