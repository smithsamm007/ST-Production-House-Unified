/**
 * ST Production House — production executor runner (Issue #187).
 *
 * Binds the REAL media executors (TTS #179, visual #181, FFmpeg assembly
 * #175, packaging thumbnail #186) into the durable worker loop, completing
 * the chain:
 *
 *   Hermes production.start → queued episode_production job
 *     → ProductionWorkerLoop (lease claim)
 *       → THIS runner (one binding per Director)
 *         → runEpisodePipeline(executorRunner)
 *           → real executors → #182 bridge → #186 QC
 *
 * Honesty contract (Rules 1–3):
 *   - This runner NEVER fabricates a provider result. Without configured
 *     provider capacity it returns the truthful durable wait
 *     (WAITING_FOR_QUOTA) / failure (PROVIDER_UNAVAILABLE) — the release
 *     re-plans and the scheduler resumes when capacity arrives. The
 *     deterministic path remains available by NOT enabling real media.
 *   - Registries are constructed per-Director from injected capability
 *     declarations (the governed Secrets & Connections boundary supplies
 *     credential locators OUTSIDE this module; it never sees raw secrets).
 *   - Executor transports (spawn/readFile) are injectable so tests prove
 *     the binding offline; production binds node:child_process spawn
 *     (array args, shell:false) and node:fs/promises via the executors'
 *     own defaults.
 *
 * Director isolation (Master Prompt §3/§4):
 *   - One instance is bound to exactly ONE agent id (bindProductionRunner).
 *     Any invocation for a different Director fails closed
 *     (RUNNER_AGENT_MISMATCH) — no shared mutable production context.
 *   - Provider slots live in the per-binding options; they are never shared
 *     or mutated across releases.
 */

import {
  createVoiceProfile,
} from "../media/ttsAdapter.js";
import { executeTtsGeneration, ttsProviderOutputExtension } from "../media/ttsExecutor.js";
import {
  createVisualStyleProfile,
  createVisualGenerationRequest,
} from "../media/visualAdapter.js";
import { executeVisualGeneration, visualProviderOutputExtension } from "../media/visualExecutor.js";
import { executeAssemblyPlan, resolvePlanInputs, buildRenderPlan } from "../media/ffmpegAssemblyExecutor.js";
import { runLocalMotionStage } from "./motionStage.js";
import { buildCanonicalReelPackagePlan, buildReelAssemblyPlans } from "./reelsStage.js";
import {
  createAssemblyPlan,
  verifyAssemblyPlanIntegrity,
} from "../media/assemblyPlan.js";
import {
  DEFAULT_EPISODE_DURATION_SECONDS,
  EPISODE_DURATION_OPTIONS_SECONDS,
} from "../scheduling/directorSchedule.js";

export const PRODUCTION_RUNNER_VERSION = "production_executor_runner_v1";

/** Stable error codes (fail-closed). */
export const PRODUCTION_RUNNER_ERROR_CODES = Object.freeze([
  "RUNNER_AGENT_MISMATCH",
  "RUNNER_REQUEST_INVALID",
  "RUNNER_REGISTRY_INVALID",
  "RUNNER_PLAN_UNBUILDABLE",
]);

function runnerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** The truthful no-capacity result every stage may return. */
export function waitingResult(failureCode = "QUOTA_EXHAUSTED") {
  return deepFreeze({
    success: false,
    failureCode,
    quotaState: "WAITING_FOR_QUOTA",
    mediaStatus: "unverified",
    generationMode: "not_evidenced",
    descriptor: null,
    outcome: null,
    inspection: null,
    outputPath: null,
  });
}

/**
 * Validate a per-Director provider registry slot. A slot must carry
 * `declared` capabilities; anything else is a configuration error (fail
 * closed — a provider without declared capabilities is never selectable).
 */
function requireSlot(registry, providerId) {
  if (!isPlainObject(registry)) throw runnerError("RUNNER_REGISTRY_INVALID");
  const slot = registry[providerId];
  if (!isPlainObject(slot) || !isPlainObject(slot.declared)) {
    throw runnerError("RUNNER_REGISTRY_INVALID");
  }
  return slot;
}

/**
 * Build the long-form assembly plan for one release from the release's OWN
 * recorded artifacts. The plan binds the narration audio and the visual
 * program through sha256 descriptor references; the main-video target
 * declares the 30–50 minute QC window (enforced post-render by the #175
 * duration gate against REAL ffprobe measurement).
 *
 * Issue #241: when the release recorded a verified MOTION artifact, the
 * visual program is that rendered clip (`video_clip`) instead of the still
 * image. The clip fills the planned episode duration — the assembly executor
 * loops a real clip that is shorter than its planned slot, so the main-video
 * duration QC still measures the Director's own target. Without a motion
 * artifact the plan is byte-identical to the pre-motion still-image plan.
 *
 * Pure: identical release state yields an identical plan (idempotent resume).
 */
export function buildLongformAssemblyPlan({
  agentId,
  productionRunId,
  narrationArtifact,
  visualArtifact,
  motionArtifact = null,
  durationSeconds,
}) {
  if (typeof agentId !== "string" || agentId.length === 0) throw runnerError("RUNNER_REQUEST_INVALID");
  if (typeof productionRunId !== "string" || productionRunId.length === 0) throw runnerError("RUNNER_REQUEST_INVALID");
  if (!isPlainObject(narrationArtifact) || typeof narrationArtifact.sha256 !== "string") throw runnerError("RUNNER_REQUEST_INVALID");
  if (!isPlainObject(visualArtifact) || typeof visualArtifact.sha256 !== "string") throw runnerError("RUNNER_REQUEST_INVALID");

  // The Director's OWN configured episode duration drives the render (master
  // prompt §2A/§6). When the caller supplies none, the default 40-minute
  // target applies — it is an explicit documented default from the schedule
  // contract, never a hidden hardcoded value that could override a
  // configuration.
  const plannedDuration = durationSeconds === undefined || durationSeconds === null
    ? DEFAULT_EPISODE_DURATION_SECONDS
    : durationSeconds;
  if (!EPISODE_DURATION_OPTIONS_SECONDS.includes(plannedDuration)) {
    throw runnerError("RUNNER_REQUEST_INVALID");
  }

  let visualSegment;
  if (motionArtifact !== null && motionArtifact !== undefined) {
    if (!isPlainObject(motionArtifact) || typeof motionArtifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(motionArtifact.sha256)) {
      throw runnerError("RUNNER_REQUEST_INVALID");
    }
    visualSegment = {
      artifactRef: `sha256:${motionArtifact.sha256}`,
      kind: "video_clip",
      durationSeconds: plannedDuration,
      transitionIn: "cut",
    };
  } else {
    visualSegment = {
      artifactRef: `sha256:${visualArtifact.sha256}`,
      kind: "still_image",
      durationSeconds: plannedDuration,
      transitionIn: "cut",
    };
  }

  const plan = createAssemblyPlan({
    agentId,
    productionRunId,
    outputTarget: "main_longform",
    aspectRatio: "16:9",
    segments: [
      visualSegment,
      {
        artifactRef: `sha256:${narrationArtifact.sha256}`,
        kind: "voice",
      },
    ],
  });
  const integrity = verifyAssemblyPlanIntegrity(plan);
  if (!integrity.intact) throw runnerError(integrity.reason ?? "RUNNER_PLAN_UNBUILDABLE");
  return plan;
}

/**
 * Create one production runner bound to exactly one Director.
 *
 *   binding: {
 *     agentId,                       — the ONLY Director this runner serves
 *     tts: { profile, registry },    — voice profile + declared capabilities
 *     visual: { profile, registry }, — style profile + declared capabilities
 *     spawnImpl?, readFileImpl?,     — injectable transports (tests)
 *     writeFileImpl?,                — bounded operational-file writer (motion)
 *     paths?: { audio, visual, motion, episode, thumbnail, runPrefix },
 *     now?, timeoutMs?, probeTimeoutMs?,
 *     qcChecks?,                     — optional automated policy checks
 *   }
 *
 * Returns `async ({ release, stage, ... }) => executorResult` — the exact
 * runner shape `runEpisodePipeline` consumes.
 */
export function bindProductionRunner(binding = {}) {
  if (!isPlainObject(binding)) throw runnerError("RUNNER_REQUEST_INVALID");
  if (typeof binding.agentId !== "string" || binding.agentId.length === 0) {
    throw runnerError("RUNNER_REQUEST_INVALID");
  }
  const agentId = binding.agentId;

  const paths = deepFreeze({
    audio: binding.paths?.audio ?? "/stph/media/audio",
    visual: binding.paths?.visual ?? "/stph/media/visuals",
    motion: binding.paths?.motion ?? "/stph/media/motion",
    episode: binding.paths?.episode ?? "/stph/media/episodes",
    thumbnail: binding.paths?.thumbnail ?? "/stph/media/thumbnails",
    runPrefix: binding.paths?.runPrefix ?? "episode",
  });

  return async function productionRunner(request = {}) {
    if (!isPlainObject(request)) throw runnerError("RUNNER_REQUEST_INVALID");
    const { release, stage, stageInputs, artifactBindings, manifest } = request;

    // Director isolation: this binding serves ONE Director only.
    if (!isPlainObject(release) || release.agentId !== agentId) {
      throw runnerError("RUNNER_AGENT_MISMATCH");
    }

    // ONE run identity per pipeline pass: the pipeline supplies it, every
    // executor descriptor of this run carries producer.runId = this value
    // (S-M37 run-scope binding), falling back to the release-derived id.
    const releaseKey = typeof release.id === "string" ? release.id.slice(0, 8) : "release";
    const productionRunId = typeof request.productionRunId === "string" && request.productionRunId.length > 0
      ? request.productionRunId
      : `${paths.runPrefix}-${releaseKey}`;

    // The QC stage consumes the runner's optional policy checks.
    if (stage === "qc") {
      return deepFreeze([...(binding.qcChecks ?? [])]);
    }

    // The reels stage builds its canonical plans through the runner-side
    // module (per-Director, release-scoped) and invokes the runner once per
    // reel assembly plan.
    if (stage === "reels:init") {
      const narration = (request.recordedArtifacts ?? []).find((a) => a.stage === "audio");
      const visual = (request.recordedArtifacts ?? []).find((a) => a.stage === "visual");
      if (!narration?.sha256 || !visual?.sha256) {
        throw runnerError("RUNNER_REQUEST_INVALID");
      }
      const reelPackage = buildCanonicalReelPackagePlan({
        agentId,
        productionRunId,
        narrationArtifact: narration,
        visualArtifact: visual,
        brandIdentityKey: binding.brandIdentityKey ?? `channel-${agentId}`,
      });
      const reelPlans = buildReelAssemblyPlans({
        reelPackage,
        narrationArtifact: narration,
        visualArtifact: visual,
        paths,
        productionRunId,
      });
      return deepFreeze({ reelPackage, reelPlans });
    }

    if (stage === "audio") {
      const voiceProfile = binding.tts?.profile ?? createVoiceProfile({
        agentId,
        language: "hi",
        provider: {
          providerId: "espeak-ng",
          providerRole: "local_open_source_emergency",
          modelIdentifier: "espeak-ng-cli",
          voiceId: "hi",
        },
      });
      const registry = binding.tts?.registry ?? {};
      let slot;
      try {
        slot = requireSlot(registry, voiceProfile.provider.providerId);
      } catch (err) {
        // No declared capacity for this Director's voice provider: the
        // truthful durable wait (credential onboarding is owner-gated).
        return waitingResult("CREDENTIAL_MISSING");
      }
      return executeTtsGeneration(voiceProfile, {
        scriptText: `यह कहानी अब शुरू होती है: ${stageInputs?.title ?? release.title ?? "यह एपिसोड"}.`,
        // File naming honesty: the extension is the SELECTED provider's real
        // output container (espeak-ng → .wav), never a hardcoded claim.
        outputPath: `${paths.audio}/${productionRunId}${ttsProviderOutputExtension(voiceProfile.provider.providerId)}`,
        registry,
        spawnImpl: binding.spawnImpl,
        readFileImpl: binding.readFileImpl,
        now: binding.now,
        timeoutMs: binding.timeoutMs,
        probeTimeoutMs: binding.probeTimeoutMs,
        productionRunId,
      });
    }

    if (stage === "visual" || stage === "packaging") {
      const styleProfile = binding.visual?.profile ?? createVisualStyleProfile({
        agentId,
        styleSummary: "Series key art and scene stills, cinematic composition",
        aspectRatio: "16:9",
      });
      const isThumbnail = stage === "packaging";
      const scenePlanRef = isThumbnail ? "thumbnail#key-art" : `${productionRunId}#scene-1`;
      const registry = binding.visual?.registry ?? {};
      try {
        requireSlot(registry, "pollinations");
      } catch {
        return waitingResult(isThumbnail ? "QUOTA_EXHAUSTED" : "CREDENTIAL_MISSING");
      }
      const request = createVisualGenerationRequest({
        styleProfile,
        modality: "image",
        provider: { providerId: "pollinations", providerRole: "approved_free_primary", modelIdentifier: "flux" },
        scenePlanRef,
      });
      // File naming honesty: the extension is the SELECTED provider's real
      // still container (pollinations → .jpg), never a hardcoded claim.
      const visualExtension = visualProviderOutputExtension(request.provider.providerId);
      return executeVisualGeneration(styleProfile, {
        request,
        prompt: isThumbnail
          ? `episode thumbnail key art for ${stageInputs?.title ?? "the episode"}, bold title composition`
          : `cinematic establishing frame for ${stageInputs?.title ?? "the episode"}`,
        outputPath: `${isThumbnail ? paths.thumbnail : paths.visual}/${productionRunId}${isThumbnail ? "-thumb" : ""}${visualExtension}`,
        registry,
        spawnImpl: binding.spawnImpl,
        readFileImpl: binding.readFileImpl,
        now: binding.now,
        timeoutMs: binding.timeoutMs,
        probeTimeoutMs: binding.probeTimeoutMs,
        productionRunId,
      });
    }

    // Local motion stage (Issue #241): animate the release's OWN recorded
    // visual frame with the local FFmpeg minterpolate worker. The stage only
    // runs when the pipeline was started with motion enabled, so a missing
    // implementation here is never a silent no-op: prerequisites fail closed
    // with stable codes and the stage fails honestly.
    if (stage === "motion") {
      const visual = (request.recordedArtifacts ?? []).find((a) => a.stage === "visual");
      return runLocalMotionStage({
        agentId,
        visualArtifact: visual ?? null,
        outputPath: `${paths.motion}/${productionRunId}.mp4`,
        frameListPath: `${paths.motion}/${productionRunId}.frames.txt`,
        spawnImpl: binding.spawnImpl,
        readFileImpl: binding.readFileImpl,
        writeFileImpl: binding.writeFileImpl,
        productionRunId,
        now: binding.now,
        timeoutMs: binding.timeoutMs,
        probeTimeoutMs: binding.probeTimeoutMs,
      });
    }

    if (stage === "assembly" || stage === "reels") {
      // Assembly/reels consume the release's OWN verified artifacts (bridge-
      // recorded in the audio/visual/motion stages of THIS pipeline run).
      const narration = (request.recordedArtifacts ?? []).find((a) => a.stage === "audio");
      const visual = (request.recordedArtifacts ?? []).find((a) => a.stage === "visual");
      // The main longform render consumes the MOTION clip when the stage ran;
      // reels keep their existing still-image short-form plans.
      const motion = (request.recordedArtifacts ?? []).find((a) => a.stage === "motion");
      if (!narration?.sha256 || !visual?.sha256 || !narration.descriptor || !visual.descriptor) {
        return waitingResult("PROVIDER_UNAVAILABLE");
      }
      let plan;
      let renderPlan;
      let outputPath;
      // The configured episode duration the pipeline resolved for this run
      // (Director schedule → job payload → documented default). It is applied
      // to the main-longform render only; the short-form reels keep their own
      // 5–180 s QC window untouched.
      const configuredDurationSeconds = isPlainObject(request.targetDurationSeconds)
        ? request.targetDurationSeconds.seconds ?? null
        : request.targetDurationSeconds ?? null;
      if (configuredDurationSeconds !== null && !EPISODE_DURATION_OPTIONS_SECONDS.includes(configuredDurationSeconds)) {
        throw runnerError("RUNNER_REQUEST_INVALID");
      }
      // The strict target window is enforced when the duration came from an
      // EXPLICIT configuration (the Director's persisted schedule or the
      // queued job). When nothing is configured the run keeps the canonical
      // S-M33-01 [1800, 3000] window — the documented default plans the
      // render, but it does not pretend to be an owner-chosen target.
      const enforceConfiguredTarget =
        configuredDurationSeconds !== null &&
        request.targetDurationSource !== undefined &&
        request.targetDurationSource !== null &&
        request.targetDurationSource !== "default";
      try {
        if (stage === "assembly") {
          plan = buildLongformAssemblyPlan({
            agentId,
            productionRunId,
            narrationArtifact: narration,
            visualArtifact: visual,
            motionArtifact: motion ?? null,
            durationSeconds: configuredDurationSeconds,
          });
          outputPath = `${paths.episode}/${productionRunId}.mp4`;
        } else {
          // Canonical short-form package (Issue #189): one pre-built reel
          // assembly plan per invocation (content_reel_1/2, brand_reel).
          const reelPlan = request.reelPlan;
          if (!isPlainObject(reelPlan) || !isPlainObject(reelPlan.plan) || typeof reelPlan.outputPath !== "string") {
            throw runnerError("RUNNER_REQUEST_INVALID");
          }
          plan = reelPlan.plan;
          outputPath = reelPlan.outputPath;
        }
        const resolved = resolvePlanInputs(plan, artifactBindings ?? {});
        renderPlan = buildRenderPlan(plan, resolved, outputPath);
      } catch (err) {
        // Unresolvable bindings or unbuildable plans are honest failures —
        // the pipeline records the stage failure with this stable code.
        return deepFreeze({
          success: false,
          executed: false,
          failureCode: err.code ?? "RUNNER_PLAN_UNBUILDABLE",
          descriptor: null,
          inspection: null,
          qc: null,
        });
      }
      return executeAssemblyPlan(plan, {
        artifactBindings: artifactBindings ?? {},
        outputPath,
        spawnImpl: binding.spawnImpl,
        readFileImpl: binding.readFileImpl,
        now: binding.now,
        timeoutMs: binding.timeoutMs,
        probeTimeoutMs: binding.probeTimeoutMs,
        // Main long-form renders are measured against the Director's
        // configured duration window; reels keep `null`.
        runtimeTargetSeconds: stage === "assembly" && enforceConfiguredTarget ? configuredDurationSeconds : null,
      });
    }

    throw runnerError("RUNNER_REQUEST_INVALID");
  };
}
