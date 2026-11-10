/**
 * Episode completeness gate tests (S-M41-01, S-M43-01, Issue #243, #263).
 *
 * The gate exists because a duration-valid render can be almost entirely
 * silent or technically non-conforming. These tests pin the fail-closed contract
 * on the REAL inspection shape FFprobe produces — required streams, per-stream
 * measured durations, audio coverage against the reference program length,
 * the A/V overrun direction, resolution, sample rate, frame rate, and loudness.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_OVERRUN_TOLERANCE_SECONDS,
  COMPLETENESS_ERROR_CODES,
  EPISODE_COMPLETENESS_VERSION,
  REQUIRED_STREAMS,
  audioCoverageToleranceSeconds,
  evaluateEpisodeCompleteness,
  parseStreamTechnicalProperties,
} from "../src/media/episodeCompleteness.js";

function inspection({
  video = "1800",
  audio = "1800",
  videoType = "video",
  audioType = "audio",
  formatDuration = null,
  success = true,
  width = 1920,
  height = 1080,
  sampleRate = "48000",
  frameRate = "30/1",
  videoCodec = "h264",
  audioCodec = "aac",
} = {}) {
  const streams = [];
  if (videoType !== null) {
    streams.push(videoType === "video"
      ? { codec_type: "video", codec_name: videoCodec, width, height, avg_frame_rate: frameRate, ...(video !== null ? { duration: video } : {}) }
      : { codec_type: videoType, codec_name: "png", width, height, ...(video !== null ? { duration: video } : {}) });
  }
  if (audioType !== null) {
    streams.push({ codec_type: audioType, codec_name: audioCodec, sample_rate: sampleRate, channels: 2, ...(audio !== null ? { duration: audio } : {}) });
  }
  return {
    tool: "ffprobe",
    success,
    contentSha256: "a".repeat(64),
    format: { format_name: "mp4", ...(formatDuration !== null ? { duration: formatDuration } : {}) },
    streams,
    reasonCode: success ? null : "FFPROBE_EXIT_NONZERO",
  };
}

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

test("contract surface: version, required streams, and closed reason codes", () => {
  assert.equal(EPISODE_COMPLETENESS_VERSION, "episode_completeness_v1");
  assert.deepEqual([...REQUIRED_STREAMS], ["video", "audio"]);
  assert.equal(Object.isFrozen(COMPLETENESS_ERROR_CODES), true);
  assert.equal(new Set(COMPLETENESS_ERROR_CODES).size, COMPLETENESS_ERROR_CODES.length);
  for (const code of [
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
  ]) {
    assert.ok(COMPLETENESS_ERROR_CODES.includes(code), `${code} must stay stable`);
  }
});

test("tolerance: 0.5% of the reference, floored at 1 s and capped at 15 s", () => {
  assert.equal(audioCoverageToleranceSeconds(1800), 9);
  assert.equal(audioCoverageToleranceSeconds(2400), 12);
  assert.equal(audioCoverageToleranceSeconds(3000), 15);
  assert.equal(audioCoverageToleranceSeconds(30), 1);
  assert.equal(audioCoverageToleranceSeconds(1), 1);
  assert.equal(audioCoverageToleranceSeconds(0), 1);
  assert.equal(audioCoverageToleranceSeconds(null), 1);
});

// ---------------------------------------------------------------------------
// Technical stream properties extraction
// ---------------------------------------------------------------------------

test("parseStreamTechnicalProperties extracts video and audio specs", () => {
  const parsed = parseStreamTechnicalProperties(inspection({ width: 1920, height: 1080, sampleRate: "48000", frameRate: "30000/1001" }));
  assert.equal(parsed.video.width, 1920);
  assert.equal(parsed.video.height, 1080);
  assert.equal(parsed.video.aspectRatio, "16:9");
  assert.ok(Math.abs(parsed.video.frameRate - 29.97) < 0.05);
  assert.equal(parsed.video.codec, "h264");
  assert.equal(parsed.audio.sampleRate, 48000);
  assert.equal(parsed.audio.channels, 2);
  assert.equal(parsed.audio.codec, "aac");
});

test("parseStreamTechnicalProperties detects 9:16 vertical Reel", () => {
  const parsed = parseStreamTechnicalProperties(inspection({ width: 1080, height: 1920 }));
  assert.equal(parsed.video.aspectRatio, "9:16");
});

// ---------------------------------------------------------------------------
// Fail-closed rejections
// ---------------------------------------------------------------------------

test("failed or unreadable inspection cannot pass", () => {
  assert.equal(evaluateEpisodeCompleteness({ inspection: null }).reasonCode, "QC_INSPECTION_UNAVAILABLE");
  assert.equal(evaluateEpisodeCompleteness({ inspection: inspection({ success: false }) }).reasonCode, "QC_INSPECTION_UNAVAILABLE");
  const noStreams = { ...inspection(), streams: [] };
  assert.equal(evaluateEpisodeCompleteness({ inspection: noStreams }).reasonCode, "QC_INSPECTION_UNAVAILABLE");
});

test("missing required streams are truthful rejections", () => {
  const noAudio = evaluateEpisodeCompleteness({ inspection: inspection({ audioType: null }) });
  assert.equal(noAudio.passed, false);
  assert.equal(noAudio.reasonCode, "QC_STREAM_MISSING_AUDIO");

  const noVideo = evaluateEpisodeCompleteness({ inspection: inspection({ videoType: "data" }) });
  assert.equal(noVideo.passed, false);
  assert.equal(noVideo.reasonCode, "QC_STREAM_MISSING_VIDEO");
});

test("a missing measured stream duration cannot pass by default", () => {
  for (const partial of [inspection({ audio: null }), inspection({ video: null })]) {
    const verdict = evaluateEpisodeCompleteness({ inspection: partial });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.reasonCode, "QC_STREAM_DURATION_MISSING");
  }
});

test("the measured 30 s / 1 s render is rejected: 29 s of silence is not coverage", () => {
  const verdict = evaluateEpisodeCompleteness({ inspection: inspection({ video: "30", audio: "1" }) });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reasonCode, "QC_AUDIO_COVERAGE_INSUFFICIENT");
  assert.equal(verdict.videoSeconds, 30);
  assert.equal(verdict.audioSeconds, 1);
  assert.equal(verdict.referenceSeconds, 30);
  assert.equal(verdict.coverageToleranceSeconds, 1);
  assert.equal(verdict.audioCoverageRatio, 1 / 30);
});

test("a real long-form profile of a 3.6 s narration over 1890 s is rejected with measurements", () => {
  const verdict = evaluateEpisodeCompleteness({ inspection: inspection({ video: "1890", audio: "3.604036" }) });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reasonCode, "QC_AUDIO_COVERAGE_INSUFFICIENT");
  assert.equal(verdict.referenceSeconds, 1890);
  assert.ok(Math.abs(verdict.coverageToleranceSeconds - 9.45) < 1e-9, "min(15, 1890 * 0.005)");
  assert.ok(verdict.audioCoverageRatio < 0.01);
});

test("audio extending past the picture is an A/V sync failure", () => {
  const verdict = evaluateEpisodeCompleteness({ inspection: inspection({ video: "30", audio: String(30 + AUDIO_OVERRUN_TOLERANCE_SECONDS + 1) }) });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reasonCode, "QC_AUDIO_EXTENDS_BEYOND_VIDEO");

  // Within the overrun allowance is fine (encoder tail).
  const ok = evaluateEpisodeCompleteness({ inspection: inspection({ video: "30", audio: "30.5" }) });
  assert.equal(ok.passed, true);
});

// ---------------------------------------------------------------------------
// Technical conformance checks: resolution, sample rate, frame rate, loudness
// ---------------------------------------------------------------------------

test("resolution and aspect ratio mismatch fails closed", () => {
  const longform = inspection({ width: 1280, height: 720 });
  const widthFail = evaluateEpisodeCompleteness({ inspection: longform, expectedWidth: 1920 });
  assert.equal(widthFail.passed, false);
  assert.equal(widthFail.reasonCode, "QC_RESOLUTION_MISMATCH");

  const aspectFail = evaluateEpisodeCompleteness({ inspection: longform, expectedAspectRatio: "9:16" });
  assert.equal(aspectFail.passed, false);
  assert.equal(aspectFail.reasonCode, "QC_RESOLUTION_MISMATCH");

  const brandReelOk = evaluateEpisodeCompleteness({
    inspection: inspection({ width: 1080, height: 1920 }),
    expectedAspectRatio: "9:16",
    expectedWidth: 1080,
    expectedHeight: 1920,
  });
  assert.equal(brandReelOk.passed, true);
});

test("audio sample rate mismatch fails closed", () => {
  const badSampleRate = inspection({ sampleRate: "44100" });
  const verdict = evaluateEpisodeCompleteness({ inspection: badSampleRate, requiredSampleRate: 48000 });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reasonCode, "QC_SAMPLE_RATE_INVALID");

  const goodSampleRate = inspection({ sampleRate: "48000" });
  const ok = evaluateEpisodeCompleteness({ inspection: goodSampleRate, requiredSampleRate: 48000 });
  assert.equal(ok.passed, true);
});

test("video frame rate under minimum fails closed", () => {
  const lowFps = inspection({ frameRate: "1/1" });
  const verdict = evaluateEpisodeCompleteness({ inspection: lowFps, minFrameRate: 2 });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reasonCode, "QC_FRAME_RATE_INVALID");
});

test("audio loudness gating fails closed on out-of-range LUFS, true peak, or clipping", () => {
  const insp = inspection();
  // Target -14 LUFS, but measured is -22 LUFS (too quiet)
  const quietLoudness = { integratedLufs: -22.0, truePeakDbtp: -5.0, clippingCount: 0 };
  const quietVerdict = evaluateEpisodeCompleteness({ inspection: insp, loudness: quietLoudness, targetLufs: -14.0 });
  assert.equal(quietVerdict.passed, false);
  assert.equal(quietVerdict.reasonCode, "QC_LOUDNESS_OUT_OF_RANGE");

  // True peak exceeds ceiling (-0.5 > -1.0)
  const hotLoudness = { integratedLufs: -14.0, truePeakDbtp: -0.5, clippingCount: 0 };
  const hotVerdict = evaluateEpisodeCompleteness({ inspection: insp, loudness: hotLoudness, targetLufs: -14.0, maxTruePeakDbtp: -1.0 });
  assert.equal(hotVerdict.passed, false);
  assert.equal(hotVerdict.reasonCode, "QC_LOUDNESS_OUT_OF_RANGE");

  // Clipping detected
  const clipLoudness = { integratedLufs: -14.0, truePeakDbtp: 0.5, clippingCount: 1 };
  const clipVerdict = evaluateEpisodeCompleteness({ inspection: insp, loudness: clipLoudness });
  assert.equal(clipVerdict.passed, false);
  assert.equal(clipVerdict.reasonCode, "QC_AUDIO_CLIPPING_DETECTED");

  // Conforming loudness passes
  const goodLoudness = { integratedLufs: -14.2, truePeakDbtp: -1.1, clippingCount: 0 };
  const passVerdict = evaluateEpisodeCompleteness({
    inspection: insp,
    loudness: goodLoudness,
    targetLufs: -14.0,
    maxTruePeakDbtp: -1.0,
  });
  assert.equal(passVerdict.passed, true);
  assert.equal(passVerdict.reasonCode, null);
  assert.equal(passVerdict.technical.loudness.integratedLufs, -14.2);
});

// ---------------------------------------------------------------------------
// Passing contract + reference selection
// ---------------------------------------------------------------------------

test("a covered program passes with measured evidence and a frozen verdict", () => {
  const verdict = evaluateEpisodeCompleteness({ inspection: inspection({ video: "1890", audio: "1889" }) });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.reasonCode, null);
  assert.equal(verdict.videoSeconds, 1890);
  assert.equal(verdict.audioSeconds, 1889);
  assert.equal(verdict.referenceSeconds, 1890);
  assert.ok(Object.isFrozen(verdict));
  assert.ok(Object.isFrozen(verdict.requiredStreams));

  // Boundary: reference 1800 → tolerance 9. 1791 passes, 1790 does not.
  assert.equal(evaluateEpisodeCompleteness({ inspection: inspection({ video: "1800", audio: "1791" }) }).passed, true);
  assert.equal(evaluateEpisodeCompleteness({ inspection: inspection({ video: "1800", audio: "1790" }) }).passed, false);
});

test("a configured main target is the reference, not the measured video length", () => {
  // The video is 1830 s but the Director asked for 1800 s; 1700 s of audio is
  // 92.9 % of the picture and still fails the configured program length.
  const short = evaluateEpisodeCompleteness({
    inspection: inspection({ video: "1830", audio: "1700" }),
    targetSeconds: 1800,
  });
  assert.equal(short.passed, false);
  assert.equal(short.reasonCode, "QC_AUDIO_COVERAGE_INSUFFICIENT");
  assert.equal(short.referenceSeconds, 1800);

  const covered = evaluateEpisodeCompleteness({
    inspection: inspection({ video: "1830", audio: "1800" }),
    targetSeconds: 1800,
  });
  assert.equal(covered.passed, true);
  assert.equal(covered.referenceSeconds, 1800);
});

test("numeric and string durations are both real measurements", () => {
  const verdict = evaluateEpisodeCompleteness({
    inspection: {
      success: true,
      streams: [
        { codec_type: "video", duration: 6 },
        { codec_type: "audio", duration: 6 },
      ],
    },
  });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.videoSeconds, 6);
  assert.equal(verdict.audioSeconds, 6);
});

test("non-finite or negative durations are rejected, never coerced into a pass", () => {
  for (const bad of [{ codec_type: "audio", duration: "NaN" }, { codec_type: "audio", duration: -4 }]) {
    const verdict = evaluateEpisodeCompleteness({
      inspection: { success: true, streams: [{ codec_type: "video", duration: "30" }, bad] },
    });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.reasonCode, "QC_STREAM_DURATION_MISSING");
  }
});
