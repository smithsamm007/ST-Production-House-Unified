/**
 * Node media transport tests (Phase-1 blocker fix).
 *
 * Evidence scope (AGENTS.md Rule 1): every case below runs against the REAL
 * subprocess machinery — `process.execPath` (this Node binary) is spawned
 * through the transport, so exit codes, stdin delivery, stdout/stderr
 * capture, timeouts, missing-binary handling, and shell non-interpretation
 * are observed rather than asserted about a mock. Only the failure-shape
 * edge cases (child 'error' event, stream caps) use an injected spawn.
 *
 * No provider is contacted, nothing is uploaded, no secret is read, and no
 * media file is fabricated: `readFileImpl` is exercised against temporary
 * files this test writes and removes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NODE_MEDIA_TRANSPORT_ERROR_CODES,
  NODE_MEDIA_TRANSPORT_VERSION,
  createNodeMediaTransports,
  createReadFileImpl,
  createSpawnImpl,
} from "../src/media/nodeMediaTransport.js";

const NODE = process.execPath;

/** Real process: echo whatever arrives on stdin back to stdout. */
const ECHO_STDIN_SCRIPT = "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{process.stdout.write(d)})";

// ---------------------------------------------------------------------------
// Real subprocess behavior
// ---------------------------------------------------------------------------

test("transport executes a real process and returns its exit code and stdout", async () => {
  const spawnImpl = createSpawnImpl();
  const result = await spawnImpl({
    command: NODE,
    args: ["-e", "process.stdout.write('transport-ok')"],
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "transport-ok");
  assert.equal(result.stderr, "");
  assert.equal(result.timedOut, false);
});

test("transport delivers stdin text to the real process (piper narration path)", async () => {
  const spawnImpl = createSpawnImpl();
  const narration = "नमस्ते — narration text via stdin, never argv";
  const result = await spawnImpl({
    command: NODE,
    args: ["-e", ECHO_STDIN_SCRIPT],
    stdin: narration,
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, narration);
});

test("transport passes hostile arguments literally: array args run with no shell", async () => {
  const spawnImpl = createSpawnImpl();
  const hostile = ["a;b", "$(whoami)", "x && rm -rf /tmp/stph-nope", "`id`", "|tee"];
  const result = await spawnImpl({
    command: NODE,
    args: ["-e", "process.stdout.write(process.argv.slice(1).join('|'))", ...hostile],
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(
    result.stdout,
    hostile.join("|"),
    "arguments must reach the process verbatim; a shell would have interpreted them"
  );
});

test("transport reports a real non-zero exit code without throwing", async () => {
  const spawnImpl = createSpawnImpl();
  const result = await spawnImpl({
    command: NODE,
    args: ["-e", "process.stderr.write('tool-failed');process.exit(3)"],
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, "tool-failed");
  assert.equal(result.timedOut, false);
});

test("transport kills a hung process and reports timedOut", async () => {
  const spawnImpl = createSpawnImpl({ killGraceMs: 100 });
  const started = Date.now();
  const result = await spawnImpl({
    command: NODE,
    args: ["-e", "setTimeout(()=>{},60000)"],
    timeoutMs: 400,
  });
  assert.equal(result.timedOut, true, "a hung tool must be reported as a timeout");
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 15_000, "the process must be killed, not awaited");
});

test("transport reports a missing binary truthfully instead of fabricating output", async () => {
  const spawnImpl = createSpawnImpl();
  const result = await spawnImpl({
    command: "stph-binary-that-does-not-exist",
    args: ["-version"],
    timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnErrorCode, "ENOENT");
  assert.equal(result.stdout, "");
});

// ---------------------------------------------------------------------------
// Fail-closed request validation (never reach spawn)
// ---------------------------------------------------------------------------

test("transport rejects command names that could smuggle a shell", async () => {
  const spawnImpl = createSpawnImpl();
  for (const command of ["ffmpeg; rm -rf /", "ffmpeg && curl x", "-rf", "ffmpeg --x", "ffmpeg\n", "", " ", "a`b`"]) {
    await assert.rejects(
      () => spawnImpl({ command, args: [] }),
      (error) => error.code === "TRANSPORT_COMMAND_INVALID",
      `command ${JSON.stringify(command)} must be rejected`
    );
  }
});

test("transport rejects malformed argument arrays", async () => {
  const spawnImpl = createSpawnImpl();
  await assert.rejects(() => spawnImpl({ command: "ffmpeg", args: "not-an-array" }), (e) => e.code === "TRANSPORT_ARGS_INVALID");
  await assert.rejects(() => spawnImpl({ command: "ffmpeg", args: [42] }), (e) => e.code === "TRANSPORT_ARGS_INVALID");
  await assert.rejects(() => spawnImpl({ command: "ffmpeg", args: ["a\0b"] }), (e) => e.code === "TRANSPORT_ARGS_INVALID");
  await assert.rejects(() => spawnImpl({ command: "ffmpeg", args: [], stdin: { nope: true } }), (e) => e.code === "TRANSPORT_STDIN_INVALID");
  await assert.rejects(() => spawnImpl({ command: "ffmpeg", args: [], timeoutMs: 0 }), (e) => e.code === "TRANSPORT_TIMEOUT_INVALID");
});

test("transport defaults to ffprobe when no command is supplied (#170 runFfprobe contract)", async () => {
  // The inspection runner calls spawnImpl({ args, timeoutMs }) with no
  // command. With no ffprobe on PATH the honest result is ENOENT; with one
  // installed it is a real probe. Either way nothing is fabricated.
  const spawnImpl = createSpawnImpl();
  const result = await spawnImpl({ args: ["-version"], timeoutMs: 10_000 });
  if (result.spawnErrorCode === undefined) {
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /ffprobe version/);
  } else {
    assert.equal(result.spawnErrorCode, "ENOENT");
  }
});

// ---------------------------------------------------------------------------
// Injected child failure shapes
// ---------------------------------------------------------------------------

test("transport surfaces a child 'error' event as a truthful record", async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      const error = new Error("spawn nope EACCES");
      error.code = "EACCES";
      child.emit("error", error);
    });
    return child;
  };
  const result = await createSpawnImpl({ spawnImpl: fakeSpawn })({ command: "ffmpeg", args: [], timeoutMs: 5_000 });
  assert.equal(result.exitCode, null);
  assert.equal(result.spawnErrorCode, "EACCES");
  assert.equal(result.timedOut, false);
});

test("transport refuses unbounded capture instead of growing silently", async () => {
  const spawnImpl = createSpawnImpl({ maxStreamBytes: 16 });
  await assert.rejects(
    () => spawnImpl({ command: NODE, args: ["-e", "process.stdout.write('x'.repeat(5000))"], timeoutMs: 20_000 }),
    (error) => error.code === "TRANSPORT_OUTPUT_LIMIT_EXCEEDED"
  );
});

// ---------------------------------------------------------------------------
// readFileImpl: real bytes for descriptor hashing
// ---------------------------------------------------------------------------

test("readFileImpl returns the real bytes so hashes match the on-disk artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stph-transport-"));
  const filePath = path.join(dir, "artifact.bin");
  const payload = Buffer.from("real-artifact-bytes-for-descriptor-hash");
  await writeFile(filePath, payload);
  try {
    const readFileImpl = createReadFileImpl();
    const bytes = await readFileImpl(filePath);
    assert.equal(Buffer.isBuffer(bytes), true);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(payload).digest("hex"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileImpl throws for unreadable paths and oversized files", async () => {
  const readFileImpl = createReadFileImpl();
  await assert.rejects(
    () => readFileImpl(path.join(tmpdir(), "stph-transport-missing-artifact.bin")),
    (error) => error.code === "ENOENT"
  );
  await assert.rejects(() => readFileImpl(""), (error) => error.code === "TRANSPORT_PATH_INVALID");
  await assert.rejects(() => readFileImpl("a\0b"), (error) => error.code === "TRANSPORT_PATH_INVALID");

  const dir = await mkdtemp(path.join(tmpdir(), "stph-transport-cap-"));
  const filePath = path.join(dir, "big.bin");
  await writeFile(filePath, Buffer.alloc(4096, 7));
  try {
    const capped = createReadFileImpl({ maxFileBytes: 512 });
    await assert.rejects(() => capped(filePath), (error) => error.code === "TRANSPORT_FILE_LIMIT_EXCEEDED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test("createNodeMediaTransports binds both executor transports immutably", () => {
  const transports = createNodeMediaTransports();
  assert.equal(transports.transportVersion, NODE_MEDIA_TRANSPORT_VERSION);
  assert.equal(typeof transports.spawnImpl, "function");
  assert.equal(typeof transports.readFileImpl, "function");
  assert.equal(Object.isFrozen(transports), true);
  assert.ok(NODE_MEDIA_TRANSPORT_ERROR_CODES.includes("TRANSPORT_COMMAND_INVALID"));
});
