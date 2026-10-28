import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicResearchBrief,
  REQUIRED_INDEPENDENT_DOMAINS
} from "../src/aiNews/deterministicResearchBrief.js";
import { createDeterministicEditorialPlan } from "../src/aiNews/deterministicEditorialPlan.js";
import { createDeterministicMetadataPlan } from "../src/aiNews/deterministicMetadataPlan.js";

const OWNER = "owner-alpha";
const AGENT = "agent-ai-news";

function source(overrides = {}) {
  return {
    url: "https://www.theverge.com/news/example-story",
    publisher: "The Verge",
    headline: "Model release cycle accelerates across the industry",
    excerpt: "Multiple vendors report faster release cadence this quarter.",
    observedAt: "2026-09-13T10:00:00Z",
    contentHash: "a".repeat(64),
    claims: ["Vendors report faster release cadence this quarter"],
    ...overrides
  };
}

function briefInput(overrides = {}) {
  return {
    schemaVersion: 1,
    ownerId: OWNER,
    agentId: AGENT,
    asOf: "2026-09-13T12:00:00Z",
    sources: [
      source(),
      source({
        url: "https://arstechnica.com/information-technology/example-story/",
        publisher: "Ars Technica",
        contentHash: "b".repeat(64)
      })
    ],
    ...overrides
  }
}

function readyBrief(overrides = {}) {
  const brief = createDeterministicResearchBrief(briefInput(overrides));
  if (brief.readiness !== "ready_for_editorial_review") {
    throw new Error(`test setup: brief not ready (${brief.reasonCode})`);
  }
  return brief;
}

function editorialPlanInput(overrides = {}) {
  return {
    schemaVersion: 1,
    brief: readyBrief(),
    publicBrand: "AI Headline Desk",
    language: "hinglish",
    tone: "explainer",
    format: "explainer_standard",
    targetSeconds: 120,
    ...overrides
  };
}

function readyPlan(overrides = {}) {
  return createDeterministicEditorialPlan(editorialPlanInput(overrides));
}

function metadataInput(overrides = {}) {
  return {
    schemaVersion: 1,
    brief: readyBrief(),
    editorialPlan: readyPlan(),
    ...overrides
  };
}

// ------------------------------------------------------------
// Deterministic happy path
// ------------------------------------------------------------
test("metadata plan: deterministic id and identical output for identical inputs", () => {
  const first = createDeterministicMetadataPlan(metadataInput());
  const second = createDeterministicMetadataPlan(metadataInput());
  assert.deepEqual(first, second);
  assert.ok(/^[a-f0-9]{64}$/.test(first.planId));
  assert.equal(first.planType, "ai_news_metadata_thumbnail_plan");
  assert.equal(first.readiness, "metadata_thumbnail_plan_only");
});

test("metadata plan: drafts echo supplied provenance, never invent content", () => {
  const plan = createDeterministicMetadataPlan(metadataInput());
  const brief = metadataInput().brief;
  assert.ok(plan.metadataDraft.titleVariants.length >= 2);
  // A headline variant is an echo of a real source headline (sorted-prefix match)
  const headline = brief.sources.find((source) => source.corroborationEligible).headline;
  assert.ok(plan.metadataDraft.titleVariants.some((title) => title.includes(headline.slice(0, 30))));
  // Description names the real independent domains from the brief
  for (const domain of brief.corroboration.independentDomains) {
    assert.ok(plan.metadataDraft.description.includes(domain));
  }
  assert.ok(plan.metadataDraft.description.includes(String(brief.corroboration.independentDomainCount)));
  assert.ok(plan.sourceAttribution.independentDomainCount >= REQUIRED_INDEPENDENT_DOMAINS);
  // Thumbnail brief is brief-only
  assert.equal(plan.thumbnailBrief.generatedAsset, null);
  assert.equal(plan.thumbnailBrief.assetReference, null);
  assert.deepEqual(plan.generatedAssets, []);
  assert.deepEqual(plan.providerCalls, []);
  assert.equal(plan.provenance.providerCalls, 0);
  assert.equal(plan.provenance.inventedNumbers, 0);
  assert.equal(plan.publication.status, "not_requested");
});

test("metadata plan: overlay text comes from the factual allowlist", () => {
  for (const language of ["hindi", "hinglish", "english"]) {
    const plan = createDeterministicMetadataPlan(metadataInput({ editorialPlan: readyPlan({ language }) }));
    assert.equal(plan.thumbnailBrief.overlayText, plan.metadataDraft.titleVariants ? plan.thumbnailBrief.overlayText : null);
    assert.equal(plan.thumbnailBrief.overlayText, {
      hindi: "दो स्वतंत्र स्रोतों ने पुष्टि की",
      hinglish: "2 INDEPENDENT SOURCES CONFIRM",
      english: "2 INDEPENDENT SOURCES CONFIRM"
    }[language]);
  }
});

test("metadata plan: different briefs produce different plan ids", () => {
  const briefB = readyBrief({
    sources: [
      source(),
      source({
        url: "https://www.wired.com/story/example-different/",
        publisher: "WIRED",
        contentHash: "c".repeat(64)
      })
    ]
  });
  const planA = createDeterministicMetadataPlan(metadataInput());
  // The editorial plan must be rebuilt from the SAME brief it is paired with.
  const planB = createDeterministicMetadataPlan(
    metadataInput({ brief: briefB, editorialPlan: readyPlan({ brief: briefB }) })
  );
  assert.notEqual(planA.planId, planB.planId);
});

// ------------------------------------------------------------
// Honest blocking
// ------------------------------------------------------------
test("metadata plan: blocked editorial plan yields truthful blocked metadata result", () => {
  const brief = createDeterministicResearchBrief(briefInput({ sources: [source()] })); // single source → unverified
  const plan = createDeterministicEditorialPlan(editorialPlanInput({ brief }));
  assert.equal(plan.readiness, "blocked");
  const result = createDeterministicMetadataPlan(metadataInput({ brief, editorialPlan: plan }));
  assert.equal(result.readiness, "blocked");
  assert.equal(result.reasonCode, "BRIEF_INSUFFICIENT_CORROBORATION");
  assert.equal(result.metadataDraft, null);
  assert.equal(result.thumbnailBrief, null);
  assert.equal(result.publication.status, "not_requested");
});

// ------------------------------------------------------------
// Fail-closed validation
// ------------------------------------------------------------
test("metadata plan: rejects malformed and tampered inputs", () => {
  assert.throws(() => createDeterministicMetadataPlan(null), /METADATA_PLAN_INPUT_INVALID/);
  assert.throws(() => createDeterministicMetadataPlan(metadataInput({ schemaVersion: 2 })), /METADATA_PLAN_SCHEMA_UNSUPPORTED/);
  assert.throws(
    () => createDeterministicMetadataPlan(metadataInput({ brief: { ...metadataInput().brief, briefType: "other" } })),
    /METADATA_PLAN_BRIEF_CONTRACT_MISMATCH/
  );
  assert.throws(
    () => createDeterministicMetadataPlan(
      metadataInput({ brief: { ...metadataInput().brief, provenance: { providerCalls: 2 } } })
    ),
    /METADATA_PLAN_BRIEF_NOT_LOCAL/
  );
  assert.throws(() => createDeterministicMetadataPlan(metadataInput({ editorialPlan: undefined })), /METADATA_PLAN_EDITORIAL_PLAN_INVALID/);
  assert.throws(
    () => createDeterministicMetadataPlan(metadataInput({ editorialPlan: { ...readyPlan(), planType: "other" } })),
    /METADATA_PLAN_EDITORIAL_PLAN_CONTRACT_MISMATCH/
  );
  assert.throws(
    () => createDeterministicMetadataPlan(metadataInput({ editorialPlan: { ...readyPlan(), generationMode: "remote" } })),
    /METADATA_PLAN_EDITORIAL_PLAN_NOT_LOCAL/
  );
  assert.throws(
    () => createDeterministicMetadataPlan(metadataInput({ editorialPlan: { ...readyPlan(), planId: "0".repeat(64) } })),
    /METADATA_PLAN_EDITORIAL_PLAN_ID_MISMATCH/
  );
  // brief/plan binding must fail
  const otherBrief = readyBrief({
    sources: [
      source(),
      source({ url: "https://www.wired.com/story/other/", publisher: "WIRED", contentHash: "c".repeat(64) })
    ]
  });
  assert.throws(
    () => createDeterministicMetadataPlan(metadataInput({ brief: otherBrief })),
    /METADATA_PLAN_BRIEF_PLAN_MISMATCH/
  );
});

test("metadata plan: secrets, internal agent names, and non-local plans are rejected", () => {
  assert.throws(
    () => createDeterministicMetadataPlan(
      metadataInput({ editorialPlan: { ...readyPlan(), publicBrand: "AI Desk api_key=abc" } })
    ),
    /METADATA_PLAN_SECRET_REJECTED/
  );
  assert.throws(
    () => createDeterministicMetadataPlan(
      metadataInput({ editorialPlan: { ...readyPlan(), publicBrand: "News by NISHA" } })
    ),
    /METADATA_PLAN_INTERNAL_NAME_REJECTED/
  );
  assert.throws(
    () => createDeterministicMetadataPlan(metadataInput({ brief: { ...readyBrief(), scope: { ownerId: OWNER, agentId: "agent-x" } } })),
    /METADATA_PLAN_AGENT_MISMATCH/
  );
});

test("metadata plan: publication-state tampering on the editorial plan is rejected", () => {
  const tamperedPlan = { ...readyPlan(), publication: { requested: true, status: "requested" } };
  assert.throws(
    () => createDeterministicMetadataPlan(metadataInput({ editorialPlan: tamperedPlan })),
    /METADATA_PLAN_EDITORIAL_PLAN_PUBLICATION_STATE_INVALID/
  );
});
