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
 * Bounded post-encode corrective pass cap and minimum clamped headroom ceiling.
 * Prevents unbounded remux loops while compensating for rare AAC transient
 * overshoot beyond DELIVERY_TRUE_PEAK_HEADROOM_DBTP.
 */
export const MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS = 3;
export const MIN_CORRECTIVE_HEADROOM_DBTP = -5.5;
export const CORRECTIVE_HEADROOM_STEP_DB = 1.0;

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
 * contract and therefore needs corrective re-normalization.
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
 * Compute the bounded true-peak target for corrective attempt `attempt` (1-based).
 * Attempt 1 uses `baseHeadroomDbtp` (-2.5 dBTP); subsequent attempts step down
 * by 1.0 dB (clamped to MIN_CORRECTIVE_HEADROOM_DBTP) if AAC encoding still
 * overshoots the QC contract.
 */
export function planCorrectiveHeadroomTarget({
  attempt = 1,
  baseHeadroomDbtp = DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
} = {}) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS) {
    throw loudnessError(
      "LOUDNESS_TARGET_INVALID",
      `corrective attempt must be an integer between 1 and ${MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS}`,
    );
  }
  if (!Number.isFinite(baseHeadroomDbtp)) {
    throw loudnessError("LOUDNESS_TARGET_INVALID", "base headroom target must be finite");
  }
  const stepped = baseHeadroomDbtp - (attempt - 1) * CORRECTIVE_HEADROOM_STEP_DB;
  return Math.max(MIN_CORRECTIVE_HEADROOM_DBTP, Number(stepped.toFixed(2)));
}

/**
 * Finalize a rendered media file by enforcing post-encode AAC true-peak
 * compliance BEFORE capturing the authoritative final inspection and SHA-256.
 *
 * Guarantees the same final-file identity flows through corrective operations,
 * FFprobe re-inspection, audio/video QC, and evidence manifest generation:
 * any corrective remux invalidates prior inspection state and forces a fresh
 * FFprobe + loudness + hash measurement on the remuxed file. Fails closed with
 * `REHEARSAL_CORRECTIVE_LIMIT_EXCEEDED` if the file still exceeds the QC
 * true-peak contract after `maxAttempts` bounded passes.
 */
export function verifyAndCorrectDeliveredAudio({
  filePath,
  targetLufs = DELIVERY_TARGET_LUFS,
  maxTruePeakDbtp = QC_MAX_TRUE_PEAK_DBTP,
  baseHeadroomDbtp = DELIVERY_TRUE_PEAK_HEADROOM_DBTP,
  maxAttempts = MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS,
  probeFile,
  measureLoudness,
  applyCorrection,
  hashFile = null,
  onCorrectionAttempt = null,
} = {}) {
  if (typeof probeFile !== "function" || typeof measureLoudness !== "function") {
    throw loudnessError("LOUDNESS_MEASUREMENT_REQUIRED", "probeFile and measureLoudness functions are required");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS) {
    throw loudnessError(
      "LOUDNESS_TARGET_INVALID",
      `maxAttempts must be between 1 and ${MAX_CORRECTIVE_NORMALIZATION_ATTEMPTS}`,
    );
  }

  let inspection = probeFile(filePath);
  let loudness = measureLoudness(filePath);
  let outputSha256 = typeof hashFile === "function" ? hashFile(filePath) : (inspection?.contentSha256 ?? null);
  const correctivePasses = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!requiresCorrectiveNormalization(loudness, maxTruePeakDbtp)) {
      break;
    }
    if (typeof applyCorrection !== "function") {
      throw loudnessError(
        "REHEARSAL_CORRECTIVE_LIMIT_EXCEEDED",
        `Delivered file ${filePath} measured ${loudness.truePeakDbtp} dBTP > ${maxTruePeakDbtp} dBTP and no corrective handler is configured`,
      );
    }
    const headroomDbtp = planCorrectiveHeadroomTarget({ attempt, baseHeadroomDbtp });
    if (typeof onCorrectionAttempt === "function") {
      onCorrectionAttempt({
        attempt,
        maxAttempts,
        measuredTruePeakDbtp: loudness.truePeakDbtp,
        qcMaxTruePeakDbtp: maxTruePeakDbtp,
        deliveryTargetDbtp: headroomDbtp,
      });
    }
    const passInfo = applyCorrection({
      videoPath: filePath,
      targetLufs,
      maxTruePeak: headroomDbtp,
      attempt,
      previousLoudness: loudness,
    });
    // Mandatory post-remux re-probe of the exact delivered file identity.
    inspection = probeFile(filePath);
    loudness = measureLoudness(filePath);
    outputSha256 = typeof hashFile === "function" ? hashFile(filePath) : (inspection?.contentSha256 ?? null);
    correctivePasses.push({
      attempt,
      headroomDbtp,
      postRemuxTruePeakDbtp: loudness.truePeakDbtp,
      postRemuxIntegratedLufs: loudness.integratedLufs,
      outputSha256,
      passInfo: passInfo ?? null,
    });
  }

  if (requiresCorrectiveNormalization(loudness, maxTruePeakDbtp)) {
    throw loudnessError(
      "REHEARSAL_CORRECTIVE_LIMIT_EXCEEDED",
      `Delivered file ${filePath} still exceeds QC true peak (${loudness.truePeakDbtp} dBTP > ${maxTruePeakDbtp} dBTP) after ${correctivePasses.length} bounded corrective passes`,
    );
  }

  return Object.freeze({
    filePath,
    inspection,
    loudness,
    outputSha256,
    correctivePassApplied: correctivePasses.length > 0,
    correctivePasses: Object.freeze(correctivePasses),
  });
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
