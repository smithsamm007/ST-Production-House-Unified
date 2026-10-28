/**
 * ST Production House — generic per-Director SOCIAL OAuth service.
 *
 * Section 6 of the master contract ("Independent social-media accounts for
 * every Director") generalizes the proven Issue #206 YouTube lifecycle to
 * every other supported platform through ONE engine, so a new Director — or a
 * newly approved platform — gets the same reusable account-management
 * functionality with no bespoke code.
 *
 *   OWNER (authenticated session)
 *     → state minted (crypto-random, stored ONLY as a SHA-256 hash, bound to
 *       owner + director + provider + server-controlled HTTPS redirect URI,
 *       expiring, atomically single-use)
 *     → official provider authorization endpoint
 *     → callback (session-authenticated; state consumed atomically)
 *     → token exchange at the official provider token endpoint (client secret
 *       and tokens never leave the server)
 *     → provider identity verification (safe account id/name only)
 *     → tokens handed ONLY to the injected EXTERNAL secret-manager adapter
 *     → opaque locator persisted in PostgreSQL (raw tokens never in DB, logs,
 *       DTOs, audit payloads, or error messages)
 *     → honest Director-scoped status + owner-authorized revocation
 *
 * PKCE: where the provider documents it (Snapchat), the `code_verifier` is
 * DERIVED from the state token (base64url of SHA-256 over a domain-separated
 * state) and the `code_challenge` is S256 over that verifier. The verifier is
 * therefore never persisted anywhere: the callback receives the state in
 * plaintext and rebuilds the identical verifier. Providers that do not
 * document PKCE (Meta plain code flow, Bilibili) run without it.
 *
 * Honesty rules (Rules 1–3): every failure surfaces a stable public error
 * code. Nothing returns connected/authorized/verified without real evidence.
 * A provider whose official identity endpoint is unconfirmed (bilibili)
 * cannot be connected at all — `OAUTH_PROVIDER_IDENTITY_UNCONFIRMED` — rather
 * than inventing an endpoint. Missing app configuration or a missing secret
 * manager adapter is an explicit 503-class failure, never a fake success.
 *
 * Dependencies are INJECTED (`transport`, `secretManager`). Tests inject
 * offline fakes; production wires a real secret-manager adapter at boot. No
 * network call happens unless an owner actually drives a callback/revocation.
 */

import { createHash, randomBytes } from "node:crypto";
import { sanitizeErrorMessage } from "../credentials/credentialBroker.js";
import {
  SOCIAL_OAUTH_PROVIDERS,
  SOCIAL_OAUTH_PROVIDER_KEYS,
  assertOfficialEndpoint,
  getSocialOAuthProvider,
  isSocialOAuthConfigured,
  loadSocialOAuthConfig,
  socialOAuthProviderDto,
} from "./socialOAuthProviders.js";
import { SocialOAuthRepository } from "./socialOAuthRepository.js";

/** State lifetime: long enough for a human consent round-trip, short by design. */
export const SOCIAL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const MAX_STATE_TOKEN_LENGTH = 512;

function fail(code, detail = undefined) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

// ---------------------------------------------------------------------------
// Runtime registry (injection point for transport + secret manager)
// ---------------------------------------------------------------------------

const runtime = {
  /** async ({ method, url, headers, body, timeoutMs }) → { status, body } */
  transport: null,
  /** () => ({ writeSecret, readSecret, deleteSecret }) | null */
  secretManagerFactory: null,
};

export function setSocialOAuthRuntime(next = {}) {
  if (next.transport !== undefined) runtime.transport = next.transport;
  if (next.secretManagerFactory !== undefined) runtime.secretManagerFactory = next.secretManagerFactory;
}

export function getSocialOAuthRuntime() {
  return {
    transport: runtime.transport,
    secretManagerFactory: runtime.secretManagerFactory,
  };
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/** 32 cryptographically secure random bytes, URL-safe. */
export function mintStateToken() {
  return randomBytes(32).toString("base64url");
}

/** The ONLY representation of a state that ever touches the database. */
export function hashStateToken(stateToken) {
  return createHash("sha256").update(String(stateToken), "utf8").digest("hex");
}

/**
 * PKCE verifier derived from the state token — never stored. Domain-separated
 * and 256-bit-entropy input, RFC 7636-compatible length (43 chars base64url).
 */
export function deriveCodeVerifier(stateToken) {
  return createHash("sha256")
    .update(`stph-social-pkce:${String(stateToken)}`, "utf8")
    .digest("base64url");
}

/** S256 challenge over a verifier. */
export function codeChallengeS256(codeVerifier) {
  return createHash("sha256").update(String(codeVerifier), "ascii").digest("base64url");
}

// ---------------------------------------------------------------------------
// URL builders (server-controlled, HTTPS-only)
// ---------------------------------------------------------------------------

/**
 * Resolve the OAuth redirect URI from the operator-configured HTTPS base. The
 * value is NEVER taken from request headers (Host/X-Forwarded-* are
 * attacker-controlled). https only, no embedded credentials, no exotic ports.
 */
export function resolveRedirectUri({ baseUrl, providerKey, callbackPath }) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 512) {
    throw fail("OAUTH_REDIRECT_BASE_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw fail("OAUTH_REDIRECT_BASE_INVALID");
  }
  if (parsed.protocol !== "https:") throw fail("OAUTH_REDIRECT_BASE_INVALID");
  if (parsed.username || parsed.password) throw fail("OAUTH_REDIRECT_BASE_INVALID");
  if (parsed.port && parsed.port !== "443") throw fail("OAUTH_REDIRECT_BASE_INVALID");
  if (parsed.search || parsed.hash) throw fail("OAUTH_REDIRECT_BASE_INVALID");
  parsed.pathname = callbackPath ?? `/api/social/${providerKey}/callback`;
  return parsed.toString();
}

export function buildAuthorizationUrl({ provider, clientId, redirectUri, state, codeChallenge = null }) {
  if (!clientId || !redirectUri || !state) throw fail("OAUTH_NOT_CONFIGURED");
  const spec = provider.authorize;
  assertOfficialEndpoint(spec.url);
  const url = new URL(spec.url);
  url.searchParams.set(spec.clientIdParam, clientId);
  url.searchParams.set(spec.redirectUriParam, redirectUri);
  if (spec.responseTypeParam) url.searchParams.set(spec.responseTypeParam, spec.responseTypeValue);
  if (spec.scopeParam && typeof provider.scope === "string" && provider.scope.length > 0) {
    url.searchParams.set(spec.scopeParam, provider.scope);
  }
  url.searchParams.set(spec.stateParam, state);
  if (provider.pkce) {
    if (!codeChallenge) throw fail("OAUTH_PKCE_CHALLENGE_MISSING");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", provider.pkce);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Default HTTPS transport (used only when no transport is injected)
// ---------------------------------------------------------------------------

async function defaultTransport({ method, url, headers, body, timeoutMs }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw fail("OAUTH_PROVIDER_UNREACHABLE", sanitizeErrorMessage(err?.message));
  }
  const text = await response.text();
  return { status: response.status, body: text };
}

function resolveTransport(injected) {
  return injected ?? runtime.transport ?? defaultTransport;
}

async function callTransport(doRequest, request) {
  try {
    return await doRequest(request);
  } catch (err) {
    if (err && err.code === "OAUTH_PROVIDER_UNREACHABLE") throw err;
    throw fail("OAUTH_PROVIDER_UNREACHABLE", sanitizeErrorMessage(err?.message));
  }
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function providerError(status, parsedBody, fallbackCode) {
  const rawCode = parsedBody && typeof parsedBody === "object"
    ? parsedBody.error ?? parsedBody.error_code ?? null
    : null;
  const rawMessage = parsedBody && typeof parsedBody === "object" && typeof parsedBody.error_description === "string"
    ? parsedBody.error_description
    : null;
  const detail = sanitizeErrorMessage(
    rawMessage
      ?? (typeof rawCode === "string" && rawCode.length > 0 ? rawCode : `provider_http_status_${status}`),
  ).slice(0, 200);
  const error = fail(fallbackCode, detail);
  error.providerStatus = status;
  return error;
}

/** Apply token-exchange parameters per the provider's documented encoding. */
function buildTokenRequest(spec, params) {
  const url = new URL(spec.url);
  assertOfficialEndpoint(spec.url);
  const headers = { accept: "application/json" };
  if (spec.encoding === "form") {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && key.length > 0) body.set(key, String(value));
    }
    headers["content-type"] = "application/x-www-form-urlencoded";
    return { method: spec.method, url: url.toString(), headers, body: body.toString() };
  }
  // "query": parameters on the URL (documented Meta exchange shape).
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && key.length > 0) url.searchParams.set(key, String(value));
  }
  return { method: spec.method, url: url.toString(), headers, body: undefined };
}

/** Shared token-endpoint call → { accessToken, refreshToken, expiresIn, scope }. */
async function exchangeTokens({ spec, params, transport, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, failureCode }) {
  const request = buildTokenRequest(spec, params);
  const doRequest = resolveTransport(transport);
  const response = await callTransport(doRequest, { ...request, timeoutMs });
  if (!response || typeof response.status !== "number" || typeof response.body !== "string") {
    throw fail("OAUTH_PROVIDER_UNREACHABLE");
  }
  if (response.status < 200 || response.status >= 300) {
    throw providerError(response.status, parseJsonBody(response.body), failureCode);
  }
  const parsed = parseJsonBody(response.body);
  if (!parsed || typeof parsed !== "object" ||
      typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw fail("OAUTH_TOKEN_RESPONSE_MALFORMED");
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : null,
    expiresIn: Number.isFinite(Number(parsed.expires_in)) ? Number(parsed.expires_in) : null,
    scope: typeof parsed.scope === "string" ? parsed.scope : null,
  };
}

/**
 * Exchange an authorization code at the provider's official token endpoint.
 * Client secret and tokens exist only inside this call chain — never in logs
 * or responses. `codeVerifier` is sent only when the provider documents PKCE.
 */
export async function exchangeAuthorizationCode({
  provider,
  config,
  code,
  redirectUri,
  codeVerifier = null,
  transport,
  timeoutMs,
}) {
  if (!config?.clientId || !config?.clientSecret) throw fail("OAUTH_NOT_CONFIGURED");
  if (typeof code !== "string" || code.length === 0 || code.length > 512) {
    throw fail("OAUTH_CALLBACK_INVALID");
  }
  const spec = provider.token;
  const params = {
    [spec.clientIdParam]: config.clientId,
    ...(spec.clientSecretParam ? { [spec.clientSecretParam]: config.clientSecret } : {}),
    [spec.codeParam]: code,
    ...(spec.redirectUriParam ? { [spec.redirectUriParam]: redirectUri } : {}),
    ...(spec.grantTypeParam ? { [spec.grantTypeParam]: spec.grantTypeValue } : {}),
    ...(provider.pkce && codeVerifier ? { code_verifier: codeVerifier } : {}),
  };
  return exchangeTokens({ spec, params, transport, timeoutMs, failureCode: "OAUTH_TOKEN_EXCHANGE_FAILED" });
}

/** Refresh a grant where the provider documents a refresh endpoint. */
export async function refreshProviderAccessToken({
  provider,
  config,
  refreshToken,
  transport,
  timeoutMs,
}) {
  const spec = provider.refresh;
  if (!spec) throw fail("OAUTH_REFRESH_UNSUPPORTED");
  if (!config?.clientId || !config?.clientSecret) throw fail("OAUTH_NOT_CONFIGURED");
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw fail("OAUTH_REFRESH_TOKEN_MISSING");
  }
  const params = {
    [spec.clientIdParam]: config.clientId,
    ...(spec.clientSecretParam ? { [spec.clientSecretParam]: config.clientSecret } : {}),
    [spec.refreshTokenParam]: refreshToken,
    ...(spec.grantTypeParam ? { [spec.grantTypeParam]: spec.grantTypeValue } : {}),
  };
  return exchangeTokens({ spec, params, transport, timeoutMs, failureCode: "OAUTH_REFRESH_FAILED" });
}

// ---------------------------------------------------------------------------
// Provider identity (safe account id/name only)
// ---------------------------------------------------------------------------

const IDENTITY_PARSERS = Object.freeze({
  /** First Facebook Page the authorized user manages. */
  meta_page(body) {
    const items = body && Array.isArray(body.data) ? body.data : [];
    const page = items.find((item) => item && typeof item.id === "string" && item.id.length > 0);
    if (!page) return null;
    return { id: page.id, name: typeof page.name === "string" ? page.name : null, handle: null };
  },
  /** The Instagram professional account linked to the user's first Page. */
  meta_instagram(body) {
    const items = body && Array.isArray(body.data) ? body.data : [];
    const page = items.find(
      (item) =>
        item &&
        item.instagram_business_account &&
        typeof item.instagram_business_account.id === "string" &&
        item.instagram_business_account.id.length > 0,
    );
    if (!page) return null;
    return {
      id: page.instagram_business_account.id,
      name: typeof page.name === "string" ? page.name : null,
      handle: typeof page.instagram_business_account.username === "string"
        ? page.instagram_business_account.username
        : null,
    };
  },
  /** Snapchat Public Profile identity. */
  snapchat_profile(body) {
    const profile = body && typeof body === "object"
      ? body.public_profile ?? body.profile ?? body
      : null;
    if (!profile || typeof profile !== "object" || typeof profile.id !== "string" || profile.id.length === 0) {
      return null;
    }
    return {
      id: profile.id,
      name: typeof profile.name === "string" ? profile.name : (typeof profile.display_name === "string" ? profile.display_name : null),
      handle: null,
    };
  },
});

/**
 * Verify the actual account via the provider's official API. Returns safe
 * identity { id, name, handle } — Rule 1: CONNECTED requires this.
 */
export async function fetchProviderIdentity({ provider, accessToken, transport, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS }) {
  if (provider.identityUnconfirmed || !provider.identity) {
    throw fail("OAUTH_PROVIDER_IDENTITY_UNCONFIRMED");
  }
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw fail("OAUTH_TOKEN_RESPONSE_MALFORMED");
  }
  const spec = provider.identity;
  const url = new URL(spec.url);
  assertOfficialEndpoint(spec.url.split("?")[0]);
  const headers = { accept: "application/json" };
  if (spec.auth === "bearer") {
    headers.authorization = `Bearer ${accessToken}`;
  } else {
    // Meta documents the access token as a query parameter.
    url.searchParams.set("access_token", accessToken);
  }
  const doRequest = resolveTransport(transport);
  const response = await callTransport(doRequest, {
    method: spec.method,
    url: url.toString(),
    headers,
    timeoutMs,
  });
  if (!response || typeof response.status !== "number" || typeof response.body !== "string") {
    throw fail("OAUTH_PROVIDER_UNREACHABLE");
  }
  if (response.status < 200 || response.status >= 300) {
    throw providerError(response.status, parseJsonBody(response.body), "OAUTH_IDENTITY_VERIFICATION_FAILED");
  }
  const parser = IDENTITY_PARSERS[spec.parser];
  if (!parser) throw fail("OAUTH_PROVIDER_IDENTITY_UNCONFIRMED");
  const identity = parser(parseJsonBody(response.body));
  if (!identity) {
    // Honest: the provider authorized us but returned no usable account.
    throw fail("OAUTH_ACCOUNT_NOT_FOUND");
  }
  return identity;
}

/** Revoke a grant at the provider's official endpoint where one is documented. */
export async function revokeProviderGrant({ provider, accessToken, transport, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS }) {
  const spec = provider.revoke;
  if (!spec) return { revoked: false, unreachable: false, unsupported: true };
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { revoked: false, unreachable: false, unsupported: false };
  }
  const url = new URL(spec.url);
  assertOfficialEndpoint(spec.url);
  url.searchParams.set(spec.tokenParam, accessToken);
  const doRequest = resolveTransport(transport);
  const response = await callTransport(doRequest, {
    method: spec.method,
    url: url.toString(),
    headers: { accept: "application/json" },
    timeoutMs,
  });
  if (!response || typeof response.status !== "number") {
    throw fail("OAUTH_PROVIDER_UNREACHABLE");
  }
  if (response.status >= 200 && response.status < 300) return { revoked: true, unreachable: false, unsupported: false };
  throw providerError(response.status, parseJsonBody(response.body), "OAUTH_REVOKE_FAILED");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function requireSecretManager() {
  const factory = runtime.secretManagerFactory;
  const secretManager = typeof factory === "function" ? factory() : null;
  if (!secretManager ||
      typeof secretManager.writeSecret !== "function" ||
      typeof secretManager.readSecret !== "function" ||
      typeof secretManager.deleteSecret !== "function") {
    throw fail("SECRET_MANAGER_NOT_CONFIGURED");
  }
  return secretManager;
}

function assertLocatorShaped(locator) {
  if (
    typeof locator !== "string" ||
    locator.length === 0 ||
    locator.length > 512 ||
    !(locator.startsWith("vault://") || locator.startsWith("opaque://"))
  ) {
    throw fail("SECRET_MANAGER_LOCATOR_INVALID");
  }
}

export class SocialOAuthService {
  constructor({ db, now = () => new Date(), stateTtlMs = SOCIAL_OAUTH_STATE_TTL_MS }) {
    if (!db || typeof db.query !== "function") {
      throw fail("STORAGE_NOT_CONFIGURED");
    }
    this.db = db;
    this.now = now;
    this.stateTtlMs = stateTtlMs;
  }

  #repo() {
    return new SocialOAuthRepository(this.db);
  }

  #provider(providerKey) {
    const provider = getSocialOAuthProvider(providerKey);
    if (!provider) throw fail("SOCIAL_OAUTH_PROVIDER_UNSUPPORTED");
    return provider;
  }

  /**
   * Start an OAuth round for one Director + provider: mint a single-use
   * expiring state, persist ONLY its hash, and return the official
   * authorization URL.
   */
  async start({ ownerId, agentId, providerKey }) {
    const provider = this.#provider(providerKey);
    if (!ownerId || !agentId) throw fail("REQUEST_VALIDATION_FAILED");
    if (provider.identityUnconfirmed) throw fail("OAUTH_PROVIDER_IDENTITY_UNCONFIRMED");

    const repo = this.#repo();
    if (!(await repo.agentExists(agentId))) throw fail("AGENT_NOT_FOUND");

    const config = loadSocialOAuthConfig(providerKey);
    if (!isSocialOAuthConfigured(config)) throw fail("OAUTH_NOT_CONFIGURED");
    requireSecretManager(); // fail before sending the owner to the provider

    const redirectUri = resolveRedirectUri({ baseUrl: config.redirectBaseUrl, providerKey });
    await repo.deleteExpiredStates(ownerId, agentId, providerKey, { now: this.now() });

    const stateToken = mintStateToken();
    const stateHash = hashStateToken(stateToken);
    const expiresAt = new Date(this.now().getTime() + this.stateTtlMs);
    const codeVerifier = provider.pkce ? deriveCodeVerifier(stateToken) : null;
    const codeChallenge = codeVerifier ? codeChallengeS256(codeVerifier) : null;
    await repo.insertState({
      stateHash,
      ownerId,
      agentId,
      providerKey,
      redirectUri,
      codeChallengeMethod: provider.pkce ?? null,
      expiresAt,
    });

    const authorizationUrl = buildAuthorizationUrl({
      provider,
      clientId: config.clientId,
      redirectUri,
      state: stateToken,
      codeChallenge,
    });
    return {
      providerKey,
      agentId,
      authorizationUrl,
      stateExpiresAt: expiresAt.toISOString(),
      pkce: provider.pkce ?? null,
    };
  }

  /**
   * Complete an OAuth round: validate + atomically consume the state, exchange
   * the code, verify the provider identity, hand tokens ONLY to the secret
   * manager, and persist the account with an opaque locator.
   */
  async handleCallback({ ownerId, providerKey, code, state, providerError: ownerDenied }) {
    const provider = this.#provider(providerKey);
    if (ownerDenied) throw fail("OAUTH_OWNER_DENIED", String(ownerDenied).slice(0, 100));
    if (typeof state !== "string" || state.length === 0 || state.length > MAX_STATE_TOKEN_LENGTH) {
      throw fail("OAUTH_CALLBACK_INVALID");
    }
    if (typeof code !== "string" || code.length === 0 || code.length > 512) {
      throw fail("OAUTH_CALLBACK_INVALID");
    }
    const config = loadSocialOAuthConfig(providerKey);
    if (!isSocialOAuthConfigured(config)) throw fail("OAUTH_NOT_CONFIGURED");

    const repo = this.#repo();
    const stateHash = hashStateToken(state);
    const row = await repo.findStateByHash(stateHash);
    if (!row) throw fail("OAUTH_STATE_INVALID");

    // Binding checks happen BEFORE the claim so a mismatched callback never
    // burns the state's single use.
    if (row.ownerId !== ownerId) throw fail("OAUTH_STATE_MISMATCH");
    if (row.providerKey !== providerKey) throw fail("OAUTH_STATE_MISMATCH");
    if (new Date(row.expiresAt).getTime() <= this.now().getTime()) {
      throw fail("OAUTH_STATE_EXPIRED");
    }

    // ATOMIC single-use claim: a concurrent/replayed callback loses here.
    const claimed = await repo.claimState({ stateHash, ownerId, agentId: row.agentId, providerKey });
    if (!claimed) throw fail("OAUTH_STATE_REPLAYED");

    const secretManager = requireSecretManager();

    const codeVerifier = row.codeChallengeMethod === "S256" ? deriveCodeVerifier(state) : null;
    const tokens = await exchangeAuthorizationCode({
      provider,
      config,
      code,
      redirectUri: row.redirectUri,
      codeVerifier,
    });
    const identity = await fetchProviderIdentity({ provider, accessToken: tokens.accessToken });

    // Secret-manager boundary: tokens go ONLY here; PostgreSQL receives the
    // returned opaque locator and nothing else (Rule 17).
    let locator;
    try {
      locator = await secretManager.writeSecret({
        ownerId,
        agentId: row.agentId,
        providerKey,
        payload: {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          obtained_at: this.now().toISOString(),
          expires_in: tokens.expiresIn,
          scope: tokens.scope,
        },
      });
    } catch {
      // Stable honest code; the manager's own message never serializes.
      throw fail("OAUTH_SECRET_WRITE_FAILED");
    }
    assertLocatorShaped(locator);

    const tokenExpiresAt = tokens.expiresIn
      ? new Date(this.now().getTime() + tokens.expiresIn * 1000)
      : null;
    const account = await repo.upsertAccount({
      ownerId,
      agentId: row.agentId,
      providerKey,
      status: "connected",
      accountId: identity.id,
      accountName: identity.name,
      accountHandle: identity.handle,
      oauthScope: tokens.scope ?? provider.scope ?? null,
      tokenLocator: locator,
      tokenExpiresAt,
      verifiedAt: this.now(),
    });

    return { agentId: row.agentId, providerKey, account };
  }

  /** Honest Director-scoped status for ONE provider (never invents a row). */
  async getStatus({ ownerId, agentId, providerKey }) {
    const provider = this.#provider(providerKey);
    const repo = this.#repo();
    if (!ownerId || !agentId) throw fail("REQUEST_VALIDATION_FAILED");
    if (!(await repo.agentExists(agentId))) throw fail("AGENT_NOT_FOUND");
    const account = await repo.getAccount(ownerId, agentId, providerKey);

    const recentStates = await repo.listRecentStates(ownerId, agentId, providerKey);
    const nowMs = this.now().getTime();
    const pendingState = recentStates.find(
      (s) => s.consumedAt === null && new Date(s.expiresAt).getTime() > nowMs,
    );

    const config = loadSocialOAuthConfig(providerKey);
    return {
      agentId,
      providerKey,
      provider: socialOAuthProviderDto(provider),
      status: account ? account.status : "unconfigured",
      account,
      pendingAuthorization: pendingState ? { stateExpiresAt: pendingState.expiresAt } : null,
      oauthConfigured: isSocialOAuthConfigured(config),
      secretManagerConfigured: typeof runtime.secretManagerFactory === "function",
    };
  }

  /** Honest Director-scoped status for EVERY supported platform. */
  async listStatus({ ownerId, agentId }) {
    const repo = this.#repo();
    if (!ownerId || !agentId) throw fail("REQUEST_VALIDATION_FAILED");
    if (!(await repo.agentExists(agentId))) throw fail("AGENT_NOT_FOUND");
    const accounts = await repo.listAccounts(ownerId, agentId);
    const byKey = new Map(accounts.map((a) => [a.providerKey, a]));
    const anyConfigured = SOCIAL_OAUTH_PROVIDER_KEYS.some((key) =>
      isSocialOAuthConfigured(loadSocialOAuthConfig(key)),
    );
    return {
      agentId,
      items: SOCIAL_OAUTH_PROVIDER_KEYS.map((providerKey) => {
        const provider = SOCIAL_OAUTH_PROVIDERS[providerKey];
        const account = byKey.get(providerKey) ?? null;
        return {
          providerKey,
          provider: socialOAuthProviderDto(provider),
          status: account ? account.status : "unconfigured",
          account,
        };
      }),
      oauthConfigured: anyConfigured,
      secretManagerConfigured: typeof runtime.secretManagerFactory === "function",
    };
  }

  /**
   * Director-scoped credential for PUBLISHING. Read-only and fail-closed: the
   * account row must exist, be `connected`, and carry an opaque locator; the
   * tokens are resolved ONLY through the injected secret-manager boundary.
   * They never serialize into errors, logs, DTOs, or the database (Rule 17).
   */
  async getPublishingCredential({ ownerId, agentId, providerKey }) {
    this.#provider(providerKey);
    const repo = this.#repo();
    if (!ownerId || !agentId) throw fail("REQUEST_VALIDATION_FAILED");

    const row = await repo.getAccountRow(ownerId, agentId, providerKey);
    if (!row) throw fail("OAUTH_ACCOUNT_NOT_FOUND");
    if (row.status !== "connected" || !row.token_locator) {
      throw fail("OAUTH_ACCOUNT_NOT_CONNECTED");
    }
    const secretManager = requireSecretManager();

    let payload;
    try {
      payload = await secretManager.readSecret({ locator: row.token_locator });
    } catch (err) {
      const code = err?.code ?? "OAUTH_SECRET_READ_FAILED";
      const safe = ["SECRET_MANAGER_ENTRY_NOT_FOUND", "SECRET_MANAGER_UNREACHABLE",
        "SECRET_MANAGER_AUTH_FAILED", "SECRET_MANAGER_FAILED",
        "SECRET_MANAGER_ADAPTER_FAILED"].includes(code);
      throw fail(safe ? code : "OAUTH_SECRET_READ_FAILED",
        safe ? undefined : sanitizeErrorMessage(err?.message ?? "secret read failed").slice(0, 200));
    }
    const accessToken = payload && typeof payload.access_token === "string" ? payload.access_token : null;
    if (!accessToken || accessToken.length === 0) throw fail("OAUTH_SECRET_READ_FAILED");
    return {
      agentId,
      providerKey,
      accessToken,
      accountId: row.account_id ?? null,
      accountName: row.account_name ?? null,
    };
  }

  /**
   * Owner-authorized revocation. Provider revocation, secret-manager cleanup,
   * and the account status update are reported honestly and separately; a
   * provider failure never marks the account disconnected.
   */
  async revoke({ ownerId, agentId, providerKey }) {
    const provider = this.#provider(providerKey);
    const repo = this.#repo();
    if (!ownerId || !agentId) throw fail("REQUEST_VALIDATION_FAILED");
    const row = await repo.getAccountRow(ownerId, agentId, providerKey);
    if (!row) throw fail("NOT_FOUND");

    if (row.status === "disconnected") {
      let secretCleanupFailed = false;
      if (row.token_locator) {
        try {
          const secretManager = requireSecretManager();
          await secretManager.deleteSecret({ locator: row.token_locator });
        } catch {
          secretCleanupFailed = true;
        }
      }
      return {
        agentId,
        providerKey,
        status: "disconnected",
        alreadyDisconnected: true,
        providerRevoked: false,
        secretCleanupFailed,
      };
    }

    const secretManager = requireSecretManager();

    // Resolve the token through the secret manager only.
    let accessToken = null;
    if (row.token_locator) {
      try {
        const payload = await secretManager.readSecret({ locator: row.token_locator });
        accessToken = payload && typeof payload.access_token === "string" ? payload.access_token : null;
      } catch (err) {
        // ST can no longer use (or revoke) this token. Honest state: mark the
        // connection dead with the real reason; never claim provider revocation.
        await repo.markDisconnected(ownerId, agentId, providerKey, { errorCode: "OAUTH_SECRET_READ_FAILED" });
        return {
          agentId,
          providerKey,
          status: "disconnected",
          alreadyDisconnected: false,
          providerRevoked: false,
          secretCleanupFailed: false,
          errorCode: "OAUTH_SECRET_READ_FAILED",
          detail: sanitizeErrorMessage(err?.code ?? err?.message ?? "secret read failed").slice(0, 200),
        };
      }
    }

    if (accessToken) {
      try {
        await revokeProviderGrant({ provider, accessToken });
      } catch (err) {
        // Provider revocation failed: the grant may still be live. The row
        // stays connected and carries the honest error code.
        const code = err?.code ?? "OAUTH_REVOKE_FAILED";
        await repo.recordErrorCode(ownerId, agentId, providerKey, code);
        throw fail(code);
      }
    }

    let secretCleanupFailed = false;
    if (row.token_locator) {
      try {
        await secretManager.deleteSecret({ locator: row.token_locator });
      } catch {
        secretCleanupFailed = true;
      }
    }
    await repo.markDisconnected(ownerId, agentId, providerKey, {
      errorCode: secretCleanupFailed ? "SECRET_CLEANUP_FAILED" : null,
    });
    return {
      agentId,
      providerKey,
      status: "disconnected",
      alreadyDisconnected: false,
      providerRevoked: Boolean(accessToken),
      secretCleanupFailed,
    };
  }
}
