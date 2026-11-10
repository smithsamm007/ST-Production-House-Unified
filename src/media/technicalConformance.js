/**
 * ST Production House — measured technical conformance (S-M43-01, Issue #263).
 *
 * WHY THIS EXISTS:
 *   S-M41-01 (episodeCompleteness) answers "is this a complete episode?":
 *   required streams plus measured audio coverage. It does NOT answer "was
 *   this encoded to the house profile?". Before this module nothing checked
 *   resolution, frame rate, sample rate or codec identity from the artifact's
 *   own FFprobe record, so those were claims rather than measurements.
 *
 * CONTRACT (AGENTS.md Rules 1–3):
 *   - Pure and offline: it evaluates the REAL post-render FFprobe inspection
 *     and performs no media access, no clock read and no process spawn.
 *   - Every asserted value is MEASURED. A missing measurement fails closed
 *     with a stable code; nothing is defaulted to "probably fine".
 *   - Profiles are explicit. `long_form_1080p` and `vertical_9_16` are the
 *     delivery profiles; the rehearsal's placeholder profile declares its own
 *     lower frame rate so a 2 fps colour plate can never masquerade as the
 *     finished delivery profile.
 */

export const TECHNICAL_CONFORMANCE_VERSION = "technical_conformance_v1";

export const TECHNICAL_CONFORMANCE_CODES = Object.freeze([
  "TECH_INSPECTION_UNAVAILABLE",
  "TECH_STREAM_MISSING_VIDEO",
  "TECH_STREAM_MISSING_AUDIO",
  "TECH_RESOLUTION_MISMATCH",
  "TECH_FRAME_RATE_UNMEASURABLE",
  "TECH_FRAME_RATE_BELOW_MINIMUM",
  "TECH_SAMPLE_RATE_MISMATCH",
  "TECH_CODEC_UNMEASURABLE",
]);

/** Delivery + rehearsal profiles. Resolution and audio rate are asserted. */
export const TECHNICAL_PROFILES = Object.freeze({
  long_form_1080p: Object.freeze({
    label: "long_form_1080p",
    width: 1920,
    height: 1080,
    minFrameRate: 24,
    sampleRate: 48000,
    delivery: true,
  }),
  vertical_9_16: Object.freeze({
    label: "vertical_9_16",
    width: 1080,
    height: 1920,
    minFrameRate: 24,
    sampleRate: 48000,
    delivery: true,
  }),
  /**
   * The rehearsal's flat-colour placeholder plate at a low frame rate. It is
   * a REAL measured profile, but explicitly NOT a delivery profile: evidence
   * produced under it must say so (Rule 3).
   */
  placeholder_rehearsal: Object.freeze({
    label: "placeholder_rehearsal",
    width: 1920,
    height: 1080,
    minFrameRate: 1,
    sampleRate: 48000,
    delivery: false,
  }),
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** "30000/1001" → 29.97; "2/1" → 2; invalid/zero denominators → null. */
export function parseFrameRate(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const [numeratorRaw, denominatorRaw] = raw.split("/");
  const numerator = Number(numeratorRaw);
  const denominator = denominatorRaw === undefined ? 1 : Number(denominatorRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return null;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null;
}

function streamOf(streams, codecType) {
  return streams.find((stream) => stream?.codec_type === codecType) ?? null;
}

/**
 * Evaluate one artifact's measured technical profile.
 *
 *   inspection — real `inspectMediaFile()` record (success + streams)
 *   profile    — one of TECHNICAL_PROFILES (or an explicitly shaped object)
 *
 * Returns a frozen verdict:
 *   { conformanceVersion, profile, passed, reasonCodes, measured }
 */
export function evaluateTechnicalConformance({ inspection, profile } = {}) {
  const measured = {
    width: null,
    height: null,
    frameRate: null,
    sampleRate: null,
    videoCodec: null,
    audioCodec: null,
    codecLongNameRecorded: false,
  };
  const reasonCodes = [];

  if (profile === null || typeof profile !== "object") {
    throw new Error("TECH_PROFILE_INVALID");
  }
  if (inspection === null || typeof inspection !== "object" || inspection.success !== true) {
    return deepFreeze({
      conformanceVersion: TECHNICAL_CONFORMANCE_VERSION,
      profile: profile.label ?? "custom",
      delivery: profile.delivery !== false,
      passed: false,
      reasonCodes: ["TECH_INSPECTION_UNAVAILABLE"],
      measured,
    });
  }

  const streams = Array.isArray(inspection.streams) ? inspection.streams : [];
  const video = streamOf(streams, "video");
  const audio = streamOf(streams, "audio");
  if (video === null) reasonCodes.push("TECH_STREAM_MISSING_VIDEO");
  if (audio === null) reasonCodes.push("TECH_STREAM_MISSING_AUDIO");

  if (video !== null) {
    measured.width = Number.isInteger(video.width) ? video.width : Number(video.width) || null;
    measured.height = Number.isInteger(video.height) ? video.height : Number(video.height) || null;
    measured.frameRate = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
    measured.videoCodec = typeof video.codec_name === "string" && video.codec_name.length > 0 ? video.codec_name : null;
    measured.codecLongNameRecorded = typeof video.codec_long_name === "string" && video.codec_long_name.length > 0;

    if (measured.width === null || measured.height === null) {
      reasonCodes.push("TECH_RESOLUTION_MISMATCH");
    } else if (measured.width !== profile.width || measured.height !== profile.height) {
      reasonCodes.push("TECH_RESOLUTION_MISMATCH");
    }
    if (measured.frameRate === null) {
      reasonCodes.push("TECH_FRAME_RATE_UNMEASURABLE");
    } else if (!(measured.frameRate >= profile.minFrameRate)) {
      reasonCodes.push("TECH_FRAME_RATE_BELOW_MINIMUM");
    }
    if (measured.videoCodec === null) reasonCodes.push("TECH_CODEC_UNMEASURABLE");
  }

  if (audio !== null) {
    measured.sampleRate = Number.isInteger(audio.sample_rate) ? audio.sample_rate : Number(audio.sample_rate) || null;
    measured.audioCodec = typeof audio.codec_name === "string" && audio.codec_name.length > 0 ? audio.codec_name : null;
    if (measured.sampleRate === null || measured.sampleRate !== profile.sampleRate) {
      reasonCodes.push("TECH_SAMPLE_RATE_MISMATCH");
    }
    if (measured.audioCodec === null) reasonCodes.push("TECH_CODEC_UNMEASURABLE");
  }

  const unique = [...new Set(reasonCodes)];
  return deepFreeze({
    conformanceVersion: TECHNICAL_CONFORMANCE_VERSION,
    profile: profile.label ?? "custom",
    delivery: profile.delivery !== false,
    passed: unique.length === 0,
    reasonCodes: unique,
    measured,
  });
}
