/**
 * ST Production House — Local motion interpolation worker (S-M40-01,
 * issue #236: FFmpeg minterpolate fallback over real artifacts).
 *
 * WHAT THIS MODULE IS:
 *   The executor boundary the motion contract (motionAdapter.js) drives:
 *   a REAL, local-only ffmpeg invocation that turns existing frame artifacts
 *   into an interpolated-sequence artifact, followed by the same
 *   matching-hash FFprobe inspection every other media stage is gated by
 *   (S-M30-01 + #170). It runs through the production media transport
 *   (src/media/nodeMediaTransport.js) — array arguments, shell:false,
 *   bounded capture, real timeout kill.
 *
 * HONESTY CONTRACT (AGENTS.md Rules 1–3, issue #236 scope):
 *   - A provider exit 0 is NOT success: `mediaStatus: "verified"` requires a
 *     REAL matching-hash inspection of the actual output bytes. Every
 *     failure (binary absent → ENOENT record, timeout, non-zero exit,
 *     unreadable output, failed inspection) is truthful and stable-coded;
 *     the descriptor stays UNVERIFIED (`ffprobe_verified:false`). Nothing is
 *     fabricated.
 *   - LOCAL ONLY: the command is ffmpeg on the local machine. No remote
 *     provider API, no network call, no model weights, no bundled binaries —
 *     the local ffmpeg binary is supplied by the deployment environment like
 *     every other executor input.
 *   - Arguments are a frozen ARRAY; the output path is always the LAST
 *     argument; source frames are read through a concat demuxer list file
 *     whose entries are validated artifact paths (never a shell string,
 *     CONVENTIONS Rule 2).
 *   - Frame inputs are validated artifact paths (no NUL, no leading dash,
 *     no `..` traversal, bounded length) — mirrored from the inspection
 *     runner's path discipline. The concat list never embeds anything but a
 *     validated absolute artifact path per line.
 *   - Transports (`spawnImpl`, `readFileImpl`) are injectable so tests prove
 *     the contract offline AND with real binaries; the module adds no I/O
 *     dependencies of its own and never reads secrets (Rule 17).
 */

import { MOTION_ERROR_CODES, deepFreeze, recordMotionOutcome } from "./motionAdapter.js";
import { createArtifactDescriptor, verifyArtifactDescriptor } from "./artifactDescriptor.js";
import { inspectMediaFile, validateArtifactPath } from "./mediaInspectionRunner.js";

export const MOTION_WORKER_VERSION = "motion_interpolation_worker_v1";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_STDERR_TAIL = 200;

/** Stable worker error codes (subset of the contract's enumerated codes). */
export const MOTION_WORKER_ERROR_CODES = Object.freeze([
  ...MOTION_ERROR_CODES.filter((code) =>
    [
      "MOTION_PARAMS_INVALID",
      "MOTION_SOURCE_REF_INVALID",
      "MOTION_EXECUTOR_INVALID",
      "MOTION_SPAWN_FAILED",
      "MOTION_TIMEOUT",
      "MOTION_CALL_FAILED",
      "INSPECTION_FAILED",
    ].includes(code)
  ),
].map(String));

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stderrTail(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  const tail = stderr.trim().slice(-MAX_STDERR_TAIL);
  return tail.length > 0 ? tail : null;
}

/** Validate a motion OUTPUT path (same discipline as the inspection runner). */
export function validateMotionOutputPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    throw fail("MOTION_EXECUTOR_INVALID");
  }
  if (path.includes("\0")) throw fail("MOTION_EXECUTOR_INVALID");
  if (path.startsWith("-")) throw fail("MOTION_EXECUTOR_INVALID");
  if (path.split("/").some((segment) => segment === "..")) throw fail("MOTION_EXECUTOR_INVALID");
  return path;
}

/**
 * Pure: build the ffmpeg argument array (CONVENTIONS Rule 2 — array args
 * ONLY, never a shell string). Stable order; the output path is LAST.
 *
 *   ffmpeg -y -f concat -safe 0 -i <frameList> -vf
 *     minterpolate=fps=<fps>:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:mb_size=<mb>:search_param=<search>
 *     -r <fps> -frames:v <frameCount> -c:v libx264 -pix_fmt yuv420p <output>
 *
 * No invented flags: every token maps to a real, documented ffmpeg/minterpolate
 * option. The desSNAKE_PARAM stop stops interpolation excessive frames.
 */
export function buildMotionInterpolateArgs({ frameListPath, outputPath, params }) {
  validateArtifactPath(frameListPath);
  validateMotionOutputPath(outputPath);
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw fail("MOTION_PARAMS_INVALID");
  }
  const { fps, sourceFps, mbSize, search, frameCount } = params;
  if (![fps, sourceFps, mbSize, search, frameCount].every((v) => Number.isInteger(v))) {
    throw fail("MOTION_PARAMS_INVALID");
  }
  const fields = [
    `fps=${fps}`,
    "mi_mode=mci",
    "mc_mode=aobmc",
    "me_mode=bidir",
    `mb_size=${mbSize}`,
    `search_param=${search}`,
  ].join(":");
  const filter = `minterpolate=${fields}`;
  return Object.freeze([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", frameListPath,
    "-vf", filter,
    "-r", String(fps),
    "-frames:v", String(frameCount),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  ]);
}

/**
 * Run ONE local ffmpeg interpolation invocation.
 *
 *   spawnImpl: ({ command, args, timeoutMs, stdin? }) => Promise<{ exitCode,
 *     stdout, stderr, timedOut?, spawnErrorCode? }> — production wraps
 *     node:child_process spawn via the media transport (array args, no
 *     shell, real timeout kill).
 *
 * Truthful mapping:
 *   spawnErrorCode (ENOENT…)   → MOTION_SPAWN_FAILED (the plan did not run)
 *   timedOut                   → MOTION_TIMEOUT
 *   exitCode != 0              → MOTION_CALL_FAILED (with sanitized stderr tail)
 *   exitCode == 0              → proceed to real inspection (not success yet)
 */
export async function runMotionInterpolation(request, { spawnImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!request || typeof request !== "object" || !Array.isArray(request.args) || request.args.length === 0) {
    throw fail("MOTION_EXECUTOR_INVALID");
  }
  if (typeof request.command !== "string" || request.command.length === 0) {
    throw fail("MOTION_EXECUTOR_INVALID");
  }
  if (typeof spawnImpl !== "function") throw fail("MOTION_SPAWN_FAILED");
  let result;
  try {
    result = await spawnImpl({ command: request.command, args: request.args, timeoutMs });
  } catch {
    throw fail("MOTION_SPAWN_FAILED");
  }
  if (!result || typeof result !== "object") throw fail("MOTION_SPAWN_FAILED");
  if (result.spawnErrorCode !== undefined) {
    throw fail("MOTION_SPAWN_FAILED");
  }
  if (result.timedOut === true) throw fail("MOTION_TIMEOUT");
  if (typeof result.exitCode !== "number") throw fail("MOTION_SPAWN_FAILED");
  if (result.exitCode !== 0) {
    const error = fail("MOTION_CALL_FAILED");
    error.exitCode = result.exitCode;
    error.stderrTail = stderrTail(result.stderr);
    throw error;
  }
  return result;
}

/**
 * The ONE stage entry a real worker calls:
 *
 *   runMotionStage(request, {
 *     frameListPath, outputPath, spawnImpl, readFileImpl,
 *     timeoutMs?, probeTimeoutMs?, productionRunId?, now?,
 *   }) → frozen stage record:
 *     { argv, spawn, inspection, descriptor, outcome, mediaStatus,
 *       generationMode, success, failureCode, interpolationMode }
 *
 * On ANY failure the record is TRUTHFULLY unsuccessful: real observation
 * codes only, no fabricated media, no invented receipts. `now` is injectable
 * and NEVER part of identity (descriptor identity is the content hash).
 */
export async function runMotionStage(contractRequest, {
  frameListPath,
  outputPath,
  spawnImpl,
  readFileImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  probeTimeoutMs,
  productionRunId = "motion-interpolation-worker",
  now = () => new Date(),
} = {}) {
  if (!contractRequest || contractRequest.requestType !== "motion_request_v1") {
    throw fail("MOTION_EXECUTOR_INVALID");
  }
  const argv = buildMotionInterpolateArgs({ frameListPath, outputPath, params: contractRequest.params });

  // 1. Real, local-only ffmpeg interpolation. Command is dockerfile-supplied
  //    like every other media executor (the transport validates its shape).
  let execution = null;
  let spawnFailure = { code: null, stderrTail: null, spawnErrorCode: null };
  try {
    execution = await runMotionInterpolation(
      { command: "ffmpeg", args: argv },
      { spawnImpl, timeoutMs },
    );
  } catch (err) {
    spawnFailure = {
      code: err.code ?? "MOTION_SPAWN_FAILED",
      stderrTail: err.stderrTail ?? null,
      spawnErrorCode: err.code === "MOTION_SPAWN_FAILED" ? "SPAWN_FAILED" : null,
    };
  }

  // 2. Real verification (Issue #170): real bytes → real hash + real ffprobe.
  //    The worker runs this regardless of spawn success so the evidence
  //    trail always shows an inspected output (or the honest reason it could
  //    not be inspected).
  const inspection = await inspectMediaFile(outputPath, {
    readFileImpl,
    spawnImpl: spawnImpl ? (probeOpts) => spawnImpl({ ...probeOpts, command: "ffprobe" }) : undefined,
    timeoutMs: probeTimeoutMs,
    now,
  });

  // 3. Descriptor + truthful outcome (S-M30-01 + S-M40-01). The descriptor
  //    anchors on the REAL measured hash — no claimed dimensions, durations,
  //    or interpolation quality are asserted. Exit 0 alone is not evidence.
  let descriptor = null;
  let outcome = null;
  if (inspection.success === true) {
    descriptor = createArtifactDescriptor({
      artifactType: "video",
      mimeType: "video/mp4",
      contentSha256: inspection.contentSha256,
      producer: {
        agentId: contractRequest.agentId,
        runId: productionRunId,
        stageId: "motion",
        providerId: "ffmpeg-minterpolate",
        note: "local minterpolate interpolation (no remote provider)",
      },
      createdAt: now().toISOString(),
    });
  } else {
    // Truthful UNVERIFIED placeholder in the REAL descriptor shape (nested
    // verification state machine, S-M30-01) so the evidence trail stays
    // id-anchored and honestly unverified.
    descriptor = {
      schemaVersion: 1,
      descriptorType: "st_media_artifact_descriptor",
      contentSha256: inspection.contentSha256 ?? "0".repeat(64),
      artifactType: "video",
      mimeType: "video/mp4",
      durationSeconds: null,
      dimensions: null,
      producer: deepFreeze({
        agentId: contractRequest.agentId,
        runId: productionRunId,
        stageId: "motion",
        providerId: "ffmpeg-minterpolate",
      }),
      verification: deepFreeze({
        state: "UNVERIFIED",
        inspectedBy: null,
        inspectedAt: null,
        reasonCode: inspection.reasonCode ?? "NO_INSPECTION_RESULT",
      }),
    };
  }

  const verifiedDescriptor = inspection.success === true
    ? verifyArtifactDescriptor(descriptor, inspection)
    : descriptor;

  try {
    outcome = recordMotionOutcome({
      request: contractRequest,
      descriptor: verifiedDescriptor,
      providerCall: spawnFailure.code === null && execution !== null
        ? { status: "succeeded" }
        : { status: "failed" },
    });
  } catch {
    outcome = null;
  }

  const verificationState = verifiedDescriptor.verification?.state ?? "UNVERIFIED";
  const mediaStatus = inspection.success === true && verificationState === "VERIFIED"
    ? "verified"
    : "unverified";
  const failureCode = mediaStatus === "verified"
    ? null
    : spawnFailure.code ?? "INSPECTION_FAILED";

  return deepFreeze({
    workerVersion: MOTION_WORKER_VERSION,
    argv,
    spawn: spawnFailure.code === null
      ? { exitCode: execution.exitCode, timedOut: execution.timedOut === true }
      : { code: spawnFailure.code, stderrTail: spawnFailure.stderrTail, exitCode: null },
    inspection,
    descriptor: verifiedDescriptor,
    outcome,
    quotaState: "OK",
    interpolationMode: mediaStatus === "verified" ? "local_interpolation" : "not_evidenced",
    mediaStatus,
    generationMode: mediaStatus === "verified" ? "local_interpolation" : "not_evidenced",
    success: mediaStatus === "verified",
    failureCode,
  });
}
