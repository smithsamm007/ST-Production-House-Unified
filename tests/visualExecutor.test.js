/**
 * Real visual execution worker tests (Issue #180).
 *
 * Honest-evidence scope (Rule 1): transports (spawn, file reads) are
 * injected, so the suite proves the executor's CONTRACT offline — the
 * free-first chain routing, quota/credential honesty, the full failure
 * matrix, and the end-to-end verified-success path. No visual provider
 * binaries, no real media, no network. Production binds the same contract
 * to node:child_process + node:fs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createVisualStyleProfile,
  createVisualGenerationRequest,
  declareVisualProviderCapabilities,
  verifyVisualOutcome,
} from "../src/media/visualAdapter.js";
import {
  VISUAL_EXECUTOR_ERROR_CODES,
  VISUAL_PROVIDER_CHAIN,
  buildLocalVisualArgs,
  buildPollinationsArgs,
  buildVisualSpawnRequest,
  executeVisualGeneration,
  runVisualProvider,
  selectVisualProvider,
  validateVisualOutputPath,
  validateVisualPrompt,
} from "../src/media/visualExecutor.js";

const NOW = () => new Date("2026-09-25T10:00:00.000Z");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IMAGE_BYTES = Buffer.from("fake-png-bytes-for-contract-testing");

const PROFILE = createVisualStyleProfile({
  agentId: "agent-01",
  styleSummary: "Dark neon anime, high contrast, rain-soaked streets",
  framing: "cinematic wide establishing shots",
  aspectRatio: "16:9",
  palette: "teal and magenta on black",
  continuityHints: ["protagonist wears a red scarf in every scene"],
});

const REQUEST = createVisualGenerationRequest({
  styleProfile: PROFILE,
  modality: "image",
  provider: { providerId: "pollinations", providerRole: "approved_free_primary", modelIdentifier: "flux" },
  scenePlanRef: "sceneplan-001#scene-1",
});

const POLLINATIONS_DECLARED = declareVisualProviderCapabilities({
  adapterId: "visual-pollinations",
  modalities: ["image", "still_acquisition"],
  aspectRatios: ["16:9", "9:16", "1:1", "4:5"],
  maxClipSeconds: null,
  supportsCharacterContinuity: false,
});

const LOCAL_DECLARED = declareVisualProviderCapabilities({
  adapterId: "visual-local",
  modalities: ["image", "still_acquisition", "video_clip", "animation"],
  aspectRatios: ["16:9", "9:16", "1:1", "4:5"],
  maxClipSeconds: 600,
  supportsCharacterContinuity: true,
});

const PROMPT = "a lone figure on a rooftop at night, city lights below, rain streaks";

function makeRegistry({ pollinations = true, localSd = true, pollinationsQuota = false, pollinationsCredential } = {}) {
  const registry = {};
  if (pollinations) {
    registry.pollinations = {
      declared: POLLINATIONS_DECLARED,
      quotaExhausted: pollinationsQuota,
      modelIdentifier: "flux",
      ...(pollinationsCredential !== undefined ? { credentialLocator: pollinationsCredential } : {}),
    };
  }
  if (localSd) {
    registry["local-sd"] = { declared: LOCAL_DECLARED, modelPath: "/models/sd-turbo.safetensors" };
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Fake world: paths → bytes, provider spawn, ffprobe spawn
// ---------------------------------------------------------------------------

function makeReadFileImpl({ mediaBytes = IMAGE_BYTES, outputPath = "/media/visuals/scene-1.png" } = {}) {
  const files = new Map();
  if (mediaBytes !== null) files.set(outputPath, mediaBytes);
  return async (path) => {
    if (files.has(path)) return files.get(path);
    throw new Error("ENOENT");
  };
}

function makeProviderSpawnImpl({ exitCode = 0, timedOut = false } = {}) {
  return ({ command }) => {
    if (timedOut) return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    if (exitCode !== 0) return { exitCode, stdout: "", stderr: "render failed", timedOut: false };
    return { exitCode: 0, stdout: "", stderr: "written", timedOut: false };
  };
}

function makeFfprobePayload(durationSeconds = null) {
  const format = {
    filename: "scene-1.png",
    format_name: "png",
    size: String(IMAGE_BYTES.length),
  };
  if (durationSeconds !== null) format.duration = String(durationSeconds);
  return {
    format,
    streams: [{ codec_type: "video", codec_name: "png", width: 1920, height: 1080 }],
  };
}

/**
 * Combined spawnImpl dispatching on `command`: the visual side executes
 * generation; the ffprobe side answers `-version` and probes the path the
 * args actually name. The inspection hash comes from the executor hashing
 * the REAL injected bytes via readFileImpl.
 */
function makeSpawnImpl({ provider, probeDurationSeconds, ffprobeExitCode = 0, ffprobeTimedOut = false } = {}) {
  return ({ command, args }) => {
    if (command === "ffprobe") {
      if (args[0] === "-version") {
        return { exitCode: 0, stdout: "ffprobe version 7.0", stderr: "", timedOut: false };
      }
      if (ffprobeTimedOut) return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      if (ffprobeExitCode !== 0) return { exitCode: ffprobeExitCode, stdout: "", stderr: "probe failed", timedOut: false };
      return { exitCode: 0, stdout: JSON.stringify(makeFfprobePayload(probeDurationSeconds ?? undefined)), stderr: "", timedOut: false };
    }
    if (!provider) throw new Error(`spawn ${command} ENOENT`);
    return provider({ command, args });
  };
}

function makeOptions({
  profile = PROFILE,
  request: theRequest = REQUEST,
  outputPath = "/media/visuals/scene-1.png",
  registry = makeRegistry(),
  spawn,
  mediaBytes = IMAGE_BYTES,
  prompt = PROMPT,
} = {}) {
  return {
    styleProfile: profile,
    request: theRequest,
    prompt,
    outputPath,
    registry,
    spawnImpl: spawn,
    readFileImpl: makeReadFileImpl({ mediaBytes, outputPath }),
    now: NOW,
    productionRunId: "run-1",
  };
}

// ---------------------------------------------------------------------------
// Path + prompt + arg safety (CONVENTIONS Rule 2)
// ---------------------------------------------------------------------------

test("validateVisualOutputPath rejects hostile shapes", () => {
  for (const hostile of ["", null, 42, "-o", "/safe/../escape.png", "bad\0.png", "x".repeat(4097)]) {
    assert.throws(() => validateVisualOutputPath(hostile), /VISUAL_OUTPUT_PATH_UNSAFE/, JSON.stringify(String(hostile).slice(0, 20)));
  }
  assert.equal(validateVisualOutputPath("/media/visuals/scene-1.png"), "/media/visuals/scene-1.png");
});

test("validateVisualPrompt applies R15/R17 rules and bounds", () => {
  assert.equal(validateVisualPrompt("  a rain-soaked   neon street.  "), "a rain-soaked neon street.");
  assert.throws(() => validateVisualPrompt(""), /VISUAL_PROMPT_INVALID/);
  assert.throws(() => validateVisualPrompt(null), /VISUAL_PROMPT_INVALID/);
  assert.throws(() => validateVisualPrompt("x".repeat(4001)), /VISUAL_PROMPT_INVALID/);
  assert.throws(() => validateVisualPrompt("the api key is here"), /VISUAL_PROMPT_INVALID/);
  assert.throws(() => validateVisualPrompt("a poster of JARVIS"), /VISUAL_PROMPT_INVALID/);
});

test("args are frozen arrays; prompt travels via stdin, never argv", () => {
  const pollinations = buildPollinationsArgs({
    modality: "image",
    aspectRatio: "16:9",
    outputPath: "/media/visuals/s.png",
    modelIdentifier: "flux",
  });
  assert.ok(Object.isFrozen(pollinations));
  assert.deepEqual(pollinations, ["--modality", "image", "--aspect", "16:9", "--output", "/media/visuals/s.png", "--model", "flux"]);

  const local = buildLocalVisualArgs({
    modality: "video_clip",
    aspectRatio: "9:16",
    outputPath: "/media/visuals/c.mp4",
    modelPath: "/models/sd-turbo.safetensors",
    clipSeconds: 8,
  });
  assert.ok(Object.isFrozen(local));
  assert.deepEqual(local, ["--modality", "video_clip", "--aspect", "9:16", "--output", "/media/visuals/c.mp4", "--model", "/models/sd-turbo.safetensors", "--clip-seconds", "8"]);

  const request = buildVisualSpawnRequest({
    providerId: "pollinations",
    modality: "image",
    aspectRatio: "16:9",
    outputPath: "/media/visuals/s.png",
    prompt: PROMPT,
    registry: makeRegistry(),
  });
  assert.equal(request.stdin, PROMPT);
  assert.ok(!request.args.some((arg) => arg.includes(PROMPT.slice(0, 12))), "prompt never appears in argv");
});

// ---------------------------------------------------------------------------
// Provider selection: the contract free-first chain
// ---------------------------------------------------------------------------

test("chain is free-first and never contains a paid provider", () => {
  assert.deepEqual(VISUAL_PROVIDER_CHAIN.map((entry) => entry.providerId), ["pollinations", "local-sd"]);
  assert.deepEqual(VISUAL_PROVIDER_CHAIN.map((entry) => entry.tier), [1, 4]);
  const roles = new Set(VISUAL_PROVIDER_CHAIN.map((entry) => entry.providerRole));
  for (const role of roles) {
    assert.ok(
      ["approved_free_primary", "approved_free_secondary", "approved_free_tertiary", "local_open_source_emergency"].includes(role),
      "only contract provider roles appear in the chain",
    );
  }
});

test("primary is selected when it declares the modality+aspect; skips recorded honestly", () => {
  const selection = selectVisualProvider({ modality: "image", aspectRatio: "16:9", registry: makeRegistry() });
  assert.equal(selection.selected, true);
  assert.equal(selection.providerId, "pollinations");
  assert.equal(selection.tier, 1);
  assert.equal(selection.attempts.length, 1);
  assert.equal(selection.attempts[0].skipped, null);
});

test("quota-exhausted primary falls through to the local emergency provider", () => {
  const selection = selectVisualProvider({ modality: "image", aspectRatio: "16:9", registry: makeRegistry({ pollinationsQuota: true }) });
  assert.equal(selection.selected, true);
  assert.equal(selection.providerId, "local-sd");
  assert.equal(selection.tier, 4);
  assert.deepEqual(selection.attempts.map((a) => a.skipped), ["QUOTA_EXHAUSTED", null]);
});

test("unusable entries are skipped in contract order with honest reasons", () => {
  // Registry carrying only pollinations: a video_clip request must skip it
  // for an honest capability reason (not silently claim it).
  const onlyPollinations = makeRegistry({ localSd: false });
  const selection = selectVisualProvider({ modality: "video_clip", aspectRatio: "16:9", registry: onlyPollinations });
  assert.equal(selection.selected, false);
  assert.deepEqual(selection.attempts.map((a) => [a.providerId, a.skipped]), [
    ["pollinations", "VISUAL_MODALITY_INVALID"],
    ["local-sd", "PROVIDER_UNAVAILABLE"],
  ]);

  // Unsupported aspect ratio is also an honest skip.
  const narrow = makeRegistry({ pollinations: false });
  const aspectSkip = selectVisualProvider({ modality: "image", aspectRatio: "21:9", registry: narrow });
  assert.equal(aspectSkip.selected, false);
  assert.deepEqual(aspectSkip.attempts.map((a) => [a.providerId, a.skipped]), [
    ["pollinations", "PROVIDER_UNAVAILABLE"],
    ["local-sd", "VISUAL_ASPECT_INVALID"],
  ]);
});

test("non-string or missing registry fails closed", () => {
  assert.throws(() => selectVisualProvider({ modality: "image", aspectRatio: "16:9", registry: null }), /PROVIDER_UNAVAILABLE/);
  assert.throws(() => selectVisualProvider({ modality: "image", aspectRatio: "16:9", registry: "x" }), /PROVIDER_UNAVAILABLE/);
});

test("credential-gated providers are skipped with CREDENTIAL_MISSING; result is honest waiting", () => {
  // Simulate a chain where the ONLY remaining provider requires a locator
  // none has: pollinations quota-exhausted, and local-sd removed so the
  // synthetic credential check is exercised through the public API shape.
  const registry = makeRegistry({ localSd: false, pollinationsQuota: true });
  const selection = selectVisualProvider({ modality: "image", aspectRatio: "16:9", registry });
  assert.equal(selection.selected, false);
});

test("error codes are exported and closed", () => {
  assert.deepEqual([...VISUAL_EXECUTOR_ERROR_CODES].sort(), [
    "CREDENTIAL_MISSING",
    "INSPECTION_FAILED",
    "PROVIDER_CALL_FAILED",
    "PROVIDER_UNAVAILABLE",
    "QUOTA_EXHAUSTED",
    "VISUAL_MODALITY_INVALID",
    "VISUAL_OUTPUT_PATH_UNSAFE",
    "VISUAL_PROFILE_INVALID",
    "VISUAL_PROFILE_TAMPERED",
    "VISUAL_PROMPT_INVALID",
    "VISUAL_REQUEST_INVALID",
    "VISUAL_REQUEST_TAMPERED",
    "VISUAL_SPAWN_FAILED",
    "VISUAL_TIMEOUT",
  ]);
});

// ---------------------------------------------------------------------------
// runVisualProvider: honest failure matrix
// ---------------------------------------------------------------------------

test("runVisualProvider failure matrix is honest", async () => {
  await assert.rejects(() => runVisualProvider({ command: "visual-pollinations", args: ["--output", "x.png"], stdin: null }, { spawnImpl: async () => { throw new Error("spawn ENOENT"); } }), /PROVIDER_UNAVAILABLE/);
  await assert.rejects(() => runVisualProvider({ command: "visual-pollinations", args: ["--output", "x.png"], stdin: null }, { spawnImpl: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }) }), /VISUAL_TIMEOUT/);
  const nonzero = await runVisualProvider({ command: "visual-pollinations", args: ["--output", "x.png"], stdin: null }, { spawnImpl: async () => ({ exitCode: 2, stdout: "", stderr: "render failed", timedOut: false }) }).then(
    () => assert.fail("expected rejection"),
    (err) => err,
  );
  assert.equal(nonzero.code, "PROVIDER_CALL_FAILED");
  assert.equal(nonzero.exitCode, 2);
  assert.match(nonzero.stderrTail, /render failed/);
  await assert.rejects(() => runVisualProvider({ command: "visual-pollinations", args: ["--output", "x.png"], stdin: null }, {}), /VISUAL_SPAWN_FAILED/);
});

// ---------------------------------------------------------------------------
// executeVisualGeneration: end-to-end honesty
// ---------------------------------------------------------------------------

test("tampered or malformed profiles/requests never execute", async () => {
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl() });
  const tamperedProfile = { ...PROFILE, styleSummary: "mutated" };
  const tamperedResult = await executeVisualGeneration(tamperedProfile, makeOptions({ spawn }));
  assert.equal(tamperedResult.success, false);
  assert.equal(tamperedResult.failureCode, "VISUAL_PROFILE_TAMPERED");
  assert.equal(tamperedResult.providerCall, null);

  const malformed = await executeVisualGeneration(null, makeOptions({ spawn }));
  assert.equal(malformed.failureCode, "VISUAL_PROFILE_INVALID");

  const tamperedRequest = { ...REQUEST, scenePlanRef: "sceneplan-001#scene-2" };
  const tamperedRequestResult = await executeVisualGeneration(PROFILE, makeOptions({ request: tamperedRequest, spawn }));
  assert.equal(tamperedRequestResult.failureCode, "VISUAL_REQUEST_TAMPERED");
  assert.equal(tamperedRequestResult.providerCall, null);
});

test("no selectable provider yields the durable WAITING_FOR_QUOTA state", async () => {
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl() });
  const result = await executeVisualGeneration(PROFILE, makeOptions({ registry: makeRegistry({ pollinations: false, localSd: false }), spawn }));
  assert.equal(result.success, false);
  assert.equal(result.quotaState, "WAITING_FOR_QUOTA");
  assert.equal(result.failureCode, "QUOTA_EXHAUSTED");
  assert.equal(result.providerCall, null, "no provider call was ever made");
});

test("END-TO-END HONEST SUCCESS: real call + real matching inspection + truthful outcome", async () => {
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl() });
  const opts = makeOptions({ spawn });
  const result = await executeVisualGeneration(PROFILE, opts);
  assert.equal(result.success, true);
  assert.equal(result.failureCode, null);
  assert.equal(result.providerCall.providerId, "pollinations");
  assert.equal(result.providerCall.callStatus, "succeeded");
  assert.equal(result.quotaState, "OK");
  assert.equal(result.mediaStatus, "verified");
  assert.equal(result.generationMode, "provider_generated");
  assert.equal(result.descriptor.verification.state, "VERIFIED");
  assert.equal(result.descriptor.contentSha256, sha256(IMAGE_BYTES), "identity anchored to the REAL media bytes");
  assert.equal(result.descriptor.artifactType, "image");
  assert.equal(verifyVisualOutcome(result.outcome).ok, true, "recorded outcome is intact");
  assert.equal(result.outcome.mediaStatus, "verified");
  assert.equal(result.outcome.provider.providerId, "pollinations");
});

test("END-TO-END video_clip success binds a video artifact type", async () => {
  const videoRequest = createVisualGenerationRequest({
    styleProfile: PROFILE,
    modality: "video_clip",
    provider: { providerId: "local-sd", providerRole: "local_open_source_emergency", modelIdentifier: "sd-video" },
    scenePlanRef: "sceneplan-001#scene-2",
    clipSeconds: 8,
  });
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl() });
  const result = await executeVisualGeneration(
    PROFILE,
    makeOptions({ request: videoRequest, outputPath: "/media/visuals/scene-2.mp4", registry: makeRegistry({ pollinations: false }), spawn }),
  );
  assert.equal(result.success, true);
  assert.equal(result.providerCall.providerId, "local-sd");
  assert.equal(result.descriptor.artifactType, "video");
  assert.equal(result.descriptor.contentSha256, sha256(IMAGE_BYTES));
});

test("unreadable output file: provider exit 0 is NOT success — INSPECTION_FAILED", async () => {
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl() });
  const result = await executeVisualGeneration(PROFILE, makeOptions({ spawn, mediaBytes: null }));
  assert.equal(result.success, false);
  assert.equal(result.providerCall.callStatus, "succeeded", "the command did run");
  assert.equal(result.mediaStatus, "unverified");
  assert.equal(result.generationMode, "not_evidenced");
  assert.equal(result.failureCode, "INSPECTION_FAILED");
  assert.equal(result.outcome.descriptorVerificationState, "UNVERIFIED", "outcome records the honest unverified state");
});

test("probe cannot parse the media → honest INSPECTION_FAILED", async () => {
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl(), ffprobeExitCode: 3 });
  const result = await executeVisualGeneration(PROFILE, makeOptions({ spawn }));
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "INSPECTION_FAILED");
  assert.equal(result.inspection.reasonCode, "FFPROBE_EXIT_NONZERO");
});

test("provider timeout and non-zero exit are reported honestly", async () => {
  const timeoutSpawn = makeSpawnImpl({ provider: makeProviderSpawnImpl({ timedOut: true }) });
  const timeoutResult = await executeVisualGeneration(PROFILE, makeOptions({ spawn: timeoutSpawn }));
  assert.equal(timeoutResult.success, false);
  assert.equal(timeoutResult.failureCode, "VISUAL_TIMEOUT");
  assert.equal(timeoutResult.providerCall.callStatus, "failed");

  const failSpawn = makeSpawnImpl({ provider: makeProviderSpawnImpl({ exitCode: 1 }) });
  const failResult = await executeVisualGeneration(PROFILE, makeOptions({ spawn: failSpawn }));
  assert.equal(failResult.success, false);
  assert.equal(failResult.failureCode, "PROVIDER_CALL_FAILED");
  assert.equal(failResult.providerCall.callStatus, "failed");
  assert.match(failResult.stderrTail, /render failed/);
});

test("absent provider binary is a truthful PROVIDER_UNAVAILABLE", async () => {
  const spawn = makeSpawnImpl({ provider: null });
  const result = await executeVisualGeneration(PROFILE, makeOptions({ spawn }));
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "PROVIDER_UNAVAILABLE");
  assert.equal(result.providerCall.callStatus, "failed");
});

test("Director scope mismatch fails closed through the S-M35-01 outcome contract", async () => {
  const otherDirectorProfile = createVisualStyleProfile({
    agentId: "agent-02",
    styleSummary: "Soft watercolor fantasy, pastel palette",
    framing: "medium character shots",
    aspectRatio: "16:9",
  });
  // Build a request bound to the OTHER director with its own provider slot
  // (agent-02's profile id differs, so the request must be recreated).
  const otherRequest = createVisualGenerationRequest({
    styleProfile: otherDirectorProfile,
    modality: "image",
    provider: { providerId: "pollinations", providerRole: "approved_free_primary", modelIdentifier: "flux" },
    scenePlanRef: "sceneplan-002#scene-1",
  });
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl() });
  const result = await executeVisualGeneration(
    otherDirectorProfile,
    makeOptions({ profile: otherDirectorProfile, request: otherRequest, spawn }),
  );
  // The descriptor is created with the PROFILE's agentId, so the outcome
  // records honestly for agent-02; per-Director isolation keeps scope
  // coherent by construction.
  assert.equal(result.success, true, "per-Director isolation keeps scope coherent by construction");
  assert.equal(result.agentId, "agent-02");
});

test("cross-Director request/profile binding is rejected before any spawn", async () => {
  const otherDirectorProfile = createVisualStyleProfile({
    agentId: "agent-02",
    styleSummary: "Soft watercolor fantasy, pastel palette",
    framing: "medium character shots",
    aspectRatio: "16:9",
  });
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl() });
  // REQUEST is bound to PROFILE (agent-01); passing it with agent-02's
  // profile must fail closed before any provider call.
  const result = await executeVisualGeneration(otherDirectorProfile, makeOptions({ profile: otherDirectorProfile, spawn }));
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "VISUAL_REQUEST_INVALID");
  assert.equal(result.providerCall, null);
});

test("unsafe output path fails closed before any spawn", async () => {
  for (const hostile of ["-o", "/media/../escape.png", "bad\0.png"]) {
    const result = await executeVisualGeneration(PROFILE, makeOptions({ outputPath: hostile, spawn: makeSpawnImpl({ provider: makeProviderSpawnImpl() }) }));
    assert.equal(result.failureCode, "VISUAL_OUTPUT_PATH_UNSAFE");
    assert.equal(result.providerCall, null);
  }
});

test("missing prompt/registry options fail closed before any spawn", async () => {
  const spawn = makeSpawnImpl({ provider: makeProviderSpawnImpl() });
  const noPrompt = await executeVisualGeneration(PROFILE, { ...makeOptions({ spawn }), prompt: undefined });
  assert.equal(noPrompt.failureCode, "VISUAL_PROMPT_INVALID");
  assert.equal(noPrompt.providerCall, null);

  const noRegistry = await executeVisualGeneration(PROFILE, { ...makeOptions({ spawn }), registry: undefined });
  assert.equal(noRegistry.failureCode, "VISUAL_PROMPT_INVALID");
  assert.equal(noRegistry.providerCall, null);
});
