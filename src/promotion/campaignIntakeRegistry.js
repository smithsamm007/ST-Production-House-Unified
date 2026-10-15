/**
 * ST Production House — campaign intake registry (TASK-4.1, Module 30/4).
 *
 * Owner-scoped registration of promotion campaigns built ONLY out of
 * scanner-passing affiliate links (src/promotion/campaignIntake.js). The
 * registry itself stays offline and deterministic:
 *
 * - Rule 9: `promoteMainVideo` is an explicit owner decision; it can never be
 *   sneaked in through metadata, and `brandIntegrationMode` is a bounded enum
 *   recorded verbatim — INTEGRATED requires an ownerEvidenceRef (and fails
 *   closed without one), OWNER_DECISION_REQUIRED records the pending owner
 *   decision without inventing one, and STANDALONE_ONLY never promotes the
 *   main video (same enum family as src/production/reelPlan.js).
 * - Rule 8: two intakes for the same normalized product/service identity
 *   cannot co-open in one registry instance; the registry returns the honest
 *   DUPLICATE_IDENTITY refusal (database enforcement remains the DB layer's).
 * - Deterministic ids recomputed over the allowlisted content: an immutable
 *   record whose content digest can be recomputed with
 *   `recomputeCampaignId(record)` — any mutation is detectable tampering
 *   (CAMPAIGN_TAMPERED) because Object.freeze blocks silent mutations.
 *
 * No network, no secrets, no publishing — Rule 7 approval is a separate act.
 */

import { createHash } from "node:crypto";
import {
  CAMPAIGN_INTAKE_ERROR_CODES,
  canonicalDisclosureTemplates,
  createScannedAffiliateLink,
} from "./campaignIntake.js";
import { normalizeProductServiceIdentity } from "./promotionPolicy.js";

const BRAND_INTEGRATION_MODES = Object.freeze(["STANDALONE_ONLY", "INTEGRATED", "OWNER_DECISION_REQUIRED"]);
const INTAKE_STATUSES = Object.freeze(["submitted", "awaiting_owner_decision", "rejected", "authorized"]);

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function fail(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

/**
 * Serializes the record's content-bearing fields only (drops derived fields:
 * campaignId and recordVersion) — the canonical form the id is recomputed
 * from, making any post-intake mutation detectable.
 */
export function campaignContent(record) {
  const content = { ...record };
  delete content.campaignId;
  delete content.recordVersion;
  return content;
}

/** Recomputes the campaign id from its content; used for tamper detection. */
export function recomputeCampaignId(record) {
  return sha256Hex(canonicalJson(campaignContent(record)));
}

export class CampaignIntakeRegistry {
  /**
   * @param {Object} options
   * @param {string} options.ownerId - session-verified owner id
   * @param {string[]} options.allowedDomains - exact or suffix-match registrable domains
   * @param {string[]} [options.internalNames] - canonical internal agent names (Rule 15)
   */
  constructor(options) {
    if (
      !options ||
      typeof options.ownerId !== "string" ||
      options.ownerId.length === 0
    ) {
      fail(CAMPAIGN_INTAKE_ERROR_CODES.IDENTITY_REQUIRED, "owner id required for intake");
    }
    if (!Array.isArray(options.allowedDomains) || options.allowedDomains.length === 0) {
      fail(CAMPAIGN_INTAKE_ERROR_CODES.LINK_DOMAIN_NOT_ALLOWED, "allowedDomains list required");
    }
    this.#ownerId = options.ownerId;
    this.#allowedDomains = options.allowedDomains.map((d) => String(d).toLowerCase());
    this.#internalNames = Array.isArray(options.internalNames) ? options.internalNames : [];
    this.#byIdentity = new Map();
  }

  #ownerId;
  #allowedDomains;
  #internalNames;
  #byIdentity;

  /**
   * Registers one owner campaign intake. Returns an immutable record usable
   * by downstream approval/publishing contracts (never publishes itself).
   */
  register(input) {
    if (!input || typeof input.productName !== "string" || input.productName.trim() === "") {
      fail(CAMPAIGN_INTAKE_ERROR_CODES.IDENTITY_REQUIRED, "productName required");
    }
    const identity = normalizeProductServiceIdentity(input.productName, input.serviceCategory);
    const identityKey = identity.canonical;
    if (this.#byIdentity.has(identityKey)) {
      fail(
        CAMPAIGN_INTAKE_ERROR_CODES.DUPLICATE_IDENTITY,
        `normalized product identity '${identityKey}' is already reserved (Rule 8)`
      );
    }

    const destinations = Array.isArray(input.destinations) ? input.destinations : [];
    if (destinations.length === 0) {
      fail(CAMPAIGN_INTAKE_ERROR_CODES.DESTINATION_REQUIRED);
    }
    for (const destination of destinations) {
      if (typeof destination !== "string" || destination.trim() === "") {
        fail(CAMPAIGN_INTAKE_ERROR_CODES.DESTINATION_REQUIRED, "each destination must be a non-empty string");
      }
      for (const name of this.#internalNames) {
        if (destination.toLowerCase().includes(String(name).toLowerCase())) {
          fail(CAMPAIGN_INTAKE_ERROR_CODES.INTERNAL_NAME_IN_PUBLIC, "destinations");
        }
      }
    }

    const scannedLinks = (Array.isArray(input.affiliateLinks) ? input.affiliateLinks : []).map((candidate) =>
      createScannedAffiliateLink(candidate, {
        allowedDomains: this.#allowedDomains,
        internalNames: this.#internalNames,
      })
    );
    for (const templateName of scannedLinks.map((l) => l.disclosureTemplate).filter(Boolean)) {
      if (!canonicalDisclosureTemplates[templateName]) {
        fail(CAMPAIGN_INTAKE_ERROR_CODES.DISCLOSURE_TEMPLATE_UNKNOWN, String(templateName));
      }
    }

    let brandIntegrationMode = input.brandIntegrationMode;
    if (brandIntegrationMode === undefined || brandIntegrationMode === null) {
      brandIntegrationMode = "OWNER_DECISION_REQUIRED";
    }
    if (!BRAND_INTEGRATION_MODES.includes(brandIntegrationMode)) {
      fail(
        CAMPAIGN_INTAKE_ERROR_CODES.DISCLOSURE_TEMPLATE_UNKNOWN,
        `unknown brandIntegrationMode '${String(brandIntegrationMode)}'`
      );
    }
    let ownerEvidenceRef = null;
    if (brandIntegrationMode === "INTEGRATED") {
      ownerEvidenceRef = input.ownerEvidenceRef;
      if (typeof ownerEvidenceRef !== "string" || ownerEvidenceRef.trim() === "") {
        fail(CAMPAIGN_INTAKE_ERROR_CODES.MAIN_VIDEO_PROMOTION_UNAUTHORIZED, "INTEGRATED requires an owner authorization reference");
      }
      if (input.promoteMainVideo !== true) {
        fail(CAMPAIGN_INTAKE_ERROR_CODES.MAIN_VIDEO_PROMOTION_UNAUTHORIZED, "promoteMainVideo requires an explicit owner decision (Rule 9)");
      }
    }
    if (input.promoteMainVideo === true && brandIntegrationMode === "STANDALONE_ONLY") {
      fail(CAMPAIGN_INTAKE_ERROR_CODES.MAIN_VIDEO_PROMOTION_UNAUTHORIZED, "STANDALONE_ONLY never promotes the main video (Rule 9)");
    }

    const status = INTAKE_STATUSES.includes(input.status) ? input.status : "submitted";
    const affiliateLinks = scannedLinks.map(({ linkId, host, disclosure, disclosureTemplate, rawLength }) => ({
      linkId,
      host,
      disclosure,
      disclosureTemplate,
      rawLength,
    }));

    const content = {
      ownerId: this.#ownerId,
      identity,
      destinations: [...destinations],
      affiliateLinks,
      brandIntegrationMode,
      ownerEvidenceRef,
      promoteMainVideo: brandIntegrationMode === "INTEGRATED" && input.promoteMainVideo === true,
      standaloneReel: { mode: "RESERVED", count: 1 },
      disclosureTemplatesUsed: [...new Set(scannedLinks.map((l) => l.disclosureTemplate).filter(Boolean))],
      status,
    };
    const record = Object.freeze({
      ...content,
      campaignId: sha256Hex(canonicalJson(content)),
      recordVersion: 1,
    });

    this.#byIdentity.set(identityKey, record);
    return record;
  }

  /** Every currently reserved normalized identity key (Rule 8 observability). */
  listReservedIdentities() {
    return [...this.#byIdentity.keys()];
  }

  /** Finds an intake record by normalized identity, or null. */
  findByIdentity(productName, serviceCategory) {
    let identity;
    try {
      identity = normalizeProductServiceIdentity(productName, serviceCategory);
    } catch {
      return null;
    }
    return this.#byIdentity.get(identity.canonical) ?? null;
  }
}

/**
 * Tamper gate: recomputes the campaign id from the record's content and
 * throws CAMPAIGN_TAMPERED when anything else was mutated after intake.
 * (Object.freeze already blocks silent in-place mutation; this is the
 * verifiable deterrent for deserialized copies.)
 */
export function assertCampaignIntact(record) {
  if (!record || record.campaignId !== recomputeCampaignId(record)) {
    fail(CAMPAIGN_INTAKE_ERROR_CODES.TAMPERED, "campaign record mutated after intake");
  }
  return true;
}
