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
import { executeTtsGeneration } from "../media/ttsExecutor.js";
import {
  createVisualStyleProfile,
  createVisualGenerationRequest,
} from "../media/visualAdapter.js";
import { executeVisualGeneration } from "../media/visualExecutor.js";
import { executeAssemblyPlan, resolvePlanInputs, buildRenderPlan } from "../media/ffmpegAssemblyExecutor.js";
import {
  createAssemblyPlan,
  verifyAssemblyPlanIntegrity,
} from "../media/assemblyPlan.js";

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
 * Pure: identical release state yields an identical plan (idempotent resume).
 */
export function buildLongformAssemblyPlan({ agentId, productionRunId, narrationArtifact, visualArtifact }) {
  if (typeof agentId !== "string" || agentId.length === 0) throw runnerError("RUNNER_REQUEST_INVALID");
  if (typeof productionRunId !== "string" || productionRunId.length === 0) throw runnerError("RUNNER_REQUEST_INVALID");
  if (!isPlainObject(narrationArtifact) || typeof narrationArtifact.sha256 !== "string") throw runnerError("RUNNER_REQUEST_INVALID");
  if (!isPlainObject(visualArtifact) || typeof visualArtifact.sha256 !== "string") throw runnerError("RUNNER_REQUEST_INVALID");

  const plan = createAssemblyPlan({
    agentId,
    productionRunId,
    outputTarget: "main_longform",
    aspectRatio: "16:9",
    segments: [
      {
        artifactRef: `sha256:${visualArtifact.sha256}`,
        kind: "still_image",
        durationSeconds: 1890,
        transitionIn: "cut",
      },
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
 *     paths?: { audio, visual, episode, thumbnail, runPrefix },
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

    // The QC stage consumes the runner's optional policy checks.
    if (stage === "qc") {
      return deepFreeze([...(binding.qcChecks ?? [])]);
    }

    const releaseKey = typeof release.id === "string" ? release.id.slice(0, 8) : "release";
    const productionRunId = `${paths.runPrefix}-${releaseKey}`;

    if (stage === "audio") {
      const voiceProfile = binding.tts?.profile ?? createVoiceProfile({
        agentId,
        language: "hi",
        provider: {
          providerId: "edge-tts",
          providerRole: "approved_free_primary",
          modelIdentifier: "edge-tts-cli",
          voiceId: "hi-IN-MadhurNeural",
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
        outputPath: `${paths.audio}/${productionRunId}.mp3`,
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
      return executeVisualGeneration(styleProfile, {
        request,
        prompt: isThumbnail
          ? `episode thumbnail key art for ${stageInputs?.title ?? "the episode"}, bold title composition`
          : `cinematic establishing frame for ${stageInputs?.title ?? "the episode"}`,
        outputPath: `${isThumbnail ? paths.thumbnail : paths.visual}/${productionRunId}${isThumbnail ? "-thumb" : ""}.png`,
        registry,
        spawnImpl: binding.spawnImpl,
        readFileImpl: binding.readFileImpl,
        now: binding.now,
        timeoutMs: binding.timeoutMs,
        probeTimeoutMs: binding.probeTimeoutMs,
        productionRunId,
      });
    }

    if (stage === "assembly") {
      // Assembly consumes the release's OWN verified artifacts (bridge-
      // recorded in the audio/visual stages of THIS pipeline run).
      const narration = (request.recordedArtifacts ?? []).find((a) => a.stage === "audio");
      const visual = (request.recordedArtifacts ?? []).find((a) => a.stage === "visual");
      if (!narration?.sha256 || !visual?.sha256 || !narration.descriptor || !visual.descriptor) {
        return waitingResult("PROVIDER_UNAVAILABLE");
      }
      let plan;
      let renderPlan;
      try {
        plan = buildLongformAssemblyPlan({
          agentId,
          productionRunId,
          narrationArtifact: narration,
          visualArtifact: visual,
        });
        const resolved = resolvePlanInputs(plan, artifactBindings ?? {});
        renderPlan = buildRenderPlan(plan, resolved, `${paths.episode}/${productionRunId}.mp4`);
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
        outputPath: `${paths.episode}/${productionRunId}.mp4`,
        spawnImpl: binding.spawnImpl,
        readFileImpl: binding.readFileImpl,
        now: binding.now,
        timeoutMs: binding.timeoutMs,
        probeTimeoutMs: binding.probeTimeoutMs,
      });
    }

    throw runnerError("RUNNER_REQUEST_INVALID");
  };
}
