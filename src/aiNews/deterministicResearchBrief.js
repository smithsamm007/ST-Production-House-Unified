import crypto from "node:crypto";
import { PRELOADED_AGENTS } from "../catalog/agents.js";

const SECRET_MARKERS = /password|api[_ -]?key|bearer\s|vault:\/\/|opaque:\/\/|private[_ -]?key|access[_ -]?token|secret[_ -]?locator/i;
const HOSTILE_HTML_PATTERN = /<[^>]+>|javascript:|on\w+\s*=/i;
const INTERNAL_AGENT_NAMES = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map(({ name }) => name.toLowerCase()).join("|")})\\b`,
  "i"
);

function stableHash(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function validateScopeString(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length < 3 || value.length > 64) {
    throw new Error("RESEARCH_BRIEF_SCOPE_MISMATCH");
  }
  const normalized = value.trim();
  if (SECRET_MARKERS.test(normalized)) {
    throw new Error("RESEARCH_BRIEF_SECRET_REJECTED");
  }
  return normalized;
}

function validateText(value, name, minLen, maxLen) {
  if (typeof value !== "string") {
    throw new Error(`RESEARCH_BRIEF_INVALID_${name.toUpperCase()}`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < minLen || normalized.length > maxLen) {
    throw new Error("RESEARCH_BRIEF_OVERSIZED_INPUT");
  }
  if (SECRET_MARKERS.test(normalized)) {
    throw new Error("RESEARCH_BRIEF_SECRET_REJECTED");
  }
  if (HOSTILE_HTML_PATTERN.test(normalized)) {
    throw new Error("RESEARCH_BRIEF_HOSTILE_INPUT");
  }
  if (INTERNAL_AGENT_NAMES.test(normalized)) {
    throw new Error("RESEARCH_BRIEF_INTERNAL_AGENT_NAME_REJECTED");
  }
  return normalized;
}

function validateTimestamp(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 64) {
    throw new Error("RESEARCH_BRIEF_INVALID_TIMESTAMP");
  }
  const normalized = value.trim();
  if (SECRET_MARKERS.test(normalized)) {
    throw new Error("RESEARCH_BRIEF_SECRET_REJECTED");
  }
  if (HOSTILE_HTML_PATTERN.test(normalized)) {
    throw new Error("RESEARCH_BRIEF_HOSTILE_INPUT");
  }
  const parsedTime = Date.parse(normalized);
  if (Number.isNaN(parsedTime)) {
    throw new Error("RESEARCH_BRIEF_INVALID_TIMESTAMP");
  }
  return new Date(parsedTime).toISOString();
}

function validateContentHash(value) {
  if (typeof value !== "string") {
    throw new Error("RESEARCH_BRIEF_INVALID_CONTENT_HASH");
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("RESEARCH_BRIEF_INVALID_CONTENT_HASH");
  }
  return normalized;
}

function canonicalizeUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048) {
    throw new Error("RESEARCH_BRIEF_INVALID_URL");
  }
  const trimmed = rawUrl.trim();
  if (SECRET_MARKERS.test(trimmed)) {
    throw new Error("RESEARCH_BRIEF_SECRET_REJECTED");
  }
  if (HOSTILE_HTML_PATTERN.test(trimmed)) {
    throw new Error("RESEARCH_BRIEF_HOSTILE_INPUT");
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("RESEARCH_BRIEF_INVALID_URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("RESEARCH_BRIEF_UNSUPPORTED_PROTOCOL");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.includes(" ")) {
    throw new Error("RESEARCH_BRIEF_INVALID_URL");
  }

  let pathname = parsed.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.replace(/\/+$/, "");
  }

  const queryParams = Array.from(parsed.searchParams.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  const sortedQuery = queryParams.length > 0
    ? "?" + queryParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";

  const canonicalUrl = `https://${hostname}${pathname}${sortedQuery}`;
  const publisherDomain = hostname.replace(/^www\./, "");

  return { canonicalUrl, publisherDomain };
}

const OPPOSING_PAIRS = [
  ["approved", "denied"],
  ["approved", "rejected"],
  ["launched", "cancelled"],
  ["launched", "delayed"],
  ["confirmed", "denied"],
  ["confirmed", "refuted"],
  ["true", "false"],
  ["increases", "decreases"],
  ["safe", "unsafe"],
  ["succeeds", "fails"],
  ["expanded", "restricted"],
];

function detectContradictions(sources) {
  const flags = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const s1 = sources[i];
      const s2 = sources[j];
      const text1 = `${s1.headline} ${s1.excerpt}`.toLowerCase();
      const text2 = `${s2.headline} ${s2.excerpt}`.toLowerCase();

      for (const [w1, w2] of OPPOSING_PAIRS) {
        const has1_w1 = text1.includes(w1);
        const has1_w2 = text1.includes(w2);
        const has2_w1 = text2.includes(w1);
        const has2_w2 = text2.includes(w2);

        if ((has1_w1 && has2_w2 && !has1_w2 && !has2_w1) || (has1_w2 && has2_w1 && !has1_w1 && !has2_w2)) {
          const topic = `Opposing assertions (${w1} vs ${w2}) detected between reports`;
          const flagId = stableHash({ topic, sources: [s1.sourceId, s2.sourceId].sort() });

          if (!flags.some((f) => f.flagId === flagId)) {
            flags.push({
              flagId,
              topic,
              conflictingSources: [s1.sourceId, s2.sourceId].sort(),
              conflictReason: "contradictory_assertions",
            });
          }
        }
      }
    }
  }
  return flags.sort((a, b) => a.flagId.localeCompare(b.flagId));
}

export function createDeterministicResearchBrief(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("RESEARCH_BRIEF_INVALID_INPUT");
  }

  const serializedInput = JSON.stringify(input);
  if (SECRET_MARKERS.test(serializedInput)) {
    throw new Error("RESEARCH_BRIEF_SECRET_REJECTED");
  }

  const ownerId = validateScopeString(input.ownerId, "ownerId");
  const agentId = validateScopeString(input.agentId, "agentId");

  if (!Array.isArray(input.sources)) {
    throw new Error("RESEARCH_BRIEF_INVALID_SOURCES");
  }
  if (input.sources.length > 50) {
    throw new Error("RESEARCH_BRIEF_OVERSIZED_INPUT");
  }

  const rawSources = input.sources;
  const processedMap = new Map();

  for (const item of rawSources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("RESEARCH_BRIEF_INVALID_SOURCE_ITEM");
    }

    if (item.ownerId && item.ownerId !== ownerId) {
      throw new Error("RESEARCH_BRIEF_SCOPE_MISMATCH");
    }
    if (item.agentId && item.agentId !== agentId) {
      throw new Error("RESEARCH_BRIEF_SCOPE_MISMATCH");
    }

    const rawUrl = item.sourceUrl || item.url;
    const publisher = validateText(item.publisher, "publisher", 1, 200);
    const observedTimestamp = validateTimestamp(item.observedTimestamp || item.observedAt);
    const headline = validateText(item.headline, "headline", 1, 500);
    const excerpt = validateText(item.excerpt, "excerpt", 1, 5000);
    const contentHash = validateContentHash(item.contentHash || item.hash);

    const { canonicalUrl, publisherDomain } = canonicalizeUrl(rawUrl);
    const sourceId = stableHash({ canonicalUrl, contentHash });

    const sourceDescriptor = {
      sourceId,
      sourceUrl: canonicalUrl,
      publisher,
      publisherDomain,
      observedTimestamp,
      headline,
      excerpt,
      contentHash,
    };

    const dedupeKey = canonicalUrl;
    if (!processedMap.has(dedupeKey)) {
      processedMap.set(dedupeKey, sourceDescriptor);
    } else {
      const existing = processedMap.get(dedupeKey);
      if (Date.parse(observedTimestamp) < Date.parse(existing.observedTimestamp)) {
        processedMap.set(dedupeKey, sourceDescriptor);
      }
    }
  }

  const provenance = Array.from(processedMap.values())
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  const uniquePublisherDomains = new Set(provenance.map((s) => s.publisherDomain));
  const publishable = uniquePublisherDomains.size >= 2;
  const status = publishable ? "PUBLISHABLE" : "INSUFFICIENT_CORROBORATION";
  const readiness = publishable ? "publishable" : "insufficient_corroboration";

  const recencyList = [...provenance].sort(
    (a, b) => Date.parse(b.observedTimestamp) - Date.parse(a.observedTimestamp) || a.sourceId.localeCompare(b.sourceId)
  );
  const latestTimestamp = recencyList.length > 0 ? recencyList[0].observedTimestamp : null;
  const earliestTimestamp = recencyList.length > 0 ? recencyList[recencyList.length - 1].observedTimestamp : null;

  const topicGroups = new Map();
  for (const src of provenance) {
    const topicKey = src.headline.toLowerCase();
    if (!topicGroups.has(topicKey)) {
      topicGroups.set(topicKey, {
        claimText: src.headline,
        sources: [],
        domains: new Set(),
      });
    }
    const grp = topicGroups.get(topicKey);
    grp.sources.push(src.sourceId);
    grp.domains.add(src.publisherDomain);
  }

  const verifiedClaims = [];
  const unresolvedClaims = [];

  for (const [topicKey, grp] of Array.from(topicGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const claimId = stableHash({ claimText: grp.claimText, sources: grp.sources.sort() });
    if (grp.domains.size >= 2) {
      verifiedClaims.push({
        claimId,
        claimText: grp.claimText,
        corroboratedBy: Array.from(grp.domains).sort(),
        sourceIds: grp.sources.sort(),
        confidence: "verified_fact",
      });
    } else {
      unresolvedClaims.push({
        claimId,
        claimText: grp.claimText,
        publisherDomain: Array.from(grp.domains)[0],
        sourceIds: grp.sources.sort(),
        confidence: "unresolved_claim",
      });
    }
  }

  const contradictionFlags = detectContradictions(provenance);

  const briefId = stableHash({
    schemaVersion: 1,
    ownerId,
    agentId,
    status,
    provenance: provenance.map((p) => ({ url: p.sourceUrl, hash: p.contentHash })),
  });

  return Object.freeze({
    schemaVersion: 1,
    briefId,
    packageType: "ai_news_research_brief_v1",
    ownerId,
    agentId,
    status,
    readiness,
    publishable,
    summary: Object.freeze({
      totalSources: provenance.length,
      uniquePublishers: uniquePublisherDomains.size,
      publisherDomains: Array.from(uniquePublisherDomains).sort(),
      timeRange: Object.freeze({
        earliestObserved: earliestTimestamp,
        latestObserved: latestTimestamp,
      }),
    }),
    claims: Object.freeze({
      verified: Object.freeze(verifiedClaims),
      unresolved: Object.freeze(unresolvedClaims),
    }),
    contradictionFlags: Object.freeze(contradictionFlags),
    recency: Object.freeze({
      latestTimestamp,
      earliestTimestamp,
      recencyList: Object.freeze(recencyList),
    }),
    provenance: Object.freeze(provenance),
    generationMode: "deterministic_offline",
    providerCalls: Object.freeze([]),
    publication: Object.freeze({ requested: false, status: "not_requested" }),
  });
}

export { createDeterministicResearchBrief as deterministicResearchBrief };
