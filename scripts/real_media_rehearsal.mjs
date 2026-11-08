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
 *     → REAL ffprobe inspection of the rendered file (sample rate, frame rate, resolution)
 *     → REAL ebur128/loudnorm loudness analysis (measured LUFS, true peak dBTP, clipping)
 *     → REAL post-render loudness normalization pass (measured input -> normalized output)
 *     → REAL post-normalization verification & gate on measured result
 *       → evaluateEpisodeCompleteness (S-M41-01 audio-coverage gate)
 *         → PASS verdict + durable evidence JSON in artifacts/rehearsal/
 *
 * HONESTY (AGENTS.md Rules 1–3):
 *   - Narration text is `generationMode: deterministic_local`
 *     (`editorialStatus: deterministic_planning_text`) — it is PLANNING
 *     narration, never a claim of editorial quality.
 *   - The visual is a flat solid-colour placeholder, explicitly LABELED
 *     `placeholder`. It exists to exercise assembly/QC/coverage with real bytes
 *     at a bounded 2 fps placeholder rate — NEVER presented as finished creative
 *     output or story footage.
 *   - Every duration, loudness value, sample rate, frame rate, and resolution
 *     reported is a REAL ffprobe / ffmpeg measurement of the on-disk bytes.
 *     No constants are assumed. No motion, no BGM/SFX, no publishing, no receipts.
 *     Publishing stays behind the owner approval gate (Rule 7).
 *
 * Usage:
 *   node scripts/real_media_rehearsal.mjs --target=1800   (or 2400 / 3000)
 *   npm run real-media-rehearsal
 *
 * Requires: espeak-ng, ffmpeg, ffprobe on PATH (missing dependencies fail
 * honestly with REHEARSAL_DEPENDENCY_MISSING — never skipped silently).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildNarrationScript } from "../src/pipeline/narrationScript.js";
import {
  audioCoverageToleranceSeconds,
  evaluateEpisodeCompleteness,
} from "../src/media/episodeCompleteness.js";
import {
  measureLoudness,
  normalizeLoudness,
  evaluateTechnicalConformance,
} from "../src/media/loudnessQc.js";

const OUT_ROOT = "artifacts/rehearsal";
const MAX_CALIBRATION_ATTEMPTS = 4;

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

function probeDurationSeconds(file) {
  const json = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8" });
  const parsed = JSON.parse(json);
  const seconds = Number(parsed?.format?.duration);
  if (!Number.isFinite(seconds)) fail("REHEARSAL_PROBE_FAILED", `no measured duration for ${file}`);
  return seconds;
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

async function main() {
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
  const normalizedVideoPath = path.join(dir, "episode-normalized.mp4");

  writeFileSync(textPath, script.text);
  const calibration = calibrateNarration({ textPath, outputPath: audioPath, targetSeconds, tolerance });

  // Render initial assembled artifact (video + speech)
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x101418:s=1920x1080:r=2`,
      "-i", audioPath,
      "-map", "0:v", "-map", "1:a", "-t", String(targetSeconds),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      videoPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  // Full real ffprobe inspection of the initial rendered file
  const probeArgs = [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,width,height,r_frame_rate,avg_frame_rate,duration",
    "-show_entries", "format=duration,size",
    "-of", "json",
    videoPath,
  ];
  const streamsJson = execFileSync("ffprobe", probeArgs, { encoding: "utf8" });
  const parsed = JSON.parse(streamsJson);
  const bytes = readFileSync(videoPath);
  const inspection = {
    success: true,
    format: { ...parsed.format, filename: path.basename(videoPath) },
    streams: parsed.streams,
  };

  // Evaluate technical conformance on the real inspection
  const conformanceVerdict = evaluateTechnicalConformance(inspection, {
    targetKind: "main_longform",
    expectedAspectRatio: "16:9",
    expectedResolution: { width: 1920, height: 1080 },
  });
  if (conformanceVerdict.passed !== true) {
    fail(`REHEARSAL_CONFORMANCE_FAILED_${conformanceVerdict.reasonCode}`, JSON.stringify(conformanceVerdict));
  }

  // Completeness gate evaluation
  const verdict = evaluateEpisodeCompleteness({ inspection, targetSeconds });
  if (verdict.passed !== true) {
    fail(`REHEARSAL_GATE_FAILED_${verdict.reasonCode}`, JSON.stringify(verdict));
  }

  // Real loudness measurement on initial render (ebur128 / loudnorm / astats)
  const initialLoudness = await measureLoudness(videoPath);

  // Real loudness normalization pass (measured input -> normalized output)
  const normResult = await normalizeLoudness(videoPath, normalizedVideoPath, {
    targetI: -14.0,
    targetTp: -1.5,
    targetLra: 11.0,
    tolerance: 2.0,
  });

  // Verify post-normalization artifact with ffprobe
  const normProbeJson = execFileSync("ffprobe", probeArgs.slice(0, -1).concat(normalizedVideoPath), { encoding: "utf8" });
  const normParsed = JSON.parse(normProbeJson);
  const normBytes = readFileSync(normalizedVideoPath);
  const normInspection = {
    success: true,
    format: { ...normParsed.format, filename: path.basename(normalizedVideoPath) },
    streams: normParsed.streams,
  };
  const normCompleteness = evaluateEpisodeCompleteness({ inspection: normInspection, targetSeconds });
  if (normCompleteness.passed !== true) {
    fail(`REHEARSAL_NORMALIZED_GATE_FAILED_${normCompleteness.reasonCode}`, JSON.stringify(normCompleteness));
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
      tool: "real ffmpeg (libx264 veryfast crf20, aac 128k, 16:9 1920x1080)",
      visualProvenance: "flat solid-colour placeholder — LABELLED `placeholder`; 2 fps placeholder rate validates assembly/QC/coverage/loudness with real bytes, never presented as finished creative output or story footage",
      streams: parsed.streams,
      outputSha256: createHash("sha256").update(bytes).digest("hex"),
      outputSizeBytes: bytes.length,
      measuredProperties: {
        width: conformanceVerdict.video.width,
        height: conformanceVerdict.video.height,
        aspectRatio: conformanceVerdict.video.aspectRatio,
        videoCodec: conformanceVerdict.video.codec,
        frameRate: conformanceVerdict.video.frameRate,
        frameRateString: conformanceVerdict.video.frameRateString,
        audioCodec: conformanceVerdict.audio.codec,
        sampleRate: conformanceVerdict.audio.sampleRate,
      },
    },
    loudness: {
      preNormalization: {
        integratedLufs: initialLoudness.integratedLufs,
        truePeakDbtp: initialLoudness.truePeakDbtp,
        lraLu: initialLoudness.lraLu,
        clippingCount: initialLoudness.clippingCount,
      },
      postNormalization: {
        integratedLufs: normResult.normalized.integratedLufs,
        truePeakDbtp: normResult.normalized.truePeakDbtp,
        lraLu: normResult.normalized.lraLu,
        clippingCount: normResult.normalized.clippingCount,
        targetLufs: normResult.target.targetI,
        targetTruePeakDbtp: normResult.target.targetTp,
        normalizedSha256: createHash("sha256").update(normBytes).digest("hex"),
        normalizedSizeBytes: normBytes.length,
      },
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
      normalizedPassed: normCompleteness.passed,
    },
    honestLimits: [
      "Placeholder visual explicitly labelled placeholder; proves assembly, QC, and technical conformance, not creative visual fidelity.",
      "Loudness is measured honestly with real ebur128/loudnorm and normalized via a real FFmpeg pass.",
      "No publishing, no receipts, no analytics: the owner approval gate (Rule 7) is untouched.",
      "Rate auto-calibration currently lives in THIS rehearsal runner; wiring it into the production audio stage is the governed follow-up.",
    ],
  };

  const evidencePath = path.join(dir, "rehearsal-evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

  console.log(JSON.stringify({
    code: "REHEARSAL_COMPLETE",
    targetSeconds,
    gate: verdict.passed,
    audioCoverageRatio: verdict.audioCoverageRatio,
    settledSynthesisRate: calibration.rate,
    iterations: calibration.iterations,
    measuredTechnicalConformance: {
      resolution: `${conformanceVerdict.video.width}x${conformanceVerdict.video.height}`,
      aspectRatio: conformanceVerdict.video.aspectRatio,
      frameRate: conformanceVerdict.video.frameRateString,
      sampleRate: `${conformanceVerdict.audio.sampleRate}Hz`,
      audioCodec: conformanceVerdict.audio.codec,
    },
    measuredLoudness: {
      preNormalizedLufs: initialLoudness.integratedLufs,
      preNormalizedTruePeakDbtp: initialLoudness.truePeakDbtp,
      preNormalizedClippingCount: initialLoudness.clippingCount,
      normalizedLufs: normResult.normalized.integratedLufs,
      normalizedTruePeakDbtp: normResult.normalized.truePeakDbtp,
      normalizedClippingCount: normResult.normalized.clippingCount,
    },
    outputSha256: evidence.assembly.outputSha256,
    normalizedSha256: evidence.loudness.postNormalization.normalizedSha256,
    evidencePath,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ code: error.code ?? "REHEARSAL_FAILED", message: error.message }));
  process.exit(1);
});
