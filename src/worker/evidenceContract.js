/**
 * ST Production House — real evidence contract (Day 6).
 *
 * A stage is complete only when its handler produced a verifiable output AND the
 * evidence describing that output passes these checks. This module is pure: no
 * database, no network, no provider. It gives the worker runtime, the repository,
 * the API and the tests one definition of "evidence".
 *
 * Honesty rules enforced here (engineering contract rules 1–3):
 *   - a verification level is one of a fixed vocabulary;
 *   - `test_fixture` evidence can never carry PROVIDER_VERIFIED or
 *     PRODUCTION_VERIFIED;
 *   - a hash is a SHA-256 of real bytes, 64 lowercase hex characters;
 *   - metadata-only output says so, and never implies a media file exists;
 *   - secret-shaped values are refused rather than persisted.
 */

import { createHash } from "node:crypto";

export const VERIFICATION_LEVEL = Object.freeze({
  IMPLEMENTED: "IMPLEMENTED",
  UNIT_TESTED: "UNIT_TESTED",
  INTEGRATION_TESTED: "INTEGRATION_TESTED",
  CI_VERIFIED: "CI_VERIFIED",
  PROVIDER_VERIFIED: "PROVIDER_VERIFIED",
  PRODUCTION_VERIFIED: "PRODUCTION_VERIFIED",
  BLOCKED: "BLOCKED",
  NOT_RUN: "NOT_RUN",
});

export const VERIFICATION_LEVELS = Object.freeze(Object.values(VERIFICATION_LEVEL));

/** Levels that assert real provider/platform/production activity. */
export const PRODUCTION_ASSERTING_LEVELS = Object.freeze([
  VERIFICATION_LEVEL.PROVIDER_VERIFIED,
  VERIFICATION_LEVEL.PRODUCTION_VERIFIED,
]);

export const EVIDENCE_ENVIRONMENT = Object.freeze({
  PRODUCTION: "PRODUCTION",
  STAGING: "STAGING",
  TEST: "TEST",
});

export const EVIDENCE_ENVIRONMENTS = Object.freeze(Object.values(EVIDENCE_ENVIRONMENT));

export const EVIDENCE_ERROR = Object.freeze({
  EVIDENCE_INVALID: "TASK_EVIDENCE_INVALID",
  EVIDENCE_HASH_INVALID: "TASK_EVIDENCE_HASH_INVALID",
  EVIDENCE_VERIFICATION_INVALID: "TASK_EVIDENCE_VERIFICATION_INVALID",
  EVIDENCE_FIXTURE_ASSERTION: "TASK_EVIDENCE_FIXTURE_ASSERTION",
  SECRET_MATERIAL_REJECTED: "SECRET_MATERIAL_REJECTED",
  STAGE_OUTPUT_INVALID: "STAGE_OUTPUT_INVALID",
});

const HASH = /^[a-f0-9]{64}$/;

/**
 * Failure classification. The worker runtime maps a handler error to one of these
 * classes; retry and provider-cooldown behaviour follow from the class, never
 * from a call site's whim.
 */
export const FAILURE_CLASS = Object.freeze({
  TRANSIENT: "TRANSIENT",
  PERMANENT: "PERMANENT",
  PROVIDER: "PROVIDER",
});

export const STAGE_ERROR = Object.freeze({
  UNSUPPORTED_STAGE: "UNSUPPORTED_STAGE",
  DEPENDENCY_NOT_SATISFIED: "DEPENDENCY_NOT_SATISFIED",
  REQUIRED_EVIDENCE_MISSING: "REQUIRED_EVIDENCE_MISSING",
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  PROVIDER_QUOTA_EXHAUSTED: "PROVIDER_QUOTA_EXHAUSTED",
  OWNER_APPROVAL_REQUIRED: "OWNER_APPROVAL_REQUIRED",
  STAGE_INPUT_INVALID: "STAGE_INPUT_INVALID",
  STAGE_OUTPUT_INVALID: "STAGE_OUTPUT_INVALID",
  STAGE_EXECUTION_FAILED: "STAGE_EXECUTION_FAILED",
  STAGE_TIMEOUT: "STAGE_TIMEOUT",
  LEASE_LOST: "LEASE_LOST",
  TASK_CANCELLED: "TASK_CANCELLED",
  SECRET_MATERIAL_REJECTED: "SECRET_MATERIAL_REJECTED",
});

export class StageError extends Error {
  constructor(code, message = null, detail = null) {
    super(message ?? code);
    this.name = "StageError";
    this.code = code;
    this.detail = detail;
  }
}

/** Transient infrastructure faults that justify a bounded retry. */
const TRANSIENT_CODES = Object.freeze([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "57P01", // admin shutdown
  "08006", // connection failure
  "53300", // too many connections
  STAGE_ERROR.STAGE_TIMEOUT,
]);

/** Provider conditions that are blocked, not retried against a live quota. */
const PROVIDER_CODES = Object.freeze([
  STAGE_ERROR.PROVIDER_NOT_CONFIGURED,
  STAGE_ERROR.PROVIDER_QUOTA_EXHAUSTED,
]);

/**
 * Classify a stage failure.
 * A provider-quota condition is blocked without consuming an attempt; a
 * permanent validation failure is terminal on the first occurrence.
 */
export function classifyFailure(code, { retryable = null } = {}) {
  const value = String(code ?? "");
  if (PROVIDER_CODES.includes(value)) {
    return {
      failureClass: FAILURE_CLASS.PROVIDER,
      retryable: false,
      consumeAttempt: false,
      providerState: value === STAGE_ERROR.PROVIDER_QUOTA_EXHAUSTED ? "QUOTA_EXHAUSTED" : "UNAVAILABLE",
    };
  }
  if (retryable === true) {
    return { failureClass: FAILURE_CLASS.TRANSIENT, retryable: true, consumeAttempt: true, providerState: null };
  }
  if (TRANSIENT_CODES.includes(value)) {
    return { failureClass: FAILURE_CLASS.TRANSIENT, retryable: true, consumeAttempt: true, providerState: null };
  }
  return { failureClass: FAILURE_CLASS.PERMANENT, retryable: false, consumeAttempt: true, providerState: null };
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isArtifactHash(value) {
  return typeof value === "string" && HASH.test(value);
}

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|passwd|password|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|bearer|client[_-]?secret|credential)/i;
const SECRET_VALUE_PATTERN = /(?:api[_-]?key|secret|password|token|bearer)\s*[:=]\s*\S{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9]{16,}/i;
const OPAQUE_LOCATOR = /^vault:\/\/[A-Za-z0-9._~\-/]{3,200}$/;

/**
 * Reject secret-shaped material anywhere in a stage input or an evidence payload.
 * An opaque `vault://` locator is allowed because it is a reference, not a value
 * (engineering contract rules 4 and 17).
 */
export function findSecretMaterial(value, path = "$") {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (OPAQUE_LOCATOR.test(value)) return null;
    return SECRET_VALUE_PATTERN.test(value) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecretMaterial(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) return `${path}.${key}`;
      const found = findSecretMaterial(child, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

export function assertNoSecretMaterial(value, { label = "value" } = {}) {
  const found = findSecretMaterial(value);
  if (found) {
    throw new StageError(
      STAGE_ERROR.SECRET_MATERIAL_REJECTED,
      `Refusing ${label}: secret-shaped material at ${found}. Use an opaque vault:// reference instead.`
    );
  }
  return true;
}

/**
 * Validate one evidence entry before it is persisted.
 * Returns `{ ok, errors }`; the caller decides whether to throw.
 */
export function validateEvidenceEntry(entry, { requiredHash = false } = {}) {
  const errors = [];
  if (!entry || typeof entry !== "object") {
    return { ok: false, errors: ["evidence entry must be an object"] };
  }
  if (typeof entry.evidenceType !== "string" || entry.evidenceType.length === 0 || entry.evidenceType.length > 80) {
    errors.push("evidenceType must be 1–80 characters");
  }
  const level = entry.verificationLevel ?? VERIFICATION_LEVEL.IMPLEMENTED;
  if (!VERIFICATION_LEVELS.includes(level)) errors.push(`unknown verificationLevel ${level}`);
  const environment = entry.environment ?? EVIDENCE_ENVIRONMENT.PRODUCTION;
  if (!EVIDENCE_ENVIRONMENTS.includes(environment)) errors.push(`unknown environment ${environment}`);
  if (entry.artifactHash !== null && entry.artifactHash !== undefined && !isArtifactHash(String(entry.artifactHash))) {
    errors.push("artifactHash must be 64 lowercase hex characters");
  }
  if (requiredHash && !isArtifactHash(String(entry.artifactHash ?? ""))) {
    errors.push("this stage requires a verified artifact hash");
  }
  if (entry.testFixture === true && PRODUCTION_ASSERTING_LEVELS.includes(level)) {
    errors.push("test-fixture evidence cannot claim PROVIDER_VERIFIED or PRODUCTION_VERIFIED");
  }
  if (!entry.handlerName || typeof entry.handlerName !== "string") errors.push("handlerName is required");
  if (!entry.handlerVersion || typeof entry.handlerVersion !== "string") errors.push("handlerVersion is required");
  if (entry.startedAt && entry.completedAt && new Date(entry.completedAt) < new Date(entry.startedAt)) {
    errors.push("completedAt cannot precede startedAt");
  }
  if (findSecretMaterial(entry.payload ?? {})) errors.push("evidence payload contains secret-shaped material");
  if (findSecretMaterial(entry.inputRefs ?? [])) errors.push("input references contain secret-shaped material");
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a handler result as a whole: a real output reference plus evidence that
 * passes the contract. A handler that returns HTTP 200 or an empty object is not
 * a completed stage.
 */
export function validateStageOutput({ resultRef, evidence, requiredHash = false }) {
  const errors = [];
  if (typeof resultRef !== "string" || resultRef.trim().length === 0 || resultRef.length > 300) {
    errors.push("resultRef must be 1–300 characters");
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    errors.push("at least one evidence entry is required");
    return { ok: false, errors };
  }
  for (const entry of evidence) {
    const check = validateEvidenceEntry(entry, { requiredHash });
    if (!check.ok) errors.push(...check.errors);
  }
  return { ok: errors.length === 0, errors };
}

/** Stable JSON so a manifest hash can be recomputed byte-for-byte. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
