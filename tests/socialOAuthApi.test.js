/**
 * Per-Director SOCIAL account connections — owner API tests.
 *
 * Boots the labeled demo-backed app (the same truthful, non-durable adapter the
 * preview uses), signs the seeded demo owner in, and exercises the real routes
 * at /api/social exactly as the dashboard does:
 *
 *   - every route requires an authenticated session;
 *   - mutations require the session CSRF token;
 *   - the provider catalog is safe metadata only;
 *   - an unconfirmed-identity provider (bilibili) fails honestly with 501;
 *   - an unsupported provider is a generic 404;
 *   - a full connect round-trips through the real callback redirect and leaves
 *     an honest Director-scoped status;
 *   - revocation flips the status and reports separate honest facts.
 *
 * The provider transport + secret-manager adapter are injected in-process (the
 * same seam production boot wires); no live provider is contacted and no real
 * credential exists anywhere. Env vars must be set before the app module loads,
 * so this file uses dynamic imports. Node --test runs each file in its own
 * process.
 */

process.env.STPH_DEMO_STORAGE = "1";
process.env.RATE_LIMIT_PER_MINUTE = "5000";
process.env.AUTH_RATE_LIMIT_PER_MINUTE = "5000";
process.env.STPH_SOCIAL_OAUTH_REDIRECT_BASE_URL = "https://dashboard.stproduction.test";
process.env.STPH_FACEBOOK_OAUTH_CLIENT_ID = "meta-app-id";
process.env.STPH_FACEBOOK_OAUTH_CLIENT_SECRET = "meta-app-secret";
process.env.STPH_INSTAGRAM_OAUTH_CLIENT_ID = "meta-app-id";
process.env.STPH_INSTAGRAM_OAUTH_CLIENT_SECRET = "meta-app-secret";

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const supertest = (await import("supertest")).default;
const { default: app, configureRuntime, finalizeRuntimeStartup } = await import("../src/catalog/server.js");
const { setSocialOAuthRuntime } = await import("../src/catalog/socialOAuthService.js");
const { createInMemorySecretManager } = await import("../src/catalog/youtubeOAuthService.js");

await configureRuntime();
await finalizeRuntimeStartup();

// Production boot wires a durable secret-manager adapter; this suite injects
// the labeled in-memory PLACEHOLDER at the same seam. It is non-durable by
// construction and is never used as production custody.
const secrets = createInMemorySecretManager();
function metaResponder(request) {
  const json = (status, payload) => ({ status, body: JSON.stringify(payload) });
  if (request.url.startsWith("https://graph.facebook.com/v26.0/oauth/access_token")) {
    return json(200, { access_token: "meta-user-token", token_type: "bearer", expires_in: 5184000 });
  }
  if (request.url.startsWith("https://graph.facebook.com/v26.0/me/accounts")) {
    return json(200, { data: [{ id: "page-1", name: "First Page", access_token: "page-token-1" }] });
  }
  if (request.url.startsWith("https://graph.facebook.com/v26.0/me/permissions")) {
    return json(200, { success: true });
  }
  return json(404, { error: "unknown_endpoint" });
}
const providerCalls = [];
setSocialOAuthRuntime({
  secretManagerFactory: () => secrets,
  transport: async (request) => {
    providerCalls.push(request);
    return metaResponder(request);
  },
});

test.after(() => {
  setSocialOAuthRuntime({ transport: null, secretManagerFactory: null });
});

const DEMO_EMAIL = "owner@stproduction.demo";
const DEMO_PASSWORD = process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026";

async function loginAs(email, password) {
  const response = await supertest(app).post("/api/auth/login").send({ email, password });
  assert.equal(response.status, 200, `login must succeed for ${email}`);
  const cookieHeader = response.headers["set-cookie"]?.[0] ?? "";
  const sessionToken = /session_token=([^;]+)/.exec(cookieHeader)?.[1] ?? "";
  assert.ok(sessionToken, "login must set the session cookie");
  assert.ok(response.body.csrfToken, "login must issue a CSRF token for mutations");
  return {
    Authorization: `Bearer ${sessionToken}`,
    "x-csrf-token": response.body.csrfToken,
  };
}

const auth = await loginAs(DEMO_EMAIL, DEMO_PASSWORD);
const channels = await supertest(app).get("/api/channels").set(auth).expect(200);
const directors = channels.body.channels.map((channel) => channel.agentId);
assert.ok(directors.length >= 2, "the seeded demo has at least two Director channels");
const [directorA, directorB] = directors;

test("social account routes require an authenticated session", async () => {
  await supertest(app).get("/api/social/providers").expect(401);
  await supertest(app).get(`/api/social/directors/${directorA}/accounts`).expect(401);
  await supertest(app).get(`/api/social/directors/${directorA}/facebook/status`).expect(401);
  await supertest(app).post(`/api/social/directors/${directorA}/facebook/oauth/start`).send({}).expect(401);
  await supertest(app).post(`/api/social/directors/${directorA}/facebook/revoke`).send({}).expect(401);
});

test("an authenticated mutation without the session CSRF token is refused", async () => {
  const csrfLess = { Authorization: auth.Authorization };
  const start = await supertest(app)
    .post(`/api/social/directors/${directorA}/facebook/oauth/start`)
    .set(csrfLess).send({});
  assert.equal(start.status, 403);
  assert.equal(start.body.error, "CSRF_TOKEN_INVALID");

  const revoke = await supertest(app)
    .post(`/api/social/directors/${directorA}/facebook/revoke`)
    .set(csrfLess).send({});
  assert.equal(revoke.status, 403);
  assert.equal(revoke.body.error, "CSRF_TOKEN_INVALID");
});

test("the provider catalog is safe metadata with no secret-shaped fields", async () => {
  const response = await supertest(app).get("/api/social/providers").set(auth).expect(200);
  const keys = response.body.providers.map((p) => p.providerKey).sort();
  assert.deepEqual(keys, ["bilibili", "facebook", "instagram", "snapchat"]);
  const bilibili = response.body.providers.find((p) => p.providerKey === "bilibili");
  assert.equal(bilibili.connectable, false, "an unconfirmed identity endpoint is disclosed");
  assert.ok(!/token|secret|locator/i.test(JSON.stringify(response.body)), "no secret-shaped field serializes");
});

test("every supported platform is listed as unconfigured for a fresh Director", async () => {
  const response = await supertest(app).get(`/api/social/directors/${directorB}/accounts`).set(auth).expect(200);
  assert.deepEqual(response.body.items.map((i) => i.providerKey).sort(), ["bilibili", "facebook", "instagram", "snapchat"]);
  assert.ok(response.body.items.every((i) => i.status === "unconfigured"));
});

test("an unconfirmed-identity provider and an unknown provider fail honestly", async () => {
  const bilibili = await supertest(app)
    .post(`/api/social/directors/${directorA}/bilibili/oauth/start`)
    .set(auth).send({});
  assert.equal(bilibili.status, 501);
  assert.equal(bilibili.body.error, "OAUTH_PROVIDER_IDENTITY_UNCONFIRMED");

  await supertest(app)
    .post(`/api/social/directors/${directorA}/twitter/oauth/start`)
    .set(auth).send({}).expect(404);
  await supertest(app)
    .get(`/api/social/directors/${directorA}/twitter/status`)
    .set(auth).expect(404);
});

test("a full facebook connect round-trips through the real callback redirect", async () => {
  const start = await supertest(app)
    .post(`/api/social/directors/${directorA}/facebook/oauth/start`)
    .set(auth).send({}).expect(200);
  const authorizationUrl = new URL(start.body.authorizationUrl);
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, "https://www.facebook.com/v26.0/dialog/oauth");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "meta-app-id");
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state, "the authorization URL carries the state token");

  // The provider redirects the owner's browser back to our callback.
  const callback = await supertest(app)
    .get(`/api/social/facebook/callback?code=auth-code&state=${encodeURIComponent(state)}`)
    .set({ Authorization: auth.Authorization })
    .expect(302);
  assert.match(callback.headers.location, /^\/index\.html\?/);
  const redirect = new URLSearchParams(callback.headers.location.split("?")[1]);
  assert.equal(redirect.get("oauth"), "connected");
  assert.equal(redirect.get("provider"), "facebook");
  assert.equal(redirect.get("agent"), directorA);

  const status = await supertest(app)
    .get(`/api/social/directors/${directorA}/facebook/status`)
    .set(auth).expect(200);
  assert.equal(status.body.status, "connected");
  assert.equal(status.body.account.account.id, "page-1");
  assert.ok(!JSON.stringify(status.body).includes("vault://"), "the locator never serializes");
  assert.ok(!JSON.stringify(status.body).includes("meta-user-token"));

  // The provider transport really ran (offline fake), and no code leaked.
  assert.ok(providerCalls.some((c) => c.url.includes("/oauth/access_token")));
});

test("a replayed callback is honest and never a second connection", async () => {
  const start = await supertest(app)
    .post(`/api/social/directors/${directorB}/facebook/oauth/start`)
    .set(auth).send({}).expect(200);
  const state = new URL(start.body.authorizationUrl).searchParams.get("state");

  await supertest(app)
    .get(`/api/social/facebook/callback?code=auth-code&state=${encodeURIComponent(state)}`)
    .set({ Authorization: auth.Authorization })
    .expect(302);

  const replay = await supertest(app)
    .get(`/api/social/facebook/callback?code=auth-code&state=${encodeURIComponent(state)}`)
    .set({ Authorization: auth.Authorization })
    .expect(302);
  const redirect = new URLSearchParams(replay.headers.location.split("?")[1]);
  assert.equal(redirect.get("oauth"), "failed");
  assert.equal(redirect.get("code"), "OAUTH_STATE_REPLAYED");

  const status = await supertest(app)
    .get(`/api/social/directors/${directorB}/facebook/status`)
    .set(auth).expect(200);
  assert.equal(status.body.status, "connected", "the first successful connect stands");
});

test("revocation flips the status and reports separate honest facts", async () => {
  const revoked = await supertest(app)
    .post(`/api/social/directors/${directorA}/facebook/revoke`)
    .set(auth).send({}).expect(200);
  assert.equal(revoked.body.status, "disconnected");
  assert.equal(revoked.body.providerRevoked, true);
  assert.equal(revoked.body.secretCleanupFailed, false);

  const status = await supertest(app)
    .get(`/api/social/directors/${directorA}/facebook/status`)
    .set(auth).expect(200);
  assert.equal(status.body.status, "disconnected");
});

test("one Director's connection never appears for another Director", async () => {
  const list = await supertest(app).get(`/api/social/directors/${directorA}/accounts`).set(auth).expect(200);
  const facebook = list.body.items.find((i) => i.providerKey === "facebook");
  assert.equal(facebook.status, "disconnected");

  const otherList = await supertest(app).get(`/api/social/directors/${directorB}/accounts`).set(auth).expect(200);
  const otherFacebook = otherList.body.items.find((i) => i.providerKey === "facebook");
  assert.equal(otherFacebook.status, "connected", "the two Directors keep independent accounts");
  assert.equal(otherFacebook.account.account.id, "page-1");
});
