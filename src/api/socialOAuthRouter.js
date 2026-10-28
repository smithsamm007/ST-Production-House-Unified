/**
 * ST Production House — Owner API: generic per-Director SOCIAL OAuth routes.
 *
 * Mounted at /api/social (behind authenticateOwner in src/catalog/server.js):
 *
 *   GET  /providers                                     → safe provider metadata
 *   GET  /directors/:agentId/accounts                   → every platform status
 *   GET  /directors/:agentId/:providerKey/status        → one platform status
 *   POST /directors/:agentId/:providerKey/oauth/start   → mint state, return the
 *                                                         official authorization URL (CSRF)
 *   GET  /:providerKey/callback                         → provider redirects the owner's
 *                                                         browser back here (session-authenticated)
 *   POST /directors/:agentId/:providerKey/revoke        → owner-authorized revocation (CSRF)
 *
 * Security contract (AGENTS.md Rules 1, 5, 6, 15, 17):
 *   - Owner identity is SERVER-authoritative (req.ownerId from the session).
 *   - Mutations require the per-session CSRF token; the callback is a browser
 *     navigation so it is protected by the session cookie instead.
 *   - Every state change writes an audit event; audit payloads carry only
 *     agentId/providerKey/errorCode — never tokens, locators, or state values.
 *   - Errors map to stable PUBLIC codes; unknown failures stay generic so no
 *     secret-shaped material can leak through an error message.
 */

import { Router } from "express";
import { verifyCsrfToken } from "../catalog/ownerAuthentication.js";
import { SocialOAuthService } from "../catalog/socialOAuthService.js";
import {
  SOCIAL_OAUTH_PROVIDERS,
  SOCIAL_OAUTH_PROVIDER_KEYS,
  socialOAuthProviderDto,
} from "../catalog/socialOAuthProviders.js";

/** Codes that may appear in the browser-facing callback redirect. */
const REDIRECTABLE_ERROR_CODES = new Set([
  "OAUTH_NOT_CONFIGURED",
  "SECRET_MANAGER_NOT_CONFIGURED",
  "OAUTH_CALLBACK_INVALID",
  "OAUTH_STATE_INVALID",
  "OAUTH_STATE_EXPIRED",
  "OAUTH_STATE_REPLAYED",
  "OAUTH_STATE_MISMATCH",
  "OAUTH_OWNER_DENIED",
  "OAUTH_TOKEN_EXCHANGE_FAILED",
  "OAUTH_TOKEN_RESPONSE_MALFORMED",
  "OAUTH_PROVIDER_UNREACHABLE",
  "OAUTH_PROVIDER_IDENTITY_UNCONFIRMED",
  "OAUTH_IDENTITY_VERIFICATION_FAILED",
  "OAUTH_ACCOUNT_NOT_FOUND",
  "OAUTH_SECRET_WRITE_FAILED",
  "SECRET_MANAGER_LOCATOR_INVALID",
]);

/** HTTP status per stable code (fail closed to 500 for the unknown). */
const STATUS_BY_CODE = new Map([
  ["REQUEST_VALIDATION_FAILED", 400],
  ["AGENT_NOT_FOUND", 404],
  ["NOT_FOUND", 404],
  ["SOCIAL_OAUTH_PROVIDER_UNSUPPORTED", 404],
  ["STORAGE_NOT_CONFIGURED", 503],
  ["OAUTH_NOT_CONFIGURED", 503],
  ["SECRET_MANAGER_NOT_CONFIGURED", 503],
  ["OAUTH_PROVIDER_IDENTITY_UNCONFIRMED", 501],
  ["OAUTH_CALLBACK_INVALID", 400],
  ["OAUTH_OWNER_DENIED", 400],
  ["OAUTH_STATE_INVALID", 400],
  ["OAUTH_STATE_EXPIRED", 400],
  ["OAUTH_STATE_REPLAYED", 409],
  ["OAUTH_STATE_MISMATCH", 403],
  ["OAUTH_TOKEN_EXCHANGE_FAILED", 502],
  ["OAUTH_TOKEN_RESPONSE_MALFORMED", 502],
  ["OAUTH_PROVIDER_UNREACHABLE", 502],
  ["OAUTH_IDENTITY_VERIFICATION_FAILED", 502],
  ["OAUTH_SECRET_WRITE_FAILED", 502],
  ["SECRET_MANAGER_LOCATOR_INVALID", 502],
  ["SECRET_MANAGER_ENTRY_NOT_FOUND", 502],
  ["SECRET_CLEANUP_FAILED", 502],
  ["OAUTH_REVOKE_FAILED", 502],
  ["OAUTH_SECRET_READ_FAILED", 502],
  ["OAUTH_ACCOUNT_NOT_FOUND", 404],
  ["OAUTH_ACCOUNT_NOT_CONNECTED", 409],
  ["OAUTH_ACCOUNT_STATUS_INVALID", 500],
  ["OAUTH_STATE_HASH_INVALID", 500],
  ["OAUTH_STATE_EXPIRY_INVALID", 500],
  ["OAUTH_PKCE_METHOD_INVALID", 500],
  ["OAUTH_REDIRECT_BASE_INVALID", 500],
  ["OAUTH_REDIRECT_URI_INVALID", 500],
]);

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function hasOnlyFields(value, allowed) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

/** Same CSRF contract as src/catalog/server.js requireCsrf (fail closed). */
async function requireCsrf(req, res, next) {
  try {
    await verifyCsrfToken(req.session?.id, req.headers["x-csrf-token"]);
    return next();
  } catch {
    return res.status(403).json({ error: "CSRF_TOKEN_INVALID" });
  }
}

function logRouterError(event, err) {
  // Error code only — messages could carry provider detail, so they stay out.
  console.warn(JSON.stringify({ level: "error", event, code: err?.code ?? "UNKNOWN" }));
}

/** Degrade honestly when storage is not configured (never fake data). */
function sendStorageError(res, err) {
  if (err?.code === "STORAGE_NOT_CONFIGURED") {
    return res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
  }
  return null;
}

function isSupportedProvider(providerKey) {
  return SOCIAL_OAUTH_PROVIDER_KEYS.includes(providerKey);
}

function dashboardRedirect({ agentId, providerKey = null, result, errorCode = null }) {
  const params = new URLSearchParams({
    view: "connections",
    agent: agentId ?? "",
    oauth: result,
  });
  if (providerKey) params.set("provider", providerKey);
  if (errorCode) params.set("code", errorCode);
  return `/index.html?${params.toString()}`;
}

export function createSocialOAuthRouter({ db, recordAuditEvent }) {
  // `db` may be an adapter OR a lazy () => adapter (mounted at module load,
  // before configureRuntime assigns the adapter). Without storage the routes
  // degrade HONESTLY with 503 — they never fake data (Rules 1–3).
  const resolveDb = typeof db === "function" ? db : () => db;
  function getService() {
    const adapter = resolveDb();
    if (!adapter || typeof adapter.query !== "function") {
      const error = new Error("STORAGE_NOT_CONFIGURED");
      error.code = "STORAGE_NOT_CONFIGURED";
      throw error;
    }
    return new SocialOAuthService({ db: adapter });
  }

  async function audit(ownerId, action, detail) {
    if (typeof recordAuditEvent === "function") {
      try {
        await recordAuditEvent(ownerId, action, detail);
      } catch {
        // Audit persistence must never turn an honest read into a 500.
      }
    }
  }

  const router = Router();

  router.get("/providers", (req, res) => {
    return res.status(200).json({
      count: SOCIAL_OAUTH_PROVIDER_KEYS.length,
      providers: SOCIAL_OAUTH_PROVIDER_KEYS.map((key) => socialOAuthProviderDto(SOCIAL_OAUTH_PROVIDERS[key])),
    });
  });

  router.get("/directors/:agentId/accounts", async (req, res) => {
    try {
      if (!AGENT_ID_PATTERN.test(req.params.agentId)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const result = await getService().listStatus({
        ownerId: req.ownerId,
        agentId: req.params.agentId,
      });
      return res.status(200).json(result);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = err?.code ?? "UNKNOWN";
      logRouterError("SOCIAL_OAUTH_ACCOUNTS_FAILED", err);
      const status = STATUS_BY_CODE.get(code) ?? 500;
      return res.status(status).json({ error: status === 500 ? "INTERNAL_SERVER_ERROR" : code });
    }
  });

  router.get("/directors/:agentId/:providerKey/status", async (req, res) => {
    try {
      if (!AGENT_ID_PATTERN.test(req.params.agentId) || !isSupportedProvider(req.params.providerKey)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const result = await getService().getStatus({
        ownerId: req.ownerId,
        agentId: req.params.agentId,
        providerKey: req.params.providerKey,
      });
      return res.status(200).json(result);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = err?.code ?? "UNKNOWN";
      logRouterError("SOCIAL_OAUTH_STATUS_FAILED", err);
      const status = STATUS_BY_CODE.get(code) ?? 500;
      return res.status(status).json({ error: status === 500 ? "INTERNAL_SERVER_ERROR" : code });
    }
  });

  router.post("/directors/:agentId/:providerKey/oauth/start", requireCsrf, async (req, res) => {
    try {
      if (req.body !== undefined && !hasOnlyFields(req.body, [])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      if (!AGENT_ID_PATTERN.test(req.params.agentId) || !isSupportedProvider(req.params.providerKey)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const start = await getService().start({
        ownerId: req.ownerId,
        agentId: req.params.agentId,
        providerKey: req.params.providerKey,
      });
      await audit(req.ownerId, "social_oauth_started", {
        agentId: start.agentId,
        providerKey: start.providerKey,
      });
      return res.status(200).json({
        providerKey: start.providerKey,
        agentId: start.agentId,
        authorizationUrl: start.authorizationUrl,
        stateExpiresAt: start.stateExpiresAt,
        pkce: start.pkce,
      });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = err?.code ?? "UNKNOWN";
      logRouterError("SOCIAL_OAUTH_START_FAILED", err);
      const status = STATUS_BY_CODE.get(code) ?? 500;
      return res.status(status).json({ error: status === 500 ? "INTERNAL_SERVER_ERROR" : code });
    }
  });

  /**
   * The provider redirects the owner's browser here with ?code&state (or
   * ?error). The session cookie authenticates the owner; the state token binds
   * the round to its owner/director/provider. Responses are browser redirects;
   * the authorization code itself NEVER appears in any redirect URL.
   */
  router.get("/:providerKey/callback", async (req, res) => {
    const providerKey = req.params.providerKey;
    const failRedirect = (code) => res.redirect(
      302,
      dashboardRedirect({ agentId: null, providerKey: isSupportedProvider(providerKey) ? providerKey : null, result: "failed", errorCode: code }),
    );
    try {
      if (!isSupportedProvider(providerKey)) return failRedirect("OAUTH_CALLBACK_FAILED");
      const providerError = typeof req.query.error === "string" && req.query.error.length > 0
        ? req.query.error
        : null;
      const code = typeof req.query.code === "string" ? req.query.code : null;
      const state = typeof req.query.state === "string" ? req.query.state : null;
      const result = await getService().handleCallback({
        ownerId: req.ownerId,
        providerKey,
        code,
        state,
        providerError,
      });
      await audit(req.ownerId, "social_oauth_connected", {
        agentId: result.agentId,
        providerKey: result.providerKey,
        accountId: result.account?.account?.id ?? null,
      });
      return res.redirect(302, dashboardRedirect({
        agentId: result.agentId, providerKey: result.providerKey, result: "connected",
      }));
    } catch (err) {
      const code = err?.code ?? "UNKNOWN";
      logRouterError("SOCIAL_OAUTH_CALLBACK_FAILED", err);
      await audit(req.ownerId, "social_oauth_failed", {
        providerKey: isSupportedProvider(providerKey) ? providerKey : null,
        errorCode: REDIRECTABLE_ERROR_CODES.has(code) ? code : "OAUTH_CALLBACK_FAILED",
      });
      if (code === "STORAGE_NOT_CONFIGURED") {
        return res.redirect(302, dashboardRedirect({
          agentId: null, providerKey: null, result: "failed", errorCode: "STORAGE_NOT_CONFIGURED",
        }));
      }
      return failRedirect(REDIRECTABLE_ERROR_CODES.has(code) ? code : "OAUTH_CALLBACK_FAILED");
    }
  });

  router.post("/directors/:agentId/:providerKey/revoke", requireCsrf, async (req, res) => {
    try {
      if (req.body !== undefined && !hasOnlyFields(req.body, [])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      if (!AGENT_ID_PATTERN.test(req.params.agentId) || !isSupportedProvider(req.params.providerKey)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const result = await getService().revoke({
        ownerId: req.ownerId,
        agentId: req.params.agentId,
        providerKey: req.params.providerKey,
      });
      // Honest, separate facts — never a single blanket "revoked" claim.
      await audit(req.ownerId, "social_connection_revoked", {
        agentId: result.agentId,
        providerKey: result.providerKey,
        providerRevoked: result.providerRevoked,
        secretCleanupFailed: result.secretCleanupFailed,
        alreadyDisconnected: result.alreadyDisconnected,
        errorCode: result.errorCode ?? null,
      });
      return res.status(200).json(result);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = err?.code ?? "UNKNOWN";
      logRouterError("SOCIAL_OAUTH_REVOKE_FAILED", err);
      const status = STATUS_BY_CODE.get(code) ?? 500;
      if (status >= 500) {
        await audit(req.ownerId, "social_revoke_failed", {
          agentId: req.params.agentId,
          providerKey: isSupportedProvider(req.params.providerKey) ? req.params.providerKey : null,
          errorCode: status === 500 ? "INTERNAL_SERVER_ERROR" : code,
        });
      }
      return res.status(status).json({ error: status === 500 ? "INTERNAL_SERVER_ERROR" : code });
    }
  });

  return router;
}
