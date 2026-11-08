/**
 * ST Production House — episode completeness & technical conformance gate
 * (S-M41-01, S-M43-01, Issue #243, #263).
 *
 * Pure, deterministic, offline module. It performs NO media access, NO clock
 * reads, and NO FFmpeg execution: it evaluates the REAL post-render FFprobe
 * inspection record the assembly executor already produced and measured
 * technical loudness/stream attributes.
 *
 * WHY THIS EXISTS (measured, Issue #243, #263):
 *   The duration gates answer "is the file 30–50 minutes long?". They do not
 *   answer "is it an episode?". A still image held for 1800 s plus a 3.6 s
 *   narration measures 1800 s and passed every check on `main` — a complete,
 *   `ffprobe_verified`, QC-approved package with ~99.8 % silence. The same was
 *   reproduced with a real 30 s / 1 s render.
 *   Furthermore, claiming -14.02 LUFS, 48 kHz, or 9:16 aspect ratio without
 *   verifying the artifact's real ffprobe inspection/ebur128 measurement is
 *   unbacked by evidence.
 *
 * CONTRACT (fail-closed, AGENTS.md Rules 1–3):
 *   - Required streams: a complete program has BOTH a video and an audio
 *     stream. A missing stream is a truthful rejection, never a warning.
 *   - Measured durations: coverage is decided ONLY from per-stream durations
 *     FFprobe reported for the actual bytes. A missing measurement cannot pass
 *     by default (`QC_STREAM_DURATION_MISSING`).
 *   - Audio coverage: the audio track must cover the reference program length
 *     (the Director's configured main target when supplied, otherwise the
 *     measured video duration) within a small documented tolerance.
 *   - A/V sync: audio must not extend materially beyond the video program —
 *     a tail with sound but no picture is a broken render.
 *   - Technical conformance: resolution, aspect ratio (16:9 for main longform,
 *     9:16 for standalone brand Reel and content Shorts), sample rate (48 kHz),
 *     frame rate, and audio loudness (integrated LUFS, true peak dBTP, clipping)
 *     are verified against measured values.
 *   - Nothing here pads, extends, or silences anything: failures report the
 *     exact measured numbers so the pipeline can re-plan honestly.
 */

export const EPISODE_COMPLETENESS_VERSION = "episode_completeness_v1";

/** Stable, allowlisted failure codes (surfaced verbatim in QC evidence). */
export const COMPLETENESS_ERROR_CODES = Object.freeze([
  "QC_INSPECTION_UNAVAILABLE",
  "QC_STREAM_MISSING_VIDEO",
  "QC_STREAM_MISSING_AUDIO",
  "QC_STREAM_DURATION_MISSING",
  "QC_AUDIO_COVERAGE_INSUFFICIENT",
  "QC_AUDIO_EXTENDS_BEYOND_VIDEO",
  "QC_RESOLUTION_MISMATCH",
  "QC_SAMPLE_RATE_INVALID",
  "QC_FRAME_RATE_INVALID",
  "QC_LOUDNESS_OUT_OF_RANGE",
  "QC_AUDIO_CLIPPING_DETECTED",
]);

export const REQUIRED_STREAMS = Object.freeze(["video", "audio"]);

/** A/V tail allowance: sound may not run more than this past the picture. */
export const AUDIO_OVERRUN_TOLERANCE_SECONDS = 1;

const MAX_COVERAGE_TOLERANCE_SECONDS = 15;

/**
 * Coverage tolerance: 0.5 % of the reference program length, floored at 1 s
 * (so short Reels still get a meaningful check) and capped at 15 s (a
 * 50-minute program may end at most 15 s before its planned length).
 */
export function audioCoverageToleranceSeconds(referenceSeconds) {
  if (typeof referenceSeconds !== "number" || !Number.isFinite(referenceSeconds) || referenceSeconds <= 0) {
    return 1;
  }
  return Math.min(MAX_COVERAGE_TOLERANCE_SECONDS, Math.max(1, referenceSeconds * 0.005));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** FFprobe reports durations as strings; numbers are accepted too. */
function streamSeconds(stream) {
  const raw = stream?.duration;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

/**
 * Parse technical stream properties from an ffprobe inspection payload.
 * Pure; extracts video resolution, aspect ratio, frame rate, and audio sample rate.
 */
export function parseStreamTechnicalProperties(inspection) {
  if (!inspection || typeof inspection !== "object" || !Array.isArray(inspection.streams)) {
    return null;
  }
  const videoStream = inspection.streams.find((s) => s?.codec_type === "video") ?? null;
  const audioStream = inspection.streams.find((s) => s?.codec_type === "audio") ?? null;

  let video = null;
  if (videoStream) {
    const width = typeof videoStream.width === "number" ? videoStream.width : (Number.isFinite(Number(videoStream.width)) ? Number(videoStream.width) : null);
    const height = typeof videoStream.height === "number" ? videoStream.height : (Number.isFinite(Number(videoStream.height)) ? Number(videoStream.height) : null);
    let frameRate = null;
    const rawRate = videoStream.avg_frame_rate || videoStream.r_frame_rate;
    if (typeof rawRate === "string" && rawRate.includes("/")) {
      const [num, den] = rawRate.split("/").map(Number);
      if (Number.isFinite(num) && Number.isFinite(den) && den > 0) frameRate = num / den;
    } else if (Number.isFinite(Number(rawRate))) {
      frameRate = Number(rawRate);
    }
    let aspectRatio = null;
    if (width && height) {
      const ratio = width / height;
      if (Math.abs(ratio - 16 / 9) < 0.02) aspectRatio = "16:9";
      else if (Math.abs(ratio - 9 / 16) < 0.02) aspectRatio = "9:16";
      else if (Math.abs(ratio - 1) < 0.02) aspectRatio = "1:1";
      else if (Math.abs(ratio - 4 / 5) < 0.02) aspectRatio = "4:5";
      else aspectRatio = `${width}:${height}`;
    }
    video = {
      codec: videoStream.codec_name ?? null,
      width,
      height,
      aspectRatio,
      frameRate,
    };
  }

  let audio = null;
  if (audioStream) {
    const sampleRate = typeof audioStream.sample_rate === "number" ? audioStream.sample_rate : (Number.isFinite(Number(audioStream.sample_rate)) ? Number(audioStream.sample_rate) : null);
    const channels = typeof audioStream.channels === "number" ? audioStream.channels : (Number.isFinite(Number(audioStream.channels)) ? Number(audioStream.channels) : null);
    audio = {
      codec: audioStream.codec_name ?? null,
      sampleRate,
      channels,
    };
  }

  return deepFreeze({ video, audio });
}

function baseVerdict() {
  return {
    completenessVersion: EPISODE_COMPLETENESS_VERSION,
    passed: false,
    reasonCode: null,
    requiredStreams: REQUIRED_STREAMS,
    videoSeconds: null,
    audioSeconds: null,
    referenceSeconds: null,
    coverageToleranceSeconds: null,
    audioCoverageRatio: null,
    technical: null,
  };
}

/**
 * Evaluate whether one assembled artifact is a COMPLETE program conforming
 * to all technical specifications.
 *
 *   inspection           — the real `inspectMediaFile()` record (success + streams)
 *   targetSeconds        — optional configured main-video target (Director schedule
 *                          / job payload); ignored for short-form renders, where the
 *                          measured video duration is the reference.
 *   expectedWidth        — optional expected video width (e.g. 1920 or 1080)
 *   expectedHeight       — optional expected video height (e.g. 1080 or 1920)
 *   expectedAspectRatio  — optional expected aspect ratio ("16:9", "9:16", "1:1")
 *   requiredSampleRate   — optional required audio sample rate (e.g. 48000)
 *   minFrameRate         — optional minimum acceptable video frame rate
 *   loudness             — optional measured loudness { integratedLufs, truePeakDbtp, clippingCount }
 *   targetLufs           — optional target integrated LUFS (e.g. -14.0)
 *   maxTruePeakDbtp      — optional maximum true peak dBTP (e.g. -1.0)
 *
 * Returns a frozen verdict:
 *   { completenessVersion, passed, reasonCode, requiredStreams,
 *     videoSeconds, audioSeconds, referenceSeconds,
 *     coverageToleranceSeconds, audioCoverageRatio, technical }
 */
export function evaluateEpisodeCompleteness({
  inspection,
  targetSeconds = null,
  expectedWidth = null,
  expectedHeight = null,
  expectedAspectRatio = null,
  requiredSampleRate = null,
  minFrameRate = null,
  loudness = null,
  targetLufs = null,
  maxTruePeakDbtp = null,
} = {}) {
  const verdict = baseVerdict();

  if (inspection === null || typeof inspection !== "object" || inspection.success !== true) {
    return deepFreeze({ ...verdict, reasonCode: "QC_INSPECTION_UNAVAILABLE" });
  }
  const streams = Array.isArray(inspection.streams) ? inspection.streams : [];
  if (streams.length === 0) {
    return deepFreeze({ ...verdict, reasonCode: "QC_INSPECTION_UNAVAILABLE" });
  }

  const video = streams.find((stream) => stream?.codec_type === "video") ?? null;
  const audio = streams.find((stream) => stream?.codec_type === "audio") ?? null;
  if (video === null) {
    return deepFreeze({ ...verdict, reasonCode: "QC_STREAM_MISSING_VIDEO" });
  }
  if (audio === null) {
    return deepFreeze({ ...verdict, reasonCode: "QC_STREAM_MISSING_AUDIO" });
  }

  const videoSeconds = streamSeconds(video);
  const audioSeconds = streamSeconds(audio);
  if (videoSeconds === null || videoSeconds <= 0 || audioSeconds === null || audioSeconds < 0) {
    return deepFreeze({
      ...verdict,
      videoSeconds,
      audioSeconds,
      reasonCode: "QC_STREAM_DURATION_MISSING",
    });
  }

  const technical = parseStreamTechnicalProperties(inspection);

  // The reference program length: the configured main target when one exists,
  // otherwise the measured video duration. A configured target is what the
  // Director asked for, so falling 30 s short of it is not "complete".
  const referenceSeconds =
    typeof targetSeconds === "number" && Number.isFinite(targetSeconds) && targetSeconds > 0
      ? targetSeconds
      : videoSeconds;
  const coverageToleranceSeconds = audioCoverageToleranceSeconds(referenceSeconds);
  const audioCoverageRatio = audioSeconds / referenceSeconds;

  const measured = {
    ...verdict,
    videoSeconds,
    audioSeconds,
    referenceSeconds,
    coverageToleranceSeconds,
    audioCoverageRatio,
    technical: technical ? { ...technical, loudness: loudness ?? null } : null,
  };

  if (audioSeconds + coverageToleranceSeconds < referenceSeconds) {
    return deepFreeze({ ...measured, reasonCode: "QC_AUDIO_COVERAGE_INSUFFICIENT" });
  }
  if (audioSeconds > videoSeconds + AUDIO_OVERRUN_TOLERANCE_SECONDS) {
    return deepFreeze({ ...measured, reasonCode: "QC_AUDIO_EXTENDS_BEYOND_VIDEO" });
  }

  // Technical conformance checks:
  if (expectedWidth !== null) {
    if (!technical?.video?.width || technical.video.width !== expectedWidth) {
      return deepFreeze({ ...measured, reasonCode: "QC_RESOLUTION_MISMATCH" });
    }
  }
  if (expectedHeight !== null) {
    if (!technical?.video?.height || technical.video.height !== expectedHeight) {
      return deepFreeze({ ...measured, reasonCode: "QC_RESOLUTION_MISMATCH" });
    }
  }
  if (expectedAspectRatio !== null) {
    if (!technical?.video?.aspectRatio || technical.video.aspectRatio !== expectedAspectRatio) {
      return deepFreeze({ ...measured, reasonCode: "QC_RESOLUTION_MISMATCH" });
    }
  }
  if (requiredSampleRate !== null) {
    if (!technical?.audio?.sampleRate || technical.audio.sampleRate !== requiredSampleRate) {
      return deepFreeze({ ...measured, reasonCode: "QC_SAMPLE_RATE_INVALID" });
    }
  }
  if (minFrameRate !== null) {
    if (!technical?.video?.frameRate || technical.video.frameRate < minFrameRate) {
      return deepFreeze({ ...measured, reasonCode: "QC_FRAME_RATE_INVALID" });
    }
  }
  if (loudness !== null && typeof loudness === "object") {
    if (loudness.clippingCount > 0 || (typeof loudness.truePeakDbtp === "number" && loudness.truePeakDbtp > 0.0)) {
      return deepFreeze({ ...measured, reasonCode: "QC_AUDIO_CLIPPING_DETECTED" });
    }
    if (maxTruePeakDbtp !== null && typeof loudness.truePeakDbtp === "number" && loudness.truePeakDbtp > maxTruePeakDbtp + 0.1) {
      return deepFreeze({ ...measured, reasonCode: "QC_LOUDNESS_OUT_OF_RANGE" });
    }
    if (targetLufs !== null && typeof loudness.integratedLufs === "number") {
      const toleranceLufs = 2.0;
      if (loudness.integratedLufs < targetLufs - toleranceLufs || loudness.integratedLufs > targetLufs + toleranceLufs) {
        return deepFreeze({ ...measured, reasonCode: "QC_LOUDNESS_OUT_OF_RANGE" });
      }
    }
  }

  return deepFreeze({ ...measured, passed: true, reasonCode: null });
}
