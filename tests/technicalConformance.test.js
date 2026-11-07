/**
 * Issue #263 — measured technical conformance (resolution, frame rate, sample
 * rate, codecs). Offline: the verdict consumes a real FFprobe record shape.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TECHNICAL_PROFILES,
  evaluateTechnicalConformance,
  parseFrameRate,
} from "../src/media/technicalConformance.js";

function inspection({ width = 1920, height = 1080, fps = "30/1", sampleRate = "48000", videoCodec = "h264", audioCodec = "aac" } = {}) {
  return {
    success: true,
    streams: [
      {
        codec_type: "video",
        codec_name: videoCodec,
        codec_long_name: "H.264 / AVC",
        width,
        height,
        avg_frame_rate: fps,
        r_frame_rate: fps,
        duration: "1800.0",
      },
      {
        codec_type: "audio",
        codec_name: audioCodec,
        sample_rate: sampleRate,
        channels: 1,
        channel_layout: "mono",
        duration: "1799.5",
      },
    ],
  };
}

test("parses ffprobe rational frame rates", () => {
  assert.equal(parseFrameRate("30/1"), 30);
  assert.equal(parseFrameRate("30000/1001"), 29.97);
  assert.equal(parseFrameRate("2/1"), 2);
  assert.equal(parseFrameRate(24), 24);
  for (const invalid of ["0/1", "1/0", "n/a", "", null, undefined, -5]) {
    assert.equal(parseFrameRate(invalid), null);
  }
});

test("the long-form delivery profile passes only a real 1920x1080 48 kHz 24+ fps artifact", () => {
  const verdict = evaluateTechnicalConformance({
    inspection: inspection(),
    profile: TECHNICAL_PROFILES.long_form_1080p,
  });
  assert.equal(verdict.passed, true);
  assert.deepEqual(verdict.reasonCodes, []);
  assert.equal(verdict.delivery, true);
  assert.equal(verdict.measured.width, 1920);
  assert.equal(verdict.measured.height, 1080);
  assert.equal(verdict.measured.frameRate, 30);
  assert.equal(verdict.measured.sampleRate, 48000);
  assert.equal(verdict.measured.videoCodec, "h264");
  assert.equal(verdict.measured.audioCodec, "aac");
});

test("the 9:16 profile asserts 1080x1920 and rejects a landscape render", () => {
  const vertical = evaluateTechnicalConformance({
    inspection: inspection({ width: 1080, height: 1920 }),
    profile: TECHNICAL_PROFILES.vertical_9_16,
  });
  assert.equal(vertical.passed, true);

  const landscape = evaluateTechnicalConformance({
    inspection: inspection(),
    profile: TECHNICAL_PROFILES.vertical_9_16,
  });
  assert.equal(landscape.passed, false);
  assert.ok(landscape.reasonCodes.includes("TECH_RESOLUTION_MISMATCH"));
});

test("resolution, frame rate, sample rate, codec, and stream gaps all fail closed", () => {
  const wrongResolution = evaluateTechnicalConformance({
    inspection: inspection({ width: 1280, height: 720 }),
    profile: TECHNICAL_PROFILES.long_form_1080p,
  });
  assert.ok(wrongResolution.reasonCodes.includes("TECH_RESOLUTION_MISMATCH"));

  const slow = evaluateTechnicalConformance({
    inspection: inspection({ fps: "2/1" }),
    profile: TECHNICAL_PROFILES.long_form_1080p,
  });
  assert.ok(slow.reasonCodes.includes("TECH_FRAME_RATE_BELOW_MINIMUM"));

  const unmeasurableFps = evaluateTechnicalConformance({
    inspection: inspection({ fps: "0/0" }),
    profile: TECHNICAL_PROFILES.long_form_1080p,
  });
  assert.ok(unmeasurableFps.reasonCodes.includes("TECH_FRAME_RATE_UNMEASURABLE"));

  const wrongRate = evaluateTechnicalConformance({
    inspection: inspection({ sampleRate: "22050" }),
    profile: TECHNICAL_PROFILES.long_form_1080p,
  });
  assert.ok(wrongRate.reasonCodes.includes("TECH_SAMPLE_RATE_MISMATCH"));

  const noDuration = evaluateTechnicalConformance({
    inspection: { success: true, streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1" }] },
    profile: TECHNICAL_PROFILES.long_form_1080p,
  });
  assert.ok(noDuration.reasonCodes.includes("TECH_STREAM_MISSING_AUDIO"));

  const unavailable = evaluateTechnicalConformance({
    inspection: { success: false, streams: [] },
    profile: TECHNICAL_PROFILES.long_form_1080p,
  });
  assert.equal(unavailable.passed, false);
  assert.deepEqual(unavailable.reasonCodes, ["TECH_INSPECTION_UNAVAILABLE"]);
  assert.throws(() => evaluateTechnicalConformance({ inspection: inspection(), profile: null }), /TECH_PROFILE_INVALID/);
});

test("the rehearsal placeholder profile is a REAL profile that is explicitly not delivery", () => {
  const placeholder = TECHNICAL_PROFILES.placeholder_rehearsal;
  assert.equal(placeholder.delivery, false);

  const verdict = evaluateTechnicalConformance({
    inspection: inspection({ fps: "2/1" }),
    profile: placeholder,
  });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.delivery, false);
  assert.equal(verdict.profile, "placeholder_rehearsal");
  assert.equal(verdict.measured.frameRate, 2);
});
