import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import {
  PRODUCTION_RUNNER_ERROR_CODES,
  PRODUCTION_RUNNER_VERSION,
  bindProductionRunner,
  buildLongformAssemblyPlan,
  waitingResult,
} from "../src/pipeline/productionExecutorRunner.js";
import { runEpisodePipeline } from "../src/pipeline/episodePipeline.js";
import { ProductionWorkerLoop } from "../src/pipeline/workerLoop.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";
import { ProductionRepository } from "../src/catalog/productionRepository.js";
import { createVoiceProfile, declareTtsProviderCapabilities } from "../src/media/ttsAdapter.js";
import { createVisualStyleProfile, declareVisualProviderCapabilities } from "../src/media/visualAdapter.js";

const NOW = () => new Date("2026-09-25T10:00:00.000Z");

const NARRATION_BYTES = Buffer.from("prod-runner-mp3-bytes");
const FRAME_BYTES = Buffer.from("prod-runner-png-bytes");
const THUMB_BYTES = Buffer.from("prod-runner-thumb-png-bytes");
const EPISODE_BYTES = Buffer.from("prod-runner-mp4-bytes");
// The three canonical reels are genuinely distinct renders (Issue #189):
// the (release_id, sha256) uniqueness rule must never collide them.
const REEL_BYTES = Object.freeze({
  content_reel_1: Buffer.from("reel-one-bytes"),
  content_reel_2: Buffer.from("reel-two-bytes"),
  brand_reel: Buffer.from("brand-reel-bytes"),
});

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Offline world: spawn/files so the real executors run without binaries
// ---------------------------------------------------------------------------

function makeSpawn() {
  return ({ command, args }) => {
    if (command === "ffprobe") {
      if (args[0] === "-version") return { exitCode: 0, stdout: "ffprobe version 7.0", stderr: "", timedOut: false };
      const target = args[args.length - 1];
      const payload = target.endsWith(".mp3")
        ? { format: { filename: "n", format_name: "mp3", size: String(NARRATION_BYTES.length) }, streams: [{ codec_type: "audio", codec_name: "mp3" }] }
        : target.endsWith(".mp4") && /content_reel_[12]|brand_reel/.test(target)
          // Reel renders are short-form: the fake ffprobe must report the
          // measured duration INSIDE the [3, 90] s short-form QC window —
          // reporting the 1890 s episode duration here would (correctly)
          // fail the real gate.
          ? { format: { filename: "r", format_name: "mp4", size: "6000", duration: "30" }, streams: [{ codec_type: "video", codec_name: "h264" }] }
          : target.endsWith(".mp4")
            ? { format: { filename: "e", format_name: "mp4", size: String(EPISODE_BYTES.length), duration: "1890" }, streams: [{ codec_type: "video", codec_name: "h264" }] }
            : { format: { filename: "f", format_name: "png", size: String(THUMB_BYTES.length) }, streams: [{ codec_type: "video", codec_name: "png", width: 1920, height: 1080 }] };
      return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "written", timedOut: false };
  };
}

function makeFiles() {
  // Extension-based world: the runner derives output paths from the release
  // id, so the fake filesystem resolves by suffix. Thumbnail bytes differ
  // from scene-still bytes (as real thumbnails do) so the (release_id,
  // sha256) uniqueness rule never collides them.
  return async (path) => {
    if (typeof path === "string" && path.endsWith(".mp3")) return NARRATION_BYTES;
    if (typeof path === "string" && path.endsWith(".mp4")) {
      const reel = path.match(/(content_reel_1|content_reel_2|brand_reel)/);
      if (reel) return REEL_BYTES[reel[1]];
      return EPISODE_BYTES;
    }
    if (typeof path === "string" && path.endsWith(".png")) {
      return path.includes("thumb") ? THUMB_BYTES : FRAME_BYTES;
    }
    throw new Error("ENOENT");
  };
}

function makeBinding({ agentId = "agent-01", overrides = {} } = {}) {
  return {
    agentId,
    paths: { runPrefix: "prodrun" },
    tts: {
      profile: createVoiceProfile({
        agentId,
        language: "hi",
        provider: { providerId: "edge-tts", providerRole: "approved_free_primary", modelIdentifier: "edge-tts-cli", voiceId: "hi-IN-MadhurNeural" },
      }),
      registry: {
        "edge-tts": { declared: declareTtsProviderCapabilities({ adapterId: "edge-tts-cli", languages: ["hi", "en"], voices: [{ voiceId: "hi-IN-MadhurNeural", language: "hi", supportsEmotion: true }] }), quotaExhausted: false },
      },
    },
    visual: {
      profile: createVisualStyleProfile({ agentId, styleSummary: "dark neon anime", aspectRatio: "16:9" }),
      registry: {
        pollinations: { declared: declareVisualProviderCapabilities({ adapterId: "visual-pollinations", modalities: ["image", "still_acquisition"], aspectRatios: ["16:9", "9:16", "1:1", "4:5"] }), quotaExhausted: false },
      },
    },
    spawnImpl: makeSpawn(),
    readFileImpl: makeFiles(),
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// bindProductionRunner: per-Director binding, real executor results
// ---------------------------------------------------------------------------

test("bound runner executes the REAL tts executor end to end (verified result)", async () => {
  const runner = bindProductionRunner(makeBinding());
  const result = await runner({
    release: { id: "r-1", agentId: "agent-01", title: "T" },
    stage: "audio",
    stageInputs: { title: "Nightfall Ward 7", season: 1, episode: 3 },
  });
  assert.equal(result.success, true);
  assert.equal(result.mediaStatus, "verified");
  assert.equal(result.generationMode, "provider_generated");
  assert.equal(result.descriptor.contentSha256, sha256(NARRATION_BYTES));
  assert.equal(result.outputPath, "/stph/media/audio/prodrun-r-1.mp3");
});

test("bound runner executes the REAL visual executor for scene and thumbnail stages", async () => {
  const runner = bindProductionRunner(makeBinding());
  const scene = await runner({ release: { id: "r-1", agentId: "agent-01" }, stage: "visual", stageInputs: { title: "T" } });
  assert.equal(scene.success, true);
  assert.equal(scene.descriptor.contentSha256, sha256(FRAME_BYTES));
  assert.equal(scene.outputPath, "/stph/media/visuals/prodrun-r-1.png");

  const thumb = await runner({ release: { id: "r-1", agentId: "agent-01" }, stage: "packaging", stageInputs: { title: "T" } });
  assert.equal(thumb.success, true);
  assert.equal(thumb.descriptor.contentSha256, sha256(THUMB_BYTES));
  assert.equal(thumb.outputPath, "/stph/media/thumbnails/prodrun-r-1-thumb.png");
});

test("bound runner returns the truthful WAITING result without provider capacity", async () => {
  const runner = bindProductionRunner(makeBinding({ overrides: { tts: { registry: {} } } }));
  const result = await runner({ release: { id: "r-1", agentId: "agent-01" }, stage: "audio", stageInputs: { title: "T" } });
  assert.deepEqual(result, waitingResult("CREDENTIAL_MISSING"), "no fabricated media — durable honest wait");
});

test("Director isolation: the binding refuses any other Director", async () => {
  const runner = bindProductionRunner(makeBinding({ agentId: "agent-01" }));
  await assert.rejects(
    () => runner({ release: { id: "r-2", agentId: "agent-02" }, stage: "audio", stageInputs: {} }),
    /RUNNER_AGENT_MISMATCH/,
  );
  assert.deepEqual([...PRODUCTION_RUNNER_ERROR_CODES].sort(), [
    "RUNNER_AGENT_MISMATCH",
    "RUNNER_PLAN_UNBUILDABLE",
    "RUNNER_REGISTRY_INVALID",
    "RUNNER_REQUEST_INVALID",
  ]);
  assert.equal(PRODUCTION_RUNNER_VERSION, "production_executor_runner_v1");
});

test("assembly stage executes the REAL FFmpeg executor against the release's own artifacts", async () => {
  const runner = bindProductionRunner(makeBinding());
  const result = await runner({
    release: { id: "r-1", agentId: "agent-01" },
    stage: "assembly",
    recordedArtifacts: [
      { stage: "audio", agentId: "agent-01", sha256: sha256(NARRATION_BYTES), descriptor: { producer: { agentId: "agent-01" } } },
      { stage: "visual", agentId: "agent-01", sha256: sha256(FRAME_BYTES), descriptor: { producer: { agentId: "agent-01" } } },
    ],
    artifactBindings: {
      [`sha256:${sha256(NARRATION_BYTES)}`]: { descriptor: { descriptorType: "st_media_artifact_descriptor", contentSha256: sha256(NARRATION_BYTES), durationSeconds: null }, path: "/stph/media/audio/prodrun.mp3" },
      [`sha256:${sha256(FRAME_BYTES)}`]: { descriptor: { descriptorType: "st_media_artifact_descriptor", contentSha256: sha256(FRAME_BYTES), durationSeconds: null }, path: "/stph/media/visuals/prodrun.png" },
    },
  });
  assert.equal(result.success, true, "30–50 min QC passes on the real measured duration");
  assert.equal(result.descriptor.contentSha256, sha256(EPISODE_BYTES));
  assert.equal(result.qc.policy, "main_video_runtime");
});

test("buildLongformAssemblyPlan declares the 30–50 minute main-video QC target", () => {
  const plan = buildLongformAssemblyPlan({
    agentId: "agent-01",
    productionRunId: "prodrun",
    narrationArtifact: { sha256: "a".repeat(64) },
    visualArtifact: { sha256: "b".repeat(64) },
  });
  assert.equal(plan.outputTarget, "main_longform");
  assert.equal(plan.segments[0].durationSeconds, 1890, "planned duration inside the 1800–3000s window");
  assert.equal(plan.segments[0].artifactRef, `sha256:${"b".repeat(64)}`);
  assert.equal(plan.segments[1].kind, "voice");
});

// ---------------------------------------------------------------------------
// Full production path: Hermes-shaped job → worker loop → verified media
// ---------------------------------------------------------------------------

async function buildHarness({ withRunner } = {}) {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const production = new ProductionRepository(db);
  await db.query("INSERT INTO agents (id, name, namespace, enabled) VALUES ($1,$2,$3,$4)", ["agent-01", "JARVIS", "st.agent.jarvis", true]);
  const ownerId = randomUUID();
  await db.query("INSERT INTO owners (id,email,password_hash,role,status) VALUES ($1,$2,$3,$4,$5)", [ownerId, "owner@187.test", "x".repeat(64), "owner", "authenticated"]);
  const channelId = randomUUID();
  await db.query(
    "INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [channelId, ownerId, "prod-187", "Prod Test", "tag", "Hindi", "agent-01"],
  );
  const { release, jobId } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Prod Runner Episode", season: 1, episode: 1,
  });

  const jobs = {
    updateStatus: async (id, status, detail) => { jobs.calls.push({ id, status, detail }); },
    calls: [],
  };
  const evidence = [];
  const worker = new ProductionWorkerLoop({
    jobsRepository: jobs,
    productionRepository: production,
    evidenceLedger: { append: async (event) => { evidence.push(event); return { ok: true }; } },
    executorRunnerFactory: withRunner ? ({ agentId }) => bindProductionRunner(makeBinding({ agentId })) : null,
    log: () => {},
  });
  const job = {
    id: jobId,
    agent_id: "agent-01",
    attempts: 0,
    max_attempts: 3,
    payload: JSON.stringify({ releaseId: release.id, channelId }),
    owner_id: ownerId,
  };
  return { db, production, ownerId, release, jobId, jobs, worker, job, evidence };
}

test("worker loop with runner factory: claimed job produces the CANONICAL package (main + 2 content reels + brand reel + packaging + QC)", async () => {
  const h = await buildHarness({ withRunner: true });
  await h.worker.process(h.job);

  const artifacts = await h.production.listArtifactsForRelease(h.ownerId, h.release.id);
  const byStage = new Map(artifacts.map((a) => [a.stage, a]));
  assert.equal(byStage.get("audio")?.generationMode, "provider_generated");
  assert.equal(byStage.get("audio")?.ffprobeVerified, true);
  assert.equal(byStage.get("assembly")?.generationMode, "provider_generated");
  // Canonical short-form package (Issue #189): three bridge-recorded reels.
  const reelArtifacts = artifacts.filter((a) => a.stage === "reels");
  assert.equal(reelArtifacts.length, 3, "2 content reels + 1 brand reel recorded");
  assert.ok(reelArtifacts.every((a) => a.generationMode === "provider_generated" && a.ffprobeVerified === true));
  assert.ok(
    new Set(reelArtifacts.map((a) => a.sha256)).size === 3,
    "the three reels are genuinely distinct media (independent content, distinct brand reel)",
  );
  assert.ok(byStage.get("thumbnail"), "thumbnail recorded via packaging");
  assert.ok(byStage.get("packaging"), "episode + canonical manifests recorded");
  assert.ok(byStage.get("qc"), "QC verdict recorded");
  const release = await h.production.getRelease(h.ownerId, h.release.id);
  assert.equal(release.status, "review", "QC-approved release reaches the owner gate");
});

test("worker loop without runner factory: deterministic pipeline unchanged (default)", async () => {
  const h = await buildHarness({ withRunner: false });
  await h.worker.process(h.job);
  const artifacts = await h.production.listArtifactsForRelease(h.ownerId, h.release.id);
  assert.ok(artifacts.length > 0);
  assert.ok(artifacts.every((a) => a.generationMode === "deterministic_local"), "no real media claimed without the runner");
});

test("worker loop re-queues durable waits within the retry budget, then fails honestly", async () => {
  const h = await buildHarness({ withRunner: true });
  // All providers without capacity → the runner returns truthful waits.
  h.worker.executorRunnerFactory = ({ agentId }) => bindProductionRunner(makeBinding({
    agentId,
    overrides: { tts: { registry: {} }, visual: { registry: {} } },
  }));

  // Attempt 1: wait → the job's metadata carries the wait, then the worker
  // re-queues for scheduler resume.
  h.job.attempts = 1;
  await h.worker.process(h.job);
  assert.ok(h.jobs.calls.some((c) => c.detail?.waitingForQuota === true), "wait attached to the job");
  assert.ok(h.jobs.calls.some((c) => c.status === "queued"), "re-queued for resume");
  const release1 = await h.production.getRelease(h.ownerId, h.release.id);
  assert.equal(release1.status, "planned", "waiting release re-plans for scheduler resume");

  // Budget exhausted: honest failure, no fabricated success (the pipeline's
  // wait marker fires first; the worker then fails the job instead of
  // re-queueing an exhausted retry budget).
  h.jobs.calls.length = 0;
  h.job.attempts = 3;
  h.job.max_attempts = 3;
  await h.worker.process(h.job);
  assert.ok(h.jobs.calls.some((c) => c.status === "failed"), "wait budget exhausted → job failed");
  assert.ok(!h.jobs.calls.some((c) => c.status === "queued"), "no infinite re-queue beyond the retry budget");
});

test("worker runner factory receives the claimed job's own agent id", async () => {
  const h = await buildHarness({ withRunner: true });
  const seen = [];
  h.worker.executorRunnerFactory = ({ job, agentId }) => {
    seen.push({ jobId: job?.id, agentId });
    return bindProductionRunner(makeBinding({ agentId }));
  };
  await h.worker.process(h.job);
  assert.deepEqual(seen, [{ jobId: h.jobId, agentId: "agent-01" }]);
});
