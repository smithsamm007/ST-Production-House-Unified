/**
 * Boot wiring of the operator secret-manager adapter (Issue #208).
 *
 * Dynamic import per STPH_SECRET_MANAGER_ADAPTER configuration; the runtime
 * is re-configured in-process for each scenario (no env-prefix commands in
 * this environment). Proves: nothing declared → nothing wired and the OAuth
 * surface stays honestly 503; builtin-env declared → guarded adapter bound
 * and the full connect path works through it; a DECLARED adapter that fails
 * to load is a loud boot error, never silent placeholder custody.
 */

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;

process.env.STPH_DEMO_STORAGE = "1";
process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID = "wiring-test-client-id.apps.googleusercontent.com";
process.env.STPH_YOUTUBE_OAUTH_CLIENT_SECRET = "wiring-test-client-secret-value";
process.env.STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL = "https://dashboard.stproduction.test";

const supertest = (await import("supertest")).default;
const { default: app, configureRuntime, finalizeRuntimeStartup, getOauthSecretManagerStatus } =
  await import("../src/catalog/server.js");
const { GOOGLE_OAUTH_ENDPOINTS, YOUTUBE_OAUTH_SCOPES, setYouTubeOAuthRuntime } =
  await import("../src/catalog/youtubeOAuthService.js");

function jsonResponse(status, payload) {
  return { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

async function boot(credentialParams = {}) {
  setYouTubeOAuthRuntime({ secretManagerFactory: null, transport: null });
  const runtime = await configureRuntime(credentialParams);
  // finalizeRuntimeStartup seeds the labeled demo data (incl. the demo owner)
  // so the HTTP scenarios below can authenticate. Its secret-manager wiring
  // happens in configureRuntime; finalize is idempotent for this purpose.
  await finalizeRuntimeStartup();
  return runtime;
}

test.after(async () => {
  delete process.env.STPH_SECRET_MANAGER_ADAPTER;
  delete process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE;
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID;
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_SECRET;
  delete process.env.STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL;
  setYouTubeOAuthRuntime({ transport: null, secretManagerFactory: null });
});

test("nothing declared: nothing is wired and the OAuth surface stays honest", async () => {
  delete process.env.STPH_SECRET_MANAGER_ADAPTER;
  delete process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE;

  const runtime = await boot();
  assert.equal(runtime.oauthSecretManager, false, "boot reports no adapter bound");
  const status = getOauthSecretManagerStatus();
  assert.equal(status.declared, false);
  assert.equal(status.bound, false);

  // Health reports the truthful wiring state.
  const health = await supertest(app)
    .get("/api/health")
    .expect(200);
  assert.equal(health.body.oauthSecretManager.declared, false);
  assert.equal(health.body.oauthSecretManager.bound, false);
  assert.equal(health.body.oauthSecretManager.nonDurable, false);

  // The YouTube status route reports secretManagerConfigured=false (honest).
  const login = await supertest(app)
    .post("/api/auth/login")
    .send({ email: "owner@stproduction.demo", password: process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026" });
  assert.equal(login.status, 200);
  const bearerAuth = { Authorization: `Bearer ${/session_token=([^;]+)/.exec(login.headers["set-cookie"][0])?.[1]}` };

  const yt = await supertest(app)
    .get("/api/youtube/directors/agent-01/status")
    .set(bearerAuth)
    .expect(200);
  assert.equal(yt.body.secretManagerConfigured, false, "honest 503-class posture preserved");
});

test("builtin-env declared: guarded adapter is bound and drives the real connect path", async () => {
  process.env.STPH_SECRET_MANAGER_ADAPTER = "builtin-env";

  const runtime = await boot();
  assert.equal(runtime.oauthSecretManager, true, "boot reports the adapter bound");
  const status = getOauthSecretManagerStatus();
  assert.equal(status.declared, true);
  assert.equal(status.bound, true);
  assert.equal(status.nonDurable, true, "durability class is reported honestly");
  assert.match(status.label, /builtin-env/);

  const login = await supertest(app)
    .post("/api/auth/login")
    .send({ email: "owner@stproduction.demo", password: process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026" });
  assert.equal(login.status, 200);
  const bearerAuth = { Authorization: `Bearer ${/session_token=([^;]+)/.exec(login.headers["set-cookie"][0])?.[1]}` };
  const csrfHeader = { "x-csrf-token": login.body.csrfToken };

  // Offline transport: the OFFICIAL Google endpoints, scripted.
  setYouTubeOAuthRuntime({
    transport: async (request) => {
      if (request.url === GOOGLE_OAUTH_ENDPOINTS.token) {
        return jsonResponse(200, {
          access_token: "ya29.wiring-test-access",
          refresh_token: "1//wiring-test-refresh",
          expires_in: 3600,
          scope: YOUTUBE_OAUTH_SCOPES.join(" "),
        });
      }
      if (request.url.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
        return jsonResponse(200, {
          items: [{ id: "UCwiringchannel01", snippet: { title: "Wired Channel", customUrl: "@wired" } }],
        });
      }
      return jsonResponse(404, { error: "unknown_endpoint" });
    },
  });

  const start = await supertest(app)
    .post("/api/youtube/directors/agent-06/oauth/start")
    .set(bearerAuth)
    .set(csrfHeader)
    .expect(200);
  const state = new URL(start.body.authorizationUrl).searchParams.get("state");
  assert.ok(state);

  const callback = await supertest(app)
    .get(`/api/youtube/callback?code=wiring-auth-code&state=${encodeURIComponent(state)}`)
    .set(bearerAuth)
    .expect(302);
  assert.ok((callback.headers.location ?? "").includes("oauth=connected"));

  const yt = await supertest(app)
    .get("/api/youtube/directors/agent-06/status")
    .set(bearerAuth)
    .expect(200);
  assert.equal(yt.body.status, "connected");
  assert.equal(yt.body.secretManagerConfigured, true);
  assert.ok(!JSON.stringify(yt.body).includes("ya29.wiring-test-access"), "tokens never serialize");

  // Health now reports the bound (non-durable) adapter.
  const health = await supertest(app).get("/api/health").expect(200);
  assert.equal(health.body.oauthSecretManager.bound, true);
  assert.equal(health.body.oauthSecretManager.nonDurable, true);
});

test("a declared adapter that fails to load is a loud boot error (fail closed)", async () => {
  process.env.STPH_SECRET_MANAGER_ADAPTER = "custom";
  process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE = "file:///definitely/not/present/adapter.mjs";

  await assert.rejects(() => boot(), (err) => err?.code === "SECRET_MANAGER_ADAPTER_MODULE_UNAVAILABLE");
  const status = getOauthSecretManagerStatus();
  assert.equal(status.bound, false, "no adapter is half-bound after a failed boot");

  // Reset to a clean, unconfigured runtime for any later tests/processes.
  delete process.env.STPH_SECRET_MANAGER_ADAPTER;
  delete process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE;
  await boot();
  assert.equal(getOauthSecretManagerStatus().bound, false);
});

test("an operator-supplied placeholder is rejected, never wired as production custody", async () => {
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "stph-wiring-"));
  const { writeFileSync, rmSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  try {
    const placeholderModule = (await import("node:path")).join(dir, "placeholder-adapter.mjs");
    writeFileSync(placeholderModule, `
export default async function createSecretManager() {
  return {
    isPlaceholder: true,
    label: "in-memory-secret-manager (placeholder, non-durable)",
    async writeSecret() { return "opaque://placeholder/x"; },
    async readSecret() { return {}; },
    async deleteSecret() {},
  };
}
`);
    process.env.STPH_SECRET_MANAGER_ADAPTER = "custom";
    process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE = pathToFileURL(placeholderModule).href;

    await assert.rejects(() => boot(), (err) => err?.code === "SECRET_MANAGER_ADAPTER_PLACEHOLDER_REJECTED");
    assert.equal(getOauthSecretManagerStatus().bound, false, "Rule 3: placeholder never passes as wiring");

    delete process.env.STPH_SECRET_MANAGER_ADAPTER;
    delete process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE;
    await boot();
    assert.equal(getOauthSecretManagerStatus().bound, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
