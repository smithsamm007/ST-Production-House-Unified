/**
 * ST Production House — Canonical Director lifecycle guards (Phase 2A).
 *
 * Thin, reusable wrappers over `CanonicalDirectorRepository` for the operational
 * write paths that must refuse a retired or suspended Director:
 *
 *   - production queueing (owner API + HERMES bridge)
 *   - schedule creation/activation
 *   - Secrets & Connections mutation
 *   - YouTube / social OAuth initiation
 *   - publishing requests
 *
 * Delivery contract:
 *   - `createCanonicalDirectorGuard(db)` returns `{ assertActive, isActive }`, or
 *     `null` semantics when no adapter is wired. Call sites treat a null guard as
 *     "canonical enforcement not configured for this transport" and keep their
 *     existing behaviour — the database trigger (sql/032) still enforces the rule
 *     for every mapped Director.
 */

import {
  CanonicalDirectorRepository,
  isKnownCanonicalDirectorCode,
  CANONICAL_DIRECTOR_CODES,
  PRESERVED_UNDERLYING_AGENT_IDS,
  NEW_UNDERLYING_AGENT_IDS,
  ACTIVE_DIRECTOR_CAP,
  CANONICAL_DIRECTOR_PUBLIC_CODES,
} from "./canonicalDirectorRepository.js";

function adapterOf(db) {
  const adapter = typeof db === "function" ? db() : db;
  if (!adapter || typeof adapter.query !== "function") return null;
  return adapter;
}

/**
 * Build the guard for one adapter (or a lazy adapter resolver).
 *
 * `assertActive(underlyingAgentId)`:
 *   - resolves to unknown (no mapping row)  -> passes (pre-cutover, not governed)
 *   - active mapping                        -> passes
 *   - retired/suspended mapping             -> throws CANONICAL_DIRECTOR_NOT_ACTIVE
 *
 * `isActive(underlyingAgentId)`:
 *   - true only for an active mapping (unknown agents resolve to false, so callers
 *     that need a positive answer use this explicitly).
 */
export function createCanonicalDirectorGuard(db) {
  const resolveAdapter = () => adapterOf(db);

  async function repository() {
    const adapter = resolveAdapter();
    if (!adapter) {
      const error = new Error("CANONICAL_DIRECTOR_GUARD_NOT_CONFIGURED");
      error.code = "CANONICAL_DIRECTOR_GUARD_NOT_CONFIGURED";
      throw error;
    }
    return new CanonicalDirectorRepository(adapter);
  }

  return {
    /** Throws CANONICAL_DIRECTOR_NOT_ACTIVE when the agent is a governed non-active Director. */
    async assertActive(underlyingAgentId) {
      if (typeof underlyingAgentId !== "string" || underlyingAgentId.length === 0) {
        throw Object.assign(new Error("UNDERLYING_AGENT_INVALID"), {
          code: "UNDERLYING_AGENT_INVALID",
        });
      }
      const repo = await repository();
      const mapping = await repo.findByUnderlyingAgentId(underlyingAgentId);
      if (!mapping) return null; // not governed by the canonical registry yet
      if (mapping.status !== "active") {
        throw Object.assign(
          new Error(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_ACTIVE),
          { code: CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_ACTIVE }
        );
      }
      return mapping;
    },

    /** True only for an active canonical mapping. */
    async isActive(underlyingAgentId) {
      if (typeof underlyingAgentId !== "string" || underlyingAgentId.length === 0) {
        return false;
      }
      const repo = await repository();
      const mapping = await repo.findActiveByUnderlyingAgentId(underlyingAgentId);
      return mapping !== null;
    },

    /** Convenience: assert by canonical Director code instead of underlying key. */
    async assertActiveCode(canonicalDirectorCode) {
      if (!isKnownCanonicalDirectorCode(canonicalDirectorCode)) {
        throw Object.assign(
          new Error(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_CODE_INVALID),
          { code: CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_CODE_INVALID }
        );
      }
      const repo = await repository();
      const mapping = await repo.findActiveByCode(canonicalDirectorCode);
      if (!mapping) {
        throw Object.assign(
          new Error(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_ACTIVE),
          { code: CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_ACTIVE }
        );
      }
      return mapping;
    },
  };
}

/**
 * Wrap a guard so a mapper failure degrades to "not governed" only when the guard
 * itself is unavailable (no storage). Enforcement failures (NOT_ACTIVE) always
 * propagate.
 */
export function safeCanonicalDirectorGuard(guard) {
  if (!guard || typeof guard.assertActive !== "function") {
    return { assertActive: async () => null, isActive: async () => false };
  }
  return guard;
}

/**
 * One-call operational enforcement used by the write-path call sites.
 *
 * Returns the active mapping (or null when the agent is not governed). Throws
 * `CANONICAL_DIRECTOR_NOT_ACTIVE` when the agent's mapping exists but is retired or
 * suspended — callers map that to a 409 and never queue the work.
 *
 * Two honest degenerations, both deliberate and documented:
 *   - no adapter wired (module mounted before configureRuntime / demo transport):
 *     returns null; the sql/032 triggers still enforce the rule in the database.
 *   - the canonical mapping table does not exist yet (a database that has not run
 *     migration 032): returns null instead of failing every production write.
 * They are distinguishable from enforcement because only a genuine governed-
 * non-active mapping throws.
 */
export async function enforceOperationalActive(db, underlyingAgentId) {
  const adapter = adapterOf(db);
  if (!adapter) return null;
  const guard = createCanonicalDirectorGuard(adapter);
  try {
    return await guard.assertActive(underlyingAgentId);
  } catch (error) {
    // 42P01 = undefined_table: pre-migration database, nothing to enforce yet.
    if (error?.code === "42P01") return null;
    throw error;
  }
}

export {
  CANONICAL_DIRECTOR_CODES,
  PRESERVED_UNDERLYING_AGENT_IDS,
  NEW_UNDERLYING_AGENT_IDS,
  ACTIVE_DIRECTOR_CAP,
  CANONICAL_DIRECTOR_PUBLIC_CODES,
  isKnownCanonicalDirectorCode,
};
