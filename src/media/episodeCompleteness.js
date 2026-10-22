/**
 * ST Production House — episode completeness gate (S-M41-01, Issue #243).
 *
 * Pure, deterministic, offline module. It performs NO media access, NO clock
 * reads, and NO FFmpeg execution: it evaluates the REAL post-render FFprobe
 * inspection record the assembly executor already produced.
 *
 * WHY THIS EXISTS (measured, Issue #243):
 *   The duration gates answer "is the file 30–50 minutes long?". They do not
 *   answer "is it an episode?". A still image held for 1800 s plus a 3.6 s
 *   narration measures 1800 s and passed every check on `main` — a complete,
 *   `ffprobe_verified`, QC-approved package with ~99.8 % silence. The same was
 *   reproduced with a real 30 s / 1 s render.
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
 *   - Nothing here pads, extends, or silences anything: a short narration is
 *     reported as short, with the measured numbers, so the pipeline can
 *     re-plan and the owner can see exactly what is missing.
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
  };
}

/**
 * Evaluate whether one assembled artifact is a COMPLETE program.
 *
 *   inspection     — the real `inspectMediaFile()` record (success + streams)
 *   targetSeconds  — optional configured main-video target (Director schedule
 *                    / job payload); ignored for short-form renders, where the
 *                    measured video duration is the reference.
 *
 * Returns a frozen verdict:
 *   { completenessVersion, passed, reasonCode, requiredStreams,
 *     videoSeconds, audioSeconds, referenceSeconds,
 *     coverageToleranceSeconds, audioCoverageRatio }
 *
 * `passed: true` is the ONLY success shape; every rejection carries one of
 * COMPLETENESS_ERROR_CODES plus whatever measurements were real.
 */
export function evaluateEpisodeCompleteness({ inspection, targetSeconds = null } = {}) {
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
  };

  if (audioSeconds + coverageToleranceSeconds < referenceSeconds) {
    return deepFreeze({ ...measured, reasonCode: "QC_AUDIO_COVERAGE_INSUFFICIENT" });
  }
  if (audioSeconds > videoSeconds + AUDIO_OVERRUN_TOLERANCE_SECONDS) {
    return deepFreeze({ ...measured, reasonCode: "QC_AUDIO_EXTENDS_BEYOND_VIDEO" });
  }

  return deepFreeze({ ...measured, passed: true, reasonCode: null });
}
