/**
 * ST Production House — Director-scoped character continuity contract
 * (S-M31-01, Module 31 — Director core generalization, offline portion).
 *
 * Pure, deterministic, offline module. It performs NO media generation, NO
 * provider calls, NO filesystem access, and NO clock reads. It exists so the
 * future Director runtimes have a truthful contract for durable character
 * state:
 *
 *   - A character record is scoped to exactly ONE registered Director (agent)
 *     id. Cross-Director access fails closed with a stable isolation code;
 *     there is no implicit sharing and no bypass path (Rule 5 / isolation).
 *   - Identity is anchored to the SHA-256 of the record's canonical content
 *     (recomputed — never trusted from input). Identical inputs produce
 *     byte-identical records; any mutation is detectable tampering.
 *   - State is versioned and append-oriented: revisions and canonical events
 *     produce NEW records that link to their predecessor; history is never
 *     silently rewritten.
 *   - Serialization is a strict allowlist (Rule 17): no secrets, no credential
 *     locators, and no internal agent names in free text (Rule 15). Fields
 *     outside the allowlist can never leak, even if a record is polluted.
 */

import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

export const CHARACTER_RECORD_TYPE = "character_continuity_record_v1";

export const MAX_RELATIONSHIPS = 12;
export const MAX_CANONICAL_EVENTS = 50;
export const MAX_CHARACTER_VERSION = 100000;

const AGENT_IDS = new Set(PRELOADED_AGENTS.map(({ id }) => id));
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,60}$/;
const RECORD_ID_RE = /^[0-9a-f]{64}$/;

/** Fields a revision may change. Scope and identity fields are immutable. */
const MUTABLE_FIELDS = Object.freeze([
  "appearance",
  "personality",
  "wardrobe",
  "environment",
  "timelinePosition",
  "voiceProfileRef",
  "relationships",
  "canonicalEvents",
]);

/** Strict serialization allowlist (Rule 17). Order is contract. */
const SERIALIZABLE_FIELDS = Object.freeze([
  "recordType",
  "id",
  "agentId",
  "characterKey",
  "displayName",
  "version",
  "previousVersionId",
  "appearance",
  "personality",
  "wardrobe",
  "environment",
  "timelinePosition",
  "voiceProfileRef",
  "relationships",
  "canonicalEvents",
]);

function characterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw characterError(code);
  }
}

function cleanText(value, code, max) {
  if (typeof value !== "string") throw characterError(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > max) throw characterError(code);
  if (SECRET_LIKE.test(normalized)) throw characterError("CHARACTER_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw characterError("CHARACTER_INTERNAL_NAME_REJECTED");
  return normalized;
}

/** Registered internal Director id (Rule 15: names are internal-only). */
function requireAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw characterError("CHARACTER_AGENT_INVALID");
  }
  return agentId;
}

function requireCharacterKey(characterKey) {
  if (typeof characterKey !== "string" || !ID_RE.test(characterKey)) {
    throw characterError("CHARACTER_KEY_INVALID");
  }
  if (SECRET_LIKE.test(characterKey)) throw characterError("CHARACTER_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(characterKey)) throw characterError("CHARACTER_INTERNAL_NAME_REJECTED");
  return characterKey;
}

function optionalText(value, code, max) {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, code, max);
}

/** Locator-free voice-profile reference (S-M32-01 profile id shape). */
function optionalVoiceProfileRef(value) {
  if (value === undefined || value === null) return null;
  requirePlainObject(value, "CHARACTER_VOICE_REF_INVALID");
  if (typeof value.profileId !== "string") throw characterError("CHARACTER_VOICE_REF_INVALID");
  // Secret detection takes precedence over shape so locators are never
  // misclassified as merely malformed ids (defense-in-depth ordering).
  if (SECRET_LIKE.test(value.profileId)) throw characterError("CHARACTER_SECRET_REJECTED");
  if (!ID_RE.test(value.profileId)) throw characterError("CHARACTER_VOICE_REF_INVALID");
  const ref = { profileId: value.profileId };
  if (value.note !== undefined && value.note !== null) {
    ref.note = cleanText(value.note, "CHARACTER_VOICE_REF_INVALID", 160);
  }
  return Object.freeze(ref);
}

function requireRelationships(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) {
    throw characterError("CHARACTER_RELATIONSHIP_LIMIT");
  }
  const seen = new Set();
  const relationships = value.map((entry) => {
    requirePlainObject(entry, "CHARACTER_RELATIONSHIP_INVALID");
    const target = requireCharacterKey(entry.target);
    const relation = cleanText(entry.relation, "CHARACTER_RELATIONSHIP_INVALID", 120);
    if (seen.has(target)) throw characterError("CHARACTER_RELATIONSHIP_DUPLICATE");
    seen.add(target);
    return Object.freeze({ target, relation });
  });
  return Object.freeze(relationships);
}

function requireCanonicalEvents(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_CANONICAL_EVENTS) {
    throw characterError("CHARACTER_EVENT_LIMIT");
  }
  const seen = new Set();
  const events = value.map((entry) => {
    requirePlainObject(entry, "CHARACTER_EVENT_INVALID");
    const eventKey = requireCharacterKey(entry.eventKey);
    const summary = cleanText(entry.summary, "CHARACTER_EVENT_INVALID", 300);
    if (seen.has(eventKey)) throw characterError("CHARACTER_EVENT_DUPLICATE");
    seen.add(eventKey);
    return Object.freeze({ eventKey, summary });
  });
  return Object.freeze(events);
}

function requireVersion(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CHARACTER_VERSION) {
    throw characterError("CHARACTER_VERSION_INVALID");
  }
  return value;
}

function buildRecord(input) {
  requirePlainObject(input, "CHARACTER_RECORD_INVALID");
  const record = {
    recordType: CHARACTER_RECORD_TYPE,
    id: null,
    agentId: requireAgentId(input.agentId),
    characterKey: requireCharacterKey(input.characterKey),
    displayName: cleanText(input.displayName, "CHARACTER_DISPLAY_NAME_INVALID", 80),
    version: input.version === undefined ? 1 : requireVersion(input.version),
    previousVersionId:
      input.previousVersionId === undefined || input.previousVersionId === null
        ? null
        : typeof input.previousVersionId === "string" && RECORD_ID_RE.test(input.previousVersionId)
          ? input.previousVersionId
          : (() => {
              throw characterError("CHARACTER_PREVIOUS_VERSION_INVALID");
            })(),
    appearance: optionalText(input.appearance, "CHARACTER_APPEARANCE_INVALID", 600),
    personality: optionalText(input.personality, "CHARACTER_PERSONALITY_INVALID", 600),
    wardrobe: optionalText(input.wardrobe, "CHARACTER_WARDROBE_INVALID", 300),
    environment: optionalText(input.environment, "CHARACTER_ENVIRONMENT_INVALID", 300),
    timelinePosition: optionalText(input.timelinePosition, "CHARACTER_TIMELINE_INVALID", 120),
    voiceProfileRef: optionalVoiceProfileRef(input.voiceProfileRef),
    relationships: requireRelationships(input.relationships),
    canonicalEvents: requireCanonicalEvents(input.canonicalEvents),
  };
  record.id = computeCharacterId(record);
  return deepFreeze(record);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Identity: recomputed content hash (never trusted from input)
// ---------------------------------------------------------------------------

/**
 * Deterministic record identity: SHA-256 over the canonical record content
 * excluding the id field itself. Identical inputs produce identical ids.
 */
export function computeCharacterId(record) {
  requirePlainObject(record, "CHARACTER_RECORD_INVALID");
  const { id: _ignored, ...content } = record;
  return stableId(content);
}

/**
 * Integrity gate: recompute the id and compare. Returns a truthful verdict —
 * it never repairs or re-stamps a mutated record.
 */
export function verifyCharacterIntegrity(record) {
  requirePlainObject(record, "CHARACTER_RECORD_INVALID");
  if (record.recordType !== CHARACTER_RECORD_TYPE) {
    return { intact: false, expectedId: null, reason: "CHARACTER_RECORD_TYPE_MISMATCH" };
  }
  const expectedId = computeCharacterId(record);
  if (record.id !== expectedId) {
    return { intact: false, expectedId, reason: "CHARACTER_ID_MISMATCH" };
  }
  return { intact: true, expectedId, reason: null };
}

/**
 * Tamper detection between two records: lists top-level fields whose values
 * differ (deterministic order = SERIALIZABLE_FIELDS order), plus "id" when
 * the candidate's recomputed identity no longer matches its stamped id.
 */
export function detectCharacterTampering(originalRecord, candidateRecord) {
  requirePlainObject(originalRecord, "CHARACTER_RECORD_INVALID");
  requirePlainObject(candidateRecord, "CHARACTER_RECORD_INVALID");
  const changed = [];
  for (const field of SERIALIZABLE_FIELDS) {
    // "id" is content-derived: it always differs for legitimately different
    // records, so it is reported only via the integrity gate below.
    if (field === "id") continue;
    if (JSON.stringify(originalRecord[field]) !== JSON.stringify(candidateRecord[field])) {
      changed.push(field);
    }
  }
  const integrity = verifyCharacterIntegrity(candidateRecord);
  if (!integrity.intact && !changed.includes("id")) {
    changed.push("id");
  }
  return Object.freeze(changed);
}

// ---------------------------------------------------------------------------
// Lifecycle: create → revise → append events (append-only, versioned)
// ---------------------------------------------------------------------------

/** Creates a v1 character record for exactly one registered Director. */
export function createCharacter(input) {
  return buildRecord(input);
}

/**
 * Produces the NEXT version of a character record. Only mutable creative
 * fields may change; scope and identity fields fail closed. The new record
 * links to its predecessor via previousVersionId — history is never rewritten.
 */
export function reviseCharacter(record, changes) {
  requirePlainObject(record, "CHARACTER_RECORD_INVALID");
  requirePlainObject(changes, "CHARACTER_REVISION_INVALID");
  const integrity = verifyCharacterIntegrity(record);
  if (!integrity.intact) throw characterError(integrity.reason);
  if (record.version >= MAX_CHARACTER_VERSION) {
    throw characterError("CHARACTER_VERSION_LIMIT");
  }
  for (const key of Object.keys(changes)) {
    if (!MUTABLE_FIELDS.includes(key)) {
      throw characterError("CHARACTER_FIELD_IMMUTABLE");
    }
  }
  return buildRecord({
    ...record,
    ...changes,
    version: record.version + 1,
    previousVersionId: record.id,
    id: undefined,
  });
}

/** Appends one canonical prior event as a new version (append-only). */
export function appendCanonicalEvent(record, event) {
  requirePlainObject(record, "CHARACTER_RECORD_INVALID");
  const events = requireCanonicalEvents([...record.canonicalEvents, event]);
  return reviseCharacter(record, { canonicalEvents: events });
}

/**
 * Cross-Director isolation gate. Two records from different Directors can
 * never be linked, compared into shared state, or merged — access DENYs.
 */
export function assertSameDirector(recordA, recordB) {
  requirePlainObject(recordA, "CHARACTER_RECORD_INVALID");
  requirePlainObject(recordB, "CHARACTER_RECORD_INVALID");
  if (recordA.agentId !== recordB.agentId) {
    throw characterError("CHARACTER_ISOLATION_VIOLATION");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Serialization: strict allowlist (Rule 17)
// ---------------------------------------------------------------------------

/**
 * Emits ONLY the allowlisted fields, in contract order, deep-frozen. Fields
 * outside the allowlist can never appear in serialized output, even if a
 * record object was polluted with extra keys after creation.
 */
export function serializeCharacter(record) {
  requirePlainObject(record, "CHARACTER_RECORD_INVALID");
  const output = {};
  for (const field of SERIALIZABLE_FIELDS) {
    output[field] = record[field] === undefined ? null : record[field];
  }
  return deepFreeze(output);
}
