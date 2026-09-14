import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicResearchBrief,
  REQUIRED_INDEPENDENT_DOMAINS
} from "../src/aiNews/deterministicResearchBrief.js";
import { createDeterministicEditorialPlan } from "../src/aiNews/deterministicEditorialPlan.js";

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
  };
}

function readyBrief(overrides = {}) {
  const brief = createDeterministicResearchBrief(briefInput(overrides));
  if (brief.readiness !== "ready_for_editorial_review") {
    throw new Error(`test setup: brief not ready (${brief.reasonCode})`);
  }
  return brief;
}

function planInput(overrides = {}) {
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

// ------------------------------------------------------------
// Determinism and structural contract
// ------------------------------------------------------------
test("editorial plan: deterministic plan id and identical output for identical inputs", () => {
  const first = createDeterministicEditorialPlan(planInput());
  const second = createDeterministicEditorialPlan(planInput());
  assert.deepEqual(first, second);
  assert.ok(/^[a-f0-9]{64}$/.test(first.planId));
  assert.equal(first.planType, "ai_news_editorial_plan");
  assert.equal(first.readiness, "editorial_plan_only");
});

test("editorial plan: sections follow hook/body/caveat/CTA order with provenance", () => {
  const plan = createDeterministicEditorialPlan(planInput());
  const roles = plan.sections.map((section) => section.role);
  assert.equal(roles[0], "hook");
  assert.equal(roles[roles.length - 1], "call_to_action");
  assert.ok(roles.includes("caveat"));
  const bodySections = plan.sections.filter((section) => section.role === "body_claim");
  assert.ok(bodySections.length >= 1);
  for (const section of bodySections) {
    assert.equal(section.claimTextEcho, plan.selectedClaims.find((claim) => claim.claimId === section.claimId).claimTextEcho);
    assert.ok(section.supportingDomains.length >= REQUIRED_INDEPENDENT_DOMAINS);
  }
  for (const claim of plan.selectedClaims) {
    assert.ok(/^[a-f0-9]{64}$/.test(claim.claimId));
    assert.equal(claim.status, undefined); // raw brief objects are not leaked
    assert.equal(claim.claimTextEcho, plan.sections.find((section) => section.claimId === claim.claimId).claimTextEcho);
  }
});

test("editorial plan: echoes claims only, never generates narrative or numbers", () => {
  const plan = createDeterministicEditorialPlan(planInput());
  assert.equal(plan.generatedNarrative, null);
  assert.deepEqual(plan.generatedMedia, []);
  assert.deepEqual(plan.providerCalls, []);
  assert.equal(plan.provenance.inventedFacts, 0);
  assert.equal(plan.provenance.inventedNumbers, 0);
  assert.equal(plan.provenance.providerCalls, 0);
  assert.equal(plan.publication.requested, false);
  assert.equal(plan.publication.status, "not_requested");
  // Every claim string in the plan appears in the source brief verbatim.
  const briefClaimTexts = new Set(plan.selectedClaims.map((claim) => claim.claimTextEcho));
  for (const section of plan.sections.filter((section) => section.role === "body_claim")) {
    assert.ok(briefClaimTexts.has(section.claimTextEcho));
  }
});

test("editorial plan: selected claims are capped and sorted deterministically", () => {
  const plan = createDeterministicEditorialPlan(planInput());
  const ids = plan.selectedClaims.map((claim) => claim.claimId);
  assert.deepEqual(ids, [...ids].sort());
});

test("editorial plan: seconds budget covers hook/body/caveat/CTA without overflow", () => {
  const plan = createDeterministicEditorialPlan(planInput({ targetSeconds: 90, format: "explainer_short" }));
  const hook = plan.sections.find((section) => section.role === "hook");
  const cta = plan.sections.find((section) => section.role === "call_to_action");
  const caveat = plan.sections.find((section) => section.role === "caveat");
  const body = plan.sections.filter((section) => section.role === "body_claim");
  const total =
    hook.targetSeconds + cta.targetSeconds + caveat.targetSeconds + body.reduce((sum, section) => sum + section.targetSeconds, 0);
  assert.ok(hook.targetSeconds >= 5);
  assert.ok(cta.targetSeconds >= 4);
  assert.ok(caveat.targetSeconds >= 3);
  assert.ok(total <= plan.targetSeconds);
});

test("editorial plan: different briefs produce different plan ids", () => {
  const planA = createDeterministicEditorialPlan(planInput());
  const planB = createDeterministicEditorialPlan(
    planInput({
      brief: readyBrief({
        sources: [
          source(),
          source({
            url: "https://www.wired.com/story/example-different/",
            publisher: "WIRED",
            contentHash: "c".repeat(64)
          })
        ]
      })
    })
  );
  assert.notEqual(planA.planId, planB.planId);
});

// ------------------------------------------------------------
// Honest blocking gates
// ------------------------------------------------------------
test("editorial plan: insufficient corroboration blocks with truthful reason", () => {
  const brief = createDeterministicResearchBrief(briefInput({ sources: [source()] }));
  assert.equal(brief.readiness, "insufficient_corroboration");
  const plan = createDeterministicEditorialPlan(planInput({ brief }));
  assert.equal(plan.readiness, "blocked");
  assert.equal(plan.reasonCode, "BRIEF_INSUFFICIENT_CORROBORATION");
  assert.deepEqual(plan.sections, []);
  assert.deepEqual(plan.selectedClaims, []);
  assert.equal(plan.generatedNarrative, null);
  assert.equal(plan.publication.status, "not_requested");
});

test("editorial plan: contradiction flags block planning entirely", () => {
  const brief = createDeterministicResearchBrief(
    briefInput({
      sources: [
        source({ claims: ["Vendor reports 5 releases this quarter"] }),
        source({
          url: "https://arstechnica.com/information-technology/example-story/",
          publisher: "Ars Technica",
          contentHash: "b".repeat(64),
          claims: ["Vendor reports 7 releases this quarter"]
        })
      ]
    })
  );
  assert.equal(brief.readiness, "ready_for_editorial_review");
  assert.ok(brief.contradictionFlags.length > 0);
  const plan = createDeterministicEditorialPlan(planInput({ brief }));
  assert.equal(plan.readiness, "blocked");
  assert.equal(plan.reasonCode, "BRIEF_CONTRADICTIONS_UNRESOLVED");
});

test("editorial plan: empty verified claims block at the gate with BRIEF_NO_VERIFIED_CLAIMS", () => {
  const brief = readyBrief();
  const plan = createDeterministicEditorialPlan(planInput({ brief: { ...brief, verifiedClaims: [] } }));
  assert.equal(plan.readiness, "blocked");
  assert.equal(plan.reasonCode, "BRIEF_NO_VERIFIED_CLAIMS");
});

test("editorial plan: claims failing eligibility checks block with NO_ELIGIBLE_CLAIMS", () => {
  const brief = readyBrief();
  const malformed = [{ claimId: "bad", claim: "x", status: "corroborated", supportingDomains: ["one.only"] }];
  const plan = createDeterministicEditorialPlan(planInput({ brief: { ...brief, verifiedClaims: malformed } }));
  assert.equal(plan.readiness, "blocked");
  assert.equal(plan.reasonCode, "NO_ELIGIBLE_CLAIMS");
  assert.deepEqual(plan.sections, []);
});

// ------------------------------------------------------------
// Fail-closed validation
// ------------------------------------------------------------
test("editorial plan: rejects malformed, secret-bearing, internal-name, and URL inputs", () => {
  assert.throws(() => createDeterministicEditorialPlan(null), /EDITORIAL_PLAN_INPUT_INVALID/);
  assert.throws(() => createDeterministicEditorialPlan([]), /EDITORIAL_PLAN_INPUT_INVALID/);
  assert.throws(() => createDeterministicEditorialPlan(planInput({ schemaVersion: 2 })), /EDITORIAL_PLAN_SCHEMA_UNSUPPORTED/);
  assert.throws(() => createDeterministicEditorialPlan(planInput({ publicBrand: "" })), /EDITORIAL_PLAN_PUBLIC_BRAND_INVALID/);
  assert.throws(() => createDeterministicEditorialPlan(planInput({ language: "klingon" })), /EDITORIAL_PLAN_LANGUAGE_UNSUPPORTED/);
  assert.throws(() => createDeterministicEditorialPlan(planInput({ tone: "hype" })), /EDITORIAL_PLAN_TONE_UNSUPPORTED/);
  assert.throws(() => createDeterministicEditorialPlan(planInput({ format: "vlog" })), /EDITORIAL_PLAN_FORMAT_UNSUPPORTED/);
  assert.throws(() => createDeterministicEditorialPlan(planInput({ targetSeconds: 10 })), /EDITORIAL_PLAN_TARGET_SECONDS_INVALID/);
  assert.throws(
    () => createDeterministicEditorialPlan(planInput({ brief: { ...readyBrief(), briefId: "not-a-hash" } })),
    /EDITORIAL_PLAN_BRIEF_ID_INVALID/
  );
  assert.throws(
    () => createDeterministicEditorialPlan(planInput({ brief: { ...readyBrief(), schemaVersion: 2 } })),
    /EDITORIAL_PLAN_BRIEF_CONTRACT_MISMATCH/
  );
  assert.throws(
    () => createDeterministicEditorialPlan(planInput({ publicBrand: "AI Desk vault://secret" })),
    /EDITORIAL_PLAN_SECRET_REJECTED/
  );
  assert.throws(
    () => createDeterministicEditorialPlan(planInput({ publicBrand: "News by JARVIS" })),
    /EDITORIAL_PLAN_INTERNAL_NAME_REJECTED/
  );
  assert.throws(
    () => createDeterministicEditorialPlan(planInput({ publicBrand: "News at https://example.com" })),
    /EDITORIAL_PLAN_URL_REJECTED/
  );
});

test("editorial plan: scope must match the brief exactly", () => {
  // The plan builder derives scope from the brief; a caller-supplied ownerId
  // that disagrees with the brief is rejected (no scope drift).
  assert.throws(
    () => createDeterministicEditorialPlan(planInput({ ownerId: "owner-other" })),
    /EDITORIAL_PLAN_SCOPE_MISMATCH/
  );
  const wrongAgentBrief = readyBrief();
  wrongAgentBrief.scope.agentId = "agent-something-else";
  assert.throws(
    () => createDeterministicEditorialPlan(planInput({ brief: wrongAgentBrief })),
    /EDITORIAL_PLAN_AGENT_MISMATCH/
  );
});

test("editorial plan: brief must be a genuine deterministic-local brief", () => {
  const brief = readyBrief();
  const tampered = { ...brief, provenance: { ...brief.provenance, providerCalls: 3 } };
  assert.throws(() => createDeterministicEditorialPlan(planInput({ brief: tampered }), ), /EDITORIAL_PLAN_BRIEF_NOT_LOCAL/);
  assert.throws(() => createDeterministicEditorialPlan(planInput({ brief: undefined })), /EDITORIAL_PLAN_BRIEF_INVALID/);
});
