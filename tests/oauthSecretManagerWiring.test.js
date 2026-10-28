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
  delete process.env.STPH_SECRET_MANAGER_VAULT_ADDRESS;
  delete process.env.STPH_SECRET_MANAGER_VAULT_TOKEN;
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID;
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_SECRET;
  delete process.env.STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL;
  setYouTubeOAuthRuntime({ transport: null, secretManagerFactory: null });
  await closeLoopbackVault();
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

// ---------------------------------------------------------------------------
// Durable custody (Issue #210): built-in Vault KV v2 adapter, end-to-end.
// A real loopback HTTP server plays the official KV v2 API — the adapter's
// DEFAULT fetch transport is exercised (no injection), proving the wiring
// path an operator will actually run. Live Vault deployment remains
// owner-gated; this is the code-side proof of the durable custody boundary.
// ---------------------------------------------------------------------------

const http = (await import("node:http")).default;

let loopbackVault = null;
const vaultStore = new Map();
const VAULT_TOKEN = "loopback-vault-token-value";

async function startLoopbackVault() {
  if (loopbackVault) return `http://127.0.0.1:${loopbackVault.address().port}`;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.headers["x-vault-token"] !== VAULT_TOKEN) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: ["permission denied"] }));
        return;
      }
      const key = `${req.method} ${req.url}`;
      if (req.method === "POST" && req.url.includes("/data/")) {
        vaultStore.set(req.url, JSON.parse(raw).data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { created_time: "2026-10-05T00:00:00Z", version: 1 } }));
      } else if (req.method === "GET" && req.url.includes("/data/")) {
        const data = vaultStore.get(req.url);
        if (!data) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ errors: [] }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { data, metadata: { version: 1 } } }));
        }
      } else if (req.method === "DELETE" && req.url.includes("/metadata/")) {
        const dataUrl = req.url.replace("/metadata/", "/data/");
        if (!vaultStore.has(dataUrl)) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ errors: [] }));
        } else {
          vaultStore.delete(dataUrl);
          res.writeHead(204);
          res.end();
        }
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: ["unsupported route"] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  loopbackVault = server;
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeLoopbackVault() {
  if (loopbackVault) {
    const server = loopbackVault;
    loopbackVault = null;
    await new Promise((resolve) => server.close(resolve));
  }
  vaultStore.clear();
}

test("vault-http declared: durable custody drives the real connect path into PostgreSQL", async () => {
  const address = await startLoopbackVault();
  process.env.STPH_SECRET_MANAGER_ADAPTER = "vault-http";
  process.env.STPH_SECRET_MANAGER_VAULT_ADDRESS = address;
  process.env.STPH_SECRET_MANAGER_VAULT_TOKEN = VAULT_TOKEN;

  const runtime = await boot();
  assert.equal(runtime.oauthSecretManager, true, "adapter bound at boot");
  const status = getOauthSecretManagerStatus();
  assert.equal(status.declared, true);
  assert.equal(status.bound, true);
  assert.equal(status.nonDurable, false, "durable custody, honestly labeled");
  assert.match(status.label, /vault-http/);

  // Several logins have already happened in this process; the per-IP auth
  // limiter (10/min) may be saturated. Wait out the window if needed rather
  // than bypassing the limiter (fail-safe, never fail-open).
  let login = await supertest(app)
    .post("/api/auth/login")
    .send({ email: "owner@stproduction.demo", password: process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026" });
  if (login.status === 429) {
    const retryAfter = Number(login.headers["retry-after"] ?? 60);
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 61) * 1000));
    login = await supertest(app)
      .post("/api/auth/login")
      .send({ email: "owner@stproduction.demo", password: process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026" });
  }
  assert.equal(login.status, 200, `demo login must succeed (got ${login.status})`);
  const bearerAuth = { Authorization: `Bearer ${/session_token=([^;]+)/.exec(login.headers["set-cookie"][0])?.[1]}` };
  const csrfHeader = { "x-csrf-token": login.body.csrfToken };

  setYouTubeOAuthRuntime({
    transport: async (request) => {
      if (request.url === GOOGLE_OAUTH_ENDPOINTS.token) {
        return jsonResponse(200, {
          access_token: "ya29.vault-path-access",
          refresh_token: "1//vault-path-refresh",
          expires_in: 3600,
          scope: YOUTUBE_OAUTH_SCOPES.join(" "),
        });
      }
      if (request.url.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
        return jsonResponse(200, {
          items: [{ id: "UCvaultchannel01", snippet: { title: "Vaulted Channel", customUrl: "@vaulted" } }],
        });
      }
      return jsonResponse(404, { error: "unknown_endpoint" });
    },
  });

  const start = await supertest(app)
    .post("/api/youtube/directors/agent-07/oauth/start")
    .set(bearerAuth)
    .set(csrfHeader)
    .expect(200);
  const state = new URL(start.body.authorizationUrl).searchParams.get("state");
  assert.ok(state);

  const callback = await supertest(app)
    .get(`/api/youtube/callback?code=vault-auth-code&state=${encodeURIComponent(state)}`)
    .set(bearerAuth)
    .expect(302);
  assert.ok((callback.headers.location ?? "").includes("oauth=connected"));

  // PostgreSQL: the vault:// locator persisted; no token material did.
  const health = await supertest(app).get("/api/health").expect(200);
  assert.equal(health.body.oauthSecretManager.bound, true);
  assert.equal(health.body.oauthSecretManager.nonDurable, false);

  const statusBody = await supertest(app)
    .get("/api/youtube/directors/agent-07/status")
    .set(bearerAuth)
    .expect(200);
  assert.equal(statusBody.body.status, "connected");
  assert.equal(statusBody.body.secretManagerConfigured, true);
  const statusBlob = JSON.stringify(statusBody.body);
  assert.ok(!statusBlob.includes("ya29.vault-path-access"), "access token never serializes");
  assert.ok(!statusBlob.includes(VAULT_TOKEN), "vault token never serializes");
  assert.ok(!statusBlob.includes("vault://"), "the locator itself never serializes to the client");

  // The token actually landed in the loopback Vault under a scoped path.
  const storedKeys = [...vaultStore.keys()];
  assert.equal(storedKeys.length, 1);
  assert.match(storedKeys[0], /\/v1\/secret\/data\/stph\/.+\/agent-07\/youtube\/[0-9a-f]{24}$/);
  const stored = [...vaultStore.values()][0];
  assert.equal(stored.payload.access_token, "ya29.vault-path-access");

  // Reset to unconfigured for later tests.
  delete process.env.STPH_SECRET_MANAGER_ADAPTER;
  delete process.env.STPH_SECRET_MANAGER_VAULT_ADDRESS;
  delete process.env.STPH_SECRET_MANAGER_VAULT_TOKEN;
  setYouTubeOAuthRuntime({ transport: null, secretManagerFactory: null });
  await boot();
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
