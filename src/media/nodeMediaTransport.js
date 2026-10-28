/**
 * ST Production House — production media transport (node:child_process +
 * node:fs/promises).
 *
 * WHY THIS MODULE EXISTS (Phase-1 blocker, honestly recorded):
 *   The media executors (S-M32-01 TTS, S-M34-01 visual, S-M33-01 FFmpeg
 *   assembly, #170 media inspection) all require an injected `spawnImpl` and
 *   `readFileImpl`, documented as "production supplies node:child_process
 *   spawn (array args, shell:false) and node:fs/promises". Until this module
 *   existed, NO component in `src/` supplied them: the sole `child_process`
 *   import in the tree was the repo linter's `spawnSync`. A worker started
 *   with `STPH_ENABLE_WORKERS=1 STPH_ENABLE_REAL_MEDIA=1` therefore reached
 *   every real stage with `spawnImpl === undefined` and failed closed with
 *   `<STAGE>_SPAWN_FAILED` — the real media chain was unreachable by
 *   construction. This module is that missing boundary, nothing more.
 *
 * Contract (CONVENTIONS Rule 2, AGENTS.md Rules 1–3):
 *   - Binary and arguments are passed as an ARGUMENT ARRAY with
 *     `shell: false`. There is no shell string anywhere, and the command
 *     name is shape-validated (no whitespace, no shell metacharacters, no
 *     leading dash) before spawn is ever called. Arguments are never
 *     interpolated; a hostile argument stays a literal argument.
 *   - Stdout/stderr capture is bounded (`maxStreamBytes`); the readers throw
 *     once the bound is exceeded rather than growing without limit. Nothing
 *     is silently truncated into a claim: an oversized capture is an error.
 *   - Timeouts really kill the process (`SIGKILL` after `killGraceMs`) and
 *     report `timedOut: true` so callers can map their own TIMEOUT code.
 *   - A spawn failure (e.g. ENOENT because the binary is absent) resolves
 *     with `exitCode: null` + `spawnErrorCode`, which the executors already
 *     translate into their truthful `*_SPAWN_FAILED` / `PROVIDER_UNAVAILABLE`
 *     codes. This module never invents a success, never retries, and never
 *     fabricates output bytes.
 *   - `readFileImpl` returns the REAL bytes for descriptor hashing; an
 *     unreadable path throws so the inspection layer keeps the descriptor
 *     UNVERIFIED. Files above `maxFileBytes` are rejected instead of being
 *     hashed partially.
 *   - `writeFileImpl` writes ONE bounded text/binary operational input (the
 *     motion stage's concat frame list, Issue #241). It is not a media
 *     output path: executors render their own bytes with ffmpeg.
 *   - Injectable (`spawnImpl`, `readFileImpl`, `statImpl`) so tests prove the
 *     contract offline, and no secrets are read (Rule 17).
 *
 * Call-site shapes (all satisfied by the single `spawnImpl` below):
 *   - `runFfmpeg`            → { command: "ffmpeg",   args, timeoutMs }
 *   - `runTtsProvider`       → { command, args, timeoutMs, stdin }
 *   - `runVisualProvider`    → { command, args, timeoutMs, stdin }
 *   - `runFfprobe` (#170)    → { args, timeoutMs }        (no command → ffprobe)
 */

import { spawn as nodeSpawn } from "node:child_process";
import {
  readFile as nodeReadFile,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";

export const NODE_MEDIA_TRANSPORT_VERSION = "node_media_transport_v1";

/** Stable error codes (fail-closed; these are wiring errors, not media failures). */
export const NODE_MEDIA_TRANSPORT_ERROR_CODES = Object.freeze([
  "TRANSPORT_COMMAND_INVALID",
  "TRANSPORT_ARGS_INVALID",
  "TRANSPORT_CONTENT_INVALID",
  "TRANSPORT_STDIN_INVALID",
  "TRANSPORT_TIMEOUT_INVALID",
  "TRANSPORT_PATH_INVALID",
  "TRANSPORT_OUTPUT_LIMIT_EXCEEDED",
  "TRANSPORT_FILE_LIMIT_EXCEEDED",
  "TRANSPORT_CHILD_INVALID",
]);

/**
 * Executable names (optionally with directory segments) accepted for spawn:
 * letters, digits, dot, underscore, dash, forward slash. No whitespace, no
 * quotes, no shell metacharacters, never a leading dash (which a tool would
 * parse as an option).
 */
const COMMAND_RE = /^(?!-)\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** ffprobe is the default command: the #170 inspection runner passes args only. */
const DEFAULT_COMMAND = "ffprobe";

const DEFAULT_STREAM_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_FILE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

function transportError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireValidCommand(command) {
  if (typeof command !== "string" || command.length === 0 || command.length > 512) {
    throw transportError("TRANSPORT_COMMAND_INVALID");
  }
  if (!COMMAND_RE.test(command)) {
    throw transportError("TRANSPORT_COMMAND_INVALID");
  }
  return command;
}

function requireValidArgs(args) {
  if (!Array.isArray(args)) throw transportError("TRANSPORT_ARGS_INVALID");
  for (const arg of args) {
    if (typeof arg !== "string") throw transportError("TRANSPORT_ARGS_INVALID");
    // NUL can never appear in an argv entry.
    if (arg.includes("\0")) throw transportError("TRANSPORT_ARGS_INVALID");
  }
  return args;
}

function requireValidStdin(stdin) {
  if (stdin === null || stdin === undefined) return null;
  if (typeof stdin === "string") return stdin;
  if (Buffer.isBuffer(stdin) || stdin instanceof Uint8Array) return stdin;
  throw transportError("TRANSPORT_STDIN_INVALID");
}

function requireValidTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw transportError("TRANSPORT_TIMEOUT_INVALID");
  }
  return timeoutMs;
}

function requireValidPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    throw transportError("TRANSPORT_PATH_INVALID");
  }
  if (path.includes("\0")) throw transportError("TRANSPORT_PATH_INVALID");
  return path;
}

/**
 * Build a spawn implementation that runs ONE real subprocess.
 *
 *   spawnImpl: ({ command?, args, timeoutMs?, stdin? }) => Promise<{
 *     exitCode: number | null,
 *     stdout: string,
 *     stderr: string,
 *     timedOut: boolean,
 *     spawnErrorCode?: string    — present only when the process never ran
 *   }>
 *
 * Never rejects for media/tooling failures (they are reported in the record);
 * throws only on invalid request shapes, which are programming errors.
 */
export function createSpawnImpl({
  spawnImpl = nodeSpawn,
  maxStreamBytes = DEFAULT_STREAM_LIMIT_BYTES,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  if (typeof spawnImpl !== "function") throw transportError("TRANSPORT_CHILD_INVALID");
  if (!Number.isFinite(maxStreamBytes) || maxStreamBytes <= 0) throw transportError("TRANSPORT_OUTPUT_LIMIT_EXCEEDED");
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) throw transportError("TRANSPORT_CHILD_INVALID");

  return async function captureProcess({ command = DEFAULT_COMMAND, args, timeoutMs = DEFAULT_TIMEOUT_MS, stdin = null } = {}) {
    const executable = requireValidCommand(command);
    const argv = requireValidArgs(args);
    const input = requireValidStdin(stdin);
    const bound = requireValidTimeout(timeoutMs);

    const child = spawnImpl(executable, [...argv], {
      // Array args + no shell: CONVENTIONS Rule 2. Nothing below is ever
      // passed through a command interpreter.
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return await new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks = [];
      const stderrChunks = [];
      let timer = null;
      let killTimer = null;

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        if (killTimer !== null) clearTimeout(killTimer);
      };

      if (!child || typeof child.on !== "function") {
        cleanup();
        reject(transportError("TRANSPORT_CHILD_INVALID"));
        return;
      }

      const finish = (record) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(record);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const collect = (chunk, chunks, streamName) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (streamName === "stdout") {
          stdoutBytes += buf.length;
          if (stdoutBytes > maxStreamBytes) {
            child.kill?.("SIGKILL");
            fail(transportError("TRANSPORT_OUTPUT_LIMIT_EXCEEDED"));
            return;
          }
        } else {
          stderrBytes += buf.length;
          if (stderrBytes > maxStreamBytes) {
            child.kill?.("SIGKILL");
            fail(transportError("TRANSPORT_OUTPUT_LIMIT_EXCEEDED"));
            return;
          }
        }
        chunks.push(buf);
      };

      child.on("error", (error) => {
        // The process never started (typically ENOENT: binary absent). This is
        // a truthful failure record, not an exception.
        finish({
          exitCode: null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut: false,
          spawnErrorCode: typeof error?.code === "string" ? error.code : "SPAWN_ERROR",
        });
      });

      if (child.stdout && typeof child.stdout.on === "function") {
        child.stdout.on("data", (chunk) => collect(chunk, stdoutChunks, "stdout"));
      }
      if (child.stderr && typeof child.stderr.on === "function") {
        child.stderr.on("data", (chunk) => collect(chunk, stderrChunks, "stderr"));
      }

      // Bounded wall-clock: kill the real process, then report timedOut.
      timer = setTimeout(() => {
        timedOut = true;
        child.kill?.("SIGKILL");
        killTimer = setTimeout(() => {
          child.kill?.("SIGKILL");
        }, killGraceMs);
        killTimer.unref?.();
      }, bound);
      timer.unref?.();

      // Close stdin deterministically: text consumers (piper) see EOF, and
      // tools that ignore stdin never block on it.
      if (child.stdin && typeof child.stdin.end === "function") {
        child.stdin.on?.("error", () => {});
        try {
          if (input !== null) child.stdin.write(input);
          child.stdin.end();
        } catch {
          // A closed stdin is not a media failure; the process exit decides.
        }
      }

      child.on("close", (code, signal) => {
        finish({
          exitCode: typeof code === "number" ? code : null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut: timedOut || (signal !== null && signal !== undefined && timedOut),
        });
      });
    });
  };
}

/**
 * Build the real-bytes reader used for descriptor hashing (#170).
 *
 *   readFileImpl: async (path) => Buffer
 *
 * Throws on unreadable paths (the caller reports INSPECTION_SOURCE_UNREADABLE)
 * and rejects files above `maxFileBytes` instead of hashing a partial read.
 */
export function createReadFileImpl({
  readFileImpl = nodeReadFile,
  statImpl = nodeStat,
  maxFileBytes = DEFAULT_FILE_LIMIT_BYTES,
} = {}) {
  if (typeof readFileImpl !== "function") throw transportError("TRANSPORT_PATH_INVALID");
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) throw transportError("TRANSPORT_FILE_LIMIT_EXCEEDED");

  return async function readArtifactBytes(path) {
    const target = requireValidPath(path);

    if (typeof statImpl === "function") {
      let info = null;
      try {
        info = await statImpl(target);
      } catch {
        // Missing/unreadable file: fall through to the read, which throws.
        info = null;
      }
      if (info && typeof info.size === "number" && info.size > maxFileBytes) {
        throw transportError("TRANSPORT_FILE_LIMIT_EXCEEDED");
      }
    }

    const content = await readFileImpl(target);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (buffer.length > maxFileBytes) throw transportError("TRANSPORT_FILE_LIMIT_EXCEEDED");
    return buffer;
  };
}

/**
 * Build the bounded file writer used for ONE operational input (the motion
 * stage's concat frame list, Issue #241).
 *
 *   writeFileImpl: async (path, content) => void
 *
 * Path and content are shape-validated before any write; content above
 * `maxFileBytes` is refused rather than truncated. Writes are injectable so
 * tests prove the motion binding offline.
 */
export function createWriteFileImpl({
  writeFileImpl = nodeWriteFile,
  maxFileBytes = DEFAULT_FILE_LIMIT_BYTES,
} = {}) {
  if (typeof writeFileImpl !== "function") throw transportError("TRANSPORT_PATH_INVALID");
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) throw transportError("TRANSPORT_FILE_LIMIT_EXCEEDED");

  return async function writeOperationalFile(path, content) {
    const target = requireValidPath(path);
    if (typeof content !== "string" && !Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
      throw transportError("TRANSPORT_CONTENT_INVALID");
    }
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (buffer.length === 0 || buffer.length > maxFileBytes) {
      throw transportError("TRANSPORT_CONTENT_INVALID");
    }
    await writeFileImpl(target, buffer);
  };
}

/**
 * The one composition production wiring binds: the executor transports plus
 * the bounded operational-file writer.
 * Frozen so a worker cannot mutate another stage's transport.
 */
export function createNodeMediaTransports(options = {}) {
  return Object.freeze({
    transportVersion: NODE_MEDIA_TRANSPORT_VERSION,
    spawnImpl: createSpawnImpl(options),
    readFileImpl: createReadFileImpl(options),
    writeFileImpl: createWriteFileImpl(options),
  });
}
