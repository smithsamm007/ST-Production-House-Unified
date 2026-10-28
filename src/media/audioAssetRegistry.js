/**
 * ST Production House — Rights-aware BGM/SFX audio-asset registry contract
 * (S-M36-01, Module 36 — media pipeline, offline contract layer).
 *
 * Pure, deterministic, offline module. It performs NO audio generation, NO
 * provider calls, NO filesystem access, and NO clock reads. It stores NO file
 * payloads — bundled third-party media is structurally prohibited (the
 * registry accepts provenance DECLARATIONS only, so a payload cannot even be
 * expressed). It exists so assembly workers (S-M33-01 audio-mix plans) can
 * select BGM/SFX/ambient assets truthfully:
 *
 *   - Every asset declares provider/source provenance and an explicit license
 *     state from a bounded enum. Only states that assert DOCUMENTED rights
 *     (`license_documented_*`) are selectable; `undocumented`, `unknown`, and
 *     `prohibited` can never enter an audio mix (fail-closed selection).
 *   - Assets are Director-scoped: selection binds one registered agent id and
 *     fails closed on cross-Director use.
 *   - Selections are deterministic records with recomputed SHA-256 ids and
 *     tamper detection; serialization is a strict allowlist (Rule 17);
 *     secrets and internal agent names are rejected everywhere (Rules 15/17).
 *   - A license assertion in this registry is a DECLARATION recorded for
 *     governance review — it is not a legal determination (AGENTS.md Rule 12:
 *     bundled third-party media stays prohibited until rights are documented).
 */

import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

export const AUDIO_ASSET_TYPE = "audio_asset_declaration_v1";
export const AUDIO_SELECTION_TYPE = "audio_asset_selection_v1";

/**
 * Bounded license-state enum. Only `license_documented_*` states carry
 * documented rights and are selectable; everything else fails closed at
 * selection time.
 */
export const AUDIO_LICENSE_STATES = Object.freeze([
  "license_documented_commercial",
  "license_documented_cc0",
  "license_documented_cc_by_attribution",
  "license_documented_public_domain",
  "license_documented_owner_owned",
  "undocumented",
  "unknown",
  "prohibited",
]);

/** States asserting documented rights — the ONLY production-safe states. */
export const SELECTABLE_LICENSE_STATES = Object.freeze(
  AUDIO_LICENSE_STATES.filter((state) => state.startsWith("license_documented_")),
);

/** Assembly audio-mix roles (mirrors the S-M33-01 AUDIO_ROLES vocabulary). */
export const AUDIO_MIX_ROLES = Object.freeze(["voice", "bgm", "sfx"]);

export const AUDIO_ASSET_KINDS = Object.freeze([
  "bgm",
  "ambient",
  "sfx",
  "transition_sting",
]);

const AGENT_IDS = new Set(PRELOADED_AGENTS.map(({ id }) => id));
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,60}$/;
const ARTIFACT_REF_RE = /^sha256:[0-9a-f]{64}$/;

const MAX_LICENSE_NOTE = 300;

function audioError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw audioError(code);
  }
}

function cleanText(value, code, max) {
  if (typeof value !== "string") throw audioError(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > max) throw audioError(code);
  if (SECRET_LIKE.test(normalized)) throw audioError("AUDIO_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw audioError("AUDIO_INTERNAL_NAME_REJECTED");
  return normalized;
}

/** Registered internal Director id (Rule 15: names are internal-only). */
function requireAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw audioError("AUDIO_AGENT_INVALID");
  }
  return agentId;
}

function requireProviderId(providerId) {
  if (typeof providerId !== "string" || !ID_RE.test(providerId)) {
    throw audioError("AUDIO_PROVIDER_INVALID");
  }
  if (SECRET_LIKE.test(providerId)) throw audioError("AUDIO_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(providerId)) throw audioError("AUDIO_INTERNAL_NAME_REJECTED");
  return providerId;
}

function requireLicenseState(state) {
  if (typeof state !== "string" || !AUDIO_LICENSE_STATES.includes(state)) {
    throw audioError("AUDIO_LICENSE_STATE_INVALID");
  }
  return state;
}

function requireOptionalArtifactRef(value, code) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ARTIFACT_REF_RE.test(value)) {
    throw audioError(code);
  }
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Asset declaration (provenance + rights metadata — never file payloads)
// ---------------------------------------------------------------------------

/**
 * Declares one audio asset: what it is, where it came from, and what its
 * documented rights state is. The registry accepts METADATA ONLY — there is
 * no field that can carry a media payload, a file path, or a URL, so bundled
 * third-party media cannot be smuggled through this contract.
 */
export function declareAudioAsset(input = {}) {
  requirePlainObject(input, "AUDIO_ASSET_INVALID");
  const allowed = ["agentId", "assetKey", "kind", "sourceProviderId", "sourceDescription", "licenseState", "licenseNote", "descriptiveTags"];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw audioError("AUDIO_ASSET_FIELD_UNKNOWN");
    }
  }
  const asset = {
    assetType: AUDIO_ASSET_TYPE,
    agentId: requireAgentId(input.agentId),
    assetKey: cleanText(input.assetKey, "AUDIO_ASSET_KEY_INVALID", 80),
    kind: (() => {
      if (typeof input.kind !== "string" || !AUDIO_ASSET_KINDS.includes(input.kind)) {
        throw audioError("AUDIO_ASSET_KIND_INVALID");
      }
      return input.kind;
    })(),
    sourceProviderId: requireProviderId(input.sourceProviderId),
    sourceDescription: cleanText(input.sourceDescription, "AUDIO_SOURCE_INVALID", 300),
    licenseState: requireLicenseState(input.licenseState),
    licenseNote:
      input.licenseNote === undefined || input.licenseNote === null
        ? null
        : cleanText(input.licenseNote, "AUDIO_LICENSE_NOTE_INVALID", MAX_LICENSE_NOTE),
    descriptiveTags:
      input.descriptiveTags === undefined || input.descriptiveTags === null
        ? Object.freeze([])
        : Object.freeze(
            input.descriptiveTags.slice(0, 10).map((tag) => cleanText(tag, "AUDIO_TAG_INVALID", 40)),
          ),
  };
  if (input.descriptiveTags !== undefined && input.descriptiveTags !== null && input.descriptiveTags.length > 10) {
    throw audioError("AUDIO_TAG_INVALID");
  }
  asset.assetId = computeAudioAssetId(asset);
  return deepFreeze(asset);
}

/** Recomputes the asset id over its identity content (tamper detection). */
export function computeAudioAssetId(asset) {
  const { assetType, agentId, assetKey, kind, sourceProviderId, sourceDescription, licenseState, licenseNote, descriptiveTags } = asset ?? {};
  return stableId({ assetType, agentId, assetKey, kind, sourceProviderId, sourceDescription, licenseState, licenseNote, descriptiveTags });
}

/** Truthful verdict; never repairs or re-stamps a mutated declaration. */
export function verifyAudioAsset(asset) {
  if (typeof asset !== "object" || asset === null || Array.isArray(asset)) {
    return { ok: false, reasonCode: "AUDIO_ASSET_MALFORMED" };
  }
  if (asset.assetType !== AUDIO_ASSET_TYPE) {
    return { ok: false, reasonCode: "AUDIO_ASSET_MALFORMED" };
  }
  if (asset.assetId !== computeAudioAssetId(asset)) {
    return { ok: false, reasonCode: "AUDIO_ASSET_TAMPERED" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Selection into assembly audio mixes (fail-closed rights + scope gating)
// ---------------------------------------------------------------------------

/**
 * Selects an asset into one assembly audio-mix role for one Director run.
 * Fails closed when:
 *   - the declaration is tampered or malformed (`AUDIO_ASSET_TAMPERED` etc.);
 *   - the license state does not assert documented rights
 *     (`AUDIO_LICENSE_NOT_DOCUMENTED` — the core rights gate);
 *   - the selecting Director differs from the asset's owner Director
 *     (`AUDIO_SCOPE_MISMATCH` — no cross-Director asset use).
 * The optional `renderedArtifactRef` binds the selection to the artifact
 * descriptor identity of the audio actually rendered for the mix.
 */
export function selectAudioAsset(input = {}) {
  requirePlainObject(input, "AUDIO_SELECTION_INVALID");
  const asset = input.asset;
  const verdict = verifyAudioAsset(asset);
  if (!verdict.ok) throw audioError(verdict.reasonCode);
  const agentId = requireAgentId(input.agentId);
  if (asset.agentId !== agentId) {
    throw audioError("AUDIO_SCOPE_MISMATCH");
  }
  if (!SELECTABLE_LICENSE_STATES.includes(asset.licenseState)) {
    throw audioError("AUDIO_LICENSE_NOT_DOCUMENTED");
  }
  const role = (() => {
    if (typeof input.role !== "string" || !AUDIO_MIX_ROLES.includes(input.role)) {
      throw audioError("AUDIO_ROLE_INVALID");
    }
    return input.role;
  })();
  const selection = {
    selectionType: AUDIO_SELECTION_TYPE,
    agentId,
    assetId: asset.assetId,
    role,
    productionRunId: cleanText(input.productionRunId, "AUDIO_RUN_INVALID", 80),
    renderedArtifactRef: requireOptionalArtifactRef(input.renderedArtifactRef, "AUDIO_ARTIFACT_REF_INVALID"),
  };
  selection.selectionId = computeAudioSelectionId(selection);
  return Object.freeze(selection);
}

/** Recomputes the selection id over its identity content. */
export function computeAudioSelectionId(selection) {
  const { selectionType, agentId, assetId, role, productionRunId, renderedArtifactRef } = selection ?? {};
  return stableId({ selectionType, agentId, assetId, role, productionRunId, renderedArtifactRef });
}

/** Truthful verdict; never repairs a mutated selection. */
export function verifyAudioSelection(selection) {
  if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
    return { ok: false, reasonCode: "AUDIO_SELECTION_MALFORMED" };
  }
  if (selection.selectionType !== AUDIO_SELECTION_TYPE) {
    return { ok: false, reasonCode: "AUDIO_SELECTION_MALFORMED" };
  }
  if (selection.selectionId !== computeAudioSelectionId(selection)) {
    return { ok: false, reasonCode: "AUDIO_SELECTION_TAMPERED" };
  }
  return { ok: true };
}

/**
 * Tamper detection between two declarations or two selections (fingerprint
 * comparison over recomputed ids).
 */
export function detectAudioTampering(original, candidate) {
  const isSelection = original?.selectionType === AUDIO_SELECTION_TYPE;
  const a = isSelection ? computeAudioSelectionId(original) : computeAudioAssetId(original);
  const b = isSelection ? computeAudioSelectionId(candidate) : computeAudioAssetId(candidate);
  return { tampered: a !== b, originalFingerprint: a, candidateFingerprint: b };
}

// ---------------------------------------------------------------------------
// Serialization: strict allowlist (Rule 17)
// ---------------------------------------------------------------------------

const ASSET_FIELDS = Object.freeze([
  "assetType",
  "assetId",
  "agentId",
  "assetKey",
  "kind",
  "sourceProviderId",
  "sourceDescription",
  "licenseState",
  "licenseNote",
  "descriptiveTags",
]);

const SELECTION_FIELDS = Object.freeze([
  "selectionType",
  "selectionId",
  "agentId",
  "assetId",
  "role",
  "productionRunId",
  "renderedArtifactRef",
]);

/**
 * Emits ONLY allowlisted fields in fixed order (byte-identical), frozen.
 * Polluted extra keys can never leak; every emitted string is re-scanned so
 * secrets and internal agent names cannot leave the process.
 */
export function serializeAudioRecord(record) {
  const isSelection = record?.selectionType === AUDIO_SELECTION_TYPE;
  const verdict = isSelection ? verifyAudioSelection(record) : verifyAudioAsset(record);
  if (!verdict.ok) throw audioError(verdict.reasonCode);
  const fields = isSelection ? SELECTION_FIELDS : ASSET_FIELDS;
  const output = {};
  for (const field of fields) {
    output[field] = record[field] === undefined ? null : record[field];
  }
  const scan = (value) => {
    if (typeof value === "string") {
      if (SECRET_LIKE.test(value)) throw audioError("AUDIO_SECRET_REJECTED");
    } else if (Array.isArray(value)) {
      for (const child of value) scan(child);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) scan(child);
    }
  };
  scan(output);
  return deepFreeze(output);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
