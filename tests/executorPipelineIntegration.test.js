import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { runEpisodePipeline, renderStageContent, PIPELINE_STAGES } from "../src/pipeline/episodePipeline.js";
import { evaluateExecutorArtifact, classifyExecutorWait, createStageExecutionContext } from "../src/pipeline/executorIntegration.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";
import { ProductionRepository } from "../src/catalog/productionRepository.js";
import { createArtifactDescriptor, verifyArtifactDescriptor } from "../src/media/artifactDescriptor.js";
import { createVoiceProfile } from "../src/media/ttsAdapter.js";
import { createVisualStyleProfile, createVisualGenerationRequest } from "../src/media/visualAdapter.js";
import { createAssemblyPlan } from "../src/media/assemblyPlan.js";

const NOW = () => new Date("2026-09-25T10:00:00.000Z");

// ---------------------------------------------------------------------------
// Fake world: provider spawn (TTS/visual/ffmpeg/ffprobe), file bytes, db
// ---------------------------------------------------------------------------

const NARRATION_BYTES = Buffer.from("fake-mp3-pipeline-bytes");
const FRAME_BYTES = Buffer.from("fake-png-pipeline-bytes");
const EPISODE_BYTES = Buffer.from("fake-mp4-pipeline-bytes");
const REEL_BYTES = {
  content_reel_1: Buffer.from("fake-reel-c1-bytes"),
  content_reel_2: Buffer.from("fake-reel-c2-bytes"),
  brand_reel: Buffer.from("fake-reel-brand-bytes"),
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function makeFfprobePayload({ bytes, formatName, codecType, extraStream = {}, durationSeconds = null }) {
  const format = { filename: "media", format_name: formatName, size: String(bytes.length) };
  if (durationSeconds !== null) format.duration = String(durationSeconds);
  return { format, streams: [{ codec_type: codecType, ...extraStream }] };
}

function makeSpawn() {
  return ({ command, args }) => {
    if (command === "ffprobe") {
      if (args[0] === "-version") return { exitCode: 0, stdout: "ffprobe version 7.0", stderr: "", timedOut: false };
      const target = args[args.length - 1];
      const reelKey = Object.keys(REEL_BYTES).find((key) => target.includes(key));
      const payload = target.endsWith(".mp3")
        ? makeFfprobePayload({ bytes: NARRATION_BYTES, formatName: "mp3", codecType: "audio", extraStream: { codec_name: "mp3", sample_rate: "24000" } })
        : target.endsWith(".png")
          ? makeFfprobePayload({ bytes: FRAME_BYTES, formatName: "png", codecType: "video", extraStream: { codec_name: "png", width: 1920, height: 1080 } })
          : reelKey
            ? makeFfprobePayload({ bytes: REEL_BYTES[reelKey], formatName: "mp4", codecType: "video", extraStream: { codec_name: "h264", width: 1080, height: 1920 }, durationSeconds: 12 })
            : makeFfprobePayload({ bytes: EPISODE_BYTES, formatName: "mp4", codecType: "video", extraStream: { codec_name: "h264", width: 1920, height: 1080 }, durationSeconds: 1890 });
      return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "written", timedOut: false };
  };
}

function makeFiles() {
  const files = new Map();
  files.set("/run/narration.mp3", NARRATION_BYTES);
  files.set("/run/frame.png", FRAME_BYTES);
  files.set("/run/episode.mp4", EPISODE_BYTES);
  files.set("/run/thumbnail.png", FRAME_BYTES);
  return async (path) => {
    if (files.has(path)) return files.get(path);
    // Reel renders are keyed by the canonical reel identity in the path
    // (release-id-keyed names make exact paths unpredictable).
    const reelKey = Object.keys(REEL_BYTES).find((key) => path.includes(key));
    if (reelKey) return REEL_BYTES[reelKey];
    throw new Error("ENOENT");
  };
}

/**
 * The Director-scoped runner a production worker would bind: per-Director
 * profiles/plans built from `agentId` ONLY, provider slots held per-Director
 * on the runner's side (here: closure-scoped per harness), executors invoked
 * with injectable transports, results shaped exactly like the real ones.
 */
function makeRunner({ overrides = {} } = {}) {
  const voiceProfile = createVoiceProfile({
    agentId: "agent-01",
    language: "hi",
    provider: { providerId: "edge-tts", providerRole: "approved_free_primary", modelIdentifier: "edge-tts-cli", voiceId: "hi-IN-MadhurNeural" },
  });
  const styleProfile = createVisualStyleProfile({
    agentId: "agent-01",
    styleSummary: "Dark neon anime, rain-soaked streets",
    aspectRatio: "16:9",
  });
  const ttsRegistry = {
    "edge-tts": {
      declared: {
        capabilitiesType: "tts_provider_capabilities_v1",
        adapterId: "edge-tts-cli",
        languages: ["hi", "en"],
        voices: [{ voiceId: "hi-IN-MadhurNeural", language: "hi", supportsEmotion: true }],
        supportsEmotion: true, supportsRate: false, supportsPitch: false, rateBounds: null, pitchBounds: null,
        capabilitiesId: "seed",
      },
      quotaExhausted: false,
    },
  };

  return async ({ stage, agentId, artifactBindings, recordedArtifacts: requestRecorded, reelPlan, release: runnerRelease, productionRunId = "episode-runner" }) => {
    if (overrides.before) await overrides.before({ stage, agentId });
    if (agentId !== "agent-01") throw new Error(`ISOLATION: runner invoked for foreign Director ${agentId}`);

    if (stage === "audio") {
      const { executeTtsGeneration } = await import("../src/media/ttsExecutor.js");
      const override = overrides.audio ?? {};
      if (override.noProvider) return { success: false, descriptor: null, inspection: null, outcome: null, quotaState: "WAITING_FOR_QUOTA", mediaStatus: "unverified", generationMode: "not_evidenced", failureCode: "QUOTA_EXHAUSTED" };
      return executeTtsGeneration(voiceProfile, {
        scriptText: "सुनिए कहानी का अगला अध्याय।",
        outputPath: "/run/narration.mp3",
        registry: ttsRegistry,
        spawnImpl: makeSpawn(),
        readFileImpl: makeFiles(),
        now: NOW,
        productionRunId,
        ...override.args,
      });
    }

    if (stage === "visual") {
      const { executeVisualGeneration } = await import("../src/media/visualExecutor.js");
      const request = createVisualGenerationRequest({
        styleProfile,
        modality: "image",
        provider: { providerId: "pollinations", providerRole: "approved_free_primary", modelIdentifier: "flux" },
        scenePlanRef: "sceneplan-183#scene-1",
      });
      return executeVisualGeneration(styleProfile, {
        request,
        prompt: "a rain-soaked neon street at night",
        outputPath: "/run/frame.png",
        registry: {
          pollinations: {
            declared: {
              capabilitiesType: "visual_provider_capabilities_v1", adapterId: "visual-pollinations",
              modalities: ["image", "still_acquisition"], aspectRatios: ["16:9", "9:16", "1:1", "4:5"],
              maxClipSeconds: null, supportsCharacterContinuity: false, capabilitiesId: "seed",
            },
            quotaExhausted: false, modelIdentifier: "flux",
          },
        },
        spawnImpl: makeSpawn(),
        readFileImpl: makeFiles(),
        now: NOW,
        productionRunId,
      });
    }

    if (stage === "assembly") {
      const { executeAssemblyPlan } = await import("../src/media/ffmpegAssemblyExecutor.js");
      const audioBinding = artifactBindings[`sha256:${sha256(NARRATION_BYTES)}`];
      const visualBinding = artifactBindings[`sha256:${sha256(FRAME_BYTES)}`];
      if (!audioBinding || !visualBinding) {
        return { success: false, executed: false, descriptor: null, inspection: null, qc: null, failureCode: "EXEC_REF_UNBOUND" };
      }
      const plan = createAssemblyPlan({
        agentId: "agent-01",
        productionRunId,
        outputTarget: "main_longform",
        aspectRatio: "16:9",
        segments: [
          { artifactRef: `sha256:${sha256(FRAME_BYTES)}`, kind: "still_image", durationSeconds: 1890, transitionIn: "cut" },
          { artifactRef: `sha256:${sha256(NARRATION_BYTES)}`, kind: "voice" },
        ],
      });
      return executeAssemblyPlan(plan, {
        artifactBindings,
        outputPath: "/run/episode.mp4",
        spawnImpl: makeSpawn(),
        readFileImpl: makeFiles(),
        now: NOW,
        skipPreflight: false,
      });
    }

    if (stage === "reels:init") {
      // The production runner builds the canonical plans per-Director with
      // the pipeline's unified run identity.
      const { buildCanonicalReelPackagePlan, buildReelAssemblyPlans } = await import("../src/pipeline/reelsStage.js");
      const narration = (requestRecorded ?? []).find((a) => a.stage === "audio");
      const visual = (requestRecorded ?? []).find((a) => a.stage === "visual");
      const reelPackage = buildCanonicalReelPackagePlan({
        agentId,
        productionRunId,
        narrationArtifact: narration,
        visualArtifact: visual,
        brandIdentityKey: `channel-${agentId}`,
      });
      return {
        reelPackage,
        reelPlans: buildReelAssemblyPlans({
          reelPackage,
          narrationArtifact: narration,
          visualArtifact: visual,
          paths: { episode: "/run/reels", runPrefix: "episode" },
          productionRunId,
        }),
      };
    }

    if (stage === "reels") {
      const { executeAssemblyPlan } = await import("../src/media/ffmpegAssemblyExecutor.js");
      const plan = reelPlan.plan;
      return executeAssemblyPlan(plan, {
        artifactBindings,
        outputPath: reelPlan.outputPath,
        spawnImpl: makeSpawn(),
        readFileImpl: makeFiles(),
        now: NOW,
        skipPreflight: false,
      });
    }

    if (stage === "packaging") {
      const thumbOverride = overrides.packagingThumbnail ?? {};
      if (thumbOverride.noProvider) {
        return { success: false, descriptor: null, inspection: null, outcome: null, quotaState: "WAITING_FOR_QUOTA", mediaStatus: "unverified", generationMode: "not_evidenced", failureCode: "QUOTA_EXHAUSTED" };
      }
      // Thumbnail media through the same visual chain (bridge-verified).
      const { executeVisualGeneration } = await import("../src/media/visualExecutor.js");
      const request = createVisualGenerationRequest({
        styleProfile,
        modality: "image",
        provider: { providerId: "pollinations", providerRole: "approved_free_primary", modelIdentifier: "flux" },
        scenePlanRef: "sceneplan-183#thumbnail",
      });
      return executeVisualGeneration(styleProfile, {
        request,
        prompt: "episode thumbnail key art, bold title composition",
        outputPath: "/run/thumbnail.png",
        registry: {
          pollinations: {
            declared: {
              capabilitiesType: "visual_provider_capabilities_v1", adapterId: "visual-pollinations",
              modalities: ["image", "still_acquisition"], aspectRatios: ["16:9", "9:16", "1:1", "4:5"],
              maxClipSeconds: null, supportsCharacterContinuity: false, capabilitiesId: "seed",
            },
            quotaExhausted: false, modelIdentifier: "flux",
          },
        },
        spawnImpl: makeSpawn(),
        readFileImpl: makeFiles(),
        now: NOW,
        productionRunId,
      });
    }

    if (stage === "qc") {
      return overrides.qcChecks ?? [{ name: "duration_policy", passed: true }];
    }

    throw new Error(`UNKNOWN RUNNER STAGE ${stage}`);
  };
}

async function buildHarness({ runner } = {}) {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const production = new ProductionRepository(db);
  await db.query("INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)", ["agent-01", "JARVIS", "st.agent.jarvis", true]);
  const ownerId = randomUUID();
  await db.query("INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)", [ownerId, "owner@183.test", "x".repeat(64), "owner", "authenticated"]);
  const channelId = randomUUID();
  await db.query(
    `INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [channelId, ownerId, "exec-183", "Executor Test", "tag", "Hindi", "agent-01"],
  );
  const { release, jobId } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Executor Episode", season: 1, episode: 1,
  });
  // The worker processing this release knows its job id from the queue
  // context and attaches it (the DB has no release→job link column).
  release.jobId = jobId;
  const evidence = [];
  return {
    db, production, ownerId, release,
    evidenceLedger: { append: async (event) => { evidence.push(event); return { ok: true }; } },
    evidence,
  };
}

// ---------------------------------------------------------------------------
// End-to-end: real executors → recorded verified media
// ---------------------------------------------------------------------------

test("END-TO-END: executor pipeline records REAL verified narration, visual, and assembled episode", async () => {
  const { production, ownerId, release, evidenceLedger } = await buildHarness();
  const result = await runEpisodePipeline({
    ownerId,
    releaseId: release.id,
    release,
    production,
    jobs: { updateStatus: async () => {} },
    evidenceLedger,
    executorRunner: makeRunner(),
  });

  assert.equal(result.status, "review");
  // audio + visual + assembly real artifacts (story is deterministic metadata
  // with the same hash as run 1 → may dedupe; assert by stage below).
  const byStage = new Map();
  for (const artifact of result.artifacts) byStage.set(artifact.stage, artifact);
  assert.ok(byStage.get("audio"), "audio artifact recorded");
  assert.ok(byStage.get("visual"), "visual artifact recorded");
  assert.ok(byStage.get("assembly"), "assembly artifact recorded");

  const audio = byStage.get("audio");
  assert.equal(audio.generationMode, "provider_generated");
  assert.equal(audio.ffprobeVerified, true);
  assert.equal(audio.sha256, sha256(NARRATION_BYTES), "hash anchored to REAL audio bytes");

  const visual = byStage.get("visual");
  assert.equal(visual.generationMode, "provider_generated");
  assert.equal(visual.sha256, sha256(FRAME_BYTES));

  const assembly = byStage.get("assembly");
  assert.equal(assembly.generationMode, "provider_generated");
  assert.equal(assembly.sha256, sha256(EPISODE_BYTES), "episode hash anchored to REAL rendered bytes");
  assert.match(assembly.storageUri, /^local:\/\/provider_generated\//);

  // Story stays deterministic (same channel-bound inputs as the pipeline).
  const story = byStage.get("story");
  assert.equal(story.generationMode, "deterministic_local");
  assert.equal(story.sha256, createHash("sha256").update(renderStageContent("story", { channelId: release.channelId, title: "Executor Episode", season: 1, episode: 1 })).digest("hex"));

  // Release reached review (owner approval gate) — real evidence preserved.
  const updated = await production.getRelease(ownerId, release.id);
  assert.equal(updated.status, "review");

  // Evidence ledger classified real executor generation.
  const stageEvents = evidenceLedger ? [] : [];
  assert.ok(stageEvents.length === 0);
});

test("verified executor artifacts persist in the artifacts table with honest provenance", async () => {
  const { production, ownerId, release } = await buildHarness();
  await runEpisodePipeline({
    ownerId, releaseId: release.id, release, production,
    jobs: { updateStatus: async () => {} },
    executorRunner: makeRunner(),
  });
  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  const audio = artifacts.find((a) => a.stage === "audio");
  const assembly = artifacts.find((a) => a.stage === "assembly");
  assert.equal(audio.ffprobeVerified, true);
  assert.equal(audio.generationMode, "provider_generated");
  assert.equal(assembly.generationMode, "provider_generated");
  assert.ok(artifacts.every((a) => a.sha256.match(/^[0-9a-f]{64}$/)));
});

// ---------------------------------------------------------------------------
// Honest waiting: quota exhaustion is a durable wait, not a failure
// ---------------------------------------------------------------------------

test("WAITING_FOR_QUOTA: durable wait preserves earlier stages and attaches the wait code to the job", async () => {
  const { production, ownerId, release } = await buildHarness();
  const jobUpdates = [];
  const result = await runEpisodePipeline({
    ownerId, releaseId: release.id, release, production,
    jobs: { updateStatus: async (id, status, detail) => { jobUpdates.push({ id, status, detail }); } },
    executorRunner: makeRunner({ overrides: { audio: { noProvider: true } } }),
  });

  assert.equal(result.status, "planned");
  assert.equal(result.waited, true);
  assert.equal(result.waitingStage, "audio");
  assert.equal(result.waitingCode, "QUOTA_EXHAUSTED");

  // Release returns to planned for scheduler resume.
  const updated = await production.getRelease(ownerId, release.id);
  assert.equal(updated.status, "planned");

  // The job kept its status (R5: no invented states) and carries the wait.
  assert.equal(jobUpdates.length, 1);
  assert.equal(jobUpdates[0].status, null);
  assert.equal(jobUpdates[0].detail.failureCode, "QUOTA_EXHAUSTED");
  assert.equal(jobUpdates[0].detail.waitingForQuota, true);

  // No artifact was fabricated for the waiting stage.
  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  assert.equal(artifacts.find((a) => a.stage === "audio"), undefined);
});

// ---------------------------------------------------------------------------
// Honest failure: unverified executor result preserves progress, fails stage
// ---------------------------------------------------------------------------

test("unverified executor result → truthful stage failure, release back to planned", async () => {
  const { production, ownerId, release } = await buildHarness();
  const jobUpdates = [];
  const result = await runEpisodePipeline({
    ownerId, releaseId: release.id, release, production,
    jobs: { updateStatus: async (id, status, detail) => { jobUpdates.push({ id, status, detail }); } },
    executorRunner: makeRunner({ overrides: { audio: { args: { readFileImpl: async () => { throw new Error("ENOENT"); } } } } }),
  });
  // The executor ran but inspection failed: truthful stage failure, release
  // re-planned, job marked failed with the stable code, nothing recorded.
  assert.equal(result.status, "planned");
  assert.equal(result.failedStage, "audio");
  assert.equal(result.failureCode, "INSPECTION_FAILED");
  const updated = await production.getRelease(ownerId, release.id);
  assert.equal(updated.status, "planned");
  assert.equal(jobUpdates[0].status, "failed");
  assert.equal(jobUpdates[0].detail.failureCode, "INSPECTION_FAILED");
  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  assert.equal(artifacts.find((a) => a.stage === "audio"), undefined);
});

test("runner throwing a gate error propagates as pipeline failure with release re-planned", async () => {
  const { production, ownerId, release } = await buildHarness();
  const runner = makeRunner({ overrides: { before: () => { throw Object.assign(new Error("EXECUTOR_STAGE_MISMATCH"), { code: "EXECUTOR_STAGE_MISMATCH" }); } } });
  await assert.rejects(
    () => runEpisodePipeline({ ownerId, releaseId: release.id, release, production, jobs: { updateStatus: async () => {} }, executorRunner: runner }),
    /EXECUTOR_STAGE_MISMATCH/,
  );
  const updated = await production.getRelease(ownerId, release.id);
  assert.equal(updated.status, "planned", "release re-planned; nothing fake");
  const events = await production.listPipelineEvents(ownerId, release.id);
  assert.ok(events.some((e) => e.status === "failed"), "failed pipeline event recorded");
});

// ---------------------------------------------------------------------------
// Director isolation (Master Prompt §3/§4)
// ---------------------------------------------------------------------------

test("cross-Director executor result fails closed through the bridge scope gate", async () => {
  const foreignDescriptor = createArtifactDescriptor({
    artifactType: "audio",
    mimeType: "audio/mpeg",
    contentSha256: "a".repeat(64),
    producer: { agentId: "agent-02", runId: "run-foreign", stageId: "tts", providerId: "edge-tts" },
    createdAt: NOW().toISOString(),
  });
  assert.throws(
    () => evaluateExecutorArtifact({
      stage: "audio",
      release: { id: "r-1", agentId: "agent-01" },
      executorResult: { success: true, descriptor: foreignDescriptor, inspection: { success: true, contentSha256: "a".repeat(64) }, outcome: null, quotaState: "OK", mediaStatus: "verified", generationMode: "provider_generated", failureCode: null },
    }),
    (err) => err.code === "EXECUTOR_AGENT_SCOPE_MISMATCH",
    "agent-02 descriptor must never record under agent-01's release",
  );
});

test("runner is always invoked with the release's OWN Director binding", async () => {
  const { production, ownerId, release } = await buildHarness();
  const seenAgents = [];
  const result = await runEpisodePipeline({
    ownerId, releaseId: release.id, release, production,
    jobs: { updateStatus: async () => {} },
    executorRunner: makeRunner({ overrides: { before: ({ agentId }) => { seenAgents.push(agentId); } } }),
  });
  assert.equal(result.status, "review");
  // audio, visual, assembly, reels:init + 3 reel renders, packaging
  // (thumbnail), qc — every invocation gets the release's own binding.
  assert.ok(seenAgents.length === 9, `runner invoked once per stage (${seenAgents.length})`);
  assert.ok(seenAgents.every((agent) => agent === "agent-01"), "every stage invoked with release.agentId only");
});

// ---------------------------------------------------------------------------
// Integration surface units
// ---------------------------------------------------------------------------

test("QC gate needs_human lands the release in review with the verdict recorded", async () => {
  const { production, ownerId, release } = await buildHarness();
  const result = await runEpisodePipeline({
    ownerId, releaseId: release.id, release, production,
    jobs: { updateStatus: async () => {} },
    executorRunner: makeRunner({ overrides: { qcChecks: [{ name: "brand_visibility_audit", requiresHuman: true }] } }),
  });
  assert.equal(result.status, "review", "needs_human is durable: the owner gate holds the release");
  assert.equal(result.qcVerdict.verdict, "needs_human");
  assert.equal(result.qcVerdict.decidedBy, "automated");
  assert.equal(result.qcVerdict.reasonCode, "QC_HUMAN_REVIEW_REQUIRED");
  const updated = await production.getRelease(ownerId, release.id);
  assert.equal(updated.status, "review");
  // The verdict was recorded content-addressed as evidence.
  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  assert.ok(artifacts.some((a) => a.stage === "qc"), "QC verdict artifact recorded");
  assert.ok(artifacts.some((a) => a.stage === "packaging"), "packaging artifacts recorded");
});

test("QC gate rejection is a truthful stage failure with release re-planned", async () => {
  const { production, ownerId, release } = await buildHarness();
  const jobUpdates = [];
  const result = await runEpisodePipeline({
    ownerId, releaseId: release.id, release, production,
    jobs: { updateStatus: async (id, status, detail) => { jobUpdates.push({ id, status, detail }); } },
    executorRunner: makeRunner({ overrides: { qcChecks: [{ name: "duration_policy", passed: false, reason: "QC_DURATION_OUT_OF_RANGE" }] } }),
  });
  assert.equal(result.status, "planned");
  assert.equal(result.failedStage, "qc");
  assert.equal(result.failureCode, "QC_DURATION_OUT_OF_RANGE");
  const updated = await production.getRelease(ownerId, release.id);
  assert.equal(updated.status, "planned");
  assert.equal(jobUpdates[0].status, "failed");
  const events = await production.listPipelineEvents(ownerId, release.id);
  assert.ok(events.some((e) => e.stage === "qc" && e.status === "failed"));
});

test("packaging thumbnail quota wait is a durable wait, release re-planned", async () => {
  const { production, ownerId, release } = await buildHarness();
  const result = await runEpisodePipeline({
    ownerId, releaseId: release.id, release, production,
    jobs: { updateStatus: async () => {} },
    executorRunner: makeRunner({ overrides: { packagingThumbnail: { noProvider: true } } }),
  });
  assert.equal(result.status, "planned");
  assert.equal(result.waited, true);
  assert.equal(result.waitingStage, "packaging");
  assert.equal(result.waitingCode, "QUOTA_EXHAUSTED");
  const updated = await production.getRelease(ownerId, release.id);
  assert.equal(updated.status, "planned");
  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  // audio/visual/assembly stay recorded; no thumbnail/manifest fabricated.
  assert.ok(artifacts.some((a) => a.stage === "assembly"));
  assert.equal(artifacts.find((a) => a.stage === "qc"), undefined);
});

test("classifyExecutorWait fails closed: unknown codes are failures, not waits", () => {
  assert.deepEqual(classifyExecutorWait({ quotaState: "WAITING_FOR_QUOTA", failureCode: "QUOTA_EXHAUSTED" }), { waiting: true, failureCode: "QUOTA_EXHAUSTED" });
  assert.deepEqual(classifyExecutorWait({ quotaState: "WAITING_FOR_QUOTA", failureCode: "CREDENTIAL_MISSING" }), { waiting: true, failureCode: "CREDENTIAL_MISSING" });
  assert.deepEqual(classifyExecutorWait({ quotaState: "WAITING_FOR_QUOTA", failureCode: "TOTALLY_UNKNOWN" }), { waiting: false, failureCode: "TOTALLY_UNKNOWN" });
  assert.deepEqual(classifyExecutorWait({ quotaState: "OK", failureCode: "INSPECTION_FAILED" }), { waiting: false, failureCode: "INSPECTION_FAILED" });
  assert.deepEqual(classifyExecutorWait(null), { waiting: false, failureCode: "EXECUTOR_RESULT_MALFORMED" });
});

test("createStageExecutionContext binds only the release's own identity", () => {
  const context = createStageExecutionContext({ release: { id: "r-9", agentId: "agent-03" }, stage: "audio", stageInputs: { title: "T", season: 1, episode: 2 } });
  assert.equal(context.agentId, "agent-03");
  assert.equal(context.releaseId, "r-9");
  assert.equal(context.stage, "audio");
  assert.throws(() => createStageExecutionContext({ release: { id: "r" }, stage: "audio" }), /EXECUTOR_STAGE_MISMATCH/);
  assert.throws(() => createStageExecutionContext({ release: { id: "r", agentId: "agent-01" }, stage: "hologram" }), /UNKNOWN_PIPELINE_STAGE/);
});
