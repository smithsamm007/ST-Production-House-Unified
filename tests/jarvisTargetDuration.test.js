/**
 * Issue #262 — one JARVIS planning duration (30 / 40 / 50 minutes), one
 * narration script, one measured narration contract.
 *
 * These tests are offline and deterministic: no provider, no FFmpeg, no
 * clock. The measured-narration tests inject the executor's return record so
 * the GATE (real module) is what is exercised, not a second implementation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { deterministicJarvisContentHandler } from "../src/jarvis/deterministicContentWorkflow.js";
import { createDeterministicNarrationPlan } from "../src/jarvis/deterministicNarrationPlan.js";
import { deterministicJarvisScriptPlanHandler } from "../src/jarvis/deterministicScriptPlan.js";
import { deterministicJarvisContinuityPlanHandler } from "../src/jarvis/deterministicContinuityPlan.js";
import { createDeterministicShortsPlan } from "../src/jarvis/deterministicShortsPlan.js";
import { createDeterministicMetadataThumbnailPlan } from "../src/jarvis/deterministicMetadataThumbnailPlan.js";
import { createDeterministicVisualScenePlan } from "../src/jarvis/deterministicVisualScenePlanner.js";
import { createDeterministicAudioDispatch } from "../src/jarvis/deterministicAudioDispatch.js";
import { JarvisContentPackageOrchestrator } from "../src/jarvis/contentPackageOrchestrator.js";
import {
  JARVIS_TARGET_DURATIONS_MINUTES,
  JARVIS_TARGET_DURATIONS_SECONDS,
  assertJarvisTargetMinutes,
  isJarvisTargetMinutes,
  jarvisTargetSeconds,
} from "../src/jarvis/targetDuration.js";
import {
  buildJarvisNarrationScript,
  deriveTimedNarrationSegments,
  MAX_DERIVED_SEGMENT_SECONDS,
} from "../src/jarvis/jarvisNarrationScript.js";
import { runMeasuredNarrationStage } from "../src/jarvis/measuredNarration.js";
import { EPISODE_DURATION_OPTIONS_SECONDS } from "../src/scheduling/directorSchedule.js";
import { WorkerRuntime } from "../src/workers/workerRuntime.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";

const BRAND = "Raat Ki Awaaz";
const CONCEPT =
  "Ek sunsaan pahadi hostel mein band kamre se har raat kisi bachche ki ghanti sunai deti hai.";

async function outlineFor({ targetMinutes, language = "hinglish", brand = BRAND } = {}) {
  return deterministicJarvisContentHandler({
    agentId: "agent-01",
    jobType: "jarvis.content.outline.v1",
    payload: { publicBrand: brand, concept: CONCEPT, language, targetMinutes },
    heartbeat() {},
    checkpoint: async () => {},
  });
}

function stageContext(jobType, payload) {
  return {
    agentId: "agent-01",
    jobType,
    payload,
    heartbeat() {},
    checkpoint: async () => {},
  };
}

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

function makeOrchestrator(options = {}) {
  const checkpointStore = new CheckpointStore(new TestCheckpointAdapter());
  const runtime = new WorkerRuntime({ idempotencyStore: new TestIdempotencyStore(), isTestEnv: true });
  return {
    orchestrator: new JarvisContentPackageOrchestrator({ runtime, checkpointStore, ...options }),
    checkpointStore,
  };
}

function packageInput(overrides = {}) {
  return {
    packageTaskId: "pkg-case-001",
    publicBrand: BRAND,
    suppliedConcept: CONCEPT,
    language: "hindi",
    targetMinutes: 40,
    ...overrides,
  };
}

function fakeExecutor({ audioSeconds = 2399.5, videoSeconds = 2400, includeDuration = true, failure = null } = {}) {
  const calls = [];
  const impl = async (voiceProfile, options) => {
    calls.push(options);
    if (failure !== null) {
      return {
        success: false,
        failureCode: failure,
        quotaState: "WAITING_FOR_QUOTA",
        providerCall: null,
        mediaStatus: "unverified",
        generationMode: "not_evidenced",
      };
    }
    return {
      success: true,
      inspection: {
        success: true,
        streams: [
          { codec_type: "video", duration: String(videoSeconds) },
          { codec_type: "audio", ...(includeDuration ? { duration: String(audioSeconds) } : {}) },
        ],
      },
      providerCall: {
        providerId: "espeak-ng",
        providerRole: "local_open_source_emergency",
        callStatus: "succeeded",
      },
      mediaStatus: "verified",
      generationMode: "provider_generated",
      quotaState: "OK",
    };
  };
  return { impl, calls };
}

// ---------------------------------------------------------------------------
// One canonical duration contract
// ---------------------------------------------------------------------------

test("the JARVIS target set is exactly the Director 30/40/50 options", () => {
  assert.deepEqual([...JARVIS_TARGET_DURATIONS_SECONDS], [...EPISODE_DURATION_OPTIONS_SECONDS]);
  assert.deepEqual([...JARVIS_TARGET_DURATIONS_MINUTES], [30, 40, 50]);
  assert.equal(jarvisTargetSeconds(40), 2400);
  for (const invalid of [0, 25, 27, 29, 31, 45, 60, 30.5, "30", null, undefined]) {
    assert.equal(isJarvisTargetMinutes(invalid), false);
  }
  assert.throws(
    () => assertJarvisTargetMinutes(27, "JARVIS_TARGET_DURATION_INVALID"),
    /JARVIS_TARGET_DURATION_INVALID/,
  );
});

test("30/40/50-minute packages plan consistently across every JARVIS stage", async () => {
  for (const targetMinutes of [30, 40, 50]) {
    const outline = await outlineFor({ targetMinutes });
    assert.equal(outline.targetMinutes, targetMinutes);

    const narration = createDeterministicNarrationPlan(outline);
    assert.equal(narration.targetMinutes, targetMinutes);
    assert.equal(
      narration.narrationSegments.reduce((sum, segment) => sum + segment.plannedDurationSeconds, 0),
      targetMinutes * 60,
    );

    const continuity = await deterministicJarvisContinuityPlanHandler(
      stageContext("jarvis.content.continuity-plan.v1", { outlinePackage: outline }),
    );
    assert.equal(continuity.targetMinutes, targetMinutes);

    const script = await deterministicJarvisScriptPlanHandler(
      stageContext("jarvis.content.script-plan.v1", { outlinePackage: outline }),
    );
    assert.equal(script.targetMinutes, targetMinutes);
    assert.equal(script.sections.reduce((sum, section) => sum + section.targetMinutes, 0), targetMinutes);
    assert.ok(script.sections.every((section) => section.targetMinutes >= 1));

    assert.equal(createDeterministicShortsPlan(outline).shorts.length, 3);

    const metadata = createDeterministicMetadataThumbnailPlan(outline);
    assert.ok(metadata.metadataDraft.description.includes(`${targetMinutes}`));

    assert.equal(createDeterministicVisualScenePlan(outline).longFormScenes.length, 5);

    const dispatch = createDeterministicAudioDispatch(narration, { ownerId: "owner-test" });
    assert.equal(dispatch.targetMinutes, targetMinutes);
    assert.equal(
      dispatch.requests.filter(({ payload }) => payload.requestKind === "narration_tts").length,
      5,
    );
  }
});

test("non-canonical durations fail closed at every JARVIS entry point", async () => {
  await assert.rejects(outlineFor({ targetMinutes: 27 }), /JARVIS_TARGET_DURATION_INVALID/);
  await assert.rejects(outlineFor({ targetMinutes: 60 }), /JARVIS_TARGET_DURATION_INVALID/);

  const outline = await outlineFor({ targetMinutes: 30 });
  const narration = createDeterministicNarrationPlan(outline);
  for (const bad of [27, 29, 31, 45]) {
    assert.throws(
      () => createDeterministicNarrationPlan({ ...outline, targetMinutes: bad }),
      /NARRATION_PLAN_DURATION_INVALID/,
    );
    assert.throws(
      () => createDeterministicShortsPlan({ ...outline, targetMinutes: bad }),
      /SHORTS_PLAN_DURATION_INVALID/,
    );
    assert.throws(
      () => createDeterministicMetadataThumbnailPlan({ ...outline, targetMinutes: bad }),
      /METADATA_PLAN_DURATION_INVALID/,
    );
    assert.throws(
      () => createDeterministicAudioDispatch({ ...narration, targetMinutes: bad }, { ownerId: "owner-test" }),
      /AUDIO_DISPATCH_DURATION_INVALID/,
    );
  }
});

// ---------------------------------------------------------------------------
// One narration script (shared with the production pipeline)
// ---------------------------------------------------------------------------

test("the shared narration builder sizes JARVIS scripts to each canonical target", async () => {
  for (const targetMinutes of [30, 40, 50]) {
    const outline = await outlineFor({ targetMinutes, language: "hindi" });
    const script = buildJarvisNarrationScript(outline);
    assert.equal(script.scriptType, "st.narration.script.v1");
    assert.equal(script.generationMode, "deterministic_local");
    assert.equal(script.targetSeconds, targetMinutes * 60);
    assert.equal(script.plannedSeconds, targetMinutes * 60);
    assert.equal(script.segments.length, 5);
    assert.ok(script.estimatedSeconds > script.acceptanceWindow.minSeconds);
    assert.ok(script.estimatedSeconds <= script.acceptanceWindow.maxSeconds);
  }

  const hinglish = await outlineFor({ targetMinutes: 30, language: "hinglish" });
  assert.throws(() => buildJarvisNarrationScript(hinglish), /LANGUAGE_UNSUPPORTED/);
  assert.throws(
    () =>
      buildJarvisNarrationScript({
        packageType: "jarvis_mvp_story_outline",
        readiness: "outline_only",
        language: "hindi",
        targetMinutes: 27,
        publicBrand: BRAND,
      }),
    /OUTLINE_INVALID/,
  );
});

test("derived subtitle segments are script words with labelled planned timings", async () => {
  const outline = await outlineFor({ targetMinutes: 50, language: "hindi" });
  const script = buildJarvisNarrationScript(outline);
  const segments = deriveTimedNarrationSegments(script);

  assert.ok(segments.length >= script.segments.length);
  assert.equal(segments[0].startTime, 0);
  assert.equal(segments.at(-1).endTime, 3000);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const duration = segment.endTime - segment.startTime;
    assert.ok(duration > 0);
    assert.ok(duration <= MAX_DERIVED_SEGMENT_SECONDS);
    assert.equal(segment.timingSource, "narration_script_planned_seconds");
    assert.equal(segment.speaker, "narrator");
    if (index > 0) assert.equal(segment.startTime, segments[index - 1].endTime);
  }

  const derivedWords = segments.map(({ text }) => text).join(" ").split(/\s+/);
  const scriptWords = script.segments.map(({ text }) => text).join(" ").split(/\s+/);
  assert.deepEqual(derivedWords, scriptWords);
});

// ---------------------------------------------------------------------------
// One measured narration contract (executor + completeness gate)
// ---------------------------------------------------------------------------

test("measured narration accepts only gate-verified in-window audio", async () => {
  const script = buildJarvisNarrationScript(await outlineFor({ targetMinutes: 40, language: "hindi" }));
  const { impl, calls } = fakeExecutor({ audioSeconds: 2399.5, videoSeconds: 2400 });

  const record = await runMeasuredNarrationStage({
    script,
    voiceProfile: { agentId: "agent-01" },
    registry: {},
    outputPath: "/home/runner/audio.wav",
    executeTtsGenerationImpl: impl,
  });

  assert.equal(record.status, "measured_verified");
  assert.equal(record.success, true);
  assert.equal(record.reasonCode, null);
  assert.equal(record.measuredSeconds, 2399.5);
  assert.equal(record.completeness.passed, true);
  assert.equal(record.providerExecuted, true);
  assert.equal(record.providerId, "espeak-ng");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scriptText, script.text);
  assert.equal(calls[0].wordsPerMinute, script.wordsPerMinute);
});

test("measured narration rejects short, unmeasurable, and provider-failed audio honestly", async () => {
  const script = buildJarvisNarrationScript(await outlineFor({ targetMinutes: 30, language: "hindi" }));
  const run = (impl) =>
    runMeasuredNarrationStage({
      script,
      voiceProfile: { agentId: "agent-01" },
      registry: {},
      outputPath: "/home/runner/audio.wav",
      executeTtsGenerationImpl: impl,
    });

  const short = await run(fakeExecutor({ audioSeconds: 1200, videoSeconds: 1800 }).impl);
  assert.equal(short.status, "measured_out_of_window");
  assert.equal(short.success, false);
  assert.equal(short.reasonCode, "QC_AUDIO_COVERAGE_INSUFFICIENT");
  assert.equal(short.measuredSeconds, 1200);

  const unmeasurable = await run(fakeExecutor({ includeDuration: false }).impl);
  assert.equal(unmeasurable.status, "measured_out_of_window");
  assert.equal(unmeasurable.reasonCode, "QC_STREAM_DURATION_MISSING");
  assert.equal(unmeasurable.measuredSeconds, null);

  const waiting = await run(fakeExecutor({ failure: "QUOTA_EXHAUSTED" }).impl);
  assert.equal(waiting.status, "not_generated");
  assert.equal(waiting.success, false);
  assert.equal(waiting.reasonCode, "QUOTA_EXHAUSTED");
  assert.equal(waiting.quotaState, "WAITING_FOR_QUOTA");
  assert.equal(waiting.providerExecuted, false);
  assert.equal(waiting.measuredSeconds, null);

  await assert.rejects(runMeasuredNarrationStage({ script: {} }), /JARVIS_NARRATION_SCRIPT_INVALID/);
  await assert.rejects(
    runMeasuredNarrationStage({
      script,
      voiceProfile: {},
      registry: {},
      outputPath: "/home/runner/audio.wav",
      executeTtsGenerationImpl: null,
    }),
    /JARVIS_NARRATION_STAGE_INPUT_INVALID/,
  );
});

// ---------------------------------------------------------------------------
// Orchestrator: derived subtitles + measured audio
// ---------------------------------------------------------------------------

test("a Hindi 40-minute package derives subtitles bound to the narrated script", async () => {
  const { orchestrator } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(packageInput({ ownerId: "owner-alpha" }));

  assert.equal(result.readiness, "deterministic_package_complete");
  assert.equal(result.narrationScriptStatus, "planned");
  assert.equal(result.narrationScript.targetSeconds, 2400);
  assert.ok(result.subtitlePlan);
  assert.equal(result.subtitlePlan.language, "hindi");
  assert.ok(result.subtitlePlan.longFormPlan.cues.length > 0);
  assert.ok(result.subtitlePlan.longFormPlan.cues.at(-1).endTime <= 2400);

  const scriptWords = new Set(result.narrationScript.text.split(/\s+/));
  for (const cue of result.subtitlePlan.longFormPlan.cues.slice(0, 25)) {
    for (const word of cue.text.split(/\s+/)) assert.ok(scriptWords.has(word));
  }

  assert.equal(result.narrationAudio.status, "skipped_pending_runtime");
  assert.equal(result.narrationAudio.reasonCode, "NARRATION_AUDIO_RUNTIME_REQUIRED");
  assert.equal(result.provenance.generatedMediaCount, 0);
  assert.equal(result.provenance.mediaStatus, "not_generated");
  assert.equal(result.provenance.providerCalls, 0);
});

test("a Hinglish package still requires owner-supplied timed narration", async () => {
  const { orchestrator } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(
    packageInput({ language: "hinglish", targetMinutes: 30 }),
  );

  assert.equal(result.readiness, "package_incomplete_pending_narration_input");
  assert.equal(result.narrationScript, null);
  assert.equal(result.narrationScriptStatus, "unavailable_for_language");
  assert.equal(result.narrationAudio.status, "skipped_pending_input");
  assert.equal(result.narrationAudio.reasonCode, "NARRATION_SCRIPT_LANGUAGE_UNSUPPORTED");
  const subtitleStage = result.stages.find(({ stage }) => stage === "subtitle_plan");
  assert.equal(subtitleStage.status, "skipped_pending_input");
  assert.equal(subtitleStage.reasonCode, "NARRATION_SEGMENTS_REQUIRED");
});

test("derived subtitles still require owner scope and say so instead of inventing one", async () => {
  const { orchestrator } = makeOrchestrator();
  const result = await orchestrator.createContentPackage(packageInput({ targetMinutes: 30 }));

  assert.equal(result.subtitlePlan, null);
  assert.equal(result.readiness, "package_incomplete_pending_narration_input");
  const subtitleStage = result.stages.find(({ stage }) => stage === "subtitle_plan");
  assert.equal(subtitleStage.reasonCode, "OWNER_SCOPE_REQUIRED");
});

test("a bound measured narration stage records verified audio and reuses the checkpoint", async () => {
  const { impl, calls } = fakeExecutor({ audioSeconds: 1799.5, videoSeconds: 1800 });
  let invocations = 0;
  const narrationStage = async ({ script, targetSeconds }) => {
    invocations += 1;
    assert.equal(script.scriptType, "st.narration.script.v1");
    assert.equal(targetSeconds, 1800);
    return runMeasuredNarrationStage({
      script,
      voiceProfile: { agentId: "agent-01" },
      registry: {},
      outputPath: "/home/runner/audio.wav",
      executeTtsGenerationImpl: impl,
    });
  };

  const { orchestrator, checkpointStore } = makeOrchestrator({ narrationStage });
  const first = await orchestrator.createContentPackage(
    packageInput({ targetMinutes: 30, ownerId: "owner-alpha" }),
  );

  assert.equal(first.narrationAudio.status, "measured_verified");
  assert.equal(first.narrationAudio.measuredSeconds, 1799.5);
  assert.equal(first.provenance.mediaStatus, "verified");
  assert.equal(first.provenance.generatedMediaCount, 1);
  assert.equal(first.provenance.providerCalls, 1);
  assert.equal(calls.length, 1);

  const audioCheckpoint = await checkpointStore.read("pkg-case-001#narration_audio");
  assert.equal(audioCheckpoint.data.record.status, "measured_verified");
  assert.equal(audioCheckpoint.data.measuredSeconds, 1799.5);

  const second = await orchestrator.createContentPackage(
    packageInput({ targetMinutes: 30, ownerId: "owner-alpha" }),
  );
  assert.equal(second.narrationAudio.status, "measured_verified");
  assert.equal(invocations, 1, "verified audio must be reused, not re-generated");
});

test("an injected narration record is validated, and the constructor rejects a bad stage", async () => {
  const refusing = makeOrchestrator({ narrationStage: async () => ({ status: "verified", success: true }) });
  await assert.rejects(
    refusing.orchestrator.createContentPackage(packageInput({ targetMinutes: 30, ownerId: "owner-alpha" })),
    /JARVIS_NARRATION_RECORD_INVALID/,
  );

  const runtime = new WorkerRuntime({ isTestEnv: true });
  const checkpointStore = new CheckpointStore(new TestCheckpointAdapter());
  assert.throws(
    () => new JarvisContentPackageOrchestrator({ runtime, checkpointStore, narrationStage: {} }),
    /JARVIS_PACKAGE_ORCHESTRATOR_NARRATION_STAGE_INVALID/,
  );
});
