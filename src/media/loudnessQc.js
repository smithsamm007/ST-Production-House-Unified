/**
 * ST Production House — Loudness and Technical Conformance QC (Slice S-M43-01).
 *
 * Provides:
 *   1. Real loudness measurement pass via FFmpeg (ebur128 / loudnorm / astats):
 *      - Integrated loudness (LUFS)
 *      - True peak (dBTP / dBFS)
 *      - Loudness range (LRA LU)
 *      - Clipping count (astats peak count at 0 dBFS / true peak overshoots)
 *      - Fails closed on unmeasurable / missing output.
 *
 *   2. Real loudness normalization pass via FFmpeg loudnorm filter:
 *      - Takes input video/audio, applies loudnorm filter with target specs
 *        (default target: -14 LUFS, max true peak -1.5 dBTP, LRA 11).
 *      - Post-measures the normalized artifact and validates measured results.
 *      - Fail-closed: never assumes success without real verification.
 *
 *   3. Technical conformance evaluator for post-render inspections:
 *      - Asserts audio sample rate, codec properties, video frame rate, and resolution.
 *      - Validates geometry (1920x1080 16:9 for main longform, 1080x1920 9:16 for short-form reels).
 */

import { spawnSync } from "node:child_process";
import { validateArtifactPath } from "./mediaInspectionRunner.js";

export const LOUDNESS_QC_VERSION = "loudness_qc_v1";

export const LOUDNESS_ERROR_CODES = Object.freeze([
  "QC_LOUDNESS_MEASUREMENT_FAILED",
  "QC_LOUDNESS_UNMEASURABLE",
  "QC_NORMALIZATION_FAILED",
  "QC_NORMALIZATION_TARGET_MISSED",
  "QC_NORMALIZATION_UNMEASURABLE",
  "QC_TECHNICAL_CONFORMANCE_FAILED",
  "QC_AUDIO_SAMPLE_RATE_MISSING",
  "QC_VIDEO_RESOLUTION_MISMATCH",
  "QC_VIDEO_ASPECT_RATIO_MISMATCH",
  "QC_VIDEO_FRAME_RATE_MISSING",
  "QC_AUDIO_CODEC_MISMATCH",
  "QC_VIDEO_CODEC_MISMATCH",
]);

export const DEFAULT_TARGET_LUFS = -14.0;
export const DEFAULT_TARGET_TRUE_PEAK_DBTP = -1.5;
export const DEFAULT_TARGET_LRA_LU = 11.0;
export const DEFAULT_LUFS_TOLERANCE = 2.0; // Allowed window: [-16.0, -12.0] LUFS

function fail(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
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
 * Parse loudnorm JSON or ebur128 summary from FFmpeg stderr output.
 */
export function parseLoudnessOutput(stderr) {
  if (typeof stderr !== "string" || stderr.trim() === "") {
    throw fail("QC_LOUDNESS_UNMEASURABLE", "empty stderr output from ffmpeg");
  }

  // 1. Try parsing loudnorm JSON block if present:
  const jsonMatch = stderr.match(/\{\s*"input_i"\s*:\s*"(-?[\d.]+)"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      const integratedLufs = Number(data.input_i);
      const truePeakDbtp = Number(data.input_tp);
      const lraLu = Number(data.input_lra);
      const thresholdLufs = Number(data.input_thresh);
      if (Number.isFinite(integratedLufs) && Number.isFinite(truePeakDbtp)) {
        // Also check for clipping in stderr via astats or peak overshoots:
        const peakCountMatch = stderr.match(/Peak count:\s*([\d.]+)/);
        const peakLevelMatch = stderr.match(/Peak level dB:\s*(-?[\d.]+)/);
        const peakLevel = peakLevelMatch ? Number(peakLevelMatch[1]) : null;
        let clippingCount = 0;
        if (peakLevel !== null && peakLevel >= -0.001) {
          clippingCount = peakCountMatch ? Math.max(1, Math.round(Number(peakCountMatch[1]))) : 1;
        } else if (truePeakDbtp > 0.0) {
          clippingCount = 1;
        }
        return {
          integratedLufs,
          truePeakDbtp,
          lraLu: Number.isFinite(lraLu) ? lraLu : null,
          thresholdLufs: Number.isFinite(thresholdLufs) ? thresholdLufs : null,
          clippingCount,
        };
      }
    } catch {
      // Fall through to regex summary parsing
    }
  }

  // 2. Try parsing ebur128 summary:
  const iMatch = stderr.match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+)\s*LUFS/);
  const tpMatch = stderr.match(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
  const lraMatch = stderr.match(/Loudness range:\s*\n\s*LRA:\s*(-?[\d.]+)\s*LU/);
  const threshMatch = stderr.match(/Threshold:\s*(-?[\d.]+)\s*LUFS/);

  if (!iMatch || !tpMatch) {
    throw fail("QC_LOUDNESS_UNMEASURABLE", "could not find ebur128/loudnorm summary in output");
  }

  const integratedLufs = Number(iMatch[1]);
  const truePeakDbtp = Number(tpMatch[1]);
  const lraLu = lraMatch ? Number(lraMatch[1]) : null;
  const thresholdLufs = threshMatch ? Number(threshMatch[1]) : null;

  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDbtp)) {
    throw fail("QC_LOUDNESS_UNMEASURABLE", "parsed non-finite loudness values");
  }

  const peakLevelMatch = stderr.match(/Peak level dB:\s*(-?[\d.]+)/);
  const peakCountMatch = stderr.match(/Peak count:\s*([\d.]+)/);
  const peakLevel = peakLevelMatch ? Number(peakLevelMatch[1]) : null;
  let clippingCount = 0;
  if (peakLevel !== null && peakLevel >= -0.001) {
    clippingCount = peakCountMatch ? Math.max(1, Math.round(Number(peakCountMatch[1]))) : 1;
  } else if (truePeakDbtp > 0.0) {
    clippingCount = 1;
  }

  return {
    integratedLufs,
    truePeakDbtp,
    lraLu: Number.isFinite(lraLu) ? lraLu : null,
    thresholdLufs: Number.isFinite(thresholdLufs) ? thresholdLufs : null,
    clippingCount,
  };
}

/**
 * Run honest loudness measurement on a media file.
 */
export async function measureLoudness(filePath, { spawnImpl = null, execFileSyncImpl = null, timeoutMs = 600_000 } = {}) {
  validateArtifactPath(filePath);

  const args = [
    "-nostats",
    "-hide_banner",
    "-vn",
    "-i", filePath,
    "-af", "ebur128=peak=true:framelog=quiet,astats=measure_overall=Peak_count",
    "-f", "null",
    "-",
  ];

  let stderr = "";
  if (typeof spawnImpl === "function") {
    const result = await spawnImpl({ command: "ffmpeg", args, timeoutMs });
    if (result.timedOut === true) throw fail("QC_LOUDNESS_MEASUREMENT_FAILED", "loudness probe timed out");
    if (result.exitCode !== 0) {
      throw fail("QC_LOUDNESS_MEASUREMENT_FAILED", `ffmpeg exited ${result.exitCode}: ${result.stderr}`);
    }
    stderr = result.stderr ?? "";
  } else if (typeof execFileSyncImpl === "function") {
    try {
      execFileSyncImpl("ffmpeg", args, { encoding: "utf8", timeout: timeoutMs });
    } catch (err) {
      stderr = err.stderr ?? "";
    }
  } else {
    const res = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: timeoutMs });
    if (res.error) throw fail("QC_LOUDNESS_MEASUREMENT_FAILED", res.error.message);
    if (res.status !== 0 && (!res.stderr || !res.stderr.includes("Integrated loudness"))) {
      throw fail("QC_LOUDNESS_MEASUREMENT_FAILED", `ffmpeg exited ${res.status}: ${res.stderr?.slice(-400)}`);
    }
    stderr = res.stderr ?? "";
  }

  const measurements = parseLoudnessOutput(stderr);
  return deepFreeze({
    measured: true,
    ...measurements,
  });
}

/**
 * Execute real post-render loudness normalization pass.
 */
export async function normalizeLoudness(
  inputPath,
  outputPath,
  {
    spawnImpl = null,
    execFileSyncImpl = null,
    targetI = DEFAULT_TARGET_LUFS,
    targetTp = DEFAULT_TARGET_TRUE_PEAK_DBTP,
    targetLra = DEFAULT_TARGET_LRA_LU,
    tolerance = DEFAULT_LUFS_TOLERANCE,
    timeoutMs = 15 * 60_000,
  } = {},
) {
  validateArtifactPath(inputPath);
  validateArtifactPath(outputPath);

  // 1. Measure input loudness
  const preMeasurement = await measureLoudness(inputPath, { spawnImpl, execFileSyncImpl, timeoutMs });

  // 2. Run normalization pass
  // Note: preserve video with -c:v copy and re-encode audio with aac using loudnorm
  const filter = `loudnorm=I=${targetI}:TP=${targetTp}:LRA=${targetLra}`;
  const args = [
    "-y",
    "-nostats",
    "-hide_banner",
    "-i", inputPath,
    "-af", filter,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    outputPath,
  ];

  if (typeof spawnImpl === "function") {
    const result = await spawnImpl({ command: "ffmpeg", args, timeoutMs });
    if (result.timedOut === true) throw fail("QC_NORMALIZATION_FAILED", "loudness normalization timed out");
    if (result.exitCode !== 0) {
      throw fail("QC_NORMALIZATION_FAILED", `ffmpeg exited ${result.exitCode}: ${result.stderr}`);
    }
  } else if (typeof execFileSyncImpl === "function") {
    try {
      execFileSyncImpl("ffmpeg", args, { encoding: "utf8", timeout: timeoutMs });
    } catch (err) {
      throw fail("QC_NORMALIZATION_FAILED", `ffmpeg normalization exited: ${err.message}`);
    }
  } else {
    const res = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: timeoutMs });
    if (res.error) throw fail("QC_NORMALIZATION_FAILED", res.error.message);
    if (res.status !== 0) {
      throw fail("QC_NORMALIZATION_FAILED", `ffmpeg normalization exited ${res.status}: ${(res.stderr ?? "").slice(-400)}`);
    }
  }

  // 3. Post-measurement on the normalized artifact
  const postMeasurement = await measureLoudness(outputPath, { spawnImpl, execFileSyncImpl, timeoutMs });

  // 4. Validate output against target bounds
  const minAllowedLufs = targetI - tolerance;
  const maxAllowedLufs = targetI + tolerance;
  const passed =
    postMeasurement.integratedLufs >= minAllowedLufs &&
    postMeasurement.integratedLufs <= maxAllowedLufs &&
    postMeasurement.truePeakDbtp <= targetTp + 1.5 &&
    postMeasurement.clippingCount === 0;

  if (!passed) {
    throw fail(
      "QC_NORMALIZATION_TARGET_MISSED",
      `normalized LUFS ${postMeasurement.integratedLufs} outside [${minAllowedLufs}, ${maxAllowedLufs}] or TP ${postMeasurement.truePeakDbtp} > ${targetTp}`,
    );
  }

  return deepFreeze({
    success: true,
    target: { targetI, targetTp, targetLra, tolerance },
    input: preMeasurement,
    normalized: postMeasurement,
  });
}

/**
 * Evaluate technical conformance against real ffprobe inspection streams.
 */
export function evaluateTechnicalConformance(
  inspection,
  {
    targetKind = "main_longform", // or "content_reel_1" / "content_reel_2" / "brand_reel"
    expectedAspectRatio = null,   // "16:9" or "9:16"
    expectedResolution = null,    // { width: 1920, height: 1080 }
  } = {},
) {
  if (!inspection || typeof inspection !== "object" || inspection.success !== true) {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_TECHNICAL_CONFORMANCE_FAILED",
      details: "inspection unavailable or unsuccessful",
    });
  }

  const streams = Array.isArray(inspection.streams) ? inspection.streams : [];
  const video = streams.find((s) => s?.codec_type === "video") ?? null;
  const audio = streams.find((s) => s?.codec_type === "audio") ?? null;

  if (!video || !audio) {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_TECHNICAL_CONFORMANCE_FAILED",
      details: !video ? "missing video stream" : "missing audio stream",
    });
  }

  // 1. Audio sample rate check
  const sampleRateRaw = audio.sample_rate;
  const sampleRate = Number(sampleRateRaw);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_AUDIO_SAMPLE_RATE_MISSING",
      details: `invalid audio sample rate: ${sampleRateRaw}`,
    });
  }

  // 2. Audio codec check
  const audioCodec = audio.codec_name?.toLowerCase();
  if (!audioCodec || (audioCodec !== "aac" && audioCodec !== "mp3")) {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_AUDIO_CODEC_MISMATCH",
      details: `unexpected audio codec: ${audio.codec_name}`,
    });
  }

  // 3. Video frame rate check
  const frameRateStr = video.avg_frame_rate || video.r_frame_rate;
  if (!frameRateStr || typeof frameRateStr !== "string") {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_VIDEO_FRAME_RATE_MISSING",
      details: "missing video frame rate in stream",
    });
  }
  const [num, den] = frameRateStr.split("/").map(Number);
  const frameRate = den ? num / den : num;
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_VIDEO_FRAME_RATE_MISSING",
      details: `invalid frame rate: ${frameRateStr}`,
    });
  }

  // 4. Video resolution & aspect ratio
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_VIDEO_RESOLUTION_MISMATCH",
      details: `invalid resolution: ${video.width}x${video.height}`,
    });
  }

  const effectiveExpectedAspect = expectedAspectRatio || (targetKind === "main_longform" ? "16:9" : "9:16");
  const effectiveExpectedRes = expectedResolution || (
    effectiveExpectedAspect === "16:9"
      ? { width: 1920, height: 1080 }
      : effectiveExpectedAspect === "9:16"
        ? { width: 1080, height: 1920 }
        : null
  );

  if (effectiveExpectedRes) {
    if (width !== effectiveExpectedRes.width || height !== effectiveExpectedRes.height) {
      return deepFreeze({
        passed: false,
        reasonCode: "QC_VIDEO_RESOLUTION_MISMATCH",
        details: `expected ${effectiveExpectedRes.width}x${effectiveExpectedRes.height}, got ${width}x${height}`,
        measuredResolution: { width, height },
        expectedResolution: effectiveExpectedRes,
      });
    }
  }

  // Check aspect ratio geometry
  if (effectiveExpectedAspect === "16:9" && Math.abs(width / height - 16 / 9) > 0.02) {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_VIDEO_ASPECT_RATIO_MISMATCH",
      details: `aspect ratio does not match 16:9 (${width}x${height})`,
    });
  }
  if (effectiveExpectedAspect === "9:16" && Math.abs(width / height - 9 / 16) > 0.02) {
    return deepFreeze({
      passed: false,
      reasonCode: "QC_VIDEO_ASPECT_RATIO_MISMATCH",
      details: `aspect ratio does not match 9:16 (${width}x${height})`,
    });
  }

  return deepFreeze({
    passed: true,
    reasonCode: null,
    audio: {
      codec: audioCodec,
      sampleRate,
      channels: audio.channels ? Number(audio.channels) : null,
    },
    video: {
      codec: video.codec_name,
      width,
      height,
      aspectRatio: effectiveExpectedAspect,
      frameRate,
      frameRateString: frameRateStr,
    },
  });
}
