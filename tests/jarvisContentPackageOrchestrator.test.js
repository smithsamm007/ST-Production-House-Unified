import test from "node:test";
import assert from "node:assert/strict";
import { JarvisContentPackageOrchestrator } from "../src/jarvis/contentPackageOrchestrator.js";
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
  const orchestrator = new JarvisContentPackageOrchestrator({ runtime, checkpointStore, evidenceLedger });
  return { orchestrator, checkpointStore, evidenceLedger };
}

function validInput(overrides = {}) {
  return {
    packageTaskId: "pkg-jarvis-001",
    publicBrand: "Raat Ek Kahaani",
    suppliedConcept: "A night-shift security guard discovers a sealed record room that hums every full moon night.",
    language: "hinglish",
    targetMinutes: 26,
    ...overrides
  };
}

const TIMED_SEGMENTS = [
  { segmentId: "seg-1", text: "Raat ke barah baje record room ki chaabi khud ghoom gayi.", startTime: 0, endTime: 4 },
  { segmentId: "seg-2", text: "Halki khatkhatahat, phir poora corridor andhera ho gaya.", startTime: 4, endTime: 9 }
];

// ------------------------------------------------------------
// Full workflow through the real stage handlers
// ------------------------------------------------------------
test("orchestrator: runs all real deterministic stages and returns the full package", async () => {
  const { orchestrator } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(validInput());

  assert.equal(result.orchestrator, "jarvis_content_package_v1");
  assert.equal(result.readiness, "package_incomplete_pending_narration_input");
  assert.ok(/^[a-f0-9]{64}$/.test(result.outlinePackageId));
  assert.equal(result.contentPackage.packageType, "jarvis_mvp_story_outline");
  assert.equal(result.contentPackage.readiness, "outline_only");
  assert.equal(result.narrationPlan.packageType, "narration_audio_plan");
  assert.equal(result.continuityPlan.packageType, "jarvis_mvp_continuity_plan");
  assert.equal(result.scriptPlan.packageType, "jarvis_mvp_script_plan");
  assert.equal(result.visualScenePlan.packageType, "visual_scene_plan_v1");
  assert.equal(result.shortsPlan.packageType, "shorts_plan_v1");
  assert.equal(result.metadataThumbnailPlan.packageType, "metadata_thumbnail_plan");
  assert.equal(result.subtitlePlan, null);
  assert.equal(result.stages.length, 8);
  assert.ok(result.stages.slice(0, 7).every((stage) => stage.status === "completed"));
  const subtitleStage = result.stages[7];
  assert.equal(subtitleStage.status, "skipped_pending_input");
  assert.equal(subtitleStage.reasonCode, "NARRATION_SEGMENTS_REQUIRED");
  assert.equal(result.provenance.providerCalls, 0);
  assert.equal(result.provenance.networkCalls, 0);
  assert.equal(result.provenance.generatedMediaCount, 0);
  assert.equal(result.provenance.mediaStatus, "not_generated");
  assert.equal(result.publication.status, "not_requested");
});

test("orchestrator: completes the subtitle stage when the owner supplies timed narration", async () => {
  const { orchestrator } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(
    validInput({ ownerId: "owner-alpha", timedNarrationSegments: TIMED_SEGMENTS })
  );

  assert.equal(result.readiness, "deterministic_package_complete");
  assert.ok(result.subtitlePlan);
  assert.equal(result.subtitlePlan.packageType, "subtitle_plan_v1");
  assert.ok(result.subtitlePlan.longFormPlan.cues.length > 0);
  assert.equal(result.subtitlePlan.shortsPlans.length, 3);
  assert.ok(result.stages.every((stage) => stage.status === "completed"));
});

test("orchestrator: timed narration validation fails closed", async () => {
  const { orchestrator } = makeOrchestrator();
  const badInputs = [
    validInput({ ownerId: "owner-alpha", timedNarrationSegments: [] }),
    validInput({ ownerId: "owner-alpha", timedNarrationSegments: [{ segmentId: "s", text: "x", startTime: 5, endTime: 4 }] }),
    validInput({ ownerId: "owner-alpha", timedNarrationSegments: [{ segmentId: "s", text: "hello there", startTime: -1, endTime: 4 }] }),
    validInput({ ownerId: "owner-alpha", timedNarrationSegments: [{ segmentId: "s", text: "a", startTime: 0, endTime: 2 }, { segmentId: "t", text: "b", startTime: 1, endTime: 3 }] })
  ];
  for (const input of badInputs) {
    await assert.rejects(
      orchestrator.createContentPackage(input),
      /JARVIS_PACKAGE_(TIMED_NARRATION_INVALID|STAGE_OUTPUT_INVALID)/
    );
  }
  await assert.rejects(
    orchestrator.createContentPackage(validInput({ timedNarrationSegments: TIMED_SEGMENTS })),
    /JARVIS_PACKAGE_OWNER_ID_REQUIRED_FOR_SUBTITLES/
  );
});

// ------------------------------------------------------------
// Real worker machinery: checkpoints, evidence, resume
// ------------------------------------------------------------
test("orchestrator: writes durable checkpoints for the package and stages", async () => {
  const { orchestrator, checkpointStore } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(validInput());

  const packageCheckpoint = await checkpointStore.read("pkg-jarvis-001#package");
  assert.equal(packageCheckpoint.step, "content_package_ready");
  assert.equal(packageCheckpoint.progress, 100);
  assert.equal(packageCheckpoint.data.readiness, "package_incomplete_pending_narration_input");
  assert.equal(packageCheckpoint.data.providerCalls, 0);

  const outlineCheckpoint = await checkpointStore.read("pkg-jarvis-001#outline");
  assert.equal(outlineCheckpoint.step, "outline_package_ready");
  assert.equal(outlineCheckpoint.data.packageId, result.outlinePackageId);

  const subtitleCheckpoint = await checkpointStore.read("pkg-jarvis-001#subtitle_plan");
  assert.equal(subtitleCheckpoint.step, "subtitle_waiting_for_narration_input");
  assert.equal(subtitleCheckpoint.data.reasonCode, "NARRATION_SEGMENTS_REQUIRED");
  assert.equal(subtitleCheckpoint.data.executionStarted, false);
});

test("orchestrator: restart safety — rerunning the same package task returns cached stage results", async () => {
  const { orchestrator } = makeOrchestrator();
  const first = await orchestrator.createContentPackage(validInput());
  const second = await orchestrator.createContentPackage(validInput());
  assert.equal(first.outlinePackageId, second.outlinePackageId);
  assert.equal(first.scriptPlan.planId, second.scriptPlan.planId);
  assert.deepEqual(second.stages.filter((stage) => stage.status === "completed").length, first.stages.filter((stage) => stage.status === "completed").length);
});

test("orchestrator: identical briefs on different task ids yield identical deterministic artifacts", async () => {
  const { orchestrator } = makeOrchestrator();
  const first = await orchestrator.createContentPackage(validInput());
  const second = await orchestrator.createContentPackage(validInput({ packageTaskId: "pkg-jarvis-002" }));
  assert.equal(first.outlinePackageId, second.outlinePackageId);
  assert.equal(first.narrationPlan.packageId, second.narrationPlan.packageId);
  assert.equal(first.continuityPlan.validationId, second.continuityPlan.validationId);
  assert.equal(first.scriptPlan.planId, second.scriptPlan.planId);
  assert.equal(first.visualScenePlan.planId, second.visualScenePlan.planId);
  assert.equal(first.shortsPlan.packageId, second.shortsPlan.packageId);
  assert.equal(first.metadataThumbnailPlan.packageId, second.metadataThumbnailPlan.packageId);
});

test("orchestrator: different concepts produce different outline ids", async () => {
  const { orchestrator } = makeOrchestrator();
  const first = await orchestrator.createContentPackage(validInput());
  const second = await orchestrator.createContentPackage(
    validInput({ packageTaskId: "pkg-jarvis-003", suppliedConcept: "An abandoned hill-station toy library where every teddy bear faces the wall." })
  );
  assert.notEqual(first.outlinePackageId, second.outlinePackageId);
});

test("orchestrator: appends stage and package evidence through the real ledger", async () => {
  const { orchestrator, evidenceLedger } = makeOrchestrator({ withLedger: true });
  const result = await orchestrator.createContentPackage(validInput());
  const classifications = evidenceLedger.list().map((event) => event.classification);
  const completedStages = result.stages.filter((stage) => stage.status === "completed").length;
  assert.equal(classifications.filter((code) => code === "jarvis_content_stage_completed").length, completedStages);
  assert.ok(classifications.includes("jarvis_content_package_completed"));
});

test("orchestrator: works without an evidence ledger", async () => {
  const { orchestrator } = makeOrchestrator({ withLedger: false });
  const result = await orchestrator.createContentPackage(validInput());
  assert.ok(result.outlinePackageId);
});

// ------------------------------------------------------------
// Constructor fail-closed requirements
// ------------------------------------------------------------
test("orchestrator: requires runtime and checkpoint store", () => {
  assert.throws(() => new JarvisContentPackageOrchestrator({}), /JARVIS_PACKAGE_ORCHESTRATOR_RUNTIME_REQUIRED/);
  const runtime = new WorkerRuntime({ isTestEnv: true });
  assert.throws(
    () => new JarvisContentPackageOrchestrator({ runtime }),
    /JARVIS_PACKAGE_ORCHESTRATOR_CHECKPOINT_STORE_REQUIRED/
  );
  assert.throws(
    () => new JarvisContentPackageOrchestrator({ runtime, checkpointStore: {}, evidenceLedger: {} }),
    /JARVIS_PACKAGE_ORCHESTRATOR_(EVIDENCE_LEDGER_INVALID|CHECKPOINT_STORE_REQUIRED)/
  );
});

// ------------------------------------------------------------
// Input validation
// ------------------------------------------------------------
test("orchestrator: rejects invalid package task ids and malformed input", async () => {
  const { orchestrator } = makeOrchestrator();
  await assert.rejects(orchestrator.createContentPackage(null), /JARVIS_PACKAGE_INPUT_INVALID/);
  await assert.rejects(orchestrator.createContentPackage(validInput({ packageTaskId: "" })), /JARVIS_PACKAGE_TASK_ID_INVALID/);
  await assert.rejects(orchestrator.createContentPackage(validInput({ packageTaskId: "bad id with spaces" })), /JARVIS_PACKAGE_TASK_ID_INVALID/);
});

test("orchestrator: stage failures are checkpointed honestly and rethrown", async () => {
  const { orchestrator, checkpointStore, evidenceLedger } = makeOrchestrator({ withLedger: true });
  // Internal agent name in the public brand is rejected deep in the outline stage.
  await assert.rejects(
    orchestrator.createContentPackage(validInput({ publicBrand: "JARVIS Prime" })),
    /./
  );
  const failedCheckpoint = await checkpointStore.read("pkg-jarvis-001#package");
  assert.equal(failedCheckpoint.step, "content_package_stage_failed");
  assert.equal(failedCheckpoint.data.resumable, true);
  assert.ok(failedCheckpoint.data.errorCode.length > 0);
  const classifications = evidenceLedger.list().map((event) => event.classification);
  assert.ok(classifications.includes("jarvis_content_package_failed"));
});
