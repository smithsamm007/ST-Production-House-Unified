/**
 * Issue #264 — durable rehearsal evidence: allowlist sanitization, required
 * measurement validation, and the post-build leak assertion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_TARGET_SECONDS,
  REHEARSAL_EVIDENCE_BUNDLE_VERSION,
  assertSanitizedBundle,
  redactPath,
  sanitizeRehearsalEvidence,
  scrubText,
  serializeRehearsalEvidenceBundle,
} from "../src/evidence/rehearsalEvidenceBundle.js";

const SHA = "a".repeat(64);

function evidence(overrides = {}) {
  return {
    rehearsalId: "real-media-rehearsal-1800",
    generatedAt: "2026-11-07T10:00:00.000Z",
    target: { targetSeconds: 1800, audioWindow: [1760, 1801] },
    narration: {
      scriptType: "long_form",
      generationMode: "deterministic_local",
      editorialStatus: "deterministic_planning_text",
      language: "hi",
      wordCount: 2400,
      plannedSeconds: 1500,
      textSha256: SHA,
    },
    speechSynthesis: {
      provider: "espeak-ng (real binary)",
      voice: "hi",
      calibration: [
        { attempt: 1, rate: 175, measuredDurationSeconds: 1200.5 },
        { attempt: 2, rate: 117, measuredDurationSeconds: 1795.2 },
      ],
      settledRate: 117,
      settledMeasuredAudioSeconds: 1795.2,
      workingDirectory: "/workspace/chats/abc/artifacts/rehearsal/1800",
    },
    assembly: {
      tool: "real ffmpeg (libx264, aac)",
      visualProvenance: "flat colour placeholder",
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "2/1", duration: "1795.2" },
        { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 1, duration: "1795.2" },
      ],
      outputPath: "/workspace/chats/abc/artifacts/rehearsal/1800/episode.mp4",
      outputSha256: SHA,
      outputSizeBytes: 123456,
    },
    loudness: {
      target: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 11, integratedToleranceLu: 1 },
      measuredInput: { integratedLufs: -8.5, truePeakDbtp: 0.4, loudnessRangeLu: 6, thresholdLufs: -18.5, peakLevelDbfs: 0, clippedSampleCount: 42, passed: false, reasonCodes: ["LOUDNESS_CLIPPING_DETECTED"] },
      normalization: { applied: true, reason: "input_not_conformant", filter: "loudnorm=I=-14:TP=-1:LRA=11", outputName: "/workspace/chats/abc/artifacts/rehearsal/1800/episode-normalized.mp4" },
      measuredOutput: { integratedLufs: -14.1, truePeakDbtp: -1.2, loudnessRangeLu: 8, peakLevelDbfs: -1.2, clippedSampleCount: 0, integratedDeltaLu: 0.1 },
      conformance: { passed: true, reasonCodes: [], integratedDeltaLu: 0.1, measured: { integratedLufs: -14.1, truePeakDbtp: -1.2, loudnessRangeLu: 8, peakLevelDbfs: -1.2, clippedSampleCount: 0 } },
    },
    technical: {
      profile: "placeholder_rehearsal",
      delivery: false,
      passed: true,
      reasonCodes: [],
      measured: { width: 1920, height: 1080, frameRate: 2, sampleRate: 48000, videoCodec: "h264", audioCodec: "aac" },
      note: "not the delivery profile",
    },
    completenessGate: {
      gate: "evaluateEpisodeCompleteness",
      passed: true,
      reasonCode: null,
      videoSeconds: 1800,
      audioSeconds: 1795.2,
      referenceSeconds: 1800,
      coverageToleranceSeconds: 40,
      audioCoverageRatio: 0.9973,
    },
    honestLimits: ["Placeholder visual proves the pipeline, not editorial quality."],
    ...overrides,
  };
}

test("builds a bundle from an allowlist and drops unknown/sensitive fields", () => {
  const bundle = sanitizeRehearsalEvidence(evidence(), {
    sourceName: "/workspace/chats/abc/artifacts/rehearsal/1800/rehearsal-evidence.json",
  });

  assert.equal(bundle.bundleVersion, REHEARSAL_EVIDENCE_BUNDLE_VERSION);
  assert.equal(bundle.source.file, "rehearsal-evidence.json");
  assert.equal(bundle.rehearsalId, "real-media-rehearsal-1800");
  assert.equal(bundle.target.targetSeconds, 1800);
  assert.deepEqual(bundle.target.audioWindow, [1760, 1801]);
  assert.equal(bundle.speechSynthesis.settledMeasuredAudioSeconds, 1795.2);
  assert.equal(bundle.speechSynthesis.attempts.length, 2);
  assert.equal(bundle.assembly.outputSha256, SHA);
  assert.equal(bundle.assembly.outputSizeBytes, 123456);
  assert.equal(bundle.loudness.measuredInput.clippedSampleCount, 42);
  assert.equal(bundle.loudness.normalization.outputName, "episode-normalized.mp4");
  assert.equal(bundle.technical.delivery, false);
  assert.equal(bundle.completenessGate.audioCoverageRatio, 0.9973);

  // Unknown keys (including a path and a host directory) never survive.
  assert.equal(bundle.speechSynthesis.workingDirectory, undefined);
  assert.equal(bundle.assembly.outputPath, undefined);

  const serialized = serializeRehearsalEvidenceBundle(bundle);
  assert.equal(serialized.includes("/workspace"), false);
  assert.equal(serialized.includes("rehearsal/1800/episode.mp4"), false);
  assert.ok(serialized.endsWith("\n"));
  assert.ok(Object.isFrozen(bundle));
  assert.ok(Object.isFrozen(bundle.assembly));
});

test("free text is scrubbed of absolute paths, URLs and credential-shaped fragments", () => {
  assert.equal(scrubText("/workspace/chats/abc/tool"), "[redacted-path]");
  assert.equal(redactPath("/workspace/chats/abc/f.mp4"), "f.mp4");
  assert.equal(redactPath("relative/f.mp4"), "f.mp4");
  assert.equal(redactPath(null), null);

  const bundle = sanitizeRehearsalEvidence(
    evidence({
      speechSynthesis: {
        provider: "engine at /home/runner/tools/espeak plus https://internal.example/api",
        voice: "hi",
        settledRate: 117,
        settledMeasuredAudioSeconds: 1795.2,
        calibration: [],
      },
      honestLimits: ["Leaked path /root/.cache/thing and token Bearer abcdef0123456789"],
    }),
  );
  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes("/home/runner"), false);
  assert.equal(serialized.includes("/root/.cache"), false);
  assert.equal(serialized.includes("internal.example"), false);
  assert.equal(serialized.includes("abcdef0123456789"), false);
  assert.match(bundle.speechSynthesis.provider, /redacted-path/);
  assert.match(bundle.honestLimits[0], /redacted-token/);
});

test("required measured fields are refused rather than defaulted", () => {
  const missingGate = evidence();
  delete missingGate.completenessGate;
  assert.throws(
    () => sanitizeRehearsalEvidence(missingGate),
    (error) => error.code === "EVIDENCE_REQUIRED_FIELD_MISSING" && error.field === "completenessGate",
  );

  const missingMeasuredAudio = evidence();
  delete missingMeasuredAudio.speechSynthesis.settledMeasuredAudioSeconds;
  assert.throws(
    () => sanitizeRehearsalEvidence(missingMeasuredAudio),
    (error) => error.code === "EVIDENCE_REQUIRED_FIELD_MISSING" && error.field === "speechSynthesis.settledMeasuredAudioSeconds",
  );

  const missingCoverage = evidence();
  delete missingCoverage.completenessGate.audioCoverageRatio;
  assert.throws(
    () => sanitizeRehearsalEvidence(missingCoverage),
    (error) => error.code === "EVIDENCE_REQUIRED_FIELD_MISSING" && error.field === "completenessGate.audioCoverageRatio",
  );
});

test("invalid shapes are rejected with stable codes", () => {
  assert.throws(() => sanitizeRehearsalEvidence(null), /EVIDENCE_INPUT_INVALID/);

  const badTarget = evidence({ target: { targetSeconds: 1234, audioWindow: [1200, 1235] } });
  assert.throws(
    () => sanitizeRehearsalEvidence(badTarget),
    (error) => error.code === "EVIDENCE_FIELD_INVALID" && error.field === "target.targetSeconds",
  );
  assert.deepEqual(EVIDENCE_TARGET_SECONDS, [1800, 2400, 3000]);

  const badSha = evidence();
  badSha.assembly.outputSha256 = "not-a-digest";
  assert.throws(
    () => sanitizeRehearsalEvidence(badSha),
    (error) => error.code === "EVIDENCE_FIELD_INVALID" && error.field === "assembly.outputSha256",
  );

  const badTimestamp = evidence({ generatedAt: "yesterday" });
  assert.throws(
    () => sanitizeRehearsalEvidence(badTimestamp),
    (error) => error.code === "EVIDENCE_FIELD_INVALID" && error.field === "generatedAt",
  );

  const badSize = evidence();
  badSize.assembly.outputSizeBytes = 0;
  assert.throws(
    () => sanitizeRehearsalEvidence(badSize),
    (error) => error.code === "EVIDENCE_FIELD_INVALID" && error.field === "assembly.outputSizeBytes",
  );
});

test("the post-build assertion refuses a bundle that still leaks", () => {
  const bundle = sanitizeRehearsalEvidence(evidence());
  assert.doesNotThrow(() => assertSanitizedBundle(bundle));

  assert.throws(
    () => assertSanitizedBundle({ ...bundle, extra: { note: "/home/runner/work/repo/artifacts/x.json" } }),
    (error) => error.code === "EVIDENCE_SANITIZATION_INCOMPLETE",
  );
  assert.throws(
    () => assertSanitizedBundle({ ...bundle, extra: { outputPath: "/tmp/x.mp4" } }),
    (error) => error.code === "EVIDENCE_SANITIZATION_INCOMPLETE" && error.problems.some((entry) => entry.includes("forbidden_key")),
  );
  assert.throws(
    () => serializeRehearsalEvidenceBundle({ ...bundle, ANTHROPIC_API_KEY: "x" }),
    (error) => error.code === "EVIDENCE_SANITIZATION_INCOMPLETE",
  );
});
