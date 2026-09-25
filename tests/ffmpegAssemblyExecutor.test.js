/**
 * FFmpeg assembly executor tests (Issue #174).
 *
 * Honest-evidence scope (Rule 1): transports (spawn, file reads) are
 * injected, so the suite proves the executor's CONTRACT offline — plan
 * integrity gating, descriptor-bound input resolution, array-arg command
 * construction, every failure code, the full QC duration policy matrix, and
 * the end-to-end honest-success path. No ffmpeg binary, no real media, no
 * network. Production binds the same contract to node:child_process +
 * node:fs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  MAIN_VIDEO_MAX_SECONDS,
  MAIN_VIDEO_MIN_SECONDS,
  canonicalSerializeAssemblyPlan,
  createAssemblyPlan,
  detectAssemblyPlanTampering,
} from "../src/media/assemblyPlan.js";
import { createArtifactDescriptor } from "../src/media/artifactDescriptor.js";
import {
  FFMPEG_EXECUTOR_ERROR_CODES,
  SHORT_FORM_MAX_SECONDS,
  SHORT_FORM_MIN_SECONDS,
  buildFfmpegArgs,
  buildRenderPlan,
  evaluateShortFormDurationGate,
  executeAssemblyPlan,
  resolvePlanInputs,
  runFfmpeg,
  validateOutputPath,
  verifyFfmpegAvailable,
} from "../src/media/ffmpegAssemblyExecutor.js";

const NOW = () => new Date("2026-09-24T15:00:00.000Z");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures: refs, bytes, descriptors, plans
// ---------------------------------------------------------------------------

const SEG1_BYTES = Buffer.from("segment-one-visual-bytes");
const SEG2_BYTES = Buffer.from("segment-two-visual-bytes");
const BGMBYTES = Buffer.from("bgm-audio-bytes");
const SUBTITLE_BYTES = Buffer.from("1\n00:00:00,000 --> 00:00:05,000\nhello\n");
const OUTPUT_BYTES = Buffer.from("rendered-mp4-bytes");

const REF_SEG1 = `sha256:${sha256("seg1")}`;
const REF_SEG2 = `sha256:${sha256("seg2")}`;
const REF_BGM = `sha256:${sha256("bgm")}`;
const REF_SUBS = `sha256:${sha256("subs")}`;

function makeDescriptor({ hash, artifactType, mimeType, durationSeconds = null } = {}) {
  return createArtifactDescriptor({
    artifactType,
    mimeType,
    contentSha256: hash,
    ...(durationSeconds !== null ? { durationSeconds } : {}),
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

function makeBindings() {
  return {
    [REF_SEG1]: { descriptor: makeDescriptor({ hash: sha256("seg1"), artifactType: "video", mimeType: "video/mp4", durationSeconds: 1800 }), path: "/media/seg1.mp4" },
    [REF_SEG2]: { descriptor: makeDescriptor({ hash: sha256("seg2"), artifactType: "image", mimeType: "image/png", durationSeconds: 30 }), path: "/media/seg2.png" },
    [REF_BGM]: { descriptor: makeDescriptor({ hash: sha256("bgm"), artifactType: "audio", mimeType: "audio/mpeg", durationSeconds: 1900 }), path: "/media/bgm.mp3" },
    [REF_SUBS]: { descriptor: makeDescriptor({ hash: sha256("subs"), artifactType: "subtitle", mimeType: "application/x-subrip" }), path: "/media/subs.srt" },
  };
}

function makePlan(overrides = {}) {
  return createAssemblyPlan({
    agentId: "agent-01",
    productionRunId: "run-1",
    outputTarget: "main_longform",
    aspectRatio: "16:9",
    segments: [
      { artifactRef: REF_SEG1, kind: "video_clip", durationSeconds: 1800, transitionIn: "cut" },
      { artifactRef: REF_SEG2, kind: "title_card", durationSeconds: 30, transitionIn: "fade" },
    ],
    audioMix: [{ artifactRef: REF_BGM, role: "bgm", gainDb: -6 }],
    note: "executor contract fixture",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fake world: paths → bytes (readFile), ffmpeg spawn, ffprobe spawn
// ---------------------------------------------------------------------------

function makeReadFileImpl({ outputBytes = OUTPUT_BYTES, outputPath = "/media/out/main.mp4" } = {}) {
  const files = new Map([
    ["/media/seg1.mp4", SEG1_BYTES],
    ["/media/seg2.png", SEG2_BYTES],
    ["/media/bgm.mp3", BGMBYTES],
    ["/media/subs.srt", SUBTITLE_BYTES],
  ]);
  if (outputBytes !== null) files.set(outputPath, outputBytes);
  return async (path) => {
    if (files.has(path)) return files.get(path);
    throw new Error("ENOENT");
  };
}

function makeFfmpegSpawnImpl({ exitCode = 0, timedOut = false } = {}) {
  return ({ command }) => {
    if (command !== "ffmpeg") throw new Error(`unexpected command ${command}`);
    if (timedOut) return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    if (exitCode !== 0) return { exitCode, stdout: "", stderr: "conversion failed", timedOut: false };
    return { exitCode: 0, stdout: "", stderr: "frame= 100 fps=25", timedOut: false };
  };
}

function makeFfprobePayload(durationSeconds) {
  return {
    format: {
      filename: "out.mp4",
      duration: String(durationSeconds),
      format_name: "mov,mp4,m4a,3gp,m4a,m4b",
      size: String(OUTPUT_BYTES.length),
    },
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
    ],
  };
}

/**
 * Combined spawnImpl dispatching on `command`: ffmpeg side executes the
 * render; ffprobe side answers `-version` (pre-flight) and probes the path
 * the args actually name (post-render QC). The inspection's hash comes from
 * the executor hashing the REAL injected bytes via readFileImpl.
 */
function makeSpawnImpl({ ffmpeg, probeDurationSeconds, ffprobeExitCode = 0, ffprobeTimedOut = false } = {}) {
  return ({ command, args }) => {
    if (command === "ffmpeg") {
      if (!ffmpeg) throw new Error("spawn ffmpeg ENOENT");
      return ffmpeg({ command, args });
    }
    if (command === "ffprobe") {
      if (args[0] === "-version") {
        return { exitCode: 0, stdout: "ffprobe version 7.0", stderr: "", timedOut: false };
      }
      if (ffprobeTimedOut) return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      if (ffprobeExitCode !== 0) return { exitCode: ffprobeExitCode, stdout: "", stderr: "probe failed", timedOut: false };
      return { exitCode: 0, stdout: JSON.stringify(makeFfprobePayload(probeDurationSeconds)), stderr: "", timedOut: false };
    }
    throw new Error(`unexpected command ${command}`);
  };
}

function makeExecutorOptions({
  outputPath = "/media/out/main.mp4",
  bindings = makeBindings(),
  spawn,
  outputBytes = OUTPUT_BYTES,
  skipPreflight = false,
} = {}) {
  return {
    artifactBindings: bindings,
    outputPath,
    spawnImpl: spawn,
    readFileImpl: makeReadFileImpl({ outputBytes, outputPath }),
    now: NOW,
    skipPreflight,
  };
}

// ---------------------------------------------------------------------------
// Path + args safety (CONVENTIONS Rule 2)
// ---------------------------------------------------------------------------

test("validateOutputPath rejects hostile shapes", () => {
  for (const hostile of ["", null, 42, "-vf=payload", "/safe/../escape.mp4", "nul\0byte.mp4", "x".repeat(4097)]) {
    assert.throws(() => validateOutputPath(hostile), /EXEC_OUTPUT_PATH_UNSAFE/, JSON.stringify(String(hostile).slice(0, 20)));
  }
  assert.equal(validateOutputPath("/media/out/main.mp4"), "/media/out/main.mp4");
});

test("args are a frozen array with the output path LAST — never a shell string", () => {
  const plan = makePlan();
  const resolved = resolvePlanInputs(plan, makeBindings());
  const { args } = buildRenderPlan(plan, resolved, "/media/out/main.mp4");
  assert.ok(Array.isArray(args));
  assert.ok(Object.isFrozen(args));
  assert.equal(args[args.length - 1], "/media/out/main.mp4");
  assert.ok(args.includes("-hide_banner") && args.includes("-nostdin"));
  // explicit codecs, never defaults
  assert.deepEqual(["-c:v", "libx264", "-pix_fmt", "yuv420p"].every((a) => args.includes(a)), true);
  assert.deepEqual(["-c:a", "aac"].every((a) => args.includes(a)), true);
  // argv values that are paths carry no shell metacharacters; the filtergraph
  // legitimately uses ffmpeg's own `;`/`,` separators — inert in array args.
  const pathArgs = args.filter((arg) => arg.startsWith("/"));
  assert.ok(pathArgs.length >= 4);
  assert.ok(!pathArgs.some((arg) => /[;&|`$\n]/.test(arg)), "path argv values are metachar-free");
  assert.ok(!args.some((arg) => arg.includes("\n")), "no multi-line argv values");
  // every input path appears exactly once after its own -i
  const inputPaths = args.filter((arg) => arg.startsWith("/media/") && arg !== "/media/out/main.mp4");
  assert.deepEqual(inputPaths.sort(), ["/media/bgm.mp3", "/media/seg1.mp4", "/media/seg2.png"].sort());
});

test("buildFfmpegArgs derives a deterministic filtergraph with aspect normalization, concat, gains", () => {
  const plan = makePlan();
  const resolved = resolvePlanInputs(plan, makeBindings());
  const a = buildRenderPlan(plan, resolved, "/media/out/main.mp4");
  const b = buildRenderPlan(plan, resolved, "/media/out/main.mp4");
  assert.deepEqual(a, b, "deterministic for identical plan + bindings");
  assert.match(a.filtergraph, /scale=1920:1080:force_original_aspect_ratio=decrease/);
  assert.match(a.filtergraph, /pad=1920:1080/);
  assert.match(a.filtergraph, /setsar=1/);
  assert.match(a.filtergraph, /concat=n=2:v=1:a=0/);
  assert.match(a.filtergraph, /volume=-6dB/);
  assert.ok(!a.filtergraph.includes("amix"), "single mix source maps directly, no amix");
  assert.equal(a.degradations.length, 0);
});

test("wipe transitions are rendered as fades WITH a labeled degradation (Rule 3)", () => {
  const plan = makePlan({
    segments: [{ artifactRef: REF_SEG1, kind: "video_clip", durationSeconds: 1800, transitionIn: "wipe" }],
    audioMix: [],
  });
  const resolved = resolvePlanInputs(plan, makeBindings());
  const { degradations } = buildRenderPlan(plan, resolved, "/media/out/main.mp4");
  assert.deepEqual([...degradations], ["wipe_rendered_as_fade:segment_0"]);
});

test("ducking without a voice source degrades to static gain — labeled, not silent", () => {
  const plan = makePlan({ audioMix: [{ artifactRef: REF_BGM, role: "bgm", gainDb: -3, ducking: true }] });
  const resolved = resolvePlanInputs(plan, makeBindings());
  const { degradations, filtergraph } = buildRenderPlan(plan, resolved, "/media/out/main.mp4");
  assert.ok(degradations.some((d) => d.startsWith("ducking_without_voice_source_static_gain")));
  assert.match(filtergraph, /volume=-3dB/);
  assert.doesNotMatch(filtergraph, /sidechaincompress/);
});

test("ducking with a voice track emits sidechaincompress against the voice source", () => {
  const refVoice = `sha256:${sha256("voice")}`;
  const bindings = makeBindings();
  bindings[refVoice] = { descriptor: makeDescriptor({ hash: sha256("voice"), artifactType: "audio", mimeType: "audio/mpeg", durationSeconds: 1800 }), path: "/media/voice.mp3" };
  const plan = makePlan({
    audioMix: [
      { artifactRef: refVoice, role: "voice", gainDb: 0 },
      { artifactRef: REF_BGM, role: "bgm", gainDb: -6, ducking: true },
    ],
  });
  const resolved = resolvePlanInputs(plan, bindings);
  const { filtergraph } = buildRenderPlan(plan, resolved, "/media/out/main.mp4");
  assert.match(filtergraph, /sidechaincompress/);
  assert.match(filtergraph, /amix=inputs=2:normalize=0/);
});

test("subtitle burning uses the subtitles filter only with video present", () => {
  const plan = makePlan({ subtitleTrack: { artifactRef: REF_SUBS, format: "srt" } });
  const resolved = resolvePlanInputs(plan, makeBindings());
  const { filtergraph } = buildRenderPlan(plan, resolved, "/media/out/main.mp4");
  assert.match(filtergraph, /subtitles=/);
  // audio-only plan: subtitle dropped with a labeled degradation
  const audioOnlyPlan = makePlan({
    segments: [{ artifactRef: REF_SEG1, kind: "voice", durationSeconds: 1800 }],
    audioMix: [],
    subtitleTrack: { artifactRef: REF_SUBS, format: "srt" },
  });
  const audioOnlyResolved = resolvePlanInputs(audioOnlyPlan, makeBindings());
  const audioOnly = buildRenderPlan(audioOnlyPlan, audioOnlyResolved, "/media/out/main.mp4");
  assert.ok(audioOnly.degradations.includes("subtitle_without_video_dropped"));
  assert.equal(audioOnly.filtergraph, null);
  assert.deepEqual(audioOnly.args.slice(audioOnly.args.indexOf("-vn"), audioOnly.args.indexOf("-vn") + 4), ["-vn", "-map", "[0:a]", "-c:a"]);
});

test("unknown output target fails closed even though the plan object predated the check", () => {
  const plan = JSON.parse(canonicalSerializeAssemblyPlan(makePlan()));
  plan.outputTarget = "hacked_target"; // post-validation mutation
  const resolved = resolvePlanInputs(plan, makeBindings());
  assert.throws(() => buildRenderPlan(plan, resolved, "/media/out/main.mp4"), /ASSEMBLY_PLAN_INVALID/);
});

test("buildFfmpegArgs is the argument-array-only view", () => {
  const plan = makePlan();
  const resolved = resolvePlanInputs(plan, makeBindings());
  assert.deepEqual(buildFfmpegArgs(plan, resolved, "/media/out/main.mp4"), buildRenderPlan(plan, resolved, "/media/out/main.mp4").args);
});

// ---------------------------------------------------------------------------
// Input resolution: artifactRefs resolve ONLY through descriptor bindings
// ---------------------------------------------------------------------------

test("unbound refs fail closed with EXEC_REF_UNBOUND", () => {
  const plan = makePlan();
  assert.throws(() => resolvePlanInputs(plan, {}), /EXEC_REF_UNBOUND/);
  assert.throws(() => resolvePlanInputs(plan, null), /EXEC_REF_UNBOUND/);
  const bindings = makeBindings();
  delete bindings[REF_BGM];
  assert.throws(() => resolvePlanInputs(plan, bindings), /EXEC_REF_UNBOUND/);
});

test("descriptor hash must equal the ref — mismatch fails closed", () => {
  const plan = makePlan();
  const bindings = makeBindings();
  bindings[REF_BGM] = { descriptor: makeDescriptor({ hash: sha256("OTHER"), artifactType: "audio", mimeType: "audio/mpeg" }), path: "/media/bgm.mp3" };
  assert.throws(() => resolvePlanInputs(plan, bindings), /EXEC_DESCRIPTOR_MISMATCH/);
});

test("hostile bound paths fail closed (traversal / leading dash / NUL)", () => {
  const plan = makePlan();
  for (const hostilePath of ["/media/../etc/passwd", "-guessing.mp4", "bad\0path.mp4"]) {
    const bindings = makeBindings();
    bindings[REF_SEG1] = { descriptor: bindings[REF_SEG1].descriptor, path: hostilePath };
    assert.throws(() => resolvePlanInputs(plan, bindings), /PATH_UNSAFE/);
  }
});

test("extra unused bindings are ignored — resolution is an allowlist, not a leak", () => {
  const plan = makePlan();
  const bindings = makeBindings();
  const extraRef = `sha256:${sha256("unused")}`;
  bindings[extraRef] = { descriptor: makeDescriptor({ hash: sha256("unused"), artifactType: "video", mimeType: "video/mp4" }), path: "/media/unused.mp4" };
  const resolved = resolvePlanInputs(plan, bindings);
  assert.equal(resolved.length, 3, "seg1 + seg2 + bgm only");
  assert.ok(!resolved.some((entry) => entry.ref === extraRef));
});

// ---------------------------------------------------------------------------
// runFfmpeg + environment pre-flight: honest failure matrix
// ---------------------------------------------------------------------------

test("runFfmpeg failure matrix is honest", async () => {
  await assert.rejects(() => runFfmpeg(["-version"], { spawnImpl: makeFfmpegSpawnImpl({ timedOut: true }) }), /FFMPEG_TIMEOUT/);
  const nonzero = await runFfmpeg(["-version"], { spawnImpl: makeFfmpegSpawnImpl({ exitCode: 1 }) }).then(
    () => assert.fail("expected rejection"),
    (err) => err,
  );
  assert.equal(nonzero.code, "FFMPEG_EXIT_NONZERO");
  assert.equal(nonzero.exitCode, 1);
  assert.match(nonzero.stderrTail, /conversion failed/);
  await assert.rejects(() => runFfmpeg(["-version"], { spawnImpl: async () => { throw new Error("spawn ffmpeg ENOENT"); } }), /FFMPEG_SPAWN_FAILED/);
  await assert.rejects(() => runFfmpeg(["-version"], {}), /FFMPEG_SPAWN_FAILED/);
});

test("environment pre-flight truthfully reports absent media tooling", async () => {
  await assert.rejects(() => verifyFfmpegAvailable({ spawnImpl: async () => { throw new Error("spawn ffprobe ENOENT"); } }), /FFPROBE_VERSION_SPAWN_FAILED/);
  await assert.rejects(() => verifyFfmpegAvailable({ spawnImpl: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }) }), /FFPROBE_VERSION_TIMEOUT/);
  await assert.rejects(() => verifyFfmpegAvailable({ spawnImpl: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }) }), /FFPROBE_VERSION_EXIT_NONZERO/);
  assert.equal(await verifyFfmpegAvailable({ spawnImpl: makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl() }) }), true);
});

// ---------------------------------------------------------------------------
// QC duration policy
// ---------------------------------------------------------------------------

function makeGateInspection({ duration, hash = sha256("seg1") } = {}) {
  return {
    tool: "ffprobe",
    success: true,
    contentSha256: hash,
    format: { duration: String(duration), format_name: "mov,mp4" },
    streams: [{ codec_type: "video", codec_name: "h264" }],
    inspectedAt: NOW().toISOString(),
    reasonCode: null,
  };
}

const MAIN_DESCRIPTOR = makeDescriptor({ hash: sha256("seg1"), artifactType: "video", mimeType: "video/mp4", durationSeconds: 45 });
const UNCLAIMED_DESCRIPTOR = makeDescriptor({ hash: sha256("seg1"), artifactType: "video", mimeType: "video/mp4" });

test("short-form gate: pass inside [3, 90], fail outside, conflict, missing duration", () => {
  assert.equal(evaluateShortFormDurationGate(UNCLAIMED_DESCRIPTOR, makeGateInspection({ duration: 45 })).passed, true);
  // claimed-vs-measured conflict (> 1 s) takes precedence over the range check
  const conflict = evaluateShortFormDurationGate(MAIN_DESCRIPTOR, makeGateInspection({ duration: 45.5 + 2 }));
  assert.equal(conflict.reasonCode, "QC_DURATION_CONFLICT");
  // with no claimed duration, the range check governs
  const under = evaluateShortFormDurationGate(UNCLAIMED_DESCRIPTOR, makeGateInspection({ duration: SHORT_FORM_MIN_SECONDS - 0.5 }));
  assert.equal(under.reasonCode, "QC_DURATION_OUT_OF_RANGE");
  const over = evaluateShortFormDurationGate(UNCLAIMED_DESCRIPTOR, makeGateInspection({ duration: SHORT_FORM_MAX_SECONDS + 1 }));
  assert.equal(over.reasonCode, "QC_DURATION_OUT_OF_RANGE");
  const missing = evaluateShortFormDurationGate(UNCLAIMED_DESCRIPTOR, {
    ...makeGateInspection({ duration: 45 }),
    format: { format_name: "mov" },
  });
  assert.equal(missing.reasonCode, "QC_INSPECTION_DURATION_MISSING");
  const unverified = evaluateShortFormDurationGate(UNCLAIMED_DESCRIPTOR, { ...makeGateInspection({ duration: 45 }), contentSha256: sha256("TAMPERED") });
  assert.equal(unverified.reasonCode, "QC_DESCRIPTOR_NOT_VERIFIED");
  assert.equal(unverified.inspectionReasonCode, "INSPECTION_HASH_MISMATCH");
});

test("main-video gate: the S-M33-01 window is enforced unchanged by the executor policy", () => {
  assert.equal(MAIN_VIDEO_MIN_SECONDS, 1800);
  assert.equal(MAIN_VIDEO_MAX_SECONDS, 3000);
});

test("error codes are exported and closed", () => {
  assert.deepEqual([...FFMPEG_EXECUTOR_ERROR_CODES].sort(), [
    "ASSEMBLY_ID_MISMATCH",
    "ASSEMBLY_PLAN_INVALID",
    "ASSEMBLY_PLAN_TYPE_MISMATCH",
    "EXEC_DESCRIPTOR_MISMATCH",
    "EXEC_OUTPUT_PATH_UNSAFE",
    "EXEC_REF_UNBOUND",
    "FFMPEG_EXIT_NONZERO",
    "FFMPEG_SPAWN_FAILED",
    "FFMPEG_TIMEOUT",
    "FFPROBE_VERSION_EXIT_NONZERO",
    "FFPROBE_VERSION_SPAWN_FAILED",
    "FFPROBE_VERSION_TIMEOUT",
    "QC_DESCRIPTOR_NOT_VERIFIED",
    "QC_DURATION_CONFLICT",
    "QC_DURATION_OUT_OF_RANGE",
    "QC_INSPECTION_DURATION_MISSING",
  ]);
});

// ---------------------------------------------------------------------------
// executeAssemblyPlan: end-to-end honesty
// ---------------------------------------------------------------------------

test("plan integrity gates: tampered or mistyped plans NEVER execute", async () => {
  const plan = makePlan();
  const tampered = JSON.parse(canonicalSerializeAssemblyPlan(plan));
  tampered.segments[0].durationSeconds = 1;
  const verdict = detectAssemblyPlanTampering(plan, tampered);
  assert.equal(verdict.tampered, true);

  const result = await executeAssemblyPlan(tampered, makeExecutorOptions({ spawn: makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl() }) }));
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "ASSEMBLY_ID_MISMATCH");
  assert.equal(result.executed, false);
  assert.equal(result.command, null, "no argv is ever derived from a tampered plan");

  const wrongType = { ...JSON.parse(canonicalSerializeAssemblyPlan(plan)), planType: "other_plan_v1" };
  const wrongTypeResult = await executeAssemblyPlan(wrongType, makeExecutorOptions({ spawn: makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl() }) }));
  assert.equal(wrongTypeResult.failureCode, "ASSEMBLY_PLAN_TYPE_MISMATCH");
});

test("unbound refs never reach the spawn boundary", async () => {
  const plan = makePlan();
  const opts = makeExecutorOptions({ spawn: makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl() }) });
  opts.artifactBindings = {};
  const result = await executeAssemblyPlan(plan, opts);
  assert.equal(result.failureCode, "EXEC_REF_UNBOUND");
  assert.equal(result.executed, false);
});

test("absent ffmpeg binary is a truthful failure — never a fabricated success", async () => {
  const plan = makePlan();
  // both binaries absent: the whole transport throws ENOENT (sandbox truth)
  const spawn = async () => { throw new Error("spawn ENOENT"); };
  const result = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn }));
  assert.equal(result.success, false);
  assert.equal(result.preflight.attempted, true);
  assert.equal(result.failureCode, "FFPROBE_VERSION_SPAWN_FAILED");
  assert.equal(result.executed, false);
});

test("ffmpeg timeout and non-zero exit are reported honestly", async () => {
  const plan = makePlan();
  const timeoutResult = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn: makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl({ timedOut: true }) }), skipPreflight: true }));
  assert.equal(timeoutResult.failureCode, "FFMPEG_TIMEOUT");
  assert.equal(timeoutResult.executed, true);
  assert.equal(timeoutResult.success, false);

  const exitResult = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn: makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl({ exitCode: 2 }) }), skipPreflight: true }));
  assert.equal(exitResult.failureCode, "FFMPEG_EXIT_NONZERO");
  assert.equal(exitResult.exitCode, 2);
  assert.match(exitResult.stderrTail, /conversion failed/);
});

test("unreadable rendered file fails QC honestly (no inspection → no success)", async () => {
  const plan = makePlan();
  const spawn = makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl() });
  const opts = makeExecutorOptions({ spawn, skipPreflight: true, outputBytes: null });
  const result = await executeAssemblyPlan(plan, opts);
  assert.equal(result.success, false);
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 0, "ffmpeg itself exited zero — the honesty comes from QC");
  assert.equal(result.failureCode, "QC_DESCRIPTOR_NOT_VERIFIED");
  assert.equal(result.qc.inspectionReasonCode, "INSPECTION_SOURCE_UNREADABLE");
});

test("probe cannot parse the render → honest QC failure", async () => {
  const plan = makePlan();
  const spawn = makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl(), ffprobeExitCode: 3 });
  const result = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn, skipPreflight: true }));
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "QC_DESCRIPTOR_NOT_VERIFIED");
  assert.equal(result.qc.inspectionReasonCode, "FFPROBE_EXIT_NONZERO");
});

test("END-TO-END HONEST SUCCESS: real command + real matching inspection + passing QC", async () => {
  const plan = makePlan();
  const spawn = makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl(), probeDurationSeconds: 1830 });
  const opts = makeExecutorOptions({ spawn, skipPreflight: true });
  const result = await executeAssemblyPlan(plan, opts);
  assert.equal(result.success, true);
  assert.equal(result.failureCode, null);
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.qc.policy, "main_video_runtime");
  assert.equal(result.qc.passed, true);
  assert.equal(result.qc.measuredDurationSeconds, 1830);
  assert.equal(result.descriptor.verification.state, "VERIFIED");
  assert.equal(result.descriptor.contentSha256, sha256(OUTPUT_BYTES), "identity anchored to the REAL rendered bytes");
  assert.ok(Array.isArray(result.command) && result.command[result.command.length - 1] === "/media/out/main.mp4");
  // full pre-flight path also succeeds
  const preflightResult = await executeAssemblyPlan(plan, { ...opts, skipPreflight: false });
  assert.equal(preflightResult.success, true);
});

test("main_longform QC: out-of-window render is rejected with QC_DURATION_OUT_OF_RANGE", async () => {
  const plan = makePlan();
  for (const bad of [MAIN_VIDEO_MIN_SECONDS - 10, MAIN_VIDEO_MAX_SECONDS + 10]) {
    const spawn = makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl(), probeDurationSeconds: bad });
    const result = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn, skipPreflight: true }));
    assert.equal(result.success, false);
    assert.equal(result.failureCode, "QC_DURATION_OUT_OF_RANGE");
    assert.equal(result.qc.measuredDurationSeconds, bad);
    assert.equal(result.descriptor, null, "a failing gate never yields a verified descriptor");
  }
});

test("short-form targets use the short-form QC policy window", async () => {
  const plan = makePlan({ outputTarget: "content_reel_1" });
  const okSpawn = makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl(), probeDurationSeconds: 45 });
  const okResult = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn: okSpawn, outputPath: "/media/out/reel.mp4", skipPreflight: true }));
  assert.equal(okResult.success, true);
  assert.equal(okResult.qc.policy, "short_form_runtime");

  // 45-minute "reel" → out of range
  const badSpawn = makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl(), probeDurationSeconds: 2700 });
  const badResult = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn: badSpawn, outputPath: "/media/out/reel.mp4", skipPreflight: true }));
  assert.equal(badResult.success, false);
  assert.equal(badResult.failureCode, "QC_DURATION_OUT_OF_RANGE");
});

test("unsafe output path fails closed before any spawn", async () => {
  const plan = makePlan();
  for (const hostile of ["-o", "/media/../escape.mp4", "bad\0.mp4"]) {
    const result = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn: makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl() }), outputPath: hostile }));
    assert.equal(result.failureCode, "EXEC_OUTPUT_PATH_UNSAFE");
    assert.equal(result.executed, false);
  }
});

test("subtitled main render end-to-end with a degradation-free build", async () => {
  const plan = makePlan({ subtitleTrack: { artifactRef: REF_SUBS, format: "srt" } });
  const spawn = makeSpawnImpl({ ffmpeg: makeFfmpegSpawnImpl(), probeDurationSeconds: 1830 });
  const result = await executeAssemblyPlan(plan, makeExecutorOptions({ spawn, skipPreflight: true }));
  assert.equal(result.success, true);
  assert.match(result.filtergraph, /subtitles=/);
  assert.deepEqual([...result.degradations], []);
});
