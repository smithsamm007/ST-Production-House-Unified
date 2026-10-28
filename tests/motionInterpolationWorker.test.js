import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile as nodeReadFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildMotionInterpolateArgs,
  runMotionStage,
  MOTION_WORKER_VERSION,
} from "../src/media/motionInterpolationWorker.js";
import { createMotionRequest } from "../src/media/motionAdapter.js";
import { createNodeMediaTransports } from "../src/media/nodeMediaTransport.js";

const AGENT_ID = "agent-01";
const FRAME_A = `sha256:${"aa".repeat(32)}`;

function contractRequest() {
  return createMotionRequest({
    agentId: AGENT_ID,
    sourceRefs: [FRAME_A],
    params: { sourceFps: 1, fps: 24, mbSize: 16, search: 8, frameCount: 6 },
  });
}

const tmpDir = () => mkdtemp(path.join(os.tmpdir(), "stph-motion-"));

function fakeSpawn(records) {
  return async function fakeSpawnImpl(received) {
    void received;
    return records.shift() ?? { exitCode: 1, stdout: "", stderr: "exhausted fake spawn", timedOut: false };
  };
}

// ---------------------------------------------------------------------------
// Pure argument construction
// ---------------------------------------------------------------------------

test("motion argv: array only, no shell metacharacters, output path is LAST and literal", () => {
  const args = buildMotionInterpolateArgs({
    frameListPath: "/abs/media/frames/list.txt",
    outputPath: "/abs/media/out/motion.mp4",
    params: { sourceFps: 1, fps: 24, mbSize: 16, search: 8, frameCount: 6 },
  });
  assert.equal(Array.isArray(args), true);
  assert.equal(args[args.length - 1], "/abs/media/out/motion.mp4");
  // The minterpolate filter is ONE literal argv token with colon-separated
  // real ffmpeg parameters (no invented flags, no shell).
  const filter = args.find((arg) => arg.startsWith("minterpolate="));
  assert.equal(
    filter,
    "minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:mb_size=16:search_param=8"
  );
  // concat demuxer inputs keep paths literal.
  assert.equal(args.includes("-safe"), true);
  assert.equal(Object.isFrozen(args), true);
});

test("motion argv: hostile/unsafe paths and non-integer params fail closed before any spawn", () => {
  assert.throws(
    () => buildMotionInterpolateArgs({
      frameListPath: "-i/etc/passwd",
      outputPath: "/out/motion.mp4",
      params: { sourceFps: 1, fps: 24, mbSize: 16, search: 8, frameCount: 6 },
    }),
    /PATH_UNSAFE|MOTION_EXECUTOR_INVALID/
  );
  assert.throws(
    () => buildMotionInterpolateArgs({
      frameListPath: "/frames/list.txt",
      outputPath: "/out/../motion.mp4",
      params: { sourceFps: 1, fps: 24, mbSize: 16, search: 8, frameCount: 6 },
    }),
    /MOTION_EXECUTOR_INVALID/
  );
  assert.throws(
    () => buildMotionInterpolateArgs({
      frameListPath: "/frames/list.txt",
      outputPath: "/out/motion.mp4",
      params: { sourceFps: 1.5, fps: 24, mbSize: 16, search: 8, frameCount: 6 },
    }),
    /MOTION_PARAMS_INVALID/
  );
});

// ---------------------------------------------------------------------------
// Honest failure matrix (offline, injected transports)
// ---------------------------------------------------------------------------

test("missing binary: an ENOENT spawn record yields MOTION_SPAWN_FAILED with mediaStatus unverified", async () => {
  const dir = await tmpDir();
  const fake = async () => ({
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnErrorCode: "ENOENT",
  });
  const stage = await runMotionStage(contractRequest(), {
    frameListPath: path.join(dir, "list.txt"),
    outputPath: path.join(dir, "motion.mp4"),
    spawnImpl: fake,
    readFileImpl: nodeReadFile,
  });
  assert.equal(stage.success, false);
  assert.equal(stage.mediaStatus, "unverified");
  assert.equal(stage.failureCode, "MOTION_SPAWN_FAILED");
  assert.equal(stage.generationMode, "not_evidenced");
  assert.equal(stage.descriptor.verification.state, "UNVERIFIED");
  assert.equal(stage.outcome.providerCall.status, "failed");
  assert.equal(stage.spawn.exitCode, null);
});

test("stale output + missing binary: a pre-existing file is never promoted as this run's render", async () => {
  const dir = await tmpDir();
  const outputPath = path.join(dir, "motion.mp4");
  // ffmpeg never starts (ENOENT), but ffprobe succeeds on a STALE file left by
  // a previous attempt at the same deterministic output path (Issue #241).
  const spawnImpl = async ({ command }) => {
    if (command === "ffprobe") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ format: { format_name: "mp4", size: "10" }, streams: [{ codec_type: "video" }] }),
        stderr: "",
        timedOut: false,
      };
    }
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnErrorCode: "ENOENT" };
  };
  const stage = await runMotionStage(contractRequest(), {
    frameListPath: path.join(dir, "list.txt"),
    outputPath,
    spawnImpl,
    readFileImpl: async () => Buffer.from("stale-previous-attempt-bytes"),
  });

  assert.equal(stage.inspection.success, true, "the stale bytes ARE inspectable — that is exactly the hazard");
  assert.equal(stage.success, false);
  assert.equal(stage.mediaStatus, "unverified");
  assert.equal(stage.failureCode, "MOTION_SPAWN_FAILED");
  assert.equal(stage.generationMode, "not_evidenced");
  assert.equal(stage.descriptor.verification.state, "UNVERIFIED");
  assert.equal(stage.descriptor.verification.reasonCode, "RENDER_NOT_EXECUTED");
  assert.equal(stage.outcome.mediaStatus, "unverified");
});

test("non-zero exit: honest MOTION_CALL_FAILED with a bounded stderr tail", async () => {
  const dir = await tmpDir();
  const fake = fakeSpawn([
    { exitCode: 3, stdout: "", stderr: "Invalid data found / synthetic failure", timedOut: false },
    { exitCode: 1, stdout: "", stderr: "no ffprobe subject", timedOut: false },
  ]);
  const stage = await runMotionStage(contractRequest(), {
    frameListPath: path.join(dir, "list.txt"),
    outputPath: path.join(dir, "motion.mp4"),
    spawnImpl: fake,
    readFileImpl: nodeReadFile,
  });
  assert.equal(stage.failureCode, "MOTION_CALL_FAILED");
  assert.equal(stage.success, false);
  assert.equal(stage.mediaStatus, "unverified");
  assert.equal(stage.spawn.code, "MOTION_CALL_FAILED");
  assert.match(stage.spawn.stderrTail, /synthetic failure/);
});

test("timeout: honest MOTION_TIMEOUT, never a disguised completion", async () => {
  const dir = await tmpDir();
  const fake = fakeSpawn([
    { exitCode: null, stdout: "", stderr: "", timedOut: true },
    { exitCode: 1, stdout: "", stderr: "", timedOut: false },
  ]);
  const stage = await runMotionStage(contractRequest(), {
    frameListPath: path.join(dir, "list.txt"),
    outputPath: path.join(dir, "motion.mp4"),
    spawnImpl: fake,
    readFileImpl: nodeReadFile,
  });
  assert.equal(stage.failureCode, "MOTION_TIMEOUT");
  assert.equal(stage.mediaStatus, "unverified");
});

test("exit 0 with an unreadable output: inspection fails honestly — INSPECTION_FAILED, UNVERIFIED descriptor", async () => {
  const dir = await tmpDir();
  const fake = fakeSpawn([
    { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    { exitCode: 1, stdout: "", stderr: "guard probe", timedOut: false },
  ]);
  const stage = await runMotionStage(contractRequest(), {
    frameListPath: path.join(dir, "missing-list.txt"),
    outputPath: path.join(dir, "missing-output.mp4"),
    spawnImpl: fake,
    readFileImpl: async () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(stage.failureCode, "INSPECTION_FAILED");
  assert.equal(stage.mediaStatus, "unverified");
  assert.equal(stage.descriptor.verification.state, "UNVERIFIED");
  assert.equal(stage.outcome.generationMode, "not_evidenced");
});

test("worker rejects a non-contract request shape outright", async () => {
  await assert.rejects(
    () => runMotionStage({ requestType: "other_v1" }, {}),
    /MOTION_EXECUTOR_INVALID/
  );
});

// ---------------------------------------------------------------------------
// REAL execution evidence (real ffmpeg + real spawn + real ffprobe inspection)
// ---------------------------------------------------------------------------

function realFfmpegAvailable() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

test("real local interpolation: two still frames → real minterpolate render → VERIFIED descriptor", async (t) => {
  if (!realFfmpegAvailable()) {
    t.diagnostic("ffmpeg not available in this environment; real render skipped honestly");
    return;
  }
  const dir = await tmpDir();

  // Two genuinely distinct real frames via real ffmpeg lavfi sources.
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64", "-frames:v", "1", path.join(dir, "frame1.png")],
    { stdio: "pipe", timeout: 20_000 },
  );
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=white:s=64x64", "-frames:v", "1", path.join(dir, "frame2.png")],
    { stdio: "pipe", timeout: 20_000 },
  );
  const frameList = path.join(dir, "frames.txt");
  await writeFile(
    frameList,
    [
      `file '${path.join(dir, "frame1.png")}'`,
      "duration 0.1",
      `file '${path.join(dir, "frame2.png")}'`,
      "duration 0.4",
      `file '${path.join(dir, "frame2.png")}'`,
      "",
    ].join("\n"),
  );

  const transports = createNodeMediaTransports();
  const stage = await runMotionStage(contractRequest(), {
    frameListPath: frameList,
    outputPath: path.join(dir, "motion.mp4"),
    spawnImpl: transports.spawnImpl,
    readFileImpl: transports.readFileImpl,
    timeoutMs: 120_000,
  });

  assert.equal(stage.workerVersion, MOTION_WORKER_VERSION);
  assert.equal(
    stage.success,
    true,
    JSON.stringify({
      failure: stage.failureCode,
      spawn: stage.spawn,
      inspection: stage.inspection?.reasonCode,
    }),
  );
  assert.equal(stage.mediaStatus, "verified");
  assert.equal(stage.generationMode, "local_interpolation");
  assert.equal(stage.failureCode, null);
  assert.equal(stage.descriptor.verification.state, "VERIFIED");
  assert.match(stage.descriptor.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(stage.outcome.mediaStatus, "verified");
  assert.equal(stage.outcome.interpolationMode, "local_interpolation");
  // The inspection measured the REAL rendered bytes: format came from ffprobe.
  assert.equal(typeof stage.inspection.format, "object");
  assert.notEqual(stage.inspection.format, null);
});
