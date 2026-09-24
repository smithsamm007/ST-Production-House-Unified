/**
 * ST Production House — FFprobe media inspection runner (Issue #170).
 *
 * Media-layer priority (production-completion plan §11 item 7, §17): the
 * artifact-descriptor contract (S-M30-01) promotes a descriptor to VERIFIED
 * only when a real inspection result matches the artifact's content hash —
 * but until now NO component actually ran ffprobe. This module is the
 * executor boundary a real assembly worker calls:
 *
 *   descriptor (UNVERIFIED)
 *     └── inspectAndVerifyArtifact()
 *           ├── hashArtifactFile()      — SHA-256 over the REAL file bytes
 *           ├── runFfprobe()            — ffprobe via ARRAY ARGS, no shell
 *           └── verifyArtifactDescriptor() — existing S-M30-01 promotion
 *
 * Honesty contract (AGENTS.md Rules 1–3):
 *   - Hashes are computed from the ACTUAL on-disk bytes. If the file on disk
 *     was substituted after generation, the computed hash no longer matches
 *     the descriptor's contentSha256, and the descriptor FAILS verification
 *     (INSPECTION_HASH_MISMATCH) — real tamper detection, not a claim.
 *   - A missing/unreadable file, an absent ffprobe binary, a timeout, or a
 *     non-zero exit each produce a TRUTHFUL failure record. Nothing is ever
 *     fabricated: with ffprobe absent the descriptor stays UNVERIFIED.
 *   - Spawn uses array arguments ONLY (CONVENTIONS Rule 2: never a shell
 *     string). Paths are validated (no NUL, no leading dash, no `..`
 *     traversal segments, bounded length) before any execution input is
 *     derived. Paths are never interpolated into a command line.
 *   - Transports (`readFileImpl`, `spawnImpl`) are injectable so tests prove
 *     the contract offline; production supplies node:fs/promises and
 *     node:child_process spawn. The runner itself adds no I/O dependencies.
 *   - No new status states (R5): outcomes reuse the S-M30-01 verification
 *     enum plus this slice's stable error codes. No secrets (Rule 17); the
 *     module never reads environment or credential material.
 */

import { createHash } from "node:crypto";
import { verifyArtifactDescriptor } from "./artifactDescriptor.js";

export const INSPECTION_RUNNER_VERSION = "media_inspection_runner_v1";

/** Stable error codes (fail-closed). */
export const MEDIA_INSPECTION_ERROR_CODES = Object.freeze([
  "PATH_UNSAFE",
  "INSPECTION_SOURCE_UNREADABLE",
  "FFPROBE_SPAWN_FAILED",
  "FFPROBE_TIMEOUT",
  "FFPROBE_EXIT_NONZERO",
  "FFPROBE_OUTPUT_UNPARSEABLE",
  "FFPROBE_PAYLOAD_EMPTY",
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Validate an artifact path BEFORE any execution input is derived from it.
 * Pure; throws PATH_UNSAFE on any hostile shape. This is not a filesystem
 * check — it is a shape check (existence is the caller's transport's job).
 */
export function validateArtifactPath(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw fail("PATH_UNSAFE");
  }
  if (path.length > MAX_PATH_LENGTH) {
    throw fail("PATH_UNSAFE");
  }
  if (path.includes("\0")) {
    throw fail("PATH_UNSAFE");
  }
  // A leading dash would be parsed by ffprobe as an option, not a file.
  if (path.startsWith("-")) {
    throw fail("PATH_UNSAFE");
  }
  // Traversal segments are rejected outright: assembly inputs must be
  // explicit artifact references, not relative escapes.
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw fail("PATH_UNSAFE");
  }
  return path;
}

/**
 * Pure: build the ffprobe argument array (CONVENTIONS Rule 2 — array args
 * ONLY, never a shell string). Stable order; the path is the LAST argument.
 */
export function buildFfprobeArgs(artifactPath) {
  validateArtifactPath(artifactPath);
  return Object.freeze([
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    artifactPath,
  ]);
}

/**
 * Compute the SHA-256 of the REAL file bytes.
 *
 *   readFileImpl: async (path) => Buffer — injectable for tests; production
 *                 supplies a chunked reader from node:fs/promises.
 *
 * Unreadable source → INSPECTION_SOURCE_UNREADABLE (truthful: nothing was
 * hashed, nothing will be verified).
 */
export async function hashArtifactFile(path, { readFileImpl } = {}) {
  validateArtifactPath(path);
  if (typeof readFileImpl !== "function") {
    throw fail("INSPECTION_SOURCE_UNREADABLE");
  }
  let content;
  try {
    content = await readFileImpl(path);
  } catch {
    throw fail("INSPECTION_SOURCE_UNREADABLE");
  }
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw fail("INSPECTION_SOURCE_UNREADABLE");
  }
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Run ffprobe on one artifact file.
 *
 *   spawnImpl: ({ args, timeoutMs }) => Promise<{
 *     exitCode: number, stdout: string, stderr: string, timedOut?: boolean
 *   }> — injectable for tests; production wraps node:child_process spawn
 *   with array args and NO shell.
 *
 * Every failure mode maps to its stable code; an unparseable or empty
 * payload is honestly rejected (never "probably fine").
 */
export async function runFfprobe(path, { spawnImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  validateArtifactPath(path);
  if (typeof spawnImpl !== "function") {
    throw fail("FFPROBE_SPAWN_FAILED");
  }
  const args = buildFfprobeArgs(path);

  let result;
  try {
    result = await spawnImpl({ args, timeoutMs });
  } catch {
    throw fail("FFPROBE_SPAWN_FAILED");
  }
  if (!result || typeof result !== "object") {
    throw fail("FFPROBE_SPAWN_FAILED");
  }
  if (result.timedOut === true) {
    throw fail("FFPROBE_TIMEOUT");
  }
  if (typeof result.exitCode !== "number") {
    throw fail("FFPROBE_SPAWN_FAILED");
  }
  if (result.exitCode !== 0) {
    throw fail("FFPROBE_EXIT_NONZERO");
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (stdout.length > MAX_STDOUT_BYTES) {
    throw fail("FFPROBE_OUTPUT_UNPARSEABLE");
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw fail("FFPROBE_OUTPUT_UNPARSEABLE");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("FFPROBE_OUTPUT_UNPARSEABLE");
  }
  const hasFormat = payload.format && typeof payload.format === "object" &&
    !Array.isArray(payload.format) && Object.keys(payload.format).length > 0;
  const hasStreams = Array.isArray(payload.streams) && payload.streams.length > 0;
  if (!hasFormat && !hasStreams) {
    throw fail("FFPROBE_PAYLOAD_EMPTY");
  }
  return Object.freeze(payload);
}

/**
 * Inspect one media file end to end and return the inspection record in the
 * exact shape `verifyArtifactDescriptor` (S-M30-01) consumes:
 *
 *   { tool, success, contentSha256, format, streams, inspectedAt }
 *
 * contentSha256 is computed from the REAL file bytes — binding the inspection
 * to actual content so substitution on disk is detected as tampering by the
 * existing descriptor hash check. `inspectedAt` is injected (never a clock
 * read inside identity-affecting logic; identity uses the content hash).
 *
 * On any failure the record is TRUTHFULLY unsuccessful with the stable
 * reasonCode — never a fabricated success.
 */
export async function inspectMediaFile(path, {
  readFileImpl,
  spawnImpl,
  timeoutMs,
  now = () => new Date(),
  tool = "ffprobe",
} = {}) {
  validateArtifactPath(path);
  if (!["ffprobe", "equivalent"].includes(tool)) {
    throw fail("FFPROBE_SPAWN_FAILED");
  }

  const base = {
    tool,
    success: false,
    contentSha256: null,
    format: null,
    streams: null,
    inspectedAt: now().toISOString(),
    reasonCode: null,
  };

  let contentSha256;
  try {
    contentSha256 = await hashArtifactFile(path, { readFileImpl });
  } catch (err) {
    return Object.freeze({ ...base, reasonCode: err.code ?? "INSPECTION_SOURCE_UNREADABLE" });
  }

  try {
    const payload = await runFfprobe(path, { spawnImpl, timeoutMs });
    return Object.freeze({
      ...base,
      success: true,
      contentSha256,
      format: payload.format ?? null,
      streams: payload.streams ?? null,
      reasonCode: null,
    });
  } catch (err) {
    return Object.freeze({
      ...base,
      contentSha256,
      reasonCode: err.code ?? "FFPROBE_SPAWN_FAILED",
    });
  }
}

/**
 * Inspect AND verify in one call:
 *
 *   1. inspectMediaFile()  — real hash + real ffprobe (injectable transports)
 *   2. verifyArtifactDescriptor() — the existing S-M30-01 promotion, which
 *      FAILS CLOSED on hash mismatch (substituted file), unparseable output,
 *      empty payload, or any unsuccessful inspection.
 *
 * Returns { descriptor, inspection }. With ffprobe absent (or any failure)
 * the descriptor stays UNVERIFIED with the truthful reasonCode — the honest
 * state this repository already serializes as ffprobe_verified:false.
 */
export async function inspectAndVerifyArtifact(descriptor, path, options = {}) {
  if (!descriptor || typeof descriptor !== "object") {
    throw fail("ARTIFACT_DESCRIPTOR_INVALID");
  }
  const inspection = await inspectMediaFile(path, options);
  const verified = verifyArtifactDescriptor(descriptor, inspection);
  return Object.freeze({ descriptor: verified, inspection });
}
