/**
 * ST Production House — operator secret-manager adapter contract (Issue #208).
 *
 * The YouTube OAuth lifecycle (Issue #206) hands tokens ONLY to an injected
 * external secret-manager adapter and persists nothing but the OPAQUE locator
 * it returns. #207 shipped that lifecycle with a labeled in-memory placeholder
 * for tests/demo and NO production wiring: an operator holding real Google
 * credentials had no supported way to cross into live mode. This module is the
 * code-side wiring surface for that boundary (master execution order STEP 2).
 *
 * Contract for an operator-supplied secret manager:
 *   const manager = await loadConfiguredSecretManager();
 *   // → { writeSecret({ownerId, agentId, providerKey, payload}) → locator
 *   //      readSecret({locator}) → payload object
 *   //      deleteSecret({locator}) → void, all async, all fail-closed }
 *
 * Hard rules enforced here (AGENTS.md):
 *   - Rule 17: only locator-shaped results are accepted; raw secret material
 *     returned by an adapter is structurally rejected before it can reach the
 *     OAuth service; adapter error messages are sanitized (locators and
 *     secret-shaped strings redacted) before they cross the boundary.
 *   - Rule 3: there is NO default real implementation. The labeled
 *     in-memory placeholder from #206 stays test/demo-only and is NEVER wired
 *     by this module. Nothing here fakes availability.
 *   - Rule 1: missing or broken configuration is an explicit, stable failure —
 *     never silent success.
 *
 * No new dependencies: Node built-ins only.
 */

import { sanitizeErrorMessage } from "./credentialBroker.js";

/**
 * Operator-selectable adapter kinds. Bounded allowlist: an unknown
 * STPH_SECRET_MANAGER_ADAPTER value fails closed with a stable code instead
 * of silently doing nothing.
 *
 * - "builtin-env": zero-infrastructure adapter storing locators in a
 *   process-local Map, seeded from operator-declared environment variables.
 *   NON-DURABLE and process-local by design: acceptable ONLY as an explicit
 *   operator stopgap (Rule 3 label below); a restart loses held secrets and
 *   connected YouTube grants must be re-connected.
 * - "custom": the operator supplies a factory module via
 *   STPH_SECRET_MANAGER_ADAPTER_MODULE (default export). The module is the
 *   trust boundary — it must implement the same three-method contract.
 */
export const SECRET_MANAGER_ADAPTER_KINDS = Object.freeze(["builtin-env", "custom"]);

const LOCATOR_PREFIXES = Object.freeze(["vault://", "opaque://"]);
const MAX_LOCATOR_LENGTH = 512;

function fail(code, detail = undefined) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** Locator-shaped check shared with the OAuth repository contract. */
export function isLocatorShaped(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LOCATOR_LENGTH &&
    LOCATOR_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

/**
 * Operator configuration, read at call time (never cached at module load so
 * tests can set env in-process).
 */
export function loadSecretManagerConfig(env = process.env) {
  const kind = env.STPH_SECRET_MANAGER_ADAPTER || null;
  const customModule = env.STPH_SECRET_MANAGER_ADAPTER_MODULE || null;
  const seedVars = (env.STPH_SECRET_MANAGER_ENV_SEED || "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return { kind, customModule, seedVars };
}

/** Honest pre-check used by status surfaces: is an adapter declared at all? */
export function isSecretManagerConfigured(config = loadSecretManagerConfig()) {
  if (config.kind === "builtin-env") return true;
  if (config.kind === "custom") return Boolean(config.customModule);
  return false;
}

/**
 * Structural validation of ANY operator-supplied adapter. Rejects:
 * missing methods, non-function methods, a labeled in-memory placeholder
 * passed off as production infrastructure (Rule 3), and adapters whose
 * writeSecret does not return a locator-shaped value.
 */
export function validateSecretManagerAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw fail("SECRET_MANAGER_ADAPTER_INVALID");
  }
  if (adapter.isPlaceholder === true) {
    // Rule 3: a labeled placeholder must never pass as production wiring.
    throw fail("SECRET_MANAGER_ADAPTER_PLACEHOLDER_REJECTED");
  }
  for (const method of ["writeSecret", "readSecret", "deleteSecret"]) {
    if (typeof adapter[method] !== "function") {
      throw fail("SECRET_MANAGER_ADAPTER_INVALID");
    }
  }
  return adapter;
}

/**
 * Wrap an operator adapter so the OAuth service boundary stays stable:
 *   - writeSecret results must be locator-shaped (raw secret material
 *     returned by mistake is structurally rejected);
 *   - thrown errors keep their stable code when present, otherwise normalize
 *     to SECRET_MANAGER_ADAPTER_FAILED with a SANITIZED message (locators and
 *     secret-shaped strings redacted — Rule 17).
 */
export function guardSecretManagerAdapter(adapter) {
  validateSecretManagerAdapter(adapter);

  async function guarded(methodName, args) {
    let result;
    try {
      result = await adapter[methodName](...args);
    } catch (err) {
      if (err && typeof err.code === "string" && err.code.length > 0) {
        throw err; // adapter-provided stable codes pass through untouched
      }
      throw fail("SECRET_MANAGER_ADAPTER_FAILED", sanitizeErrorMessage(err?.message));
    }
    if (methodName === "writeSecret" && !isLocatorShaped(result)) {
      throw fail("SECRET_MANAGER_LOCATOR_INVALID");
    }
    return result;
  }

  return {
    label: `guarded:${adapter.label ?? "operator-adapter"}`,
    // Durability class is forwarded honestly for status/health surfaces:
    // operators must be able to see when custody is process-local (Rule 1).
    nonDurable: adapter.nonDurable === true,
    writeSecret: (...args) => guarded("writeSecret", args),
    readSecret: (...args) => guarded("readSecret", args),
    deleteSecret: (...args) => guarded("deleteSecret", args),
  };
}

/**
 * "builtin-env" adapter. Locators live in a process-local Map, seeded from
 * the operator-declared environment variables (STPH_SECRET_MANAGER_ENV_SEED).
 * NON-DURABLE BY DESIGN — labeled honestly everywhere. An operator running
 * this in production accepts that a process restart drops held token bundles
 * (connected grants must be re-connected); durable custody requires the
 * "custom" adapter kind backed by a real external manager.
 */
export function createBuiltinEnvSecretManager({ seedVars = [], env = process.env } = {}) {
  const store = new Map();
  for (const name of seedVars) {
    const seedLocator = env[name];
    if (typeof seedLocator === "string" && seedLocator.length > 0 && isLocatorShaped(seedLocator)) {
      // The env var's VALUE is treated as an opaque locator reference (e.g.
      // pointing at an external store); it is never a raw secret.
      store.set(seedLocator, {
        ownerId: null,
        agentId: null,
        providerKey: null,
        payload: { locator_ref: seedLocator, source: `env:${name}` },
      });
    }
  }

  return {
    label: "builtin-env (non-durable, process-local)",
    nonDurable: true,
    async writeSecret({ ownerId, agentId, providerKey, payload }) {
      if (!ownerId || !agentId || !providerKey) {
        throw fail("SECRET_MANAGER_ADAPTER_FAILED", "ownerId, agentId and providerKey are required");
      }
      if (!payload || typeof payload !== "object") {
        throw fail("SECRET_MANAGER_ADAPTER_FAILED", "payload object required");
      }
      // Locator shape mirrors the placeholder: opaque://builtin-env/...
      // Unpredictable suffix so locators cannot be guessed or enumerated.
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const locator = `opaque://builtin-env/${providerKey}/${agentId}/${suffix}`;
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

/**
 * Load the operator-configured adapter (or null when none is declared).
 * Throws stable, sanitized codes on misconfiguration — never fakes success.
 */
export async function loadConfiguredSecretManager(env = process.env) {
  const config = loadSecretManagerConfig(env);
  if (!isSecretManagerConfigured(config)) return null;

  if (config.kind === "builtin-env") {
    return guardSecretManagerAdapter(createBuiltinEnvSecretManager({ seedVars: config.seedVars, env }));
  }

  // kind === "custom": dynamic import of the operator's factory module.
  let mod;
  try {
    mod = await import(config.customModule);
  } catch (err) {
    throw fail("SECRET_MANAGER_ADAPTER_MODULE_UNAVAILABLE", sanitizeErrorMessage(err?.message));
  }
  const factory = mod.default ?? mod.createSecretManager ?? mod.factory;
  if (typeof factory !== "function") {
    throw fail("SECRET_MANAGER_ADAPTER_INVALID");
  }
  let adapter;
  try {
    adapter = await factory({ env });
  } catch (err) {
    if (err && typeof err.code === "string" && err.code.length > 0) throw err;
    throw fail("SECRET_MANAGER_ADAPTER_FAILED", sanitizeErrorMessage(err?.message));
  }
  return guardSecretManagerAdapter(adapter);
}
