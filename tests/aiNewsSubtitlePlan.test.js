import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicResearchBrief
} from "../src/aiNews/deterministicResearchBrief.js";
import { createDeterministicEditorialPlan } from "../src/aiNews/deterministicEditorialPlan.js";
import {
  createDeterministicSubtitlePlan,
  createNarrationInputRegistry
} from "../src/aiNews/deterministicSubtitlePlan.js";

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

function registryInput(overrides = {}) {
  return {
    schemaVersion: 1,
    ownerId: OWNER,
    agentId: AGENT,
    language: "hinglish",
    segments: [
      {
        segmentId: "seg-001",
        text: "Model release cycles are accelerating across the industry this quarter.",
        startTime: 0,
        endTime: 6
      },
      {
        segmentId: "seg-002",
        text: "Two independent publishers confirmed the faster cadence report.",
        speaker: "anchor",
        startTime: 6.5,
        endTime: 12
      }
    ],
    ...overrides
  };
}

function registry(overrides = {}) {
  return createNarrationInputRegistry(registryInput(overrides));
}

function planInput(overrides = {}) {
  return {
    schemaVersion: 1,
    brief: readyBrief(),
    editorialPlan: readyPlan(),
    narration: registry(),
    ...overrides
  };
}

// ------------------------------------------------------------
// Narration input registry
// ------------------------------------------------------------
test("registry: deterministic id, frozen output, and normalized segments", () => {
  const first = registry();
  const second = registry();
  assert.deepEqual(first, second);
  assert.ok(/^[a-f0-9]{64}$/.test(first.registryId));
  assert.equal(first.registryType, "ai_news_narration_registry");
  assert.equal(first.agentId, AGENT);
  assert.equal(first.segmentCount, 2);
  assert.equal(first.totalDurationSeconds, 12);
  assert.equal(first.segments[0].speaker, "narrator");
  assert.equal(first.segments[1].speaker, "anchor");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.segments[0]), true);
  // Timings are normalized to millisecond precision
  assert.equal(first.segments[1].startTime, 6.5);
});

test("registry: different segments or owners produce different ids", () => {
  const baseline = registry();
  const otherSegments = registry({
    segments: [{ segmentId: "seg-009", text: "A different narration line entirely.", startTime: 0, endTime: 4 }]
  });
  const otherOwner = registry({ ownerId: "owner-beta" });
  assert.notEqual(baseline.registryId, otherSegments.registryId);
  assert.notEqual(baseline.registryId, otherOwner.registryId);
});

test("registry: fail-closed validation with stable codes", () => {
  assert.throws(() => createNarrationInputRegistry(null), /SUBTITLE_REGISTRY_INPUT_INVALID/);
  assert.throws(() => registry({ schemaVersion: 2 }), /SUBTITLE_REGISTRY_SCHEMA_UNSUPPORTED/);
  assert.throws(() => registry({ ownerId: "no" }), /SUBTITLE_REGISTRY_OWNER_INVALID/);
  assert.throws(() => registry({ ownerId: 42 }), /SUBTITLE_REGISTRY_OWNER_INVALID/);
  assert.throws(() => registry({ agentId: "agent-x" }), /SUBTITLE_REGISTRY_AGENT_MISMATCH/);
  assert.throws(() => registry({ language: "klingon" }), /SUBTITLE_REGISTRY_LANGUAGE_UNSUPPORTED/);
  assert.throws(() => registry({ segments: [] }), /SUBTITLE_SEGMENTS_INVALID/);
  assert.throws(() => registry({ segments: "nope" }), /SUBTITLE_SEGMENTS_INVALID/);
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "hi", startTime: 0, endTime: 1 }, "bogus"] }),
    /SUBTITLE_SEGMENT_MALFORMED/
  );
  assert.throws(
    () => registry({ segments: [{ text: "no id", startTime: 0, endTime: 1 }] }),
    /SUBTITLE_SEGMENT_ID_INVALID/
  );
  assert.throws(
    () => registry({
      segments: [
        { segmentId: "dup", text: "one", startTime: 0, endTime: 1 },
        { segmentId: "dup", text: "two", startTime: 1, endTime: 2 }
      ]
    }),
    /SUBTITLE_SEGMENT_DUPLICATE_ID/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "   ", startTime: 0, endTime: 1 }] }),
    /SUBTITLE_TEXT_INVALID/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "ok", startTime: -1, endTime: 1 }] }),
    /SUBTITLE_TIMING_INVALID/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "ok", startTime: 5, endTime: 5 }] }),
    /SUBTITLE_TIMING_INVALID/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "ok", startTime: 0, endTime: Number.NaN }] }),
    /SUBTITLE_TIMING_INVALID/
  );
  assert.throws(
    () => registry({
      segments: [
        { segmentId: "s1", text: "first", startTime: 0, endTime: 5 },
        { segmentId: "s2", text: "overlap", startTime: 4, endTime: 8 }
      ]
    }),
    /SUBTITLE_TIMING_OVERLAP_DETECTED/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "long", startTime: 0, endTime: 61 }] }),
    /SUBTITLE_SEGMENT_DURATION_EXCESSIVE/
  );
  assert.throws(
    () => registry({
      segments: [{ segmentId: "s", text: "long", startTime: 0, endTime: 901 }]
    }),
    /SUBTITLE_SEGMENT_DURATION_EXCESSIVE/
  );
});

test("registry: secrets, internal agent names, and markup are rejected (Rules 15/17)", () => {
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "key is api_key=abc123", startTime: 0, endTime: 1 }] }),
    /SUBTITLE_SECRET_REJECTED/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "vault://kv/creds", startTime: 0, endTime: 1 }] }),
    /SUBTITLE_SECRET_REJECTED/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "reported by JARVIS desk", startTime: 0, endTime: 1 }] }),
    /SUBTITLE_INTERNAL_NAME_REJECTED/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "<script>alert(1)</script>", startTime: 0, endTime: 1 }] }),
    /SUBTITLE_MARKUP_UNSUPPORTED/
  );
  assert.throws(
    () => registry({ segments: [{ segmentId: "s", text: "ok", speaker: "user api_key=x", startTime: 0, endTime: 1 }] }),
    /SUBTITLE_SECRET_REJECTED/
  );
});

// ------------------------------------------------------------
// Deterministic subtitle plan — happy path
// ------------------------------------------------------------
test("subtitle plan: deterministic id and identical output for identical inputs", () => {
  const first = createDeterministicSubtitlePlan(planInput());
  const second = createDeterministicSubtitlePlan(planInput());
  assert.deepEqual(first, second);
  assert.ok(/^[a-f0-9]{64}$/.test(first.planId));
  assert.equal(first.planType, "ai_news_subtitle_plan");
  assert.equal(first.readiness, "subtitle_plan_only");
  assert.equal(first.generationMode, "deterministic_local");
  assert.equal(first.agentId, AGENT);
  assert.equal(first.language, "hinglish");
});

test("subtitle plan: cues echo supplied narration text only, split at word boundaries", () => {
  const plan = createDeterministicSubtitlePlan(planInput());
  const segments = registryInput().segments;
  const cues = plan.longFormPlan.cues;
  assert.ok(cues.length >= 2);
  // Concatenated cue text reconstructs exactly the supplied narration (echo-only)
  const echoed = cues.map((cue) => cue.text).join(" ");
  assert.equal(echoed, `${segments[0].text} ${segments[1].text}`);
  // Speaker labels echo supplied speakers (or the narrator default)
  assert.deepEqual(
    [...new Set(cues.map((cue) => cue.speaker))].sort(),
    plan.narrationEcho.speakers
  );
});

test("subtitle plan: cue timing is bounded, monotonic, and well-formatted", () => {
  const plan = createDeterministicSubtitlePlan(planInput());
  const cues = plan.longFormPlan.cues;
  let previousEnd = 0;
  for (const [index, cue] of cues.entries()) {
    assert.ok(cue.text.length <= 42, `cue ${index} exceeds 42 chars`);
    assert.ok(cue.durationSeconds <= 7, `cue ${index} exceeds 7 seconds`);
    assert.ok(cue.startTime >= previousEnd, `cue ${index} overlaps its predecessor`);
    assert.ok(cue.endTime > cue.startTime);
    assert.equal(cue.sequence, index + 1);
    assert.match(cue.startTimeSRT, /^\d{2}:\d{2}:\d{2},\d{3}$/);
    assert.match(cue.endTimeVTT, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.equal(cue.srtFormatted, `${cue.sequence}\n${cue.startTimeSRT} --> ${cue.endTimeSRT}\n${cue.text}`);
    previousEnd = cue.endTime;
  }
  // Long-form 16:9 profile plus the vertical adaptation of the SAME timeline
  assert.equal(plan.longFormPlan.aspectRatio, "16:9");
  assert.equal(plan.longFormPlan.width, 1920);
  assert.equal(plan.shortsAdaptation.aspectRatio, "9:16");
  assert.equal(plan.shortsAdaptation.width, 1080);
  assert.equal(plan.shortsAdaptation.totalCues, plan.longFormPlan.totalCues);
  assert.deepEqual(plan.shortsAdaptation.cues, plan.longFormPlan.cues);
});

test("subtitle plan: provenance is truthful — zero generation, zero publication", () => {
  const plan = createDeterministicSubtitlePlan(planInput());
  assert.deepEqual(plan.generatedMedia, []);
  assert.deepEqual(plan.providerCalls, []);
  assert.deepEqual(plan.artifacts, []);
  assert.equal(plan.provenance.providerCalls, 0);
  assert.equal(plan.provenance.networkFetches, 0);
  assert.equal(plan.provenance.inventedFacts, 0);
  assert.equal(plan.provenance.inventedNumbers, 0);
  assert.equal(plan.provenance.inventedNarrationSegments, 0);
  assert.equal(plan.publication.requested, false);
  assert.equal(plan.publication.status, "not_requested");
});

test("subtitle plan: different briefs or registries produce different plan ids", () => {
  const planA = createDeterministicSubtitlePlan(planInput());
  const briefB = readyBrief({
    sources: [
      source(),
      source({ url: "https://www.wired.com/story/example-different/", publisher: "WIRED", contentHash: "c".repeat(64) })
    ]
  });
  const planB = createDeterministicSubtitlePlan(
    planInput({ brief: briefB, editorialPlan: readyPlan({ brief: briefB }) })
  );
  const planC = createDeterministicSubtitlePlan(
    planInput({
      narration: registry({
        segments: [{ segmentId: "seg-x", text: "Another verified narration line.", startTime: 0, endTime: 3 }]
      })
    })
  );
  assert.notEqual(planA.planId, planB.planId);
  assert.notEqual(planA.planId, planC.planId);
});

// ------------------------------------------------------------
// Honest blocking
// ------------------------------------------------------------
test("subtitle plan: blocked editorial plan yields truthful blocked subtitle result", () => {
  const brief = createDeterministicResearchBrief(briefInput({ sources: [source()] })); // single source → unverified
  const plan = createDeterministicEditorialPlan(editorialPlanInput({ brief }));
  assert.equal(plan.readiness, "blocked");
  const result = createDeterministicSubtitlePlan(planInput({ brief, editorialPlan: plan }));
  assert.equal(result.readiness, "blocked");
  assert.equal(result.reasonCode, "BRIEF_INSUFFICIENT_CORROBORATION");
  assert.equal(result.planId, null);
  assert.equal(result.longFormPlan, null);
  assert.equal(result.shortsAdaptation, null);
  assert.deepEqual(result.generatedMedia, []);
  assert.equal(result.provenance.providerCalls, 0);
  assert.equal(result.publication.status, "not_requested");
});

// ------------------------------------------------------------
// Fail-closed plan validation
// ------------------------------------------------------------
test("subtitle plan: rejects malformed, mismatched, and tampered inputs", () => {
  assert.throws(() => createDeterministicSubtitlePlan(null), /SUBTITLE_PLAN_INPUT_INVALID/);
  assert.throws(() => createDeterministicSubtitlePlan(planInput({ schemaVersion: 2 })), /SUBTITLE_PLAN_SCHEMA_UNSUPPORTED/);
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ brief: { ...planInput().brief, briefType: "other" } })),
    /SUBTITLE_BRIEF_CONTRACT_MISMATCH/
  );
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ brief: { ...planInput().brief, provenance: { providerCalls: 3 } } })),
    /SUBTITLE_BRIEF_NOT_LOCAL/
  );
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ brief: { ...planInput().brief, scope: { ownerId: OWNER, agentId: "agent-x" } } })),
    /SUBTITLE_BRIEF_AGENT_MISMATCH/
  );
  assert.throws(() => createDeterministicSubtitlePlan(planInput({ editorialPlan: undefined })), /SUBTITLE_EDITORIAL_PLAN_INVALID/);
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ editorialPlan: { ...readyPlan(), planType: "other" } })),
    /SUBTITLE_EDITORIAL_PLAN_CONTRACT_MISMATCH/
  );
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ editorialPlan: { ...readyPlan(), generationMode: "remote" } })),
    /SUBTITLE_EDITORIAL_PLAN_NOT_LOCAL/
  );
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ editorialPlan: { ...readyPlan(), planId: "0".repeat(64) } })),
    /SUBTITLE_EDITORIAL_PLAN_ID_MISMATCH/
  );
  assert.throws(
    () => createDeterministicSubtitlePlan(
      planInput({ editorialPlan: { ...readyPlan(), publication: { requested: true, status: "requested" } } })
    ),
    /SUBTITLE_EDITORIAL_PLAN_PUBLICATION_STATE_INVALID/
  );
  // brief/plan binding must fail
  const otherBrief = readyBrief({
    sources: [
      source(),
      source({ url: "https://www.wired.com/story/other/", publisher: "WIRED", contentHash: "c".repeat(64) })
    ]
  });
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ brief: otherBrief })),
    /SUBTITLE_BRIEF_PLAN_MISMATCH/
  );
});

test("subtitle plan: rejects invalid, tampered, or mismatched narration registries", () => {
  assert.throws(() => createDeterministicSubtitlePlan(planInput({ narration: undefined })), /SUBTITLE_REGISTRY_INVALID/);
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ narration: { ...registry(), registryType: "other" } })),
    /SUBTITLE_REGISTRY_INVALID/
  );
  // Tampered segment text under the original registryId cannot ride in
  const tampered = {
    ...registry(),
    segments: registry().segments.map((segment) => ({ ...segment, text: "mutated narration text" }))
  };
  assert.throws(() => createDeterministicSubtitlePlan(planInput({ narration: tampered })), /SUBTITLE_REGISTRY_ID_MISMATCH/);

  // Language must match the editorial plan
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ editorialPlan: readyPlan({ language: "english" }), narration: registry() })),
    /SUBTITLE_REGISTRY_LANGUAGE_MISMATCH/
  );
  // Owner must match the brief scope
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ narration: registry({ ownerId: "owner-beta" }) })),
    /SUBTITLE_REGISTRY_OWNER_MISMATCH/
  );
});

test("subtitle plan: secrets in the plan payload are rejected (Rule 17)", () => {
  const secretRegistry = {
    ...registry(),
    segments: registry().segments.map((segment) => ({ ...segment, text: "see vault://kv/token for details" }))
  };
  assert.throws(
    () => createDeterministicSubtitlePlan(planInput({ narration: secretRegistry })),
    /SUBTITLE_SECRET_REJECTED/
  );
});
