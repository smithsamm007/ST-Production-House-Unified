import test from "node:test";
import assert from "node:assert/strict";
import { deterministicJarvisContentHandler } from "../src/jarvis/deterministicContentWorkflow.js";
import {
  createDeterministicMetadataThumbnailPlan,
  deterministicMetadataThumbnailPlanHandler,
} from "../src/jarvis/deterministicMetadataThumbnailPlan.js";

async function outline(overrides = {}) {
  return deterministicJarvisContentHandler({
    agentId: "agent-01",
    jobType: "jarvis.content.outline.v1",
    payload: {
      publicBrand: "Raat Ki Awaaz",
      concept: "Ek sunsaan pahadi hostel mein band kamre se har raat kisi bachche ki ghanti sunai deti hai.",
      language: "hinglish",
      targetMinutes: 27,
      ...overrides,
    },
    heartbeat() {},
    checkpoint: async () => {},
  });
}

test("creates deterministic draft metadata and a thumbnail brief without claims or assets", async () => {
  const source = await outline();
  const first = createDeterministicMetadataThumbnailPlan(source);
  const second = createDeterministicMetadataThumbnailPlan(source);
  assert.deepEqual(second, first);
  assert.equal(first.readiness, "metadata_thumbnail_plan_only");
  assert.equal(first.metadataDraft.status, "draft_only");
  assert.equal(first.metadataDraft.titleVariants.length, 3);
  assert.equal(first.metadataDraft.hashtags.length, 3);
  assert.deepEqual(first.metadataDraft.seoPerformanceClaims, []);
  assert.deepEqual(first.metadataDraft.urls, []);
  assert.equal(first.thumbnailBrief.status, "brief_only");
  assert.equal(first.thumbnailBrief.generatedAsset, null);
  assert.deepEqual(first.generatedAssets, []);
  assert.deepEqual(first.providerCalls, []);
  assert.equal(first.publication.status, "not_requested");
  assert.doesNotMatch(JSON.stringify(first), /viral|trending|guaranteed|views|ctr/i);
});

test("produces a Hindi draft and records planning-only checkpoints", async () => {
  const source = await outline({ language: "hindi" });
  const checkpoints = [];
  const context = {
    agentId: "agent-01",
    jobType: "jarvis.content.metadata-thumbnail-plan.v1",
    payload: { outlinePackage: source },
    heartbeat() {},
    checkpoint: async (...entry) => checkpoints.push(entry),
  };
  const plan = await deterministicMetadataThumbnailPlanHandler(context);
  assert.match(plan.metadataDraft.titleVariants[0], /अनसुलझा रहस्य/);
  assert.match(plan.thumbnailBrief.overlayText, /सच अभी बाकी/);
  assert.deepEqual(checkpoints.map(([step]) => step), ["metadata_source_validated", "metadata_thumbnail_plan_ready"]);
  await assert.rejects(deterministicMetadataThumbnailPlanHandler({ ...context, agentId: "agent-02" }), /SCOPE_MISMATCH/);
  await assert.rejects(deterministicMetadataThumbnailPlanHandler({ ...context, jobType: "jarvis.content.outline.v1" }), /SCOPE_MISMATCH/);
});

test("rejects malformed, non-local, secret-bearing, internal-name and unsafe-URL inputs", async () => {
  const source = await outline();
  assert.throws(() => createDeterministicMetadataThumbnailPlan({ ...source, readiness: "metadata_ready" }), /SOURCE_CONTRACT_MISMATCH/);
  assert.throws(() => createDeterministicMetadataThumbnailPlan({ ...source, providerCalls: [{ provider: "paid" }] }), /SOURCE_NOT_LOCAL/);
  assert.throws(() => createDeterministicMetadataThumbnailPlan({ ...source, suppliedConcept: "A long enough concept containing api_key=unsafe-value for rejection." }), /SECRET_REJECTED/);
  assert.throws(() => createDeterministicMetadataThumbnailPlan({ ...source, publicBrand: "JARVIS Horror" }), /INTERNAL_NAME_REJECTED/);
  assert.throws(() => createDeterministicMetadataThumbnailPlan({ ...source, publicBrand: "BYTE Horror" }), /INTERNAL_NAME_REJECTED/);
  assert.throws(() => createDeterministicMetadataThumbnailPlan({ ...source, suppliedConcept: "A long enough public story concept that accidentally names NISHA as its internal agent." }), /INTERNAL_NAME_REJECTED/);
  assert.throws(() => createDeterministicMetadataThumbnailPlan({ ...source, suppliedConcept: "A long enough story concept with https://unsafe.example/path embedded inside." }), /UNSAFE_URL_REJECTED/);
  assert.throws(() => createDeterministicMetadataThumbnailPlan({ ...source, storyOutline: source.storyOutline.slice(1) }), /BEATS_INVALID/);
});
