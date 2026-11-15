/**
 * ST Production House — sanitized Director creative context (DCIIS wiring).
 *
 * ONE implementation of the allowlist, shared by the two boundaries that may
 * carry creative identity: the Hermes decision bridge and the stage execution
 * context. Neither boundary is allowed to build its own shape, so a field that
 * reaches a team is a field that passed this function.
 *
 * Rules it enforces:
 *   - the identity MUST belong to the Director being served (cross-Director is
 *     an error, never a silent substitution);
 *   - only allowlisted fields survive — the result is CONSTRUCTED from the
 *     allowlist, never filtered from the input, so credentials, prompts,
 *     affiliate data and provider names cannot ride along;
 *   - a field that is present but unusable (wrong type, empty, over-long) is an
 *     explicit error, because a Director with a 3000-character vision must not
 *     look like a Director with no vision;
 *   - the result is frozen.
 */

export const CREATIVE_CONTEXT_SNAPSHOT_KEYS = Object.freeze([
  "universeType",
  "narrator",
  "sourceCategories",
  "lazyHierarchy",
  "bibleSummary",
]);

export const CREATIVE_CONTEXT_MAX_STRING = 2000;
export const CREATIVE_CONTEXT_MAX_LIST = 20;

function invalid() {
  const error = new Error("DIRECTOR_IDENTITY_INVALID");
  error.code = "DIRECTOR_IDENTITY_INVALID";
  return error;
}

function mismatch() {
  const error = new Error("DIRECTOR_IDENTITY_MISMATCH");
  error.code = "DIRECTOR_IDENTITY_MISMATCH";
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireBoundedString(value) {
  if (typeof value !== "string") throw invalid();
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > CREATIVE_CONTEXT_MAX_STRING) throw invalid();
  return trimmed;
}

function requireBoundedList(value) {
  if (!Array.isArray(value) || value.length > CREATIVE_CONTEXT_MAX_LIST) throw invalid();
  return value.map((item) => requireBoundedString(item));
}

function requireBoundedMap(value) {
  if (!isPlainObject(value)) throw invalid();
  const keys = Object.keys(value);
  if (keys.length > CREATIVE_CONTEXT_MAX_LIST) throw invalid();
  const out = {};
  for (const key of keys) out[key] = requireBoundedString(value[key]);
  return out;
}

/**
 * Reduce a Director identity to the allowlisted, serializable creative context.
 *
 * @param {Object|null|undefined} identity
 * @param {string} expectedAgentId
 * @returns {null|Object} frozen allowlisted context, or null for no identity
 */
export function sanitizeDirectorCreativeContext(identity, expectedAgentId) {
  if (identity === null || identity === undefined) return null;
  if (!isPlainObject(identity)) throw invalid();
  if (identity.agentId !== expectedAgentId) throw mismatch();

  const snapshot = isPlainObject(identity.snapshot) ? identity.snapshot : {};
  const safeSnapshot = {};
  for (const key of CREATIVE_CONTEXT_SNAPSHOT_KEYS) {
    const value = snapshot[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      safeSnapshot[key] = requireBoundedString(value);
    } else if (Array.isArray(value)) {
      safeSnapshot[key] = requireBoundedList(value);
    } else {
      safeSnapshot[key] = requireBoundedMap(value);
    }
  }

  const context = { agentId: expectedAgentId };
  for (const field of ["charterId", "vision", "defaultLanguage", "secondaryLanguage"]) {
    if (identity[field] === undefined || identity[field] === null) continue;
    context[field] = requireBoundedString(identity[field]);
  }
  if (Object.keys(safeSnapshot).length > 0) context.snapshot = safeSnapshot;

  return Object.freeze(context);
}

export default sanitizeDirectorCreativeContext;
