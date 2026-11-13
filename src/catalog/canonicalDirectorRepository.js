/**
 * ST Production House — Canonical Director registry (Phase 2A).
 *
 * The single authoritative lifecycle state for the canonical 10 Directors, on
 * `canonical_director_mappings` (sql/032).
 *
 * Contract:
 *   - One row per canonical Director code; `status` is the ONLY authoritative
 *     lifecycle state (active | retired | suspended).
 *   - Active cap invariant: COUNT(status = 'active') <= 50, serialized on the
 *     dedicated `canonical_director_cap_lock` row with a transaction-scoped
 *     `SELECT ... FOR UPDATE`. The database enforces the same rule with a trigger,
 *     so the invariant survives a writer that bypasses this repository.
 *   - Retirement is expressed here, never by deleting or repurposing an `agents`
 *     row: history, channels, jobs, schedules, credentials and evidence stay
 *     attributed to the underlying key they were created under.
 *   - A retired or suspended mapping can never resolve to an active production
 *     origin: `requireActiveUnderlyingAgent` / `resolveActiveUnderlyingAgentId`
 *     throw `CANONICAL_DIRECTOR_NOT_ACTIVE`.
 *
 * Portability: every statement is parameterized single-table SQL (no joins, no
 * scalar subqueries), inside the subset shared with the labeled demo adapter.
 */

import { randomUUID } from "node:crypto";

/** The frozen canonical Director set. Unknown codes fail closed. */
export const CANONICAL_DIRECTOR_CODES = Object.freeze([
  "JARVIS",
  "COSMOS",
  "NEWTON",
  "AADI",
  "LAKME",
  "SHERLOCK",
  "CHRONOS",
  "AI NEWS",
  "TECH MASTER",
  "BUTTERFLY",
]);

/** Preserved underlying keys and the six new deterministic underlying IDs. */
export const PRESERVED_UNDERLYING_AGENT_IDS = Object.freeze([
  "agent-01",
  "agent-02",
  "agent-03",
  "agent-21",
]);

export const NEW_UNDERLYING_AGENT_IDS = Object.freeze([
  "agent-director-cosmos",
  "agent-director-aadi",
  "agent-director-chronos",
  "agent-director-ai-news",
  "agent-director-tech-master",
  "agent-director-butterfly",
]);

export const ACTIVE_DIRECTOR_CAP = 50;

export const CANONICAL_DIRECTOR_STATUSES = Object.freeze([
  "active",
  "retired",
  "suspended",
]);

export const CANONICAL_DIRECTOR_PUBLIC_CODES = Object.freeze({
  CANONICAL_DIRECTOR_CODE_INVALID: "CANONICAL_DIRECTOR_CODE_INVALID",
  CANONICAL_DIRECTOR_NOT_FOUND: "CANONICAL_DIRECTOR_NOT_FOUND",
  CANONICAL_DIRECTOR_NOT_ACTIVE: "CANONICAL_DIRECTOR_NOT_ACTIVE",
  ACTIVE_DIRECTOR_CAP_REACHED: "ACTIVE_DIRECTOR_CAP_REACHED",
  MAPPING_ALREADY_EXISTS: "MAPPING_ALREADY_EXISTS",
  STATUS_INVALID: "STATUS_INVALID",
  UNDERLYING_AGENT_INVALID: "UNDERLYING_AGENT_INVALID",
});

const MAPPING_COLUMNS = `id,
         canonical_director_code,
         underlying_agent_id,
         display_name,
         namespace,
         status,
         retired_at,
         retired_reason,
         suspended_note,
         created_at,
         updated_at`;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function isKnownCanonicalDirectorCode(code) {
  return typeof code === "string" && CANONICAL_DIRECTOR_CODES.includes(code);
}

function assertKnownCode(code) {
  if (!isKnownCanonicalDirectorCode(code)) {
    throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_CODE_INVALID);
  }
  return code;
}

function assertUnderlyingAgentId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) {
    throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.UNDERLYING_AGENT_INVALID);
  }
  return value;
}

/** Row -> safe DTO (explicit allowlist, camelCase, ISO timestamps). */
export function canonicalDirectorMappingDto(row) {
  return Object.freeze({
    id: row.id,
    canonicalDirectorCode: row.canonical_director_code,
    underlyingAgentId: row.underlying_agent_id,
    displayName: row.display_name,
    namespace: row.namespace,
    status: row.status,
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
    retiredReason: row.retired_reason ?? null,
    suspendedNote: row.suspended_note ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export class CanonicalDirectorRepository {
  constructor(db) {
    if (!db || typeof db.query !== "function") {
      throw new Error("CANONICAL_DIRECTOR_DB_REQUIRED");
    }
    this.db = db;
  }

  // ---------------------------------------------------------------- reads

  /** Every mapping, active first. */
  async listAll() {
    const result = await this.db.query(
      `SELECT ${MAPPING_COLUMNS}
         FROM canonical_director_mappings
        ORDER BY (status = 'active')::int DESC, canonical_director_code ASC;`
    );
    return result.rows.map(canonicalDirectorMappingDto);
  }

  /** Active mappings only — the set the cap invariant is about. */
  async listActive() {
    const result = await this.db.query(
      `SELECT ${MAPPING_COLUMNS}
         FROM canonical_director_mappings
        WHERE status = 'active'
        ORDER BY canonical_director_code ASC;`
    );
    return result.rows.map(canonicalDirectorMappingDto);
  }

  /** One mapping regardless of status, or null. */
  async findByCode(canonicalDirectorCode) {
    assertKnownCode(canonicalDirectorCode);
    const result = await this.db.query(
      `SELECT ${MAPPING_COLUMNS}
         FROM canonical_director_mappings
        WHERE canonical_director_code = $1
        LIMIT 1;`,
      [canonicalDirectorCode]
    );
    return result.rows[0] ? canonicalDirectorMappingDto(result.rows[0]) : null;
  }

  /** The mapping for a code only while it is active, or null. */
  async findActiveByCode(canonicalDirectorCode) {
    assertKnownCode(canonicalDirectorCode);
    const result = await this.db.query(
      `SELECT ${MAPPING_COLUMNS}
         FROM canonical_director_mappings
        WHERE canonical_director_code = $1
          AND status = 'active'
        LIMIT 1;`,
      [canonicalDirectorCode]
    );
    return result.rows[0] ? canonicalDirectorMappingDto(result.rows[0]) : null;
  }

  /** The active mapping for an underlying key, or null. */
  async findActiveByUnderlyingAgentId(underlyingAgentId) {
    if (typeof underlyingAgentId !== "string" || underlyingAgentId.length === 0) {
      return null;
    }
    const result = await this.db.query(
      `SELECT ${MAPPING_COLUMNS}
         FROM canonical_director_mappings
        WHERE underlying_agent_id = $1
          AND status = 'active'
        LIMIT 1;`,
      [underlyingAgentId]
    );
    return result.rows[0] ? canonicalDirectorMappingDto(result.rows[0]) : null;
  }

  /** Any mapping for an underlying key, regardless of status, or null. */
  async findByUnderlyingAgentId(underlyingAgentId) {
    if (typeof underlyingAgentId !== "string" || underlyingAgentId.length === 0) {
      return null;
    }
    const result = await this.db.query(
      `SELECT ${MAPPING_COLUMNS}
         FROM canonical_director_mappings
        WHERE underlying_agent_id = $1
        LIMIT 1;`,
      [underlyingAgentId]
    );
    return result.rows[0] ? canonicalDirectorMappingDto(result.rows[0]) : null;
  }

  /** Current active count (informational; enforcement is the locked path). */
  async activeCount() {
    const result = await this.db.query(
      `SELECT count(*)::int AS count
         FROM canonical_director_mappings
        WHERE status = 'active';`
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // ------------------------------------------------------ lifecycle writes

  /**
   * Record a canonical Director mapping without activating it. Activation is a
   * separate, cap-locked operation.
   */
  async createMapping({
    canonicalDirectorCode,
    underlyingAgentId,
    displayName,
    namespace,
    status = "retired",
    retiredReason = null,
    suspendedNote = null,
  }) {
    assertKnownCode(canonicalDirectorCode);
    assertUnderlyingAgentId(underlyingAgentId);

    if (!CANONICAL_DIRECTOR_STATUSES.includes(status)) {
      throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.STATUS_INVALID);
    }
    if (status === "active") {
      // Refuse to smuggle activation past the cap-locked path.
      throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.ACTIVE_DIRECTOR_CAP_REACHED);
    }

    try {
      const result = await this.db.query(
        `INSERT INTO canonical_director_mappings
           (id, canonical_director_code, underlying_agent_id, display_name, namespace,
            status, retired_at, retired_reason, suspended_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${MAPPING_COLUMNS};`,
        [
          randomUUID(),
          canonicalDirectorCode,
          underlyingAgentId,
          displayName,
          namespace,
          status,
          status === "retired" ? new Date().toISOString() : null,
          retiredReason,
          suspendedNote,
        ]
      );
      return canonicalDirectorMappingDto(result.rows[0]);
    } catch (error) {
      if (error?.code === "23505" || /unique/i.test(error?.message ?? "")) {
        throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.MAPPING_ALREADY_EXISTS);
      }
      throw error;
    }
  }

  /**
   * Activate a mapping. This is the ONLY activation path and it always runs under
   * the dedicated cap lock:
   *   BEGIN -> SELECT ... FOR UPDATE on the cap-lock row -> recount active ->
   *   (cap reached ? raise) -> UPDATE ... SET status = 'active'.
   * The migration's trigger performs the same check inside the database.
   */
  async activateMapping(canonicalDirectorCode, { underlyingAgentId = null } = {}) {
    assertKnownCode(canonicalDirectorCode);

    return this.#withCapLock(async (client) => {
      const current = await client.query(
        `SELECT status, underlying_agent_id
           FROM canonical_director_mappings
          WHERE canonical_director_code = $1
          LIMIT 1;`,
        [canonicalDirectorCode]
      );
      if (current.rows.length === 0) {
        throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_FOUND);
      }

      const row = current.rows[0];
      if (underlyingAgentId !== null && underlyingAgentId !== row.underlying_agent_id) {
        throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.UNDERLYING_AGENT_INVALID);
      }
      if (row.status === "active") {
        // Idempotent: already active, nothing to enforce.
        const again = await client.query(
          `SELECT ${MAPPING_COLUMNS}
             FROM canonical_director_mappings
            WHERE canonical_director_code = $1
            LIMIT 1;`,
          [canonicalDirectorCode]
        );
        return canonicalDirectorMappingDto(again.rows[0]);
      }

      const count = await client.query(
        `SELECT count(*)::int AS count
           FROM canonical_director_mappings
          WHERE status = 'active';`
      );
      if (Number(count.rows[0]?.count ?? 0) >= ACTIVE_DIRECTOR_CAP) {
        throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.ACTIVE_DIRECTOR_CAP_REACHED);
      }

      const updated = await client.query(
        `UPDATE canonical_director_mappings
            SET status = 'active',
                retired_at = NULL,
                retired_reason = NULL,
                suspended_note = NULL,
                updated_at = now()
          WHERE canonical_director_code = $1
          RETURNING ${MAPPING_COLUMNS};`,
        [canonicalDirectorCode]
      );
      return canonicalDirectorMappingDto(updated.rows[0]);
    });
  }

  /** Retire an active mapping in place. History and the agents row are preserved. */
  async retireMapping(canonicalDirectorCode, { retiredReason = null } = {}) {
    assertKnownCode(canonicalDirectorCode);

    return this.#withCapLock(async (client) => {
      const current = await client.query(
        `SELECT status
           FROM canonical_director_mappings
          WHERE canonical_director_code = $1
          LIMIT 1;`,
        [canonicalDirectorCode]
      );
      if (current.rows.length === 0) {
        throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_FOUND);
      }
      if (current.rows[0].status !== "active") {
        throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_ACTIVE);
      }

      const updated = await client.query(
        `UPDATE canonical_director_mappings
            SET status = 'retired',
                retired_at = now(),
                retired_reason = $2,
                suspended_note = NULL,
                updated_at = now()
          WHERE canonical_director_code = $1
          RETURNING ${MAPPING_COLUMNS};`,
        [canonicalDirectorCode, retiredReason]
      );
      return canonicalDirectorMappingDto(updated.rows[0]);
    });
  }

  /** Suspend an active mapping (temporary operational block, distinct from retirement). */
  async suspendMapping(canonicalDirectorCode, { suspendedNote = null } = {}) {
    assertKnownCode(canonicalDirectorCode);

    return this.#withCapLock(async (client) => {
      const current = await client.query(
        `SELECT status
           FROM canonical_director_mappings
          WHERE canonical_director_code = $1
          LIMIT 1;`,
        [canonicalDirectorCode]
      );
      if (current.rows.length === 0) {
        throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_FOUND);
      }
      if (current.rows[0].status !== "active") {
        throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_ACTIVE);
      }

      const updated = await client.query(
        `UPDATE canonical_director_mappings
            SET status = 'suspended',
                suspended_note = $2,
                retired_at = NULL,
                retired_reason = NULL,
                updated_at = now()
          WHERE canonical_director_code = $1
          RETURNING ${MAPPING_COLUMNS};`,
        [canonicalDirectorCode, suspendedNote]
      );
      return canonicalDirectorMappingDto(updated.rows[0]);
    });
  }

  // --------------------------------------------------- operational guards

  /** Underlying agent id for an ACTIVE canonical Director, else throw. */
  async resolveActiveUnderlyingAgentId(canonicalDirectorCode) {
    const mapping = await this.findActiveByCode(assertKnownCode(canonicalDirectorCode));
    if (!mapping) {
      throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_ACTIVE);
    }
    return mapping.underlyingAgentId;
  }

  /** The active mapping for an underlying key, else throw. */
  async requireActiveUnderlyingAgent(underlyingAgentId) {
    const mapping = await this.findActiveByUnderlyingAgentId(underlyingAgentId);
    if (!mapping) {
      throw fail(CANONICAL_DIRECTOR_PUBLIC_CODES.CANONICAL_DIRECTOR_NOT_ACTIVE);
    }
    return mapping;
  }

  // ------------------------------------------------------------- internal

  /**
   * Run `callback` inside a transaction that has taken the cap lock. Falls back to
   * the plain adapter for transports without withTransaction (the labeled demo
   * adapter), where single-process semantics are already serialized.
   */
  async #withCapLock(callback) {
    const run = async (client) => {
      await client.query(
        `SELECT id
           FROM canonical_director_cap_lock
          WHERE id = 'active_director_cap'
          FOR UPDATE;`
      );
      return callback(client);
    };
    if (typeof this.db.withTransaction === "function") {
      return this.db.withTransaction(run);
    }
    return run(this.db);
  }
}
