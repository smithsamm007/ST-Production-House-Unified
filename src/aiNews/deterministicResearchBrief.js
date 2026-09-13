/**
 * ST Production House — AI News deterministic research brief planner.
 *
 * Converts bounded, owner/agent-scoped source descriptors into a
 * provenance-first editorial brief WITHOUT fetching the network, calling
 * providers, or inventing facts. Identical inputs always produce the exact
 * same brief (deterministic SHA-256 brief ID).
 *
 * Truthfulness rules:
 * - Every claim in the output is echoed from supplied input; nothing is generated.
 * - Claims corroborated by at least two independent publisher domains are
 *   marked "corroborated"; single-source claims are marked
 *   "unverified_single_source" and never presented as fact.
 * - With fewer than two independent publisher domains the planner returns a
 *   truthful INSUFFICIENT_CORROBORATION state instead of a publishable brief.
 */

import { createHash } from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const SCHEMA_VERSION = 1;
const BRIEF_TYPE = "ai_news_research_brief";
const REQUIRED_INDEPENDENT_DOMAINS = 2;

const MAX_SOURCES = 50;
const MAX_CLAIMS_PER_SOURCE = 12;
const MAX_PAYLOAD_BYTES = 262144;

const BOUNDS = Object.freeze({
  ownerId: { min: 3, max: 64 },
  agentId: { min: 3, max: 64 },
  publisher: { min: 2, max: 120 },
  headline: { min: 5, max: 300 },
  excerpt: { min: 10, max: 2000 },
  claim: { min: 3, max: 300 },
  url: { max: 2048 }
});

const SCOPE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const STRICT_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NUMERIC_PATTERN = /\d[\d,]*(?:\.\d+)?/g;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const INTERNAL_AGENT_NAME_PATTERN = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i"
);

const SECRET_LIKE = /(?:password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|client[_ -]?secret)/i;
const RAW_HTML_LIKE = /<\s*\/?\s*[a-z][^>]*>|<\s*(?:script|iframe|style|svg|img)\b|javascript:/i;
const PRIVATE_HOST_LIKE = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.)/;

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedText(value, code, min, max) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) throw new Error(code);
  if (SECRET_LIKE.test(normalized)) throw new Error("RESEARCH_BRIEF_SECRET_REJECTED");
  if (RAW_HTML_LIKE.test(normalized)) throw new Error("RESEARCH_BRIEF_RAW_HTML_REJECTED");
  if (INTERNAL_AGENT_NAME_PATTERN.test(normalized)) throw new Error("RESEARCH_BRIEF_INTERNAL_NAME_REJECTED");
  return normalized;
}

function parseStrictIso(value, code) {
  if (typeof value !== "string" || !STRICT_ISO_PATTERN.test(value) || value.length > 40) {
    throw new Error(code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return { value, epochMs: parsed };
}

function canonicalizeSourceUrl(raw) {
  if (typeof raw !== "string" || raw.length < 9 || raw.length > BOUNDS.url.max) {
    throw new Error("RESEARCH_BRIEF_URL_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("RESEARCH_BRIEF_URL_INVALID");
  }
  if (parsed.protocol !== "https:") throw new Error("RESEARCH_BRIEF_URL_PROTOCOL_REJECTED");
  if (parsed.username || parsed.password) throw new Error("RESEARCH_BRIEF_URL_CREDENTIALS_REJECTED");
  if (parsed.port && parsed.port !== "443") throw new Error("RESEARCH_BRIEF_URL_PORT_REJECTED");

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("RESEARCH_BRIEF_URL_HOST_REJECTED");
  }
  if (host === "localhost" || PRIVATE_HOST_LIKE.test(host) || /[[\]:]/.test(host)) {
    throw new Error("RESEARCH_BRIEF_URL_HOST_REJECTED");
  }

  let pathname = parsed.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

  let search = "";
  if (parsed.searchParams.size > 0) {
    const params = [...parsed.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
    search = `?${params.join("&")}`;
  }

  return `https://${host}${pathname === "/" ? "" : pathname}${search}`;
}

function normalizeClaimText(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNumbers(text) {
  const matches = text.match(NUMERIC_PATTERN) || [];
  return [...new Set(matches.map((value) => value.replace(/,/g, "")))].sort();
}

function maskNumbers(text) {
  return normalizeClaimText(text.replace(NUMERIC_PATTERN, " # "));
}

function validateScopeId(value, code) {
  if (typeof value !== "string" || value.length < BOUNDS.ownerId.min || value.length > BOUNDS.ownerId.max) {
    throw new Error(code);
  }
  if (!SCOPE_ID_PATTERN.test(value)) throw new Error(code);
  return value;
}

function validateSourceEntry(raw, scope) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("RESEARCH_BRIEF_SOURCE_INVALID");
  }
  if (raw.ownerId !== undefined && raw.ownerId !== scope.ownerId) {
    throw new Error("RESEARCH_BRIEF_SCOPE_MISMATCH");
  }
  if (raw.agentId !== undefined && raw.agentId !== scope.agentId) {
    throw new Error("RESEARCH_BRIEF_SCOPE_MISMATCH");
  }

  const url = canonicalizeSourceUrl(raw.url);
  const publisher = boundedText(raw.publisher, "RESEARCH_BRIEF_PUBLISHER_INVALID", BOUNDS.publisher.min, BOUNDS.publisher.max);
  const headline = boundedText(raw.headline, "RESEARCH_BRIEF_HEADLINE_INVALID", BOUNDS.headline.min, BOUNDS.headline.max);
  const excerpt = boundedText(raw.excerpt, "RESEARCH_BRIEF_EXCERPT_INVALID", BOUNDS.excerpt.min, BOUNDS.excerpt.max);
  const observedAt = parseStrictIso(raw.observedAt, "RESEARCH_BRIEF_TIMESTAMP_INVALID");

  if (typeof raw.contentHash !== "string" || !SHA256_PATTERN.test(raw.contentHash)) {
    throw new Error("RESEARCH_BRIEF_CONTENT_HASH_INVALID");
  }

  let claims = [];
  if (raw.claims !== undefined) {
    if (!Array.isArray(raw.claims) || raw.claims.length > MAX_CLAIMS_PER_SOURCE) {
      throw new Error("RESEARCH_BRIEF_CLAIMS_INVALID");
    }
    claims = raw.claims.map((claim) =>
      boundedText(claim, "RESEARCH_BRIEF_CLAIM_INVALID", BOUNDS.claim.min, BOUNDS.claim.max)
    );
  }

  const publisherDomain = new URL(url).hostname;
  return {
    sourceId: sha256Hex(url),
    url,
    publisher,
    publisherDomain,
    headline,
    excerpt,
    observedAt: observedAt.value,
    observedAtEpochMs: observedAt.epochMs,
    contentHash: raw.contentHash,
    claims
  };
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("RESEARCH_BRIEF_INPUT_INVALID");
  }
  if (input.schemaVersion !== SCHEMA_VERSION) throw new Error("RESEARCH_BRIEF_SCHEMA_UNSUPPORTED");

  const payloadJson = stableStringify(input);
  if (payloadJson.length > MAX_PAYLOAD_BYTES) throw new Error("RESEARCH_BRIEF_PAYLOAD_TOO_LARGE");
  if (SECRET_LIKE.test(payloadJson)) throw new Error("RESEARCH_BRIEF_SECRET_REJECTED");

  const scope = {
    ownerId: validateScopeId(input.ownerId, "RESEARCH_BRIEF_OWNER_ID_INVALID"),
    agentId: validateScopeId(input.agentId, "RESEARCH_BRIEF_AGENT_ID_INVALID")
  };

  let asOf = null;
  if (input.asOf !== undefined && input.asOf !== null) {
    asOf = parseStrictIso(input.asOf, "RESEARCH_BRIEF_TIMESTAMP_INVALID");
  }

  if (!Array.isArray(input.sources)) throw new Error("RESEARCH_BRIEF_SOURCES_REQUIRED");
  if (input.sources.length > MAX_SOURCES) throw new Error("RESEARCH_BRIEF_TOO_MANY_SOURCES");

  const nowMs = Date.now();
  const asOfCeiling = asOf ? asOf.epochMs : nowMs;
  if (asOfCeiling - nowMs > FUTURE_TOLERANCE_MS) throw new Error("RESEARCH_BRIEF_TIMESTAMP_INVALID");

  const validated = input.sources.map((source) => {
    const entry = validateSourceEntry(source, scope);
    if (entry.observedAtEpochMs > asOfCeiling + FUTURE_TOLERANCE_MS) {
      throw new Error("RESEARCH_BRIEF_TIMESTAMP_INVALID");
    }
    return entry;
  });

  return { scope, asOf, sources: validated };
}

function deduplicateAndRank(sources) {
  const seenUrls = new Set();
  const seenHashes = new Set();
  const kept = [];
  let duplicatesRemoved = 0;

  for (const source of sources) {
    if (seenUrls.has(source.url)) {
      duplicatesRemoved += 1;
      continue;
    }
    seenUrls.add(source.url);
    // A byte-identical copy published on another domain adds no independent
    // corroboration weight; it is kept for provenance but marked ineligible.
    const corroborationEligible = !seenHashes.has(source.contentHash);
    seenHashes.add(source.contentHash);
    kept.push({ ...source, corroborationEligible });
  }

  kept.sort((a, b) =>
    a.observedAtEpochMs - b.observedAtEpochMs ||
    (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)
  );
  return { kept, duplicatesRemoved };
}

function analyzeClaims(kept) {
  const groups = new Map();
  const maskedGroups = new Map();
  for (const source of kept) {
    if (!source.corroborationEligible) continue;
    for (const claim of source.claims) {
      const key = normalizeClaimText(claim);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ source, claim });
      const masked = maskNumbers(claim);
      if (!maskedGroups.has(masked)) maskedGroups.set(masked, []);
      maskedGroups.get(masked).push({ source, claim });
    }
  }

  const verifiedClaims = [];
  const unresolvedClaims = [];
  const contradictionFlags = [];
  const processedMaskedKeys = new Set();

  const groupKeys = [...groups.keys()].sort();
  for (const key of groupKeys) {
    const entries = groups.get(key);
    const byDomain = new Map();
    for (const entry of entries) {
      if (!byDomain.has(entry.source.publisherDomain)) byDomain.set(entry.source.publisherDomain, entry);
    }
    const independent = [...byDomain.values()];
    const claimId = sha256Hex(key);
    const sortedEntries = [...entries].sort((a, b) =>
      (a.source.sourceId < b.source.sourceId ? -1 : a.source.sourceId > b.source.sourceId ? 1 : 0)
    );

    if (independent.length >= REQUIRED_INDEPENDENT_DOMAINS) {
      verifiedClaims.push({
        claimId,
        claim: sortedEntries[0].claim,
        supportingDomains: independent.map((entry) => entry.source.publisherDomain).sort(),
        supportingSourceIds: sortedEntries.map((entry) => entry.source.sourceId),
        status: "corroborated"
      });
    } else {
      unresolvedClaims.push({
        claimId,
        claim: sortedEntries[0].claim,
        supportingDomains: independent.map((entry) => entry.source.publisherDomain).sort(),
        supportingSourceIds: sortedEntries.map((entry) => entry.source.sourceId),
        status: "unverified_single_source"
      });
    }

    // Deterministic numeric-divergence detection across masked claim groups:
    // otherwise-equivalent claims reporting different numbers from independent
    // domains are flagged, never resolved by the planner.
    const maskedKey = maskNumbers(sortedEntries[0].claim);
    if (processedMaskedKeys.has(maskedKey)) continue; // one flag per masked group
    processedMaskedKeys.add(maskedKey);
    const maskedEntries = maskedGroups.get(maskedKey) || [];
    const numericByDomain = new Map();
    for (const entry of maskedEntries) {
      const numbers = extractNumbers(entry.claim);
      if (numbers.length === 0) continue;
      if (!numericByDomain.has(entry.source.publisherDomain)) {
        numericByDomain.set(entry.source.publisherDomain, { numbers: numbers.join("|"), entry });
      }
    }
    if (numericByDomain.size >= REQUIRED_INDEPENDENT_DOMAINS) {
      const distinctValues = [...new Set([...numericByDomain.values()].map((record) => record.numbers))];
      if (distinctValues.length > 1) {
        contradictionFlags.push({
          claimGroupKey: maskedKey,
          flag: "NUMERIC_DIVERGENCE",
          reports: [...numericByDomain.values()]
            .sort((a, b) => (a.entry.source.sourceId < b.entry.source.sourceId ? -1 : 1))
            .map((record) => ({
              value: record.numbers,
              sourceId: record.entry.source.sourceId,
              publisherDomain: record.entry.source.publisherDomain
            }))
        });
      }
    }
  }

  return { verifiedClaims, unresolvedClaims, contradictionFlags };
}

function buildBrief(input) {
  const { scope, asOf, sources } = validateInput(input);
  const { kept, duplicatesRemoved } = deduplicateAndRank(sources);

  const independentDomains = [
    ...new Set(kept.filter((source) => source.corroborationEligible).map((source) => source.publisherDomain))
  ].sort();
  const corroborationSatisfied = independentDomains.length >= REQUIRED_INDEPENDENT_DOMAINS;

  const { verifiedClaims, unresolvedClaims, contradictionFlags } = analyzeClaims(kept);

  const observedEpochs = kept.map((source) => source.observedAtEpochMs);
  const recency = {
    oldestObservedAt: kept.length ? kept[0].observedAt : null,
    newestObservedAt: kept.length ? kept[kept.length - 1].observedAt : null,
    asOf: asOf ? asOf.value : null,
    newestAgeHours:
      asOf && kept.length
        ? Math.max(0, Math.round(((asOf.epochMs - kept[kept.length - 1].observedAtEpochMs) / 3600000) * 100) / 100)
        : null
  };

  const briefIdSeed = stableStringify({
    schemaVersion: SCHEMA_VERSION,
    briefType: BRIEF_TYPE,
    scope,
    asOf: recency.asOf,
    sources: kept.map((source) => ({
      url: source.url,
      publisher: source.publisher,
      observedAt: source.observedAt,
      headline: source.headline,
      excerpt: source.excerpt,
      contentHash: source.contentHash,
      claims: source.claims
    }))
  });

  const common = {
    schemaVersion: SCHEMA_VERSION,
    briefType: BRIEF_TYPE,
    briefId: sha256Hex(briefIdSeed),
    generationMode: "deterministic_local",
    scope,
    corroboration: {
      requiredIndependentDomains: REQUIRED_INDEPENDENT_DOMAINS,
      independentDomainCount: independentDomains.length,
      independentDomains,
      satisfied: corroborationSatisfied
    },
    sources: kept.map((source) => ({
      sourceId: source.sourceId,
      url: source.url,
      publisher: source.publisher,
      publisherDomain: source.publisherDomain,
      observedAt: source.observedAt,
      contentHash: source.contentHash,
      headline: source.headline,
      excerpt: source.excerpt,
      claims: source.claims,
      corroborationEligible: source.corroborationEligible,
      status: "included"
    })),
    duplicatesRemoved,
    verifiedClaims,
    unresolvedClaims,
    contradictionFlags,
    recency,
    provenance: {
      networkFetches: 0,
      providerCalls: 0,
      inventedFacts: 0,
      note: "All content is echoed from supplied provenance; no text was generated, fetched, or synthesized."
    },
    generatedNarrative: null,
    generatedMedia: [],
    publication: { requested: false, status: "not_requested" }
  };

  if (!corroborationSatisfied) {
    return Object.freeze({
      ...common,
      readiness: "insufficient_corroboration",
      reasonCode: "INSUFFICIENT_CORROBORATION",
      verifiedClaims: [],
      publishable: false
    });
  }

  return Object.freeze({
    ...common,
    readiness: "ready_for_editorial_review",
    reasonCode: null,
    publishable: false
  });
}

export {
  SCHEMA_VERSION,
  BRIEF_TYPE,
  REQUIRED_INDEPENDENT_DOMAINS,
  MAX_SOURCES,
  MAX_CLAIMS_PER_SOURCE,
  MAX_PAYLOAD_BYTES,
  BOUNDS,
  buildBrief as createDeterministicResearchBrief,
  canonicalizeSourceUrl,
  normalizeClaimText
};
