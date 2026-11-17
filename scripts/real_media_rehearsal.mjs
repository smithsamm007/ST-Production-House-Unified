#!/usr/bin/env node
/**
 * ST Production House — REAL media rehearsal (repeatable evidence runner, Issue #263).
 *
 * Validates, on a media-capable host, one complete 30/40/50-minute episode
 * and a standalone 9:16 brand promo Reel to full technical conformance:
 *
 *   deterministic narration script (labelled planning text)
 *     → REAL speech synthesis (espeak-ng, local open-source emergency provider)
 *     → rate auto-calibration against REAL measured durations
 *     → REAL two-pass audio loudness normalization (ffmpeg loudnorm, linear
 *       applying pass -> -14 LUFS / -2.5 dBTP delivery headroom; the published
 *       QC contract stays -1 dBTP and is never relaxed to make a render pass)
 *     → REAL ffmpeg assembly (1920x1080 16:9 main video + 1080x1920 9:16 brand promo Reel)
 *     → REAL ffprobe inspection & ebur128/loudnorm loudness analysis of RENDERED files
 *       → evaluateEpisodeCompleteness (S-M41-01, S-M43-01 audio-coverage & technical QC)
 *         → PASS verdict + durable evidence JSON in artifacts/rehearsal/
 *
 * HONESTY (AGENTS.md Rules 1–3):
 *   - Narration text is `generationMode: deterministic_local`
 *     (`editorialStatus: deterministic_planning_text`) — it is PLANNING
 *     narration, never a claim of editorial quality.
 *   - Visuals are flat solid-colour placeholders, EXPLICITLY LABELED `placeholder`.
 *     They exist to exercise assembly/QC/coverage/conformance with real bytes —
 *     never presented as finished creative footage (AGENTS.md Rule 3).
 *   - Every duration, sample rate, frame rate, resolution, integrated LUFS,
 *     true peak dBTP, and clipping count reported is a REAL ffprobe / ffmpeg
 *     measurement of the on-disk bytes.
 *   - No motion, no BGM/SFX, no publishing, no receipts. Publishing stays
 *     behind the owner approval gate (Rule 7).
 *
 * Usage:
 *   node scripts/real_media_rehearsal.mjs --target=1800   (or 2400 / 3000)
 *   npm run real-media-rehearsal
 *
 * Requires: espeak-ng, ffmpeg, ffprobe on PATH.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildNarrationScript } from "../src/pipeline/narrationScript.js";
import {
  audioCoverageToleranceSeconds,
  evaluateEpisodeCompleteness,
  parseStreamTechnicalProperties,
} from "../src/media/episodeCompleteness.js";
import { parseLoudnormOutput } from "../src/media/mediaInspectionRunner.js";
import {
  DELIVERY_TARGET_LUFS,
  DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
  MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS,
  QC_MAX_TRUE_PEAK_DBTP,
  buildMeasuredNormalizationFilter,
  selectGateLoudness,
  verifyAndCorrectDeliveredAudio,
} from "../src/media/loudnessNormalization.js";

const OUT_ROOT = "artifacts/rehearsal";
const MAX_CALIBRATION_ATTEMPTS = 4;
const TARGET_LUFS = DELIVERY_TARGET_LUFS;
// The published QC contract (unchanged): the delivered file must not exceed it.
const MAX_TRUE_PEAK_DBTP = QC_MAX_TRUE_PEAK_DBTP;
// What the delivery pass aims for, leaving headroom for the AAC encode.
const NORMALIZATION_TRUE_PEAK_DBTP = DELIVERY_TRUE_PEAK_HEADROOM_DBTP;
const REQUIRED_SAMPLE_RATE = 48000;
const BRAND_REEL_SECONDS = 30;

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

function measureLoudnessSync(filePath) {
  const child = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-i", filePath, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const stderr = typeof child.stderr === "string" ? child.stderr : "";
  return parseLoudnormOutput(stderr);
}

function hashFileSync(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * One corrective pass for a delivered file whose encoded audio still breaches
 * the QC true peak: extract the real audio, two-pass normalize it to the
 * stepped delivery target, remux it over the original (video stream copied,
 * never re-encoded), and verify the remuxed audio stream decodes cleanly
 * before replacing the deliverable.
 */
function applyCorrectiveNormalization({
  videoPath,
  targetLufs = TARGET_LUFS,
  maxTruePeak = NORMALIZATION_TRUE_PEAK_DBTP,
  attempt = 1,
}) {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const extractedPath = path.join(dir, `${stem}_delivered_audio_attempt_${attempt}.wav`);
  const correctedPath = path.join(dir, `${stem}_delivered_audio_normalized_attempt_${attempt}.wav`);
  const remuxedPath = path.join(dir, `${stem}_corrected_attempt_${attempt}.mp4`);
  execFileSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", videoPath, "-vn", "-acodec", "pcm_s16le", extractedPath],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  const correctedLoudness = normalizeAudioSync({
    inputPath: extractedPath,
    outputPath: correctedPath,
    targetLufs,
    maxTruePeak,
  });
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-i", videoPath,
      "-i", correctedPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "128k", "-ar", String(REQUIRED_SAMPLE_RATE),
      "-shortest",
      remuxedPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", remuxedPath, "-vn", "-f", "null", "-"],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  renameSync(remuxedPath, videoPath);
  return { correctedLoudness, extractedPath, correctedPath, headroomDbtp: maxTruePeak };
}

function normalizeAudioSync({ inputPath, outputPath, targetLufs = TARGET_LUFS, maxTruePeak = NORMALIZATION_TRUE_PEAK_DBTP }) {
  // TWO-PASS loudnorm. The single-pass dynamic pass used before measured
  // -15.47 LUFS against a -14.0 target and only bounded the peak of the buffer
  // it processed, so the AAC-encoded deliverable later measured +0.14 dBTP.
  // Pass 1 measures the real input; pass 2 applies a linear filter from those
  // measurements.
  const inputMeasured = measureLoudnessSync(inputPath);
  const filter = buildMeasuredNormalizationFilter({ targetLufs, maxTruePeak, measured: inputMeasured });
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-i", inputPath,
      "-af", filter,
      "-ar", String(REQUIRED_SAMPLE_RATE),
      outputPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  const measured = measureLoudnessSync(outputPath);
  if (measured.truePeakDbtp > maxTruePeak + 0.1) {
    fail(
      "REHEARSAL_LOUDNORM_CLIPPING",
      `Normalized audio missed its delivery peak target: true peak ${measured.truePeakDbtp} dBTP over target ${maxTruePeak} dBTP`,
    );
  }
  if (Math.abs(measured.integratedLufs - targetLufs) > 2.0) {
    fail("REHEARSAL_LOUDNORM_TARGET_MISSED", `Normalized audio LUFS ${measured.integratedLufs} missed target ${targetLufs}`);
  }
  return measured;
}

/**
 * Calibrate the synthesis rate against REAL measurements: duration scales
 * ≈ 1/rate, so each attempt multiplies the current rate by measure/target,
 * bounded to MAX_CALIBRATION_ATTEMPTS.
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
  const rawAudioPath = path.join(dir, "narration_raw.wav");
  const normAudioPath = path.join(dir, "narration_normalized.wav");
  const videoPath = path.join(dir, "episode.mp4");
  const brandReelPath = path.join(dir, "brand_reel.mp4");

  writeFileSync(textPath, script.text);
  const calibration = calibrateNarration({ textPath, outputPath: rawAudioPath, targetSeconds, tolerance });

  // Real loudness measurement of raw speech synthesis
  const rawSpeechLoudness = measureLoudnessSync(rawAudioPath);

  // Real loudness normalization pass to delivery headroom target (-14 LUFS / -2.5 dBTP, 48 kHz)
  const normSpeechLoudness = normalizeAudioSync({
    inputPath: rawAudioPath,
    outputPath: normAudioPath,
    targetLufs: TARGET_LUFS,
    maxTruePeak: NORMALIZATION_TRUE_PEAK_DBTP,
  });

  // Long-form 16:9 episode assembly (1920x1080, AAC 48 kHz)
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x101418:s=1920x1080:r=2`,
      "-i", normAudioPath,
      "-map", "0:v", "-map", "1:a", "-t", String(targetSeconds),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", String(REQUIRED_SAMPLE_RATE),
      videoPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );

  // Standalone 9:16 brand promo Reel assembly (1080x1920, 30s, AAC 48 kHz)
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x181024:s=1080x1920:r=2`,
      "-i", normAudioPath,
      "-map", "0:v", "-map", "1:a", "-t", String(BRAND_REEL_SECONDS),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", String(REQUIRED_SAMPLE_RATE),
      brandReelPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );

  // Real ffprobe inspections bound to the exact on-disk file SHA-256
  const probeFile = (file) => {
    const contentSha256 = hashFileSync(file);
    const json = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,duration", "-show_entries", "format=duration,size", "-of", "json", file],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(json);
    return {
      success: true,
      contentSha256,
      format: { ...parsed.format, filename: path.basename(file) },
      streams: parsed.streams,
    };
  };

  // Finalize delivered files: complete all bounded corrective AAC operations,
  // re-probe the exact final output, re-measure loudness, and capture the
  // final SHA-256 from that same delivered file.
  const longformFinal = verifyAndCorrectDeliveredAudio({
    filePath: videoPath,
    targetLufs: TARGET_LUFS,
    maxTruePeakDbtp: MAX_TRUE_PEAK_DBTP,
    baseHeadroomDbtp: NORMALIZATION_TRUE_PEAK_DBTP,
    maxAttempts: MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS,
    probeFile,
    measureLoudness: measureLoudnessSync,
    hashFile: hashFileSync,
    applyCorrection: applyCorrectiveNormalization,
    onCorrectionAttempt: (info) => {
      console.log(JSON.stringify({ code: "REHEARSAL_CORRECTIVE_NORMALIZATION", asset: "longform", ...info }));
    },
  });
  const brandReelFinal = verifyAndCorrectDeliveredAudio({
    filePath: brandReelPath,
    targetLufs: TARGET_LUFS,
    maxTruePeakDbtp: MAX_TRUE_PEAK_DBTP,
    baseHeadroomDbtp: NORMALIZATION_TRUE_PEAK_DBTP,
    maxAttempts: MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS,
    probeFile,
    measureLoudness: measureLoudnessSync,
    hashFile: hashFileSync,
    applyCorrection: applyCorrectiveNormalization,
    onCorrectionAttempt: (info) => {
      console.log(JSON.stringify({ code: "REHEARSAL_CORRECTIVE_NORMALIZATION", asset: "brand_reel", ...info }));
    },
  });

  const longformInspection = longformFinal.inspection;
  const brandReelInspection = brandReelFinal.inspection;
  const longformLoudness = longformFinal.loudness;
  const brandReelLoudness = brandReelFinal.loudness;

  // Conformance gate on long-form (evaluated strictly on final post-remux inspection + loudness)
  const longformVerdict = evaluateEpisodeCompleteness({
    inspection: longformInspection,
    targetSeconds,
    expectedWidth: 1920,
    expectedHeight: 1080,
    expectedAspectRatio: "16:9",
    requiredSampleRate: REQUIRED_SAMPLE_RATE,
    loudness: selectGateLoudness({
      assembled: longformLoudness,
      rawSpeech: rawSpeechLoudness,
      normalizedSpeech: normSpeechLoudness,
    }),
    targetLufs: TARGET_LUFS,
    maxTruePeakDbtp: MAX_TRUE_PEAK_DBTP,
  });
  if (longformVerdict.passed !== true) {
    fail(`REHEARSAL_GATE_FAILED_${longformVerdict.reasonCode}`, JSON.stringify(longformVerdict));
  }

  // Conformance gate on brand Reel (assert 9:16 on final post-remux inspection + loudness)
  const brandReelVerdict = evaluateEpisodeCompleteness({
    inspection: brandReelInspection,
    targetSeconds: BRAND_REEL_SECONDS,
    expectedWidth: 1080,
    expectedHeight: 1920,
    expectedAspectRatio: "9:16",
    requiredSampleRate: REQUIRED_SAMPLE_RATE,
    loudness: selectGateLoudness({
      assembled: brandReelLoudness,
      rawSpeech: rawSpeechLoudness,
      normalizedSpeech: normSpeechLoudness,
    }),
    targetLufs: TARGET_LUFS,
    maxTruePeakDbtp: MAX_TRUE_PEAK_DBTP,
  });
  if (brandReelVerdict.passed !== true) {
    fail(`REHEARSAL_BRAND_REEL_GATE_FAILED_${brandReelVerdict.reasonCode}`, JSON.stringify(brandReelVerdict));
  }

  const longformBytes = readFileSync(videoPath);
  const brandReelBytes = readFileSync(brandReelPath);
  const longformFinalSha256 = createHash("sha256").update(longformBytes).digest("hex");
  const brandReelFinalSha256 = createHash("sha256").update(brandReelBytes).digest("hex");
  if (longformFinalSha256 !== longformInspection.contentSha256) {
    fail("REHEARSAL_FILE_IDENTITY_MISMATCH", "longform file SHA-256 does not match final inspection SHA-256");
  }
  if (brandReelFinalSha256 !== brandReelInspection.contentSha256) {
    fail("REHEARSAL_FILE_IDENTITY_MISMATCH", "brand reel file SHA-256 does not match final inspection SHA-256");
  }
  const longformTechnical = parseStreamTechnicalProperties(longformInspection);
  const brandReelTechnical = parseStreamTechnicalProperties(brandReelInspection);

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
    loudnessNormalization: {
      pass: "real two-pass ffmpeg loudnorm (measuring pass, then a linear applying pass using measured_I/measured_TP/measured_LRA/measured_thresh), delivery target -14 LUFS / -2.5 dBTP for AAC headroom, 48 kHz",
      targetIntegratedLufs: TARGET_LUFS,
      deliveryTruePeakDbtp: NORMALIZATION_TRUE_PEAK_DBTP,
      qcMaxTruePeakDbtp: MAX_TRUE_PEAK_DBTP,
      correctivePassApplied: longformFinal.correctivePassApplied,
      correctivePassCount: longformFinal.correctivePasses.length,
      brandReelCorrectivePassApplied: brandReelFinal.correctivePassApplied,
      deliveredFile: {
        integratedLufs: longformLoudness.integratedLufs,
        truePeakDbtp: longformLoudness.truePeakDbtp,
        clippingCount: longformLoudness.clippingCount,
      },
      rawSpeech: {
        integratedLufs: rawSpeechLoudness.integratedLufs,
        truePeakDbtp: rawSpeechLoudness.truePeakDbtp,
        loudnessRangeLu: rawSpeechLoudness.loudnessRangeLu,
        clippingCount: rawSpeechLoudness.clippingCount,
      },
      normalizedSpeech: {
        integratedLufs: normSpeechLoudness.integratedLufs,
        truePeakDbtp: normSpeechLoudness.truePeakDbtp,
        loudnessRangeLu: normSpeechLoudness.loudnessRangeLu,
        clippingCount: normSpeechLoudness.clippingCount,
      },
    },
    assembly: {
      longform: {
        tool: "real ffmpeg (libx264 veryfast crf20, aac 128k 48kHz, 16:9 1920x1080)",
        visualProvenance: "placeholder: flat solid-colour placeholder plate (1920x1080, r=2) — explicitly LABELED placeholder (AGENTS.md Rule 3); valid only for testing assembly, timing, audio coverage, and technical container conformance, NEVER finished creative footage",
        streams: longformInspection.streams,
        outputSha256: longformFinalSha256,
        outputSizeBytes: longformBytes.length,
      },
      brandReel: {
        tool: "real ffmpeg (libx264 veryfast crf21, aac 128k 48kHz, 9:16 1080x1920 standalone brand Reel)",
        visualProvenance: "placeholder: flat solid-colour placeholder plate (1080x1920, r=2) — explicitly LABELED placeholder (AGENTS.md Rule 3); valid only for testing assembly, timing, audio coverage, and technical container conformance, NEVER finished creative footage",
        streams: brandReelInspection.streams,
        outputSha256: brandReelFinalSha256,
        outputSizeBytes: brandReelBytes.length,
      },
    },
    technicalConformance: {
      longform: {
        resolution: `${longformTechnical.video.width}x${longformTechnical.video.height}`,
        aspectRatio: longformTechnical.video.aspectRatio,
        frameRate: longformTechnical.video.frameRate,
        videoCodec: longformTechnical.video.codec,
        audioCodec: longformTechnical.audio.codec,
        sampleRate: longformTechnical.audio.sampleRate,
        channels: longformTechnical.audio.channels,
        loudness: {
          integratedLufs: longformLoudness.integratedLufs,
          truePeakDbtp: longformLoudness.truePeakDbtp,
          clippingCount: longformLoudness.clippingCount,
        },
        resolutionConforms: longformTechnical.video.width === 1920 && longformTechnical.video.height === 1080,
      },
      brandReel: {
        resolution: `${brandReelTechnical.video.width}x${brandReelTechnical.video.height}`,
        aspectRatio: brandReelTechnical.video.aspectRatio,
        frameRate: brandReelTechnical.video.frameRate,
        videoCodec: brandReelTechnical.video.codec,
        audioCodec: brandReelTechnical.audio.codec,
        sampleRate: brandReelTechnical.audio.sampleRate,
        channels: brandReelTechnical.audio.channels,
        loudness: {
          integratedLufs: brandReelLoudness.integratedLufs,
          truePeakDbtp: brandReelLoudness.truePeakDbtp,
          clippingCount: brandReelLoudness.clippingCount,
        },
        resolutionConforms: brandReelTechnical.video.width === 1080 && brandReelTechnical.video.height === 1920,
      },
    },
    completenessGate: {
      longformVerdict: {
        gate: "evaluateEpisodeCompleteness (S-M41-01, S-M43-01 technical QC)",
        passed: longformVerdict.passed,
        reasonCode: longformVerdict.reasonCode,
        videoSeconds: longformVerdict.videoSeconds,
        audioSeconds: longformVerdict.audioSeconds,
        referenceSeconds: longformVerdict.referenceSeconds,
        coverageToleranceSeconds: longformVerdict.coverageToleranceSeconds,
        audioCoverageRatio: longformVerdict.audioCoverageRatio,
      },
      brandReelVerdict: {
        gate: "evaluateEpisodeCompleteness (S-M41-01, S-M43-01 technical QC)",
        passed: brandReelVerdict.passed,
        reasonCode: brandReelVerdict.reasonCode,
        videoSeconds: brandReelVerdict.videoSeconds,
        audioSeconds: brandReelVerdict.audioSeconds,
        referenceSeconds: brandReelVerdict.referenceSeconds,
      },
    },
    honestLimits: [
      "Placeholder visuals and planning narration prove the technical pipeline, not creative/editorial quality.",
      "No publishing, no receipts, no analytics: the owner approval gate (Rule 7) is untouched.",
      "Standalone brand promo Reel is asserted as 9:16 (1080x1920) and main longform as 16:9 (1920x1080).",
    ],
  };

  const evidencePath = path.join(dir, "rehearsal-evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    code: "REHEARSAL_COMPLETE",
    targetSeconds,
    longformGate: longformVerdict.passed,
    brandReelGate: brandReelVerdict.passed,
    audioCoverageRatio: longformVerdict.audioCoverageRatio,
    measuredLongformLufs: longformLoudness.integratedLufs,
    measuredLongformTruePeak: longformLoudness.truePeakDbtp,
    qcMaxTruePeakDbtp: MAX_TRUE_PEAK_DBTP,
    deliveryTruePeakDbtp: NORMALIZATION_TRUE_PEAK_DBTP,
    correctivePassApplied: longformFinal.correctivePassApplied,
    correctivePassCount: longformFinal.correctivePasses.length,
    measuredBrandReelLufs: brandReelLoudness.integratedLufs,
    measuredBrandReelTruePeak: brandReelLoudness.truePeakDbtp,
    longformResolution: `${longformTechnical.video.width}x${longformTechnical.video.height}`,
    brandReelResolution: `${brandReelTechnical.video.width}x${brandReelTechnical.video.height}`,
    settledSynthesisRate: calibration.rate,
    iterations: calibration.iterations,
    outputSha256: evidence.assembly.longform.outputSha256,
    evidencePath,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? "REHEARSAL_FAILED", message: error.message }));
  process.exit(1);
}
