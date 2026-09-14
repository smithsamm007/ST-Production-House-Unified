import test from "node:test";
import assert from "node:assert/strict";
import { AiNewsContentPackageOrchestrator } from "../src/aiNews/contentPackageOrchestrator.js";
import { WorkerRuntime } from "../src/workers/workerRuntime.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

class TestCheckpointAdapter {
  constructor() {
    this.name = "TestCheckpointAdapter";
    this.store = new Map();
  }
  async get(key) {
    return this.store.get(key) || null;
  }
  async set(key, value) {
    this.store.set(key, value);
  }
}

class TestIdempotencyStore {
  constructor() {
    this.name = "TestIdempotencyStore";
    this.store = new Map();
  }
  async get(key) {
    return this.store.get(key) || null;
  }
  async set(key, value) {
    this.store.set(key, value);
  }
}

function makeOrchestrator({ withLedger = false } = {}) {
  const checkpointStore = new CheckpointStore(new TestCheckpointAdapter());
  const runtime = new WorkerRuntime({ idempotencyStore: new TestIdempotencyStore(), isTestEnv: true });
  const evidenceLedger = withLedger ? new EvidenceLedger() : undefined;
  const orchestrator = new AiNewsContentPackageOrchestrator({ runtime, checkpointStore, evidenceLedger });
  return { orchestrator, checkpointStore, evidenceLedger };
}

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

function validInput(overrides = {}) {
  return {
    packageTaskId: "pkg-ainews-001",
    ownerId: "owner-alpha",
    asOf: "2026-09-13T12:00:00Z",
    sources: [
      source(),
      source({
        url: "https://arstechnica.com/information-technology/example-story/",
        publisher: "Ars Technica",
        contentHash: "b".repeat(64)
      })
    ],
    publicBrand: "AI Headline Desk",
    language: "hinglish",
    tone: "explainer",
    format: "explainer_standard",
    targetSeconds: 120,
    ...overrides
  };
}

const TIMED_SEGMENTS = [
  { segmentId: "seg-1", text: "Model release cycles are accelerating across the industry this quarter.", startTime: 0, endTime: 6 },
  { segmentId: "seg-2", text: "Two independent publishers confirmed the faster cadence report.", speaker: "anchor", startTime: 6.5, endTime: 12 }
];

// ------------------------------------------------------------
// Full workflow through the real stage functions
// ------------------------------------------------------------
test("orchestrator: runs the deterministic stages and returns the full package", async () => {
  const { orchestrator } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(validInput());

  assert.equal(result.orchestrator, "ai_news_content_package_v1");
  assert.equal(result.readiness, "package_incomplete_pending_narration_input");
  assert.equal(result.agentId, "agent-ai-news");
  assert.ok(/^[a-f0-9]{64}$/.test(result.packageId));
  assert.ok(/^[a-f0-9]{64}$/.test(result.briefId));
  assert.equal(result.researchBrief.briefType, "ai_news_research_brief");
  assert.equal(result.researchBrief.readiness, "ready_for_editorial_review");
  assert.equal(result.editorialPlan.planType, "ai_news_editorial_plan");
  assert.equal(result.editorialPlan.readiness, "editorial_plan_only");
  assert.equal(result.metadataThumbnailPlan.planType, "ai_news_metadata_thumbnail_plan");
  assert.equal(result.metadataThumbnailPlan.readiness, "metadata_thumbnail_plan_only");
  assert.equal(result.subtitlePlan, null);
  assert.equal(result.stages.length, 4);
  assert.ok(result.stages.slice(0, 3).every((stage) => stage.status === "completed"));
  const subtitleStage = result.stages[3];
  assert.equal(subtitleStage.status, "skipped_pending_input");
  assert.equal(subtitleStage.reasonCode, "NARRATION_REGISTRY_REQUIRED");
  assert.equal(result.provenance.providerCalls, 0);
  assert.equal(result.provenance.networkCalls, 0);
  assert.equal(result.provenance.generatedMediaCount, 0);
  assert.equal(result.provenance.mediaStatus, "not_generated");
  assert.equal(result.publication.status, "not_requested");
});

test("orchestrator: completes the subtitle stage when the owner supplies timed narration", async () => {
  const { orchestrator } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(validInput({ timedNarrationSegments: TIMED_SEGMENTS }));

  assert.equal(result.readiness, "deterministic_package_complete");
  assert.ok(result.subtitlePlan);
  assert.equal(result.subtitlePlan.planType, "ai_news_subtitle_plan");
  assert.ok(result.subtitlePlan.longFormPlan.cues.length > 0);
  assert.ok(result.stages.every((stage) => stage.status === "completed"));
  // Registry binding: the plan echoes the registered narration id
  assert.ok(/^[a-f0-9]{64}$/.test(result.subtitlePlan.registryId));
});

test("orchestrator: timed narration validation fails closed", async () => {
  const { orchestrator } = makeOrchestrator();
  const badInputs = [
    validInput({ timedNarrationSegments: [] }),
    validInput({ timedNarrationSegments: [{ segmentId: "s", text: "x", startTime: 5, endTime: 4 }] }),
    validInput({ timedNarrationSegments: [{ segmentId: "s", text: "hello there", startTime: -1, endTime: 4 }] }),
    validInput({
      timedNarrationSegments: [
        { segmentId: "s", text: "first segment", startTime: 0, endTime: 2 },
        { segmentId: "t", text: "overlapping segment", startTime: 1, endTime: 3 }
      ]
    })
  ];
  for (const input of badInputs) {
    await assert.rejects(orchestrator.createContentPackage(input), /AI_NEWS_PACKAGE_TIMED_NARRATION_INVALID/);
  }
});

// ------------------------------------------------------------
// Determinism, idempotency, and restart safety
// ------------------------------------------------------------
test("orchestrator: rerunning the same package task returns cached deterministic results", async () => {
  const { orchestrator } = makeOrchestrator();
  const first = await orchestrator.createContentPackage(validInput());
  const second = await orchestrator.createContentPackage(validInput());
  assert.equal(first.packageId, second.packageId);
  assert.equal(first.briefId, second.briefId);
  assert.equal(first.editorialPlan.planId, second.editorialPlan.planId);
  assert.equal(first.metadataThumbnailPlan.planId, second.metadataThumbnailPlan.planId);
});

test("orchestrator: identical inputs on different task ids yield identical deterministic artifacts", async () => {
  const { orchestrator } = makeOrchestrator();
  const first = await orchestrator.createContentPackage(validInput());
  const second = await orchestrator.createContentPackage(validInput({ packageTaskId: "pkg-ainews-002" }));
  assert.equal(first.briefId, second.briefId);
  assert.equal(first.editorialPlan.planId, second.editorialPlan.planId);
  assert.equal(first.metadataThumbnailPlan.planId, second.metadataThumbnailPlan.planId);
  assert.equal(first.packageId, second.packageId);
});

test("orchestrator: different sources produce different brief and package ids", async () => {
  const { orchestrator } = makeOrchestrator();
  const first = await orchestrator.createContentPackage(validInput());
  const second = await orchestrator.createContentPackage(
    validInput({
      packageTaskId: "pkg-ainews-003",
      sources: [
        source(),
        source({ url: "https://www.wired.com/story/example-different/", publisher: "WIRED", contentHash: "c".repeat(64) })
      ]
    })
  );
  assert.notEqual(first.briefId, second.briefId);
  assert.notEqual(first.packageId, second.packageId);
});

// ------------------------------------------------------------
// Honest blocking: upstream gates stop the chain truthfully
// ------------------------------------------------------------
test("orchestrator: insufficient corroboration blocks the package and downstream stages do not run", async () => {
  const { orchestrator } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(
    validInput({ sources: [source()] }) // single source → unverified
  );

  assert.equal(result.readiness, "blocked");
  assert.equal(result.reasonCode, "INSUFFICIENT_CORROBORATION");
  assert.equal(result.researchBrief.readiness, "insufficient_corroboration");
  assert.equal(result.editorialPlan, null);
  assert.equal(result.metadataThumbnailPlan, null);
  assert.equal(result.subtitlePlan, null);
  const downstream = result.stages.filter((stage) => stage.stage !== "research_brief");
  assert.equal(downstream.length, 3);
  assert.ok(downstream.every((stage) => stage.status === "not_run"));
  assert.ok(downstream.every((stage) => stage.reasonCode === "UPSTREAM_BLOCKED"));
  assert.equal(result.provenance.providerCalls, 0);
  assert.equal(result.publication.status, "not_requested");
});

test("orchestrator: blocked editorial plan propagates the original reason code", async () => {
  const { orchestrator } = makeOrchestrator();
  // Two eligible sources but zero claims → NO_ELIGIBLE_CLAIMS in the editorial gate
  const result = await orchestrator.createContentPackage(
    validInput({
      sources: [
        source({ claims: [] }),
        source({
          url: "https://arstechnica.com/information-technology/example-story/",
          publisher: "Ars Technica",
          contentHash: "b".repeat(64),
          claims: []
        })
      ]
    })
  );
  assert.equal(result.readiness, "blocked");
  assert.equal(result.reasonCode, "BRIEF_NO_VERIFIED_CLAIMS");
  assert.equal(result.editorialPlan.readiness, "blocked");
  assert.equal(result.metadataThumbnailPlan, null);
  const notRun = result.stages.filter((stage) => stage.status === "not_run");
  assert.equal(notRun.length, 2);
});

// ------------------------------------------------------------
// Stage failures: checkpointed honestly and rethrown
// ------------------------------------------------------------
test("orchestrator: stage failures are checkpointed honestly and rethrown", async () => {
  const { orchestrator, checkpointStore, evidenceLedger } = makeOrchestrator({ withLedger: true });
  // Internal agent name in the public brand is rejected deep in the editorial stage (Rule 15).
  await assert.rejects(
    orchestrator.createContentPackage(validInput({ publicBrand: "News by NISHA" })),
    /AI_NEWS_PACKAGE_STAGE_FAILED:editorial_plan/
  );
  const failedCheckpoint = await checkpointStore.read("pkg-ainews-001#package");
  assert.equal(failedCheckpoint.step, "content_package_stage_failed");
  assert.equal(failedCheckpoint.data.resumable, true);
  assert.ok(failedCheckpoint.data.errorCode.length > 0);
  const classifications = evidenceLedger.list().map((event) => event.classification);
  assert.ok(classifications.includes("ai_news_content_package_failed"));
});

test("orchestrator: secrets in supplied sources fail closed in the research stage (Rule 17)", async () => {
  const { orchestrator, checkpointStore } = makeOrchestrator();
  await assert.rejects(
    orchestrator.createContentPackage(
      validInput({ sources: [source({ headline: "Vendors adopt api_key=abc123 rotation" }), source({ url: "https://arstechnica.com/information-technology/example-story/", publisher: "Ars Technica", contentHash: "b".repeat(64) })] })
    ),
    /AI_NEWS_PACKAGE_STAGE_FAILED:research_brief:RESEARCH_BRIEF_SECRET_REJECTED/
  );
  const failedCheckpoint = await checkpointStore.read("pkg-ainews-001#package");
  assert.equal(failedCheckpoint.step, "content_package_stage_failed");
});

// ------------------------------------------------------------
// Real worker machinery: checkpoints and evidence
// ------------------------------------------------------------
test("orchestrator: writes durable checkpoints for the package and pending narration", async () => {
  const { orchestrator, checkpointStore } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(validInput());

  const packageCheckpoint = await checkpointStore.read("pkg-ainews-001#package");
  assert.equal(packageCheckpoint.step, "content_package_ready");
  assert.equal(packageCheckpoint.progress, 100);
  assert.equal(packageCheckpoint.data.readiness, "package_incomplete_pending_narration_input");
  assert.equal(packageCheckpoint.data.providerCalls, 0);
  assert.equal(packageCheckpoint.data.packageId, result.packageId);

  const subtitleCheckpoint = await checkpointStore.read("pkg-ainews-001#subtitle_plan");
  assert.equal(subtitleCheckpoint.step, "subtitle_waiting_for_narration_input");
  assert.equal(subtitleCheckpoint.data.reasonCode, "NARRATION_REGISTRY_REQUIRED");
  assert.equal(subtitleCheckpoint.data.executionStarted, false);
  assert.equal(subtitleCheckpoint.data.resumable, true);
});

test("orchestrator: appends stage and package evidence through the real ledger", async () => {
  const { orchestrator, evidenceLedger } = makeOrchestrator({ withLedger: true });
  const result = await orchestrator.createContentPackage(validInput({ timedNarrationSegments: TIMED_SEGMENTS }));
  const classifications = evidenceLedger.list().map((event) => event.classification);
  const completedStages = result.stages.filter((stage) => stage.status === "completed").length;
  assert.equal(classifications.filter((code) => code === "ai_news_stage_completed").length, completedStages);
  assert.ok(classifications.includes("ai_news_content_package_completed"));
});

test("orchestrator: works without an evidence ledger", async () => {
  const { orchestrator } = makeOrchestrator({ withLedger: false });
  const result = await orchestrator.createContentPackage(validInput());
  assert.ok(result.packageId);
});

// ------------------------------------------------------------
// Constructor fail-closed requirements and input validation
// ------------------------------------------------------------
test("orchestrator: requires runtime and checkpoint store", () => {
  assert.throws(() => new AiNewsContentPackageOrchestrator({}), /AI_NEWS_PACKAGE_ORCHESTRATOR_RUNTIME_REQUIRED/);
  const runtime = new WorkerRuntime({ isTestEnv: true });
  assert.throws(
    () => new AiNewsContentPackageOrchestrator({ runtime }),
    /AI_NEWS_PACKAGE_ORCHESTRATOR_CHECKPOINT_STORE_REQUIRED/
  );
  assert.throws(
    () => new AiNewsContentPackageOrchestrator({ runtime, checkpointStore: {}, evidenceLedger: {} }),
    /AI_NEWS_PACKAGE_ORCHESTRATOR_(EVIDENCE_LEDGER_INVALID|CHECKPOINT_STORE_REQUIRED)/
  );
});

test("orchestrator: rejects invalid task ids, owner ids, and malformed input", async () => {
  const { orchestrator } = makeOrchestrator();
  await assert.rejects(orchestrator.createContentPackage(null), /AI_NEWS_PACKAGE_INPUT_INVALID/);
  await assert.rejects(orchestrator.createContentPackage(validInput({ packageTaskId: "" })), /AI_NEWS_PACKAGE_TASK_ID_INVALID/);
  await assert.rejects(
    orchestrator.createContentPackage(validInput({ packageTaskId: "bad id with spaces" })),
    /AI_NEWS_PACKAGE_TASK_ID_INVALID/
  );
  await assert.rejects(orchestrator.createContentPackage(validInput({ ownerId: "no" })), /AI_NEWS_PACKAGE_OWNER_ID_INVALID/);
  await assert.rejects(orchestrator.createContentPackage(validInput({ ownerId: 42 })), /AI_NEWS_PACKAGE_OWNER_ID_INVALID/);
});
