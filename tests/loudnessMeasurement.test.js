/**
 * Issue #263 — measured loudness, clipping, and two-pass normalization.
 *
 * These tests are offline: the FFmpeg STDERR fixtures below reproduce the
 * real summary shapes, and the spawn is injected. No measurement is invented:
 * the point of the suite is that an unparseable or missing measurement fails
 * closed instead of passing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HOUSE_LOUDNESS_TARGET,
  buildClippingAnalysisArgs,
  buildLoudnessAnalysisArgs,
  buildNormalizationArgs,
  buildNormalizationFilter,
  evaluateLoudnessConformance,
  measureClipping,
  measureLoudness,
  normalizeLoudness,
  parseAstatsOverall,
  parseEbur128Summary,
} from "../src/media/loudnessMeasurement.js";

const EBUR128_CONFORMANT = `
[Parsed_ebur128_0 @ 0x55d0] Summary:

  Integrated loudness:
    I:         -14.0 LUFS
    Threshold: -24.0 LUFS

  Loudness range:
    LRA:        11.0 LU
    Threshold: -34.0 LUFS
    LRA low:    -20.0 LUFS
    LRA high:    -9.0 LUFS

  True peak:
    Peak:       -1.0 dBFS
`;

const EBUR128_TOO_LOUD = `
[Parsed_ebur128_0 @ 0x55d0] Summary:

  Integrated loudness:
    I:          -8.5 LUFS
    Threshold: -18.5 LUFS

  Loudness range:
    LRA:         6.0 LU
    Threshold: -28.5 LUFS
    LRA low:    -12.0 LUFS
    LRA high:    -4.0 LUFS

  True peak:
    Peak:        0.4 dBFS
`;

const EBUR128_SILENCE = `
[Parsed_ebur128_0 @ 0x55d0] Summary:

  Integrated loudness:
    I:          -inf LUFS
    Threshold:  -inf LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:  -inf LUFS
    LRA low:   -inf LUFS
    LRA high:  -inf LUFS

  True peak:
    Peak:       -inf dBFS
`;

const ASTATS_CLIPPED = `
[Parsed_astats_0 @ 0x55e0] Overall
DC offset: 0.000000
Min level: -1.000000
Max level: 1.000000
Peak level dB: 0.000000
RMS level dB: -14.000000
Peak count: 42
`;

const ASTATS_CLEAN = `
[Parsed_astats_0 @ 0x55e0] Overall
DC offset: 0.000000
Min level: -0.707946
Max level: 0.707946
Peak level dB: -3.010300
RMS level dB: -18.061800
Peak count: 7
`;

function fakeSpawn({ stderr = "", exitCode = 0, timedOut = false, spawnErrorCode = null } = {}) {
  const calls = [];
  const impl = (request) => {
    calls.push(request);
    return {
      exitCode: spawnErrorCode === null ? exitCode : null,
      timedOut,
      spawnErrorCode,
      stdout: "",
      stderr,
    };
  };
  return { impl, calls };
}

// ---------------------------------------------------------------- parsing
test("parses the LAST ebur128 summary block into real measured values", () => {
  const parsed = parseEbur128Summary(`${EBUR128_TOO_LOUD}\n${EBUR128_CONFORMANT}`);
  assert.equal(parsed.integratedLufs, -14);
  assert.equal(parsed.loudnessRangeLu, 11);
  assert.equal(parsed.truePeakDbtp, -1);
  assert.equal(parsed.thresholdLufs, -24);
});

test("parsing refuses text without a summary and reports silence as unmeasurable", () => {
  assert.equal(parseEbur128Summary("no measurement here"), null);
  // Digital silence measures -inf for both integrated loudness and true peak,
  // so there is no usable measurement at all — the parser says so.
  assert.equal(parseEbur128Summary(EBUR128_SILENCE), null);

  const record = measureLoudness({ file: "episode.mp4", spawnImpl: fakeSpawn({ stderr: EBUR128_SILENCE }).impl });
  assert.equal(record.success, false);
  assert.equal(record.reasonCode, "LOUDNESS_UNMEASURABLE");
});

test("parses astats peak level and peak sample count", () => {
  const clipped = parseAstatsOverall(ASTATS_CLIPPED);
  assert.equal(clipped.peakLevelDbfs, 0);
  assert.equal(clipped.peakLevelSampleCount, 42);
  assert.equal(parseAstatsOverall(ASTATS_CLEAN).peakLevelDbfs, -3.0103);
  assert.equal(parseAstatsOverall("nothing"), null);
});

// ------------------------------------------------------------ measurement
test("measureLoudness returns the measured values from a real-shaped stderr", () => {
  const { impl, calls } = fakeSpawn({ stderr: EBUR128_CONFORMANT });
  const record = measureLoudness({ file: "episode.mp4", spawnImpl: impl });

  assert.equal(record.success, true);
  assert.equal(record.integratedLufs, -14);
  assert.equal(record.truePeakDbtp, -1);
  assert.equal(record.loudnessRangeLu, 11);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ffmpeg");
  assert.ok(calls[0].args.includes("ebur128=peak=true"));
  assert.equal(calls[0].args.at(-1), "-");
});

test("measureLoudness fails closed for spawn failure, timeout, non-zero exit, and garbage", () => {
  const missing = measureLoudness({ file: "episode.mp4", spawnImpl: fakeSpawn({ spawnErrorCode: "ENOENT" }).impl });
  assert.equal(missing.success, false);
  assert.equal(missing.reasonCode, "LOUDNESS_SPAWN_FAILED");

  const timedOut = measureLoudness({ file: "episode.mp4", spawnImpl: fakeSpawn({ timedOut: true }).impl });
  assert.equal(timedOut.reasonCode, "LOUDNESS_TIMEOUT");

  const exit5 = measureLoudness({ file: "episode.mp4", spawnImpl: fakeSpawn({ exitCode: 5, stderr: "boom" }).impl });
  assert.equal(exit5.reasonCode, "LOUDNESS_ANALYSIS_FAILED");
  assert.match(exit5.stderrTail, /boom/);

  const garbage = measureLoudness({ file: "episode.mp4", spawnImpl: fakeSpawn({ stderr: "nonsense" }).impl });
  assert.equal(garbage.reasonCode, "LOUDNESS_UNMEASURABLE");

  assert.throws(() => measureLoudness({ file: "-rf", spawnImpl: () => ({}) }), /LOUDNESS_FILE_INVALID/);
  assert.throws(() => measureLoudness({ file: "episode.mp4", spawnImpl: null }), /LOUDNESS_SPAWN_INVALID/);
});

test("measureClipping counts full-scale peak samples and treats a sub-full-scale peak as zero", () => {
  const clipped = measureClipping({ file: "episode.mp4", spawnImpl: fakeSpawn({ stderr: ASTATS_CLIPPED }).impl });
  assert.equal(clipped.success, true);
  assert.equal(clipped.peakLevelDbfs, 0);
  assert.equal(clipped.clippedSampleCount, 42);
  assert.equal(clipped.clippingBasis, "astats_peak_level_and_peak_sample_count");

  const clean = measureClipping({ file: "episode.mp4", spawnImpl: fakeSpawn({ stderr: ASTATS_CLEAN }).impl });
  assert.equal(clean.clippedSampleCount, 0);
  assert.equal(clean.peakLevelSampleCount, 7);
});

test("analysis argv is array-only and rejects hostile paths", () => {
  const args = buildLoudnessAnalysisArgs("episode.mp4");
  assert.ok(Array.isArray(args));
  assert.ok(Object.isFrozen(args));
  assert.equal(args[0], "-hide_banner");
  assert.ok(buildClippingAnalysisArgs("episode.mp4").includes("astats=metadata=0:reset=0"));
  for (const hostile of ["", "-i", "a\0b", "x".repeat(5000)]) {
    assert.throws(() => buildLoudnessAnalysisArgs(hostile), /LOUDNESS_FILE_INVALID/);
  }
});

// ------------------------------------------------------------- conformance
test("conformance passes only within tolerance, under the true-peak ceiling, and without clipping", () => {
  const measured = { success: true, integratedLufs: -14, truePeakDbtp: -1.2, loudnessRangeLu: 9 };
  const cleanClipping = { success: true, peakLevelDbfs: -1.2, clippedSampleCount: 0 };

  const pass = evaluateLoudnessConformance({ measurement: measured, clipping: cleanClipping });
  assert.equal(pass.passed, true);
  assert.deepEqual(pass.reasonCodes, []);
  assert.equal(pass.integratedDeltaLu, 0);

  const tooLoud = evaluateLoudnessConformance({
    measurement: { ...measured, integratedLufs: -11.5, truePeakDbtp: 0.4 },
    clipping: cleanClipping,
  });
  assert.equal(tooLoud.passed, false);
  assert.ok(tooLoud.reasonCodes.includes("LOUDNESS_INTEGRATED_OUT_OF_RANGE"));
  assert.ok(tooLoud.reasonCodes.includes("LOUDNESS_TRUE_PEAK_EXCEEDED"));

  const clipping = evaluateLoudnessConformance({
    measurement: measured,
    clipping: { success: true, peakLevelDbfs: 0, clippedSampleCount: 3 },
  });
  assert.ok(clipping.reasonCodes.includes("LOUDNESS_CLIPPING_DETECTED"));

  const unmeasurable = evaluateLoudnessConformance({ measurement: { success: false }, clipping: {} });
  assert.equal(unmeasurable.passed, false);
  assert.ok(unmeasurable.reasonCodes.includes("LOUDNESS_UNMEASURABLE"));
  assert.equal(unmeasurable.measured.integratedLufs, null);
});

// ----------------------------------------------------------- normalization
test("normalization builds a two-pass loudnorm command from the MEASURED input", () => {
  const measurement = {
    success: true,
    integratedLufs: -8.5,
    truePeakDbtp: 0.4,
    loudnessRangeLu: 6,
    thresholdLufs: -18.5,
  };
  const filter = buildNormalizationFilter(measurement);
  assert.match(filter, /^loudnorm=I=-14:TP=-1:LRA=11:/);
  assert.match(filter, /measured_I=-8\.5/);
  assert.match(filter, /measured_TP=0\.4/);
  assert.match(filter, /measured_thresh=-18\.5/);
  assert.match(filter, /linear=true/);

  const args = buildNormalizationArgs({ inputPath: "in.mp4", outputPath: "out.mp4", measurement });
  assert.ok(args.includes("-c:v"));
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-ar") + 1], "48000");
  assert.equal(args.at(-1), "out.mp4");

  assert.throws(() => buildNormalizationFilter({ success: false }), /LOUDNESS_NORMALIZATION_INVALID/);
  assert.throws(
    () => buildNormalizationFilter({ success: true, integratedLufs: -14, truePeakDbtp: -1 }),
    /LOUDNESS_NORMALIZATION_INVALID/,
  );
});

test("normalizeLoudness reports execution honestly and never claims success on failure", () => {
  const measurement = { success: true, integratedLufs: -8.5, truePeakDbtp: 0.4, loudnessRangeLu: 6, thresholdLufs: -18.5 };
  const ok = normalizeLoudness({
    inputPath: "in.mp4",
    outputPath: "out.mp4",
    measurement,
    spawnImpl: fakeSpawn({}).impl,
  });
  assert.equal(ok.executed, true);
  assert.equal(ok.success, true);
  assert.match(ok.filter, /loudnorm/);

  const failed = normalizeLoudness({
    inputPath: "in.mp4",
    outputPath: "out.mp4",
    measurement,
    spawnImpl: fakeSpawn({ exitCode: 1, stderr: "encoder exploded" }).impl,
  });
  assert.equal(failed.success, false);
  assert.equal(failed.failureCode, "LOUDNESS_ANALYSIS_FAILED");
  assert.match(failed.stderrTail, /encoder exploded/);

  assert.equal(HOUSE_LOUDNESS_TARGET.integratedToleranceLu, 1);
});
