/**
 * Local motion stage binding tests (Issue #241).
 *
 * Proves the narrow seam that turns the SHIPPED motion worker (S-M40-01,
 * #236) into a pipeline stage:
 *   - the opt-in gate is exact ("1") and defaults off;
 *   - the frame list is deterministic and rejects shapes the concat demuxer
 *     cannot carry literally;
 *   - prerequisites fail closed (missing source, unverified source, foreign
 *     Director) BEFORE any spawn;
 *   - a real worker verdict maps to the #182 executor-result shape and the
 *     bridge records it with truthful `local_interpolation` provenance;
 *   - the production runner writes the frame list, invokes the worker with the
 *     recorded visual frame, and assembly consumes the MOTION clip (looped to
 *     the planned duration) instead of the still.
 *
 * All media is faked through injected transports: no binary is spawned, no
 * network call is made, and no artifact is claimed without a matching-hash
 * inspection record.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  LOCAL_MOTION_ENABLED_ENV,
  MOTION_STAGE_PARAMS,
  buildMotionFrameListContent,
  localMotionEnabled,
  motionRequestForVisualArtifact,
  runLocalMotionStage,
} from "../src/pipeline/motionStage.js";
import { bindProductionRunner, buildLongformAssemblyPlan } from "../src/pipeline/productionExecutorRunner.js";
import { evaluateExecutorArtifact } from "../src/pipeline/episodePipeline.js";
import { buildRenderPlan } from "../src/media/ffmpegAssemblyExecutor.js";
import { createArtifactDescriptor, verifyArtifactDescriptor } from "../src/media/artifactDescriptor.js";

const AGENT_ID = "agent-01";
const NOW = () => new Date("2026-10-22T09:00:00.000Z");
const MEDIA_PATHS = Object.freeze({
  audio: "/run/audio",
  visual: "/run/visuals",
  motion: "/run/motion",
  episode: "/run/episodes",
  thumbnail: "/run/thumbnails",
  runPrefix: "episode",
});

const FRAME_BYTES = Buffer.from("fake-visual-frame-bytes");
const MOTION_BYTES = Buffer.from("fake-motion-mp4-bytes");
const NARRATION_BYTES = Buffer.from("fake-narration-bytes");
const EPISODE_BYTES = Buffer.from("fake-assembled-episode-bytes");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function ffprobePayload({ bytes, durationSeconds = null, codecType = "video" }) {
  const format = { filename: "media", format_name: "mp4", size: String(bytes.length) };
  if (durationSeconds !== null) format.duration = String(durationSeconds);
  const stream = { codec_type: codecType, codec_name: codecType === "video" ? "h264" : "aac" };
  if (durationSeconds !== null) stream.duration = String(durationSeconds);
  // A measured rendered program reports both streams (S-M41-01 reads them).
  if (durationSeconds !== null && codecType === "video") {
    return { format, streams: [stream, { codec_type: "audio", codec_name: "aac", duration: String(durationSeconds) }] };
  }
  return { format, streams: [stream] };
}

/** Real-bytes reader: only the known artifact paths exist. */
function makeReadFile(files = new Map()) {
  return async (path) => {
    if (files.has(path)) return files.get(path);
    throw new Error("ENOENT");
  };
}

/**
 * Fake media transport: ffmpeg "renders" (exit 0), ffprobe reports the payload
 * of whichever known file was inspected, and the spawn records every argv so
 * the tests can prove what was actually executed.
 */
function makeSpawn({ files = new Map(), durations = new Map(), ffmpegExitCode = 0, spawnErrorCode = null } = {}) {
  const calls = [];
  const spawnImpl = async ({ command, args }) => {
    calls.push({ command, args: [...args] });
    if (spawnErrorCode !== null) {
      return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnErrorCode };
    }
    if (command === "ffprobe") {
      if (args[0] === "-version") return { exitCode: 0, stdout: "ffprobe version test", stderr: "", timedOut: false };
      const target = args[args.length - 1];
      const bytes = files.get(target) ?? MOTION_BYTES;
      const duration = durations.get(target) ?? null;
      return { exitCode: 0, stdout: JSON.stringify(ffprobePayload({ bytes, durationSeconds: duration })), stderr: "", timedOut: false };
    }
    return { exitCode: ffmpegExitCode, stdout: "", stderr: ffmpegExitCode === 0 ? "" : "synthetic encode failure", timedOut: false };
  };
  return { spawnImpl, calls };
}

/** A verified image artifact exactly as the pipeline records one. */
function verifiedVisualArtifact({ storagePath = "/run/frame.png" } = {}) {
  const contentSha256 = sha256(FRAME_BYTES);
  const descriptor = createArtifactDescriptor({
    artifactType: "image",
    mimeType: "image/png",
    contentSha256,
    producer: { agentId: AGENT_ID, runId: "episode-run1", stageId: "visual", providerId: "pollinations" },
  });
  const verified = verifyArtifactDescriptor(descriptor, {
    tool: "ffprobe",
    success: true,
    contentSha256,
    format: { format_name: "png" },
    streams: [{ codec_type: "video", codec_name: "png" }],
    inspectedAt: NOW().toISOString(),
  });
  return Object.freeze({ stage: "visual", agentId: AGENT_ID, sha256: contentSha256, storagePath, descriptor: verified });
}

function verifiedArtifact({ artifactType, mimeType, bytes, stage, path, agentId = AGENT_ID }) {
  const contentSha256 = sha256(bytes);
  const descriptor = createArtifactDescriptor({
    artifactType,
    mimeType,
    contentSha256,
    producer: { agentId, runId: "episode-run1", stageId: stage, providerId: "test" },
  });
  const verified = verifyArtifactDescriptor(descriptor, {
    tool: "ffprobe",
    success: true,
    contentSha256,
    format: { format_name: artifactType === "image" ? "png" : "mp4" },
    streams: [{ codec_type: artifactType === "audio" ? "audio" : "video" }],
    inspectedAt: NOW().toISOString(),
  });
  return Object.freeze({ stage, agentId, sha256: contentSha256, storagePath: path, descriptor: verified });
}

// ---------------------------------------------------------------------------
// Gate + frame list
// ---------------------------------------------------------------------------

test("motion gate: only the exact value \"1\" enables the stage; default is off", () => {
  assert.equal(localMotionEnabled({}), false);
  assert.equal(localMotionEnabled({ [LOCAL_MOTION_ENABLED_ENV]: "true" }), false);
  assert.equal(localMotionEnabled({ [LOCAL_MOTION_ENABLED_ENV]: "0" }), false);
  assert.equal(localMotionEnabled({ [LOCAL_MOTION_ENABLED_ENV]: "1" }), true);
  assert.equal(localMotionEnabled(null), false);
});

test("motion frame list: deterministic, one validated frame path per entry", () => {
  const content = buildMotionFrameListContent("/run/frame.png", 3);
  assert.equal(content, "file '/run/frame.png'\nduration 1\nfile '/run/frame.png'\nduration 1\nfile '/run/frame.png'\nduration 1\n");
  assert.equal(buildMotionFrameListContent("/run/frame.png", 3), content, "identical inputs → identical bytes");

  // Shapes the concat demuxer would parse differently are rejected outright.
  for (const hostile of ["-i/etc/passwd", "/run/../secret.png", "/run/it's.png", "/run/a\nb.png", "/run/\0x.png"]) {
    assert.throws(() => buildMotionFrameListContent(hostile, 1), /MOTION_SOURCE_PATH_UNSAFE/);
  }
  assert.throws(() => buildMotionFrameListContent("/run/frame.png", 0), /MOTION_EXECUTOR_INVALID/);
});

// ---------------------------------------------------------------------------
// Prerequisites fail closed (before any spawn)
// ---------------------------------------------------------------------------

test("prerequisites: missing, unverified, or foreign-Director sources fail closed without a spawn", async () => {
  const noSource = async () => {
    throw new Error("spawn must not be called without a verified source");
  };
  const writeFile = async () => {
    throw new Error("write must not happen without a verified source");
  };

  const missing = await runLocalMotionStage({
    agentId: AGENT_ID,
    visualArtifact: null,
    outputPath: "/run/motion/out.mp4",
    frameListPath: "/run/motion/frames.txt",
    spawnImpl: noSource,
    readFileImpl: makeReadFile(),
    writeFileImpl: writeFile,
  });
  assert.equal(missing.success, false);
  assert.equal(missing.failureCode, "MOTION_SOURCE_UNAVAILABLE");
  assert.equal(missing.descriptor, null);

  const artifact = verifiedVisualArtifact();
  const unverified = Object.freeze({
    ...artifact,
    descriptor: Object.freeze({
      ...artifact.descriptor,
      verification: Object.freeze({ state: "UNVERIFIED", inspectedBy: null, inspectedAt: null, reasonCode: "NO_INSPECTION_RESULT" }),
    }),
  });
  const unverifiedResult = await runLocalMotionStage({
    agentId: AGENT_ID,
    visualArtifact: unverified,
    outputPath: "/run/motion/out.mp4",
    frameListPath: "/run/motion/frames.txt",
    spawnImpl: noSource,
    readFileImpl: makeReadFile(),
    writeFileImpl: writeFile,
  });
  assert.equal(unverifiedResult.failureCode, "MOTION_SOURCE_UNAVAILABLE");

  const foreign = await runLocalMotionStage({
    agentId: "agent-02",
    visualArtifact: artifact,
    outputPath: "/run/motion/out.mp4",
    frameListPath: "/run/motion/frames.txt",
    spawnImpl: noSource,
    readFileImpl: makeReadFile(),
    writeFileImpl: writeFile,
  });
  assert.equal(foreign.failureCode, "MOTION_AGENT_MISMATCH");

  assert.throws(
    () => motionRequestForVisualArtifact({ agentId: AGENT_ID, visualArtifact: { ...artifact, storagePath: "/run/../frame.png" } }),
    /MOTION_SOURCE_PATH_UNSAFE/,
  );
});

// ---------------------------------------------------------------------------
// Real worker verdict → #182 bridge
// ---------------------------------------------------------------------------

test("verified motion: the worker's matching-hash inspection is the only success path", async () => {
  const outputPath = "/run/motion/episode-run1.mp4";
  const frameListPath = "/run/motion/episode-run1.frames.txt";
  const files = new Map([[outputPath, MOTION_BYTES], ["/run/frame.png", FRAME_BYTES]]);
  const writes = [];
  const { spawnImpl, calls } = makeSpawn({ files });

  const result = await runLocalMotionStage({
    agentId: AGENT_ID,
    visualArtifact: verifiedVisualArtifact(),
    outputPath,
    frameListPath,
    spawnImpl,
    readFileImpl: makeReadFile(files),
    writeFileImpl: async (path, content) => writes.push({ path, content }),
    productionRunId: "episode-run1",
    now: NOW,
  });

  assert.equal(result.success, true, JSON.stringify({ failure: result.failureCode }));
  assert.equal(result.mediaStatus, "verified");
  assert.equal(result.generationMode, "local_interpolation", "local work is never labelled a provider call");
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.descriptor.verification.state, "VERIFIED");
  assert.equal(result.inspection.contentSha256, sha256(MOTION_BYTES));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, frameListPath);
  assert.match(writes[0].content, /file '\/run\/frame\.png'/);
  assert.equal((writes[0].content.match(/file '/g) ?? []).length, MOTION_STAGE_PARAMS.frameCount);

  const ffmpegCall = calls.find((call) => call.command === "ffmpeg");
  assert.ok(ffmpegCall, "the real binary was invoked through the injected transport");
  assert.ok(ffmpegCall.args.includes(`minterpolate=fps=${MOTION_STAGE_PARAMS.fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:mb_size=${MOTION_STAGE_PARAMS.mbSize}:search_param=${MOTION_STAGE_PARAMS.search}`));
  assert.equal(ffmpegCall.args[ffmpegCall.args.length - 1], outputPath);

  // The bridge accepts the verified result and keeps the local provenance.
  const verdict = evaluateExecutorArtifact({
    stage: "motion",
    release: { id: "r-1", agentId: AGENT_ID },
    executorResult: result,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verified, true);
  assert.equal(verdict.kind, "video");
  assert.equal(verdict.generationMode, "local_interpolation");
  assert.equal(verdict.sha256, sha256(MOTION_BYTES));
});

test("missing ffmpeg: MOTION_SPAWN_FAILED, unverified media, no output path", async () => {
  const outputPath = "/run/motion/episode-run1.mp4";
  const { spawnImpl } = makeSpawn({ spawnErrorCode: "ENOENT" });

  const result = await runLocalMotionStage({
    agentId: AGENT_ID,
    visualArtifact: verifiedVisualArtifact(),
    outputPath,
    frameListPath: "/run/motion/episode-run1.frames.txt",
    spawnImpl,
    readFileImpl: makeReadFile(new Map([[outputPath, MOTION_BYTES]])),
    writeFileImpl: async () => {},
    productionRunId: "episode-run1",
    now: NOW,
  });

  assert.equal(result.success, false);
  assert.equal(result.failureCode, "MOTION_SPAWN_FAILED");
  assert.equal(result.mediaStatus, "unverified");
  assert.equal(result.generationMode, "not_evidenced");
  assert.equal(result.outputPath, null);

  const verdict = evaluateExecutorArtifact({
    stage: "motion",
    release: { id: "r-1", agentId: AGENT_ID },
    executorResult: result,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.failureCode, "MOTION_SPAWN_FAILED");
});

test("frame-list write failure fails the stage closed before any media claim", async () => {
  const { spawnImpl, calls } = makeSpawn({ files: new Map([["/run/motion/out.mp4", MOTION_BYTES]]) });
  const result = await runLocalMotionStage({
    agentId: AGENT_ID,
    visualArtifact: verifiedVisualArtifact(),
    outputPath: "/run/motion/out.mp4",
    frameListPath: "/run/motion/frames.txt",
    spawnImpl,
    readFileImpl: makeReadFile(new Map([["/run/motion/out.mp4", MOTION_BYTES]])),
    writeFileImpl: async () => {
      throw new Error("EACCES");
    },
    now: NOW,
  });
  assert.equal(result.failureCode, "MOTION_FRAME_LIST_WRITE_FAILED");
  assert.equal(calls.length, 0, "no binary was spawned");
});

// ---------------------------------------------------------------------------
// Production runner: stage branch + assembly consumption
// ---------------------------------------------------------------------------

test("production runner motion stage sources the recorded visual frame and writes the frame list", async () => {
  const files = new Map([
    [`${MEDIA_PATHS.motion}/episode-run1.mp4`, MOTION_BYTES],
    ["/run/frame.png", FRAME_BYTES],
  ]);
  const writes = [];
  const { spawnImpl, calls } = makeSpawn({ files });

  const runner = bindProductionRunner({
    agentId: AGENT_ID,
    paths: MEDIA_PATHS,
    spawnImpl,
    readFileImpl: makeReadFile(files),
    writeFileImpl: async (path, content) => writes.push({ path, content }),
    now: NOW,
  });

  const result = await runner({
    release: { id: "rel-1", agentId: AGENT_ID, title: "Motion probe" },
    stage: "motion",
    stageInputs: { title: "Motion probe" },
    recordedArtifacts: [verifiedVisualArtifact()],
    productionRunId: "episode-run1",
  });

  assert.equal(result.success, true, JSON.stringify({ failure: result.failureCode }));
  assert.equal(result.outputPath, `${MEDIA_PATHS.motion}/episode-run1.mp4`);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `${MEDIA_PATHS.motion}/episode-run1.frames.txt`);
  assert.match(writes[0].content, new RegExp(`file '/run/frame\\.png'`));
  assert.ok(calls.some((call) => call.command === "ffmpeg" && call.args.includes("-f") && call.args.includes("concat")));
});

test("production runner motion stage without a recorded visual artifact fails closed", async () => {
  const { spawnImpl, calls } = makeSpawn({ files: new Map() });
  const runner = bindProductionRunner({
    agentId: AGENT_ID,
    paths: MEDIA_PATHS,
    spawnImpl,
    readFileImpl: makeReadFile(),
    writeFileImpl: async () => {},
    now: NOW,
  });
  const result = await runner({
    release: { id: "rel-1", agentId: AGENT_ID, title: "Motion probe" },
    stage: "motion",
    recordedArtifacts: [],
    productionRunId: "episode-run1",
  });
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "MOTION_SOURCE_UNAVAILABLE");
  assert.equal(calls.length, 0);
});

test("longform assembly plan binds the motion clip when present and the still otherwise", () => {
  const narration = verifiedArtifact({ artifactType: "audio", mimeType: "audio/mpeg", bytes: NARRATION_BYTES, stage: "audio", path: "/run/narration.mp3" });
  const visual = verifiedVisualArtifact();
  const motion = verifiedArtifact({ artifactType: "video", mimeType: "video/mp4", bytes: MOTION_BYTES, stage: "motion", path: "/run/motion.mp4" });

  const withMotion = buildLongformAssemblyPlan({
    agentId: AGENT_ID,
    productionRunId: "episode-run1",
    narrationArtifact: narration,
    visualArtifact: visual,
    motionArtifact: motion,
    durationSeconds: 1800,
  });
  assert.equal(withMotion.segments[0].kind, "video_clip");
  assert.equal(withMotion.segments[0].artifactRef, `sha256:${motion.sha256}`);
  assert.equal(withMotion.segments[0].durationSeconds, 1800);

  const withoutMotion = buildLongformAssemblyPlan({
    agentId: AGENT_ID,
    productionRunId: "episode-run1",
    narrationArtifact: narration,
    visualArtifact: visual,
    durationSeconds: 1800,
  });
  assert.equal(withoutMotion.segments[0].kind, "still_image");
  assert.equal(withoutMotion.segments[0].artifactRef, `sha256:${visual.sha256}`);
});

test("assembly render loops a real motion clip to the planned slot, and still holds the still", () => {
  const narration = verifiedArtifact({ artifactType: "audio", mimeType: "audio/mpeg", bytes: NARRATION_BYTES, stage: "audio", path: "/run/narration.mp3" });
  const visual = verifiedVisualArtifact();
  const motion = verifiedArtifact({ artifactType: "video", mimeType: "video/mp4", bytes: MOTION_BYTES, stage: "motion", path: "/run/motion.mp4" });

  const bindings = {
    [`sha256:${narration.sha256}`]: { descriptor: narration.descriptor, path: "/run/narration.mp3" },
    [`sha256:${visual.sha256}`]: { descriptor: visual.descriptor, path: "/run/frame.png" },
    [`sha256:${motion.sha256}`]: { descriptor: motion.descriptor, path: "/run/motion.mp4" },
  };

  const motionPlan = buildLongformAssemblyPlan({
    agentId: AGENT_ID,
    productionRunId: "episode-run1",
    narrationArtifact: narration,
    visualArtifact: visual,
    motionArtifact: motion,
    durationSeconds: 1800,
  });
  // resolvePlanInputs() emits { ref, descriptor, path }; mirror that shape.
  const resolved = (artifact) => ({ ref: `sha256:${artifact.sha256}`, ...bindings[`sha256:${artifact.sha256}`] });
  const motionRender = buildRenderPlan(
    motionPlan,
    [resolved(narration), resolved(motion)],
    "/run/episode.mp4",
  );
  const loopIndex = motionRender.args.indexOf("-stream_loop");
  assert.ok(loopIndex >= 0, "short real clip is looped, never silently truncated");
  assert.equal(motionRender.args[loopIndex + 1], "-1");
  assert.equal(motionRender.args[loopIndex + 2], "-t");
  assert.equal(motionRender.args[loopIndex + 3], "1800", "the motion clip fills the Director's planned slot");
  assert.ok(motionRender.args.includes("/run/motion.mp4"));
  assert.equal(motionRender.args.includes("/run/frame.png"), false);

  const stillPlan = buildLongformAssemblyPlan({
    agentId: AGENT_ID,
    productionRunId: "episode-run1",
    narrationArtifact: narration,
    visualArtifact: visual,
    durationSeconds: 1800,
  });
  const stillRender = buildRenderPlan(
    stillPlan,
    [resolved(narration), resolved(visual)],
    "/run/episode.mp4",
  );
  assert.equal(stillRender.args.includes("-stream_loop"), false);
  assert.ok(stillRender.args.includes("-loop"));
  assert.ok(stillRender.args.includes("/run/frame.png"));
});

test("production runner assembly consumes the motion binding end to end", async () => {
  const narration = verifiedArtifact({ artifactType: "audio", mimeType: "audio/mpeg", bytes: NARRATION_BYTES, stage: "audio", path: "/run/narration.mp3" });
  const visual = verifiedVisualArtifact();
  const motion = verifiedArtifact({ artifactType: "video", mimeType: "video/mp4", bytes: MOTION_BYTES, stage: "motion", path: "/run/motion.mp4" });
  const outputPath = `${MEDIA_PATHS.episode}/episode-run1.mp4`;
  const files = new Map([[outputPath, EPISODE_BYTES], ["/run/narration.mp3", NARRATION_BYTES], ["/run/frame.png", FRAME_BYTES], ["/run/motion.mp4", MOTION_BYTES]]);
  const { spawnImpl, calls } = makeSpawn({ files, durations: new Map([[outputPath, 1800]]) });

  const runner = bindProductionRunner({
    agentId: AGENT_ID,
    paths: MEDIA_PATHS,
    spawnImpl,
    readFileImpl: makeReadFile(files),
    writeFileImpl: async () => {},
    now: NOW,
  });

  const result = await runner({
    release: { id: "rel-1", agentId: AGENT_ID, title: "Motion probe" },
    stage: "assembly",
    recordedArtifacts: [narration, visual, motion],
    artifactBindings: {
      [`sha256:${narration.sha256}`]: { descriptor: narration.descriptor, path: "/run/narration.mp3" },
      [`sha256:${visual.sha256}`]: { descriptor: visual.descriptor, path: "/run/frame.png" },
      [`sha256:${motion.sha256}`]: { descriptor: motion.descriptor, path: "/run/motion.mp4" },
    },
    targetDurationSeconds: 1800,
    targetDurationSource: "job_payload",
    productionRunId: "episode-run1",
  });

  assert.equal(result.success, true, JSON.stringify({ failure: result.failureCode, qc: result.qc }));
  const ffmpegCall = calls.find((call) => call.command === "ffmpeg");
  assert.ok(ffmpegCall.args.includes("-stream_loop"), "the rendered program is the motion clip");
  assert.ok(ffmpegCall.args.includes("/run/motion.mp4"));
  assert.equal(ffmpegCall.args.includes("/run/frame.png"), false);
});
