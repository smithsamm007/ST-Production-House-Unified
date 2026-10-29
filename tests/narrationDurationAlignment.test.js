/**
 * Cross-module regression test: narration script ⇄ episode duration ⇄ QC gate.
 *
 * The failure this file exists to prevent (measured offline):
 *   The audio stage narrated ONE title-derived line (~3 s) while assembly QC
 *   + the S-M41-01 completeness gate demanded measured audio coverage of the
 *   Director's configured 1800 / 2400 / 3000 s target. Three individually
 *   green modules therefore composed into a run that could never pass.
 *
 * It binds, in one test file:
 *   src/pipeline/narrationScript.js        (complete script, sized to target)
 *     → src/pipeline/episodePipeline.js    (stageInputs.narrationScript)
 *     → src/pipeline/productionExecutorRunner.js (audio stage uses it)
 *     → src/media/ttsExecutor.js           (accepts the full-length text)
 *     → src/media/episodeCompleteness.js   (measures coverage against target)
 *
 * Everything runs offline: transports (spawn / file reads) are injected, so
 * no TTS binary, no FFmpeg and no network are involved or claimed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  NARRATION_AIM_MARGIN_SECONDS,
  NARRATION_BEATS,
  NARRATION_PLANNING_WORDS_PER_SECOND,
  NARRATION_SCRIPT_ERROR_CODES,
  buildNarrationScript,
} from "../src/pipeline/narrationScript.js";
import { renderStageContent } from "../src/pipeline/episodePipeline.js";
import { bindProductionRunner } from "../src/pipeline/productionExecutorRunner.js";
import { ProductionWorkerLoop } from "../src/pipeline/workerLoop.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";
import { ProductionRepository } from "../src/catalog/productionRepository.js";
import { createVoiceProfile, declareTtsProviderCapabilities } from "../src/media/ttsAdapter.js";
import { MAX_TEXT_LENGTH, validateNarrationText } from "../src/media/ttsExecutor.js";
import {
  audioCoverageToleranceSeconds,
  evaluateEpisodeCompleteness,
} from "../src/media/episodeCompleteness.js";
import { EPISODE_DURATION_OPTIONS_SECONDS } from "../src/scheduling/directorSchedule.js";

const TARGETS = [1800, 2400, 3000];
const TITLE = "Nightfall Ward 7";

/** Offline world: capture what the executor was really asked to speak. */
function makeCapturingBinding({ agentId = "agent-01" } = {}) {
  const spawnCalls = [];
  return {
    spawnCalls,
    binding: {
      agentId,
      paths: { runPrefix: "alignrun" },
      tts: {
        profile: createVoiceProfile({
          agentId,
          language: "hi",
          provider: {
            providerId: "edge-tts",
            providerRole: "approved_free_primary",
            modelIdentifier: "edge-tts-cli",
            voiceId: "hi-IN-MadhurNeural",
          },
        }),
        registry: {
          "edge-tts": {
            declared: declareTtsProviderCapabilities({
              adapterId: "edge-tts-cli",
              languages: ["hi", "en"],
              voices: [{ voiceId: "hi-IN-MadhurNeural", language: "hi", supportsEmotion: true }],
            }),
            quotaExhausted: false,
          },
        },
      },
      spawnImpl: (request) => {
        spawnCalls.push({ command: request.command, args: [...(request.args ?? [])], stdin: request.stdin ?? null });
        if (request.command === "ffprobe") {
          const payload = { format: { filename: "n", format_name: "mp3", size: "16" }, streams: [{ codec_type: "audio", codec_name: "mp3" }] };
          return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false };
        }
        return { exitCode: 0, stdout: "", stderr: "written", timedOut: false };
      },
      readFileImpl: async () => Buffer.from("alignment-narration-bytes"),
      now: () => new Date("2026-10-29T10:00:00.000Z"),
    },
  };
}

function inspectionFor({ videoSeconds, audioSeconds }) {
  return {
    success: true,
    format: { filename: "e", format_name: "mp4", size: "1000", duration: String(videoSeconds) },
    streams: [
      { codec_type: "video", codec_name: "h264", duration: String(videoSeconds) },
      { codec_type: "audio", codec_name: "aac", duration: String(audioSeconds) },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. The builder supports every Director-configured target (30 / 40 / 50 min)
// ---------------------------------------------------------------------------

test("complete narration script is planned for each configured 30/40/50-minute target", () => {
  assert.deepEqual([...EPISODE_DURATION_OPTIONS_SECONDS], [1800, 2400, 3000]);

  for (const targetSeconds of TARGETS) {
    const script = buildNarrationScript({
      title: TITLE,
      season: 1,
      episode: 3,
      targetDurationSeconds: targetSeconds,
    });

    // Plan-side alignment: the five beat segments sum EXACTLY to the target.
    assert.equal(script.targetSeconds, targetSeconds);
    assert.equal(script.plannedSeconds, targetSeconds);
    assert.equal(script.segments.length, NARRATION_BEATS.length);
    assert.equal(
      script.segments.reduce((sum, segment) => sum + segment.plannedSeconds, 0),
      targetSeconds,
      `beat segments must sum to the ${targetSeconds}s target`,
    );
    assert.equal(
      script.segments.reduce((sum, segment) => sum + segment.wordCount, 0),
      script.wordCount - `इस कहानी का नाम है ${TITLE}`.split(" ").length,
      "word accounting: intro sentence + beat segments is the whole script",
    );

    // The ESTIMATED narration length must sit inside the completeness gate's
    // own acceptance window for that target — this is the cross-module link.
    const window = script.acceptanceWindow;
    assert.equal(window.minSeconds, targetSeconds - audioCoverageToleranceSeconds(targetSeconds));
    assert.equal(window.maxSeconds, targetSeconds + 1);
    assert.ok(
      script.estimatedSeconds >= window.minSeconds && script.estimatedSeconds <= window.maxSeconds,
      `${targetSeconds}s script estimates ${script.estimatedSeconds}s, outside [${window.minSeconds}, ${window.maxSeconds}]`,
    );
    assert.ok(script.estimatedSeconds <= targetSeconds - 1, "plan stays clear of the A/V overrun edge");
    assert.ok(NARRATION_AIM_MARGIN_SECONDS < audioCoverageToleranceSeconds(targetSeconds));

    // The full script must be admissible narration input (R15/R17 + bound).
    assert.equal(validateNarrationText(script.text), script.text);
    assert.ok(script.text.length <= MAX_TEXT_LENGTH, `script must fit the narration bound (${script.text.length} chars)`);
    assert.ok(script.text.length > 1000, "the script is complete, not a title line");

    assert.equal(script.generationMode, "deterministic_local");
    assert.equal(script.editorialStatus, "deterministic_planning_text");
    assert.ok(Object.isFrozen(script));
  }
});

test("narration script is deterministic and refuses non-configured targets", () => {
  const a = buildNarrationScript({ title: TITLE, targetDurationSeconds: 2400 });
  const b = buildNarrationScript({ title: TITLE, targetDurationSeconds: 2400 });
  assert.equal(a.text, b.text, "identical inputs produce byte-identical scripts (idempotent resume)");

  assert.deepEqual([...NARRATION_SCRIPT_ERROR_CODES].sort(), [
    "NARRATION_TARGET_UNSUPPORTED",
    "NARRATION_TITLE_INVALID",
  ]);
  for (const invalid of [1890, 2000, 1500, 3600, null, "2400", 0]) {
    assert.throws(
      () => buildNarrationScript({ title: TITLE, targetDurationSeconds: invalid }),
      (error) => error.code === "NARRATION_TARGET_UNSUPPORTED",
      `target ${String(invalid)} must be refused, never silently planned`,
    );
  }
  // Omitting the target means "documented default", matching
  // resolveEpisodeTargetDuration's `source: "default"` contract.
  const defaulted = buildNarrationScript({ title: TITLE });
  assert.equal(defaulted.targetSeconds, 2400);
  assert.throws(() => buildNarrationScript({ title: "   ", targetDurationSeconds: 2400 }), /NARRATION_TITLE_INVALID/);
});

// ---------------------------------------------------------------------------
// 2. The audio stage receives the COMPLETE script (not the title line)
// ---------------------------------------------------------------------------

test("audio stage narrates the complete configured-duration script end to end", async () => {
  const { binding, spawnCalls } = makeCapturingBinding();
  const runner = bindProductionRunner(binding);
  const script = buildNarrationScript({ title: TITLE, season: 1, episode: 3, targetDurationSeconds: 3000 });

  const result = await runner({
    release: { id: "align-1", agentId: "agent-01", title: TITLE },
    stage: "audio",
    stageInputs: { title: TITLE, season: 1, episode: 3, narrationScript: script },
  });

  assert.equal(result.success, true, `expected a verified result, got ${result.failureCode ?? "none"}`);
  assert.equal(result.mediaStatus, "verified");

  const ttsCall = spawnCalls.find((call) => call.command === "edge-tts");
  assert.ok(ttsCall, "the TTS provider was really invoked");
  const textArg = ttsCall.args[ttsCall.args.indexOf("--text") + 1];
  assert.equal(textArg, script.text, "the COMPLETE script reaches the provider");
  assert.ok(textArg.length > 1000, "never the title-only line");
  assert.notEqual(textArg, `यह कहानी अब शुरू होती है: ${TITLE}.`);
});

test("audio stage keeps its historical title line when no script is supplied", async () => {
  const { binding, spawnCalls } = makeCapturingBinding();
  const runner = bindProductionRunner(binding);

  const result = await runner({
    release: { id: "align-2", agentId: "agent-01", title: "T" },
    stage: "audio",
    stageInputs: { title: "T" },
  });
  assert.equal(result.success, true);
  const ttsCall = spawnCalls.find((call) => call.command === "edge-tts");
  assert.equal(ttsCall.args[ttsCall.args.indexOf("--text") + 1], "यह कहानी अब शुरू होती है: T.");
});

// ---------------------------------------------------------------------------
// 3. THE REGRESSION: plan and QC gate must agree about program length
// ---------------------------------------------------------------------------

test("regression: the legacy title-only narration cannot pass the completeness gate", () => {
  for (const targetSeconds of TARGETS) {
    const legacyLine = `यह कहानी अब शुरू होती है: ${TITLE}.`;
    const legacyVerdict = evaluateEpisodeCompleteness({
      inspection: inspectionFor({ videoSeconds: targetSeconds, audioSeconds: 3 }),
      targetSeconds,
    });
    assert.equal(legacyVerdict.passed, false);
    assert.equal(legacyVerdict.reasonCode, "QC_AUDIO_COVERAGE_INSUFFICIENT");
    assert.ok(legacyLine.length < 100, "the legacy input is a title line, not a program");

    const script = buildNarrationScript({ title: TITLE, targetDurationSeconds: targetSeconds });
    const plannedVerdict = evaluateEpisodeCompleteness({
      inspection: inspectionFor({ videoSeconds: targetSeconds, audioSeconds: Math.floor(script.estimatedSeconds) }),
      targetSeconds,
    });
    assert.equal(
      plannedVerdict.passed,
      true,
      `planned ${targetSeconds}s narration must satisfy the gate (got ${plannedVerdict.reasonCode})`,
    );
    assert.ok(plannedVerdict.audioCoverageRatio >= 0.99);
  }
});

test("completeness gate still rejects a narration that is genuinely too short", () => {
  const script = buildNarrationScript({ title: TITLE, targetDurationSeconds: 2400 });
  const short = evaluateEpisodeCompleteness({
    // Real-world drift: the provider spoke faster than the planning rate.
    inspection: inspectionFor({ videoSeconds: 2400, audioSeconds: Math.floor(script.estimatedSeconds) - 60 }),
    targetSeconds: 2400,
  });
  assert.equal(short.passed, false);
  assert.equal(short.reasonCode, "QC_AUDIO_COVERAGE_INSUFFICIENT");
});

// ---------------------------------------------------------------------------
// 4. The pipeline hands the configured duration to the builder
// ---------------------------------------------------------------------------

test("the audio-stage artifact carries the complete configured-duration script", () => {
  const script = buildNarrationScript({ title: TITLE, season: 1, episode: 3, targetDurationSeconds: 2400 });
  const content = JSON.parse(
    renderStageContent("audio", {
      channelId: "ch-1",
      title: TITLE,
      season: 1,
      episode: 3,
      targetDurationSeconds: 2400,
      narrationScript: script,
    }),
  );
  assert.equal(content.schema, "st.audio.narration.v1");
  assert.equal(content.targetSeconds, 2400);
  assert.equal(content.generationMode, "deterministic_local");
  assert.equal(content.narrationLines.length, NARRATION_BEATS.length);
  assert.equal(
    content.narrationLines.map((line) => line.text).join(" "),
    script.segments.map((segment) => segment.text).join(" "),
    "the artifact carries the exact script text the audio stage narrates",
  );
  assert.equal(content.plannedSeconds, 2400);
  assert.equal(content.wordCount, script.wordCount);

  // Ad-hoc callers without a script keep the historical planning stub.
  const stub = JSON.parse(renderStageContent("audio", { channelId: "ch-1", title: TITLE, season: 1, episode: 3 }));
  assert.equal(stub.narrationLines.length, 3);
  assert.equal(stub.narrationLines[0].text, `Previously on ${TITLE}...`);
});

test("worker loop → runner → executor carries the default-duration script", async () => {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const production = new ProductionRepository(db);
  await db.query("INSERT INTO agents (id, name, namespace, enabled) VALUES ($1,$2,$3,$4)", ["agent-01", "ALIGN", "st.agent.align", true]);
  const ownerId = randomUUID();
  await db.query("INSERT INTO owners (id,email,password_hash,role,status) VALUES ($1,$2,$3,$4,$5)", [ownerId, "owner@align.test", "x".repeat(64), "owner", "authenticated"]);
  const channelId = randomUUID();
  await db.query(
    "INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [channelId, ownerId, "align-1", "Align", "tag", "Hindi", "agent-01"],
  );
  const { release, jobId } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: TITLE, season: 1, episode: 1,
  });

  const { binding, spawnCalls } = makeCapturingBinding();
  const worker = new ProductionWorkerLoop({
    jobsRepository: { updateStatus: async () => {}, calls: [] },
    productionRepository: production,
    evidenceLedger: { append: async () => ({ ok: true }) },
    executorRunnerFactory: ({ agentId }) => bindProductionRunner({ ...binding, agentId }),
    log: () => {},
  });
  await worker.process({
    id: jobId,
    agent_id: "agent-01",
    attempts: 0,
    max_attempts: 3,
    payload: JSON.stringify({ releaseId: release.id, channelId }),
    owner_id: ownerId,
  });

  const ttsCall = spawnCalls.find((call) => call.command === "edge-tts");
  assert.ok(ttsCall, "the audio stage ran through the real executor");
  const spoken = ttsCall.args[ttsCall.args.indexOf("--text") + 1];

  // The documented default target (2400 s / 40 min) is what the run planned.
  const expected = buildNarrationScript({ title: TITLE, season: 1, episode: 1, targetDurationSeconds: 2400 });
  assert.equal(spoken, expected.text, "the pipeline passes the complete default-duration script");
  assert.ok(spoken.length > 1000, "the title-only line can never reach the provider again");
});
