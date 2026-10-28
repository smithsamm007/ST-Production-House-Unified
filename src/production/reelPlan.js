/**
 * ST Production House — Independent content-Reel planning + brand-integration
 * mode contract (S-M34-01, Module 34 — package layer, offline portion).
 *
 * Pure, deterministic, offline module. NO media generation, NO provider calls,
 * NO publication, NO filesystem access, NO clock reads. It exists so a
 * production run can truthfully plan the canonical short-form package:
 *
 *   - TWO genuinely independent content Reels: hooks, objectives, and segment
 *     plans must all differ; identical or trivially-identical inputs fail
 *     closed with stable codes. Each Reel carries an independent recomputed
 *     SHA-256 identity derived from its content — duplicate exports cannot
 *     share identity.
 *   - ONE standalone brand-promotion Reel per run with an explicit
 *     brandIntegrationMode:
 *       STANDALONE_ONLY        → brand content never touches the main video
 *       INTEGRATED             → requires an explicit owner authorization
 *                                reference bound to the exact run
 *       OWNER_DECISION_REQUIRED → records the pending decision; never invents
 *                                 one
 *   - Paid/sponsored/affiliate campaigns require owner authorization for the
 *     brand Reel itself. No integration, promotion identity, or product is
 *     ever invented here.
 *   - Destinations are validated against the S-M23-01 package-destination
 *     allowlist (single canonical source). Publication is never requested.
 *   - Serialization is a strict allowlist (Rule 17); secrets and internal
 *     agent names are rejected in every free-text field (Rules 15/17).
 */

import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { PACKAGE_DESTINATIONS } from "../jarvis/packageProfileManifest.js";

export const REEL_PLAN_TYPE = "reel_plan_v1";
export const REEL_PACKAGE_TYPE = "reel_package_plan_v1";

export const BRAND_INTEGRATION_MODES = Object.freeze([
  "STANDALONE_ONLY",
  "INTEGRATED",
  "OWNER_DECISION_REQUIRED",
]);

export const REEL_ROLES = Object.freeze(["content_reel", "brand_reel"]);

/** Short-form vertical/square framing only; long-form 16:9 is NOT a Reel. */
export const REEL_ASPECT_RATIOS = Object.freeze(["9:16", "1:1", "4:5"]);

/** Reel duration bounds in ACTUAL media seconds (planning bound, QC measures real files). */
export const REEL_MIN_SECONDS = 5;
export const REEL_MAX_SECONDS = 180;

/**
 * Reel destination allowlist: the short-form subset of the canonical package
 * destinations (Bilibili permitted "where appropriate" per the canonical
 * distribution matrix). Every entry is validated against PACKAGE_DESTINATIONS.
 */
export const REEL_DESTINATIONS = Object.freeze([
  "youtube_shorts",
  "bilibili",
  "instagram_reels",
  "facebook_reels",
  "snapchat_spotlight",
]);

const SEGMENT_KINDS = Object.freeze([
  "video_clip",
  "still_image",
  "title_card",
  "voice",
  "bgm",
  "sfx",
]);
const TRANSITIONS = Object.freeze(["cut", "fade", "dissolve", "wipe"]);

const AGENT_IDS = new Set(PRELOADED_AGENTS.map(({ id }) => id));
const INTERNAL_AGENT_NAME = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i",
);
const SECRET_LIKE = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator|authorization:|affiliate[_ -]?link/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,60}$/;
const ARTIFACT_REF_RE = /^sha256:[0-9a-f]{64}$/;

const MAX_SEGMENTS = 12;
const MAX_DESTINATIONS = REEL_DESTINATIONS.length;

const PACKAGE_FIELDS = Object.freeze([
  "planType",
  "id",
  "agentId",
  "productionRunId",
  "brandIntegrationMode",
  "contentReels",
  "brandReel",
  "mainVideoIntegration",
  "ownerDecision",
]);

function reelError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw reelError(code);
  }
}

function cleanText(value, code, max) {
  if (typeof value !== "string") throw reelError(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > max) throw reelError(code);
  if (SECRET_LIKE.test(normalized)) throw reelError("REEL_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(normalized)) throw reelError("REEL_INTERNAL_NAME_REJECTED");
  return normalized;
}

/** Canonical comparison form: whitespace/punctuation-insensitive equality. */
function canonicalForm(text) {
  return text.toLowerCase().replace(/[^a-z0-9\u0900-\u097F]+/g, "");
}

function requireAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_IDS.has(agentId)) {
    throw reelError("REEL_AGENT_INVALID");
  }
  return agentId;
}

function requireRunId(productionRunId) {
  if (typeof productionRunId !== "string" || !ID_RE.test(productionRunId)) {
    throw reelError("REEL_RUN_INVALID");
  }
  return productionRunId;
}

function requireArtifactRef(value, code) {
  if (typeof value !== "string" || !ARTIFACT_REF_RE.test(value)) {
    throw reelError(code);
  }
  return value.toLowerCase();
}

function requireBoundedNumber(value, code, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw reelError(code);
  }
  return value;
}

function requireSegments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SEGMENTS) {
    throw reelError("REEL_SEGMENT_LIMIT");
  }
  return Object.freeze(
    value.map((segment) => {
      requirePlainObject(segment, "REEL_SEGMENT_INVALID");
      for (const key of Object.keys(segment)) {
        if (!["artifactRef", "kind", "durationSeconds"].includes(key)) {
          throw reelError("REEL_SEGMENT_FIELD_UNKNOWN");
        }
      }
      const out = {
        artifactRef: requireArtifactRef(segment.artifactRef, "REEL_ARTIFACT_REF_INVALID"),
        kind: (() => {
          if (typeof segment.kind !== "string" || !SEGMENT_KINDS.includes(segment.kind)) {
            throw reelError("REEL_SEGMENT_KIND_INVALID");
          }
          return segment.kind;
        })(),
      };
      if (segment.durationSeconds !== undefined && segment.durationSeconds !== null) {
        out.durationSeconds = requireBoundedNumber(
          segment.durationSeconds,
          "REEL_SEGMENT_DURATION_INVALID",
          0.1,
          REEL_MAX_SECONDS,
        );
      }
      return Object.freeze(out);
    }),
  );
}

function requireDestinations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DESTINATIONS) {
    throw reelError("REEL_DESTINATION_INVALID");
  }
  const seen = new Set();
  for (const destination of value) {
    if (typeof destination !== "string" || !REEL_DESTINATIONS.includes(destination)) {
      throw reelError("REEL_DESTINATION_INVALID");
    }
    if (!PACKAGE_DESTINATIONS.includes(destination)) {
      // Defense-in-depth: reel subset must stay inside the canonical allowlist.
      throw reelError("REEL_DESTINATION_INVALID");
    }
    if (seen.has(destination)) throw reelError("REEL_DESTINATION_DUPLICATE");
    seen.add(destination);
  }
  return Object.freeze([...value]);
}

function requireProductIdentityKey(value) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw reelError("REEL_PRODUCT_IDENTITY_INVALID");
  }
  if (SECRET_LIKE.test(value)) throw reelError("REEL_SECRET_REJECTED");
  if (INTERNAL_AGENT_NAME.test(value)) throw reelError("REEL_INTERNAL_NAME_REJECTED");
  return value;
}

function buildReelPlan(input) {
  requirePlainObject(input, "REEL_PLAN_INVALID");
  for (const key of Object.keys(input)) {
    if (
      !["planType", "id", "agentId", "productionRunId", "role", "hook", "objective",
        "aspectRatio", "durationSeconds", "captionConcept", "segments", "destinations",
        "productIdentityKey", "paidCampaign"].includes(key)
    ) {
      throw reelError("REEL_FIELD_UNKNOWN");
    }
  }
  const role = (() => {
    if (typeof input.role !== "string" || !REEL_ROLES.includes(input.role)) {
      throw reelError("REEL_ROLE_INVALID");
    }
    return input.role;
  })();
  const plan = {
    planType: REEL_PLAN_TYPE,
    id: null,
    agentId: requireAgentId(input.agentId),
    productionRunId: requireRunId(input.productionRunId),
    role,
    hook: cleanText(input.hook, "REEL_HOOK_INVALID", 200),
    objective: cleanText(input.objective, "REEL_OBJECTIVE_INVALID", 300),
    aspectRatio: (() => {
      if (typeof input.aspectRatio !== "string" || !REEL_ASPECT_RATIOS.includes(input.aspectRatio)) {
        throw reelError("REEL_ASPECT_INVALID");
      }
      return input.aspectRatio;
    })(),
    durationSeconds: requireBoundedNumber(
      input.durationSeconds,
      "REEL_DURATION_INVALID",
      REEL_MIN_SECONDS,
      REEL_MAX_SECONDS,
    ),
    captionConcept: cleanText(input.captionConcept, "REEL_CAPTION_INVALID", 300),
    segments: requireSegments(input.segments),
    destinations: requireDestinations(input.destinations),
    productIdentityKey: role === "brand_reel" ? requireProductIdentityKey(input.productIdentityKey) : null,
    paidCampaign: role === "brand_reel" ? input.paidCampaign === true : false,
  };
  plan.id = computeReelPlanId(plan);
  return deepFreeze(plan);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reel plan identity + tamper detection
// ---------------------------------------------------------------------------

/** Recomputed SHA-256 over canonical reel content (id field excluded). */
export function computeReelPlanId(plan) {
  requirePlainObject(plan, "REEL_PLAN_INVALID");
  const { id: _ignored, ...content } = plan;
  return stableId(content);
}

export function verifyReelPlanIntegrity(plan) {
  requirePlainObject(plan, "REEL_PLAN_INVALID");
  if (plan.planType !== REEL_PLAN_TYPE) {
    return { intact: false, expectedId: null, reason: "REEL_PLAN_TYPE_MISMATCH" };
  }
  const expectedId = computeReelPlanId(plan);
  if (plan.id !== expectedId) {
    return { intact: false, expectedId, reason: "REEL_ID_MISMATCH" };
  }
  return { intact: true, expectedId, reason: null };
}

/** Creates one immutable, deterministic Reel plan. */
export function createReelPlan(input) {
  return buildReelPlan(input);
}

// ---------------------------------------------------------------------------
// Independence enforcement (the core anti-duplication guarantee)
// ---------------------------------------------------------------------------

/**
 * Two content Reels must differ in hook, objective, AND segment plan.
 * Comparison is punctuation/whitespace/case-insensitive so "the same hook
 * with different subtitles" cannot pass. Each failure carries a stable code.
 */
export function assertReelIndependence(reelA, reelB) {
  requirePlainObject(reelA, "REEL_PLAN_INVALID");
  requirePlainObject(reelB, "REEL_PLAN_INVALID");
  const integrityA = verifyReelPlanIntegrity(reelA);
  if (!integrityA.intact) throw reelError(integrityA.reason);
  const integrityB = verifyReelPlanIntegrity(reelB);
  if (!integrityB.intact) throw reelError(integrityB.reason);
  if (canonicalForm(reelA.hook) === canonicalForm(reelB.hook)) {
    throw reelError("REEL_HOOK_NOT_INDEPENDENT");
  }
  if (canonicalForm(reelA.objective) === canonicalForm(reelB.objective)) {
    throw reelError("REEL_OBJECTIVE_NOT_INDEPENDENT");
  }
  if (stableId(reelA.segments) === stableId(reelB.segments)) {
    throw reelError("REEL_SEGMENT_PLAN_NOT_INDEPENDENT");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Owner authorization binding (INTEGRATED mode only; never invented)
// ---------------------------------------------------------------------------

function requireOwnerAuthorization(value, productionRunId) {
  requirePlainObject(value, "REEL_OWNER_AUTHORIZATION_REQUIRED");
  for (const key of Object.keys(value)) {
    if (!["authorizationRef", "boundRunId"].includes(key)) {
      throw reelError("REEL_AUTHORIZATION_FIELD_UNKNOWN");
    }
  }
  if (typeof value.authorizationRef !== "string" || !ID_RE.test(value.authorizationRef)) {
    throw reelError("REEL_OWNER_AUTHORIZATION_REQUIRED");
  }
  if (value.boundRunId !== productionRunId) {
    throw reelError("REEL_AUTHORIZATION_RUN_MISMATCH");
  }
  return Object.freeze({ authorizationRef: value.authorizationRef, boundRunId: productionRunId });
}

// ---------------------------------------------------------------------------
// Package: 2 independent content Reels + 1 standalone brand Reel + mode
// ---------------------------------------------------------------------------

/**
 * Composes the canonical short-form package for one production run.
 *
 * - Exactly two content Reels, enforced independent (fail-closed).
 * - Exactly one standalone brand Reel.
 * - brandIntegrationMode gates everything:
 *     INTEGRATED              → owner authorization required and run-bound;
 *                               mainVideoIntegration must reference a DIFFERENT
 *                               artifact than the brand Reel's artifact (reuse
 *                               of the Reel as the main-video segment fails).
 *     STANDALONE_ONLY         → mainVideoIntegration is always null; supplying
 *                               integration material fails closed.
 *     OWNER_DECISION_REQUIRED → ownerDecision records { status: "pending" }
 *                               with no decision invented; authorization
 *                               material is rejected (a pending decision
 *                               cannot already be decided).
 */
export function createReelPackagePlan(input) {
  requirePlainObject(input, "REEL_PACKAGE_INVALID");
  for (const key of Object.keys(input)) {
    if (
      !["agentId", "productionRunId", "contentReels", "brandReel",
        "brandIntegrationMode", "ownerAuthorization", "mainVideoIntegration"].includes(key)
    ) {
      throw reelError("REEL_PACKAGE_FIELD_UNKNOWN");
    }
  }
  const agentId = requireAgentId(input.agentId);
  const productionRunId = requireRunId(input.productionRunId);

  if (!Array.isArray(input.contentReels) || input.contentReels.length !== 2) {
    throw reelError("REEL_PACKAGE_CONTENT_COUNT");
  }
  const contentReels = input.contentReels.map((reel) => buildReelPlan(reel));
  for (const reel of contentReels) {
    if (reel.role !== "content_reel" || reel.agentId !== agentId || reel.productionRunId !== productionRunId) {
      throw reelError("REEL_PACKAGE_SCOPE_MISMATCH");
    }
  }
  assertReelIndependence(contentReels[0], contentReels[1]);

  const brandReel = buildReelPlan(input.brandReel);
  if (brandReel.role !== "brand_reel" || brandReel.agentId !== agentId || brandReel.productionRunId !== productionRunId) {
    throw reelError("REEL_PACKAGE_SCOPE_MISMATCH");
  }

  const mode = (() => {
    if (typeof input.brandIntegrationMode !== "string" || !BRAND_INTEGRATION_MODES.includes(input.brandIntegrationMode)) {
      throw reelError("REEL_BRAND_MODE_INVALID");
    }
    return input.brandIntegrationMode;
  })();

  let mainVideoIntegration = null;
  let ownerDecision = null;

  if (mode === "INTEGRATED") {
    const authorization = requireOwnerAuthorization(input.ownerAuthorization, productionRunId);
    requirePlainObject(input.mainVideoIntegration, "REEL_INTEGRATION_INVALID");
    for (const key of Object.keys(input.mainVideoIntegration)) {
      if (!["artifactRef", "note"].includes(key)) {
        throw reelError("REEL_INTEGRATION_FIELD_UNKNOWN");
      }
    }
    const integrationArtifactRef = requireArtifactRef(
      input.mainVideoIntegration.artifactRef,
      "REEL_ARTIFACT_REF_INVALID",
    );
    // The standalone Brand Reel and the integrated main-video segment are
    // DIFFERENT artifacts — silently reusing the Reel's artifact fails closed.
    if (brandReel.segments.some((segment) => segment.artifactRef === integrationArtifactRef)) {
      throw reelError("REEL_INTEGRATION_ARTIFACT_REUSE");
    }
    mainVideoIntegration = Object.freeze({
      artifactRef: integrationArtifactRef,
      note: input.mainVideoIntegration.note === undefined || input.mainVideoIntegration.note === null
        ? null
        : cleanText(input.mainVideoIntegration.note, "REEL_INTEGRATION_INVALID", 200),
    });
    void authorization; // validated, bound to the run, not serialized with secrets
  } else if (mode === "STANDALONE_ONLY") {
    if (input.mainVideoIntegration !== undefined && input.mainVideoIntegration !== null) {
      throw reelError("REEL_INTEGRATION_CONFLICT");
    }
  } else if (input.ownerAuthorization !== undefined && input.ownerAuthorization !== null) {
    // A pending owner decision cannot already carry an authorization.
    throw reelError("REEL_MODE_CONFLICT");
  }

  if (mode === "OWNER_DECISION_REQUIRED") {
    ownerDecision = Object.freeze({ status: "pending", decidedBy: null });
  }

  if (brandReel.paidCampaign && mode !== "INTEGRATED") {
    // Paid/sponsored campaigns need owner authorization even when standalone;
    // that authorization is a separate owner-gated flow (S-M24-LIVE), so the
    // package records the blocker instead of inventing approval.
    ownerDecision = Object.freeze({ status: "owner_action_required", decidedBy: null });
  }

  const ownerAuthorizationRef =
    mode === "INTEGRATED" && typeof input.ownerAuthorization?.authorizationRef === "string"
      ? input.ownerAuthorization.authorizationRef
      : null;

  const pkg = {
    planType: REEL_PACKAGE_TYPE,
    id: null,
    agentId,
    productionRunId,
    brandIntegrationMode: mode,
    contentReels: Object.freeze(contentReels),
    brandReel,
    mainVideoIntegration,
    ownerDecision,
    ownerAuthorizationRef,
  };
  pkg.id = computeReelPackagePlanId(pkg);
  return deepFreeze(pkg);
}

/** Recomputed SHA-256 over canonical package content (id + auth ref excluded). */
export function computeReelPackagePlanId(pkg) {
  requirePlainObject(pkg, "REEL_PACKAGE_INVALID");
  const { id: _ignored, ownerAuthorizationRef: _auth, ...content } = pkg;
  return stableId(content);
}

export function verifyReelPackagePlanIntegrity(pkg) {
  requirePlainObject(pkg, "REEL_PACKAGE_INVALID");
  if (pkg.planType !== REEL_PACKAGE_TYPE) {
    return { intact: false, expectedId: null, reason: "REEL_PACKAGE_TYPE_MISMATCH" };
  }
  const expectedId = computeReelPackagePlanId(pkg);
  if (pkg.id !== expectedId) {
    return { intact: false, expectedId, reason: "REEL_PACKAGE_ID_MISMATCH" };
  }
  return { intact: true, expectedId, reason: null };
}

export function detectReelPackagePlanTampering(originalPkg, candidatePkg) {
  const a = computeReelPackagePlanId(originalPkg);
  const b = computeReelPackagePlanId(candidatePkg);
  return { tampered: a !== b, originalFingerprint: a, candidateFingerprint: b };
}

// ---------------------------------------------------------------------------
// Serialization: strict allowlist (Rule 17)
// ---------------------------------------------------------------------------

/**
 * Projects a package onto the strict allowlist in fixed order. Unknown keys
 * are dropped (and can never leak); allowlisted-field mutation or deletion
 * fails the recomputed-id integrity gate; the owner authorization reference
 * is never serialized (it is an internal control-plane reference).
 */
export function serializeReelPackagePlan(pkg) {
  requirePlainObject(pkg, "REEL_PACKAGE_INVALID");
  const projection = {};
  for (const field of PACKAGE_FIELDS) {
    projection[field] = pkg[field] === undefined ? null : pkg[field];
  }
  const integrity = verifyReelPackagePlanIntegrity(projection);
  if (!integrity.intact) throw reelError(integrity.reason);
  const scan = (value) => {
    if (typeof value === "string") {
      if (SECRET_LIKE.test(value)) throw reelError("REEL_SECRET_REJECTED");
      if (!ARTIFACT_REF_RE.test(value) && !ID_RE.test(value) && INTERNAL_AGENT_NAME.test(value)) {
        throw reelError("REEL_INTERNAL_NAME_REJECTED");
      }
    } else if (Array.isArray(value)) {
      for (const child of value) scan(child);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) scan(child);
    }
  };
  scan(projection);
  return deepFreeze(projection);
}
