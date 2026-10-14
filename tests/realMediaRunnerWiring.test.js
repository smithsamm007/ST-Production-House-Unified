/**
 * Real-media runner wiring tests (Phase-1 blocker fix).
 *
 * The executors require injected transports; before
 * `createRealMediaRunnerFactory` existed, `src/catalog/server.js` bound the
 * runner with no `spawnImpl`/`readFileImpl`, so every real media stage failed
 * closed with `<STAGE>_SPAWN_FAILED`. These tests pin the wiring itself:
 * a real per-Director binding is produced, isolation is enforced, the
 * factory declares the FREE-FIRST provider capacity (espeak-ng voice +
 * pollinations visual), and a runner bound WITHOUT capacity still returns the
 * truthful durable wait (never fabricated media).
 *
 * Offline by construction: a stub transport is used, so no binary is spawned
 * and no network call is made.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createRealMediaRunnerFactory } from "../src/catalog/server.js";
import { bindProductionRunner } from "../src/pipeline/productionExecutorRunner.js";
import { createNodeMediaTransports } from "../src/media/nodeMediaTransport.js";

const MEDIA_PATHS = Object.freeze({
  audio: path.join("artifacts", "media", "audio"),
  visual: path.join("artifacts", "media", "visuals"),
  episode: path.join("artifacts", "media", "episodes"),
  thumbnail: path.join("artifacts", "media", "thumbnails"),
  runPrefix: "episode",
});

function makeFactory(transports = createNodeMediaTransports()) {
  return createRealMediaRunnerFactory({
    bindProductionRunner,
    transports,
    mediaPaths: MEDIA_PATHS,
  });
}

/**
 * A transport that never runs a real process and never reads a real file:
 * `spawnImpl` reports the process never started (ENOENT), and `readFileImpl`
 * throws. This lets the tests prove the factory's provider SELECTION wiring
 * offline — the failure code must be a binary-failure code, never the
 * "no capacity" wait, which only an unconfigured registry produces.
 */
const STUB_TRANSPORTS = Object.freeze({
  spawnImpl: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnErrorCode: "ENOENT" }),
  readFileImpl: async () => { throw new Error("ENOENT"); },
});

test("real-media factory composes the production transports into one runner per Director", () => {
  const factory = makeFactory();
  assert.equal(typeof factory, "function");
  const runner = factory({ agentId: "agent-01" });
  assert.equal(typeof runner, "function");
});

test("real-media factory enforces per-Director isolation", async () => {
  const runner = makeFactory()({ agentId: "agent-01" });
  await assert.rejects(
    () => runner({ release: { id: "r-1", agentId: "agent-02", title: "T" }, stage: "audio" }),
    (error) => error.code === "RUNNER_AGENT_MISMATCH"
  );
});

test("real-media factory returns the QC stage policy list without touching a provider", async () => {
  const runner = makeFactory()({ agentId: "agent-01" });
  const qc = await runner({ release: { id: "r-1", agentId: "agent-01", title: "T" }, stage: "qc" });
  assert.equal(Array.isArray(qc), true);
});

test("a runner bound without declared capacity still reports the durable wait, never media", async () => {
  // The honest no-capacity truth is a property of an UNCONFIGURED binding,
  // pinned here directly against bindProductionRunner (no tts/visual slots).
  const runner = bindProductionRunner({
    agentId: "agent-01",
    spawnImpl: STUB_TRANSPORTS.spawnImpl,
    readFileImpl: STUB_TRANSPORTS.readFileImpl,
    paths: MEDIA_PATHS,
  });
  const audio = await runner({
    release: { id: "r-1", agentId: "agent-01", title: "T" },
    stage: "audio",
    stageInputs: { title: "Placeholder wiring probe" },
  });
  assert.equal(audio.success, false);
  assert.equal(audio.quotaState, "WAITING_FOR_QUOTA");
  assert.equal(audio.failureCode, "CREDENTIAL_MISSING");
  assert.equal(audio.mediaStatus, "unverified");
  assert.equal(audio.descriptor, null);

  const visual = await runner({
    release: { id: "r-1", agentId: "agent-01", title: "T" },
    stage: "visual",
    stageInputs: { title: "Placeholder wiring probe" },
  });
  assert.equal(visual.success, false);
  assert.equal(visual.mediaStatus, "unverified");
  assert.equal(visual.descriptor, null);
});

test("the factory declares the free-first provider capacity for a Director", async () => {
  const runner = makeFactory(STUB_TRANSPORTS)({ agentId: "agent-01" });

  // Voice: the espeak-ng slot is DECLARED, so selection passes and the stage
  // reaches the (stubbed) spawn — the failure is a binary failure, not the
  // "no capacity" wait. This is the wiring regression guard.
  const audio = await runner({
    release: { id: "r-1", agentId: "agent-01", title: "T" },
    stage: "audio",
    stageInputs: { title: "Capacity wiring probe" },
  });
  assert.equal(audio.success, false);
  assert.notEqual(audio.quotaState, "WAITING_FOR_QUOTA");
  assert.notEqual(audio.failureCode, "CREDENTIAL_MISSING");
  assert.equal(audio.providerCall.providerId, "espeak-ng");
  assert.equal(audio.providerCall.providerRole, "local_open_source_emergency");

  // Visual: the pollinations slot is DECLARED and selected (attempts record
  // skipped: null), so the stage reaches the stubbed spawn.
  const visual = await runner({
    release: { id: "r-1", agentId: "agent-01", title: "T" },
    stage: "visual",
    stageInputs: { title: "Capacity wiring probe" },
  });
  assert.equal(visual.success, false);
  assert.notEqual(visual.quotaState, "WAITING_FOR_QUOTA");
  assert.equal(visual.providerCall.providerId, "pollinations");
  assert.ok(visual.attempts.some((a) => a.providerId === "pollinations" && a.skipped === null));
});
