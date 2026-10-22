/**
 * ST Production House — local motion stage binding (Issue #241).
 *
 * Wires the SHIPPED offline motion contract + worker (S-M40-01, #236) into the
 * real executor pipeline as ONE optional stage:
 *
 *   audio → visual → motion → assembly   (motion only when opted in)
 *
 * WHAT THIS MODULE IS:
 *   The narrow seam between the episode pipeline's artifact bindings and the
 *   local FFmpeg `minterpolate` worker. It performs NO motion generation of
 *   its own: it validates the release's OWN recorded visual artifact, writes
 *   the bounded concat frame list the worker consumes, invokes the worker, and
 *   maps the worker's truthful record to the executor-result shape the #182
 *   bridge already validates.
 *
 * HONESTY CONTRACT (AGENTS.md Rules 1–3, 15, 17):
 *   - Prerequisites are checked BEFORE any spawn: the visual artifact must be
 *     recorded with a `sha256:`-addressable content hash, a REAL storage path,
 *     a VERIFIED descriptor for that same hash, and the same Director. A
 *     missing or unverified source returns `MOTION_SOURCE_UNAVAILABLE` — the
 *     stage fails closed; nothing is guessed, copied, or substituted.
 *   - The motion output is verified ONLY by the worker's real matching-hash
 *     FFprobe inspection. `success` here mirrors the worker's verdict; an
 *     ffmpeg exit 0 alone never becomes a recorded artifact.
 *   - Paths are operational inputs, never contract fields: the concat list
 *     embeds one validated artifact path per line and rejects quotes,
 *     newlines, NUL, leading dashes, and `..` traversal (the concat demuxer
 *     would otherwise parse them).
 *   - Nothing here contacts a network, reads secrets, or invents ids.
 */

import { createMotionRequest } from "../media/motionAdapter.js";
import { runMotionStage } from "../media/motionInterpolationWorker.js";

export const MOTION_STAGE_BINDING_VERSION = "motion_stage_binding_v1";

/**
 * Feature gate. Default OFF: without it the pipeline runs exactly the
 * pre-existing `audio → visual → assembly` path. Opt-in is a deployment
 * decision (the same discipline as STPH_ENABLE_REAL_MEDIA).
 */
export const LOCAL_MOTION_ENABLED_ENV = "STPH_ENABLE_LOCAL_MOTION";

/**
 * The interpolation plan this binding issues. `fps > sourceFps` is required by
 * the contract (interpolation must increase temporal density); `frameCount`
 * bounds the rendered sequence to one second at 24 fps so the stage stays a
 * bounded, reviewable increment, never an unbounded render claim.
 */
export const MOTION_STAGE_PARAMS = Object.freeze({
  sourceFps: 1,
  fps: 24,
  frameCount: 24,
  mbSize: 16,
  search: 8,
});

export const MOTION_STAGE_ERROR_CODES = Object.freeze([
  "MOTION_SOURCE_UNAVAILABLE",
  "MOTION_SOURCE_PATH_UNSAFE",
  "MOTION_FRAME_LIST_WRITE_FAILED",
  "MOTION_AGENT_MISMATCH",
  "MOTION_EXECUTOR_INVALID",
]);

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const MAX_FRAME_LIST_BYTES = 1 * 1024 * 1024;

function stageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Resolves the opt-in gate. Only the exact value "1" enables the stage. */
export function localMotionEnabled(env = process.env) {
  return env !== null && typeof env === "object" && env[LOCAL_MOTION_ENABLED_ENV] === "1";
}

/**
 * The truthful executor-result shape for a motion stage that could not run.
 * No descriptor, no media, no wait state (the local slot has no quota).
 */
function motionFailure(code) {
  return Object.freeze({
    success: false,
    failureCode: code,
    quotaState: "OK",
    mediaStatus: "unverified",
    generationMode: "not_evidenced",
    descriptor: null,
    outcome: null,
    inspection: null,
    outputPath: null,
  });
}

/**
 * Validate an operational artifact path for the concat demuxer list.
 * Rejects exactly the shapes the list format cannot carry literally.
 */
export function requireMotionSourcePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    throw stageError("MOTION_SOURCE_PATH_UNSAFE");
  }
  if (path.includes("\0") || path.includes("\n") || path.includes("\r") || path.includes("'")) {
    throw stageError("MOTION_SOURCE_PATH_UNSAFE");
  }
  if (path.startsWith("-")) throw stageError("MOTION_SOURCE_PATH_UNSAFE");
  if (path.split("/").some((segment) => segment === "..")) throw stageError("MOTION_SOURCE_PATH_UNSAFE");
  return path;
}

/**
 * Deterministic concat-demuxer frame list: the recorded visual frame repeated
 * `frameCount` times at a one-second input cadence, which the worker's
 * `minterpolate` filter then resamples to the target frame rate. The list is a
 * pure function of (path, frameCount) — identical inputs, identical bytes.
 */
export function buildMotionFrameListContent(sourcePath, frameCount = MOTION_STAGE_PARAMS.frameCount) {
  const validated = requireMotionSourcePath(sourcePath);
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 20000) {
    throw stageError("MOTION_EXECUTOR_INVALID");
  }
  const lines = [];
  for (let index = 0; index < frameCount; index += 1) {
    lines.push(`file '${validated}'`, "duration 1");
  }
  const content = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_FRAME_LIST_BYTES) {
    throw stageError("MOTION_EXECUTOR_INVALID");
  }
  return content;
}

/**
 * Build the contract request for one release's recorded visual artifact.
 *
 * Requires ALL of: content hash, real storage path, a descriptor VERIFIED for
 * that exact hash, and the release's own Director. Anything else fails closed
 * with a stable code — the stage never animates an artifact it cannot prove.
 */
export function motionRequestForVisualArtifact({ agentId, visualArtifact } = {}) {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw stageError("MOTION_AGENT_MISMATCH");
  }
  if (visualArtifact === null || typeof visualArtifact !== "object") {
    throw stageError("MOTION_SOURCE_UNAVAILABLE");
  }
  const sha256 = visualArtifact.sha256;
  if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) {
    throw stageError("MOTION_SOURCE_UNAVAILABLE");
  }
  const descriptor = visualArtifact.descriptor;
  if (descriptor === null || typeof descriptor !== "object") {
    throw stageError("MOTION_SOURCE_UNAVAILABLE");
  }
  if (descriptor.artifactType !== "image") {
    // This binding animates recorded STILLS (the visual stage's real output).
    // Any other artifact type is not a frame source for this plan.
    throw stageError("MOTION_SOURCE_UNAVAILABLE");
  }
  if (descriptor.verification?.state !== "VERIFIED" || descriptor.contentSha256 !== sha256) {
    throw stageError("MOTION_SOURCE_UNAVAILABLE");
  }
  if (descriptor.producer?.agentId !== agentId) {
    throw stageError("MOTION_AGENT_MISMATCH");
  }
  const sourcePath = requireMotionSourcePath(visualArtifact.storagePath);
  const request = createMotionRequest({
    agentId,
    sourceRefs: [`sha256:${sha256}`],
    params: MOTION_STAGE_PARAMS,
    note: "local minterpolate over the recorded visual frame",
  });
  return Object.freeze({
    request,
    sourcePath,
    sourceRef: `sha256:${sha256}`,
  });
}

/**
 * Run the local motion stage for one release.
 *
 * Returns the executor-result shape the pipeline's #182 bridge evaluates:
 *   { success, failureCode, quotaState, mediaStatus, generationMode,
 *     descriptor, outcome, inspection, outputPath }
 *
 * `success: true` only when the worker's real inspection verified the rendered
 * bytes. Missing prerequisites, a failed frame-list write, an absent ffmpeg
 * binary, a timeout, a non-zero exit, or a failed inspection all return
 * `success: false` with the worker's stable code — never fabricated media.
 */
export async function runLocalMotionStage({
  agentId,
  visualArtifact,
  outputPath,
  frameListPath,
  spawnImpl,
  readFileImpl,
  writeFileImpl,
  productionRunId = "motion-stage",
  now,
  timeoutMs,
  probeTimeoutMs,
} = {}) {
  let source;
  try {
    source = motionRequestForVisualArtifact({ agentId, visualArtifact });
  } catch (error) {
    return motionFailure(error?.code ?? "MOTION_SOURCE_UNAVAILABLE");
  }

  if (typeof writeFileImpl !== "function") return motionFailure("MOTION_FRAME_LIST_WRITE_FAILED");

  let frameList;
  try {
    frameList = buildMotionFrameListContent(source.sourcePath, source.request.params.frameCount);
  } catch (error) {
    return motionFailure(error?.code ?? "MOTION_FRAME_LIST_WRITE_FAILED");
  }

  try {
    await writeFileImpl(frameListPath, frameList);
  } catch {
    return motionFailure("MOTION_FRAME_LIST_WRITE_FAILED");
  }

  let stage;
  try {
    stage = await runMotionStage(source.request, {
      frameListPath,
      outputPath,
      spawnImpl,
      readFileImpl,
      productionRunId,
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      ...(typeof probeTimeoutMs === "number" ? { probeTimeoutMs } : {}),
      ...(typeof now === "function" ? { now } : {}),
    });
  } catch {
    // The worker throws only for malformed requests/executor wiring, never for
    // honest media failures (those are returned). Fail closed either way.
    return motionFailure("MOTION_EXECUTOR_INVALID");
  }

  return Object.freeze({
    success: stage.success === true,
    failureCode: stage.success === true ? null : stage.failureCode ?? "MOTION_CALL_FAILED",
    quotaState: "OK",
    mediaStatus: stage.mediaStatus,
    generationMode: stage.generationMode,
    descriptor: stage.descriptor ?? null,
    outcome: stage.outcome ?? null,
    inspection: stage.inspection ?? null,
    outputPath: stage.success === true ? outputPath : null,
  });
}
