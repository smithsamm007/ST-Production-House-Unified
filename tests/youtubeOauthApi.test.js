/**
 * YouTube OAuth lifecycle — owner API routes (Issue #206).
 *
 * Boots the labeled demo-backed app, logs the seeded demo owner in, and
 * exercises the mounted /api/youtube routes: owner authentication, session
 * CSRF on mutations, start → callback → status → revoke over an INJECTED
 * offline transport + secret manager, honest failure redirects, and audit
 * evidence. No network call, no live Google account, no real secret manager.
 */

process.env.STPH_DEMO_STORAGE = "1";
// loadOAuthConfig() reads these at call time — in-process test-only values.
process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID = "api-test-client-id.apps.googleusercontent.com";
process.env.STPH_YOUTUBE_OAUTH_CLIENT_SECRET = "api-test-client-secret-value";
process.env.STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL = "https://dashboard.stproduction.test";

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const supertest = (await import("supertest")).default;
const { default: app, configureRuntime, finalizeRuntimeStartup } = await import("../src/catalog/server.js");
const {
  GOOGLE_OAUTH_ENDPOINTS,
  YOUTUBE_OAUTH_SCOPES,
  createInMemorySecretManager,
  setYouTubeOAuthRuntime,
} = await import("../src/catalog/youtubeOAuthService.js");

await configureRuntime();
await finalizeRuntimeStartup();

const login = await supertest(app)
  .post("/api/auth/login")
  .send({ email: "owner@stproduction.demo", password: process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026" });
assert.equal(login.status, 200, "demo owner login must succeed");

const cookieHeader = login.headers["set-cookie"]?.[0] ?? "";
const sessionToken = /session_token=([^;]+)/.exec(cookieHeader)?.[1] ?? "";
assert.ok(sessionToken, "login must set the session cookie");
assert.ok(login.body.csrfToken, "login must issue a CSRF token for mutations");
const bearerAuth = { Authorization: `Bearer ${sessionToken}` };
const csrfHeader = { "x-csrf-token": login.body.csrfToken };

function jsonResponse(status, payload) {
  return { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

const secrets = createInMemorySecretManager();
setYouTubeOAuthRuntime({
  transport: async (request) => {
    if (request.url === GOOGLE_OAUTH_ENDPOINTS.token) {
      return jsonResponse(200, {
        access_token: "ya29.api-test-access-token",
        refresh_token: "1//api-test-refresh-token",
        expires_in: 3600,
        scope: YOUTUBE_OAUTH_SCOPES.join(" "),
      });
    }
    if (request.url.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
      return jsonResponse(200, {
        items: [{ id: "UCapitestchannel01", snippet: { title: "Public Channel Name", customUrl: "@public-handle" } }],
      });
    }
    if (request.url === GOOGLE_OAUTH_ENDPOINTS.revoke) {
      return { status: 200, body: "" };
    }
    return jsonResponse(404, { error: "unknown_endpoint" });
  },
  secretManagerFactory: () => secrets,
});

test.after(() => {
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID;
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_SECRET;
  delete process.env.STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL;
  setYouTubeOAuthRuntime({ transport: null, secretManagerFactory: null });
});

async function startOauth(agentId = "agent-01") {
  const response = await supertest(app)
    .post(`/api/youtube/directors/${agentId}/oauth/start`)
    .set(bearerAuth)
    .set(csrfHeader)
    .expect(200);
  assert.equal(response.body.providerKey, "youtube");
  const state = new URL(response.body.authorizationUrl).searchParams.get("state");
  assert.ok(state, "authorization URL carries the state token");
  return { response, state };
}

async function auditEvents() {
  const response = await supertest(app).get("/api/audit").set(bearerAuth).expect(200);
  return Array.isArray(response.body) ? response.body : response.body.events ?? [];
}

function auditHas(events, eventType, agentId) {
  return events.some((event) =>
    event.eventType === eventType &&
    (event.payload?.agentId ?? event.detail?.agentId) === agentId &&
    !JSON.stringify(event).includes("ya29"),
  );
}

test("every YouTube OAuth route rejects anonymous callers", async () => {
  await supertest(app).post("/api/youtube/directors/agent-01/oauth/start").expect(401);
  await supertest(app).get("/api/youtube/directors/agent-01/status").expect(401);
  await supertest(app).post("/api/youtube/directors/agent-01/revoke").expect(401);
  await supertest(app).get("/api/youtube/callback?code=c&state=s").expect(401);
});

test("mutations require the session CSRF token even with a valid bearer token", async () => {
  const noCsrf = await supertest(app)
    .post("/api/youtube/directors/agent-01/oauth/start")
    .set(bearerAuth)
    .expect(403);
  assert.equal(noCsrf.body.error, "CSRF_TOKEN_INVALID");

  const badCsrf = await supertest(app)
    .post("/api/youtube/directors/agent-01/revoke")
    .set(bearerAuth)
    .set("x-csrf-token", "not-the-session-token")
    .expect(403);
  assert.equal(badCsrf.body.error, "CSRF_TOKEN_INVALID");
});

test("status is honest and Director-scoped before any connection exists", async () => {
  const status = await supertest(app)
    .get("/api/youtube/directors/agent-01/status")
    .set(bearerAuth)
    .expect(200);
  assert.equal(status.body.providerKey, "youtube");
  assert.equal(status.body.status, "unconfigured");
  assert.equal(status.body.account, null);
  assert.equal(status.body.oauthConfigured, true);
  assert.equal(status.body.secretManagerConfigured, true);

  const other = await supertest(app)
    .get("/api/youtube/directors/agent-02/status")
    .set(bearerAuth)
    .expect(200);
  assert.equal(other.body.status, "unconfigured", "no cross-director leakage");

  await supertest(app)
    .get("/api/youtube/directors/agent-does-not-exist/status")
    .set(bearerAuth)
    .expect(404, { error: "AGENT_NOT_FOUND" });
});

test("start returns the official Google authorization URL and writes an audit event", async () => {
  const { response } = await startOauth("agent-01");
  const url = new URL(response.body.authorizationUrl);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), "https://dashboard.stproduction.test/api/youtube/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID);
  assert.ok(response.body.stateExpiresAt, "state expiry is reported");

  assert.ok(auditHas(await auditEvents(), "youtube_oauth_started", "agent-01"), "owner mutation is audited (Rule 6)");
});

test("start degrades honestly when Google OAuth is not configured", async () => {
  const clientId = process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID;
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID;
  try {
    const response = await supertest(app)
      .post("/api/youtube/directors/agent-03/oauth/start")
      .set(bearerAuth)
      .set(csrfHeader)
      .expect(503);
    assert.equal(response.body.error, "OAUTH_NOT_CONFIGURED");
  } finally {
    process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID = clientId;
  }
});

test("callback completes the connection, redirects honestly, and never echoes the code", async () => {
  const { state } = await startOauth("agent-01");
  const callback = await supertest(app)
    .get(`/api/youtube/callback?code=api-test-auth-code&state=${encodeURIComponent(state)}`)
    .set(bearerAuth)
    .expect(302);

  const location = callback.headers.location ?? "";
  assert.ok(location.startsWith("/index.html?"), "the browser is returned to the dashboard");
  assert.ok(location.includes("view=connections"), "landed on the connections view");
  assert.ok(location.includes("agent=agent-01"), "landed on the connecting director");
  assert.ok(location.includes("oauth=connected"), "honest connected result");
  assert.ok(!location.includes("api-test-auth-code"), "the authorization code never serializes into a redirect");
  assert.ok(!location.includes("state="), "the state token never serializes into a redirect");

  const status = await supertest(app)
    .get("/api/youtube/directors/agent-01/status")
    .set(bearerAuth)
    .expect(200);
  assert.equal(status.body.status, "connected");
  assert.equal(status.body.account.channel.id, "UCapitestchannel01");
  assert.equal(status.body.account.channel.title, "Public Channel Name");
  assert.ok(status.body.account.verifiedAt, "verification evidence recorded");

  assert.ok(auditHas(await auditEvents(), "youtube_oauth_connected", "agent-01"));
});

test("callback failures redirect with stable codes instead of leaking errors", async () => {
  const unknownState = await supertest(app)
    .get("/api/youtube/callback?code=whatever&state=not-a-real-state")
    .set(bearerAuth)
    .expect(302);
  assert.ok((unknownState.headers.location ?? "").includes("oauth=failed"));
  assert.ok((unknownState.headers.location ?? "").includes("code=OAUTH_STATE_INVALID"));

  const denied = await supertest(app)
    .get("/api/youtube/callback?error=access_denied&state=anything")
    .set(bearerAuth)
    .expect(302);
  assert.ok((denied.headers.location ?? "").includes("oauth=failed"));
  assert.ok((denied.headers.location ?? "").includes("code=OAUTH_OWNER_DENIED"));
});

test("a replayed callback is rejected and the first connection stands", async () => {
  const { state } = await startOauth("agent-04");
  await supertest(app)
    .get(`/api/youtube/callback?code=first-code&state=${encodeURIComponent(state)}`)
    .set(bearerAuth)
    .expect(302);

  const replay = await supertest(app)
    .get(`/api/youtube/callback?code=second-code&state=${encodeURIComponent(state)}`)
    .set(bearerAuth)
    .expect(302);
  const location = replay.headers.location ?? "";
  assert.ok(location.includes("oauth=failed"));
  assert.ok(location.includes("code=OAUTH_STATE_REPLAYED"));

  const status = await supertest(app)
    .get("/api/youtube/directors/agent-04/status")
    .set(bearerAuth)
    .expect(200);
  assert.equal(status.body.status, "connected");
});

test("revoke is owner-authorized, audited, and reports separated honest facts", async () => {
  const response = await supertest(app)
    .post("/api/youtube/directors/agent-01/revoke")
    .set(bearerAuth)
    .set(csrfHeader)
    .expect(200);
  assert.equal(response.body.status, "disconnected");
  assert.equal(response.body.providerRevoked, true);
  assert.equal(response.body.secretCleanupFailed, false);
  assert.equal(response.body.alreadyDisconnected, false);

  const status = await supertest(app)
    .get("/api/youtube/directors/agent-01/status")
    .set(bearerAuth)
    .expect(200);
  assert.equal(status.body.status, "disconnected");
  assert.equal(status.body.account.channel.id, "UCapitestchannel01", "safe identity survives disconnection");

  assert.ok(auditHas(await auditEvents(), "youtube_connection_revoked", "agent-01"));
});

test("revoking a director that never connected is a generic 404", async () => {
  const response = await supertest(app)
    .post("/api/youtube/directors/agent-05/revoke")
    .set(bearerAuth)
    .set(csrfHeader)
    .expect(404);
  assert.equal(response.body.error, "NOT_FOUND");
});

test("secret material never serializes through any YouTube OAuth route", async () => {
  const status01 = await supertest(app).get("/api/youtube/directors/agent-01/status").set(bearerAuth).expect(200);
  const status04 = await supertest(app).get("/api/youtube/directors/agent-04/status").set(bearerAuth).expect(200);
  const blob = JSON.stringify([status01.body, status04.body]);
  assert.ok(!blob.includes("ya29.api-test-access-token"), "access token never serializes");
  assert.ok(!blob.includes("1//api-test-refresh-token"), "refresh token never serializes");
  assert.ok(!blob.includes("api-test-client-secret-value"), "client secret never serializes");
  assert.ok(!blob.includes("opaque://"), "even the locator never serializes");
});
