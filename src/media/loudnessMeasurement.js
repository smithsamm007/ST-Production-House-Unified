/**
 * ST Production House — measured loudness & clipping (S-M43-01, Issue #263).
 *
 * WHY THIS EXISTS:
 *   The rehearsal rendered H.264/AAC but never applied `loudnorm` and never
 *   measured loudness, so any claim of "-14 LUFS / -1 dBTP" was NOT
 *   evidence-backed by this repository. This module is the measurement (and
 *   normalization) contract:
 *
 *     ffmpeg -af ebur128=peak=true  → integrated LUFS, LRA, true peak dBTP
 *     ffmpeg -af astats             → peak level dBFS + peak sample count
 *     two-pass loudnorm             → a real normalized output
 *
 * HONESTY CONTRACT (AGENTS.md Rules 1–3):
 *   - Every number returned here was parsed out of real FFmpeg stderr for the
 *     named file. There are no defaults and no constants standing in for a
 *     measurement: an unparseable summary is a truthful failure
 *     (`LOUDNESS_UNMEASURABLE`), never a pass.
 *   - `clippedSampleCount` is the count of samples at the measured peak level
 *     when that peak reaches full scale (0 dBFS); otherwise it is 0. It is
 *     reported with `clippingBasis` so nobody can mistake it for a different
 *     measurement.
 *   - `-inf` (digital silence) is reported as `null` + a reason code rather
 *     than being mapped to a convenient finite value.
 *   - Spawning is injected (`spawnImpl`) and array-args only; this module
 *     never builds a shell string (CONVENTIONS Rule 2).
 */

export const LOUDNESS_MEASUREMENT_VERSION = "loudness_measurement_v1";

/** House technical target for delivered audio (documented in docs/media). */
export const HOUSE_LOUDNESS_TARGET = Object.freeze({
  integratedLufs: -14,
  truePeakDbtp: -1,
  loudnessRangeLu: 11,
  /** Allowed deviation from the integrated target, in LU. */
  integratedToleranceLu: 1,
});

export const LOUDNESS_ERROR_CODES = Object.freeze([
  "LOUDNESS_FILE_INVALID",
  "LOUDNESS_SPAWN_INVALID",
  "LOUDNESS_SPAWN_FAILED",
  "LOUDNESS_TIMEOUT",
  "LOUDNESS_ANALYSIS_FAILED",
  "LOUDNESS_UNMEASURABLE",
  "LOUDNESS_NORMALIZATION_INVALID",
]);

export const LOUDNESS_CONFORMANCE_CODES = Object.freeze([
  "LOUDNESS_UNMEASURABLE",
  "LOUDNESS_INTEGRATED_OUT_OF_RANGE",
  "LOUDNESS_TRUE_PEAK_EXCEEDED",
  "LOUDNESS_CLIPPING_DETECTED",
]);

const NUMBER = "-?\\d+(?:\\.\\d+)?";

function loudnessError(code) {
  const error = new Error(code);
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

function lastMatch(text, pattern) {
  const matches = [...String(text).matchAll(new RegExp(pattern, "g"))];
  return matches.length === 0 ? null : matches[matches.length - 1][1];
}

function firstMatch(text, pattern) {
  const match = new RegExp(pattern).exec(String(text));
  return match === null ? null : match[1];
}

function toFinite(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** True when the record contains a real, finite integrated measurement. */
export function isMeasuredLoudness(measurement) {
  return (
    measurement !== null &&
    typeof measurement === "object" &&
    measurement.success === true &&
    Number.isFinite(measurement.integratedLufs) &&
    Number.isFinite(measurement.truePeakDbtp)
  );
}

// ---------------------------------------------------------------------------
// Argument construction (array args only)
// ---------------------------------------------------------------------------

/** ebur128 analysis pass over the artifact's first audio stream. */
export function buildLoudnessAnalysisArgs(file) {
  if (typeof file !== "string" || file.length === 0 || file.length > 4096 || file.includes("\0") || file.startsWith("-")) {
    throw loudnessError("LOUDNESS_FILE_INVALID");
  }
  return Object.freeze([
    "-hide_banner",
    "-nostats",
    "-i", file,
    "-map", "0:a:0",
    "-af", "ebur128=peak=true",
    "-f", "null",
    "-",
  ]);
}

/** astats analysis pass: peak level + peak sample count (clipping basis). */
export function buildClippingAnalysisArgs(file) {
  if (typeof file !== "string" || file.length === 0 || file.length > 4096 || file.includes("\0") || file.startsWith("-")) {
    throw loudnessError("LOUDNESS_FILE_INVALID");
  }
  return Object.freeze([
    "-hide_banner",
    "-nostats",
    "-i", file,
    "-map", "0:a:0",
    "-af", "astats=metadata=0:reset=0",
    "-f", "null",
    "-",
  ]);
}

/**
 * Two-pass loudnorm filter using the MEASURED input values. A missing
 * measurement is refused: guessing a loudnorm input is exactly the invention
 * this issue forbids.
 */
export function buildNormalizationFilter(measurement, target = HOUSE_LOUDNESS_TARGET) {
  if (!isMeasuredLoudness(measurement)) throw loudnessError("LOUDNESS_NORMALIZATION_INVALID");
  if (!Number.isFinite(measurement.thresholdLufs)) throw loudnessError("LOUDNESS_NORMALIZATION_INVALID");
  const round = (value) => Math.round(value * 100) / 100;
  return [
    `loudnorm=I=${target.integratedLufs}`,
    `TP=${target.truePeakDbtp}`,
    `LRA=${target.loudnessRangeLu}`,
    `measured_I=${round(measurement.integratedLufs)}`,
    `measured_TP=${round(measurement.truePeakDbtp)}`,
    `measured_LRA=${round(measurement.loudnessRangeLu ?? target.loudnessRangeLu)}`,
    `measured_thresh=${round(measurement.thresholdLufs)}`,
    "offset=0",
    "linear=true",
    "print_format=summary",
  ].join(":");
}

/**
 * Remux + normalize: video is copied untouched; only the audio is re-encoded
 * to AAC 48 kHz. The report is printed to stderr by loudnorm itself.
 */
export function buildNormalizationArgs({ inputPath, outputPath, measurement, target = HOUSE_LOUDNESS_TARGET } = {}) {
  if (typeof outputPath !== "string" || outputPath.length === 0 || outputPath.includes("\0") || outputPath.startsWith("-")) {
    throw loudnessError("LOUDNESS_FILE_INVALID");
  }
  return Object.freeze([
    "-y",
    "-hide_banner",
    "-nostats",
    "-i", inputPath,
    "-map", "0:v?",
    "-map", "0:a:0",
    "-c:v", "copy",
    "-af", buildNormalizationFilter(measurement, target),
    "-c:a", "aac",
    "-ar", "48000",
    "-b:a", "192k",
    outputPath,
  ]);
}

// ---------------------------------------------------------------------------
// Parsing (pure; fixtures in the test suite mirror real FFmpeg output)
// ---------------------------------------------------------------------------

/**
 * Parse the LAST ebur128 summary block in FFmpeg stderr.
 *
 * Returns `{ integratedLufs, loudnessRangeLu, truePeakDbtp, thresholdLufs }`
 * with `null` for values the writer did not report (e.g. `-inf` silence), or
 * `null` when no summary exists at all.
 */
export function parseEbur128Summary(stderr) {
  const text = typeof stderr === "string" ? stderr : "";
  const summaryIndex = text.lastIndexOf("Summary:");
  const block = summaryIndex === -1 ? null : text.slice(summaryIndex);
  if (block === null) return null;

  const integratedLufs = toFinite(lastMatch(block, `I:\\s*(${NUMBER})\\s*LUFS`));
  const truePeakDbtp = toFinite(lastMatch(block, `Peak:\\s*(${NUMBER})\\s*dBFS`));
  const loudnessRangeLu = toFinite(lastMatch(block, `LRA:\\s*(${NUMBER})\\s*LU`));
  // The INTEGRATED gating threshold is the first "Threshold:" after the
  // integrated value; the loudness-range section reports its own threshold
  // later in the same block and must not overwrite it (loudnorm pass 2 needs
  // the integrated one).
  const rangeIndex = block.indexOf("Loudness range:");
  const integratedSection = rangeIndex > 0 ? block.slice(0, rangeIndex) : block;
  const thresholdLufs = toFinite(
    firstMatch(integratedSection, `Threshold:\\s*(${NUMBER})\\s*LUFS`) ??
      firstMatch(block, `Threshold:\\s*(${NUMBER})\\s*LUFS`),
  );

  if (integratedLufs === null && truePeakDbtp === null) return null;
  return Object.freeze({ integratedLufs, loudnessRangeLu, truePeakDbtp, thresholdLufs });
}

/** Parse the LAST astats "Overall" block: peak level dBFS + peak sample count. */
export function parseAstatsOverall(stderr) {
  const text = typeof stderr === "string" ? stderr : "";
  const index = text.lastIndexOf("Overall");
  const block = index === -1 ? null : text.slice(index);
  if (block === null) return null;

  const peakLevelDbfs = toFinite(lastMatch(block, `Peak level dB:\\s*(${NUMBER})`));
  const peakCountRaw = lastMatch(block, `Peak count:\\s*(\\d+)`);
  if (peakLevelDbfs === null) return null;
  return Object.freeze({
    peakLevelDbfs,
    peakLevelSampleCount: peakCountRaw === null ? null : Number(peakCountRaw),
  });
}

// ---------------------------------------------------------------------------
// Measurement (injected spawn, real stderr)
// ---------------------------------------------------------------------------

function runAnalysis({ args, spawnImpl, timeoutMs }) {
  if (typeof spawnImpl !== "function") throw loudnessError("LOUDNESS_SPAWN_INVALID");
  let result;
  try {
    result = spawnImpl({ command: "ffmpeg", args, timeoutMs });
  } catch (error) {
    const wrapped = loudnessError("LOUDNESS_SPAWN_FAILED");
    wrapped.cause = error?.code ?? null;
    throw wrapped;
  }
  if (!result || typeof result !== "object") throw loudnessError("LOUDNESS_SPAWN_FAILED");
  if (result.timedOut === true) throw loudnessError("LOUDNESS_TIMEOUT");
  if (typeof result.exitCode !== "number") throw loudnessError("LOUDNESS_SPAWN_FAILED");
  if (result.exitCode !== 0) {
    const error = loudnessError("LOUDNESS_ANALYSIS_FAILED");
    error.exitCode = result.exitCode;
    error.stderrTail = typeof result.stderr === "string" ? result.stderr.slice(-1200) : "";
    throw error;
  }
  return result;
}

/**
 * Measure integrated loudness, loudness range and true peak for one file.
 * Never throws for an unmeasurable file — the record says so.
 */
export function measureLoudness({ file, spawnImpl, timeoutMs = 120_000 } = {}) {
  const base = {
    measurementVersion: LOUDNESS_MEASUREMENT_VERSION,
    success: false,
    reasonCode: null,
    integratedLufs: null,
    loudnessRangeLu: null,
    truePeakDbtp: null,
    thresholdLufs: null,
  };
  // Programming errors (hostile path, missing spawn) throw; a failed or
  // unparseable MEASUREMENT is reported as a truthful record.
  const args = buildLoudnessAnalysisArgs(file);
  if (typeof spawnImpl !== "function") throw loudnessError("LOUDNESS_SPAWN_INVALID");
  let parsed;
  try {
    const result = runAnalysis({ args, spawnImpl, timeoutMs });
    parsed = parseEbur128Summary(result.stderr);
  } catch (error) {
    return deepFreeze({
      ...base,
      reasonCode: error?.code ?? "LOUDNESS_ANALYSIS_FAILED",
      exitCode: typeof error?.exitCode === "number" ? error.exitCode : null,
      stderrTail: typeof error?.stderrTail === "string" ? error.stderrTail : null,
    });
  }
  if (parsed === null || !Number.isFinite(parsed.integratedLufs) || !Number.isFinite(parsed.truePeakDbtp)) {
    return deepFreeze({ ...base, reasonCode: "LOUDNESS_UNMEASURABLE" });
  }
  return deepFreeze({ ...base, ...parsed, success: true });
}

/**
 * Measure the artifact's peak level and the number of samples at that peak.
 * `clippedSampleCount` is the peak sample count when the peak reaches full
 * scale (>= 0 dBFS), otherwise 0.
 */
export function measureClipping({ file, spawnImpl, timeoutMs = 120_000 } = {}) {
  const base = {
    measurementVersion: LOUDNESS_MEASUREMENT_VERSION,
    success: false,
    reasonCode: null,
    peakLevelDbfs: null,
    peakLevelSampleCount: null,
    clippedSampleCount: null,
    clippingBasis: "astats_peak_level_and_peak_sample_count",
  };
  const args = buildClippingAnalysisArgs(file);
  if (typeof spawnImpl !== "function") throw loudnessError("LOUDNESS_SPAWN_INVALID");
  let parsed;
  try {
    const result = runAnalysis({ args, spawnImpl, timeoutMs });
    parsed = parseAstatsOverall(result.stderr);
  } catch (error) {
    return deepFreeze({
      ...base,
      reasonCode: error?.code ?? "LOUDNESS_ANALYSIS_FAILED",
      exitCode: typeof error?.exitCode === "number" ? error.exitCode : null,
      stderrTail: typeof error?.stderrTail === "string" ? error.stderrTail : null,
    });
  }
  if (parsed === null) {
    return deepFreeze({ ...base, reasonCode: "LOUDNESS_UNMEASURABLE" });
  }
  const clippedSampleCount =
    parsed.peakLevelDbfs >= 0 && Number.isFinite(parsed.peakLevelSampleCount)
      ? parsed.peakLevelSampleCount
      : parsed.peakLevelDbfs < 0
        ? 0
        : null;
  return deepFreeze({ ...base, ...parsed, clippedSampleCount, success: true });
}

// ---------------------------------------------------------------------------
// Conformance verdict (the gate)
// ---------------------------------------------------------------------------

/**
 * Judge a MEASURED artifact against the house target. All conditions must
 * hold: integrated within ±tolerance, true peak at or below target, and no
 * detected clipping. Any missing measurement fails closed.
 */
export function evaluateLoudnessConformance({
  measurement,
  clipping,
  target = HOUSE_LOUDNESS_TARGET,
} = {}) {
  const measured = {
    integratedLufs: Number.isFinite(measurement?.integratedLufs) ? measurement.integratedLufs : null,
    truePeakDbtp: Number.isFinite(measurement?.truePeakDbtp) ? measurement.truePeakDbtp : null,
    loudnessRangeLu: Number.isFinite(measurement?.loudnessRangeLu) ? measurement.loudnessRangeLu : null,
    peakLevelDbfs: Number.isFinite(clipping?.peakLevelDbfs) ? clipping.peakLevelDbfs : null,
    clippedSampleCount: Number.isFinite(clipping?.clippedSampleCount) ? clipping.clippedSampleCount : null,
  };
  const reasonCodes = [];

  if (!isMeasuredLoudness(measurement)) reasonCodes.push("LOUDNESS_UNMEASURABLE");
  if (clipping?.success !== true) reasonCodes.push("LOUDNESS_UNMEASURABLE");

  if (isMeasuredLoudness(measurement)) {
    const delta = Math.abs(measurement.integratedLufs - target.integratedLufs);
    if (!(delta <= target.integratedToleranceLu)) reasonCodes.push("LOUDNESS_INTEGRATED_OUT_OF_RANGE");
    if (!(measurement.truePeakDbtp <= target.truePeakDbtp)) reasonCodes.push("LOUDNESS_TRUE_PEAK_EXCEEDED");
  }
  if (clipping?.success === true && !(measured.clippedSampleCount === 0)) {
    reasonCodes.push("LOUDNESS_CLIPPING_DETECTED");
  }

  const unique = [...new Set(reasonCodes)];
  return deepFreeze({
    passed: unique.length === 0,
    reasonCodes: unique,
    target: { ...target },
    measured,
    integratedDeltaLu:
      isMeasuredLoudness(measurement) ? Math.abs(measurement.integratedLufs - target.integratedLufs) : null,
  });
}

// ---------------------------------------------------------------------------
// Normalization execution
// ---------------------------------------------------------------------------

/**
 * Run a real two-pass loudnorm remux. Returns a truthful record; the caller
 * must re-MEASURE the output before claiming conformance.
 */
export function normalizeLoudness({
  inputPath,
  outputPath,
  measurement,
  spawnImpl,
  target = HOUSE_LOUDNESS_TARGET,
  timeoutMs = 600_000,
} = {}) {
  const args = buildNormalizationArgs({ inputPath, outputPath, measurement, target });
  if (typeof spawnImpl !== "function") throw loudnessError("LOUDNESS_SPAWN_INVALID");
  const result = spawnImpl({ command: "ffmpeg", args, timeoutMs });
  const base = {
    measurementVersion: LOUDNESS_MEASUREMENT_VERSION,
    executed: true,
    success: false,
    failureCode: null,
    exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
    filter: args[args.indexOf("-af") + 1],
  };
  if (!result || result.timedOut === true) {
    return deepFreeze({ ...base, failureCode: "LOUDNESS_TIMEOUT" });
  }
  if (typeof result.exitCode !== "number") {
    return deepFreeze({ ...base, failureCode: "LOUDNESS_SPAWN_FAILED" });
  }
  if (result.exitCode !== 0) {
    return deepFreeze({
      ...base,
      failureCode: "LOUDNESS_ANALYSIS_FAILED",
      stderrTail: typeof result.stderr === "string" ? result.stderr.slice(-1200) : "",
    });
  }
  return deepFreeze({ ...base, success: true });
}
