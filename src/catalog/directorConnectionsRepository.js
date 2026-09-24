/**
 * ST Production House — Director Connections repository (Secrets & Connections).
 *
 * Implements the per-director Secrets & Connections store on top of sql/022.
 * A "connection" is one Director's binding to one provider: opaque locators
 * for secret fields, plain values for non-secret configuration, and an
 * append-only history of HONEST connection-test outcomes.
 *
 * Security contract (AGENTS.md Rules 1, 5, 6, 15, 17):
 *   - Every query is parameterized and scoped by BOTH owner_id and agent_id:
 *     a cross-owner or cross-director read is indistinguishable from a missing
 *     row (generic NOT_FOUND up the stack). Directors never share credentials.
 *   - Secret values NEVER live here. The database CHECK constraint enforces
 *     the locator shape (vault:// / opaque://); this repository re-validates
 *     before every write (fail closed, defense in depth).
 *   - DTOs are explicit allowlists: locators serialize ONLY as their field
 *     keys with a masked marker — never the locator value itself, never any
 *     secret material.
 *   - The connection-test runner is HONEST: without a live, owner-configured
 *     transport it records outcome `unverified` — never `success` (Rule 1).
 *     Failure details pass through sanitizeErrorMessage so locators and
 *     secret-shaped strings never reach the audit trail.
 *
 * Portability: statements stay inside the SQL subset shared by the PostgreSQL
 * adapter and the labeled demo adapter (single-table statements, jsonb
 * round-trips, inlined validated integer LIMITs).
 */

import { sanitizeErrorMessage } from "../credentials/credentialBroker.js";
import {
  CONNECTION_KINDS,
  PROVIDER_CATALOG,
  isLocatorShapedSecretFields,
} from "./providerCatalog.js";

export const CONNECTION_STATUSES = Object.freeze([
  "not_configured",
  "configured",
  "unverified",
  "connection_failed",
]);

export const TEST_OUTCOMES = Object.freeze(["success", "failed", "unverified"]);

const MAX_LIST_LIMIT = 200;
const MAX_FIELD_KEY_LENGTH = 60;
const MAX_CONFIG_VALUE_LENGTH = 300;
const MAX_LABEL_LENGTH = 120;
const LOCATOR_PREFIXES = Object.freeze(["vault://", "opaque://"]);
const SECRET_KEY_BLOCKLIST = Object.freeze(["__proto__", "constructor", "prototype"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertValidFieldKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_FIELD_KEY_LENGTH) {
    throw fail("CONNECTION_FIELD_KEY_INVALID");
  }
  if (!/^[a-z0-9_]+$/.test(key) || SECRET_KEY_BLOCKLIST.includes(key)) {
    throw fail("CONNECTION_FIELD_KEY_INVALID");
  }
}

function assertLocatorShaped(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw fail("SECRET_LOCATOR_REQUIRED");
  }
  if (!LOCATOR_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    // Rule 17: plaintext secrets are structurally rejected before any write.
    throw fail("PLAINTEXT_SECRET_REJECTED");
  }
}

function assertConfigValue(value) {
  if (typeof value !== "string") throw fail("CONFIG_FIELD_VALUE_INVALID");
  if (value.length > MAX_CONFIG_VALUE_LENGTH) throw fail("CONFIG_FIELD_VALUE_INVALID");
  // A "config" field must never smuggle a locator (that class is secret-only).
  if (LOCATOR_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw fail("CONFIG_FIELD_LOCATOR_PROHIBITED");
  }
}

function sanitizeJsonMap(map, mode) {
  if (map === undefined || map === null) return {};
  if (!isPlainObject(map)) throw fail("CONNECTION_FIELDS_INVALID");
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    assertValidFieldKey(key);
    if (mode === "secret") {
      assertLocatorShaped(value);
    } else {
      assertConfigValue(value);
    }
    out[key] = value;
  }
  return out;
}

function safeParse(json, fallback = {}) {
  if (typeof json !== "string") return isPlainObject(json) ? json : fallback;
  try {
    const parsed = JSON.parse(json);
    return isPlainObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function connectionDto(row) {
  const secretFields = safeParse(row.secret_fields);
  return {
    id: row.id,
    agentId: row.agent_id,
    providerKey: row.provider_key,
    kind: row.kind,
    status: row.status,
    // Rule 17 DTO: field KEYS only — the locator value never serializes.
    secretFieldKeys: Object.keys(secretFields).sort(),
    configFields: safeParse(row.config_fields),
    credentialLabel: row.credential_label ?? null,
    catalog: catalogSummary(row.provider_key, row.kind),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function catalogSummary(providerKey, kind) {
  const entry = PROVIDER_CATALOG[providerKey];
  if (!entry) {
    return {
      displayName: providerKey,
      category: kind,
      authType: null,
      websiteUrl: null,
      credentialUrl: null,
      custom: true,
    };
  }
  return {
    displayName: entry.displayName,
    category: entry.category,
    authType: entry.authType,
    websiteUrl: entry.websiteUrl,
    credentialUrl: entry.credentialUrl,
    custom: false,
  };
}

function testDto(row) {
  return {
    id: String(row.id),
    connectionId: row.connection_id,
    agentId: row.agent_id,
    outcome: row.outcome,
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    errorCode: row.error_code ?? null,
    detail: row.detail ?? null,
    createdAt: toIso(row.created_at),
  };
}

function boundedLimit(raw, fallback) {
  const n = Math.floor(Number(raw));
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIST_LIMIT);
}

export class DirectorConnectionsRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * List a director's connections. Scoped by (ownerId, agentId) — always both.
   */
  async listConnections(ownerId, agentId, { limit } = {}) {
    const rows = await this.db.query(
      "SELECT * FROM director_connections WHERE owner_id = $1 AND agent_id = $2 ORDER BY kind, provider_key LIMIT " +
        boundedLimit(limit, MAX_LIST_LIMIT),
      [ownerId, agentId],
    );
    return rows.rows.map(connectionDto);
  }

  /**
   * One connection. Cross-owner / cross-director → null (generic not-found).
   */
  async getConnection(ownerId, agentId, connectionId) {
    const rows = await this.db.query(
      "SELECT * FROM director_connections WHERE id = $1 AND owner_id = $2 AND agent_id = $3",
      [connectionId, ownerId, agentId],
    );
    return rows.rows.length === 0 ? null : connectionDto(rows.rows[0]);
  }

  /**
   * Create (or fully replace) the single connection for (owner, agent,
   * providerKey, kind). Secret fields MUST be locator-shaped; configuration
   * fields MUST be plain strings. Throws PLAINTEXT_SECRET_REJECTED otherwise.
   */
  async upsertConnection(ownerId, agentId, { providerKey, kind, secretFields, configFields, credentialLabel } = {}) {
    if (typeof providerKey !== "string" || !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(providerKey)) {
      throw fail("PROVIDER_KEY_INVALID");
    }
    if (!CONNECTION_KINDS.includes(kind)) throw fail("CONNECTION_KIND_INVALID");
    if (credentialLabel !== undefined && credentialLabel !== null &&
        (typeof credentialLabel !== "string" || credentialLabel.length > MAX_LABEL_LENGTH)) {
      throw fail("CONNECTION_LABEL_INVALID");
    }
    const secrets = sanitizeJsonMap(secretFields, "secret");
    const config = sanitizeJsonMap(configFields, "config");
    if (Object.keys(secrets).length === 0 && Object.keys(config).length === 0) {
      throw fail("CONNECTION_EMPTY");
    }
    // Defense in depth on top of the DB CHECK constraint (Rule 17).
    if (Object.keys(secrets).length > 0 && !isLocatorShapedSecretFields(secrets)) {
      throw fail("SECRET_LOCATOR_REQUIRED");
    }
    const hasSecrets = Object.keys(secrets).length > 0;
    const status = hasSecrets || Object.keys(config).length > 0 ? "configured" : "not_configured";

    const result = await this.db.query(
      `INSERT INTO director_connections
         (owner_id, agent_id, provider_key, kind, status, credential_label, secret_fields, config_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       ON CONFLICT (owner_id, agent_id, provider_key, kind)
       DO UPDATE SET
         status = EXCLUDED.status,
         credential_label = EXCLUDED.credential_label,
         secret_fields = EXCLUDED.secret_fields,
         config_fields = EXCLUDED.config_fields,
         updated_at = now()
       RETURNING *`,
      [
        ownerId,
        agentId,
        providerKey,
        kind,
        status,
        credentialLabel ?? null,
        JSON.stringify(secrets),
        JSON.stringify(config),
      ],
    );
    return connectionDto(result.rows[0]);
  }

  /**
   * Delete a connection. Scoped by (owner, agent, id); null when absent.
   */
  async deleteConnection(ownerId, agentId, connectionId) {
    const rows = await this.db.query(
      "DELETE FROM director_connections WHERE id = $1 AND owner_id = $2 AND agent_id = $3 RETURNING id",
      [connectionId, ownerId, agentId],
    );
    return rows.rows.length > 0;
  }

  /**
   * Record an HONEST connection-test outcome (append-only; the DB trigger
   * blocks UPDATE/DELETE). Runs inside the caller-supplied transaction when
   * provided so the audit row and any status change cannot diverge (Rule 6).
   *
   * The test runner itself lives in `runConnectionTest` below: with no live
   * transport configured it reports `unverified` — never `success` (Rule 1).
   */
  async recordTestResult(db, { connectionId, ownerId, agentId, outcome, latencyMs, errorCode, detail }) {
    const executor = db ?? this.db;
    if (!TEST_OUTCOMES.includes(outcome)) throw fail("TEST_OUTCOME_INVALID");
    const latency =
      latencyMs === undefined || latencyMs === null
        ? null
        : Number(latencyMs);
    if (latency !== null && (!Number.isSafeInteger(latency) || latency < 0)) {
      throw fail("TEST_LATENCY_INVALID");
    }
    const rows = await executor.query(
      `INSERT INTO director_connection_tests
         (connection_id, owner_id, agent_id, outcome, latency_ms, error_code, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        connectionId,
        ownerId,
        agentId,
        outcome,
        latency,
        errorCode ? String(errorCode).slice(0, 100) : null,
        detail ? String(detail).slice(0, 500) : null,
      ],
    );
    return testDto(rows.rows[0]);
  }

  /** Append-only test history for one connection (owner+agent scoped). */
  async listTestResults(ownerId, agentId, connectionId, { limit } = {}) {
    const rows = await this.db.query(
      "SELECT * FROM director_connection_tests WHERE connection_id = $1 AND owner_id = $2 AND agent_id = $3 ORDER BY id DESC LIMIT " +
        boundedLimit(limit, 20),
      [connectionId, ownerId, agentId],
    );
    return rows.rows.map(testDto);
  }
}

/**
 * Run a connection test. HONEST by construction (AGENTS.md Rule 1):
 *
 *   - `transport` is the owner/deployer-configured async checker. Only a
 *     transport that EXPLICITLY returns `{ ok: true }` produces `success`.
 *   - No transport (the default, and the current production reality) →
 *     outcome `unverified` with a truthful detail line. This is NOT an error
 *     and NOT a success: the UI reports exactly that.
 *   - Transport exceptions → `failed` with a sanitized error code/detail
 *     (sanitizeErrorMessage strips locators and secret-shaped strings).
 *   - The result object never contains secret values; only field keys travel.
 *
 * Returns { outcome, latencyMs?, errorCode?, detail? } — the caller persists
 * it via recordTestResult in the same transaction as any status update.
 */
export async function runConnectionTest(connection, { transport, now = () => new Date() } = {}) {
  if (!connection || typeof connection.id !== "string") {
    throw fail("CONNECTION_NOT_FOUND");
  }
  const startedAt = now().getTime();
  if (typeof transport !== "function") {
    return {
      outcome: "unverified",
      detail: "LIVE_TRANSPORT_NOT_CONFIGURED: no owner-configured transport; nothing was called, nothing was verified.",
    };
  }
  try {
    // Only field KEYS are handed to the transport — never locator values.
    const result = await transport({
      connectionId: connection.id,
      providerKey: connection.providerKey,
      kind: connection.kind,
      secretFieldKeys: connection.secretFieldKeys,
      configFields: connection.configFields,
    });
    if (!result || typeof result !== "object" || result.ok !== true) {
      const rawReason = result && typeof result === "object" ? result.reason : "TRANSPORT_REJECTED";
      return {
        outcome: "failed",
        latencyMs: now().getTime() - startedAt,
        errorCode: "CONNECTION_TEST_FAILED",
        detail: sanitizeErrorMessage(String(rawReason ?? "TRANSPORT_REJECTED")).slice(0, 500),
      };
    }
    return {
      outcome: "success",
      latencyMs: now().getTime() - startedAt,
      detail: "Transport confirmed the credential in the external secret manager.",
    };
  } catch (err) {
    return {
      outcome: "failed",
      latencyMs: now().getTime() - startedAt,
      errorCode: "CONNECTION_TEST_FAILED",
      detail: sanitizeErrorMessage(err?.message ?? String(err)).slice(0, 500),
    };
  }
}
