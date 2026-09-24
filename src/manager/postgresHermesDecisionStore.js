/**
 * ST Production House — PostgreSQL-backed Hermes decision store (Issue #172).
 *
 * Durable implementation of the manager's store contract
 * (src/manager/hermesManager.js) over sql/023 `hermes_decisions`:
 *
 *   append(record)                              -> record (immutable row)
 *   list({ limit, filter })                     -> records, newest first
 *   nextDecisionNumber()                        -> monotonic max+1
 *
 * Contract rules (AGENTS.md):
 *   - Append-only (Rule 1/6): the table's trigger rejects UPDATE/DELETE
 *     (APPEND_ONLY_VIOLATION). A decision completion is a NEW record with
 *     the same decisionNumber — history is never rewritten.
 *   - Parameterized SQL only; single-table statements inside the SQL subset
 *     shared by the PostgreSQL adapter and the labeled demo adapter (which
 *     the offline tests use): no joins, no subqueries, inlined VALIDATED
 *     integer LIMITs.
 *   - R5: the DB enums mirror the manager's existing enums exactly — no new
 *     states anywhere.
 *   - Rule 17: the store persists only what the manager emits (the payload
 *     gate already rejected secret-shaped material upstream); it never reads
 *     env vars or credential material.
 *   - Lazy adapter resolution (adapter OR () => adapter) so the API can mount
 *     at module load; without storage everything fails closed with
 *     STORAGE_NOT_CONFIGURED (honest 503 up the stack — Rules 1–3).
 */

const ADVISORY_LOCK_KEY_1 = 889901;
const ADVISORY_LOCK_KEY_2 = 112234;

const MAX_LIST_LIMIT = 200;
const MAX_STORED_STRING = 500;

function storeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeParseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) || Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function boundedLimit(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isSafeInteger(n) || n < 1) return MAX_LIST_LIMIT;
  return Math.min(n, MAX_LIST_LIMIT);
}

function assertBounded(value, code, max = MAX_STORED_STRING) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw storeError(code);
  }
}

/** DB row -> manager record (camelCase, JSON columns parsed). */
function rowToRecord(row) {
  return {
    recordSeq: row.record_seq === undefined ? undefined : Number(row.record_seq),
    decisionNumber: Number(row.decision_number),
    action: row.action,
    authority: row.authority,
    directorId: row.director_id,
    category: row.category,
    reason: row.reason,
    outcome: row.outcome,
    reasonCode: row.reason_code ?? null,
    payload: safeParseJson(row.payload, {}),
    credentialRequest: safeParseJson(row.credential_request, null),
    supersedes: row.supersedes_decision_number === null || row.supersedes_decision_number === undefined
      ? null
      : Number(row.supersedes_decision_number),
    errorCode: row.error_code ?? null,
    detail: row.detail ?? null,
    createdAt: toIso(row.created_at),
  };
}

export class PostgresHermesDecisionStore {
  /**
   * @param {object|() => object} db the adapter (or lazy resolver) exposing
   *   query() and withTransaction()
   */
  constructor({ db } = {}) {
    if (typeof db === "function") {
      this.resolveDb = db;
    } else if (db && typeof db.query === "function") {
      this.resolveDb = () => db;
    } else {
      this.resolveDb = () => null;
    }
  }

  #requireDb() {
    const adapter = this.resolveDb();
    if (!adapter || typeof adapter.query !== "function") {
      throw storeError("STORAGE_NOT_CONFIGURED");
    }
    return adapter;
  }

  /**
   * Persist one immutable decision record. Validates the fields the DB
   * constraint enforces (defense in depth) and returns the stored record
   * (with recordSeq) in the manager's shape.
   */
  async append(record) {
    const db = this.#requireDb();
    if (!isPlainObject(record)) throw storeError("HERMES_RECORD_INVALID");
    if (!Number.isSafeInteger(record.decisionNumber) || record.decisionNumber <= 0) {
      throw storeError("HERMES_RECORD_INVALID");
    }
    assertBounded(record.action, "HERMES_RECORD_INVALID", 120);
    assertBounded(record.authority, "HERMES_RECORD_INVALID", 40);
    assertBounded(record.directorId, "HERMES_RECORD_INVALID", 80);
    assertBounded(record.category, "HERMES_RECORD_INVALID", 40);
    assertBounded(record.reason, "HERMES_RECORD_INVALID", 500);
    assertBounded(record.outcome, "HERMES_RECORD_INVALID", 40);

    const res = await db.query(
      `INSERT INTO hermes_decisions
         (decision_number, action, authority, director_id, category, reason,
          outcome, reason_code, payload, credential_request,
          supersedes_decision_number, error_code, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)
       RETURNING *`,
      [
        record.decisionNumber,
        record.action,
        record.authority,
        record.directorId,
        record.category,
        record.reason,
        record.outcome,
        record.reasonCode ?? null,
        JSON.stringify(isPlainObject(record.payload) ? record.payload : {}),
        record.credentialRequest ? JSON.stringify(record.credentialRequest) : null,
        record.supersedes ?? null,
        record.errorCode ?? null,
        record.detail ?? null,
        record.createdAt ?? new Date().toISOString(),
      ],
    );
    return rowToRecord(res.rows[0]);
  }

  /**
   * Newest-first history. filter: { decisionNumber } and/or { category }.
   */
  async list({ limit, filter } = {}) {
    const db = this.#requireDb();
    const clauses = [];
    const params = [];
    if (filter?.decisionNumber !== undefined) {
      if (!Number.isSafeInteger(filter.decisionNumber) || filter.decisionNumber <= 0) {
        throw storeError("DECISION_NUMBER_INVALID");
      }
      params.push(filter.decisionNumber);
      clauses.push(`decision_number = $${params.length}`);
    }
    if (filter?.category !== undefined) {
      assertBounded(filter.category, "DECISION_CATEGORY_INVALID", 40);
      params.push(filter.category);
      clauses.push(`category = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const safeLimit = boundedLimit(limit);
    const res = await db.query(
      `SELECT * FROM hermes_decisions${where} ORDER BY record_seq DESC LIMIT ${safeLimit}`,
      params,
    );
    return res.rows.map(rowToRecord);
  }

  /**
   * Monotonic decision numbering: advisory-locked max+1 inside a
   * transaction, so concurrent managers never allocate the same number on
   * PostgreSQL. The demo adapter treats the advisory lock as a no-op (its
   * single-process semantics are already serialized).
   */
  async nextDecisionNumber() {
    const db = this.#requireDb();
    const run = async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        ADVISORY_LOCK_KEY_1,
        ADVISORY_LOCK_KEY_2,
      ]);
      const res = await client.query(
        "SELECT decision_number FROM hermes_decisions ORDER BY decision_number DESC LIMIT 1",
      );
      const max = res.rows[0] ? Number(res.rows[0].decision_number) : 0;
      return max + 1;
    };
    if (typeof db.withTransaction === "function") {
      return db.withTransaction(run);
    }
    return run(db);
  }
}
