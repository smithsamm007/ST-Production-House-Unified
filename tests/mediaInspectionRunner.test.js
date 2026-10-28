/**
 * FFprobe media inspection runner tests (Issue #170).
 *
 * Honest-evidence scope (Rule 1): the transports (file reads, spawn) are
 * injected, so the suite proves the runner's CONTRACT offline — array-arg
 * construction, path safety, real hashing of supplied bytes, every failure
 * code, the tamper-detection path, and descriptor promotion. No ffprobe
 * binary, no real media, no network. Production binds the same contract to
 * node:fs + node:child_process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildFfprobeArgs,
  hashArtifactFile,
  inspectAndVerifyArtifact,
  inspectMediaFile,
  runFfprobe,
  validateArtifactPath,
  MEDIA_INSPECTION_ERROR_CODES,
} from "../src/media/mediaInspectionRunner.js";
import { createArtifactDescriptor } from "../src/media/artifactDescriptor.js";

const NOW = () => new Date("2026-09-24T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Helpers: a fake on-disk world (bytes keyed by path) + a fake ffprobe
// ---------------------------------------------------------------------------

const REAL_BYTES = Buffer.from("fake-mp4-bytes-for-contract-testing");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function makeDescriptor({ sha = sha256(REAL_BYTES), artifactType = "video", mimeType = "video/mp4" } = {}) {
  return createArtifactDescriptor({
    artifactType,
    mimeType,
    contentSha256: sha,
    sizeBytes: REAL_BYTES.length,
    storageUri: "st-artifacts://run-1/episode-1/main.mp4",
    producer: {
      agentId: "agent-01",
      runId: "run-1",
      stageId: "assembly",
      providerId: "local_deterministic_assembly",
      note: "Contract-test fixture — synthetic content, never presented as real media.",
    },
    createdAt: NOW().toISOString(),
  });
}

const GOOD_FFPROBE_PAYLOAD = Object.freeze({
  format: {
    filename: "main.mp4",
    duration: "2400.5",
    format_name: "mov,mp4,m4a,3gp,m4a,m4b",
    size: String(REAL_BYTES.length),
  },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
    { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
  ],
});

function makeSpawnImpl({ payload = GOOD_FFPROBE_PAYLOAD, exitCode = 0, timedOut = false, stdout } = {}) {
  return async ({ args }) => {
    if (timedOut) return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    return {
      exitCode,
      stdout: stdout ?? JSON.stringify(payload),
      stderr: exitCode === 0 ? "" : "mock error",
      timedOut: false,
    };
  };
}

const READS = {
  real: async (path) => {
    if (path === "st-artifacts://run-1/episode-1/main.mp4") return REAL_BYTES;
    if (path === "/media/substituted.mp4") return Buffer.from("ATTACKER-REPLACED-BYTES");
    throw new Error("ENOENT");
  },
};

// ---------------------------------------------------------------------------
// Arg construction + path safety (CONVENTIONS Rule 2)
// ---------------------------------------------------------------------------

test("args are a frozen array with the path LAST — never a shell string", () => {
  const args = buildFfprobeArgs("/media/a/main.mp4");
  assert.ok(Array.isArray(args));
  assert.ok(Object.isFrozen(args));
  assert.equal(args[args.length - 1], "/media/a/main.mp4");
  assert.deepEqual(args.slice(0, -1), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]);
});

test("path validation rejects hostile shapes", () => {
  for (const hostile of [
    "",
    null,
    42,
    "-vf=payload",
    "/safe/../escape.mp4",
    "safe/../../up.mp4",
    "nul\0byte.mp4",
    "x".repeat(4097),
  ]) {
    assert.throws(() => validateArtifactPath(hostile), /PATH_UNSAFE/, JSON.stringify(String(hostile).slice(0, 20)));
  }
  assert.equal(validateArtifactPath("/ok/path.mp4"), "/ok/path.mp4");
  assert.equal(validateArtifactPath("relative/ok.mp4"), "relative/ok.mp4");
});

test("stable error codes are exported and closed", () => {
  assert.deepEqual([...MEDIA_INSPECTION_ERROR_CODES].sort(), [
    "FFPROBE_EXIT_NONZERO",
    "FFPROBE_OUTPUT_UNPARSEABLE",
    "FFPROBE_PAYLOAD_EMPTY",
    "FFPROBE_SPAWN_FAILED",
    "FFPROBE_TIMEOUT",
    "INSPECTION_SOURCE_UNREADABLE",
    "PATH_UNSAFE",
  ]);
});

// ---------------------------------------------------------------------------
// Real hashing (tamper binding)
// ---------------------------------------------------------------------------

test("hashArtifactFile hashes the REAL supplied bytes", async () => {
  const hash = await hashArtifactFile("st-artifacts://run-1/episode-1/main.mp4", { readFileImpl: READS.real });
  assert.equal(hash, sha256(REAL_BYTES));
  await assert.rejects(
    () => hashArtifactFile("/missing/file.mp4", { readFileImpl: READS.real }),
    /INSPECTION_SOURCE_UNREADABLE/,
  );
  await assert.rejects(() => hashArtifactFile("/missing/file.mp4"), /INSPECTION_SOURCE_UNREADABLE|PATH_UNSAFE/);
});

// ---------------------------------------------------------------------------
// runFfprobe failure matrix
// ---------------------------------------------------------------------------

test("runFfprobe returns the parsed ffprobe payload on success", async () => {
  const payload = await runFfprobe("/media/a/main.mp4", { spawnImpl: makeSpawnImpl() });
  assert.equal(payload.format.duration, "2400.5");
  assert.equal(payload.streams.length, 2);
});

test("runFfprobe failure matrix is honest", async () => {
  await assert.rejects(() => runFfprobe("/media/a.mp4", { spawnImpl: makeSpawnImpl({ timedOut: true }) }), /FFPROBE_TIMEOUT/);
  await assert.rejects(() => runFfprobe("/media/a.mp4", { spawnImpl: makeSpawnImpl({ exitCode: 1 }) }), /FFPROBE_EXIT_NONZERO/);
  await assert.rejects(() => runFfprobe("/media/a.mp4", { spawnImpl: makeSpawnImpl({ stdout: "not json" }) }), /FFPROBE_OUTPUT_UNPARSEABLE/);
  await assert.rejects(
    () => runFfprobe("/media/a.mp4", { spawnImpl: makeSpawnImpl({ stdout: JSON.stringify({ format: {}, streams: [] }) }) }),
    /FFPROBE_PAYLOAD_EMPTY/,
  );
  await assert.rejects(() => runFfprobe("/media/a.mp4", { spawnImpl: async () => { throw new Error("enoent"); } }), /FFPROBE_SPAWN_FAILED/);
  await assert.rejects(() => runFfprobe("/media/a.mp4", { spawnImpl: async () => null }), /FFPROBE_SPAWN_FAILED/);
  await assert.rejects(() => runFfprobe("/media/a.mp4", {}), /FFPROBE_SPAWN_FAILED/);
  await assert.rejects(() => runFfprobe("-danger", { spawnImpl: makeSpawnImpl() }), /PATH_UNSAFE/);
});

// ---------------------------------------------------------------------------
// inspectMediaFile: honest records in the S-M30-01 shape
// ---------------------------------------------------------------------------

test("inspectMediaFile succeeds with a real hash and payload", async () => {
  const inspection = await inspectMediaFile("st-artifacts://run-1/episode-1/main.mp4", {
    readFileImpl: READS.real,
    spawnImpl: makeSpawnImpl(),
    now: NOW,
  });
  assert.equal(inspection.tool, "ffprobe");
  assert.equal(inspection.success, true);
  assert.equal(inspection.contentSha256, sha256(REAL_BYTES));
  assert.equal(inspection.reasonCode, null);
  assert.equal(inspection.inspectedAt, "2026-09-24T12:00:00.000Z");
  assert.ok(inspection.format);
  assert.ok(inspection.streams.length === 2);
});

test("inspectMediaFile records truthful failures — including the absent-binary case", async () => {
  const unreadable = await inspectMediaFile("/missing.mp4", { readFileImpl: READS.real, spawnImpl: makeSpawnImpl(), now: NOW });
  assert.equal(unreadable.success, false);
  assert.equal(unreadable.reasonCode, "INSPECTION_SOURCE_UNREADABLE");
  assert.equal(unreadable.contentSha256, null);

  const noBinary = await inspectMediaFile("st-artifacts://run-1/episode-1/main.mp4", {
    readFileImpl: READS.real,
    spawnImpl: async () => { throw new Error("spawn ffprobe ENOENT"); },
    now: NOW,
  });
  assert.equal(noBinary.success, false);
  assert.equal(noBinary.reasonCode, "FFPROBE_SPAWN_FAILED", "ffprobe absent is a truthful state, never a fake success");
  assert.equal(noBinary.contentSha256, sha256(REAL_BYTES), "hash still binds the real bytes");
});

// ---------------------------------------------------------------------------
// inspectAndVerifyArtifact: promotion + TAMPER DETECTION
// ---------------------------------------------------------------------------

test("full promotion: matching real file + valid ffprobe → VERIFIED", async () => {
  const descriptor = makeDescriptor();
  assert.equal(descriptor.verification.state, "UNVERIFIED");

  const { descriptor: verified, inspection } = await inspectAndVerifyArtifact(descriptor, "st-artifacts://run-1/episode-1/main.mp4", {
    readFileImpl: READS.real,
    spawnImpl: makeSpawnImpl(),
    now: NOW,
  });
  assert.equal(verified.verification.state, "VERIFIED");
  assert.equal(verified.verification.inspectedBy, "ffprobe");
  assert.equal(inspection.success, true);
});

test("TAMPER DETECTION: a substituted on-disk file fails the descriptor hash check", async () => {
  const descriptor = makeDescriptor(); // bound to sha256(REAL_BYTES)
  const { descriptor: result, inspection } = await inspectAndVerifyArtifact(descriptor, "/media/substituted.mp4", {
    readFileImpl: READS.real,
    spawnImpl: makeSpawnImpl(), // ffprobe "succeeds" on the substituted file
    now: NOW,
  });
  assert.equal(inspection.success, true, "ffprobe ran on the substituted file");
  assert.equal(inspection.contentSha256, sha256(Buffer.from("ATTACKER-REPLACED-BYTES")));
  assert.equal(result.verification.state, "UNVERIFIED", "hash mismatch fails closed");
  assert.equal(result.verification.reasonCode, "INSPECTION_HASH_MISMATCH");
});

test("failed inspection never promotes — descriptor stays UNVERIFIED with the honest reason", async () => {
  const descriptor = makeDescriptor();
  const { descriptor: result, inspection } = await inspectAndVerifyArtifact(descriptor, "st-artifacts://run-1/episode-1/main.mp4", {
    readFileImpl: READS.real,
    spawnImpl: makeSpawnImpl({ exitCode: 1 }),
    now: NOW,
  });
  assert.equal(inspection.reasonCode, "FFPROBE_EXIT_NONZERO");
  assert.equal(result.verification.state, "UNVERIFIED");
  assert.equal(result.verification.reasonCode, "INSPECTION_NOT_SUCCESSFUL");
});

test("no transports → honest failure, never fabrication", async () => {
  const descriptor = makeDescriptor();
  const inspection = await inspectMediaFile("st-artifacts://run-1/episode-1/main.mp4", { now: NOW });
  assert.equal(inspection.success, false);
  assert.equal(inspection.reasonCode, "INSPECTION_SOURCE_UNREADABLE");
  const { descriptor: result } = await inspectAndVerifyArtifact(descriptor, "st-artifacts://run-1/episode-1/main.mp4", { now: NOW });
  assert.equal(result.verification.state, "UNVERIFIED");
});

test("invalid descriptor input fails closed", async () => {
  await assert.rejects(() => inspectAndVerifyArtifact(null, "/x.mp4", { now: NOW }), /ARTIFACT_DESCRIPTOR_INVALID/);
  await assert.rejects(() => inspectAndVerifyArtifact("nope", "/x.mp4", { now: NOW }), /ARTIFACT_DESCRIPTOR_INVALID/);
});
