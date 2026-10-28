/**
 * ST Production House — Deterministic per-agent package-profile manifest
 * (S-M23-01, Module 23 — additive platform-adaptation planning layer).
 *
 * Pure, deterministic, offline module. It performs NO provider calls, NO media
 * generation, NO publication, NO filesystem access, and NO clock reads. It
 * exists so a package run can truthfully declare its OUTPUT CONTRACT:
 *
 *   - The canonical default profile encodes the owner's standard package:
 *     exactly 1 long-form episode (30–50 min; YouTube + Bilibili only),
 *     2 independent standalone Shorts, and 1 promotional Reel.
 *   - The existing JARVIS planner contract (3 standalone Shorts) is preserved
 *     verbatim under the agent-resolved `jarvis_legacy_v1` profile until the
 *     owner explicitly decides otherwise. No existing planner contract is
 *     rewritten (R5): this module is purely additive metadata.
 *   - Each package output is mapped to its allowed destination platforms
 *     (the platform-adaptation manifest). Long-form destinations are
 *     YouTube + Bilibili ONLY; short-form destinations are YouTube Shorts,
 *     Instagram Reels, Facebook Reels, and Snapchat Spotlight.
 *   - Publication is ALWAYS `not_requested` here. Live publishing is
 *     owner-gated (AGENTS.md Rule 7) and happens nowhere in this module.
 *
 * Fail-closed rules (AGENTS.md):
 *   - Rule 15: internal agent names are rejected in free-text fields.
 *   - Rule 17: secret-like strings are rejected; serialization is a strict
 *     allowlist; unknown fields are dropped.
 *   - Manifest identity is a recomputed SHA-256 over the manifest content
 *     (fixed key order); any tampering is detected, never silently accepted.
 */

import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

export const PACKAGE_PROFILE_MANIFEST_TYPE = "package_profile_manifest_v1";

/** Known profiles. Additive only: never remove or reorder existing entries. */
export const PACKAGE_PROFILES = Object.freeze({
  canonical_default_v1: Object.freeze({
    profileId: "canonical_default_v1",
    description: "Canonical ST package: 1 long-form + 2 standalone Shorts + 1 promotional Reel",
    longFormCount: 1,
    standaloneShortCount: 2,
    promoReelCount: 1,
    longFormRuntimeSeconds: Object.freeze({ min: 1800, max: 3000 }),
    standaloneShortRoles: Object.freeze([]),
  }),
  jarvis_legacy_v1: Object.freeze({
    profileId: "jarvis_legacy_v1",
    description: "JARVIS additive compatibility profile: existing planner contract with 3 standalone Shorts preserved",
    longFormCount: 1,
    standaloneShortCount: 3,
    promoReelCount: 1,
    longFormRuntimeSeconds: Object.freeze({ min: 1800, max: 3000 }),
    standaloneShortRoles: Object.freeze(["opening_hook", "high_tension_moment", "cliffhanger_teaser"]),
  }),
});

const DEFAULT_PROFILE_ID = "canonical_default_v1";
const LEGACY_AGENT_IDS = Object.freeze(new Set(["agent-01"]));

/** Platform destination allowlist (single source of truth for this module). */
export const PACKAGE_DESTINATIONS = Object.freeze([
  "youtube",
  "bilibili",
  "youtube_shorts",
  "instagram_reels",
  "facebook_reels",
  "snapchat_spotlight",
]);

const LONG_FORM_DESTINATIONS = Object.freeze(["youtube", "bilibili"]);
const SHORT_FORM_DESTINATIONS = Object.freeze([
  "youtube_shorts",
  "instagram_reels",
  "facebook_reels",
  "snapchat_spotlight",
]);

const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token/i;
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const AGENT_IDS = new Set(PRELOADED_AGENTS.map(({ id }) => id));
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{3,120}$/;

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertCleanText(value, secretCode, nameCode) {
  if (typeof value !== "string") throw new Error("PACKAGE_PROFILE_INPUT_INVALID");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (SECRET_LIKE.test(normalized)) throw new Error(secretCode);
  if (INTERNAL_AGENT_NAME.test(normalized)) throw new Error(nameCode);
  return normalized;
}

/** Resolves a registered agent id (Rule 15: names are internal-only). */
function assertAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw new Error("PACKAGE_PROFILE_AGENT_INVALID");
  }
  return agentId;
}

/**
 * Resolves the profile id for an agent: explicit override wins; otherwise
 * JARVIS keeps its legacy 3-Shorts contract and every other agent gets the
 * canonical default. Deterministic and additive — no existing contract moves.
 */
export function resolvePackageProfileForAgent(agentId) {
  assertAgentId(agentId);
  return LEGACY_AGENT_IDS.has(agentId) ? "jarvis_legacy_v1" : DEFAULT_PROFILE_ID;
}

/** Lists registered profiles (frozen shallow copies; stable order). */
export function listPackageProfiles() {
  return Object.values(PACKAGE_PROFILES).map((profile) => ({
    profileId: profile.profileId,
    description: profile.description,
    longFormCount: profile.longFormCount,
    standaloneShortCount: profile.standaloneShortCount,
    promoReelCount: profile.promoReelCount,
  }));
}

/** Resolves a profile id to its frozen definition. Unknown ids fail closed. */
export function resolvePackageProfile(profileId) {
  if (profileId === undefined || profileId === null) {
    return PACKAGE_PROFILES[DEFAULT_PROFILE_ID];
  }
  if (typeof profileId !== "string" || !Object.hasOwn(PACKAGE_PROFILES, profileId)) {
    throw new Error("PACKAGE_PROFILE_UNKNOWN");
  }
  return PACKAGE_PROFILES[profileId];
}

function buildOutputs(profile) {
  const outputs = [];
  outputs.push({
    slot: "long_form_1",
    kind: "long_form_episode",
    targetSeconds: null,
    runtimeBoundsSeconds: {
      min: profile.longFormRuntimeSeconds.min,
      max: profile.longFormRuntimeSeconds.max,
    },
    destinations: [...LONG_FORM_DESTINATIONS],
  });
  for (let i = 1; i <= profile.standaloneShortCount; i += 1) {
    const role = profile.standaloneShortRoles.length
      ? profile.standaloneShortRoles[i - 1]
      : null;
    outputs.push({
      slot: `standalone_short_${i}`,
      kind: "standalone_short",
      targetSeconds: role ? { opening_hook: 30, high_tension_moment: 45, cliffhanger_teaser: 30 }[role] ?? null : null,
      runtimeBoundsSeconds: null,
      destinations: [...SHORT_FORM_DESTINATIONS],
    });
  }
  outputs.push({
    slot: `promo_reel_${profile.promoReelCount > 0 ? 1 : 0}`,
    kind: "promotional_reel",
    targetSeconds: null,
    runtimeBoundsSeconds: null,
    destinations: [...SHORT_FORM_DESTINATIONS],
  });
  return outputs;
}

/**
 * Builds the deterministic package-profile manifest for one package run.
 * Same inputs => byte-identical manifest (no clocks, no randomness).
 */
export function buildPackageProfileManifest(input = {}) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("PACKAGE_PROFILE_INPUT_INVALID");
  }
  const agentId = assertAgentId(input.agentId);
  const profileId = input.profileId === undefined || input.profileId === null
    ? resolvePackageProfileForAgent(agentId)
    : input.profileId;
  const profile = resolvePackageProfile(profileId);

  let packageTaskId = null;
  if (input.packageTaskId !== undefined && input.packageTaskId !== null) {
    if (typeof input.packageTaskId !== "string" || !TASK_ID_PATTERN.test(input.packageTaskId)) {
      throw new Error("PACKAGE_PROFILE_TASK_ID_INVALID");
    }
    packageTaskId = input.packageTaskId;
  }

  let concept = null;
  if (input.concept !== undefined && input.concept !== null) {
    if (typeof input.concept !== "string" || input.concept.trim().length < 3 || input.concept.trim().length > 1200) {
      throw new Error("PACKAGE_PROFILE_CONCEPT_INVALID");
    }
    concept = assertCleanText(
      input.concept,
      "PACKAGE_PROFILE_SECRET_REJECTED",
      "PACKAGE_PROFILE_INTERNAL_AGENT_NAME_REJECTED",
    );
  }

  const outputs = buildOutputs(profile);

  // Invariant: the emitted outputs must exactly match the profile contract.
  const longForm = outputs.filter((o) => o.kind === "long_form_episode").length;
  const shorts = outputs.filter((o) => o.kind === "standalone_short").length;
  const promo = outputs.filter((o) => o.kind === "promotional_reel").length;
  if (longForm !== profile.longFormCount || shorts !== profile.standaloneShortCount || promo !== profile.promoReelCount) {
    throw new Error("PACKAGE_PROFILE_INVARIANT_VIOLATION");
  }

  const manifest = {
    manifestType: PACKAGE_PROFILE_MANIFEST_TYPE,
    profileId: profile.profileId,
    agentId,
    packageTaskId,
    concept,
    outputs,
    longFormCount: longForm,
    standaloneShortCount: shorts,
    promoReelCount: promo,
    mediaStatus: "not_generated",
    providerCalls: [],
    publication: { status: "not_requested" },
  };
  manifest.manifestId = stableId(manifest);
  return Object.freeze(manifest);
}

/** Recomputes the manifest id over its identity content (tamper detection). */
export function computePackageProfileManifestId(manifest) {
  const {
    manifestType,
    profileId,
    agentId,
    packageTaskId,
    concept,
    outputs,
    longFormCount,
    standaloneShortCount,
    promoReelCount,
    mediaStatus,
    providerCalls,
    publication,
  } = manifest ?? {};
  return stableId({
    manifestType,
    profileId,
    agentId,
    packageTaskId,
    concept,
    outputs,
    longFormCount,
    standaloneShortCount,
    promoReelCount,
    mediaStatus,
    providerCalls,
    publication,
  });
}

/**
 * Verifies a manifest's integrity. Returns `{ ok: true }` or
 * `{ ok: false, reasonCode }` — never mutates, never throws on mismatch.
 */
export function verifyPackageProfileManifest(manifest) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { ok: false, reasonCode: "PACKAGE_PROFILE_MANIFEST_MALFORMED" };
  }
  if (manifest.manifestType !== PACKAGE_PROFILE_MANIFEST_TYPE) {
    return { ok: false, reasonCode: "PACKAGE_PROFILE_MANIFEST_MALFORMED" };
  }
  const expected = computePackageProfileManifestId(manifest);
  if (manifest.manifestId !== expected) {
    return { ok: false, reasonCode: "MANIFEST_ID_MISMATCH" };
  }
  return { ok: true };
}

/**
 * Strict-allowlist dashboard projection (Rule 17). Unknown fields are dropped,
 * free text is re-validated, output is frozen with fixed key order.
 */
export function serializePackageProfileForDashboard(manifest) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("PACKAGE_PROFILE_MANIFEST_MALFORMED");
  }
  if (verifyPackageProfileManifest(manifest).ok === false) {
    throw new Error("MANIFEST_ID_MISMATCH");
  }
  if (typeof manifest.profileId !== "string" || !Object.hasOwn(PACKAGE_PROFILES, manifest.profileId)) {
    throw new Error("PACKAGE_PROFILE_UNKNOWN");
  }
  assertAgentId(manifest.agentId);
  if (manifest.concept !== null && manifest.concept !== undefined) {
    assertCleanText(
      manifest.concept,
      "PACKAGE_PROFILE_SECRET_REJECTED",
      "PACKAGE_PROFILE_INTERNAL_AGENT_NAME_REJECTED",
    );
  }
  const outputs = manifest.outputs.map((output) => ({
    slot: output.slot,
    kind: output.kind,
    targetSeconds: output.targetSeconds ?? null,
    runtimeBoundsSeconds:
      output.runtimeBoundsSeconds === null || output.runtimeBoundsSeconds === undefined
        ? null
        : { min: output.runtimeBoundsSeconds.min, max: output.runtimeBoundsSeconds.max },
    destinations: [...output.destinations],
  }));
  return Object.freeze({
    manifestType: manifest.manifestType,
    manifestId: manifest.manifestId,
    profileId: manifest.profileId,
    agentId: manifest.agentId,
    packageTaskId: manifest.packageTaskId ?? null,
    outputs,
    longFormCount: manifest.longFormCount,
    standaloneShortCount: manifest.standaloneShortCount,
    promoReelCount: manifest.promoReelCount,
    mediaStatus: manifest.mediaStatus,
    publicationStatus: manifest.publication.status,
  });
}
