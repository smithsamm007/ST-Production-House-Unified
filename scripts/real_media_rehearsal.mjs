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
 *     → REAL ffprobe inspection of the rendered file
 *       → evaluateEpisodeCompleteness (S-M41-01 audio-coverage gate)
 *         → PASS verdict + durable evidence JSON in artifacts/rehearsal/
 *
 * HONESTY (AGENTS.md Rules 1–3):
 *   - Narration text is `generationMode: deterministic_local`
 *     (`editorialStatus: deterministic_planning_text`) — it is PLANNING
 *     narration, never a claim of editorial quality.
 *   - The visual is a flat solid-colour placeholder, labelled. It exists to
 *     exercise assembly/QC/coverage with real bytes — never story footage.
 *   - Every duration reported is a REAL ffprobe measurement of the on-disk
 *     bytes. No motion, no BGM/SFX, no publishing, no receipts. Publishing
 *     stays behind the owner approval gate (Rule 7).
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

  writeFileSync(textPath, script.text);
  const calibration = calibrateNarration({ textPath, outputPath: audioPath, targetSeconds, tolerance });

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

  const streamsJson = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,duration", "-show_entries", "format=duration,size", "-of", "json", videoPath], { encoding: "utf8" });
  const parsed = JSON.parse(streamsJson);
  const bytes = readFileSync(videoPath);
  const inspection = {
    success: true,
    format: { ...parsed.format, filename: path.basename(videoPath) },
    streams: parsed.streams,
  };
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
      tool: "real ffmpeg (libx264 veryfast crf20, aac 128k, 16:9 1920x1080)",
      visualProvenance: "flat solid-colour placeholder — LABELLED; validates assembly/QC/coverage, never presented as story footage",
      streams: parsed.streams,
      outputSha256: createHash("sha256").update(bytes).digest("hex"),
      outputSizeBytes: bytes.length,
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
      "Placeholder visual and planning narration prove the pipeline, not editorial quality.",
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
