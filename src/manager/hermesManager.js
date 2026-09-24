/**
 * ST Production House — Hermes manager (decision layer).
 *
 * Issue #166. Hermes = the ST MANAGER: it decides WHAT happens next and
 * WHERE work runs, then records every decision as an immutable, auditable
 * record. It holds decision authority — NOT secret access:
 *
 *   - Hermes addresses credentials by REFERENCE
 *     ("agent-01 / gemini / production"). The credential broker resolves
 *     the reference and hands the credential directly to the authorized
 *     adapter. Secret values never enter this layer (Rules 4/5/17): the
 *     payload gate REJECTS secret-shaped fields before a record is created.
 *
 *   - Every decision is classified through the frozen authority matrix
 *     (src/manager/authorityMatrix.js). Unknown actions fail closed;
 *     prohibited actions are structurally refused even with an approval;
 *     owner-policy actions require an unexpired owner approval reference.
 *
 *   - Outcomes are HONEST (Rule 1): a decision becomes EXECUTED only when
 *     the ST evidence ledger confirms the receipt. Anything else stays
 *     EXECUTING, FAILED, or BLOCKED — never "probably done".
 *
 *   - Decision records are internal audit artifacts, APPEND-ONLY: the store
 *     has no update path. A completion SUPERSEDES the original record with
 *     the same decisionNumber (the newest record for a decisionNumber is
 *     its current state). Records serialize ONLY through the safe DTO
 *     allowlist (Rules 15/17). No job-lifecycle states are touched (R5):
 *     decision outcomes are a separate, closed record-level enum.
 */

import {
  classifyHermesAction,
  canHermesExecute,
  AUTHORITY_AUTONOMOUS,
  AUTHORITY_OWNER_POLICY,
  AUTHORITY_PROHIBITED,
} from "./authorityMatrix.js";

/** Closed decision outcomes (record-level enum, R5: no job states touched). */
export const HERMES_DECISION_OUTCOMES = Object.freeze([
  "EXECUTING",
  "EXECUTED",
  "FAILED",
  "BLOCKED",
  "OWNER_APPROVAL_REQUIRED",
]);

/** Closed decision categories for audit grouping. */
export const HERMES_DECISION_CATEGORIES = Object.freeze([
  "production",
  "scheduling",
  "providers",
  "resources",
  "publishing",
  "security_refusal",
]);

/**
 * Secret-shaped field names that may NEVER enter a decision payload
 * (defense in depth on top of the DTO allowlist). Fields with these names
 * are rejected outright — Hermes has no use for them and must never hold
 * them (the credential broker, not Hermes, moves secret material).
 */
const SECRET_FIELD_BLOCKLIST = Object.freeze([
  "apikey", "api_key", "secret", "password", "passwd", "token",
  "accesstoken", "access_token", "refreshtoken", "refresh_token",
  "clientsecret", "client_secret", "authorization", "bearer", "cookie",
  "privatekey", "private_key", "sessionid", "session_id", "credential",
]);

/** Values that look like live secret material, whatever the field name. */
const SECRET_VALUE_PATTERNS = Object.freeze([
  /^AIza[0-9A-Za-z_-]{20,}/,
  /^sk-[A-Za-z0-9_-]{8,}/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^Bearer\s+[A-Za-z0-9._-]{8,}/i,
  /^xox[baprs]-/,
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Recursively validate a decision payload: keys must be safe identifiers,
 * values must be bounded strings/numbers/booleans/plain objects/arrays.
 * Secret-shaped keys or secret-shaped string values are rejected outright
 * (fail closed) — Hermes records intent, never material.
 */
export function assertDecisionPayloadSafe(payload, depth = 0, key = "payload") {
  if (depth > 6) throw fail("PAYLOAD_TOO_DEEP");
  // The ROOT must be structured intent (object/array) — never a bare scalar.
  if (depth === 0 && !isPlainObject(payload) && !Array.isArray(payload)) {
    throw fail("PAYLOAD_TYPE_INVALID");
  }
  if (payload === null || payload === undefined) return;
  // Key gate runs for EVERY nested field, leaves included — a field named
  // "token" or "api_key" is refused no matter what its value is.
  if (depth > 0 && typeof key === "string") {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (SECRET_FIELD_BLOCKLIST.includes(normalized)) throw fail("SECRET_FIELD_REJECTED");
  }
  const type = typeof payload;
  if (type === "string") {
    if (payload.length > 500) throw fail("PAYLOAD_VALUE_TOO_LONG");
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(payload)) throw fail("SECRET_VALUE_REJECTED");
    }
    return;
  }
  if (type === "number" && Number.isFinite(payload)) return;
  if (type === "boolean") return;
  if (!isPlainObject(payload) && !Array.isArray(payload)) throw fail("PAYLOAD_TYPE_INVALID");
  if (Array.isArray(payload) && payload.length > 50) throw fail("PAYLOAD_TOO_LARGE");
  if (isPlainObject(payload) && Object.keys(payload).length > 30) throw fail("PAYLOAD_TOO_LARGE");
  const entries = Array.isArray(payload)
    ? payload.map((value) => [null, value])
    : Object.entries(payload);
  for (const [entryKey, value] of entries) {
    assertDecisionPayloadSafe(value, depth + 1, entryKey ?? "item");
  }
}

/**
 * Create a Hermes manager over an injected append-only decision store.
 *
 * Store contract (injected — this module performs NO I/O of its own):
 *   append(record)                     -> record (persist one immutable row)
 *   list({ limit, filter })            -> records, newest first, optional
 *                                         filter { decisionNumber } |
 *                                         { category }
 *
 * `nextDecisionNumber` is injected so numbering is monotonic and
 * environment-specific (no hidden clock/counter in this module).
 */
export class HermesManager {
  constructor(store, { nextDecisionNumber } = {}) {
    if (!store || typeof store.append !== "function" || typeof store.list !== "function") {
      throw fail("HERMES_STORE_REQUIRED");
    }
    if (typeof nextDecisionNumber !== "function") {
      throw fail("HERMES_NUMBERING_REQUIRED");
    }
    this.store = store;
    this.nextDecisionNumber = nextDecisionNumber;
  }

  /**
   * Record one decision. Flow: payload gate → authority matrix → outcome.
   *
   *   input = {
   *     action:            matrix key, e.g. "production.start"
   *     directorId:        target director/agent id (internal identifier)
   *     category:          one of HERMES_DECISION_CATEGORIES
   *     reason:            why this decision (bounded string)
   *     payload:           secret-free structured intent
   *     credentialRequest: OPTIONAL reference, e.g.
   *                        { agentId, providerKey, scope: "production" } —
   *                        a REQUEST only; the broker supplies credentials
   *                        to the adapter, never to Hermes.
   *     ownerApproval:     required for OWNER_POLICY_CONTROLLED actions
   *   }
   *
   * Returns the created record. BLOCKED records are still recorded —
   * refusals are audit evidence too.
   */
  async decide(input, { now = new Date() } = {}) {
    if (!isPlainObject(input)) throw fail("DECISION_INPUT_REQUIRED");
    const { action, directorId, category, reason, payload, credentialRequest, ownerApproval } = input;

    const classification = classifyHermesAction(action);
    if (payload !== undefined && !isPlainObject(payload)) throw fail("PAYLOAD_TYPE_INVALID");
    assertDecisionPayloadSafe(payload ?? {});
    if (credentialRequest !== undefined) {
      if (!isPlainObject(credentialRequest)) throw fail("CREDENTIAL_REQUEST_INVALID");
      assertDecisionPayloadSafe(credentialRequest, 1, "credentialRequest");
      for (const field of ["agentId", "providerKey"]) {
        if (typeof credentialRequest[field] !== "string" || credentialRequest[field].length === 0) {
          throw fail("CREDENTIAL_REQUEST_INVALID");
        }
      }
    }
    if (typeof directorId !== "string" || directorId.length === 0 || directorId.length > 80) {
      throw fail("DIRECTOR_ID_INVALID");
    }
    if (!HERMES_DECISION_CATEGORIES.includes(category)) throw fail("DECISION_CATEGORY_INVALID");
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) {
      throw fail("DECISION_REASON_REQUIRED");
    }

    const decisionNumber = await this.nextDecisionNumber();
    const base = {
      decisionNumber,
      action,
      authority: classification.authority,
      directorId,
      category,
      reason,
      payload: payload ?? {},
      credentialRequest: credentialRequest ?? null,
      createdAt: now.toISOString(),
    };

    if (classification.authority === AUTHORITY_PROHIBITED) {
      return this.#appendOutcome(base, "BLOCKED", classification.reason);
    }
    if (classification.authority === AUTHORITY_OWNER_POLICY &&
        !canHermesExecute(classification, ownerApproval, { now })) {
      return this.#appendOutcome(base, "OWNER_APPROVAL_REQUIRED", classification.reason);
    }
    return this.#appendOutcome(base, "EXECUTING", classification.reason);
  }

  /**
   * Complete a decision HONESTLY. Appends a superseding record (append-only
   * store — no updates). Only a verified evidence receipt moves a decision
   * to EXECUTED (Rule 1): fetchEvidence(receiptId) must return
   * { found: true }. Everything else lands as FAILED with a truthful
   * reasonCode; nothing is silently dropped or upgraded.
   */
  async completeDecision(decisionNumber, { succeeded, evidenceReceiptId, errorCode, detail, fetchEvidence } = {}) {
    if (!Number.isSafeInteger(decisionNumber) || decisionNumber <= 0) {
      throw fail("DECISION_NUMBER_INVALID");
    }
    if (typeof succeeded !== "boolean") throw fail("DECISION_RESULT_REQUIRED");

    const records = await this.store.list({ limit: 1, filter: { decisionNumber } });
    const record = records[0];
    if (!record) throw fail("DECISION_NOT_FOUND");
    if (record.outcome !== "EXECUTING") throw fail("DECISION_NOT_EXECUTING");

    let verified = false;
    if (succeeded) {
      if (typeof evidenceReceiptId !== "string" || evidenceReceiptId.length === 0) {
        throw fail("EVIDENCE_RECEIPT_REQUIRED");
      }
      if (typeof fetchEvidence !== "function") throw fail("EVIDENCE_LOOKUP_REQUIRED");
      const ledgerRecord = await fetchEvidence(evidenceReceiptId);
      verified = Boolean(ledgerRecord && ledgerRecord.found === true);
    }

    return this.#appendOutcome(
      record,
      succeeded && verified ? "EXECUTED" : "FAILED",
      verified ? "EVIDENCE_VERIFIED" : (succeeded ? "EVIDENCE_UNVERIFIED" : "EXECUTION_FAILED"),
      { errorCode, detail },
    );
  }

  /** Decision history, newest first, through the safe DTO. */
  async listDecisions({ limit = 50, category } = {}) {
    const bounded = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 200);
    const records = await this.store.list({
      limit: bounded,
      filter: category ? { category } : undefined,
    });
    return records.map(hermesDecisionDto);
  }

  /** Read-model summary for the dashboard: counts by outcome/category. */
  async overview() {
    const records = await this.store.list({ limit: 200 });
    const byOutcome = {};
    const byCategory = {};
    for (const record of records) {
      byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
      byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
    }
    return {
      decisions: Object.fromEntries(Object.entries(byOutcome).sort(([a], [b]) => a.localeCompare(b))),
      byCategory: Object.fromEntries(Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))),
      blockedRefusals: byOutcome.BLOCKED ?? 0,
      pendingOwnerApproval: byOutcome.OWNER_APPROVAL_REQUIRED ?? 0,
      lastDecisionNumber: records[0]?.decisionNumber ?? 0,
    };
  }

  async #appendOutcome(base, outcome, reasonCode, extras = {}) {
    const record = Object.freeze({
      decisionNumber: base.decisionNumber,
      action: base.action,
      authority: base.authority,
      directorId: base.directorId,
      category: base.category,
      reason: base.reason,
      payload: base.payload,
      credentialRequest: base.credentialRequest ?? null,
      createdAt: base.createdAt,
      outcome,
      reasonCode,
      errorCode: extras.errorCode ?? null,
      detail: extras.detail ?? null,
      supersedes: base.outcome !== undefined ? base.decisionNumber : null,
    });
    const stored = await this.store.append(record);
    return hermesDecisionDto(stored ?? record);
  }
}

/**
 * Safe DTO (Rules 15/17): explicit allowlist. Credential request references
 * serialize; secret-shaped values were already rejected at the gate.
 */
export function hermesDecisionDto(record) {
  return {
    decisionNumber: record.decisionNumber,
    action: record.action,
    authority: record.authority,
    directorId: record.directorId,
    category: record.category,
    reason: record.reason,
    outcome: record.outcome,
    reasonCode: record.reasonCode,
    payload: record.payload,
    credentialRequest: record.credentialRequest
      ? {
          agentId: record.credentialRequest.agentId,
          providerKey: record.credentialRequest.providerKey,
          scope: record.credentialRequest.scope ?? null,
        }
      : null,
    errorCode: record.errorCode ?? null,
    detail: record.detail ?? null,
    createdAt: record.createdAt,
  };
}

/**
 * In-memory append-only decision store (demo/test transport). Production
 * deployments back the same contract with a PostgreSQL table — the manager
 * never knows the difference. newest-first listing; optional filtering.
 */
export class InMemoryHermesDecisionStore {
  #records = [];

  async append(record) {
    this.#records.push(record);
    return record;
  }

  async list({ limit = 50, filter } = {}) {
    let rows = [...this.#records].reverse();
    if (filter?.decisionNumber !== undefined) {
      rows = rows.filter((r) => r.decisionNumber === filter.decisionNumber);
    }
    if (filter?.category !== undefined) {
      rows = rows.filter((r) => r.category === filter.category);
    }
    return rows.slice(0, Math.max(0, limit));
  }

  get size() {
    return this.#records.length;
  }
}
