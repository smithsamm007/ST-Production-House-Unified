/**
 * ST Production House — owner-scoped YouTube OAuth service (Issue #206).
 *
 * Implements the OFFICIAL Google/YouTube OAuth lifecycle for one Director at
 * a time, per the AGENTS.md contract:
 *
 *   OWNER (authenticated session)
 *     → state minted (crypto-random, stored ONLY as SHA-256 hash, bound to
 *       owner + director + provider + server-controlled HTTPS redirect URI,
 *       expiring, atomically single-use)
 *     → Google authorization (official accounts.google.com endpoint)
 *     → callback (session-authenticated; state consumed atomically)
 *     → token exchange (official oauth2.googleapis.com/token; client secret
 *       and tokens never leave the server)
 *     → YouTube account verification (official youtube/v3 channels?mine=true)
 *     → tokens handed ONLY to the injected EXTERNAL secret-manager adapter
 *     → opaque locator persisted in PostgreSQL (raw tokens never in DB, logs,
 *       DTOs, audit payloads, or error messages)
 *     → honest Director-scoped status + owner-authorized revocation
 *
 * Honesty rules (Rules 1–3): every failure surfaces a stable public error
 * code. Nothing returns connected/authorized/verified without real evidence.
 * Missing Google client configuration or a missing secret manager adapter is
 * an explicit 503-class failure — never a fake success.
 *
 * Dependencies are INJECTED: `transport` (HTTPS boundary) and `secretManager`
 * are supplied by the runtime registry / router factory. Tests inject offline
 * fakes; production sets a real secret-manager adapter at boot. No network
 * call happens unless an owner actually drives a callback/revocation.
 */

import { createHash, randomBytes } from "node:crypto";
import { sanitizeErrorMessage } from "../credentials/credentialBroker.js";
import {
  YouTubeOAuthRepository,
  OAUTH_PROVIDER_KEY,
} from "./youtubeOAuthRepository.js";

export { OAUTH_PROVIDER_KEY };

/** Official Google endpoints (HTTPS-only, server-controlled). */
export const GOOGLE_OAUTH_ENDPOINTS = Object.freeze({
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  youtubeChannelsMine:
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
});

export const YOUTUBE_OAUTH_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
]);

/** State lifetime: long enough for a human consent round-trip, short by design. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
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

/**
 * Set process-wide collaborators. Production boot wires a real secret-manager
 * adapter here; tests inject labeled offline fakes. Passing null resets.
 */
export function setYouTubeOAuthRuntime(next = {}) {
  if (next.transport !== undefined) runtime.transport = next.transport;
  if (next.secretManagerFactory !== undefined) runtime.secretManagerFactory = next.secretManagerFactory;
}

export function getYouTubeOAuthRuntime() {
  return {
    transport: runtime.transport,
    secretManagerFactory: runtime.secretManagerFactory,
  };
}

/**
 * Labeled in-memory secret manager. TEST/DEMO AID ONLY — it is a placeholder
 * by construction (process-local, non-durable) and is never wired by the
 * production server. It must never be used to pass production verification
 * (AGENTS.md Rule 3); production wires a real adapter via setYouTubeOAuthRuntime.
 */
export function createInMemorySecretManager() {
  const store = new Map();
  return {
    isPlaceholder: true,
    label: "in-memory-secret-manager (placeholder, non-durable)",
    async writeSecret({ ownerId, agentId, providerKey, payload }) {
      const locator = `opaque://in-memory/${providerKey}/${agentId}/${randomBytes(16).toString("hex")}`;
      store.set(locator, { ownerId, agentId, providerKey, payload });
      return locator;
    },
    async readSecret({ locator }) {
      const entry = store.get(locator);
      if (!entry) throw fail("SECRET_MANAGER_ENTRY_NOT_FOUND");
      return entry.payload;
    },
    async deleteSecret({ locator }) {
      if (!store.delete(locator)) throw fail("SECRET_MANAGER_ENTRY_NOT_FOUND");
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration (read at call time, never cached at module load)
// ---------------------------------------------------------------------------

export function loadOAuthConfig(env = process.env) {
  return {
    clientId: env.STPH_YOUTUBE_OAUTH_CLIENT_ID || null,
    clientSecret: env.STPH_YOUTUBE_OAUTH_CLIENT_SECRET || null,
    redirectBaseUrl: env.STPH_YOUTUBE_OAUTH_REDIRECT_BASE_URL || null,
  };
}

export function isOAuthConfigured(config = loadOAuthConfig()) {
  return Boolean(config.clientId && config.clientSecret && config.redirectBaseUrl);
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

// ---------------------------------------------------------------------------
// URL builders (server-controlled, HTTPS-only)
// ---------------------------------------------------------------------------

/**
 * Resolve the OAuth redirect URI from the operator-configured HTTPS base.
 * The value is NEVER taken from request headers (Host/X-Forwarded-* are
 * attacker-controlled). https only, no embedded credentials, no exotic ports.
 */
export function resolveRedirectUri({ baseUrl, callbackPath = "/api/youtube/callback" }) {
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
  parsed.pathname = callbackPath;
  return parsed.toString();
}

export function buildGoogleAuthorizationUrl({
  clientId,
  redirectUri,
  state,
  scopes = YOUTUBE_OAUTH_SCOPES,
  accessType = "offline",
}) {
  if (!clientId || !redirectUri || !state) throw fail("OAUTH_NOT_CONFIGURED");
  const url = new URL(GOOGLE_OAUTH_ENDPOINTS.authorize);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", accessType);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
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
    // Abort/network failures normalize to one honest, stable code.
    throw fail("OAUTH_PROVIDER_UNREACHABLE", sanitizeErrorMessage(err?.message));
  }
  const text = await response.text();
  return { status: response.status, body: text };
}

function resolveTransport(injected) {
  return injected ?? runtime.transport ?? defaultTransport;
}

/**
 * Call the transport boundary and normalize ANY throw (injected fake, default
 * fetch, network failure) to one honest stable code with sanitized detail.
 * A raw transport error must never leak provider messages or secret-shaped
 * strings through the service boundary (Rules 1, 17).
 */
async function callTransport(doRequest, request) {
  try {
    return await doRequest(request);
  } catch (err) {
    if (err && err.code === "OAUTH_PROVIDER_UNREACHABLE") throw err;
    throw fail("OAUTH_PROVIDER_UNREACHABLE", sanitizeErrorMessage(err?.message));
  }
}

// ---------------------------------------------------------------------------
// Official Google API adapters (transport-injected; unit-testable offline)
// ---------------------------------------------------------------------------

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
  // sanitizeErrorMessage strips locators and secret-shaped strings (Rule 17).
  const detail = sanitizeErrorMessage(
    typeof rawCode === "string" && rawCode.length > 0
      ? rawCode
      : `google_http_status_${status}`,
  ).slice(0, 200);
  const error = fail(fallbackCode, detail);
  error.providerStatus = status;
  return error;
}

/**
 * Exchange an authorization code at the official Google token endpoint.
 * Returns { accessToken, refreshToken, expiresIn, scope }. Client secret and
 * tokens exist only inside this call chain — never in logs or responses.
 */
export async function exchangeGoogleAuthorizationCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  transport,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
}) {
  if (!clientId || !clientSecret) throw fail("OAUTH_NOT_CONFIGURED");
  if (typeof code !== "string" || code.length === 0 || code.length > 512) {
    throw fail("OAUTH_CALLBACK_INVALID");
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }).toString();

  const doRequest = resolveTransport(transport);
  const response = await callTransport(doRequest, {
    method: "POST",
    url: GOOGLE_OAUTH_ENDPOINTS.token,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    timeoutMs,
  });
  if (!response || typeof response.status !== "number" || typeof response.body !== "string") {
    throw fail("OAUTH_PROVIDER_UNREACHABLE");
  }
  if (response.status !== 200) {
    throw providerError(response.status, parseJsonBody(response.body), "OAUTH_TOKEN_EXCHANGE_FAILED");
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
 * Verify the actual YouTube account via the official API. Returns safe
 * identity { channelId, title, handle } — Rule 1: CONNECTED requires this.
 */
export async function fetchYouTubeChannelIdentity({
  accessToken,
  transport,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
}) {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw fail("OAUTH_TOKEN_RESPONSE_MALFORMED");
  }
  const doRequest = resolveTransport(transport);
  const response = await callTransport(doRequest, {
    method: "GET",
    url: GOOGLE_OAUTH_ENDPOINTS.youtubeChannelsMine,
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    timeoutMs,
  });
  if (!response || typeof response.status !== "number" || typeof response.body !== "string") {
    throw fail("OAUTH_PROVIDER_UNREACHABLE");
  }
  if (response.status !== 200) {
    throw providerError(response.status, parseJsonBody(response.body), "OAUTH_YOUTUBE_VERIFICATION_FAILED");
  }
  const parsed = parseJsonBody(response.body);
  const item = parsed && Array.isArray(parsed.items) ? parsed.items[0] : null;
  if (!item || typeof item.id !== "string" || item.id.length === 0) {
    // Honest: the Google account authorized us but has no YouTube channel.
    throw fail("OAUTH_YOUTUBE_CHANNEL_NOT_FOUND");
  }
  const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet : {};
  return {
    channelId: item.id,
    title: typeof snippet.title === "string" ? snippet.title : null,
    handle: typeof snippet.customUrl === "string" ? snippet.customUrl : null,
  };
}

/**
 * Revoke a grant at the official Google revocation endpoint. Google answers
 * 400 invalid_token for already-revoked tokens — treated honestly as
 * "already revoked", never silently as fresh success.
 */
export async function revokeGoogleToken({ token, transport, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS }) {
  if (typeof token !== "string" || token.length === 0) {
    throw fail("OAUTH_SECRET_READ_FAILED");
  }
  const doRequest = resolveTransport(transport);
  const response = await callTransport(doRequest, {
    method: "POST",
    url: GOOGLE_OAUTH_ENDPOINTS.revoke,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }).toString(),
    timeoutMs,
  });
  if (!response || typeof response.status !== "number") {
    throw fail("OAUTH_PROVIDER_UNREACHABLE");
  }
  if (response.status === 200) return { revoked: true, alreadyRevoked: false };
  const parsed = parseJsonBody(response.body);
  const providerCode = parsed && typeof parsed.error === "string" ? parsed.error : "";
  if (response.status === 400 && providerCode.includes("invalid_token")) {
    return { revoked: true, alreadyRevoked: true };
  }
  throw providerError(response.status, parsed, "OAUTH_REVOKE_FAILED");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The secret-manager boundary contract (injected adapter). */
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

export class YouTubeOAuthService {
  constructor({ db, now = () => new Date(), stateTtlMs = OAUTH_STATE_TTL_MS }) {
    if (!db || typeof db.query !== "function") {
      throw fail("STORAGE_NOT_CONFIGURED");
    }
    this.db = db;
    this.now = now;
    this.stateTtlMs = stateTtlMs;
  }

  #repo() {
    return new YouTubeOAuthRepository(this.db);
  }

  /**
   * Start an OAuth round for one Director: mint a single-use expiring state,
   * persist ONLY its hash, and return the official Google authorization URL.
   */
  async start({ ownerId, agentId }) {
    const repo = this.#repo();
    if (!ownerId || !agentId) throw fail("REQUEST_VALIDATION_FAILED");
    if (!(await repo.agentExists(agentId))) throw fail("AGENT_NOT_FOUND");

    const config = loadOAuthConfig();
    if (!isOAuthConfigured(config)) throw fail("OAUTH_NOT_CONFIGURED");
    requireSecretManager(); // fail before sending the owner to Google

    const redirectUri = resolveRedirectUri({ baseUrl: config.redirectBaseUrl });
    await repo.deleteExpiredStates(ownerId, agentId, { now: this.now() });

    const stateToken = mintStateToken();
    const stateHash = hashStateToken(stateToken);
    const expiresAt = new Date(this.now().getTime() + this.stateTtlMs);
    await repo.insertState({ stateHash, ownerId, agentId, redirectUri, expiresAt });

    const authorizationUrl = buildGoogleAuthorizationUrl({
      clientId: config.clientId,
      redirectUri,
      state: stateToken,
    });
    return {
      providerKey: OAUTH_PROVIDER_KEY,
      agentId,
      authorizationUrl,
      stateExpiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Complete an OAuth round: validate + atomically consume the state, exchange
   * the code, verify the YouTube account, hand tokens ONLY to the secret
   * manager, and persist the account with an opaque locator.
   */
  async handleCallback({ ownerId, code, state, providerError: ownerDenied }) {
    if (ownerDenied) throw fail("OAUTH_OWNER_DENIED", String(ownerDenied).slice(0, 100));
    if (typeof state !== "string" || state.length === 0 || state.length > MAX_STATE_TOKEN_LENGTH) {
      throw fail("OAUTH_CALLBACK_INVALID");
    }
    if (typeof code !== "string" || code.length === 0 || code.length > 512) {
      throw fail("OAUTH_CALLBACK_INVALID");
    }
    const config = loadOAuthConfig();
    if (!isOAuthConfigured(config)) throw fail("OAUTH_NOT_CONFIGURED");

    const repo = this.#repo();
    const stateHash = hashStateToken(state);
    const row = await repo.findStateByHash(stateHash);
    if (!row) throw fail("OAUTH_STATE_INVALID");

    // Binding checks happen BEFORE the claim so a mismatched callback never
    // burns the state's single use.
    if (row.ownerId !== ownerId) throw fail("OAUTH_STATE_MISMATCH");
    if (row.providerKey !== OAUTH_PROVIDER_KEY) throw fail("OAUTH_STATE_MISMATCH");
    if (new Date(row.expiresAt).getTime() <= this.now().getTime()) {
      throw fail("OAUTH_STATE_EXPIRED");
    }

    // ATOMIC single-use claim: a concurrent/replayed callback loses here.
    const claimed = await repo.claimState({
      stateHash,
      ownerId,
      agentId: row.agentId,
      providerKey: OAUTH_PROVIDER_KEY,
    });
    if (!claimed) throw fail("OAUTH_STATE_REPLAYED");

    const secretManager = requireSecretManager();

    const tokens = await exchangeGoogleAuthorizationCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: row.redirectUri,
      code,
    });
    const identity = await fetchYouTubeChannelIdentity({ accessToken: tokens.accessToken });

    // Secret-manager boundary: tokens go ONLY here; PostgreSQL receives the
    // returned opaque locator and nothing else (Rule 17).
    let locator;
    try {
      locator = await secretManager.writeSecret({
        ownerId,
        agentId: row.agentId,
        providerKey: OAUTH_PROVIDER_KEY,
        payload: {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          obtained_at: this.now().toISOString(),
          expires_in: tokens.expiresIn,
          scope: tokens.scope,
        },
      });
    } catch (err) {
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
      status: "connected",
      channelId: identity.channelId,
      channelTitle: identity.title,
      channelHandle: identity.handle,
      oauthScope: tokens.scope ?? YOUTUBE_OAUTH_SCOPES.join(" "),
      tokenLocator: locator,
      tokenExpiresAt,
      verifiedAt: this.now(),
    });

    return {
      agentId: row.agentId,
      providerKey: OAUTH_PROVIDER_KEY,
      account,
    };
  }

  /** Honest Director-scoped status (never claims connectivity without a row). */
  async getStatus({ ownerId, agentId }) {
    const repo = this.#repo();
    if (!ownerId || !agentId) throw fail("REQUEST_VALIDATION_FAILED");
    if (!(await repo.agentExists(agentId))) throw fail("AGENT_NOT_FOUND");
    const account = await repo.getAccount(ownerId, agentId);

    const recentStates = await repo.listRecentStates(ownerId, agentId);
    const nowMs = this.now().getTime();
    const pendingState = recentStates.find(
      (s) =>
        s.providerKey === OAUTH_PROVIDER_KEY &&
        s.consumedAt === null &&
        new Date(s.expiresAt).getTime() > nowMs,
    );

    const config = loadOAuthConfig();
    const secretManagerFactory = runtime.secretManagerFactory;
    return {
      agentId,
      providerKey: OAUTH_PROVIDER_KEY,
      status: account ? account.status : "unconfigured",
      account,
      pendingAuthorization: pendingState
        ? { stateExpiresAt: pendingState.expiresAt }
        : null,
      oauthConfigured: isOAuthConfigured(config),
      secretManagerConfigured: typeof secretManagerFactory === "function",
    };
  }

  /**
   * Owner-authorized revocation. Provider revocation, secret-manager cleanup,
   * and the account status update are reported honestly and separately; a
   * provider failure never marks the account disconnected.
   */
  async revoke({ ownerId, agentId }) {
    const repo = this.#repo();
    if (!ownerId || !agentId) throw fail("REQUEST_VALIDATION_FAILED");
    const accountRow = await repo.getAccountRow(ownerId, agentId);
    if (!accountRow) throw fail("NOT_FOUND");

    if (accountRow.status === "disconnected") {
      // Idempotent: try the secret cleanup again, report honestly.
      let secretCleanupFailed = false;
      if (accountRow.token_locator) {
        try {
          const secretManager = requireSecretManager();
          await secretManager.deleteSecret({ locator: accountRow.token_locator });
        } catch {
          secretCleanupFailed = true;
        }
      }
      return {
        agentId,
        providerKey: OAUTH_PROVIDER_KEY,
        status: "disconnected",
        alreadyDisconnected: true,
        providerRevoked: false,
        secretCleanupFailed,
      };
    }

    const config = loadOAuthConfig();
    if (!isOAuthConfigured(config)) throw fail("OAUTH_NOT_CONFIGURED");
    const secretManager = requireSecretManager();

    // Resolve the token through the secret manager only.
    let accessToken = null;
    if (accountRow.token_locator) {
      try {
        const payload = await secretManager.readSecret({ locator: accountRow.token_locator });
        accessToken = payload && typeof payload.access_token === "string" ? payload.access_token : null;
      } catch (err) {
        // ST can no longer use (or revoke) this token. Honest state: mark the
        // connection dead with the real reason; never claim provider revocation.
        await repo.markDisconnected(ownerId, agentId, { errorCode: "OAUTH_SECRET_READ_FAILED" });
        return {
          agentId,
          providerKey: OAUTH_PROVIDER_KEY,
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
        await revokeGoogleToken({ token: accessToken });
      } catch (err) {
        // Provider revocation failed: the grant may still be live. The row
        // stays connected and carries the honest error code.
        const code = err?.code ?? "OAUTH_REVOKE_FAILED";
        await repo.recordErrorCode(ownerId, agentId, code);
        throw fail(code);
      }
    }

    // Provider revoked (or no usable token existed): clean up the secret.
    let secretCleanupFailed = false;
    if (accountRow.token_locator) {
      try {
        await secretManager.deleteSecret({ locator: accountRow.token_locator });
      } catch {
        secretCleanupFailed = true;
      }
    }
    await repo.markDisconnected(ownerId, agentId, {
      errorCode: secretCleanupFailed ? "SECRET_CLEANUP_FAILED" : null,
    });
    return {
      agentId,
      providerKey: OAUTH_PROVIDER_KEY,
      status: "disconnected",
      alreadyDisconnected: false,
      providerRevoked: Boolean(accessToken),
      secretCleanupFailed,
    };
  }
}
