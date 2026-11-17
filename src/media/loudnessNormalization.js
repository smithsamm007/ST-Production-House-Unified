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

/**
 * How many encode→measure→attenuate rounds a corrective delivery pass may
 * spend. Each round re-encodes the SAME normalized PCM (never a previous AAC
 * generation), so this bounds the work without stacking codec losses.
 */
export const MAX_DELIVERY_CORRECTION_ATTEMPTS = 5;

/**
 * Refuse to keep attenuating forever: past this much cumulative attenuation the
 * program is no longer the intended delivery, so the run must fail honestly
 * instead of quietly shipping a much quieter episode that happens to pass QC.
 */
export const MAX_CUMULATIVE_ATTENUATION_DB = 12;

/**
 * Build the DYNAMIC delivery filter used by the corrective pass.
 *
 * The two-pass LINEAR pass preserves program dynamics, which means it cannot
 * satisfy both delivery targets on peaky speech: run 44066920506 showed that
 * making the delivered AAC respect -2.5 dBTP by broadband gain pushed the
 * program to -21.06 LUFS against a -14 LUFS target. Dynamic normalization
 * reduces crest factor instead, so peak and loudness are reachable together.
 */
export function buildDynamicDeliveryFilter({
  targetLufs = DELIVERY_TARGET_LUFS,
  truePeakDbtp = DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
  loudnessRangeLu = 7,
} = {}) {
  if (!Number.isFinite(targetLufs) || !Number.isFinite(truePeakDbtp)) {
    throw loudnessError("LOUDNESS_TARGET_INVALID", "target loudness and true peak must be finite");
  }
  if (!Number.isFinite(loudnessRangeLu) || loudnessRangeLu <= 0) {
    throw loudnessError("LOUDNESS_TARGET_INVALID", "loudness range must be a positive finite number");
  }
  return `loudnorm=I=${targetLufs}:TP=${truePeakDbtp}:LRA=${loudnessRangeLu}`;
}

/**
 * Decide the NEXT corrective round from measurements of the delivered file.
 *
 * Measured facts driving this (run 44068972407):
 *   - ceiling -2.5 dBTP, LRA 7 → PCM -2.45 dBTP / -15.87 LUFS, delivered
 *     +2.04 dBTP / -15.91 LUFS (AAC encode raises the true peak ~4.5 dB)
 *   - ceiling -7.24 dBTP, LRA 7 → delivered -2.38 dBTP / -20.30 LUFS
 * Peak and loudness therefore cannot be reached by moving the ceiling alone:
 * buying peak headroom with broadband gain costs the same loudness. The
 * second lever is program compression (lower loudness range), which raises
 * loudness at a fixed peak.
 */
export function planCorrectiveRound({
  delivered,
  targetLufs = DELIVERY_TARGET_LUFS,
  targetTruePeakDbtp = DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
  loudnessToleranceLu = 2.0,
  ceilingDbtp = DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
  loudnessRangeLu = 7,
  minimumCeilingDbtp = -20,
} = {}) {
  if (!delivered || typeof delivered !== "object") {
    throw loudnessError("LOUDNESS_MEASUREMENT_REQUIRED", "a delivered loudness measurement is required");
  }
  const truePeakDbtp = requireFinite(delivered.truePeakDbtp, "truePeakDbtp");
  const integratedLufs = requireFinite(delivered.integratedLufs, "integratedLufs");
  const ceiling = requireFinite(ceilingDbtp, "ceilingDbtp");
  const lra = requireFinite(loudnessRangeLu, "loudnessRangeLu");

  const peakOk = truePeakDbtp <= targetTruePeakDbtp;
  const loudnessOk = Math.abs(integratedLufs - targetLufs) <= loudnessToleranceLu;
  if (peakOk && loudnessOk) {
    return Object.freeze({ converged: true, reasonCode: null, nextCeilingDbtp: ceiling, nextLoudnessRangeLu: lra });
  }

  if (!peakOk) {
    const overshootDb = truePeakDbtp - targetTruePeakDbtp;
    const nextCeilingDbtp = Math.round((ceiling - overshootDb - 0.2) * 100) / 100;
    if (nextCeilingDbtp < minimumCeilingDbtp) {
      return Object.freeze({
        converged: false,
        reasonCode: "DELIVERY_PEAK_UNREACHABLE",
        nextCeilingDbtp: minimumCeilingDbtp,
        nextLoudnessRangeLu: lra,
      });
    }
    // Peak is the binding constraint: shave it, and compress a little more so
    // the loudness lost to that shave is bought back.
    return Object.freeze({
      converged: false,
      reasonCode: null,
      nextCeilingDbtp,
      nextLoudnessRangeLu: Math.max(1, Math.round((lra - 1) * 10) / 10),
    });
  }

  // Peak already inside target but the program is too quiet: compress harder so
  // loudness rises without touching the ceiling.
  if (integratedLufs < targetLufs - loudnessToleranceLu) {
    if (lra <= 1) {
      return Object.freeze({
        converged: false,
        reasonCode: "DELIVERY_LOUDNESS_UNREACHABLE",
        nextCeilingDbtp: ceiling,
        nextLoudnessRangeLu: 1,
      });
    }
    return Object.freeze({
      converged: false,
      reasonCode: null,
      nextCeilingDbtp: ceiling,
      nextLoudnessRangeLu: Math.max(1, Math.round((lra - 2) * 10) / 10),
    });
  }

  // Too loud with an acceptable peak: lower the ceiling slightly.
  return Object.freeze({
    converged: false,
    reasonCode: null,
    nextCeilingDbtp: Math.max(minimumCeilingDbtp, Math.round((ceiling - 0.5) * 100) / 100),
    nextLoudnessRangeLu: lra,
  });
}

/**
 * Decide the attenuation for the NEXT encode round from a measurement of the
 * file that was actually encoded.
 *
 * WHY THIS EXISTS (measured, not theoretical):
 *   Run 43921087702 applied the two-pass delivery normalization, verified the
 *   intermediate WAV against the -2.5 dBTP target, then re-encoded that WAV to
 *   AAC 128k and never measured the result. The completeness gate measured the
 *   delivered file at +2.04 dBTP / -15.91 LUFS and rejected it. The pass
 *   corrected bytes, not the deliverable, so nothing in the pipeline caught
 *   the lossy encode overshoot before the gate.
 *
 * The caller measures the encoded file, passes that number here, and gets back
 * either "converged" or the cumulative gain for another round. Attenuating in
 * whole decibels of program gain is exactly how a delivery chain compensates
 * for encoder overshoot; it is not a QC relaxation, because the gate still
 * measures the delivered file against the unchanged -1.0 dBTP contract.
 */
export function planDeliveryAttenuation({
  measuredTruePeakDbtp,
  targetTruePeakDbtp = DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
  cumulativeGainDb = 0,
  maxCumulativeAttenuationDb = MAX_CUMULATIVE_ATTENUATION_DB,
  safetyMarginDb = 0.2,
} = {}) {
  const measured = requireFinite(measuredTruePeakDbtp, "measuredTruePeakDbtp");
  const target = requireFinite(targetTruePeakDbtp, "targetTruePeakDbtp");
  const cumulative = requireFinite(cumulativeGainDb, "cumulativeGainDb");
  if (!Number.isFinite(maxCumulativeAttenuationDb) || maxCumulativeAttenuationDb <= 0) {
    throw loudnessError("LOUDNESS_TARGET_INVALID", "maxCumulativeAttenuationDb must be a positive finite number");
  }
  if (!Number.isFinite(safetyMarginDb) || safetyMarginDb < 0) {
    throw loudnessError("LOUDNESS_TARGET_INVALID", "safetyMarginDb must be a non-negative finite number");
  }

  if (measured <= target) {
    return Object.freeze({ converged: true, additionalAttenuationDb: 0, cumulativeGainDb: cumulative });
  }

  const overshootDb = measured - target;
  const additionalAttenuationDb = -Math.round((overshootDb + safetyMarginDb) * 100) / 100;
  const nextCumulativeGainDb = Math.round((cumulative + additionalAttenuationDb) * 100) / 100;
  if (nextCumulativeGainDb < -Math.abs(maxCumulativeAttenuationDb)) {
    throw loudnessError(
      "LOUDNESS_ATTENUATION_EXHAUSTED",
      `encoded file measured ${measured} dBTP against a ${target} dBTP delivery target; the required ${nextCumulativeGainDb} dB cumulative attenuation exceeds the ${-Math.abs(maxCumulativeAttenuationDb)} dB budget`,
    );
  }
  return Object.freeze({
    converged: false,
    additionalAttenuationDb,
    cumulativeGainDb: nextCumulativeGainDb,
  });
}

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
