#!/usr/bin/env node
/**
 * ST Production House — REAL media smoke verification (Phase 2 evidence).
 *
 * WHAT THIS SCRIPT PROVES (and what it does not):
 *   It runs the SHIPPED production executors against the REAL binaries and
 *   the REAL filesystem, through the production transport
 *   (`src/media/nodeMediaTransport.js`):
 *
 *     generated placeholder inputs (real ffmpeg output)
 *       → real SHA-256 over the on-disk bytes
 *         → media_assembly_plan_v1 (plan integrity gate)
 *           → executeAssemblyPlan  (real ffmpeg argv, array args, no shell)
 *             → real ffprobe inspection of the RENDERED file
 *               → real QC duration gate ([1800,3000] s longform / [3,90] s short)
 *                 → VERIFIED artifact descriptor
 *
 *   It does NOT contact a provider, does NOT upload anything, does NOT
 *   synthesize speech, and does NOT claim any media as provider-generated.
 *   The inputs it generates are labelled placeholders: a silent audio track
 *   and a flat colour frame/animation. They exist only to exercise the
 *   assembly duration/QC contract with real bytes. A silent track is never
 *   presented as narration (AGENTS.md Rules 1–3). Nothing here writes a
 *   publishing receipt, a provider receipt, or an engagement number.
 *
 *   Render geometry is deliberately real: the longform input is a genuine
 *   1 fps video of the full planned runtime so the mandated encoder profile
 *   (libx264 medium/crf20) can produce a real 30–50 minute file inside a
 *   bounded CPU budget; the visual is a flat animation, not story footage.
 *   Recorded evidence states that explicitly.
 *
 * Usage (each stage is bounded):
 *   node scripts/real_media_smoke.mjs --stage=inputs
 *   node scripts/real_media_smoke.mjs --stage=longform
 *   node scripts/real_media_smoke.mjs --stage=reels [--reel=brand_reel]
 *   node scripts/real_media_smoke.mjs --stage=negative
 *   node scripts/real_media_smoke.mjs --stage=all
 *
 * Evidence is written to `artifacts/real-media-smoke/<stage>.json` (the
 * `artifacts/` directory is git-ignored: evidence is produced by running the
 * tools, never committed as a claim).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createArtifactDescriptor } from "../src/media/artifactDescriptor.js";
import {
  createAssemblyPlan,
  evaluateMainVideoRuntimeGate,
  verifyAssemblyPlanIntegrity,
} from "../src/media/assemblyPlan.js";
import { createNodeMediaTransports } from "../src/media/nodeMediaTransport.js";
import { executeAssemblyPlan } from "../src/media/ffmpegAssemblyExecutor.js";
import { inspectMediaFile } from "../src/media/mediaInspectionRunner.js";
import { createVoiceProfile, declareTtsProviderCapabilities } from "../src/media/ttsAdapter.js";
import { executeTtsGeneration } from "../src/media/ttsExecutor.js";
import {
  createVisualGenerationRequest,
  createVisualStyleProfile,
  declareVisualProviderCapabilities,
} from "../src/media/visualAdapter.js";
import { executeVisualGeneration } from "../src/media/visualExecutor.js";

const SMOKE_ROOT = path.join(process.cwd(), "artifacts", "real-media-smoke");
const INPUT_DIR = path.join(SMOKE_ROOT, "inputs");
const OUTPUT_DIR = path.join(SMOKE_ROOT, "outputs");

const LONG_FORM_SECONDS = 1890; // inside the [1800, 3000] s main-video window
const REEL_SECONDS = 30; // inside the [3, 90] s short-form window

const AGENT_ID = "agent-01";
const PRODUCER_NOTE = "real local placeholder signal (silent/flat) used only for the assembly + QC duration contract — never provider-generated media";

const transports = createNodeMediaTransports();
const { spawnImpl, readFileImpl } = transports;

const REEL_TARGETS = Object.freeze([
  Object.freeze({ target: "content_reel_1", aspectRatio: "9:16" }),
  Object.freeze({ target: "content_reel_2", aspectRatio: "9:16" }),
  Object.freeze({ target: "brand_reel", aspectRatio: "1:1" }),
]);

function fail(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

/** Run a real tool through the production transport; a non-zero exit is fatal here. */
async function runTool(command, args, { timeoutMs = 10 * 60_000 } = {}) {
  const result = await spawnImpl({ command, args, timeoutMs });
  if (result.timedOut === true) throw fail("TOOL_TIMEOUT", `${command} exceeded ${timeoutMs} ms`);
  if (typeof result.exitCode !== "number") {
    throw fail("TOOL_UNAVAILABLE", `${command} could not start (${result.spawnErrorCode ?? "unknown"})`);
  }
  if (result.exitCode !== 0) {
    throw fail("TOOL_EXIT_NONZERO", `${command} exited ${result.exitCode}: ${result.stderr.slice(-400)}`);
  }
  return result;
}

async function toolVersion(command) {
  try {
    const result = await runTool(command, ["-version"], { timeoutMs: 30_000 });
    return result.stdout.split("\n")[0]?.trim() ?? null;
  } catch (error) {
    return `unavailable (${error.code})`;
  }
}

async function hashOf(filePath) {
  const bytes = await readFileImpl(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function describe({ artifactType, mimeType, sha256, durationSeconds, stageId, runId }) {
  return createArtifactDescriptor({
    artifactType,
    mimeType,
    contentSha256: sha256,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    producer: {
      agentId: AGENT_ID,
      runId,
      stageId,
      providerId: "local_ffmpeg_placeholder_signal",
      note: PRODUCER_NOTE,
    },
    createdAt: new Date().toISOString(),
  });
}

function bind(descriptor, filePath) {
  return { descriptor, path: filePath };
}

/** Real measured duration as ffprobe reports it (never a planned value). */
function measuredSeconds(inspection) {
  const raw = inspection?.format?.duration;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Stage: inputs (real ffmpeg output; labelled placeholders)
// ---------------------------------------------------------------------------

async function stageInputs() {
  await mkdir(INPUT_DIR, { recursive: true });

  const longClip = path.join(INPUT_DIR, "placeholder-longform-visual-1fps.mp4");
  const longAudio = path.join(INPUT_DIR, "placeholder-longform-audio-silence.mp3");
  const reelStill = path.join(INPUT_DIR, "placeholder-reel-still.png");
  const reelAudio = path.join(INPUT_DIR, "placeholder-reel-audio-silence.mp3");

  const ffmpegVersion = await toolVersion("ffmpeg");
  const ffprobeVersion = await toolVersion("ffprobe");

  // 1 fps for the full planned runtime: a real video whose frame rate the
  // mandated encoder profile preserves, so the assembled file is genuinely
  // LONG_FORM_SECONDS long.
  await runTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x101018:s=1920x1080:r=1`,
    "-t", String(LONG_FORM_SECONDS),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "51", "-pix_fmt", "yuv420p",
    longClip,
  ], { timeoutMs: 8 * 60_000 });

  await runTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-t", String(LONG_FORM_SECONDS),
    "-c:a", "libmp3lame", "-b:a", "128k",
    longAudio,
  ], { timeoutMs: 8 * 60_000 });

  await runTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x1a1030:s=1080x1920",
    "-frames:v", "1", "-pix_fmt", "rgb24",
    reelStill,
  ], { timeoutMs: 60_000 });

  await runTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-t", String(REEL_SECONDS),
    "-c:a", "libmp3lame", "-b:a", "128k",
    reelAudio,
  ], { timeoutMs: 120_000 });

  const inputs = {};
  for (const [key, filePath, extra] of [
    ["longformVisual", longClip, { artifactType: "video", mimeType: "video/mp4" }],
    ["longformAudio", longAudio, { artifactType: "audio", mimeType: "audio/mpeg", durationSeconds: LONG_FORM_SECONDS }],
    ["reelStill", reelStill, { artifactType: "image", mimeType: "image/png" }],
    ["reelAudio", reelAudio, { artifactType: "audio", mimeType: "audio/mpeg", durationSeconds: REEL_SECONDS }],
  ]) {
    inputs[key] = {
      filePath,
      sha256: await hashOf(filePath),
      ...extra,
    };
  }

  return {
    stage: "inputs",
    ffmpegVersion,
    ffprobeVersion,
    longFormSeconds: LONG_FORM_SECONDS,
    reelSeconds: REEL_SECONDS,
    labels: { inputs: "labelled placeholders: silent audio + flat colour visual" },
    inputs,
    note: "Inputs are real ffmpeg output, hashed from the on-disk bytes. They are NOT narration and NOT story visuals.",
  };
}

// ---------------------------------------------------------------------------
// Stage: longform (real render + real ffprobe + real [1800,3000] s QC gate)
// ---------------------------------------------------------------------------

async function stageLongform() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const visualPath = path.join(INPUT_DIR, "placeholder-longform-visual-1fps.mp4");
  const audioPath = path.join(INPUT_DIR, "placeholder-longform-audio-silence.mp3");

  const visualSha = await hashOf(visualPath);
  const audioSha = await hashOf(audioPath);
  const visualDescriptor = describe({
    artifactType: "video", mimeType: "video/mp4",
    sha256: visualSha, durationSeconds: LONG_FORM_SECONDS, stageId: "visual", runId: "smoke-longform",
  });
  const audioDescriptor = describe({
    artifactType: "audio", mimeType: "audio/mpeg",
    sha256: audioSha, durationSeconds: LONG_FORM_SECONDS, stageId: "audio", runId: "smoke-longform",
  });

  const plan = createAssemblyPlan({
    agentId: AGENT_ID,
    productionRunId: "smoke-longform",
    outputTarget: "main_longform",
    aspectRatio: "16:9",
    segments: [
      { artifactRef: `sha256:${visualSha}`, kind: "video_clip", durationSeconds: LONG_FORM_SECONDS, transitionIn: "cut" },
      { artifactRef: `sha256:${audioSha}`, kind: "voice" },
    ],
    note: "real-media smoke: longform assembly duration + QC contract",
  });

  const integrity = verifyAssemblyPlanIntegrity(plan);
  const outputPath = path.join(OUTPUT_DIR, "longform-main.mp4");
  const result = await executeAssemblyPlan(plan, {
    artifactBindings: {
      [`sha256:${visualSha}`]: bind(visualDescriptor, visualPath),
      [`sha256:${audioSha}`]: bind(audioDescriptor, audioPath),
    },
    outputPath,
    spawnImpl,
    readFileImpl,
    timeoutMs: 15 * 60_000,
    probeTimeoutMs: 60_000,
  });

  return {
    stage: "longform",
    planId: plan.id,
    planIntegrityIntact: integrity.intact,
    outputPath: result.outputPath,
    executed: result.executed,
    exitCode: result.exitCode,
    stderrTail: result.stderrTail,
    ffmpegArgs: result.command,
    preflight: result.preflight,
    failureCode: result.failureCode,
    degradationNotes: result.degradations,
    qcPolicy: result.qc?.policy ?? null,
    qcPassed: result.qc?.passed ?? null,
    qcReasonCode: result.qc?.reasonCode ?? null,
    measuredDurationSeconds: result.qc?.measuredDurationSeconds ?? measuredSeconds(result.inspection),
    renderedSha256: result.descriptor?.contentSha256 ?? result.inspection?.contentSha256 ?? null,
    descriptorVerificationState: result.descriptor?.verification?.state ?? null,
    success: result.success,
  };
}

// ---------------------------------------------------------------------------
// Stage: reels (real short-form renders, one per canonical reel target)
// ---------------------------------------------------------------------------

async function stageReels(onlyTarget = null) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stillPath = path.join(INPUT_DIR, "placeholder-reel-still.png");
  const audioPath = path.join(INPUT_DIR, "placeholder-reel-audio-silence.mp3");
  const stillSha = await hashOf(stillPath);
  const audioSha = await hashOf(audioPath);
  const stillDescriptor = describe({
    artifactType: "image", mimeType: "image/png",
    sha256: stillSha, stageId: "packaging", runId: "smoke-reels",
  });
  const audioDescriptor = describe({
    artifactType: "audio", mimeType: "audio/mpeg",
    sha256: audioSha, durationSeconds: REEL_SECONDS, stageId: "audio", runId: "smoke-reels",
  });

  const results = [];
  for (const { target, aspectRatio } of REEL_TARGETS) {
    if (onlyTarget !== null && target !== onlyTarget) continue;
    const plan = createAssemblyPlan({
      agentId: AGENT_ID,
      productionRunId: `smoke-${target}`,
      outputTarget: target,
      aspectRatio,
      segments: [
        { artifactRef: `sha256:${stillSha}`, kind: "still_image", durationSeconds: REEL_SECONDS, transitionIn: "fade" },
        { artifactRef: `sha256:${audioSha}`, kind: "voice" },
      ],
      note: "real-media smoke: short-form assembly duration + QC contract",
    });
    const outputPath = path.join(OUTPUT_DIR, `${target}.mp4`);
    const result = await executeAssemblyPlan(plan, {
      artifactBindings: {
        [`sha256:${stillSha}`]: bind(stillDescriptor, stillPath),
        [`sha256:${audioSha}`]: bind(audioDescriptor, audioPath),
      },
      outputPath,
      spawnImpl,
      readFileImpl,
      timeoutMs: 8 * 60_000,
      probeTimeoutMs: 60_000,
    });
    results.push({
      target,
      aspectRatio,
      planId: plan.id,
      outputPath: result.outputPath,
      executed: result.executed,
      exitCode: result.exitCode,
      stderrTail: result.stderrTail,
      failureCode: result.failureCode,
      degradationNotes: result.degradations,
      qcPolicy: result.qc?.policy ?? null,
      qcPassed: result.qc?.passed ?? null,
      qcReasonCode: result.qc?.reasonCode ?? null,
      measuredDurationSeconds: result.qc?.measuredDurationSeconds ?? measuredSeconds(result.inspection),
      renderedSha256: result.descriptor?.contentSha256 ?? result.inspection?.contentSha256 ?? null,
      descriptorVerificationState: result.descriptor?.verification?.state ?? null,
      success: result.success,
    });
  }

  return { stage: "reels", reelSeconds: REEL_SECONDS, reels: results };
}

// ---------------------------------------------------------------------------
// Stage: negative (the gate must REJECT a real render that is too short)
// ---------------------------------------------------------------------------

async function stageNegative() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const shortRender = path.join(OUTPUT_DIR, "content_reel_1.mp4");
  const shortSha = await hashOf(shortRender);
  const shortDescriptor = describe({
    artifactType: "video", mimeType: "video/mp4",
    sha256: shortSha, stageId: "assembly", runId: "smoke-negative",
  });
  // BOTH inputs must be short: a long audio track would legitimately drive a
  // long output and the control would prove nothing.
  const audioPath = path.join(INPUT_DIR, "placeholder-reel-audio-silence.mp3");
  const audioSha = await hashOf(audioPath);
  const audioDescriptor = describe({
    artifactType: "audio", mimeType: "audio/mpeg",
    sha256: audioSha, durationSeconds: REEL_SECONDS, stageId: "audio", runId: "smoke-negative",
  });

  // A main_longform plan bound to a 30 s render: the real measured duration
  // must fail the [1800,3000] s gate. A rubber-stamp gate would pass here.
  const plan = createAssemblyPlan({
    agentId: AGENT_ID,
    productionRunId: "smoke-negative",
    outputTarget: "main_longform",
    aspectRatio: "16:9",
    segments: [
      { artifactRef: `sha256:${shortSha}`, kind: "video_clip", transitionIn: "cut" },
      { artifactRef: `sha256:${audioSha}`, kind: "voice" },
    ],
    note: "real-media smoke: negative control for the main-video duration gate",
  });

  const outputPath = path.join(OUTPUT_DIR, "longform-negative.mp4");
  const result = await executeAssemblyPlan(plan, {
    artifactBindings: {
      [`sha256:${shortSha}`]: bind(shortDescriptor, shortRender),
      [`sha256:${audioSha}`]: bind(audioDescriptor, audioPath),
    },
    outputPath,
    spawnImpl,
    readFileImpl,
    timeoutMs: 8 * 60_000,
    probeTimeoutMs: 60_000,
  });

  // Direct gate call on the real inspection, proving the gate itself (not
  // only the executor) refuses a short real render.
  const directInspection = await inspectMediaFile(shortRender, { readFileImpl, spawnImpl, timeoutMs: 60_000 });
  const directGate = evaluateMainVideoRuntimeGate(shortDescriptor, directInspection);

  return {
    stage: "negative",
    planId: plan.id,
    outputPath: result.outputPath,
    executed: result.executed,
    exitCode: result.exitCode,
    stderrTail: result.stderrTail,
    failureCode: result.failureCode,
    qcPassed: result.qc?.passed ?? null,
    qcReasonCode: result.qc?.reasonCode ?? null,
    measuredDurationSeconds: result.qc?.measuredDurationSeconds ?? measuredSeconds(result.inspection),
    descriptor: result.descriptor,
    success: result.success,
    expectedSuccess: false,
    negativeControlSatisfied:
      result.success === false && result.qc?.reasonCode === "QC_DURATION_OUT_OF_RANGE",
    directGate: {
      passed: directGate.passed,
      reasonCode: directGate.reasonCode,
      measuredDurationSeconds: directGate.measuredDurationSeconds,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage: provider-capacity (real TTS/visual executors, real environment truth)
// ---------------------------------------------------------------------------

/**
 * Drives the REAL TTS and visual executors with the real transport and the
 * exact per-Director registry shape the production runner uses, so the
 * recorded states are the environment's truth rather than a claim:
 *   - no declared slot            → durable wait (WAITING_FOR_QUOTA)
 *   - declared slot, no binary    → PROVIDER_UNAVAILABLE, mediaStatus unverified
 *   - declared slot + binary      → a real provider call happens (recorded)
 * Voice narration text here is a short neutral placeholder sentence and no
 * agent name ever appears (Rule 15).
 */
async function stageProviderCapacity() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const voiceProfile = createVoiceProfile({
    agentId: AGENT_ID,
    language: "hi",
    provider: {
      providerId: "edge-tts",
      providerRole: "approved_free_primary",
      modelIdentifier: "edge-tts-cli",
      voiceId: "hi-IN-MadhurNeural",
    },
  });
  const declaredTts = declareTtsProviderCapabilities({
    adapterId: "edge-tts-cli",
    languages: ["hi", "en"],
    voices: [{ voiceId: "hi-IN-MadhurNeural", language: "hi", supportsEmotion: true }],
  });
  const scriptText = "यह एक सत्यापन वाक्य है।";
  const ttsOptions = {
    scriptText,
    outputPath: path.join(OUTPUT_DIR, "capacity-probe-narration.mp3"),
    spawnImpl,
    readFileImpl,
    productionRunId: "smoke-capacity",
  };

  const ttsContractOnly = await executeTtsGeneration(voiceProfile, { ...ttsOptions, registry: {} });
  const ttsDeclaredNoBinary = await executeTtsGeneration(voiceProfile, {
    ...ttsOptions,
    registry: { "edge-tts": { declared: declaredTts, quotaExhausted: false } },
  });

  const styleProfile = createVisualStyleProfile({
    agentId: AGENT_ID,
    styleSummary: "cinematic composition",
    aspectRatio: "16:9",
  });
  const declaredVisual = declareVisualProviderCapabilities({
    adapterId: "visual-pollinations",
    modalities: ["image", "still_acquisition"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:5"],
  });
  const visualRequest = createVisualGenerationRequest({
    styleProfile,
    modality: "image",
    provider: { providerId: "pollinations", providerRole: "approved_free_primary", modelIdentifier: "flux" },
    scenePlanRef: "smoke-capacity#scene-1",
  });
  const visualDeclaredNoBinary = await executeVisualGeneration(styleProfile, {
    request: visualRequest,
    prompt: "cinematic establishing frame for a smoke verification",
    outputPath: path.join(OUTPUT_DIR, "capacity-probe-frame.png"),
    registry: { pollinations: { declared: declaredVisual, quotaExhausted: false } },
    spawnImpl,
    readFileImpl,
    productionRunId: "smoke-capacity",
  });

  const summarize = (result) => ({
    success: result.success,
    failureCode: result.failureCode ?? null,
    quotaState: result.quotaState ?? null,
    mediaStatus: result.mediaStatus ?? null,
    descriptorState: result.descriptor?.verification?.state ?? null,
    outputPath: result.outputPath ?? null,
  });

  return {
    stage: "provider-capacity",
    binaries: {
      "edge-tts": (await toolVersion("edge-tts")).includes("unavailable") ? "ABSENT" : await toolVersion("edge-tts"),
      "visual-pollinations": (await toolVersion("visual-pollinations")).includes("unavailable") ? "ABSENT" : await toolVersion("visual-pollinations"),
      ffmpeg: await toolVersion("ffmpeg"),
      ffprobe: await toolVersion("ffprobe"),
    },
    ttsWithoutDeclaredCapacity: summarize(ttsContractOnly),
    ttsWithDeclaredCapacityNoBinary: summarize(ttsDeclaredNoBinary),
    visualWithDeclaredCapacityNoBinary: summarize(visualDeclaredNoBinary),
    interpretation:
      "A provider exit 0 is never success: mediaStatus becomes verified only from a matching-hash inspection of the real output bytes. ABSENT binaries must surface PROVIDER_UNAVAILABLE (or the durable WAITING_FOR_QUOTA wait) — never fabricated media.",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { stage: "all", reel: null };
  for (const arg of argv) {
    if (arg.startsWith("--stage=")) options.stage = arg.slice("--stage=".length);
    else if (arg.startsWith("--reel=")) options.reel = arg.slice("--reel=".length);
  }
  return options;
}

async function writeEvidence(name, payload) {
  await mkdir(SMOKE_ROOT, { recursive: true });
  const filePath = path.join(SMOKE_ROOT, `${name}.json`);
  const record = {
    smokeRunner: "scripts/real_media_smoke.mjs",
    transportVersion: transports.transportVersion,
    generatedAt: new Date().toISOString(),
    providersContacted: 0,
    uploadsPerformed: 0,
    syntheticNote: "Placeholder local signals only; no provider-generated media is claimed.",
    ...payload,
  };
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stages = options.stage === "all"
    ? ["inputs", "provider-capacity", "longform", "reels", "negative"]
    : [options.stage];
  const summary = { stages: [] };

  for (const stage of stages) {
    let payload;
    if (stage === "inputs") payload = await stageInputs();
    else if (stage === "longform") payload = await stageLongform();
    else if (stage === "reels") payload = await stageReels(options.reel);
    else if (stage === "negative") payload = await stageNegative();
    else if (stage === "provider-capacity") payload = await stageProviderCapacity();
    else throw fail("SMOKE_STAGE_UNKNOWN", stage);
    const filePath = await writeEvidence(stage, payload);
    summary.stages.push({ stage, evidencePath: filePath, ...payload });
    console.log(JSON.stringify({ code: "SMOKE_STAGE_COMPLETE", stage, evidencePath: filePath }));
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ code: "SMOKE_STAGE_FAILED", errorCode: error?.code ?? "UNKNOWN", message: error?.message ?? String(error) }));
  process.exitCode = 1;
});
