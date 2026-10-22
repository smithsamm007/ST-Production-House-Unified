/**
 * Real local FFmpeg/FFprobe evidence for the episode completeness gate
 * (S-M41-01, Issue #243).
 *
 * These tests perform REAL renders with the production transports
 * (`createNodeMediaTransports`, array args, no shell) and assert the gate on
 * the REAL FFprobe measurement of the rendered bytes:
 *
 *   1. a 6 s program with a 1 s narration is REJECTED
 *      (`QC_AUDIO_COVERAGE_INSUFFICIENT`, no descriptor);
 *   2. the same program with matching 6 s audio is ACCEPTED and records the
 *      measured stream evidence.
 *
 * Where ffmpeg/ffprobe are absent the test skips honestly with a diagnostic —
 * it never fabricates a result either way (AGENTS.md Rule 1).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodeMediaTransports } from "../src/media/nodeMediaTransport.js";
import { inspectMediaFile } from "../src/media/mediaInspectionRunner.js";
import { createArtifactDescriptor, verifyArtifactDescriptor } from "../src/media/artifactDescriptor.js";
import { createAssemblyPlan } from "../src/media/assemblyPlan.js";
import { executeAssemblyPlan } from "../src/media/ffmpegAssemblyExecutor.js";

const AGENT_ID = "agent-01";
const PROGRAM_SECONDS = 6;

function realFfmpegAvailable() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe", timeout: 10_000 });
    execFileSync("ffprobe", ["-version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function verifiedInput(transports, { artifactType, mimeType, stage, file }) {
  const inspection = await inspectMediaFile(file, {
    readFileImpl: transports.readFileImpl,
    spawnImpl: transports.spawnImpl,
  });
  assert.equal(inspection.success, true, `${stage} input must be really inspectable`);
  const descriptor = verifyArtifactDescriptor(
    createArtifactDescriptor({
      artifactType,
      mimeType,
      contentSha256: inspection.contentSha256,
      producer: { agentId: AGENT_ID, runId: "real-completeness", stageId: stage, providerId: "probe" },
    }),
    inspection,
  );
  return { sha256: inspection.contentSha256, descriptor, path: file };
}

async function renderProgram({ dir, transports, audioSeconds }) {
  const still = path.join(dir, "frame.png");
  const voice = path.join(dir, `narration-${audioSeconds}.mp3`);
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=teal:s=320x180", "-frames:v", "1", still], { stdio: "pipe", timeout: 20_000 });
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${audioSeconds}`, voice], { stdio: "pipe", timeout: 20_000 });

  const visual = await verifiedInput(transports, { artifactType: "image", mimeType: "image/png", stage: "visual", file: still });
  const narration = await verifiedInput(transports, { artifactType: "audio", mimeType: "audio/mpeg", stage: "audio", file: voice });

  const plan = createAssemblyPlan({
    agentId: AGENT_ID,
    productionRunId: "real-completeness",
    outputTarget: "content_reel_1",
    aspectRatio: "9:16",
    segments: [
      { artifactRef: `sha256:${visual.sha256}`, kind: "still_image", durationSeconds: PROGRAM_SECONDS, transitionIn: "cut" },
      { artifactRef: `sha256:${narration.sha256}`, kind: "voice" },
    ],
  });

  return executeAssemblyPlan(plan, {
    artifactBindings: {
      [`sha256:${visual.sha256}`]: { descriptor: visual.descriptor, path: visual.path },
      [`sha256:${narration.sha256}`]: { descriptor: narration.descriptor, path: narration.path },
    },
    outputPath: path.join(dir, `program-${audioSeconds}.mp4`),
    spawnImpl: transports.spawnImpl,
    readFileImpl: transports.readFileImpl,
    timeoutMs: 120_000,
  });
}

test("REAL render: a short narration over a longer program is rejected by the completeness gate", async (t) => {
  if (!realFfmpegAvailable()) {
    t.diagnostic("ffmpeg/ffprobe not available in this environment; real completeness evidence skipped honestly");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "stph-completeness-real-"));
  const transports = createNodeMediaTransports();
  const result = await renderProgram({ dir, transports, audioSeconds: 1 });

  assert.equal(result.executed, true, "the real ffmpeg command ran");
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "QC_AUDIO_COVERAGE_INSUFFICIENT");
  assert.equal(result.descriptor, null, "an incomplete program is never verified");
  assert.equal(result.qc.passed, false);
  assert.equal(result.qc.completeness.passed, false);
  assert.equal(result.qc.completeness.reasonCode, "QC_AUDIO_COVERAGE_INSUFFICIENT");
  // The measurements come from the REAL rendered bytes.
  assert.ok(result.qc.completeness.videoSeconds >= PROGRAM_SECONDS - 0.1);
  assert.ok(result.qc.completeness.audioSeconds < 2);
  assert.ok(result.qc.completeness.audioCoverageRatio < 0.35);
});

test("REAL render: matching audio and video pass with measured stream evidence", async (t) => {
  if (!realFfmpegAvailable()) {
    t.diagnostic("ffmpeg/ffprobe not available in this environment; real completeness evidence skipped honestly");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "stph-completeness-real-"));
  const transports = createNodeMediaTransports();
  const result = await renderProgram({ dir, transports, audioSeconds: PROGRAM_SECONDS });

  assert.equal(result.executed, true);
  assert.equal(result.success, true, JSON.stringify({ failure: result.failureCode, qc: result.qc }));
  assert.equal(result.qc.passed, true);
  assert.equal(result.qc.completeness.passed, true);
  assert.ok(result.qc.completeness.videoSeconds >= PROGRAM_SECONDS - 0.1);
  assert.ok(result.qc.completeness.audioSeconds >= PROGRAM_SECONDS - 0.1);
  assert.ok(result.qc.completeness.audioCoverageRatio >= 0.99);
  assert.equal(result.descriptor.verification.state, "VERIFIED");
  assert.equal(result.descriptor.verification.inspectedBy, "ffprobe");
});
