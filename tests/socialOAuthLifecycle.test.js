/**
 * Per-Director SOCIAL OAuth lifecycle — registry + repository + service tests.
 *
 * Everything here runs OFFLINE against the labeled demo adapter and injected
 * fakes: no network call, no live provider account, no real secret manager.
 *
 * Coverage:
 *   - the frozen provider registry is HTTPS-only on official hosts, and a
 *     provider whose identity endpoint is unconfirmed (bilibili) can never be
 *     reported connected;
 *   - state tokens are crypto-random and persisted ONLY as SHA-256 hashes;
 *   - PKCE (Snapchat) derives the verifier from the state so nothing extra is
 *     stored, and the S256 challenge is correct;
 *   - the official authorization URL is built per provider with that
 *     provider's own parameter names (Meta `redirect_uri`, Bilibili `gourl`);
 *   - token exchange + provider identity verification (Meta page / Meta
 *     Instagram / Snapchat profile) through an injected transport;
 *   - tokens go ONLY through the injected secret-manager adapter; the DB and
 *     every DTO carry the opaque locator and nothing else (Rule 17);
 *   - expiry, replay, atomic single-use, and wrong owner / provider fail
 *     closed with stable codes;
 *   - honest Director-scoped status and owner-authorized revocation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SOCIAL_OAUTH_PROVIDERS,
  SOCIAL_OAUTH_PROVIDER_KEYS,
  assertOfficialEndpoint,
  getSocialOAuthProvider,
  socialOAuthProviderDto,
  loadSocialOAuthConfig,
  isSocialOAuthConfigured,
} from "../src/catalog/socialOAuthProviders.js";
import {
  SocialOAuthRepository,
  ACCOUNT_STATUSES,
  isLocatorShaped,
} from "../src/catalog/socialOAuthRepository.js";
import {
  SocialOAuthService,
  SOCIAL_OAUTH_STATE_TTL_MS,
  mintStateToken,
  hashStateToken,
  deriveCodeVerifier,
  codeChallengeS256,
  resolveRedirectUri,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshProviderAccessToken,
  fetchProviderIdentity,
  revokeProviderGrant,
  setSocialOAuthRuntime,
  getSocialOAuthRuntime,
} from "../src/catalog/socialOAuthService.js";
import { createInMemorySecretManager } from "../src/catalog/youtubeOAuthService.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

// ---------------------------------------------------------------------------
// Environment + harness
// ---------------------------------------------------------------------------

const OAUTH_ENV = {
  STPH_SOCIAL_OAUTH_REDIRECT_BASE_URL: "https://dashboard.stproduction.test",
  STPH_FACEBOOK_OAUTH_CLIENT_ID: "meta-app-id",
  STPH_FACEBOOK_OAUTH_CLIENT_SECRET: "meta-app-secret",
  STPH_INSTAGRAM_OAUTH_CLIENT_ID: "meta-app-id",
  STPH_INSTAGRAM_OAUTH_CLIENT_SECRET: "meta-app-secret",
  STPH_SNAPCHAT_OAUTH_CLIENT_ID: "snap-client-id",
  STPH_SNAPCHAT_OAUTH_CLIENT_SECRET: "snap-client-secret",
  STPH_BILIBILI_OAUTH_CLIENT_ID: "bili-client-id",
  STPH_BILIBILI_OAUTH_CLIENT_SECRET: "bili-client-secret",
};
function applyEnv() {
  for (const [key, value] of Object.entries(OAUTH_ENV)) process.env[key] = value;
}

test.after(() => {
  for (const key of Object.keys(OAUTH_ENV)) delete process.env[key];
  setSocialOAuthRuntime({ transport: null, secretManagerFactory: null });
});

async function buildHarness() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `owner-${ownerId.slice(0, 8)}@social-oauth.test`, "x".repeat(64), "owner", "authenticated"],
  );
  return { db, ownerId, repo: new SocialOAuthRepository(db), secrets: createInMemorySecretManager() };
}

function jsonResponse(status, payload) {
  return { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

function metaResponder(request) {
  if (request.url.startsWith("https://graph.facebook.com/v26.0/oauth/access_token")) {
    return jsonResponse(200, { access_token: "meta-user-token", token_type: "bearer", expires_in: 5184000 });
  }
  if (request.url.startsWith("https://graph.facebook.com/v26.0/me/accounts")) {
    return jsonResponse(200, {
      data: [
        { id: "page-1", name: "First Page", access_token: "page-token-1" },
        {
          id: "page-2",
          name: "Second Page",
          access_token: "page-token-2",
          instagram_business_account: { id: "ig-2", username: "second.handle" },
        },
      ],
    });
  }
  if (request.url.startsWith("https://graph.facebook.com/v26.0/me/permissions")) {
    return jsonResponse(200, { success: true });
  }
  return jsonResponse(404, { error: "unknown_endpoint" });
}

function snapchatResponder(request) {
  if (request.url.startsWith("https://accounts.snapchat.com/login/oauth2/access_token")) {
    return jsonResponse(200, {
      access_token: "snap-access-token",
      refresh_token: "snap-refresh-token",
      expires_in: 3600,
      scope: "snapchat-profile-api",
    });
  }
  if (request.url.startsWith("https://businessapi.snapchat.com/v1/public_profiles/my_profile")) {
    return jsonResponse(200, { public_profile: { id: "snap-profile-1", name: "Public Profile" } });
  }
  return jsonResponse(404, { error: "unknown_endpoint" });
}

function scriptedTransport(respond) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    return respond(request, calls.length);
  };
  return { transport, calls };
}

function wire(secrets, transport) {
  setSocialOAuthRuntime({ transport, secretManagerFactory: () => secrets });
}

async function serviceWithTransport({ db, secrets }, respond = metaResponder) {
  const scripted = scriptedTransport(respond);
  wire(secrets, scripted.transport);
  return { service: new SocialOAuthService({ db }), ...scripted };
}

async function startAndClaim(service, ownerId, agentId, providerKey) {
  const start = await service.start({ ownerId, agentId, providerKey });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  assert.ok(state, "authorization URL carries the state token");
  const callback = await service.handleCallback({ ownerId, providerKey, code: "auth-code", state });
  return { start, state, callback };
}

// ---------------------------------------------------------------------------
// Registry safety
// ---------------------------------------------------------------------------

test("the provider registry is HTTPS-only on official hosts and frozen", () => {
  assert.deepEqual([...SOCIAL_OAUTH_PROVIDER_KEYS].sort(), ["bilibili", "facebook", "instagram", "snapchat"]);
  assert.ok(Object.isFrozen(SOCIAL_OAUTH_PROVIDERS));
  for (const key of SOCIAL_OAUTH_PROVIDER_KEYS) {
    const provider = SOCIAL_OAUTH_PROVIDERS[key];
    assert.ok(Object.isFrozen(provider), `${key} entry is frozen`);
    assert.match(provider.authorize.url, /^https:\/\/[a-z0-9.-]+\//);
  }
});

test("a non-official or non-HTTPS endpoint is rejected before it can be used", () => {
  assert.throws(() => assertOfficialEndpoint("http://graph.facebook.com/oauth"), /SOCIAL_OAUTH_ENDPOINT_HTTPS_ONLY/);
  assert.throws(() => assertOfficialEndpoint("https://evil.example.com/oauth"), /SOCIAL_OAUTH_ENDPOINT_HOST_NOT_OFFICIAL/);
  assert.throws(() => assertOfficialEndpoint("https://user:pw@graph.facebook.com/oauth"), /CREDENTIALS_PROHIBITED/);
  assert.throws(() => assertOfficialEndpoint("https://graph.facebook.com:8443/oauth"), /PORT_PROHIBITED/);
  assert.ok(assertOfficialEndpoint("https://graph.facebook.com/v26.0/oauth/access_token"));
});

test("bilibili is registered but NOT connectable while its identity endpoint is unconfirmed", () => {
  const provider = getSocialOAuthProvider("bilibili");
  assert.equal(provider.identity, null, "no identity URL is invented");
  assert.equal(provider.identityUnconfirmed, true);
  assert.equal(socialOAuthProviderDto(provider).connectable, false);
  assert.equal(socialOAuthProviderDto(getSocialOAuthProvider("snapchat")).connectable, true);
});

test("provider config is read per-provider and never cached", () => {
  applyEnv();
  assert.equal(isSocialOAuthConfigured(loadSocialOAuthConfig("facebook")), true);
  const raw = { ...process.env, STPH_FACEBOOK_OAUTH_CLIENT_SECRET: "" };
  assert.equal(isSocialOAuthConfigured(loadSocialOAuthConfig("facebook", raw)), false);
});

// ---------------------------------------------------------------------------
// Crypto + URL builders
// ---------------------------------------------------------------------------

test("state tokens are crypto-random and stored only as SHA-256 hashes", () => {
  const a = mintStateToken();
  const b = mintStateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.match(hashStateToken(a), /^[0-9a-f]{64}$/);
  assert.notEqual(hashStateToken(a), hashStateToken(b));
});

test("the PKCE verifier is derived from the state (nothing extra is persisted)", () => {
  const state = mintStateToken();
  const verifier = deriveCodeVerifier(state);
  assert.equal(verifier, deriveCodeVerifier(state), "deterministic for the same state");
  assert.notEqual(verifier, deriveCodeVerifier(mintStateToken()), "different per state");
  assert.ok(verifier.length >= 43, "RFC 7636 minimum verifier length");
  const challenge = codeChallengeS256(verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(challenge, verifier, "the challenge is a hash of the verifier");
});

test("redirect URIs are server-controlled, HTTPS-only, and provider-scoped", () => {
  assert.equal(
    resolveRedirectUri({ baseUrl: "https://dashboard.stproduction.test", providerKey: "facebook" }),
    "https://dashboard.stproduction.test/api/social/facebook/callback",
  );
  assert.throws(() => resolveRedirectUri({ baseUrl: "http://dashboard.stproduction.test", providerKey: "facebook" }), /OAUTH_REDIRECT_BASE_INVALID/);
  assert.throws(() => resolveRedirectUri({ baseUrl: "https://u:p@dashboard.stproduction.test", providerKey: "facebook" }), /OAUTH_REDIRECT_BASE_INVALID/);
});

test("authorization URLs use each provider's OWN documented parameters", () => {
  const meta = new URL(buildAuthorizationUrl({
    provider: getSocialOAuthProvider("facebook"),
    clientId: "meta-app-id",
    redirectUri: "https://dashboard.stproduction.test/api/social/facebook/callback",
    state: "state-token",
  }));
  assert.equal(meta.origin + meta.pathname, "https://www.facebook.com/v26.0/dialog/oauth");
  assert.equal(meta.searchParams.get("client_id"), "meta-app-id");
  assert.equal(meta.searchParams.get("redirect_uri"), "https://dashboard.stproduction.test/api/social/facebook/callback");
  assert.equal(meta.searchParams.get("response_type"), "code");
  assert.equal(meta.searchParams.get("state"), "state-token");
  assert.ok(meta.searchParams.get("scope").includes("pages_show_list"));
  assert.equal(meta.searchParams.get("code_challenge"), null, "Meta plain code flow has no PKCE");

  const snap = new URL(buildAuthorizationUrl({
    provider: getSocialOAuthProvider("snapchat"),
    clientId: "snap-client-id",
    redirectUri: "https://dashboard.stproduction.test/api/social/snapchat/callback",
    state: "state-token",
    codeChallenge: codeChallengeS256(deriveCodeVerifier("state-token")),
  }));
  assert.equal(snap.origin + snap.pathname, "https://accounts.snapchat.com/login/oauth2/authorize");
  assert.equal(snap.searchParams.get("scope"), "snapchat-profile-api");
  assert.equal(snap.searchParams.get("code_challenge_method"), "S256");

  const bili = new URL(buildAuthorizationUrl({
    provider: getSocialOAuthProvider("bilibili"),
    clientId: "bili-client-id",
    redirectUri: "https://dashboard.stproduction.test/api/social/bilibili/callback",
    state: "state-token",
  }));
  assert.equal(bili.searchParams.get("gourl"), "https://dashboard.stproduction.test/api/social/bilibili/callback");
  assert.equal(bili.searchParams.get("redirect_uri"), null, "Bilibili names the callback gourl, not redirect_uri");
});

// ---------------------------------------------------------------------------
// Transport calls (offline)
// ---------------------------------------------------------------------------

test("the Meta code exchange is a GET with the documented query parameters", async () => {
  const scripted = scriptedTransport(metaResponder);
  const tokens = await exchangeAuthorizationCode({
    provider: getSocialOAuthProvider("facebook"),
    config: { clientId: "meta-app-id", clientSecret: "meta-app-secret" },
    code: "auth-code",
    redirectUri: "https://dashboard.stproduction.test/api/social/facebook/callback",
    transport: scripted.transport,
  });
  assert.equal(tokens.accessToken, "meta-user-token");
  assert.equal(scripted.calls.length, 1);
  const call = scripted.calls[0];
  assert.equal(call.method, "GET");
  const url = new URL(call.url);
  assert.equal(url.origin + url.pathname, "https://graph.facebook.com/v26.0/oauth/access_token");
  assert.equal(url.searchParams.get("code"), "auth-code");
  assert.equal(url.searchParams.get("client_secret"), "meta-app-secret");
  assert.equal(url.searchParams.get("grant_type"), null, "Meta documents no grant_type parameter");
});

test("the Snapchat exchange posts a form WITH the derived PKCE verifier", async () => {
  const scripted = scriptedTransport(snapchatResponder);
  const state = "state-token";
  const tokens = await exchangeAuthorizationCode({
    provider: getSocialOAuthProvider("snapchat"),
    config: { clientId: "snap-client-id", clientSecret: "snap-client-secret" },
    code: "auth-code",
    redirectUri: "https://dashboard.stproduction.test/api/social/snapchat/callback",
    codeVerifier: deriveCodeVerifier(state),
    transport: scripted.transport,
  });
  assert.equal(tokens.accessToken, "snap-access-token");
  assert.equal(tokens.refreshToken, "snap-refresh-token");
  const call = scripted.calls[0];
  assert.equal(call.method, "POST");
  const body = new URLSearchParams(call.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code_verifier"), deriveCodeVerifier(state));
  assert.equal(body.get("client_secret"), "snap-client-secret");
});

test("a provider HTTP error surfaces a stable code, never the raw payload", async () => {
  const scripted = scriptedTransport(() => jsonResponse(401, { error_description: "bad code" }));
  await assert.rejects(
    () => exchangeAuthorizationCode({
      provider: getSocialOAuthProvider("snapchat"),
      config: { clientId: "snap-client-id", clientSecret: "snap-client-secret" },
      code: "auth-code",
      redirectUri: "https://dashboard.stproduction.test/api/social/snapchat/callback",
      transport: scripted.transport,
    }),
    (err) => err.code === "OAUTH_TOKEN_EXCHANGE_FAILED",
  );
});

test("identity parsers pick the right account for each social surface", async () => {
  const page = await fetchProviderIdentity({
    provider: getSocialOAuthProvider("facebook"),
    accessToken: "meta-user-token",
    transport: scriptedTransport(metaResponder).transport,
  });
  assert.deepEqual(page, { id: "page-1", name: "First Page", handle: null });

  const ig = await fetchProviderIdentity({
    provider: getSocialOAuthProvider("instagram"),
    accessToken: "meta-user-token",
    transport: scriptedTransport(metaResponder).transport,
  });
  assert.deepEqual(ig, { id: "ig-2", name: "Second Page", handle: "second.handle" });

  const snap = await fetchProviderIdentity({
    provider: getSocialOAuthProvider("snapchat"),
    accessToken: "snap-access-token",
    transport: scriptedTransport(snapchatResponder).transport,
  });
  assert.deepEqual(snap, { id: "snap-profile-1", name: "Public Profile", handle: null });
});

test("identity verification refuses to invent an endpoint for an unconfirmed provider", async () => {
  await assert.rejects(
    () => fetchProviderIdentity({
      provider: getSocialOAuthProvider("bilibili"),
      accessToken: "token",
      transport: scriptedTransport(metaResponder).transport,
    }),
    (err) => err.code === "OAUTH_PROVIDER_IDENTITY_UNCONFIRMED",
  );
});

test("refresh uses the documented refresh endpoint where one exists", async () => {
  const scripted = scriptedTransport(snapchatResponder);
  const tokens = await refreshProviderAccessToken({
    provider: getSocialOAuthProvider("snapchat"),
    config: { clientId: "snap-client-id", clientSecret: "snap-client-secret" },
    refreshToken: "snap-refresh-token",
    transport: scripted.transport,
  });
  assert.equal(tokens.accessToken, "snap-access-token");
  const body = new URLSearchParams(scripted.calls[0].body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "snap-refresh-token");
});

test("revocation calls the documented provider endpoint, or reports unsupported", async () => {
  const scripted = scriptedTransport(metaResponder);
  const result = await revokeProviderGrant({
    provider: getSocialOAuthProvider("facebook"),
    accessToken: "meta-user-token",
    transport: scripted.transport,
  });
  assert.equal(result.revoked, true);
  assert.equal(new URL(scripted.calls[0].url).searchParams.get("access_token"), "meta-user-token");

  const none = await revokeProviderGrant({
    provider: getSocialOAuthProvider("snapchat"),
    accessToken: "snap-access-token",
    transport: scriptedTransport(snapchatResponder).transport,
  });
  assert.equal(none.unsupported, true, "no revocation endpoint is invented where none is documented");
});

// ---------------------------------------------------------------------------
// Full lifecycle through the demo adapter
// ---------------------------------------------------------------------------

test("start refuses an unconfirmed provider, unconfigured app, or missing secret manager", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);

  await assert.rejects(
    () => service.start({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "bilibili" }),
    (err) => err.code === "OAUTH_PROVIDER_IDENTITY_UNCONFIRMED",
  );
  await assert.rejects(
    () => service.start({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "twitter" }),
    (err) => err.code === "SOCIAL_OAUTH_PROVIDER_UNSUPPORTED",
  );
  await assert.rejects(
    () => service.start({ ownerId: harness.ownerId, agentId: "missing-agent", providerKey: "facebook" }),
    (err) => err.code === "AGENT_NOT_FOUND",
  );

  setSocialOAuthRuntime({ secretManagerFactory: null });
  await assert.rejects(
    () => service.start({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" }),
    (err) => err.code === "SECRET_MANAGER_NOT_CONFIGURED",
  );
});

test("facebook connect round-trips: hashed state, verified page, locator-only custody", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);

  const { callback } = await startAndClaim(service, harness.ownerId, "agent-01", "facebook");
  assert.equal(callback.providerKey, "facebook");
  assert.equal(callback.account.status, "connected");
  assert.equal(callback.account.account.id, "page-1");
  assert.ok(!JSON.stringify(callback).includes("vault://"), "the locator never serializes");
  assert.ok(!JSON.stringify(callback).includes("access_token"));

  // The database stores ONLY the locator, never a raw token.
  const stored = await harness.repo.getAccountRow(harness.ownerId, "agent-01", "facebook");
  assert.ok(isLocatorShaped(stored.token_locator));
  assert.equal(JSON.stringify(stored).includes("meta-user-token"), false);

  // The secret manager received the tokens.
  const payload = await harness.secrets.readSecret({ locator: stored.token_locator });
  assert.equal(payload.access_token, "meta-user-token");
});

test("instagram connect verifies the linked professional account, not the Page id", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);
  const { callback } = await startAndClaim(service, harness.ownerId, "agent-01", "instagram");
  assert.equal(callback.account.account.id, "ig-2");
  assert.equal(callback.account.account.handle, "second.handle");
});

test("snapchat connect runs PKCE end-to-end with nothing extra persisted", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness, snapchatResponder);
  const { callback } = await startAndClaim(service, harness.ownerId, "agent-01", "snapchat");
  assert.equal(callback.account.account.id, "snap-profile-1");

  const states = await harness.repo.listRecentStates(harness.ownerId, "agent-01", "snapchat");
  assert.equal(states[0].codeChallengeMethod, "S256");
  assert.equal(JSON.stringify(states).includes("code_verifier"), false, "the verifier is derived, never stored");
});

test("a state is single-use, expiring, and bound to its owner and provider", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);

  const start = await service.start({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
  const state = new URL(start.authorizationUrl).searchParams.get("state");

  // Wrong owner fails BEFORE the atomic claim, so the state survives.
  await assert.rejects(
    () => service.handleCallback({ ownerId: randomUUID(), providerKey: "facebook", code: "c", state }),
    (err) => err.code === "OAUTH_STATE_MISMATCH",
  );
  // Wrong provider binding fails too.
  await assert.rejects(
    () => service.handleCallback({ ownerId: harness.ownerId, providerKey: "instagram", code: "c", state }),
    (err) => err.code === "OAUTH_STATE_MISMATCH",
  );

  await service.handleCallback({ ownerId: harness.ownerId, providerKey: "facebook", code: "c", state });
  await assert.rejects(
    () => service.handleCallback({ ownerId: harness.ownerId, providerKey: "facebook", code: "c", state }),
    (err) => err.code === "OAUTH_STATE_REPLAYED",
  );
});

test("an expired state is refused with a stable code", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);
  const now = new Date();
  const expired = new SocialOAuthService({ db: harness.db, now: () => now });
  const start = await expired.start({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  const later = new SocialOAuthService({ db: harness.db, now: () => new Date(now.getTime() + SOCIAL_OAUTH_STATE_TTL_MS + 1000) });
  await assert.rejects(
    () => later.handleCallback({ ownerId: harness.ownerId, providerKey: "facebook", code: "c", state }),
    (err) => err.code === "OAUTH_STATE_EXPIRED",
  );
  void service;
});

test("owner denial and malformed callbacks are honest and never a success", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);
  await assert.rejects(
    () => service.handleCallback({ ownerId: harness.ownerId, providerKey: "facebook", code: "c", state: "s", providerError: "access_denied" }),
    (err) => err.code === "OAUTH_OWNER_DENIED",
  );
  await assert.rejects(
    () => service.handleCallback({ ownerId: harness.ownerId, providerKey: "facebook", code: "", state: "s" }),
    (err) => err.code === "OAUTH_CALLBACK_INVALID",
  );
});

test("status is honest per provider, and every supported platform is listed", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);

  const before = await service.listStatus({ ownerId: harness.ownerId, agentId: "agent-01" });
  assert.deepEqual(before.items.map((i) => i.providerKey).sort(), ["bilibili", "facebook", "instagram", "snapchat"]);
  assert.ok(before.items.every((i) => i.status === "unconfigured"));
  assert.equal(before.oauthConfigured, true);

  await startAndClaim(service, harness.ownerId, "agent-01", "facebook");
  const status = await service.getStatus({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
  assert.equal(status.status, "connected");
  assert.equal(status.account.account.id, "page-1");

  const other = await service.getStatus({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "instagram" });
  assert.equal(other.status, "unconfigured", "one Director's platforms stay independent");
});

test("a second Director never sees another Director's social account", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);
  await startAndClaim(service, harness.ownerId, "agent-01", "facebook");
  const other = await service.getStatus({ ownerId: harness.ownerId, agentId: "agent-02", providerKey: "facebook" });
  assert.equal(other.status, "unconfigured", "accounts are scoped per Director");
  assert.equal(await harness.repo.getAccount(harness.ownerId, "agent-02", "facebook"), null);
});

test("getPublishingCredential resolves the token only through the secret manager", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);
  await startAndClaim(service, harness.ownerId, "agent-01", "facebook");

  const credential = await service.getPublishingCredential({
    ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook",
  });
  assert.equal(credential.accessToken, "meta-user-token");
  assert.equal(credential.accountId, "page-1");

  await assert.rejects(
    () => service.getPublishingCredential({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "snapchat" }),
    (err) => err.code === "OAUTH_ACCOUNT_NOT_FOUND",
  );
});

test("revocation is honest: provider revocation, secret cleanup, and status are separate facts", async () => {
  applyEnv();
  const harness = await buildHarness();
  const { service } = await serviceWithTransport(harness);
  await startAndClaim(service, harness.ownerId, "agent-01", "facebook");

  const revoked = await service.revoke({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
  assert.equal(revoked.status, "disconnected");
  assert.equal(revoked.providerRevoked, true);
  assert.equal(revoked.secretCleanupFailed, false);

  const status = await service.getStatus({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
  assert.equal(status.status, "disconnected");

  const again = await service.revoke({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
  assert.equal(again.alreadyDisconnected, true);
});

test("a provider revocation failure never falsely marks the account disconnected", async () => {
  applyEnv();
  const harness = await buildHarness();
  const failing = () => jsonResponse(500, { error: "server_error" });
  const { service } = await serviceWithTransport(harness, (request) =>
    request.url.includes("me/permissions") ? failing() : metaResponder(request));
  await startAndClaim(service, harness.ownerId, "agent-01", "facebook");

  await assert.rejects(
    () => service.revoke({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" }),
    (err) => err.code === "OAUTH_REVOKE_FAILED",
  );
  const status = await service.getStatus({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
  assert.equal(status.status, "connected", "the row stays connected while the grant may still be live");
  assert.equal(status.account.lastErrorCode, "OAUTH_REVOKE_FAILED");
});

test("status enums stay exactly as sql/003 defines them (R5)", () => {
  assert.deepEqual([...ACCOUNT_STATUSES], ["unconfigured", "connected", "expired", "disconnected"]);
});

test("the runtime registry is injectable and resettable", () => {
  setSocialOAuthRuntime({ transport: null, secretManagerFactory: null });
  assert.deepEqual(getSocialOAuthRuntime(), { transport: null, secretManagerFactory: null });
});
