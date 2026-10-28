/**
 * YouTube OAuth lifecycle — repository + service unit tests (Issue #206).
 *
 * Everything here runs OFFLINE against the labeled demo adapter and injected
 * fakes: no network call, no live Google account, no real secret manager.
 *
 * Coverage:
 *   - state crypto-randomness + hash-only persistence (plaintext never stored)
 *   - expiry, replay, atomic single-use, wrong owner / director / provider
 *   - official Google endpoint usage through an injected transport
 *   - token exchange + YouTube account verification success and failure matrix
 *   - tokens written ONLY through the injected secret-manager adapter; the
 *     database and every DTO carry the opaque locator and nothing else
 *   - honest Director-scoped status and owner-authorized revocation (provider
 *     revocation, secret cleanup, and status are reported as separate facts)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  YouTubeOAuthRepository,
  OAUTH_PROVIDER_KEY,
  ACCOUNT_STATUSES,
  isLocatorShaped,
} from "../src/catalog/youtubeOAuthRepository.js";
import {
  YouTubeOAuthService,
  OAUTH_STATE_TTL_MS,
  GOOGLE_OAUTH_ENDPOINTS,
  YOUTUBE_OAUTH_SCOPES,
  mintStateToken,
  hashStateToken,
  resolveRedirectUri,
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  fetchYouTubeChannelIdentity,
  revokeGoogleToken,
  createInMemorySecretManager,
  setYouTubeOAuthRuntime,
  getYouTubeOAuthRuntime,
  loadOAuthConfig,
  isOAuthConfigured,
} from "../src/catalog/youtubeOAuthService.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

// ---------------------------------------------------------------------------
// Environment + harness
// ---------------------------------------------------------------------------

// loadOAuthConfig() reads process.env at call time (never cached at module
// load), so tests set values in-process. No live credentials are involved.
const OAUTH_ENV = Object.freeze({
  STPH_YOUTUBE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  STPH_YOUTUBE_OAUTH_CLIENT_SECRET: "test-client-secret-value",
  STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL: "https://dashboard.stproduction.test",
});
for (const [key, value] of Object.entries(OAUTH_ENV)) {
  process.env[key] = value;
}

test.after(() => {
  for (const key of Object.keys(OAUTH_ENV)) delete process.env[key];
  setYouTubeOAuthRuntime({ transport: null, secretManagerFactory: null });
});

async function buildHarness() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `owner-${ownerId.slice(0, 8)}@youtube-oauth.test`, "x".repeat(64), "owner", "authenticated"],
  );
  const secrets = createInMemorySecretManager();
  return { db, ownerId, repo: new YouTubeOAuthRepository(db), secrets };
}

function jsonResponse(status, payload) {
  return { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

/** Success responder for every official Google endpoint the service uses. */
function defaultGoogleResponder(request) {
  if (request.url === GOOGLE_OAUTH_ENDPOINTS.token) {
    return jsonResponse(200, {
      access_token: "ya29.test-access-token",
      refresh_token: "1//test-refresh-token",
      expires_in: 3600,
      scope: YOUTUBE_OAUTH_SCOPES.join(" "),
    });
  }
  if (request.url.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
    return jsonResponse(200, {
      items: [{ id: "UCtestchannel123", snippet: { title: "Public Channel Name", customUrl: "@public-handle" } }],
    });
  }
  if (request.url === GOOGLE_OAUTH_ENDPOINTS.revoke) {
    return { status: 200, body: "" };
  }
  return jsonResponse(404, { error: "unknown_endpoint" });
}

function scriptedTransport(respond = defaultGoogleResponder) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    return respond(request, calls.length);
  };
  return { transport, calls };
}

async function startWithSuccess(service, ownerId, agentId = "agent-01") {
  const start = await service.start({ ownerId, agentId });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  assert.ok(state, "authorization URL carries the state token");
  return { start, state };
}

// ---------------------------------------------------------------------------
// State token crypto + configuration
// ---------------------------------------------------------------------------

test("state tokens are crypto-random and stored only as SHA-256 hashes", () => {
  const first = mintStateToken();
  const second = mintStateToken();
  assert.notEqual(first, second, "two mints never collide");
  assert.ok(first.length >= 40, "32 random bytes carry real entropy");
  assert.match(first, /^[A-Za-z0-9_-]+$/, "URL-safe base64 without padding");

  const hash = hashStateToken(first);
  assert.match(hash, /^[0-9a-f]{64}$/, "hash is SHA-256 hex");
  assert.notEqual(hash, first, "the hash never equals the plaintext state");
  assert.equal(hashStateToken(first), hash, "hashing is deterministic");
});

test("loadOAuthConfig reads operator env and isOAuthConfigured requires all three values", () => {
  assert.deepEqual(loadOAuthConfig({}), { clientId: null, clientSecret: null, redirectBaseUrl: null });
  assert.equal(isOAuthConfigured(loadOAuthConfig({})), false);

  const partial = loadOAuthConfig({ STPH_YOUTUBE_OAUTH_CLIENT_ID: "a" });
  assert.equal(isOAuthConfigured(partial), false, "client id alone is not configuration");

  assert.equal(isOAuthConfigured(loadOAuthConfig()), true, "the process env is fully configured in this test");
});

test("resolveRedirectUri is HTTPS-only and server-controlled", () => {
  const uri = resolveRedirectUri({ baseUrl: "https://dashboard.stproduction.test" });
  assert.equal(uri, "https://dashboard.stproduction.test/api/youtube/callback");
  assert.equal(
    resolveRedirectUri({ baseUrl: "https://dashboard.stproduction.test/", callbackPath: "/api/youtube/callback" }),
    "https://dashboard.stproduction.test/api/youtube/callback",
  );
  assert.equal(
    resolveRedirectUri({ baseUrl: "https://host.test:443" }),
    "https://host.test/api/youtube/callback",
    "explicit port 443 is normalized, not rejected",
  );

  for (const baseUrl of [
    "http://dashboard.stproduction.test",
    "https://user:pass@dashboard.stproduction.test",
    "https://dashboard.stproduction.test:8443",
    "https://dashboard.stproduction.test?x=1",
    "https://dashboard.stproduction.test#frag",
    "not a url",
    "",
  ]) {
    assert.throws(() => resolveRedirectUri({ baseUrl }), /OAUTH_REDIRECT_BASE_INVALID/, `rejects ${baseUrl}`);
  }
});

test("authorization URL targets the official Google endpoint with state and scopes", () => {
  const url = new URL(buildGoogleAuthorizationUrl({
    clientId: "test-client-id.apps.googleusercontent.com",
    redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
    state: "state-token-xyz",
  }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "test-client-id.apps.googleusercontent.com");
  assert.equal(url.searchParams.get("redirect_uri"), "https://dashboard.stproduction.test/api/youtube/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-token-xyz");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("scope"), YOUTUBE_OAUTH_SCOPES.join(" "));
  assert.ok(YOUTUBE_OAUTH_SCOPES.includes("https://www.googleapis.com/auth/youtube.readonly"));
  assert.ok(YOUTUBE_OAUTH_SCOPES.includes("https://www.googleapis.com/auth/youtube.upload"));

  assert.throws(
    () => buildGoogleAuthorizationUrl({ clientId: null, redirectUri: "https://x.test/cb", state: "s" }),
    /OAUTH_NOT_CONFIGURED/,
  );
});

// ---------------------------------------------------------------------------
// Google API adapters (injected transport, offline)
// ---------------------------------------------------------------------------

test("token exchange posts the code to the official endpoint and returns token material", async () => {
  const { transport, calls } = scriptedTransport();
  const tokens = await exchangeGoogleAuthorizationCode({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret-value",
    redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
    code: "auth-code-1",
    transport,
  });
  assert.equal(tokens.accessToken, "ya29.test-access-token");
  assert.equal(tokens.refreshToken, "1//test-refresh-token");
  assert.equal(tokens.expiresIn, 3600);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, GOOGLE_OAUTH_ENDPOINTS.token);

  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get("code"), "auth-code-1");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("redirect_uri"), "https://dashboard.stproduction.test/api/youtube/callback");
});

test("token exchange maps Google errors and malformed responses to stable codes", async () => {
  const base = {
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret-value",
    redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
    code: "auth-code-1",
  };

  const rejected = scriptedTransport(() => jsonResponse(400, { error: "invalid_grant" }));
  await assert.rejects(
    () => exchangeGoogleAuthorizationCode({ ...base, transport: rejected.transport }),
    (err) => err.code === "OAUTH_TOKEN_EXCHANGE_FAILED" && err.providerStatus === 400,
  );

  const malformed = scriptedTransport(() => ({ status: 200, body: "{not json" }));
  await assert.rejects(
    () => exchangeGoogleAuthorizationCode({ ...base, transport: malformed.transport }),
    /OAUTH_TOKEN_RESPONSE_MALFORMED/,
  );

  const emptyToken = scriptedTransport(() => jsonResponse(200, { token_type: "Bearer" }));
  await assert.rejects(
    () => exchangeGoogleAuthorizationCode({ ...base, transport: emptyToken.transport }),
    /OAUTH_TOKEN_RESPONSE_MALFORMED/,
  );

  await assert.rejects(
    () => exchangeGoogleAuthorizationCode({ ...base, clientSecret: null, transport: scriptedTransport().transport }),
    /OAUTH_NOT_CONFIGURED/,
  );
  await assert.rejects(
    () => exchangeGoogleAuthorizationCode({ ...base, code: "", transport: scriptedTransport().transport }),
    /OAUTH_CALLBACK_INVALID/,
  );
});

test("transport failures normalize to OAUTH_PROVIDER_UNREACHABLE without leaking details", async () => {
  const failing = scriptedTransport(() => {
    throw new Error("socket hang up for opaque://in-memory/leak");
  });
  await assert.rejects(
    () => exchangeGoogleAuthorizationCode({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret-value",
      redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
      code: "auth-code-1",
      transport: failing.transport,
    }),
    (err) => err.code === "OAUTH_PROVIDER_UNREACHABLE" && !String(err.detail ?? "").includes("opaque://"),
  );

  const garbage = scriptedTransport(() => ({ status: "200", body: "{}" }));
  await assert.rejects(
    () => exchangeGoogleAuthorizationCode({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret-value",
      redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
      code: "auth-code-1",
      transport: garbage.transport,
    }),
    /OAUTH_PROVIDER_UNREACHABLE/,
  );
});

test("YouTube verification requires a real channel identity; absence is honest", async () => {
  const success = scriptedTransport();
  const identity = await fetchYouTubeChannelIdentity({ accessToken: "ya29.test-access-token", transport: success.transport });
  assert.deepEqual(identity, { channelId: "UCtestchannel123", title: "Public Channel Name", handle: "@public-handle" });
  assert.equal(success.calls[0].method, "GET");
  assert.equal(success.calls[0].headers.authorization, "Bearer ya29.test-access-token");

  const noChannel = scriptedTransport(() => jsonResponse(200, { items: [] }));
  await assert.rejects(
    () => fetchYouTubeChannelIdentity({ accessToken: "ya29.test-access-token", transport: noChannel.transport }),
    /OAUTH_YOUTUBE_CHANNEL_NOT_FOUND/,
  );

  const apiError = scriptedTransport(() => jsonResponse(403, { error: { code: 403 } }));
  await assert.rejects(
    () => fetchYouTubeChannelIdentity({ accessToken: "ya29.test-access-token", transport: apiError.transport }),
    /OAUTH_YOUTUBE_VERIFICATION_FAILED/,
  );

  await assert.rejects(
    () => fetchYouTubeChannelIdentity({ accessToken: "", transport: success.transport }),
    /OAUTH_TOKEN_RESPONSE_MALFORMED/,
  );
});

test("token revocation treats Google's invalid_token as already revoked, never as fresh success", async () => {
  const ok = scriptedTransport(() => ({ status: 200, body: "" }));
  assert.deepEqual(await revokeGoogleToken({ token: "ya29.test-access-token", transport: ok.transport }), {
    revoked: true,
    alreadyRevoked: false,
  });

  const already = scriptedTransport(() => jsonResponse(400, { error: "invalid_token" }));
  assert.deepEqual(await revokeGoogleToken({ token: "ya29.test-access-token", transport: already.transport }), {
    revoked: true,
    alreadyRevoked: true,
  });

  const failed = scriptedTransport(() => jsonResponse(500, { error: "backend_error" }));
  await assert.rejects(
    () => revokeGoogleToken({ token: "ya29.test-access-token", transport: failed.transport }),
    /OAUTH_REVOKE_FAILED/,
  );

  await assert.rejects(() => revokeGoogleToken({ token: "", transport: ok.transport }), /OAUTH_SECRET_READ_FAILED/);
});

test("the in-memory secret manager is a labeled non-durable placeholder", async () => {
  const manager = createInMemorySecretManager();
  assert.equal(manager.isPlaceholder, true);
  assert.match(manager.label, /placeholder/);

  const locator = await manager.writeSecret({
    ownerId: "owner-1",
    agentId: "agent-01",
    providerKey: OAUTH_PROVIDER_KEY,
    payload: { access_token: "ya29.test-access-token" },
  });
  assert.equal(isLocatorShaped(locator), true, "writeSecret returns a locator-shaped reference");
  assert.deepEqual(await manager.readSecret({ locator }), { access_token: "ya29.test-access-token" });
  await manager.deleteSecret({ locator });
  await assert.rejects(() => manager.readSecret({ locator }), /SECRET_MANAGER_ENTRY_NOT_FOUND/);
});

// ---------------------------------------------------------------------------
// Repository: state lifecycle
// ---------------------------------------------------------------------------

test("state rows persist ONLY the hash and reject malformed input", async () => {
  const { repo, ownerId } = await buildHarness();
  const stateHash = hashStateToken(mintStateToken());
  const inserted = await repo.insertState({
    stateHash,
    ownerId,
    agentId: "agent-01",
    redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(inserted.stateHash, stateHash);
  assert.equal(inserted.providerKey, OAUTH_PROVIDER_KEY);
  assert.equal(inserted.consumedAt, null);

  const found = await repo.findStateByHash(stateHash);
  assert.equal(found.ownerId, ownerId);
  assert.equal(found.agentId, "agent-01");

  await assert.rejects(
    () => repo.insertState({
      stateHash: "not-a-hash",
      ownerId,
      agentId: "agent-01",
      redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
      expiresAt: new Date(Date.now() + 60_000),
    }),
    /OAUTH_STATE_HASH_INVALID/,
  );
  await assert.rejects(
    () => repo.insertState({
      stateHash: hashStateToken(mintStateToken()),
      ownerId,
      agentId: "agent-01",
      redirectUri: "http://insecure.test/callback",
      expiresAt: new Date(Date.now() + 60_000),
    }),
    /OAUTH_REDIRECT_URI_INVALID/,
  );
  await assert.rejects(
    () => repo.insertState({
      stateHash: hashStateToken(mintStateToken()),
      ownerId,
      agentId: "agent-01",
      redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
      expiresAt: new Date("garbage"),
    }),
    /OAUTH_STATE_EXPIRY_INVALID/,
  );
});

test("state claim is atomically single-use and binding-scoped", async () => {
  const { repo, ownerId } = await buildHarness();
  const stateHash = hashStateToken(mintStateToken());
  await repo.insertState({
    stateHash,
    ownerId,
    agentId: "agent-01",
    redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
    expiresAt: new Date(Date.now() + 60_000),
  });

  assert.equal(
    await repo.claimState({ stateHash, ownerId, agentId: "agent-01", providerKey: OAUTH_PROVIDER_KEY }),
    true,
    "the first claim wins",
  );
  assert.equal(
    await repo.claimState({ stateHash, ownerId, agentId: "agent-01", providerKey: OAUTH_PROVIDER_KEY }),
    false,
    "a replay loses the atomic race",
  );

  const secondHash = hashStateToken(mintStateToken());
  await repo.insertState({
    stateHash: secondHash,
    ownerId,
    agentId: "agent-01",
    redirectUri: "https://dashboard.stproduction.test/api/youtube/callback",
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(
    await repo.claimState({ stateHash: secondHash, ownerId, agentId: "agent-02", providerKey: OAUTH_PROVIDER_KEY }),
    false,
    "wrong director cannot claim",
  );
  assert.equal(
    await repo.claimState({ stateHash: secondHash, ownerId: randomUUID(), agentId: "agent-01", providerKey: OAUTH_PROVIDER_KEY }),
    false,
    "wrong owner cannot claim",
  );
  assert.equal(
    await repo.claimState({ stateHash: secondHash, ownerId, agentId: "agent-01", providerKey: "instagram" }),
    false,
    "wrong provider cannot claim",
  );
  assert.equal(
    await repo.claimState({ stateHash: secondHash, ownerId, agentId: "agent-01", providerKey: OAUTH_PROVIDER_KEY }),
    true,
    "the untouched state still belongs to its real bindings",
  );
});

test("expired and spent states are cleaned up while live states survive", async () => {
  const { repo, ownerId } = await buildHarness();
  const now = new Date();
  const expiredHash = hashStateToken(mintStateToken());
  const spentHash = hashStateToken(mintStateToken());
  const liveHash = hashStateToken(mintStateToken());

  await repo.insertState({ stateHash: expiredHash, ownerId, agentId: "agent-01", redirectUri: "https://d.test/cb", expiresAt: new Date(now.getTime() - 1000) });
  await repo.insertState({ stateHash: spentHash, ownerId, agentId: "agent-01", redirectUri: "https://d.test/cb", expiresAt: new Date(now.getTime() + 60_000) });
  await repo.insertState({ stateHash: liveHash, ownerId, agentId: "agent-01", redirectUri: "https://d.test/cb", expiresAt: new Date(now.getTime() + 60_000) });
  await repo.claimState({ stateHash: spentHash, ownerId, agentId: "agent-01", providerKey: OAUTH_PROVIDER_KEY });

  const deleted = await repo.deleteExpiredStates(ownerId, "agent-01", { now });
  assert.equal(deleted, 2, "expired + spent removed, live untouched");
  assert.equal(await repo.findStateByHash(expiredHash), null);
  assert.equal(await repo.findStateByHash(spentHash), null);
  assert.ok(await repo.findStateByHash(liveHash), "live state survives cleanup");

  const recent = await repo.listRecentStates(ownerId, "agent-01", { limit: 1 });
  assert.equal(recent.length, 1);
});

// ---------------------------------------------------------------------------
// Repository: account persistence (locator-only, safe DTOs)
// ---------------------------------------------------------------------------

test("account upsert serializes safe DTOs and structurally rejects raw tokens", async () => {
  const { repo, ownerId } = await buildHarness();
  assert.equal(await repo.agentExists("agent-01"), true);
  assert.equal(await repo.agentExists("agent-does-not-exist"), false);

  const account = await repo.upsertAccount({
    ownerId,
    agentId: "agent-01",
    status: "connected",
    channelId: "UCtestchannel123",
    channelTitle: "Public Channel Name",
    channelHandle: "@public-handle",
    oauthScope: YOUTUBE_OAUTH_SCOPES.join(" "),
    tokenLocator: "vault://st/agent-01/youtube/oauth",
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    verifiedAt: new Date(),
  });
  assert.equal(account.status, "connected");
  assert.equal(account.channel.id, "UCtestchannel123");
  assert.equal(account.channel.title, "Public Channel Name");
  assert.ok(!JSON.stringify(account).includes("vault://"), "the locator never serializes");
  assert.ok(!("tokenLocator" in account), "there is no locator field at all");
  assert.ok(!JSON.stringify(account).toLowerCase().includes("access_token"));

  await assert.rejects(
    () => repo.upsertAccount({
      ownerId,
      agentId: "agent-01",
      status: "connected",
      channelId: "UCtestchannel123",
      tokenLocator: "ya29.raw-token-value",
    }),
    /SECRET_MANAGER_LOCATOR_INVALID/,
    "raw token material is structurally rejected",
  );
  await assert.rejects(
    () => repo.upsertAccount({
      ownerId,
      agentId: "agent-01",
      status: "connected",
      channelId: null,
      tokenLocator: "vault://st/agent-01/youtube/oauth",
    }),
    /OAUTH_YOUTUBE_IDENTITY_REQUIRED/,
    "CONNECTED without a verified channel is impossible (Rule 1)",
  );
  await assert.rejects(
    () => repo.upsertAccount({
      ownerId,
      agentId: "agent-01",
      status: "authorized",
      channelId: "UCtestchannel123",
      tokenLocator: "vault://st/agent-01/youtube/oauth",
    }),
    /OAUTH_ACCOUNT_STATUS_INVALID/,
    "only the existing sql/003 statuses are legal (R5)",
  );
  assert.deepEqual(ACCOUNT_STATUSES, ["unconfigured", "connected", "expired", "disconnected"]);
});

test("account reads are scoped by owner and director and disconnect clears the locator", async () => {
  const { repo, ownerId } = await buildHarness();
  await repo.upsertAccount({
    ownerId,
    agentId: "agent-01",
    status: "connected",
    channelId: "UCtestchannel123",
    tokenLocator: "vault://st/agent-01/youtube/oauth",
  });

  assert.equal(await repo.getAccount(ownerId, "agent-02"), null, "no cross-director leakage");
  assert.equal(await repo.getAccount(randomUUID(), "agent-01"), null, "no cross-owner leakage");
  assert.equal((await repo.getAccount(ownerId, "agent-01")).status, "connected");

  const raw = await repo.getAccountRow(ownerId, "agent-01");
  assert.equal(raw.token_locator, "vault://st/agent-01/youtube/oauth", "the raw row keeps the locator server-side only");

  assert.equal(await repo.recordErrorCode(ownerId, "agent-01", "OAUTH_REVOKE_FAILED"), true);
  assert.equal((await repo.getAccountRow(ownerId, "agent-01")).last_error_code, "OAUTH_REVOKE_FAILED");

  assert.equal(await repo.markDisconnected(ownerId, "agent-02"), false, "cross-director disconnect is a no-op");
  assert.equal(await repo.markDisconnected(ownerId, "agent-01"), true);
  const disconnected = await repo.getAccountRow(ownerId, "agent-01");
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.token_locator, null, "the stale locator is cleared");
  assert.ok(disconnected.revoked_at, "revocation timestamp recorded");
});

// ---------------------------------------------------------------------------
// Service: start
// ---------------------------------------------------------------------------

test("start fails honestly without configuration or a secret manager", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  const service = new YouTubeOAuthService({ db });

  const clientId = process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID;
  delete process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID;
  setYouTubeOAuthRuntime({ secretManagerFactory: () => secrets });
  await assert.rejects(() => service.start({ ownerId, agentId: "agent-01" }), /OAUTH_NOT_CONFIGURED/);
  process.env.STPH_YOUTUBE_OAUTH_CLIENT_ID = clientId;

  setYouTubeOAuthRuntime({ secretManagerFactory: null });
  await assert.rejects(() => service.start({ ownerId, agentId: "agent-01" }), /SECRET_MANAGER_NOT_CONFIGURED/);

  setYouTubeOAuthRuntime({ secretManagerFactory: () => secrets });
  await assert.rejects(() => service.start({ ownerId, agentId: "agent-does-not-exist" }), /AGENT_NOT_FOUND/);
  await assert.rejects(() => service.start({ ownerId: null, agentId: "agent-01" }), /REQUEST_VALIDATION_FAILED/);
});

test("start mints a single-use state persisted only as its hash", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  setYouTubeOAuthRuntime({ transport: scriptedTransport().transport, secretManagerFactory: () => secrets });
  const service = new YouTubeOAuthService({ db });

  const start = await service.start({ ownerId, agentId: "agent-01" });
  assert.equal(start.providerKey, OAUTH_PROVIDER_KEY);
  assert.equal(start.agentId, "agent-01");

  const url = new URL(start.authorizationUrl);
  assert.equal(url.origin, "https://accounts.google.com");
  const state = url.searchParams.get("state");
  assert.equal(url.searchParams.get("redirect_uri"), "https://dashboard.stproduction.test/api/youtube/callback");

  const rows = await db.query("SELECT * FROM youtube_oauth_states");
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].state_hash, hashStateToken(state));
  assert.match(rows.rows[0].state_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rows.rows).includes(state), "the plaintext state is never persisted");
  assert.equal(rows.rows[0].consumed_at ?? null, null, "state starts un-consumed");
  const expiresAt = new Date(rows.rows[0].expires_at).getTime();
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + OAUTH_STATE_TTL_MS + 5000, "state expiry is bounded");
});

// ---------------------------------------------------------------------------
// Service: callback (full offline lifecycle)
// ---------------------------------------------------------------------------

test("callback completes the full lifecycle with tokens confined to the secret manager", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  const { transport, calls } = scriptedTransport();
  setYouTubeOAuthRuntime({ transport, secretManagerFactory: () => secrets });
  const service = new YouTubeOAuthService({ db });

  const { state } = await startWithSuccess(service, ownerId);
  const result = await service.handleCallback({ ownerId, code: "auth-code-1", state });

  assert.equal(result.providerKey, OAUTH_PROVIDER_KEY);
  assert.equal(result.agentId, "agent-01");
  assert.equal(result.account.status, "connected");
  assert.equal(result.account.channel.id, "UCtestchannel123");
  assert.equal(result.account.channel.title, "Public Channel Name");
  assert.equal(result.account.channel.handle, "@public-handle");
  assert.ok(!JSON.stringify(result).includes("ya29"), "raw access tokens never serialize");
  assert.ok(!JSON.stringify(result).includes("1//"), "raw refresh tokens never serialize");

  // Official endpoints were used: token exchange, then channel verification.
  const urls = calls.map((call) => call.url);
  assert.ok(urls.includes(GOOGLE_OAUTH_ENDPOINTS.token));
  assert.ok(urls.some((u) => u.startsWith("https://www.googleapis.com/youtube/v3/channels")));

  // The database holds an opaque locator and NOTHING secret-shaped.
  const rows = await db.query("SELECT * FROM youtube_director_accounts");
  assert.equal(rows.rows.length, 1);
  const serialized = JSON.stringify(rows.rows);
  assert.ok(!serialized.includes("ya29"), "access token never reaches PostgreSQL");
  assert.ok(!serialized.includes("1//"), "refresh token never reaches PostgreSQL");
  assert.ok(!serialized.includes("test-client-secret-value"), "client secret never reaches PostgreSQL");
  assert.ok(!serialized.includes("auth-code-1"), "authorization code never reaches PostgreSQL");
  assert.equal(rows.rows[0].token_locator.startsWith("opaque://"), true, "only an opaque locator is persisted");
  assert.equal(rows.rows[0].status, "connected");
  assert.ok(rows.rows[0].verified_at, "verification evidence recorded");
  assert.ok(rows.rows[0].token_expires_at, "token expiry recorded");

  // The secret itself is retrievable ONLY through the injected manager.
  const stored = await secrets.readSecret({ locator: rows.rows[0].token_locator });
  assert.equal(stored.access_token, "ya29.test-access-token");
  assert.equal(stored.refresh_token, "1//test-refresh-token");

  // The state is spent: the same state cannot be replayed.
  const stateRow = await db.query("SELECT consumed_at FROM youtube_oauth_states");
  assert.ok(stateRow.rows[0].consumed_at, "state consumed exactly once");
});

test("callback rejects unknown, expired, mismatched, and replayed states honestly", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  setYouTubeOAuthRuntime({ transport: scriptedTransport().transport, secretManagerFactory: () => secrets });

  let nowMs = Date.parse("2026-10-05T00:00:00.000Z");
  const service = new YouTubeOAuthService({ db, now: () => new Date(nowMs) });

  await assert.rejects(
    () => service.handleCallback({ ownerId, code: "c", state: mintStateToken() }),
    /OAUTH_STATE_INVALID/,
  );
  await assert.rejects(
    () => service.handleCallback({ ownerId, code: "c", state: "" }),
    /OAUTH_CALLBACK_INVALID/,
  );
  await assert.rejects(
    () => service.handleCallback({ ownerId, code: "", state: "s" }),
    /OAUTH_CALLBACK_INVALID/,
  );
  await assert.rejects(
    () => service.handleCallback({ ownerId, code: "c", state: "s", providerError: "access_denied" }),
    /OAUTH_OWNER_DENIED/,
  );

  // A different owner's session cannot consume this state (binding mismatch).
  const { state } = await startWithSuccess(service, ownerId);
  await assert.rejects(
    () => service.handleCallback({ ownerId: randomUUID(), code: "c", state }),
    /OAUTH_STATE_MISMATCH/,
  );

  // Expiry is evaluated in JS against the state row, never faked.
  nowMs += OAUTH_STATE_TTL_MS + 1000;
  await assert.rejects(
    () => service.handleCallback({ ownerId, code: "c", state }),
    /OAUTH_STATE_EXPIRED/,
  );
});

test("callback never burns a state on a binding mismatch, and replay loses the atomic race", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  setYouTubeOAuthRuntime({ transport: scriptedTransport().transport, secretManagerFactory: () => secrets });
  const service = new YouTubeOAuthService({ db });

  const { state } = await startWithSuccess(service, ownerId);
  await assert.rejects(
    () => service.handleCallback({ ownerId: randomUUID(), code: "c", state }),
    /OAUTH_STATE_MISMATCH/,
  );

  // The genuine owner still completes the round: the mismatch did not consume it.
  const result = await service.handleCallback({ ownerId, code: "auth-code-1", state });
  assert.equal(result.account.status, "connected");

  // Replay: the exact same state loses against the atomic single-use claim.
  await assert.rejects(
    () => service.handleCallback({ ownerId, code: "auth-code-2", state }),
    /OAUTH_STATE_REPLAYED/,
  );
});

test("secret-manager write failure surfaces OAUTH_SECRET_WRITE_FAILED and never fakes connected", async () => {
  const { db, ownerId } = await buildHarness();
  const failingManager = {
    isPlaceholder: false,
    label: "failing-test-double",
    async writeSecret() { throw new Error("secret backend unavailable: vault://leak"); },
    async readSecret() { throw new Error("unavailable"); },
    async deleteSecret() { throw new Error("unavailable"); },
  };
  setYouTubeOAuthRuntime({ transport: scriptedTransport().transport, secretManagerFactory: () => failingManager });
  const service = new YouTubeOAuthService({ db });

  const { state } = await startWithSuccess(service, ownerId);
  await assert.rejects(
    () => service.handleCallback({ ownerId, code: "auth-code-1", state }),
    /OAUTH_SECRET_WRITE_FAILED/,
  );
  const rows = await db.query("SELECT * FROM youtube_director_accounts");
  assert.equal(rows.rows.length, 0, "no account row is invented when the secret write fails");
});

test("status is honest: unconfigured, pending authorization, connected, then disconnected", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  setYouTubeOAuthRuntime({ transport: scriptedTransport().transport, secretManagerFactory: () => secrets });
  const service = new YouTubeOAuthService({ db });

  const initial = await service.getStatus({ ownerId, agentId: "agent-01" });
  assert.equal(initial.status, "unconfigured");
  assert.equal(initial.account, null);
  assert.equal(initial.pendingAuthorization, null);
  assert.equal(initial.oauthConfigured, true);
  assert.equal(initial.secretManagerConfigured, true);

  const { state } = await startWithSuccess(service, ownerId);
  const pending = await service.getStatus({ ownerId, agentId: "agent-01" });
  assert.equal(pending.status, "unconfigured");
  assert.ok(pending.pendingAuthorization, "an un-consumed state is reported as pending authorization");
  assert.ok(pending.pendingAuthorization.stateExpiresAt);

  await service.handleCallback({ ownerId, code: "auth-code-1", state });
  const connected = await service.getStatus({ ownerId, agentId: "agent-01" });
  assert.equal(connected.status, "connected");
  assert.equal(connected.account.channel.id, "UCtestchannel123");
  assert.equal(connected.pendingAuthorization, null);

  setYouTubeOAuthRuntime({ secretManagerFactory: null });
  const unmanaged = await service.getStatus({ ownerId, agentId: "agent-01" });
  assert.equal(unmanaged.secretManagerConfigured, false, "missing runtime collaborators are reported, not hidden");
  setYouTubeOAuthRuntime({ secretManagerFactory: () => secrets });

  await assert.rejects(() => service.getStatus({ ownerId, agentId: "nope" }), /AGENT_NOT_FOUND/);
});

// ---------------------------------------------------------------------------
// Service: revocation (honest, separated facts)
// ---------------------------------------------------------------------------

test("revocation revokes at Google, deletes the secret, and disconnects", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  const { transport, calls } = scriptedTransport();
  setYouTubeOAuthRuntime({ transport, secretManagerFactory: () => secrets });
  const service = new YouTubeOAuthService({ db });

  const { state } = await startWithSuccess(service, ownerId);
  await service.handleCallback({ ownerId, code: "auth-code-1", state });
  const locator = (await db.query("SELECT token_locator FROM youtube_director_accounts")).rows[0].token_locator;

  const result = await service.revoke({ ownerId, agentId: "agent-01" });
  assert.equal(result.status, "disconnected");
  assert.equal(result.providerRevoked, true);
  assert.equal(result.secretCleanupFailed, false);
  assert.equal(result.alreadyDisconnected, false);

  assert.ok(calls.some((call) => call.url === GOOGLE_OAUTH_ENDPOINTS.revoke), "official Google revocation endpoint used");
  await assert.rejects(() => secrets.readSecret({ locator }), /SECRET_MANAGER_ENTRY_NOT_FOUND/, "secret deleted");

  const row = await db.query("SELECT * FROM youtube_director_accounts");
  assert.equal(row.rows[0].status, "disconnected");
  assert.equal(row.rows[0].token_locator, null);
  assert.ok(row.rows[0].revoked_at);
});

test("provider revocation failure keeps the account connected and records the honest error", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  const { transport } = scriptedTransport((request) => {
    if (request.url === GOOGLE_OAUTH_ENDPOINTS.revoke) return jsonResponse(500, { error: "backend_error" });
    return defaultGoogleResponder(request);
  });
  setYouTubeOAuthRuntime({ transport, secretManagerFactory: () => secrets });
  const service = new YouTubeOAuthService({ db });

  const { state } = await startWithSuccess(service, ownerId);
  await service.handleCallback({ ownerId, code: "auth-code-1", state });

  await assert.rejects(() => service.revoke({ ownerId, agentId: "agent-01" }), /OAUTH_REVOKE_FAILED/);
  const row = await db.query("SELECT * FROM youtube_director_accounts");
  assert.equal(row.rows[0].status, "connected", "a live grant is never falsely reported as revoked");
  assert.equal(row.rows[0].last_error_code, "OAUTH_REVOKE_FAILED");
  assert.equal(row.rows[0].token_locator.startsWith("opaque://"), true, "the locator survives for a retry");
});

test("revocation without a readable secret marks the connection dead honestly", async () => {
  const { db, ownerId } = await buildHarness();
  const manager = createInMemorySecretManager();
  setYouTubeOAuthRuntime({ transport: scriptedTransport().transport, secretManagerFactory: () => manager });
  const service = new YouTubeOAuthService({ db });

  const { state } = await startWithSuccess(service, ownerId);
  await service.handleCallback({ ownerId, code: "auth-code-1", state });
  const locator = (await db.query("SELECT token_locator FROM youtube_director_accounts")).rows[0].token_locator;
  await manager.deleteSecret({ locator });

  const result = await service.revoke({ ownerId, agentId: "agent-01" });
  assert.equal(result.status, "disconnected");
  assert.equal(result.providerRevoked, false, "never claims provider revocation without one");
  assert.equal(result.errorCode, "OAUTH_SECRET_READ_FAILED");

  const row = await db.query("SELECT * FROM youtube_director_accounts");
  assert.equal(row.rows[0].status, "disconnected");
  assert.equal(row.rows[0].token_locator, null);
});

test("revocation is scoped and idempotent for disconnected accounts", async () => {
  const { db, ownerId, secrets } = await buildHarness();
  setYouTubeOAuthRuntime({ transport: scriptedTransport().transport, secretManagerFactory: () => secrets });
  const service = new YouTubeOAuthService({ db });

  await assert.rejects(() => service.revoke({ ownerId, agentId: "agent-01" }), /NOT_FOUND/);

  const { state } = await startWithSuccess(service, ownerId);
  await service.handleCallback({ ownerId, code: "auth-code-1", state });
  await service.revoke({ ownerId, agentId: "agent-01" });

  const again = await service.revoke({ ownerId, agentId: "agent-01" });
  assert.equal(again.alreadyDisconnected, true);
  assert.equal(again.providerRevoked, false);
  assert.equal(again.secretCleanupFailed, false);
});

test("runtime registry exposes and resets injected collaborators", () => {
  const transport = scriptedTransport().transport;
  const factory = () => createInMemorySecretManager();
  setYouTubeOAuthRuntime({ transport, secretManagerFactory: factory });
  const current = getYouTubeOAuthRuntime();
  assert.equal(current.transport, transport);
  assert.equal(current.secretManagerFactory, factory);
  setYouTubeOAuthRuntime({ transport: null, secretManagerFactory: null });
  assert.equal(getYouTubeOAuthRuntime().transport, null);
});
