/**
 * Loudness delivery helpers for real rendered audio (Issue #264 follow-up).
 *
 * WHY THIS EXISTS (measured, not theoretical):
 *   Run 43301281602 rendered a real 1800 s episode and the completeness gate
 *   rejected it with `QC_AUDIO_CLIPPING_DETECTED`:
 *
 *     integratedLufs -15.47, truePeakDbtp 0.14, clippingCount 1
 *
 *   The delivered MP4 audio was normalized speech re-encoded to AAC 128k. Two
 *   separate defects produced that measurement:
 *
 *   1. The pass was SINGLE-PASS `loudnorm` (dynamic mode). Single-pass dynamic
 *      normalization misses its own targets — the file landed at -15.47 LUFS
 *      against a -14.0 target — and it only bounds the peak of the signal it
 *      processed, not of the lossy re-encode that follows.
 *   2. The delivery peak target was the same value as the QC limit (-1.0 dBTP),
 *      leaving ZERO headroom for AAC intersample overshoot, so the encoded
 *      file measured +0.14 dBTP.
 *
 *   The fix is a two-pass LINEAR pass that measures first, and a delivery peak
 *   target with real headroom below the published QC contract. The QC contract
 *   itself is NOT relaxed: `QC_MAX_TRUE_PEAK_DBTP` stays at -1.0 dBTP and the
 *   gate keeps rejecting anything above it.
 *
 * NOTE on `loudnorm`'s JSON: `input_i` / `input_tp` describe the FILE being
 * measured, while `output_i` / `output_tp` describe loudnorm's own internal
 * normalization to its default -24 LUFS target. Only the `input_*` values are
 * a property of the delivered file, which is why a delivered file measuring
 * `input_tp = 0.14` alongside `output_tp = -8.39` is genuinely clipped.
 */

export const DELIVERY_TARGET_LUFS = -14.0;

/**
 * The published QC contract: a delivered file must not exceed this true peak.
 * This is the value the completeness gate enforces and it must not be relaxed
 * to make a render pass.
 */
export const QC_MAX_TRUE_PEAK_DBTP = -1.0;

/**
 * The peak the delivery pass aims for, leaving headroom for lossy (AAC) encode
 * overshoot so the encoded deliverable stays inside the QC contract.
 */
export const DELIVERY_TRUE_PEAK_HEADROOM_DBTP = -2.5;

function loudnessError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireFinite(value, field) {
  if (!Number.isFinite(value)) {
    throw loudnessError(
      "LOUDNESS_MEASUREMENT_INVALID",
      `loudnorm measurement field ${field} is not finite`,
    );
  }
  return value;
}

/**
 * Build the second (applying) pass of a two-pass `loudnorm` filter from the
 * first (measuring) pass. Linear mode is requested so the pass preserves
 * program dynamics instead of riding the gain.
 */
export function buildMeasuredNormalizationFilter({
  targetLufs = DELIVERY_TARGET_LUFS,
  maxTruePeak = DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
  measured,
} = {}) {
  if (!measured || typeof measured !== "object") {
    throw loudnessError("LOUDNESS_MEASUREMENT_REQUIRED", "a measured loudness object is required for the applying pass");
  }
  if (!Number.isFinite(targetLufs) || !Number.isFinite(maxTruePeak)) {
    throw loudnessError("LOUDNESS_TARGET_INVALID", "target loudness and true peak must be finite");
  }

  const integratedLufs = requireFinite(measured.integratedLufs, "integratedLufs");
  const truePeakDbtp = requireFinite(measured.truePeakDbtp, "truePeakDbtp");
  const thresholdLufs = requireFinite(measured.thresholdLufs, "thresholdLufs");

  const parts = [
    `loudnorm=I=${targetLufs}:TP=${maxTruePeak}:LRA=7`,
    `measured_I=${integratedLufs}`,
    `measured_TP=${truePeakDbtp}`,
    Number.isFinite(measured.loudnessRangeLu) ? `measured_LRA=${measured.loudnessRangeLu}` : null,
    `measured_thresh=${thresholdLufs}`,
    "offset=0",
    "linear=true",
  ];
  return parts.filter((part) => part !== null).join(":");
}

/**
 * Whether a delivered (already encoded) file still breaches the QC true-peak
 * contract and therefore needs one corrective re-normalization pass.
 */
export function requiresCorrectiveNormalization(
  loudness,
  maxTruePeakDbtp = QC_MAX_TRUE_PEAK_DBTP,
) {
  if (!loudness || typeof loudness !== "object") {
    throw loudnessError("LOUDNESS_MEASUREMENT_REQUIRED", "a measured loudness object is required");
  }
  const truePeakDbtp = requireFinite(loudness.truePeakDbtp, "truePeakDbtp");
  return truePeakDbtp > maxTruePeakDbtp;
}

/**
 * The loudness object the completeness gate is allowed to see: the measurement
 * of the DELIVERED file. The intermediate measurements (raw synthesis and the
 * normalized WAV) are evidence, never gate input — a gate fed either of those
 * would report a pass for bytes that were never delivered.
 */
export function selectGateLoudness({ assembled, rawSpeech, normalizedSpeech } = {}) {
  void rawSpeech;
  void normalizedSpeech;
  if (
    !assembled ||
    typeof assembled !== "object" ||
    !Number.isFinite(assembled.integratedLufs) ||
    !Number.isFinite(assembled.truePeakDbtp)
  ) {
    throw loudnessError(
      "REHEARSAL_DELIVERED_LOUDNESS_REQUIRED",
      "the completeness gate must receive the measurement of the delivered file, not a pre-normalization measurement",
    );
  }
  return assembled;
}
