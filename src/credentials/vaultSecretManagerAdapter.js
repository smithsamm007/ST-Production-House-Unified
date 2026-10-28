/**
 * ST Production House — built-in HashiCorp Vault KV v2 secret-manager adapter
 * (Issue #210, STEP 2 durable custody).
 *
 * Implements the SAME three-method contract as every other operator adapter
 * (writeSecret/readSecret/deleteSecret → locator-shaped results) against the
 * OFFICIAL Vault KV v2 HTTP API, so the OAuth lifecycle (#206) can hold OAuth
 * tokens in DURABLE external custody while PostgreSQL persists only the
 * opaque locator (AGENTS.md Rule 4 and the §14 architecture: OWNER → EXTERNAL
 * DURABLE SECRET MANAGER → LOCATOR → PostgreSQL).
 *
 * Honesty rules:
 *   - DURABLE by construction: the manager is labeled nonDurable:false and
 *     contacts an EXTERNAL Vault server. This is not the builtin-env stopgap.
 *   - LIVE DEPLOYMENT IS OWNER-GATED: this module performs no network call
 *     unless wired by an operator; tests inject a transport (offline). A
 *     reachable Vault with a valid token is required for real custody and
 *     that provisioning is OWNER ACTION REQUIRED (Issue #118 territory).
 *   - The Vault token is read at load time from an env var OR a token file
 *     (container-secrets pattern). The token never serializes into errors,
 *     logs, DTOs, or responses (Rule 17); error details are sanitized.
 *   - Fail closed: unknown mounts are never resolved (confused-deputy
 *     defense), non-locator results are rejected by the guarded boundary,
 *     and every failure maps to a stable sanitized code. No error is ever
 *     translated into success.
 *
 * Official API surface used (KV v2):
 *   WRITE  POST   {address}/v1/{mount}/data/{path}     body {"data": {...}}
 *   READ   GET    {address}/v1/{mount}/data/{path}     → data.data
 *   DELETE DELETE {address}/v1/{mount}/metadata/{path}
 *   Auth: X-Vault-Token header.
 *
 * Locator mapping: vault://{mount}/{path} — exactly the scheme already
 * allowed by sql/011 and sql/028 CHECK constraints. No new dependencies.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { sanitizeErrorMessage } from "./credentialBroker.js";

const DEFAULT_MOUNT = "secret";
const MAX_PATH_SEGMENT = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

function fail(code, detail = undefined) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** A segment usable inside a Vault path: bounded, no slashes, no traversal. */
function safeSegment(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_SEGMENT) {
    throw fail("SECRET_MANAGER_LOCATOR_INVALID", `${label} segment invalid`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw fail("SECRET_MANAGER_LOCATOR_INVALID", `${label} segment contains path separators`);
  }
  if (!/^[A-Za-z0-9@._-]+$/.test(value)) {
    throw fail("SECRET_MANAGER_LOCATOR_INVALID", `${label} segment has unsupported characters`);
  }
  return value;
}

/** Parse a vault:// locator produced by THIS adapter's mount only. */
function parseLocator(locator, configuredMount) {
  if (typeof locator !== "string" || !locator.startsWith("vault://")) {
    throw fail("SECRET_MANAGER_LOCATOR_INVALID");
  }
  // URL parsing normalizes "." and ".." away, which would silently rewrite a
  // traversal locator into a different Vault path. Reject raw traversal and
  // dot segments BEFORE any URL construction (fail closed, Issue #210).
  const rawPath = locator.slice("vault://".length).replace(/^[^/]+/, "");
  if (/(^|\/)\.{1,2}(\/|$)/.test(rawPath)) {
    throw fail("SECRET_MANAGER_LOCATOR_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(locator);
  } catch {
    throw fail("SECRET_MANAGER_LOCATOR_INVALID");
  }
  const mount = parsed.host;
  const relativePath = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!mount || !relativePath) throw fail("SECRET_MANAGER_LOCATOR_INVALID");
  // Confused-deputy defense: a locator from ANOTHER mount (or another
  // deployment's mount) is never resolved against this manager.
  if (mount !== configuredMount) {
    throw fail("SECRET_MANAGER_LOCATOR_MOUNT_MISMATCH", `locator mount "${mount}" is not the configured mount`);
  }
  for (const segment of relativePath.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw fail("SECRET_MANAGER_LOCATOR_INVALID");
    }
  }
  return { mount, path: relativePath };
}

/**
 * Operator configuration (read at call time, never cached at module load).
 * Required: address + a token source (env var or token file) + mount.
 */
export function loadVaultAdapterConfig(env = process.env) {
  const address = env.STPH_SECRET_MANAGER_VAULT_ADDRESS || null;
  const mount = env.STPH_SECRET_MANAGER_VAULT_MOUNT || DEFAULT_MOUNT;
  const token = env.STPH_SECRET_MANAGER_VAULT_TOKEN || null;
  const tokenFile = env.STPH_SECRET_MANAGER_VAULT_TOKEN_FILE || null;
  return { address, mount, token, tokenFile };
}

/**
 * Honest pre-check: is the vault-http adapter fully configured? Partial
 * configuration (address without a token source, etc.) is NOT configuration.
 */
export function isVaultAdapterConfigured(config = loadVaultAdapterConfig()) {
  if (!config.address || !config.mount) return false;
  if (!config.token && !config.tokenFile) return false;
  try {
    validateVaultAddress(config.address);
    return true;
  } catch {
    return false;
  }
}

function validateVaultAddress(address) {
  if (typeof address !== "string" || address.length === 0 || address.length > 512) {
    throw fail("SECRET_MANAGER_ADAPTER_INVALID", "vault address invalid");
  }
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    throw fail("SECRET_MANAGER_ADAPTER_INVALID", "vault address not a URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    // Production custody must be HTTPS; loopback http is for local dev only
    // (mirrors the repository's existing lint exclusions).
    throw fail("SECRET_MANAGER_ADAPTER_INVALID", "vault address must be https");
  }
  if (parsed.username || parsed.password) {
    throw fail("SECRET_MANAGER_ADAPTER_INVALID", "vault address must not embed credentials");
  }
  if (parsed.search || parsed.hash) {
    throw fail("SECRET_MANAGER_ADAPTER_INVALID", "vault address must not carry query/fragment");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function resolveVaultToken(config) {
  if (config.token && typeof config.token === "string" && config.token.length > 0) {
    return config.token;
  }
  if (config.tokenFile && typeof config.tokenFile === "string" && config.tokenFile.length > 0) {
    try {
      const content = readFileSync(config.tokenFile, "utf8").trim();
      if (content.length === 0) throw fail("SECRET_MANAGER_AUTH_FAILED", "token file empty");
      return content;
    } catch (err) {
      if (err?.code === "SECRET_MANAGER_AUTH_FAILED") throw err;
      throw fail("SECRET_MANAGER_AUTH_FAILED", "token file unreadable");
    }
  }
  throw fail("SECRET_MANAGER_AUTH_FAILED", "no vault token source");
}

/**
 * Default HTTPS transport (same boundary contract as the OAuth service).
 * Any network/timeout failure normalizes to SECRET_MANAGER_UNREACHABLE.
 */
async function defaultVaultTransport({ method, url, headers, body, timeoutMs }) {
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
    throw fail("SECRET_MANAGER_UNREACHABLE", sanitizeErrorMessage(err?.message));
  }
  const text = await response.text();
  return { status: response.status, body: text };
}

function mapVaultFailure(status, bodyText) {
  let providerCode = "";
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      providerCode = sanitizeErrorMessage(String(parsed.errors[0]));
    }
  } catch {
    // non-JSON body: keep the generic mapping below
  }
  if (status === 403 || status === 401) {
    return fail("SECRET_MANAGER_AUTH_FAILED", providerCode || "vault denied the operation");
  }
  if (status === 404) {
    return fail("SECRET_MANAGER_ENTRY_NOT_FOUND");
  }
  const detail = providerCode || `vault_http_status_${status}`;
  return fail("SECRET_MANAGER_ADAPTER_FAILED", detail.slice(0, 200));
}

/**
 * Create the Vault KV v2 adapter. The result satisfies the operator adapter
 * contract and is ready to be wrapped by guardSecretManagerAdapter().
 */
export function createVaultSecretManager({
  address,
  mount = DEFAULT_MOUNT,
  token,
  tokenFile,
  transport,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = validateVaultAddress(address);
  if (!mount || typeof mount !== "string" || !/^[a-z0-9-]{1,50}$/.test(mount)) {
    throw fail("SECRET_MANAGER_ADAPTER_INVALID", "vault mount invalid");
  }
  // The token is resolved eagerly so a missing token source is a LOUD
  // configuration failure at wiring time, never a mid-lifecycle surprise.
  const vaultToken = resolveVaultToken({ token, tokenFile });

  const doRequest = transport ?? defaultVaultTransport;
  const dataUrl = (path) => `${base}/v1/${mount}/data/${path}`;
  const metadataUrl = (path) => `${base}/v1/${mount}/metadata/${path}`;
  const headers = () => ({
    "x-vault-token": vaultToken,
    "content-type": "application/json",
    accept: "application/json",
  });

  async function request({ method, url, body }) {
    let response;
    try {
      response = await doRequest({
        method,
        url,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
      });
    } catch (err) {
      if (err?.code === "SECRET_MANAGER_UNREACHABLE") throw err;
      throw fail("SECRET_MANAGER_UNREACHABLE", sanitizeErrorMessage(err?.message));
    }
    if (!response || typeof response.status !== "number" || typeof response.body !== "string") {
      throw fail("SECRET_MANAGER_UNREACHABLE");
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapVaultFailure(response.status, response.body);
    }
    return response;
  }

  return {
    label: `vault-http (KV v2, mount=${mount})`,
    nonDurable: false,
    /** Mount is exported (only) for mount-mismatch diagnostics in tests. */
    vaultMount: mount,

    async writeSecret({ ownerId, agentId, providerKey, payload }) {
      if (!ownerId || !agentId || !providerKey) {
        throw fail("SECRET_MANAGER_ADAPTER_FAILED", "ownerId, agentId and providerKey are required");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw fail("SECRET_MANAGER_ADAPTER_FAILED", "payload object required");
      }
      // Structural Director + owner scoping: every secret lives under
      // {prefix}/{owner}/{director}/{provider}/{unique} in the Vault namespace.
      const owner = safeSegment(ownerId, "ownerId");
      const agent = safeSegment(agentId, "agentId");
      const provider = safeSegment(providerKey, "providerKey");
      const path = `stph/${owner}/${agent}/${provider}/${randomBytes(12).toString("hex")}`;
      await request({
        method: "POST",
        url: dataUrl(path),
        body: { data: { payload, written_at: new Date().toISOString() } },
      });
      return `vault://${mount}/${path}`;
    },

    async readSecret({ locator }) {
      const { path } = parseLocator(locator, mount);
      const response = await request({ method: "GET", url: dataUrl(path) });
      let parsed;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw fail("SECRET_MANAGER_ADAPTER_FAILED", "vault response malformed");
      }
      const payload = parsed?.data?.data?.payload;
      if (!payload || typeof payload !== "object") {
        throw fail("SECRET_MANAGER_ADAPTER_FAILED", "vault secret payload missing");
      }
      return payload;
    },

    async deleteSecret({ locator }) {
      const { path } = parseLocator(locator, mount);
      await request({ method: "DELETE", url: metadataUrl(path) });
    },
  };
}
