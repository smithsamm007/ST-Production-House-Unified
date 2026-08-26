import test from "node:test";
import assert from "node:assert/strict";
import { createDeterministicResearchBrief, deterministicResearchBrief } from "../src/aiNews/deterministicResearchBrief.js";

const VALID_HASH_1 = "a".repeat(64);
const VALID_HASH_2 = "b".repeat(64);
const VALID_HASH_3 = "c".repeat(64);

function createSampleSource(overrides = {}) {
  return {
    sourceUrl: "https://techcrunch.com/2025/01/01/ai-breakthrough",
    publisher: "TechCrunch",
    observedTimestamp: "2025-01-01T12:00:00.000Z",
    headline: "Major AI Model Release Announced",
    excerpt: "A leading lab announced a new model with open weights.",
    contentHash: VALID_HASH_1,
    ...overrides,
  };
}

function createSampleInput(overrides = {}) {
  return {
    ownerId: "owner-101",
    agentId: "agent-01",
    sources: [
      createSampleSource(),
      createSampleSource({
        sourceUrl: "https://arstechnica.com/ai/2025/01/open-model",
        publisher: "Ars Technica",
        observedTimestamp: "2025-01-01T13:00:00.000Z",
        headline: "Major AI Model Release Announced",
        excerpt: "Independent benchmark reports verify open weights model.",
        contentHash: VALID_HASH_2,
      }),
    ],
    ...overrides,
  };
}

test("createDeterministicResearchBrief is exported as alias deterministicResearchBrief", () => {
  assert.equal(createDeterministicResearchBrief, deterministicResearchBrief);
});

test("determinism: 100 runs on identical inputs yield identical brief ID and deep equal output", () => {
  const input = createSampleInput();
  const baseline = createDeterministicResearchBrief(input);
  assert.ok(baseline.briefId);
  assert.equal(baseline.generationMode, "deterministic_offline");
  assert.deepEqual(baseline.providerCalls, []);

  for (let i = 0; i < 100; i++) {
    const run = createDeterministicResearchBrief(input);
    assert.equal(run.briefId, baseline.briefId);
    assert.deepEqual(run, baseline);
  }
});

test("canonicalizes HTTPS URLs and deduplicates offline", () => {
  const input = createSampleInput({
    sources: [
      createSampleSource({
        sourceUrl: "HTTPS://TECHCRUNCH.COM:443/2025/01/01/ai-breakthrough/?z=2&a=1",
        observedTimestamp: "2025-01-01T10:00:00.000Z",
        contentHash: VALID_HASH_1,
      }),
      createSampleSource({
        sourceUrl: "https://techcrunch.com/2025/01/01/ai-breakthrough?a=1&z=2",
        observedTimestamp: "2025-01-01T12:00:00.000Z",
        contentHash: VALID_HASH_1,
      }),
      createSampleSource({
        sourceUrl: "https://arstechnica.com/ai/model/",
        publisher: "Ars Technica",
        observedTimestamp: "2025-01-01T11:00:00.000Z",
        contentHash: VALID_HASH_2,
      }),
    ],
  });

  const brief = createDeterministicResearchBrief(input);
  assert.equal(brief.provenance.length, 2);
  const tcSource = brief.provenance.find((s) => s.publisherDomain === "techcrunch.com");
  assert.ok(tcSource);
  assert.equal(tcSource.sourceUrl, "https://techcrunch.com/2025/01/01/ai-breakthrough?a=1&z=2");
  assert.equal(tcSource.observedTimestamp, "2025-01-01T10:00:00.000Z");

  const arsSource = brief.provenance.find((s) => s.publisherDomain === "arstechnica.com");
  assert.ok(arsSource);
  assert.equal(arsSource.sourceUrl, "https://arstechnica.com/ai/model");
});

test("corroboration: single publisher domain returns INSUFFICIENT_CORROBORATION state", () => {
  const input = createSampleInput({
    sources: [
      createSampleSource({ sourceUrl: "https://techcrunch.com/story-1", contentHash: VALID_HASH_1 }),
      createSampleSource({ sourceUrl: "https://techcrunch.com/story-2", contentHash: VALID_HASH_2, headline: "Other Tech Story" }),
    ],
  });

  const brief = createDeterministicResearchBrief(input);
  assert.equal(brief.status, "INSUFFICIENT_CORROBORATION");
  assert.equal(brief.readiness, "insufficient_corroboration");
  assert.equal(brief.publishable, false);
  assert.equal(brief.summary.uniquePublishers, 1);
  assert.equal(brief.claims.verified.length, 0);
  assert.equal(brief.claims.unresolved.length, 2);
  assert.equal(brief.claims.unresolved[0].confidence, "unresolved_claim");
});

test("corroboration: two independent publisher domains return PUBLISHABLE state", () => {
  const input = createSampleInput();
  const brief = createDeterministicResearchBrief(input);
  assert.equal(brief.status, "PUBLISHABLE");
  assert.equal(brief.readiness, "publishable");
  assert.equal(brief.publishable, true);
  assert.equal(brief.summary.uniquePublishers, 2);
  assert.equal(brief.claims.verified.length, 1);
  assert.equal(brief.claims.verified[0].confidence, "verified_fact");
  assert.deepEqual(brief.claims.verified[0].corroboratedBy, ["arstechnica.com", "techcrunch.com"]);
});

test("contradiction detection: flags opposing assertions across source reports", () => {
  const input = createSampleInput({
    sources: [
      createSampleSource({
        sourceUrl: "https://techcrunch.com/deal",
        publisher: "TechCrunch",
        headline: "Acquisition Deal Approved by Regulator",
        excerpt: "The regulatory body confirmed the acquisition deal is approved.",
        contentHash: VALID_HASH_1,
      }),
      createSampleSource({
        sourceUrl: "https://arstechnica.com/deal",
        publisher: "Ars Technica",
        headline: "Acquisition Deal Denied by Regulator",
        excerpt: "The regulatory body confirmed the acquisition deal is denied.",
        contentHash: VALID_HASH_2,
      }),
    ],
  });

  const brief = createDeterministicResearchBrief(input);
  assert.ok(brief.contradictionFlags.length > 0);
  assert.equal(brief.contradictionFlags[0].conflictReason, "contradictory_assertions");
  assert.equal(brief.contradictionFlags[0].conflictingSources.length, 2);
});

test("rejects hostile URLs and unsupported protocols", () => {
  const hostileUrls = [
    "http://techcrunch.com/story",
    "ftp://files.example.com/news.txt",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://example.com/<script>alert(1)</script>",
    "https://example.com/path?param=<iframe src=x>",
  ];

  for (const hostileUrl of hostileUrls) {
    const input = createSampleInput({
      sources: [createSampleSource({ sourceUrl: hostileUrl })],
    });
    assert.throws(() => createDeterministicResearchBrief(input), (err) => {
      return err.message === "RESEARCH_BRIEF_UNSUPPORTED_PROTOCOL" ||
             err.message === "RESEARCH_BRIEF_INVALID_URL" ||
             err.message === "RESEARCH_BRIEF_HOSTILE_INPUT";
    });
  }
});

test("rejects raw HTML and script injection in text fields", () => {
  const hostileTexts = [
    "<script>alert('xss')</script>",
    "Headline with <iframe src='evil.com'></iframe>",
    "Excerpt containing javascript:void(0)",
    "Publisher <div onload='bad()'>News</div>",
  ];

  for (const hostileText of hostileTexts) {
    assert.throws(() => createDeterministicResearchBrief(createSampleInput({
      sources: [createSampleSource({ headline: hostileText })],
    })), /RESEARCH_BRIEF_HOSTILE_INPUT/);

    assert.throws(() => createDeterministicResearchBrief(createSampleInput({
      sources: [createSampleSource({ excerpt: hostileText })],
    })), /RESEARCH_BRIEF_HOSTILE_INPUT/);

    assert.throws(() => createDeterministicResearchBrief(createSampleInput({
      sources: [createSampleSource({ publisher: hostileText })],
    })), /RESEARCH_BRIEF_HOSTILE_INPUT/);
  }
});

test("rejects secret-like fields in inputs", () => {
  const secretPayloads = [
    { headline: "Secret key api_key=secret12345 in headline" },
    { excerpt: "Includes vault://locators/secret" },
    { publisher: "News bearer token123" },
    { ownerId: "owner-opaque://secret" },
    { sources: [createSampleSource({ contentHash: VALID_HASH_1 }), "password=123"] },
  ];

  for (const payload of secretPayloads) {
    const input = createSampleInput(payload);
    assert.throws(() => createDeterministicResearchBrief(input), /RESEARCH_BRIEF_SECRET_REJECTED/);
  }
});

test("rejects public text containing internal agent names", () => {
  const forbiddenNames = ["JARVIS", "Sherlock", "LAKME", "Panchi", "Veda"];

  for (const name of forbiddenNames) {
    assert.throws(() => createDeterministicResearchBrief(createSampleInput({
      sources: [createSampleSource({ headline: `Analysis by ${name} on AI` })],
    })), /RESEARCH_BRIEF_INTERNAL_AGENT_NAME_REJECTED/);

    assert.throws(() => createDeterministicResearchBrief(createSampleInput({
      sources: [createSampleSource({ publisher: `${name} Publishing` })],
    })), /RESEARCH_BRIEF_INTERNAL_AGENT_NAME_REJECTED/);
  }
});

test("scope isolation: rejects cross-owner/agent scope mismatch and missing scope", () => {
  assert.throws(() => createDeterministicResearchBrief(createSampleInput({ ownerId: "" })), /RESEARCH_BRIEF_SCOPE_MISMATCH/);
  assert.throws(() => createDeterministicResearchBrief(createSampleInput({ agentId: "ab" })), /RESEARCH_BRIEF_SCOPE_MISMATCH/);

  const mismatchedOwner = createSampleInput({
    ownerId: "owner-101",
    sources: [createSampleSource({ ownerId: "owner-999" })],
  });
  assert.throws(() => createDeterministicResearchBrief(mismatchedOwner), /RESEARCH_BRIEF_SCOPE_MISMATCH/);

  const mismatchedAgent = createSampleInput({
    agentId: "agent-01",
    sources: [createSampleSource({ agentId: "agent-02" })],
  });
  assert.throws(() => createDeterministicResearchBrief(mismatchedAgent), /RESEARCH_BRIEF_SCOPE_MISMATCH/);
});

test("input bounds: rejects oversized sources, string length violations, bad timestamps, and bad content hashes", () => {
  const oversizedSources = Array.from({ length: 51 }, (_, i) =>
    createSampleSource({
      sourceUrl: `https://publisher${i}.com/news`,
      publisher: `Publisher ${i}`,
      contentHash: (i.toString(16).padStart(64, "0")),
    })
  );
  assert.throws(() => createDeterministicResearchBrief(createSampleInput({ sources: oversizedSources })), /RESEARCH_BRIEF_OVERSIZED_INPUT/);

  assert.throws(() => createDeterministicResearchBrief(createSampleInput({
    sources: [createSampleSource({ headline: "x".repeat(501) })],
  })), /RESEARCH_BRIEF_OVERSIZED_INPUT/);

  assert.throws(() => createDeterministicResearchBrief(createSampleInput({
    sources: [createSampleSource({ excerpt: "x".repeat(5001) })],
  })), /RESEARCH_BRIEF_OVERSIZED_INPUT/);

  assert.throws(() => createDeterministicResearchBrief(createSampleInput({
    sources: [createSampleSource({ observedTimestamp: "invalid-date-string" })],
  })), /RESEARCH_BRIEF_INVALID_TIMESTAMP/);

  assert.throws(() => createDeterministicResearchBrief(createSampleInput({
    sources: [createSampleSource({ contentHash: "not-a-valid-hash" })],
  })), /RESEARCH_BRIEF_INVALID_CONTENT_HASH/);
});
