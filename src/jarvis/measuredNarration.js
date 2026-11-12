/**
 * ST Production House — measured JARVIS narration stage (Issue #262).
 *
 * WHY THIS EXISTS:
 *   The JARVIS content-package orchestrator planned narration structure and
 *   timing but never reached the narration RUNTIME the production pipeline
 *   uses, so the measured QC contract could not judge a JARVIS package. This
 *   module binds ONE script to the SAME two contracts, adding neither:
 *
 *     src/media/ttsExecutor.js         — real provider execution + real ffprobe
 *     src/media/episodeCompleteness.js — measured audio-coverage gate (S-M41-01)
 *
 *   The script's documented words-per-minute is handed to the executor as
 *   INPUT. This module does not re-run the production runner's bounded
 *   rate-calibration loop; the MEASURED result is accepted or rejected by the
 *   gate. Out-of-window audio is reported with its measured numbers — never
 *   stretched, padded, or claimed.
 *
 * HONESTY CONTRACT (AGENTS.md Rules 1–3):
 *   - `success: true` is possible ONLY for `status: "measured_verified"`, which
 *     requires a real provider result AND a completeness verdict computed from
 *     real FFprobe measurements.
 *   - A provider wait/failure keeps the executor's own code; an unmeasurable
 *     render carries the gate's code (e.g. QC_STREAM_DURATION_MISSING) — never
 *     a default pass.
 *   - Every returned record is frozen and carries the measured seconds used.
 *   - Skips are explicit: `skipped_pending_runtime` (no executor bound) and
 *     `skipped_pending_input` (no script for this language) are honest states,
 *     not successes.
 */

import { evaluateEpisodeCompleteness } from "../media/episodeCompleteness.js";
import { executeTtsGeneration } from "../media/ttsExecutor.js";

export const JARVIS_NARRATION_STAGE_VERSION = "jarvis_measured_narration_v1";

/** Closed set of narration-audio statuses this module can report. */
export const NARRATION_AUDIO_STATUSES = Object.freeze([
  "measured_verified",
  "measured_out_of_window",
  "not_generated",
  "skipped_pending_runtime",
  "skipped_pending_input",
]);

export const JARVIS_NARRATION_STAGE_ERROR_CODES = Object.freeze([
  "JARVIS_NARRATION_SCRIPT_INVALID",
  "JARVIS_NARRATION_STAGE_INPUT_INVALID",
  "JARVIS_NARRATION_RECORD_INVALID",
  "NARRATION_STAGE_UNAVAILABLE",
]);

function stageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * The honest "nothing was generated" record used for both skip states. Status
 * and reason code are explicit; no measured field is invented.
 */
export function createSkippedNarrationAudio(status, reasonCode) {
  if (status !== "skipped_pending_runtime" && status !== "skipped_pending_input") {
    throw stageError("JARVIS_NARRATION_RECORD_INVALID");
  }
  if (typeof reasonCode !== "string" || reasonCode.trim().length === 0 || reasonCode.length > 120) {
    throw stageError("JARVIS_NARRATION_RECORD_INVALID");
  }
  return deepFreeze({
    stageVersion: JARVIS_NARRATION_STAGE_VERSION,
    status,
    success: false,
    reasonCode,
    providerId: null,
    providerRole: null,
    providerExecuted: false,
    quotaState: null,
    mediaStatus: "not_generated",
    generationMode: "not_evidenced",
    measuredSeconds: null,
    completeness: null,
    scriptMetrics: null,
  });
}

/**
 * Validate a narration-audio record (including one produced by an injected
 * stage) before it becomes part of a package result. Fails closed.
 */
export function assertNarrationAudioRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw stageError("JARVIS_NARRATION_RECORD_INVALID");
  }
  if (!NARRATION_AUDIO_STATUSES.includes(value.status)) {
    throw stageError("JARVIS_NARRATION_RECORD_INVALID");
  }
  if (value.success !== (value.status === "measured_verified")) {
    throw stageError("JARVIS_NARRATION_RECORD_INVALID");
  }
  if (!Object.hasOwn(value, "measuredSeconds")) {
    throw stageError("JARVIS_NARRATION_RECORD_INVALID");
  }
  return value;
}

/**
 * Narrate one complete script through the production TTS executor and judge
 * the result with the measured completeness gate.
 *
 *   script        — `buildNarrationScript()` output (validated).
 *   voiceProfile  — S-M32-01 voice profile the executor verifies.
 *   registry      — declared provider registry (capability/quota-aware).
 *   outputPath    — destination the executor really writes.
 *   spawnImpl / readFileImpl / probeTimeoutMs — real transports (tests inject).
 *   executeTtsGenerationImpl — injection seam; defaults to the real executor.
 *
 * Returns a frozen record:
 *   { stageVersion, status, success, reasonCode, providerId, providerRole,
 *     providerExecuted, quotaState, mediaStatus, generationMode,
 *     measuredSeconds, completeness, scriptMetrics }
 */
export async function runMeasuredNarrationStage({
  script,
  voiceProfile,
  registry,
  outputPath,
  spawnImpl,
  readFileImpl,
  now,
  timeoutMs,
  probeTimeoutMs,
  productionRunId,
  executeTtsGenerationImpl = executeTtsGeneration,
} = {}) {
  if (
    !script ||
    typeof script !== "object" ||
    script.scriptType !== "st.narration.script.v1" ||
    typeof script.text !== "string" ||
    script.text.trim().length === 0 ||
    !Number.isInteger(script.wordsPerMinute) ||
    !Number.isFinite(script.targetSeconds) ||
    script.targetSeconds <= 0
  ) {
    throw stageError("JARVIS_NARRATION_SCRIPT_INVALID");
  }
  if (
    typeof executeTtsGenerationImpl !== "function" ||
    !voiceProfile ||
    typeof voiceProfile !== "object" ||
    !registry ||
    typeof registry !== "object" ||
    typeof outputPath !== "string"
  ) {
    throw stageError("JARVIS_NARRATION_STAGE_INPUT_INVALID");
  }

  const scriptMetrics = deepFreeze({
    targetSeconds: script.targetSeconds,
    plannedSeconds: typeof script.plannedSeconds === "number" ? script.plannedSeconds : null,
    estimatedSeconds: typeof script.estimatedSeconds === "number" ? script.estimatedSeconds : null,
    wordCount: Number.isInteger(script.wordCount) ? script.wordCount : null,
    wordsPerMinute: script.wordsPerMinute,
  });

  const result = await executeTtsGenerationImpl(voiceProfile, {
    scriptText: script.text,
    outputPath,
    registry,
    wordsPerMinute: script.wordsPerMinute,
    spawnImpl,
    readFileImpl,
    now,
    timeoutMs,
    probeTimeoutMs,
    productionRunId,
  });

  const base = {
    stageVersion: JARVIS_NARRATION_STAGE_VERSION,
    status: "not_generated",
    success: false,
    reasonCode: null,
    providerId: result?.providerCall?.providerId ?? null,
    providerRole: result?.providerCall?.providerRole ?? null,
    providerExecuted: result?.providerCall?.callStatus === "succeeded",
    quotaState: result?.quotaState ?? null,
    mediaStatus: result?.mediaStatus ?? "unverified",
    generationMode: result?.generationMode ?? "not_evidenced",
    measuredSeconds: null,
    completeness: null,
    scriptMetrics,
  };

  // Provider wait / failure / unverified bytes: keep the executor's own truth.
  if (result?.success !== true) {
    return deepFreeze({
      ...base,
      reasonCode: typeof result?.failureCode === "string" ? result.failureCode : "NARRATION_STAGE_UNAVAILABLE",
    });
  }

  // The gate is the only duration authority. It reads the executor's REAL
  // inspection record and is given the script's target as the reference.
  const completeness = evaluateEpisodeCompleteness({
    inspection: result.inspection,
    targetSeconds: script.targetSeconds,
  });
  const measuredSeconds = typeof completeness.audioSeconds === "number" ? completeness.audioSeconds : null;

  if (completeness.passed !== true) {
    return deepFreeze({
      ...base,
      status: "measured_out_of_window",
      reasonCode: completeness.reasonCode ?? "QC_INSPECTION_UNAVAILABLE",
      measuredSeconds,
      completeness,
    });
  }

  return deepFreeze({
    ...base,
    status: "measured_verified",
    success: true,
    reasonCode: null,
    measuredSeconds,
    completeness,
  });
}
