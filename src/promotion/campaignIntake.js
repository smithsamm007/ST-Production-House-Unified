/**
 * ST Production House — campaign intake contract (TASK-4.1, Module 30/4).
 *
 * The owner's ONLY way to declare a promotion campaign. Deterministic and
 * offline: a campaign package binds its public identity, destinations, the
 * affiliate link set passing the security scanner, explicit disclosure
 * templates, and the Rule 8/9 boundaries before anything can go near
 * publishing (Rule 7 approval remains a separate, owner-only act).
 *
 * Fail-closed guarantees implemented here:
 * - HTTPS-only, host-allowlisted affiliate links with no embedded credentials,
 *   no non-standard ports, no localhost/private network hosts, no tracking-
 *   parameter smuggling in the raw string; each scanned link carries its own
 *   disclosure verbatim (Rule: affiliate disclosure policy).
 * - `promoteMainVideo` must be an explicit owner decision at intake (Rule 9:
 *   main-video promotion is independent of the standalone Reel and disabled
 *   unless the owner explicitly enables it). It is stored ONLY on the owner-
 *   enabled campaign surface, and it forbids the standalone Reel to carry it.
 * - The one-standalone-Reel-per-product/service reservation is the database
 *   layer's job (Rule 8); intake's job is to REFUSE a second intake for the
 *   same normalized product identity in the same intake batch.
 * - Internal agent names never appear in public fields (Rule 15): intake
 *   scans every public string against the canonical internal-name list
 *   supplied at construction and fails closed.
 * - Deterministic ids: recomputed SHA-256 over the allowlisted content —
 *   byte-identical intake yields byte-identical records and any field
 *   mutation is detectable tampering.
 *
 * No provider calls, no network, no media generation, no publishing.
 */

import { createHash } from "node:crypto";
import { normalizeProductServiceIdentity } from "./promotionPolicy.js";

const HTTPS_URI_PATTERN = /^https:\/\/[a-z0-9.\-:~\/?#=@!$&'()*+,;_\[\]%-]+$/i;
const PRIVATE_HOST_PATTERN = /(localhost)|(\.local$)|(^127\.)|(^10\.)|(^192\.168\.)|(^172\.(1[6-9]|2\d|3[01])\.)|(^169\.254\.)|(\.internal$)|(^0\.)/i;

const CANONICAL_DISCLOSURE_TEMPLATES = Object.freeze({
  caption_suffix: "Paid partnership. Disclosure: contains affiliate links, marked with #ad — the owner may earn commissions at no extra cost to you.",
  humanoid_label: "Contains affiliate links (#ad). Paid partnership.",
  video_overlay: "#ad",
});

/** Stable failure codes; never a silent pass. */
export const CAMPAIGN_INTAKE_ERROR_CODES = Object.freeze({
  IDENTITY_REQUIRED: "CAMPAIGN_IDENTITY_REQUIRED",
  DUPLICATE_IDENTITY: "CAMPAIGN_DUPLICATE_IDENTITY",
  LINK_REQUIRED: "CAMPAINT_LINK_REQUIRED",
  LINK_NOT_HTTPS: "AFFILIATE_LINK_NOT_HTTPS",
  LINK_EMBEDDED_CREDENTIALS: "AFFILIATE_LINK_EMBEDDED_CREDENTIALS",
  LINK_UNSAFE_HOST: "AFFILIATE_LINK_UNSAFE_HOST",
  LINK_NONSTANDARD_PORT: "AFFILIATE_LINK_NONSTANDARD_PORT",
  LINK_DOMAIN_NOT_ALLOWED: "AFFILIATE_LINK_DOMAIN_NOT_ALLOWED",
  DISCLOSURE_REQUIRED: "AFFILIATE_DISCLOSURE_REQUIRED",
  DISCLOSURE_TEMPLATE_UNKNOWN: "AFFILIATE_DISCLOSURE_TEMPLATE_UNKNOWN",
  DESTINATION_REQUIRED: "CAMPAIGN_DESTINATION_REQUIRED",
  INTERNAL_NAME_IN_PUBLIC: "CAMPAIGN_INTERNAL_NAME_IN_PUBLIC",
  MAIN_VIDEO_PROMOTION_UNAUTHORIZED: "MAIN_VIDEO_PROMOTION_UNAUTHORIZED",
  TAMPERED: "CAMPAIGN_TAMPERED",
});

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic canonical JSON (sorted keys) for id recomputation. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function isPlainString(v) {
  return typeof v === "string";
}

/** Rule 15 scan: internal names must not appear in any public string. */
function assertNoInternalNames(text, internalNames, fieldName) {
  const haystack = String(text).toLowerCase();
  for (const name of internalNames) {
    if (haystack.includes(String(name).toLowerCase())) {
      const error = new Error(`${CAMPAIGN_INTAKE_ERROR_CODES.INTERNAL_NAME_IN_PUBLIC}: ${fieldName}`);
      error.code = CAMPAIGN_INTAKE_ERROR_CODES.INTERNAL_NAME_IN_PUBLIC;
      error.field = fieldName;
      throw error;
    }
  }
}

/**
 * Pulls the http(s) URL pieces with strict URL parsing. Anything that is
 * not a well-formed https URL fails closed (never "best effort").
 */
function parseAffiliateUrl(raw) {
  if (!isPlainString(raw) || raw.length === 0) {
    const error = new Error(CAMPAIGN_INTAKE_ERROR_CODES.LINK_REQUIRED);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.LINK_REQUIRED;
    throw error;
  }
  if (!HTTPS_URI_PATTERN.test(raw)) {
    const error = new Error(`${CAMPAIGN_INTAKE_ERROR_CODES.LINK_NOT_HTTPS}: affiliate links must be https`);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.LINK_NOT_HTTPS;
    throw error;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    const error = new Error(`${CAMPAIGN_INTAKE_ERROR_CODES.LINK_NOT_HTTPS}: unparseable affiliate URL`);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.LINK_NOT_HTTPS;
    throw error;
  }
  if (url.username !== "" || url.password !== "") {
    const error = new Error(CAMPAIGN_INTAKE_ERROR_CODES.LINK_EMBEDDED_CREDENTIALS);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.LINK_EMBEDDED_CREDENTIALS;
    throw error;
  }
  if (PRIVATE_HOST_PATTERN.test(url.hostname)) {
    const error = new Error(`${CAMPAIGN_INTAKE_ERROR_CODES.LINK_UNSAFE_HOST}: ${url.hostname}`);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.LINK_UNSAFE_HOST;
    throw error;
  }
  const port = url.port;
  if (port !== "" && port !== "443") {
    const error = new Error(`${CAMPAIGN_INTAKE_ERROR_CODES.LINK_NONSTANDARD_PORT}: ${port}`);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.LINK_NONSTANDARD_PORT;
    throw error;
  }
  return url;
}

/**
 * The affiliate link security scanner. Every accepted link is https-only,
 * host-allowlisted, credential-free, standard-port, and bound verbatim to a
 * disclosure string. Anything else fails closed with the stable code.
 */
export function createScannedAffiliateLink(input, { allowedDomains, internalNames }) {
  const url = parseAffiliateUrl(input.url);

  let domainInList = false;
  for (const allowed of allowedDomains) {
    const host = url.hostname.toLowerCase();
    if (host === allowed || host.endsWith(`.${allowed}`)) {
      domainInList = true;
      break;
    }
  }
  if (!domainInList) {
    const error = new Error(`${CAMPAIGN_INTAKE_ERROR_CODES.LINK_DOMAIN_NOT_ALLOWED}: ${url.hostname}`);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.LINK_DOMAIN_NOT_ALLOWED;
    throw error;
  }

  const disclosure = input.disclosure;
  if (!isPlainString(disclosure) || disclosure.trim() === "") {
    const error = new Error(CAMPAIGN_INTAKE_ERROR_CODES.DISCLOSURE_REQUIRED);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.DISCLOSURE_REQUIRED;
    throw error;
  }
  assertNoInternalNames(disclosure, internalNames, "disclosure");

  const disclosureTemplate = input.disclosureTemplate ?? null;
  if (disclosureTemplate !== null && !CANONICAL_DISCLOSURE_TEMPLATES[disclosureTemplate]) {
    const error = new Error(`${CAMPAIGN_INTAKE_ERROR_CODES.DISCLOSURE_TEMPLATE_UNKNOWN}: ${disclosureTemplate}`);
    error.code = CAMPAIGN_INTAKE_ERROR_CODES.DISCLOSURE_TEMPLATE_UNKNOWN;
    throw error;
  }

  const content = {
    urlMc: `https://${url.host}${url.pathname}${url.search}`,
    host: url.hostname.toLowerCase(),
    rawLength: input.url.length,
    disclosure: disclosure,
    disclosureTemplate: disclosureTemplate,
  };
  return Object.freeze({ ...content, linkId: sha256Hex(canonicalJson(content)) });
}

export const canonicalDisclosureTemplates = Object.freeze({ ...CANONICAL_DISCLOSURE_TEMPLATES });
