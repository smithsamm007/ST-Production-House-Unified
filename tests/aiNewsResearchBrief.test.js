import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicResearchBrief,
  canonicalizeSourceUrl,
  normalizeClaimText,
  REQUIRED_INDEPENDENT_DOMAINS,
  MAX_SOURCES
} from "../src/aiNews/deterministicResearchBrief.js";

const OWNER = "owner-alpha";
const AGENT = "agent-ai-news";

function source(overrides = {}) {
  return {
    url: "https://example-news.example/article/one",
    publisher: "Example News",
    observedAt: "2026-09-01T10:00:00Z",
    headline: "Regulator approves new solar grid plan",
    excerpt: "The national regulator approved a plan to expand the solar grid across three states starting next year.",
    contentHash: "b".repeat(64),
    claims: ["The solar grid will expand across three states"],
    ...overrides
  };
}

function validInput(overrides = {}) {
  return {
    schemaVersion: 1,
    ownerId: OWNER,
    agentId: AGENT,
    asOf: "2026-09-02T00:00:00Z",
    sources: [
      source(),
      source({
        url: "https://second-domain.example/story/approval",
        publisher: "Second Wire",
        contentHash: "c".repeat(64)
      })
    ],
    ...overrides
  };
}

// ------------------------------------------------------------
// Determinism & brief identity
// ------------------------------------------------------------
test("research brief: identical inputs produce identical brief IDs and content", () => {
  const a = createDeterministicResearchBrief(validInput());
  const b = createDeterministicResearchBrief(validInput());
  assert.equal(a.briefId, b.briefId);
  assert.deepEqual(a, b);
});

test("research brief: source order does not change the brief ID", () => {
  const ordered = validInput();
  const reversed = validInput();
  reversed.sources = [...reversed.sources].reverse();
  const a = createDeterministicResearchBrief(ordered);
  const b = createDeterministicResearchBrief(reversed);
  assert.equal(a.briefId, b.briefId);
});

test("research brief: different inputs produce different brief IDs", () => {
  const a = createDeterministicResearchBrief(validInput());
  const b = createDeterministicResearchBrief(validInput({ asOf: "2026-09-03T00:00:00Z" }));
  assert.notEqual(a.briefId, b.briefId);
});

// ------------------------------------------------------------
// Corroboration policy
// ------------------------------------------------------------
test("research brief: fewer than two independent domains returns truthful INSUFFICIENT_CORROBORATION", () => {
  const brief = createDeterministicResearchBrief(validInput({ sources: [source()] }));
  assert.equal(brief.readiness, "insufficient_corroboration");
  assert.equal(brief.reasonCode, "INSUFFICIENT_CORROBORATION");
  assert.equal(brief.publishable, false);
  assert.equal(brief.verifiedClaims.length, 0);
  assert.equal(brief.corroboration.independentDomainCount, 1);
  assert.equal(brief.corroboration.satisfied, false);
});

test("research brief: two independent domains satisfy corroboration and verify shared claims", () => {
  const brief = createDeterministicResearchBrief(validInput());
  assert.equal(brief.readiness, "ready_for_editorial_review");
  assert.equal(brief.corroboration.satisfied, true);
  assert.equal(brief.corroboration.independentDomainCount, 2);
  assert.equal(brief.publishable, false, "brief is never auto-publishable; owner review is required");
  assert.equal(brief.verifiedClaims.length, 1);
  assert.equal(brief.verifiedClaims[0].status, "corroborated");
  assert.deepEqual(brief.verifiedClaims[0].supportingDomains, [
    "example-news.example",
    "second-domain.example"
  ]);
});

test("research brief: single-source claims stay unresolved and never become fact", () => {
  const brief = createDeterministicResearchBrief(
    validInput({
      sources: [
        source(),
        source({
          url: "https://second-domain.example/story/approval",
          publisher: "Second Wire",
          headline: "Second wire files separate weather report",
          excerpt: "A separate story about monsoon rainfall totals recorded across coastal districts this week.",
          contentHash: "c".repeat(64),
          claims: ["Monsoon rainfall exceeded seasonal averages"]
        })
      ]
    })
  );
  assert.equal(brief.readiness, "ready_for_editorial_review");
  assert.equal(brief.verifiedClaims.length, 0);
  assert.equal(brief.unresolvedClaims.length, 2);
  assert.ok(brief.unresolvedClaims.every((claim) => claim.status === "unverified_single_source"));
});

test("research brief: duplicate syndicated copy on another domain adds no independent corroboration", () => {
  const brief = createDeterministicResearchBrief(
    validInput({
      sources: [
        source(),
        source({ url: "https://syndication.example/copy/one", publisher: "Syndication Desk", contentHash: "b".repeat(64) })
      ]
    })
  );
  assert.equal(brief.reasonCode, "INSUFFICIENT_CORROBORATION");
  assert.equal(brief.corroboration.independentDomainCount, 1);
  assert.equal(brief.duplicatesRemoved, 0);
  const syndicated = brief.sources.find((entry) => entry.publisherDomain === "syndication.example");
  assert.equal(syndicated.corroborationEligible, false);
});

test("research brief: exact URL duplicates are dropped and counted", () => {
  const brief = createDeterministicResearchBrief(
    validInput({ sources: [source(), source(), source()] })
  );
  assert.equal(brief.sources.length, 1);
  assert.equal(brief.duplicatesRemoved, 2);
});

// ------------------------------------------------------------
// Contradiction detection
// ------------------------------------------------------------
test("research brief: numeric divergence between independent domains is flagged, not resolved", () => {
  const brief = createDeterministicResearchBrief(
    validInput({
      sources: [
        source({ claims: ["The dam water level reached 205 feet today"] }),
        source({
          url: "https://second-domain.example/story/approval",
          publisher: "Second Wire",
          headline: "Second wire reports dam level figure",
          excerpt: "Officials stated the dam water level reached 221 feet during the evening inspection round.",
          contentHash: "d".repeat(64),
          claims: ["The dam water level reached 221 feet today"]
        })
      ]
    })
  );
  assert.equal(brief.contradictionFlags.length, 1);
  assert.equal(brief.contradictionFlags[0].flag, "NUMERIC_DIVERGENCE");
  assert.equal(brief.contradictionFlags[0].reports.length, 2);
  assert.deepEqual(
    brief.contradictionFlags[0].reports.map((report) => report.value).sort(),
    ["205", "221"]
  );
});

// ------------------------------------------------------------
// Hostile URL handling
// ------------------------------------------------------------
test("research brief: rejects non-HTTPS, private, and malformed URLs", () => {
  const hostileUrls = [
    "http://example-news.example/article/one",
    "ftp://example-news.example/article",
    "https://user:pass@example-news.example/a",
    "https://example-news.example:8443/a",
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/admin",
    "https://intranet.internal/leak",
    "not a url at all",
    ""
  ];
  for (const url of hostileUrls) {
    assert.throws(
      () => createDeterministicResearchBrief(validInput({ sources: [source({ url })] })),
      /RESEARCH_BRIEF_URL_(INVALID|PROTOCOL_REJECTED|CREDENTIALS_REJECTED|PORT_REJECTED|HOST_REJECTED)/,
      `expected rejection for ${url}`
    );
  }
});

test("research brief: canonicalizes URLs for deduplication (scheme, case, trailing slash, param order)", () => {
  assert.equal(
    canonicalizeSourceUrl("HTTPS://EXAMPLE-News.example/a/"),
    "https://example-news.example/a"
  );
  assert.equal(
    canonicalizeSourceUrl("https://example-news.example/s?b=2&a=1"),
    "https://example-news.example/s?a=1&b=2"
  );
  assert.equal(
    canonicalizeSourceUrl("https://example-news.example:443/same"),
    "https://example-news.example/same"
  );
});

// ------------------------------------------------------------
// Secret rejection, raw HTML, internal names, scope isolation
// ------------------------------------------------------------
test("research brief: rejects secret-like fields anywhere in the payload", () => {
  const leaks = [
    validInput({ sources: [source({ excerpt: "Service note: password=hunter22 embedded in config" })] }),
    validInput({ sources: [source({ excerpt: "Read the api_key from the response headers" })] }),
    validInput({ sources: [source({ url: "https://vault://secret-manager/keys" })] })
  ];
  for (const input of leaks) {
    assert.throws(() => createDeterministicResearchBrief(input), /RESEARCH_BRIEF_(SECRET_REJECTED|URL_INVALID)/);
  }
});

test("research brief: rejects raw HTML and script content in text fields", () => {
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: [source({ headline: "<script>alert(1)</script>" })] })),
    /RESEARCH_BRIEF_RAW_HTML_REJECTED/
  );
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: [source({ excerpt: "Body with <img src=x onerror=alert(1)> inside" })] })),
    /RESEARCH_BRIEF_RAW_HTML_REJECTED/
  );
});

test("research brief: rejects internal agent names in provenance text (Rule 15)", () => {
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: [source({ publisher: "JARVIS Media" })] })),
    /RESEARCH_BRIEF_INTERNAL_NAME_REJECTED/
  );
});

test("research brief: rejects cross-owner and cross-agent scoped sources", () => {
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: [source({ ownerId: "owner-beta" })] })),
    /RESEARCH_BRIEF_SCOPE_MISMATCH/
  );
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: [source({ agentId: "agent-other" })] })),
    /RESEARCH_BRIEF_SCOPE_MISMATCH/
  );
});

// ------------------------------------------------------------
// Input bounds and malformed inputs
// ------------------------------------------------------------
test("research brief: rejects malformed timestamps and future observations", () => {
  const badTimestamps = ["2026-09-01 10:00", "not-a-time", 12345, "2026-13-45T99:00:00Z", ""];
  for (const observedAt of badTimestamps) {
    assert.throws(
      () => createDeterministicResearchBrief(validInput({ sources: [source({ observedAt })] })),
      /RESEARCH_BRIEF_TIMESTAMP_INVALID/,
      `expected rejection for ${String(observedAt)}`
    );
  }
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ asOf: "2030-01-01T00:00:00Z" })),
    /RESEARCH_BRIEF_TIMESTAMP_INVALID/
  );
});

test("research brief: enforces source count, claim count, and content-hash bounds", () => {
  const tooMany = Array.from({ length: MAX_SOURCES + 1 }, (_, index) =>
    source({ url: `https://domain-${index}.example/story/${index}` })
  );
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: tooMany })),
    /RESEARCH_BRIEF_TOO_MANY_SOURCES/
  );
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: [source({ claims: ["no"] })] })),
    /RESEARCH_BRIEF_CLAIM_INVALID/
  );
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: [source({ claims: Array.from({ length: 13 }, (_, i) => `claim number ${i} is here`) })] })),
    /RESEARCH_BRIEF_CLAIMS_INVALID/
  );
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ sources: [source({ contentHash: "deadbeef" })] })),
    /RESEARCH_BRIEF_CONTENT_HASH_INVALID/
  );
});

test("research brief: rejects wrong schema version and non-object input", () => {
  assert.throws(() => createDeterministicResearchBrief(validInput({ schemaVersion: 2 })), /RESEARCH_BRIEF_SCHEMA_UNSUPPORTED/);
  assert.throws(() => createDeterministicResearchBrief(null), /RESEARCH_BRIEF_INPUT_INVALID/);
  assert.throws(() => createDeterministicResearchBrief([source()]), /RESEARCH_BRIEF_INPUT_INVALID/);
  assert.throws(
    () => createDeterministicResearchBrief(validInput({ ownerId: "o!" })),
    /RESEARCH_BRIEF_OWNER_ID_INVALID/
  );
});

// ------------------------------------------------------------
// Honesty markers & stability
// ------------------------------------------------------------
test("research brief: output carries explicit zero-network zero-provider provenance", () => {
  const brief = createDeterministicResearchBrief(validInput());
  assert.equal(brief.generationMode, "deterministic_local");
  assert.equal(brief.provenance.networkFetches, 0);
  assert.equal(brief.provenance.providerCalls, 0);
  assert.equal(brief.provenance.inventedFacts, 0);
  assert.equal(brief.generatedNarrative, null);
  assert.deepEqual(brief.generatedMedia, []);
  assert.equal(brief.publication.status, "not_requested");
});

test("research brief: source ordering is deterministic and recency bounds are truthful", () => {
  const brief = createDeterministicResearchBrief(
    validInput({
      sources: [
        source({ url: "https://z-domain.example/article", publisher: "Zeta", observedAt: "2026-09-01T12:00:00Z" }),
        source({ url: "https://a-domain.example/article", publisher: "Alpha", observedAt: "2026-09-01T06:00:00Z" })
      ]
    })
  );
  assert.equal(brief.sources[0].publisherDomain, "a-domain.example");
  assert.equal(brief.sources[1].publisherDomain, "z-domain.example");
  assert.equal(brief.recency.oldestObservedAt, "2026-09-01T06:00:00Z");
  assert.equal(brief.recency.newestObservedAt, "2026-09-01T12:00:00Z");
  assert.equal(brief.recency.newestAgeHours, 12);
});

test("research brief: claims are normalized consistently for grouping", () => {
  assert.equal(normalizeClaimText("The Grid — expanded by 40%!"), "the grid expanded by 40");
  assert.equal(normalizeClaimText("  THE   GRID  expanded "), "the grid expanded");
});
