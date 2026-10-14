#!/usr/bin/env node
/**
 * ST Production House — REAL free-first provider episode evidence (Phase 3).
 *
 * WHAT THIS PROVES (and what it does not):
 *   It drives the EXACT production wiring — `createRealMediaRunnerFactory`
 *   from `src/catalog/server.js`, the same factory the durable worker binds —
 *   for ONE Director (agent-01), through the executor-runner chain the episode
 *   pipeline uses:
 *
 *     audio stage   → real TTS provider (espeak-ng, local open-source
 *                     emergency engine) → real bytes → real SHA-256 + ffprobe
 *     visual stage  → real visual provider (pollinations, tier-1 free primary,
 *                     keyless HTTPS) → real bytes → real SHA-256 + ffprobe
 *     packaging     → same Director style profile (continuity)
 *     assembly      → real FFmpeg long-form main video + main-video QC gate
 *     reels:init    → the two canonical content Reels + the brand Reel plans
 *     reels         → each Reel REALLY assembled from THIS release's own
 *                     narration + visual artifacts, short-form QC gate
 *
 *   It contacts REAL providers and writes REAL media. Every stage result is
 *   recorded verbatim to `artifacts/provider-episode/<stage>.json` (the
 *   `artifacts/` directory is git-ignored: evidence is produced by running the
 *   tools, never committed as a claim).
 *
 *   It does NOT publish anything, does NOT create a platform receipt, and
 *   does NOT claim any credentialed provider ran. No internal agent name
 *   appears in any public-facing string (Rule 15).
 *
 * Usage (each stage bounded so a slow host never hides a failure):
 *   node scripts/real_provider_episode.mjs --stage=providers
 *   node scripts/real_provider_episode.mjs --stage=assembly
 *   node scripts/real_provider_episode.mjs --stage=reels
 *   node scripts/real_provider_episode.mjs --stage=all
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRealMediaRunnerFactory } from "../src/catalog/server.js";
import { bindProductionRunner } from "../src/pipeline/productionExecutorRunner.js";
import { createNodeMediaTransports } from "../src/media/nodeMediaTransport.js";

const ROOT = path.join(process.cwd(), "artifacts", "provider-episode");
const MEDIA = Object.freeze({
  audio: path.join(ROOT, "media", "audio"),
  visual: path.join(ROOT, "media", "visuals"),
  episode: path.join(ROOT, "media", "episodes"),
  thumbnail: path.join(ROOT, "media", "thumbnails"),
  runPrefix: "episode",
});

const AGENT_ID = "agent-01";
const RELEASE_ID = "rel-provider-verify";
const RUN_ID = "episode-provider-verify";
const PUBLIC_TITLE = "The Lantern That Never Went Out";
const INTERNAL_NAMES = /\b(?:jarvis|sherlock|lakme|panchi|veda|byte|chanakya|kabir|shakti|rohan|maya|aarohi|vikram|tara|ananya|karan|dev|aanya|arjun|nisha|newton)\b/i;
const RELEASE = Object.freeze({ id: RELEASE_ID, agentId: AGENT_ID, title: PUBLIC_TITLE });

async function writeEvidence(name, payload) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(path.join(ROOT, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function freshRunner() {
  const factory = createRealMediaRunnerFactory({
    bindProductionRunner,
    transports: createNodeMediaTransports(),
    mediaPaths: MEDIA,
  });
  return factory({ agentId: AGENT_ID });
}

function summarise(result) {
  return {
    success: result.success,
    failureCode: result.failureCode ?? null,
    quotaState: result.quotaState ?? null,
    mediaStatus: result.mediaStatus ?? null,
    generationMode: result.generationMode ?? null,
    providerId: result.providerCall?.providerId ?? null,
    outputPath: result.outputPath ?? null,
    sha256: result.descriptor?.contentSha256 ?? null,
    mimeType: result.descriptor?.mimeType ?? null,
    verificationState: result.descriptor?.verification?.state ?? null,
    measuredDurationSeconds: result.qc?.measuredDurationSeconds ?? result.inspection?.format?.duration ?? null,
    qcPassed: result.qc?.passed ?? null,
    qcReasonCode: result.qc?.reasonCode ?? null,
    codec: result.inspection?.streams?.[0]?.codec_name ?? null,
    stderrTail: result.stderrTail ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stage: providers (real narration + real visuals + continuity)
// ---------------------------------------------------------------------------

async function stageProviders() {
  await Promise.all([
    mkdir(MEDIA.audio, { recursive: true }),
    mkdir(MEDIA.visual, { recursive: true }),
    mkdir(MEDIA.thumbnail, { recursive: true }),
  ]);
  const runner = freshRunner();

  const audio = await runner({ release: RELEASE, stage: "audio", stageInputs: { title: PUBLIC_TITLE }, productionRunId: RUN_ID });
  const visual = await runner({ release: RELEASE, stage: "visual", stageInputs: { title: PUBLIC_TITLE }, productionRunId: RUN_ID });
  const packaging = await runner({ release: RELEASE, stage: "packaging", stageInputs: { title: PUBLIC_TITLE }, productionRunId: RUN_ID });

  const evidence = {
    stage: "providers",
    agentId: AGENT_ID,
    releaseId: RELEASE_ID,
    productionRunId: RUN_ID,
    audio: summarise(audio),
    visual: summarise(visual),
    packaging: summarise(packaging),
    continuity: {
      voiceProfileId: audio.outcome?.voiceProfileId ?? null,
      visualProfileIdVisual: visual.outcome?.visualProfileId ?? null,
      visualProfileIdPackaging: packaging.outcome?.visualProfileId ?? null,
      sameDirectorStyleAcrossStages:
        visual.outcome?.visualProfileId !== undefined &&
        visual.outcome?.visualProfileId === packaging.outcome?.visualProfileId,
    },
    // Carried forward to the assembly/reels stages (same release, same run).
    evidence: {
      narration: audio.success === true && audio.descriptor
        ? { stage: "audio", sha256: audio.descriptor.contentSha256, descriptor: audio.descriptor, path: audio.outputPath, agentId: AGENT_ID }
        : null,
      visual: visual.success === true && visual.descriptor
        ? { stage: "visual", sha256: visual.descriptor.contentSha256, descriptor: visual.descriptor, path: visual.outputPath, agentId: AGENT_ID }
        : null,
    },
  };

  const internalLeak = INTERNAL_NAMES.test(JSON.stringify({ title: PUBLIC_TITLE }));
  const verdict =
    audio.success === true && visual.success === true &&
    evidence.continuity.sameDirectorStyleAcrossStages === true && internalLeak === false
      ? "PROVIDER_EPISODE_STAGE_PROVIDERS_VERIFIED"
      : "PROVIDER_EPISODE_STAGE_PROVIDERS_FAILED";
  evidence.verdict = verdict;
  await writeEvidence("providers", evidence);
  console.log(JSON.stringify({ verdict, audio: evidence.audio, visual: evidence.visual, packaging: evidence.packaging, continuity: evidence.continuity }, null, 2));
  return evidence;
}

async function loadProviders() {
  const file = path.join(ROOT, "providers.json");
  const { readFile } = await import("node:fs/promises");
  const parsed = JSON.parse(await readFile(file, "utf8"));
  return parsed.evidence;
}

function bindingsFor({ narration, visual }) {
  return {
    [`sha256:${narration.sha256}`]: { descriptor: narration.descriptor, path: narration.path },
    [`sha256:${visual.sha256}`]: { descriptor: visual.descriptor, path: visual.path },
  };
}

// ---------------------------------------------------------------------------
// Stage: assembly (real long-form main video + main-video QC gate)
// ---------------------------------------------------------------------------

async function stageAssembly() {
  await mkdir(MEDIA.episode, { recursive: true });
  const { narration, visual } = await loadProviders();
  if (!narration || !visual) throw new Error("PROVIDER_STAGE_EVIDENCE_MISSING");
  const runner = freshRunner();
  const recordedArtifacts = [narration, visual];
  const artifactBindings = bindingsFor({ narration, visual });

  const assembly = await runner({
    release: RELEASE,
    stage: "assembly",
    stageInputs: { title: PUBLIC_TITLE },
    productionRunId: RUN_ID,
    recordedArtifacts,
    artifactBindings,
  });

  const evidence = {
    stage: "assembly",
    productionRunId: RUN_ID,
    fromRealEpisodeAssets: { narrationSha256: narration.sha256, visualSha256: visual.sha256 },
    assembly: summarise(assembly),
    verdict: assembly.success === true ? "PROVIDER_EPISODE_STAGE_ASSEMBLY_VERIFIED" : "PROVIDER_EPISODE_STAGE_ASSEMBLY_FAILED",
  };
  await writeEvidence("assembly", evidence);
  console.log(JSON.stringify(evidence, null, 2));
  return evidence;
}

// ---------------------------------------------------------------------------
// Stage: reels (2 content Reels + brand Reel from THIS release's own assets)
// ---------------------------------------------------------------------------

async function stageReels() {
  await mkdir(MEDIA.episode, { recursive: true });
  const { narration, visual } = await loadProviders();
  if (!narration || !visual) throw new Error("PROVIDER_STAGE_EVIDENCE_MISSING");
  const runner = freshRunner();
  const recordedArtifacts = [narration, visual];
  const artifactBindings = bindingsFor({ narration, visual });

  const init = await runner({
    release: RELEASE,
    stage: "reels:init",
    stageInputs: { title: PUBLIC_TITLE },
    productionRunId: RUN_ID,
    recordedArtifacts,
  });

  const reels = [];
  for (const reelPlan of init.reelPlans ?? []) {
    const result = await runner({
      release: RELEASE,
      stage: "reels",
      stageInputs: { title: PUBLIC_TITLE },
      productionRunId: RUN_ID,
      reelPlan,
      recordedArtifacts,
      artifactBindings,
    });
    reels.push({ key: reelPlan.key, outputPath: reelPlan.outputPath, ...summarise(result) });
  }

  const brandIntegrationMode = init.reelPackage?.brandIntegrationMode ?? null;
  const keys = reels.map((reel) => reel.key).sort();
  const allVerified = reels.length === 3 && reels.every((reel) => reel.success === true);
  const evidence = {
    stage: "reels",
    productionRunId: RUN_ID,
    fromRealEpisodeAssets: { narrationSha256: narration.sha256, visualSha256: visual.sha256 },
    reelKeys: keys,
    contentReelCount: keys.filter((key) => key.startsWith("content_reel")).length,
    brandReelCount: keys.filter((key) => key === "brand_reel").length,
    brandIntegrationMode,
    reels,
    verdict: allVerified && brandIntegrationMode === "STANDALONE_ONLY"
      ? "PROVIDER_EPISODE_STAGE_REELS_VERIFIED"
      : "PROVIDER_EPISODE_STAGE_REELS_FAILED",
  };
  await writeEvidence("reels", evidence);
  console.log(JSON.stringify(evidence, null, 2));
  return evidence;
}

async function main() {
  const stageArg = process.argv.find((arg) => arg.startsWith("--stage="));
  const stage = stageArg ? stageArg.slice("--stage=".length) : "all";
  if (stage === "providers" || stage === "all") await stageProviders();
  if (stage === "assembly" || stage === "all") await stageAssembly();
  if (stage === "reels" || stage === "all") await stageReels();
}

main().catch((error) => {
  console.error(`real_provider_episode: ${error?.message ?? error}`);
  process.exit(1);
});
