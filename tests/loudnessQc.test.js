/**
 * Tests for Loudness QC and Technical Conformance (Slice S-M43-01).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  LOUDNESS_QC_VERSION,
  LOUDNESS_ERROR_CODES,
  DEFAULT_TARGET_LUFS,
  DEFAULT_TARGET_TRUE_PEAK_DBTP,
  parseLoudnessOutput,
  measureLoudness,
  normalizeLoudness,
  evaluateTechnicalConformance,
} from "../src/media/loudnessQc.js";

// ---------------------------------------------------------------------------
// Constants & Version
// ---------------------------------------------------------------------------

test("loudness qc contract constants and error codes", () => {
  assert.equal(LOUDNESS_QC_VERSION, "loudness_qc_v1");
  assert.equal(DEFAULT_TARGET_LUFS, -14.0);
  assert.equal(DEFAULT_TARGET_TRUE_PEAK_DBTP, -1.5);
  assert.ok(Array.isArray(LOUDNESS_ERROR_CODES));
  assert.ok(LOUDNESS_ERROR_CODES.includes("QC_LOUDNESS_UNMEASURABLE"));
  assert.ok(LOUDNESS_ERROR_CODES.includes("QC_NORMALIZATION_TARGET_MISSED"));
  assert.ok(LOUDNESS_ERROR_CODES.includes("QC_VIDEO_RESOLUTION_MISMATCH"));
  assert.ok(LOUDNESS_ERROR_CODES.includes("QC_AUDIO_SAMPLE_RATE_MISSING"));
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseLoudnessOutput: parses ebur128 summary accurately", () => {
  const stderr = `
Output #0, null, to 'pipe:':
[Parsed_ebur128_0 @ 0x55c707fd6140] Summary:

  Integrated loudness:
    I:         -19.2 LUFS
    Threshold: -29.2 LUFS

  Loudness range:
    LRA:         2.4 LU
    Threshold: -39.2 LUFS
    LRA low:   -20.5 LUFS
    LRA high:  -18.1 LUFS

  True peak:
    Peak:       -1.8 dBFS

[Parsed_astats_1 @ 0x5624eac26900] Peak level dB: -1.800000
[Parsed_astats_1 @ 0x5624eac26900] Peak count: 0
  `;
  const result = parseLoudnessOutput(stderr);
  assert.equal(result.integratedLufs, -19.2);
  assert.equal(result.truePeakDbtp, -1.8);
  assert.equal(result.lraLu, 2.4);
  assert.equal(result.thresholdLufs, -29.2);
  assert.equal(result.clippingCount, 0);
});

test("parseLoudnessOutput: detects clipping from peak level or true peak", () => {
  const clippingStderr = `
[Parsed_ebur128_0 @ 0x55c707fd6140] Summary:

  Integrated loudness:
    I:         -12.0 LUFS
    Threshold: -22.0 LUFS

  True peak:
    Peak:       0.8 dBFS

[Parsed_astats_1 @ 0x5624eac26900] Peak level dB: 0.000000
[Parsed_astats_1 @ 0x5624eac26900] Peak count: 12
  `;
  const result = parseLoudnessOutput(clippingStderr);
  assert.equal(result.integratedLufs, -12.0);
  assert.equal(result.truePeakDbtp, 0.8);
  assert.equal(result.clippingCount, 12);
});

test("parseLoudnessOutput: parses loudnorm JSON block", () => {
  const stderr = `
[Parsed_loudnorm_0 @ 0x5636af213180]
{
	"input_i" : "-19.11",
	"input_tp" : "-0.49",
	"input_lra" : "1.10",
	"input_thresh" : "-29.12",
	"output_i" : "-14.05",
	"output_tp" : "-1.50",
	"output_lra" : "1.10",
	"output_thresh" : "-24.01",
	"normalization_type" : "dynamic",
	"target_offset" : "-0.00"
}
  `;
  const result = parseLoudnessOutput(stderr);
  assert.equal(result.integratedLufs, -19.11);
  assert.equal(result.truePeakDbtp, -0.49);
  assert.equal(result.lraLu, 1.10);
  assert.equal(result.thresholdLufs, -29.12);
});

test("parseLoudnessOutput: fails closed on unmeasurable or empty output", () => {
  assert.throws(() => parseLoudnessOutput(""), /QC_LOUDNESS_UNMEASURABLE/);
  assert.throws(() => parseLoudnessOutput("Random log with no loudness info"), /QC_LOUDNESS_UNMEASURABLE/);
});

// ---------------------------------------------------------------------------
// Technical Conformance Evaluator
// ---------------------------------------------------------------------------

test("evaluateTechnicalConformance: accepts conforming 1920x1080 16:9 main video", () => {
  const inspection = {
    success: true,
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
      },
    ],
  };
  const verdict = evaluateTechnicalConformance(inspection, { targetKind: "main_longform" });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.reasonCode, null);
  assert.equal(verdict.video.width, 1920);
  assert.equal(verdict.video.height, 1080);
  assert.equal(verdict.video.aspectRatio, "16:9");
  assert.equal(verdict.audio.sampleRate, 48000);
});

test("evaluateTechnicalConformance: accepts conforming 1080x1920 9:16 brand reel", () => {
  const inspection = {
    success: true,
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1080,
        height: 1920,
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 1,
      },
    ],
  };
  const verdict = evaluateTechnicalConformance(inspection, {
    targetKind: "brand_reel",
    expectedAspectRatio: "9:16",
    expectedResolution: { width: 1080, height: 1920 },
  });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.video.aspectRatio, "9:16");
});

test("evaluateTechnicalConformance: rejects square 1:1 when 9:16 expected for brand reel", () => {
  const inspection = {
    success: true,
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1080,
        height: 1080,
        r_frame_rate: "30/1",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
      },
    ],
  };
  const verdict = evaluateTechnicalConformance(inspection, {
    targetKind: "brand_reel",
    expectedAspectRatio: "9:16",
    expectedResolution: { width: 1080, height: 1920 },
  });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reasonCode, "QC_VIDEO_RESOLUTION_MISMATCH");
});

test("evaluateTechnicalConformance: rejects missing audio sample rate", () => {
  const inspection = {
    success: true,
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        r_frame_rate: "30/1",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "0",
      },
    ],
  };
  const verdict = evaluateTechnicalConformance(inspection);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reasonCode, "QC_AUDIO_SAMPLE_RATE_MISSING");
});

// ---------------------------------------------------------------------------
// Mocked Loudness Measurement & Normalization
// ---------------------------------------------------------------------------

test("measureLoudness with injected spawnImpl returns measured values", async () => {
  const mockSpawn = async () => ({
    exitCode: 0,
    stderr: `
[Parsed_ebur128_0 @ 0x123] Summary:

  Integrated loudness:
    I:         -18.5 LUFS
    Threshold: -28.5 LUFS

  Loudness range:
    LRA:         2.0 LU
    Threshold: -38.5 LUFS
    LRA low:   -19.5 LUFS
    LRA high:  -17.5 LUFS

  True peak:
    Peak:       -2.1 dBFS
    `,
  });

  const res = await measureLoudness("/valid/path/file.mp4", { spawnImpl: mockSpawn });
  assert.equal(res.measured, true);
  assert.equal(res.integratedLufs, -18.5);
  assert.equal(res.truePeakDbtp, -2.1);
});

test("normalizeLoudness gates honestly on measured result", async () => {
  let callCount = 0;
  const mockSpawn = async ({ args }) => {
    callCount += 1;
    // Step 1: measure input
    // Step 2: run normalization
    // Step 3: measure normalized output
    if (callCount === 1) {
      return {
        exitCode: 0,
        stderr: `
[Parsed_ebur128_0 @ 0x1] Summary:
  Integrated loudness:
    I:         -22.0 LUFS
    Threshold: -32.0 LUFS
  True peak:
    Peak:       -4.0 dBFS
        `,
      };
    }
    if (callCount === 2) {
      return { exitCode: 0, stderr: "ffmpeg norm success" };
    }
    return {
      exitCode: 0,
      stderr: `
[Parsed_ebur128_0 @ 0x2] Summary:
  Integrated loudness:
    I:         -14.1 LUFS
    Threshold: -24.1 LUFS
  True peak:
    Peak:       -1.6 dBFS
      `,
    };
  };

  const result = await normalizeLoudness("/in.mp4", "/out.mp4", { spawnImpl: mockSpawn });
  assert.equal(result.success, true);
  assert.equal(result.input.integratedLufs, -22.0);
  assert.equal(result.normalized.integratedLufs, -14.1);
  assert.equal(result.normalized.truePeakDbtp, -1.6);
});

test("normalizeLoudness fails closed when normalization output misses target", async () => {
  let callCount = 0;
  const mockSpawn = async () => {
    callCount += 1;
    if (callCount === 1) {
      return { exitCode: 0, stderr: `[Parsed_ebur128_0 @ 0x1] Summary:\n  Integrated loudness:\n    I: -22.0 LUFS\n  True peak:\n    Peak: -4.0 dBFS` };
    }
    if (callCount === 2) return { exitCode: 0, stderr: "ok" };
    // Output missed target by a wide margin (-18.0 instead of -14.0)
    return { exitCode: 0, stderr: `[Parsed_ebur128_0 @ 0x2] Summary:\n  Integrated loudness:\n    I: -18.0 LUFS\n  True peak:\n    Peak: -1.0 dBFS` };
  };

  await assert.rejects(
    () => normalizeLoudness("/in.mp4", "/out.mp4", { spawnImpl: mockSpawn }),
    /QC_NORMALIZATION_TARGET_MISSED/,
  );
});
