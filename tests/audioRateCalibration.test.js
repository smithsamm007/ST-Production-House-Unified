/**
 * Measured audio-rate calibration (Issue #257): the production audio stage
 * must CONSUME a measured duration and re-request synthesis with the rate
 * scaled by measured/target, bounded and deterministic, and fail honestly
 * when the evidence or provider capability is unavailable.
 *
 * Everything runs offline with injected transports: the fake provider's
 * measured duration follows the same physics the real rehearsal measured
 * (docs/media/REAL_MEDIA_REHEARSAL.md: rendered duration ≈ K / synthesis rate,
 * with K a property of the text, NOT a trusted constant).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  AUDIO_CALIBRATION_ERROR_CODES,
  DEFAULT_NARRATION_WPM,
  MAX_AUDIO_CALIBRATION_ATTEMPTS,
  bindProductionRunner,
} from "../src/pipeline/productionExecutorRunner.js";
import { buildNarrationScript } from "../src/pipeline/narrationScript.js";
import { createVoiceProfile, declareTtsProviderCapabilities } from "../src/media/ttsAdapter.js";
import { buildTtsSpawnRequest, executeTtsGeneration, ttsProviderOutputExtension } from "../src/media/ttsExecutor.js";

const TITLE = "Calibration Ward 5";
// Measured physics (docs/media/REAL_MEDIA_REHEARSAL.md): rendered duration ≈
// words × 60 ÷ (setting × 1.127) — the effective wpm is ≈ 1.127× the -s setting.
const EFFECTIVE_WPM_FACTOR = 1.127;

function espeakBinding({ agentId = "agent-01", extensionProfileOverride = {} } = {}) {
  const profile = createVoiceProfile({
    agentId,
    language: "hi",
    provider: { providerId: "espeak-ng", providerRole: "local_open_source_emergency", modelIdentifier: "espeak-ng-cli", voiceId: "hi" },
    ...extensionProfileOverride,
  });
  return {
    agentId,
    paths: { runPrefix: "calib" },
    tts: {
      profile,
      registry: {
        "espeak-ng": {
          declared: declareTtsProviderCapabilities({
            adapterId: "espeak-ng-cli",
            languages: ["hi", "en"],
            voices: [{ voiceId: "hi", language: "hi", supportsEmotion: false }],
          }),
          quotaExhausted: false,
        },
      },
    },
    spawnImpl: null,
    readFileImpl: null,
    now: () => new Date("2026-10-30T10:00:00.000Z"),
  };
}

/**
 * Offline espeak-ng world: synthesis "succeeds" and the REAL post-render
 * inspection reports durationSeconds ≈ K / rate, exactly where `rate` is the
 * `-s <wpm>` request carried in the spawn argv (or the provider default).
 */
function makeCalibrationWorld({ narrationScript, fixedDurationSeconds = null, reportDuration = true } = {}) {
  const bytes = Buffer.from("calibrated-narration-bytes");
  const ttsSpawnCalls = [];
  let lastRequestedRate =
    narrationScript && Number.isInteger(narrationScript.wordsPerMinute) ? narrationScript.wordsPerMinute : DEFAULT_NARRATION_WPM;
  return {
    ttsSpawnCalls,
    bytes,
    bindingExtras: {
      spawnImpl: ({ command, args }) => {
        if (command === "ffprobe") {
          let deterministic;
          if (fixedDurationSeconds !== null) {
            deterministic = fixedDurationSeconds;
          } else {
            deterministic = narrationScript.wordCount * 60 / (lastRequestedRate * EFFECTIVE_WPM_FACTOR);
          }
          const payload = {
            format: { filename: "n", format_name: "wav", size: String(bytes.length), ...(reportDuration ? { duration: String(deterministic) } : {}) },
            ...(reportDuration
              ? { streams: [{ codec_type: "audio", codec_name: "pcm_s16le", duration: String(deterministic) }] }
              : { streams: [{ codec_type: "audio", codec_name: "pcm_s16le" }] }),
          };
          return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false };
        }
        ttsSpawnCalls.push({ command, args: [...(args ?? [])] });
        // Record the rate request this synthesis carried — the next probe
        // measures ITS output.
        if (args && args.includes("-s")) {
          const requested = Number(args[args.indexOf("-") + 1]);
          lastRequestedRate = Number.isFinite(requested) ? requested : DEFAULT_NARRATION_WPM;
        }
        if (args && args.includes("-s")) {
          const requested = Number(args[args.indexOf("-s") + 1]);
          lastRequestedRate = Number.isFinite(requested) ? requested : DEFAULT_NARRATION_WPM;
        }
        return { exitCode: 0, stdout: "", stderr: "written", timedOut: false };
      },
      readFileImpl: async () => bytes,
    },
  };
}

// ---------------------------------------------------------------------------
// Executor surface: the requested rate reaches the provider argv, nothing else
// ---------------------------------------------------------------------------

test("requested words-per-minute reaches espeak-ng argv (-s) and never edge-tts", () => {
  const espeakRequest = buildTtsSpawnRequest({
    providerId: "espeak-ng",
    voiceId: "hi",
    text: "यह एक परीक्षण है।",
    outputPath: "/media/audio/n.mp3",
    registry: { "espeak-ng": { declared: declareTtsProviderCapabilities({ adapterId: "espeak-ng-cli", languages: ["hi"], voices: [{ voiceId: "hi", language: "hi" }] }) } },
    wordsPerMinute: 117,
  });
  assert.deepEqual(
    espeakRequest.args.slice(espeakRequest.args.indexOf("-s"), espeakRequest.args.indexOf("-s") + 2),
    ["-s", "117"],
  );
  assert.deepEqual(espeakRequest.args.slice(-4), ["-v", "hi", "-w", "/media/audio/n.mp3"]);

  const defaultRequest = buildTtsSpawnRequest({
    providerId: "espeak-ng",
    voiceId: "hi",
    text: "यह एक परीक्षण है।",
    outputPath: "/media/audio/n.mp3",
    registry: { "espeak-ng": { declared: declareTtsProviderCapabilities({ adapterId: "espeak-ng-cli", languages: ["hi"], voices: [{ voiceId: "hi", language: "hi" }] }) } },
  });
  assert.ok(!defaultRequest.args.includes("-s"), "no provider-default guess: no rate argument without one");

  const edgeRequest = buildTtsSpawnRequest({
    providerId: "edge-tts",
    voiceId: "hi-IN-MadhurNeural",
    text: "यह एक परीक्षण है।",
    outputPath: "/media/audio/e.mp3",
    registry: { "edge-tts": { declared: declareTtsProviderCapabilities({ adapterId: "edge-tts-cli", languages: ["hi"], voices: [{ voiceId: "hi-IN-MadhurNeural", language: "hi" }] }) } },
    wordsPerMinute: 117,
  });
  assert.ok(!edgeRequest.args.includes("-s") && !edgeRequest.args.some((arg) => typeof arg === "string" && arg.startsWith("--rate")),
    "an unverified relative-rate argument is never invented");
});

test("invalid rate bounds fail closed before any provider call", async () => {
  for (const invalid of [7, 451, 0, -10, 117.5, "117", Number.NaN]) {
    const spawnCalls = [];
    const result = await executeTtsGeneration(
      createVoiceProfile({
        agentId: "agent-01",
        language: "hi",
        provider: { providerId: "espeak-ng", providerRole: "local_open_source_emergency", modelIdentifier: "espeak-ng-cli", voiceId: "hi" },
      }),
      {
        scriptText: "यह एक परीक्षण है।",
        outputPath: "/media/audio/invalid.mp3",
        registry: {
          "espeak-ng": { declared: declareTtsProviderCapabilities({ adapterId: "espeak-ng-cli", languages: ["hi"], voices: [{ voiceId: "hi", language: "hi" }] }), quotaExhausted: false },
        },
        wordsPerMinute: invalid,
        spawnImpl: ({ command }) => {
          spawnCalls.push(command);
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
        readFileImpl: async () => Buffer.from("x"),
      },
    );
    assert.equal(result.success, false);
    assert.equal(result.failureCode, "TTS_RATE_INVALID");
    assert.equal(spawnCalls.length, 0, "an unusable rate request is never sent to a provider");
  }
});

// ---------------------------------------------------------------------------
// The production audio stage: calibration is consumed, bounded, deterministic
// ---------------------------------------------------------------------------

test("audio stage converges on measured durations and uses the settled rate", async () => {
  const script = buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 });
  const world = makeCalibrationWorld({ narrationScript: script });
  const runner = bindProductionRunner({ ...espeakBinding(), ...world.bindingExtras });
  assert.equal(script.wordsPerMinute, 132, "the plan's declared words-per-minute seeds attempt 1");

  const result = await runner({
    release: { id: "cal-1", agentId: "agent-01", title: TITLE },
    stage: "audio",
    stageInputs: { title: TITLE, narrationScript: script },
    targetDurationSeconds: 1800,
  });

  assert.equal(result.success, true, `expected in-window calibration, got ${result.failureCode ?? "none"}`);
  assert.equal(result.calibration.settled, true);
  assert.equal(result.calibration.targetSeconds, 1800);
  assert.ok(result.success && result.calibration.settled, "settled evidence recorded");

  const attempts = result.calibration.attempts;
  assert.equal(attempts.length, 2, "from the plan rate 132 → K/rate physics converges in one correction");
  assert.equal(attempts[0].wordsPerMinute, 132);
  assert.equal(attempts[1].wordsPerMinute, 117);
  assert.ok(attempts[1].measuredDurationSeconds >= 1791 && attempts[1].measuredDurationSeconds <= 1801,
    `settled measurement ${attempts[1].measuredDurationSeconds} must sit inside the gate window`);

  // EVIDENCE the production stage actually uses the measured rate: the final
  // spawn carries the settled `-s 117`.
  const espeakCalls = world.ttsSpawnCalls.filter((call) => call.command === "espeak-ng");
  assert.equal(espeakCalls.length, 2, "bounded: exactly two synthesis attempts");
  const lastArgs = espeakCalls.at(-1).args;
  assert.deepEqual(lastArgs.slice(lastArgs.indexOf("-s"), lastArgs.indexOf("-s") + 2), ["-s", "117"]);
});

test("calibration is bounded and deterministic (repeated runs produce identical attempts)", async () => {
  const script2400 = buildNarrationScript({ title: TITLE, targetDurationSeconds: 2400 });
  const make = () => {
    const world = makeCalibrationWorld({ narrationScript: script2400 });
    const runner = bindProductionRunner({ ...espeakBinding(), ...world.bindingExtras });
    return runner({
      release: { id: "cal-2", agentId: "agent-01", title: TITLE },
      stage: "audio",
      stageInputs: { title: TITLE, narrationScript: script2400 },
      targetDurationSeconds: 2400,
    });
  };
  const first = await make();
  const second = await make();
  assert.equal(first.calibration.settled, true);
  assert.deepEqual(first.calibration.attempts, second.calibration.attempts, "same physics → identical bounded attempt sequence");
});

test("a provider that ignores rate input fails closed after the bounded attempts", async () => {
  // Simulates a synthesis stack that cannot be rate-controlled for this job:
  // every attempt measures the SAME out-of-window duration.
  const world = makeCalibrationWorld({ narrationScript: buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 }), fixedDurationSeconds: 1200 });
  const runner = bindProductionRunner({ ...espeakBinding(), ...world.bindingExtras });

  const result = await runner({
    release: { id: "cal-3", agentId: "agent-01", title: TITLE },
    stage: "audio",
    stageInputs: { title: TITLE, narrationScript: buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 }) },
    targetDurationSeconds: 1800,
  });

  assert.equal(result.success, false);
  assert.equal(result.failureCode, "NARRATION_CALIBRATION_EXHAUSTED");
  assert.ok(AUDIO_CALIBRATION_ERROR_CODES.includes(result.failureCode));
  assert.equal(result.calibration.settled, false);
  assert.equal(result.calibration.attempts.length, MAX_AUDIO_CALIBRATION_ATTEMPTS);
  assert.equal(result.mediaStatus, "unverified");
  assert.equal(result.descriptor, null);
  assert.equal(result.quotaState, null, "exhaustion is a FAILURE, never a fabricated durable wait");
  assert.equal(world.ttsSpawnCalls.length, 3, "bounded synthesis attempts, every attempt measured");
});

test("a non-rate-controlled provider with measured out-of-window narration fails closed immediately", async () => {
  const bytes = Buffer.from("edge-narration-bytes");
  const ttsSpawnCalls = [];
  const runner = bindProductionRunner({
    agentId: "agent-01",
    paths: { runPrefix: "calib" },
    tts: {
      profile: createVoiceProfile({
        agentId: "agent-01",
        language: "hi",
        provider: { providerId: "edge-tts", providerRole: "approved_free_primary", modelIdentifier: "edge-tts-cli", voiceId: "hi-IN-MadhurNeural" },
      }),
      registry: {
        "edge-tts": {
          declared: declareTtsProviderCapabilities({
            adapterId: "edge-tts-cli", languages: ["hi", "en"], voices: [{ voiceId: "hi-IN-MadhurNeural", language: "hi", supportsEmotion: true }],
          }),
          quotaExhausted: false,
        },
      },
    },
    spawnImpl: ({ command, args }) => {
      if (command === "ffprobe") {
        const payload = {
          format: { filename: "n", format_name: "mp3", size: String(bytes.length), duration: "1200" },
          streams: [{ codec_type: "audio", codec_name: "mp3", duration: "1200" }],
        };
        return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false };
      }
      ttsSpawnCalls.push({ command, args: [...(args ?? [])] });
      return { exitCode: 0, stdout: "", stderr: "written", timedOut: false };
    },
    readFileImpl: async () => bytes,
  });

  const result = await runner({
    release: { id: "cal-4", agentId: "agent-01", title: TITLE },
    stage: "audio",
    stageInputs: { title: TITLE, narrationScript: buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 }) },
    targetDurationSeconds: 1800,
  });

  assert.equal(result.success, false);
  assert.equal(result.failureCode, "NARRATION_RATE_UNCONTROLLED");
  assert.equal(result.calibration.attempts.length, 1);
  assert.equal(ttsSpawnCalls.length, 1, "no second guess at an honestly uncontrolled provider");
  assert.ok(ttsSpawnCalls.at(-1).args.every((arg) => arg !== "-s"), "no invented rate argument");
});

test("without a target or without a measurable duration, the stage is unchanged", async () => {
  const unmeasurable = makeCalibrationWorld({ narrationScript: buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 }), reportDuration: false });
  const runnerUnmeasurable = bindProductionRunner({ ...espeakBinding(), ...unmeasurable.bindingExtras });
  const singleShot = await runnerUnmeasurable({
    release: { id: "cal-5", agentId: "agent-01", title: TITLE },
    stage: "audio",
    stageInputs: { title: TITLE, narrationScript: buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 }) },
    targetDurationSeconds: 1800,
  });
  assert.equal(singleShot.success, true);
  assert.equal(singleShot.calibration, undefined, "unmeasurable → zero calibration claims");
  assert.equal(unmeasurable.ttsSpawnCalls.length, 1);

  const world = makeCalibrationWorld({ narrationScript: buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 }) });
  const runnerNoTarget = bindProductionRunner({ ...espeakBinding(), ...world.bindingExtras });
  const noTarget = await runnerNoTarget({
    release: { id: "cal-6", agentId: "agent-01", title: TITLE },
    stage: "audio",
    stageInputs: { title: TITLE, narrationScript: buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 }) },
  });
  assert.equal(noTarget.success, true);
  assert.equal(noTarget.calibration, undefined);
  assert.equal(world.ttsSpawnCalls.length, 1, "no target → exactly one synthesis, like before this issue");
});

test("executor waits and failures are still returned unchanged (never retried blindly)", async () => {
  const runner = bindProductionRunner({
    ...espeakBinding(),
    tts: {
      ...espeakBinding().tts,
      registry: { "espeak-ng": { declared: espeakBinding().tts.registry["espeak-ng"].declared, quotaExhausted: false, credentialLocator: undefined } },
    },
    // No spawn at all → the executor honestly returns PROVIDER_UNAVAILABLE.
    spawnImpl: undefined,
    readFileImpl: async () => Buffer.from("x"),
  });
  const result = await runner({
    release: { id: "cal-7", agentId: "agent-01", title: TITLE },
    stage: "audio",
    stageInputs: { title: TITLE, narrationScript: buildNarrationScript({ title: TITLE, targetDurationSeconds: 1800 }) },
    targetDurationSeconds: 1800,
  });
  // A transport failure without rate input yields the provider/execute
  // failure path — and the calibration loop must NOT transform it.
  assert.equal(result.success, false);
  assert.ok(AUDIO_CALIBRATION_ERROR_CODES.includes(result.failureCode ?? "") === false, "transport failure keeps its own honest code");
  assert.notEqual(result.failureCode, "NARRATION_CALIBRATION_EXHAUSTED");
});

test("calibration constants and codes stay frozen", () => {
  assert.equal(MAX_AUDIO_CALIBRATION_ATTEMPTS, 3);
  assert.equal(DEFAULT_NARRATION_WPM, 175);
  assert.deepEqual([...AUDIO_CALIBRATION_ERROR_CODES].sort(), [
    "NARRATION_CALIBRATION_EXHAUSTED",
    "NARRATION_RATE_UNCONTROLLED",
  ]);
  assert.equal(ttsProviderOutputExtension("espeak-ng"), ".wav");
});
