#!/usr/bin/env node
/**
 * ST Production House — REAL media rehearsal (repeatable evidence runner).
 *
 * Validates, on a media-capable host, one complete 30/40/50-minute episode:
 *
 *   deterministic narration script (labelled planning text)
 *     → REAL speech synthesis (espeak-ng, the local open-source emergency
 *       provider — no credentials needed)
 *     → rate auto-calibration against REAL measured durations
 *     → REAL ffmpeg assembly (video + narration audio, real libx264/aac bytes)
 *     → REAL MEASURED loudness (ebur128) + true peak + clipping samples
 *       → REAL two-pass loudnorm normalization when out of conformance
 *     → REAL ffprobe inspection of the FINAL file
 *       → technical conformance (resolution / frame rate / sample rate / codec)
 *       → evaluateEpisodeCompleteness (S-M41-01 audio-coverage gate)
 *         → PASS verdict + durable evidence JSON in artifacts/rehearsal/
 *
 * HONESTY (AGENTS.md Rules 1–3):
 *   - Narration text is `generationMode: deterministic_local`
 *     (`editorialStatus: deterministic_planning_text`) — PLANNING narration,
 *     never a claim of editorial quality.
 *   - The visual is a flat solid-colour placeholder at a LOW frame rate,
 *     labelled: `technicalProfile: placeholder_rehearsal`, `delivery: false`.
 *     It exists to exercise assembly/QC/coverage/loudness with real bytes —
 *     never story footage, and never the delivery profile.
 *   - Every duration, LUFS, dBTP, sample count, frame rate and sample rate
 *     reported is parsed from a REAL FFmpeg/FFprobe measurement of the bytes
 *     on disk. No motion, no BGM/SFX, no publishing, no receipts.
 *
 * Usage:
 *   node scripts/real_media_rehearsal.mjs --target=1800   (or 2400 / 3000)
 *   npm run real-media-rehearsal
 *
 * Requires: espeak-ng, ffmpeg, ffprobe on PATH (missing dependencies fail
 * honestly with REHEARSAL_DEPENDENCY_MISSING — never skipped silently).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildNarrationScript } from "../src/pipeline/narrationScript.js";
import {
  audioCoverageToleranceSeconds,
  evaluateEpisodeCompleteness,
} from "../src/media/episodeCompleteness.js";
import {
  HOUSE_LOUDNESS_TARGET,
  evaluateLoudnessConformance,
  measureClipping,
  measureLoudness,
  normalizeLoudness,
} from "../src/media/loudnessMeasurement.js";
import {
  TECHNICAL_PROFILES,
  evaluateTechnicalConformance,
} from "../src/media/technicalConformance.js";

const OUT_ROOT = "artifacts/rehearsal";
const MAX_CALIBRATION_ATTEMPTS = 4;
const REHEARSAL_PROFILE = TECHNICAL_PROFILES.placeholder_rehearsal;

function fail(code, detail) {
  const error = new Error(detail ?? code);
  error.code = code;
  throw error;
}

function requireBin(bin) {
  try {
    execFileSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    fail("REHEARSAL_DEPENDENCY_MISSING", `${bin} is not available on this host; the rehearsal cannot claim evidence it did not produce`);
  }
}

/**
 * Injected spawn adapter for the measurement modules: ARRAY ARGS only, no
 * shell (CONVENTIONS Rule 2). spawnSync is used (not execFileSync) because
 * FFmpeg writes its ebur128/astats summaries to STDERR, which execFileSync
 * discards on success.
 */
function measurementSpawn({ command, args, timeoutMs = 120_000 }) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    return {
      exitCode: null,
      timedOut: result.error.code === "ETIMEDOUT",
      stdout: "",
      stderr: "",
      spawnErrorCode: result.error.code ?? null,
    };
  }
  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function probeDurationSeconds(file) {
  const json = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8" });
  const parsed = JSON.parse(json);
  const seconds = Number(parsed?.format?.duration);
  if (!Number.isFinite(seconds)) fail("REHEARSAL_PROBE_FAILED", `no measured duration for ${file}`);
  return seconds;
}

function probeArtifact(file) {
  const json = execFileSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries",
      "stream=codec_type,codec_name,codec_long_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,channel_layout,duration",
      "-show_entries", "format=duration,size",
      "-of", "json",
      file,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(json);
}

/**
 * Calibrate the synthesis rate against REAL measurements: duration scales
 * ≈ 1/rate, so each attempt multiplies the current rate by measure/target,
 * bounded to MAX_CALIBRATION_ATTEMPTS. No hardcoded answer is trusted — the
 * final window membership is always a fresh measurement.
 */
function calibrateNarration({ textPath, outputPath, targetSeconds, tolerance }) {
  let rate = 175; // espeak-ng's documented default; a measurement, not a truth
  let measured = null;
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_CALIBRATION_ATTEMPTS; attempt += 1) {
    execFileSync("espeak-ng", ["-v", "hi", "-s", String(rate), "-w", outputPath, "-f", textPath], { stdio: ["ignore", "ignore", "ignore"] });
    measured = probeDurationSeconds(outputPath);
    const minSeconds = targetSeconds - tolerance;
    const maxSeconds = targetSeconds + 1;
    attempts.push({ attempt, rate, measuredDurationSeconds: Number(measured.toFixed(3)) });
    if (measured >= minSeconds && measured <= maxSeconds) {
      return { rate, measuredSeconds: measured, attempts, calibrated: attempt === 1 ? false : true, iterations: attempt };
    }
    rate = Math.min(450, Math.max(1, Math.round(rate * (measured / targetSeconds))));
  }
  fail("REHEARSAL_CALIBRATION_FAILED", `narration stayed outside [${targetSeconds - tolerance}, ${targetSeconds + 1}] after ${MAX_CALIBRATION_ATTEMPTS} attempts (last: ${measured}s)`);
}

function main() {
  const argTarget = process.argv.find((arg) => arg.startsWith("--target="));
  const targetSeconds = argTarget ? Number(argTarget.split("=")[1]) : 2400;
  if (![1800, 2400, 3000].includes(targetSeconds)) {
    fail("REHEARSAL_TARGET_UNSUPPORTED", `target must be one of 1800/2400/3000 (got ${targetSeconds})`);
  }
  for (const bin of ["espeak-ng", "ffmpeg", "ffprobe"]) requireBin(bin);

  const script = buildNarrationScript({ title: "Rehearsal Episode", targetDurationSeconds: targetSeconds });
  const tolerance = audioCoverageToleranceSeconds(targetSeconds);
  const dir = path.join(OUT_ROOT, String(targetSeconds));
  mkdirSync(dir, { recursive: true });

  const textPath = path.join(dir, "narration.txt");
  const audioPath = path.join(dir, "narration.wav");
  const videoPath = path.join(dir, "episode.mp4");
  const normalizedPath = path.join(dir, "episode-normalized.mp4");

  writeFileSync(textPath, script.text);
  const calibration = calibrateNarration({ textPath, outputPath: audioPath, targetSeconds, tolerance });

  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      // Explicit, labelled placeholder visual (Rule 3). 2 fps keeps a
      // full-length still-image program inside a bounded CPU budget; the
      // technical profile below declares that rate so nothing pretends this
      // is the 24+ fps delivery profile.
      "-f", "lavfi", "-i", "color=c=0x101418:s=1920x1080:r=2",
      "-i", audioPath,
      "-map", "0:v", "-map", "1:a", "-t", String(targetSeconds),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      // House audio profile: AAC 48 kHz (the sample rate the technical gate
      // asserts), so the gate measures what the delivery contract states.
      "-c:a", "aac", "-ar", "48000", "-b:a", "128k",
      "-movflags", "+faststart",
      videoPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  // ---- MEASURED loudness of the RAW render -------------------------------
  const measuredInput = measureLoudness({ file: videoPath, spawnImpl: measurementSpawn });
  const inputClipping = measureClipping({ file: videoPath, spawnImpl: measurementSpawn });
  const inputVerdict = evaluateLoudnessConformance({
    measurement: measuredInput,
    clipping: inputClipping,
    target: HOUSE_LOUDNESS_TARGET,
  });

  let finalPath = videoPath;
  let normalization = { applied: false, reason: "input_already_conformant" };
  if (inputVerdict.passed !== true) {
    if (measuredInput.success !== true) {
      fail(`REHEARSAL_LOUDNESS_UNMEASURABLE_${measuredInput.reasonCode}`, JSON.stringify(measuredInput));
    }
    const run = normalizeLoudness({
      inputPath: videoPath,
      outputPath: normalizedPath,
      measurement: measuredInput,
      spawnImpl: measurementSpawn,
    });
    if (run.success !== true) {
      fail(`REHEARSAL_NORMALIZATION_FAILED_${run.failureCode}`, JSON.stringify(run));
    }
    finalPath = normalizedPath;
    normalization = {
      applied: true,
      reason: `input_not_conformant:${inputVerdict.reasonCodes.join("_")}`,
      filter: run.filter,
      outputName: path.basename(normalizedPath),
    };
  }

  // ---- MEASURED conformance of the FINAL artifact ------------------------
  const measuredOutput = finalPath === videoPath
    ? measuredInput
    : measureLoudness({ file: finalPath, spawnImpl: measurementSpawn });
  const outputClipping = finalPath === videoPath
    ? inputClipping
    : measureClipping({ file: finalPath, spawnImpl: measurementSpawn });
  const loudnessVerdict = evaluateLoudnessConformance({
    measurement: measuredOutput,
    clipping: outputClipping,
    target: HOUSE_LOUDNESS_TARGET,
  });
  if (loudnessVerdict.passed !== true) {
    fail(`REHEARSAL_LOUDNESS_QC_FAILED_${loudnessVerdict.reasonCodes.join("_")}`, JSON.stringify(loudnessVerdict));
  }

  const parsed = probeArtifact(finalPath);
  const bytes = readFileSync(finalPath);
  const inspection = {
    success: true,
    format: { ...parsed.format, filename: path.basename(finalPath) },
    streams: parsed.streams,
  };

  const technical = evaluateTechnicalConformance({ inspection, profile: REHEARSAL_PROFILE });
  if (technical.passed !== true) {
    fail(`REHEARSAL_TECHNICAL_QC_FAILED_${technical.reasonCodes.join("_")}`, JSON.stringify(technical));
  }

  const verdict = evaluateEpisodeCompleteness({ inspection, targetSeconds });
  if (verdict.passed !== true) {
    fail(`REHEARSAL_GATE_FAILED_${verdict.reasonCode}`, JSON.stringify(verdict));
  }

  const evidence = {
    rehearsalId: `real-media-rehearsal-${targetSeconds}`,
    generatedAt: new Date().toISOString(),
    target: { targetSeconds, audioWindow: [targetSeconds - tolerance, targetSeconds + 1] },
    narration: {
      source: "buildNarrationScript (deterministic_local planning text, labelled)",
      scriptType: script.scriptType,
      generationMode: script.generationMode,
      editorialStatus: script.editorialStatus,
      language: script.language,
      wordCount: script.wordCount,
      plannedSeconds: script.plannedSeconds,
      textSha256: createHash("sha256").update(script.text).digest("hex"),
    },
    speechSynthesis: {
      provider: "espeak-ng (real binary, local open-source emergency slot, no credentials)",
      voice: "hi",
      calibration: calibration.attempts,
      settledRate: calibration.rate,
      settledMeasuredAudioSeconds: Number(calibration.measuredSeconds.toFixed(3)),
    },
    assembly: {
      tool: "real ffmpeg (libx264 veryfast crf20, aac 128k, 1920x1080, 2 fps placeholder)",
      visualProvenance: "flat solid-colour placeholder at 2 fps — LABELLED placeholder_rehearsal, delivery:false; validates assembly/QC/loudness, never presented as story footage",
      streams: parsed.streams,
      outputSha256: createHash("sha256").update(bytes).digest("hex"),
      outputSizeBytes: bytes.length,
    },
    loudness: {
      target: { ...HOUSE_LOUDNESS_TARGET },
      measuredInput: {
        integratedLufs: measuredInput.integratedLufs,
        truePeakDbtp: measuredInput.truePeakDbtp,
        loudnessRangeLu: measuredInput.loudnessRangeLu,
        peakLevelDbfs: inputClipping.peakLevelDbfs,
        clippedSampleCount: inputClipping.clippedSampleCount,
        passed: inputVerdict.passed,
        reasonCodes: inputVerdict.reasonCodes,
      },
      normalization,
      measuredOutput: {
        integratedLufs: measuredOutput.integratedLufs,
        truePeakDbtp: measuredOutput.truePeakDbtp,
        loudnessRangeLu: measuredOutput.loudnessRangeLu,
        peakLevelDbfs: outputClipping.peakLevelDbfs,
        clippedSampleCount: outputClipping.clippedSampleCount,
        clippingBasis: outputClipping.clippingBasis,
        integratedDeltaLu: loudnessVerdict.integratedDeltaLu,
      },
      conformance: loudnessVerdict,
    },
    technical: {
      profile: technical.profile,
      delivery: technical.delivery,
      passed: technical.passed,
      reasonCodes: technical.reasonCodes,
      measured: technical.measured,
      note: "Frame rate and sample rate are the values FFprobe measured for THIS artifact. The placeholder profile is explicitly NOT the delivery profile.",
    },
    completenessGate: {
      gate: "evaluateEpisodeCompleteness (S-M41-01, real post-render inspection)",
      passed: verdict.passed,
      reasonCode: verdict.reasonCode,
      videoSeconds: verdict.videoSeconds,
      audioSeconds: verdict.audioSeconds,
      referenceSeconds: verdict.referenceSeconds,
      coverageToleranceSeconds: verdict.coverageToleranceSeconds,
      audioCoverageRatio: verdict.audioCoverageRatio,
    },
    honestLimits: [
      "Placeholder visual (2 fps, colour plate) and planning narration prove the pipeline, not editorial quality; the placeholder profile is delivery:false.",
      "No publishing, no receipts, no analytics: the owner approval gate (Rule 7) is untouched.",
      "Loudness normalization is a real two-pass loudnorm remux; conformance is asserted only on the RE-MEASURED output.",
    ],
  };
  const evidencePath = path.join(dir, "rehearsal-evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    code: "REHEARSAL_COMPLETE",
    targetSeconds,
    gate: verdict.passed,
    loudnessPassed: loudnessVerdict.passed,
    integratedLufs: measuredOutput.integratedLufs,
    truePeakDbtp: measuredOutput.truePeakDbtp,
    clippedSampleCount: outputClipping.clippedSampleCount,
    normalizationApplied: normalization.applied,
    technicalPassed: technical.passed,
    audioCoverageRatio: verdict.audioCoverageRatio,
    settledSynthesisRate: calibration.rate,
    iterations: calibration.iterations,
    outputSha256: evidence.assembly.outputSha256,
    evidencePath,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? "REHEARSAL_FAILED", message: error.message }));
  process.exit(1);
}
