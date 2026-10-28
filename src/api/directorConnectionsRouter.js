/**
 * ST Production House — Owner API: per-director Secrets & Connections.
 *
 * Issue #164 (owner-dashboard surface). Two authenticated routers:
 *
 * `createProviderCatalogRouter()` — mounted at /api/providers:
 *   GET  /catalog   → safe provider metadata (official credential URLs)
 *   POST /catalog   → register a custom provider (CSRF; never mutates the
 *                     frozen governed catalog; process-lifetime scope)
 *
 * `createDirectorConnectionsRouter()` — mounted at /api/connections:
 *   GET    /directors/:agentId                      → list connections
 *   POST   /directors/:agentId                      → upsert one connection (CSRF)
 *   GET    /directors/:agentId/:connectionId        → one connection (404-safe)
 *   DELETE /directors/:agentId/:connectionId        → delete (CSRF)
 *   POST   /directors/:agentId/:connectionId/test   → honest test (CSRF)
 *   GET    /directors/:agentId/:connectionId/tests  → append-only history
 *
 * Security contract (AGENTS.md Rules 5, 6, 15, 17):
 * - Mount behind authenticateOwner; every mutation additionally requires a
 *   per-session CSRF token, and every state change writes an audit event.
 * - Owner identity is SERVER-authoritative (req.ownerId from the session) —
 *   never client input. Cross-owner/cross-director reads are generic 404s.
 * - Outbound serialization uses ONLY the repository's DTO allowlists: locator
 *   values and secret material never serialize (Rule 17); the provider
 *   catalog carries no agent names at all (Rule 15).
 * - The connection test is HONEST: without a live transport it records
 *   `unverified` — never `success` (Rule 1). No network I/O is added here.
 */

import { Router } from "express";
import { verifyCsrfToken } from "../catalog/ownerAuthentication.js";
import {
  DirectorConnectionsRepository,
  runConnectionTest,
} from "../catalog/directorConnectionsRepository.js";
import {
  PROVIDER_CATALOG,
  listCatalog,
  validateCustomProviderDefinition,
  registerCustomProvider,
} from "../catalog/providerCatalog.js";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/;

/** Owner-extendable catalog runtime state (process lifetime, never frozen-catalog mutation). */
const CUSTOM_PROVIDERS = new Map();

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
  console.error(JSON.stringify({ event, error: err?.message ?? String(err) }));
}

/** Degrade honestly when storage is not configured (never fake data). */
function sendStorageError(res, err) {
  if (err?.code === "STORAGE_NOT_CONFIGURED") {
    return res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
  }
  return null;
}

function loadedCatalog() {
  // Governed catalog first; process-lifetime custom registrations layered on
  // top. Neither is ever mutated (the frozen catalog stays untouched).
  return { ...PROVIDER_CATALOG, ...Object.fromEntries(CUSTOM_PROVIDERS) };
}

export function createProviderCatalogRouter() {
  const router = Router();

  router.get("/catalog", (req, res) => {
    const merged = loadedCatalog();
    return res.status(200).json({
      count: Object.keys(merged).length,
      providers: listCatalog(merged),
    });
  });

  router.post("/catalog", requireCsrf, (req, res) => {
    if (!hasOnlyFields(req.body, ["definition"])) {
      return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
    }
    const definition = req.body.definition;
    const merged = loadedCatalog();
    try {
      validateCustomProviderDefinition(definition, merged);
      const next = registerCustomProvider(merged, definition);
      CUSTOM_PROVIDERS.set(definition.providerKey, next[definition.providerKey]);
    } catch (err) {
      const code = typeof err?.message === "string" && err.message.startsWith("CUSTOM_PROVIDER_")
        ? err.message
        : "CUSTOM_PROVIDER_INVALID";
      return res.status(400).json({ error: code });
    }
    return res.status(201).json({ registered: definition.providerKey });
  });

  return router;
}

export function createDirectorConnectionsRouter({ db, recordAuditEvent }) {
  // `db` may be an adapter OR a lazy () => adapter (server.js mounts this
  // router at module load, before configureRuntime() assigns the adapter).
  // When no storage is configured the routes degrade HONESTLY with 503 —
  // they never fake data (Rules 1–3).
  const resolveDb = typeof db === "function" ? db : () => db;
  function getRepo() {
    const adapter = resolveDb();
    if (!adapter || typeof adapter.query !== "function") {
      const error = new Error("STORAGE_NOT_CONFIGURED");
      error.code = "STORAGE_NOT_CONFIGURED";
      throw error;
    }
    return new DirectorConnectionsRepository(adapter);
  }
  const router = Router();

  router.get("/directors/:agentId", async (req, res) => {
    try {
      if (!AGENT_ID_PATTERN.test(req.params.agentId)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const items = await getRepo().listConnections(req.ownerId, req.params.agentId);
      return res.status(200).json({ count: items.length, items });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("DIRECTOR_CONNECTIONS_LIST_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/directors/:agentId", requireCsrf, async (req, res) => {
    try {
      if (!hasOnlyFields(req.body, ["providerKey", "kind", "secretFields", "configFields", "credentialLabel"])) {
        return res.status(400).json({ error: "REQUEST_VALIDATION_FAILED" });
      }
      if (!AGENT_ID_PATTERN.test(req.params.agentId)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const { providerKey, kind, secretFields, configFields, credentialLabel } = req.body;
      if (typeof providerKey !== "string" || !PROVIDER_KEY_PATTERN.test(providerKey)) {
        return res.status(400).json({ error: "PROVIDER_KEY_INVALID" });
      }
      const connection = await getRepo().upsertConnection(req.ownerId, req.params.agentId, {
        providerKey,
        kind,
        secretFields,
        configFields,
        credentialLabel,
      });
      if (typeof recordAuditEvent === "function") {
        await recordAuditEvent(req.ownerId, "director_connection_upserted", {
          agentId: req.params.agentId,
          connectionId: connection.id,
          providerKey,
          kind,
        });
      }
      return res.status(201).json(connection);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = err?.code ?? err?.message;
      if ([
        "PLAINTEXT_SECRET_REJECTED",
        "SECRET_LOCATOR_REQUIRED",
        "CONNECTION_FIELD_KEY_INVALID",
        "CONNECTION_EMPTY",
        "CONFIG_FIELD_LOCATOR_PROHIBITED",
        "CONNECTION_KIND_INVALID",
        "CONFIG_FIELD_VALUE_INVALID",
        "CONNECTION_FIELDS_INVALID",
        "CONNECTION_LABEL_INVALID",
        "PROVIDER_KEY_INVALID",
      ].includes(code)) {
        return res.status(400).json({ error: code });
      }
      logRouterError("DIRECTOR_CONNECTION_UPSERT_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.get("/directors/:agentId/:connectionId", async (req, res) => {
    try {
      if (!AGENT_ID_PATTERN.test(req.params.agentId) || !CONNECTION_ID_PATTERN.test(req.params.connectionId)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const connection = await getRepo().getConnection(req.ownerId, req.params.agentId, req.params.connectionId);
      if (!connection) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      return res.status(200).json(connection);
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("DIRECTOR_CONNECTION_GET_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.delete("/directors/:agentId/:connectionId", requireCsrf, async (req, res) => {
    try {
      if (!AGENT_ID_PATTERN.test(req.params.agentId) || !CONNECTION_ID_PATTERN.test(req.params.connectionId)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const deleted = await getRepo().deleteConnection(req.ownerId, req.params.agentId, req.params.connectionId);
      if (!deleted) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      if (typeof recordAuditEvent === "function") {
        await recordAuditEvent(req.ownerId, "director_connection_deleted", {
          agentId: req.params.agentId,
          connectionId: req.params.connectionId,
        });
      }
      return res.status(200).json({ deleted: true });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("DIRECTOR_CONNECTION_DELETE_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.post("/directors/:agentId/:connectionId/test", requireCsrf, async (req, res) => {
    try {
      if (!AGENT_ID_PATTERN.test(req.params.agentId) || !CONNECTION_ID_PATTERN.test(req.params.connectionId)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const connection = await getRepo().getConnection(req.ownerId, req.params.agentId, req.params.connectionId);
      if (!connection) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      // HONEST by construction: with no owner-configured transport the
      // outcome is `unverified` — never `success` (Rule 1). A real transport
      // is injected by the deployer runtime, never by HTTP input.
      const result = await runConnectionTest(connection);
      const recorded = await getRepo().recordTestResult(null, {
        connectionId: connection.id,
        ownerId: req.ownerId,
        agentId: req.params.agentId,
        outcome: result.outcome,
        latencyMs: result.latencyMs,
        errorCode: result.errorCode,
        detail: result.detail,
      });
      if (typeof recordAuditEvent === "function") {
        await recordAuditEvent(req.ownerId, "director_connection_tested", {
          agentId: req.params.agentId,
          connectionId: connection.id,
          outcome: recorded.outcome,
        });
      }
      return res.status(201).json({ result: recorded });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      const code = err?.code ?? err?.message;
      if (code === "TEST_OUTCOME_INVALID" || code === "TEST_LATENCY_INVALID") {
        return res.status(400).json({ error: code });
      }
      logRouterError("DIRECTOR_CONNECTION_TEST_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  router.get("/directors/:agentId/:connectionId/tests", async (req, res) => {
    try {
      if (!AGENT_ID_PATTERN.test(req.params.agentId) || !CONNECTION_ID_PATTERN.test(req.params.connectionId)) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      const history = await getRepo().listTestResults(req.ownerId, req.params.agentId, req.params.connectionId);
      return res.status(200).json({ count: history.length, items: history });
    } catch (err) {
      if (sendStorageError(res, err)) return;
      logRouterError("DIRECTOR_CONNECTION_HISTORY_FAILED", err);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  return router;
}
