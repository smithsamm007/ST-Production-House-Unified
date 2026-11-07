/**
 * ST Production House — JARVIS deterministic content package orchestrator.
 *
 * Runs ONE original content package through the REAL deterministic JARVIS
 * workflow stages that already exist in this repository, in dependency order,
 * using the production WorkerRuntime (heartbeats, checkpoints, idempotency,
 * fail-closed errors) and a durable CheckpointStore.
 *
 * Truthfulness boundaries (hard):
 * - Every stage is deterministic and offline. `providerCalls` stays empty.
 * - No stage generates media, audio, or images; `mediaStatus` is
 *   `not_generated` and provenance counters are zero.
 * - The subtitle stage requires owner/agent-supplied TIMED narration segments
 *   (no in-repo stage can synthesize speech). Without them the orchestrator
 *   truthfully reports `skipped_pending_input` with `NARRATION_SEGMENTS_REQUIRED`
 *   instead of inventing narration text or timings.
 * - The result is never publishable: `publication.status` stays
 *   `not_requested`; publishing requires separate owner approval elsewhere.
 */

import { createHash } from "node:crypto";
import { deterministicJarvisContentHandler } from "./deterministicContentWorkflow.js";
import { deterministicNarrationPlanHandler } from "./deterministicNarrationPlan.js";
import { deterministicJarvisContinuityPlanHandler } from "./deterministicContinuityPlan.js";
import { deterministicJarvisScriptPlanHandler } from "./deterministicScriptPlan.js";
import { createDeterministicVisualScenePlan } from "./deterministicVisualScenePlanner.js";
import { deterministicShortsPlanHandler } from "./deterministicShortsPlan.js";
import { deterministicMetadataThumbnailPlanHandler } from "./deterministicMetadataThumbnailPlan.js";
import { deterministicSubtitlePlanHandler } from "./deterministicSubtitlePlan.js";
import {
  buildJarvisNarrationScript,
  deriveTimedNarrationSegments,
  supportsJarvisNarrationScriptLanguage
} from "./jarvisNarrationScript.js";
import { assertNarrationAudioRecord, createSkippedNarrationAudio } from "./measuredNarration.js";

const JARVIS_AGENT_ID = "agent-01";

const STAGES = Object.freeze([
  { stage: "outline", jobType: "jarvis.content.outline.v1" },
  { stage: "narration_plan", jobType: "jarvis.content.narration-plan.v1" },
  { stage: "continuity_plan", jobType: "jarvis.content.continuity-plan.v1" },
  { stage: "script_plan", jobType: "jarvis.content.script-plan.v1" },
  { stage: "visual_scene_plan", jobType: "jarvis.content.visual-scene-plan.v1" },
  { stage: "shorts_plan", jobType: "jarvis.content.shorts-plan.v1" },
  { stage: "metadata_thumbnail_plan", jobType: "jarvis.content.metadata-thumbnail-plan.v1" },
  { stage: "subtitle_plan", jobType: "jarvis.content.subtitle-plan.v1" }
]);

const PACKAGE_TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const MAX_TIMED_SEGMENTS = 500;

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertContract(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`JARVIS_PACKAGE_STAGE_OUTPUT_INVALID:${label}`);
  }
  if (value.generationMode !== "deterministic_local") {
    throw new Error(`JARVIS_PACKAGE_STAGE_NOT_DETERMINISTIC:${label}`);
  }
  if (!Array.isArray(value.providerCalls) || value.providerCalls.length !== 0) {
    throw new Error(`JARVIS_PACKAGE_STAGE_PROVIDER_CALL_REJECTED:${label}`);
  }
  if (value.publication?.requested !== false || value.publication?.status !== "not_requested") {
    throw new Error(`JARVIS_PACKAGE_STAGE_PUBLICATION_STATE_INVALID:${label}`);
  }
  return value;
}

function validateTimedNarrationSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_TIMED_SEGMENTS) {
    throw new Error("JARVIS_PACKAGE_TIMED_NARRATION_INVALID");
  }
  let previousEnd = 0;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") throw new Error("JARVIS_PACKAGE_TIMED_NARRATION_INVALID");
    if (typeof segment.segmentId !== "string" || !segment.segmentId.trim()) {
      throw new Error("JARVIS_PACKAGE_TIMED_NARRATION_INVALID");
    }
    if (typeof segment.text !== "string" || !segment.text.trim()) {
      throw new Error("JARVIS_PACKAGE_TIMED_NARRATION_INVALID");
    }
    const start = Number(segment.startTime);
    const end = Number(segment.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < previousEnd - 0.001) {
      throw new Error("JARVIS_PACKAGE_TIMED_NARRATION_INVALID");
    }
    previousEnd = end;
  }
  return segments;
}

export class JarvisContentPackageOrchestrator {
  /**
   * @param {object} options
   * @param {object} options.runtime - WorkerRuntime instance (required).
   * @param {object} options.checkpointStore - CheckpointStore instance (required).
   * @param {object} [options.evidenceLedger] - Optional EvidenceLedger for stage receipts.
   * @param {Function} [options.narrationStage] - Optional measured narration stage
   *   bound to the production TTS executor + completeness gate. Receives
   *   `{ script, packageTaskId, targetSeconds }`; without it no audio is generated.
   */
  constructor({ runtime, checkpointStore, evidenceLedger, narrationStage } = {}) {
    if (!runtime || typeof runtime.run !== "function") {
      throw new Error("JARVIS_PACKAGE_ORCHESTRATOR_RUNTIME_REQUIRED");
    }
    if (!checkpointStore || typeof checkpointStore.write !== "function" || typeof checkpointStore.read !== "function") {
      throw new Error("JARVIS_PACKAGE_ORCHESTRATOR_CHECKPOINT_STORE_REQUIRED");
    }
    if (evidenceLedger && typeof evidenceLedger.append !== "function") {
      throw new Error("JARVIS_PACKAGE_ORCHESTRATOR_EVIDENCE_LEDGER_INVALID");
    }
    if (narrationStage !== undefined && narrationStage !== null && typeof narrationStage !== "function") {
      throw new Error("JARVIS_PACKAGE_ORCHESTRATOR_NARRATION_STAGE_INVALID");
    }
    this.runtime = runtime;
    this.checkpointStore = checkpointStore;
    this.evidenceLedger = evidenceLedger || null;
    this.narrationStage = narrationStage ?? null;
  }

  #recordEvidence(subjectId, classification, payload) {
    if (!this.evidenceLedger) return null;
    return this.evidenceLedger.append({
      subjectId,
      kind: "workflow_checkpoint",
      classification,
      payload
    });
  }

  /**
   * Produce one deterministic content package.
   * @param {object} input
   * @param {string} input.packageTaskId - Unique, stable task id for idempotent checkpoints.
   * @param {string} input.publicBrand - Public brand (never an internal agent name).
   * @param {string} input.suppliedConcept - Owner-supplied concept (20-1200 chars).
   * @param {"hindi"|"hinglish"} input.language
   * @param {number} input.targetMinutes - 25-30.
   * @param {Array} [input.timedNarrationSegments] - Optional owner-supplied timed narration.
   * @returns {Promise<object>} Frozen package result.
   */
  async createContentPackage(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("JARVIS_PACKAGE_INPUT_INVALID");
    }
    if (typeof input.packageTaskId !== "string" || !PACKAGE_TASK_ID_PATTERN.test(input.packageTaskId)) {
      throw new Error("JARVIS_PACKAGE_TASK_ID_INVALID");
    }

    const { packageTaskId } = input;
    const brief = {
      publicBrand: input.publicBrand,
      suppliedConcept: input.suppliedConcept,
      language: input.language,
      targetMinutes: input.targetMinutes
    };

    const stageRecords = [];
    const outputs = {};

    const runStage = async ({ stage, jobType }, payload, context = {}) => {
      const stageTaskId = `${packageTaskId}#${stage}`;
      const result = await this.runtime.run(
        {
          taskId: stageTaskId,
          jobType,
          agentId: JARVIS_AGENT_ID,
          payload,
          context: Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined))
        },
        async (ctx) => {
          switch (jobType) {
            case "jarvis.content.outline.v1":
              return deterministicJarvisContentHandler(ctx);
            case "jarvis.content.narration-plan.v1":
              return deterministicNarrationPlanHandler(ctx);
            case "jarvis.content.continuity-plan.v1":
              return deterministicJarvisContinuityPlanHandler(ctx);
            case "jarvis.content.script-plan.v1":
              return deterministicJarvisScriptPlanHandler(ctx);
            case "jarvis.content.shorts-plan.v1":
              return deterministicShortsPlanHandler(ctx);
            case "jarvis.content.metadata-thumbnail-plan.v1":
              return deterministicMetadataThumbnailPlanHandler(ctx);
            case "jarvis.content.subtitle-plan.v1":
              return deterministicSubtitlePlanHandler(ctx);
            case "jarvis.content.visual-scene-plan.v1":
              // This planner has no ctx-based handler; it is a pure function.
              // The worker wrapper still records checkpoints for the stage.
              return createDeterministicVisualScenePlan(payload);
            default:
              throw new Error(`JARVIS_PACKAGE_STAGE_JOB_TYPE_UNKNOWN:${jobType}`);
          }
        },
        { checkpointStore: this.checkpointStore }
      );

      if (!result || result.status !== "success") {
        const reason = String(result?.error?.message || result?.error || "STAGE_FAILED").slice(0, 200);
        throw new Error(`JARVIS_PACKAGE_STAGE_FAILED:${stage}:${reason}`);
      }
      const output = assertContract(result.output, stage);
      outputs[stage] = output;
      stageRecords.push({
        stage,
        status: "completed",
        taskId: stageTaskId,
        jobType,
        resultHash: stableHash(output),
        runtimeStatus: result.status
      });
      this.#recordEvidence(packageTaskId, "jarvis_content_stage_completed", {
        stage,
        stageTaskId,
        resultHash: stableHash(output)
      });
      return output;
    };

    try {
      // 1. Outline — the root contract every other stage validates against.
      // (The outline handler takes the brief as flat payload fields.)
      const outline = await runStage(STAGES[0], {
        publicBrand: brief.publicBrand,
        concept: brief.suppliedConcept,
        language: brief.language,
        targetMinutes: brief.targetMinutes
      });

      // 2. Narration plan (structure/timing only; no audio generated).
      await runStage(STAGES[1], { outlinePackage: outline });

      // 2b. One narration script for this package (Issue #262). The same
      // duration-aligned builder the production pipeline hands to its audio
      // stage sizes the script to this package's 30/40/50-minute target, so the
      // plan and the measured completeness gate describe ONE program length.
      // The builder emits Hindi planning text only; a Hinglish package keeps
      // requiring owner-supplied timed narration (no Hinglish builder exists).
      const narrationScript = supportsJarvisNarrationScriptLanguage(outline.language)
        ? buildJarvisNarrationScript(outline)
        : null;

      // 2c. Measured narration audio (Issue #262). When the caller binds the
      // production measured-narration stage, the complete script is narrated by
      // the real TTS executor and judged by the measured completeness gate.
      // Without a bound stage NOTHING is generated, and that is stated.
      let narrationAudio;
      if (narrationScript === null) {
        narrationAudio = createSkippedNarrationAudio("skipped_pending_input", "NARRATION_SCRIPT_LANGUAGE_UNSUPPORTED");
      } else if (this.narrationStage === null) {
        narrationAudio = createSkippedNarrationAudio("skipped_pending_runtime", "NARRATION_AUDIO_RUNTIME_REQUIRED");
      } else {
        // Restart safety: a MEASURED verification is reused from the durable
        // checkpoint instead of re-calling a provider. Unverified attempts are
        // never cached, so an honest wait/failure is re-attempted by whoever
        // owns resumption (Rules 1–3), not silently treated as settled.
        const cached = await this.checkpointStore.read(`${packageTaskId}#narration_audio`);
        const cachedRecord = cached?.data?.record ?? null;
        if (cachedRecord !== null && cachedRecord.status === "measured_verified") {
          narrationAudio = assertNarrationAudioRecord(cachedRecord);
        } else {
          narrationAudio = assertNarrationAudioRecord(
            await this.narrationStage({
              script: narrationScript,
              packageTaskId,
              targetSeconds: outline.targetMinutes * 60
            })
          );
          await this.checkpointStore.write(`${packageTaskId}#narration_audio`, {
            step: "narration_audio_stage_completed",
            progress: narrationAudio.status === "measured_verified" ? 90 : 60,
            data: {
              record: narrationAudio,
              status: narrationAudio.status,
              reasonCode: narrationAudio.reasonCode,
              providerId: narrationAudio.providerId,
              measuredSeconds: narrationAudio.measuredSeconds
            }
          });
          this.#recordEvidence(packageTaskId, "jarvis_content_narration_audio_stage", {
            status: narrationAudio.status,
            reasonCode: narrationAudio.reasonCode,
            measuredSeconds: narrationAudio.measuredSeconds
          });
        }
      }

      // 3. Continuity plan.
      await runStage(STAGES[2], { outlinePackage: outline });

      // 4. Script plan.
      await runStage(STAGES[3], { outlinePackage: outline });

      // 5. Visual scene plan (specifications only).
      await runStage(STAGES[4], outline);

      // 6. Shorts plan (exactly three Shorts, no ending disclosure).
      await runStage(STAGES[5], { outlinePackage: outline });

      // 7. Metadata + thumbnail plan (drafts only).
      await runStage(STAGES[6], { outlinePackage: outline });

      // 8. Subtitle plan — cue text bound to the script that will be narrated.
      // Issue #262: when the owner supplies no segments, segments are DERIVED
      // from the same complete narration script the audio stage narrates. Their
      // timings are the script's PLANNED beat seconds (labelled), never a
      // measurement; the text is a slice of the script, never invented. Owner
      // scope is still mandatory for this stage (scope-isolated cue planning).
      let subtitlePlan = null;
      let subtitleStatus = "skipped_pending_input";
      let subtitleReasonCode = "NARRATION_SEGMENTS_REQUIRED";
      const ownerScopeValid = typeof input.ownerId === "string" && /^[a-zA-Z0-9_-]{3,80}$/.test(input.ownerId);
      const ownerSuppliedSegments = input.timedNarrationSegments !== undefined
        ? validateTimedNarrationSegments(input.timedNarrationSegments)
        : null;
      const segments = ownerSuppliedSegments
        ?? (narrationScript === null ? null : deriveTimedNarrationSegments(narrationScript));

      if (segments !== null && !ownerScopeValid) {
        if (ownerSuppliedSegments !== null) {
          throw new Error("JARVIS_PACKAGE_OWNER_ID_REQUIRED_FOR_SUBTITLES");
        }
        subtitleReasonCode = "OWNER_SCOPE_REQUIRED";
      } else if (segments !== null) {
        subtitlePlan = await runStage(
          STAGES[7],
          {
            narrationPackage: {
              language: outline.language,
              packageId: outline.packageId,
              narrationSegments: segments
            }
          },
          { ownerId: input.ownerId }
        );
        subtitleStatus = "completed";
        subtitleReasonCode = null;
      }

      if (subtitlePlan === null) {
        await this.checkpointStore.write(`${packageTaskId}#subtitle_plan`, {
          step: "subtitle_waiting_for_narration_input",
          progress: 0,
          data: {
            reasonCode: subtitleReasonCode,
            resumable: true,
            executionStarted: false,
            generatedMedia: 0
          }
        });
        this.#recordEvidence(packageTaskId, "jarvis_content_stage_skipped", {
          stage: "subtitle_plan",
          reasonCode: subtitleReasonCode
        });
      }

      stageRecords.push({
        stage: "subtitle_plan",
        status: subtitleStatus,
        taskId: `${packageTaskId}#subtitle_plan`,
        jobType: STAGES[7].jobType,
        resultHash: subtitlePlan ? stableHash(subtitlePlan) : null,
        reasonCode: subtitleReasonCode
      });

      const readiness = subtitleStatus === "completed"
        ? "deterministic_package_complete"
        : "package_incomplete_pending_narration_input";

      const packageResult = {
        schemaVersion: 1,
        orchestrator: "jarvis_content_package_v1",
        packageTaskId,
        agentId: JARVIS_AGENT_ID,
        outlinePackageId: outline.packageId,
        readiness,
        contentPackage: outline,
        narrationPlan: outputs.narration_plan,
        continuityPlan: outputs.continuity_plan,
        scriptPlan: outputs.script_plan,
        visualScenePlan: outputs.visual_scene_plan,
        shortsPlan: outputs.shorts_plan,
        metadataThumbnailPlan: outputs.metadata_thumbnail_plan,
        subtitlePlan,
        narrationScript,
        narrationScriptStatus: narrationScript === null ? "unavailable_for_language" : "planned",
        narrationAudio,
        stages: stageRecords,
        provenance: {
          generationMode: "deterministic_local",
          providerCalls: narrationAudio.providerExecuted ? 1 : 0,
          networkCalls: 0,
          generatedMediaCount: narrationAudio.status === "measured_verified" ? 1 : 0,
          mediaStatus: narrationAudio.status === "measured_verified" ? "verified" : "not_generated",
          narrationAudioStatus: narrationAudio.status,
          note: "Deterministic plans only; this orchestrator itself renders nothing. When a measured narration stage is bound, the narration audio it produced is reported with the executor's real FFprobe measurements and the completeness gate's verdict — never as a claim."
        },
        publication: { requested: false, status: "not_requested" }
      };

      await this.checkpointStore.write(`${packageTaskId}#package`, {
        step: "content_package_ready",
        progress: 100,
        data: {
          readiness,
          outlinePackageId: outline.packageId,
          stagesCompleted: stageRecords.filter((record) => record.status === "completed").length,
          narrationAudioStatus: narrationAudio.status,
          providerCalls: narrationAudio.providerExecuted ? 1 : 0,
          generatedMediaCount: narrationAudio.status === "measured_verified" ? 1 : 0
        }
      });
      this.#recordEvidence(packageTaskId, "jarvis_content_package_completed", {
        readiness,
        outlinePackageId: outline.packageId,
        resultHash: stableHash(packageResult)
      });

      return Object.freeze(packageResult);
    } catch (error) {
      await this.checkpointStore.write(`${packageTaskId}#package`, {
        step: "content_package_stage_failed",
        progress: 0,
        data: {
          errorCode: String(error?.message || "JARVIS_PACKAGE_STAGE_FAILED").slice(0, 200),
          resumable: true,
          executionStarted: false
        }
      }).catch(() => {});
      this.#recordEvidence(packageTaskId, "jarvis_content_package_failed", {
        errorCode: String(error?.message || "JARVIS_PACKAGE_STAGE_FAILED").slice(0, 200)
      });
      throw error;
    }
  }
}
