/**
 * ST Production House — AI News deterministic content package orchestrator.
 *
 * Generalizes the proven JARVIS content-package pattern (see
 * src/jarvis/contentPackageOrchestrator.js) to the AI News pipeline. Runs ONE
 * news package through the REAL deterministic AI News stages that already
 * exist in this repository, in dependency order, using the production
 * WorkerRuntime (heartbeats, checkpoints, idempotency, fail-closed errors)
 * and a durable CheckpointStore:
 *
 *   research brief -> editorial plan -> metadata/thumbnail plan
 *                  -> subtitle plan (requires owner-supplied timed narration)
 *
 * Truthfulness boundaries (hard):
 * - Every stage is deterministic and offline. `providerCalls` stays empty.
 * - No stage generates media, audio, narration, or images; `mediaStatus` is
 *   `not_generated` and provenance counters are zero.
 * - The subtitle stage requires owner-supplied timed narration segments
 *   (no in-repo stage can synthesize speech). Without them the orchestrator
 *   truthfully reports `skipped_pending_input` with `NARRATION_REGISTRY_REQUIRED`.
 * - A blocked upstream stage stops the chain: downstream stages are marked
 *   `not_run` and the package reports the ORIGINAL upstream reason code.
 * - Stage bindings are verified before the next stage runs (brief/plan/registry
 *   ids must chain); tampering fails closed.
 * - The result is never publishable: `publication.status` stays `not_requested`.
 */

import { createHash } from "node:crypto";
import { createDeterministicResearchBrief } from "./deterministicResearchBrief.js";
import { createDeterministicEditorialPlan } from "./deterministicEditorialPlan.js";
import { createDeterministicMetadataPlan } from "./deterministicMetadataPlan.js";
import {
  createDeterministicSubtitlePlan,
  createNarrationInputRegistry
} from "./deterministicSubtitlePlan.js";

const AI_NEWS_AGENT_ID = "agent-ai-news";
const SCHEMA_VERSION = 1;

const STAGES = Object.freeze([
  { stage: "research_brief", jobType: "ai-news.research-brief.v1" },
  { stage: "editorial_plan", jobType: "ai-news.editorial-plan.v1" },
  { stage: "metadata_thumbnail_plan", jobType: "ai-news.metadata-plan.v1" },
  { stage: "subtitle_plan", jobType: "ai-news.subtitle-plan.v1" }
]);

const PACKAGE_TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const OWNER_ID_PATTERN = /^[a-zA-Z0-9_-]{3,80}$/;
const MAX_TIMED_SEGMENTS = 500;

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertContract(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`AI_NEWS_PACKAGE_STAGE_OUTPUT_INVALID:${label}`);
  }
  if (value.generationMode !== "deterministic_local") {
    throw new Error(`AI_NEWS_PACKAGE_STAGE_NOT_DETERMINISTIC:${label}`);
  }
  // AI News stages report zero provider calls in one of two truthful shapes:
  // a top-level empty `providerCalls` array (plan stages) or
  // `provenance.providerCalls: 0` (the research brief). Any other shape or a
  // non-zero counter fails closed.
  if (value.providerCalls !== undefined) {
    if (!Array.isArray(value.providerCalls) || value.providerCalls.length !== 0) {
      throw new Error(`AI_NEWS_PACKAGE_STAGE_PROVIDER_CALL_REJECTED:${label}`);
    }
  } else if (value.provenance?.providerCalls !== 0) {
    throw new Error(`AI_NEWS_PACKAGE_STAGE_PROVIDER_CALL_REJECTED:${label}`);
  }
  if (value.publication?.requested !== false || value.publication?.status !== "not_requested") {
    throw new Error(`AI_NEWS_PACKAGE_STAGE_PUBLICATION_STATE_INVALID:${label}`);
  }
  return value;
}

function assertBinding(actual, expected, code) {
  if (actual !== expected) {
    throw new Error(code);
  }
}

function validateTimedNarrationSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_TIMED_SEGMENTS) {
    throw new Error("AI_NEWS_PACKAGE_TIMED_NARRATION_INVALID");
  }
  let previousEnd = 0;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") throw new Error("AI_NEWS_PACKAGE_TIMED_NARRATION_INVALID");
    if (typeof segment.segmentId !== "string" || !segment.segmentId.trim()) {
      throw new Error("AI_NEWS_PACKAGE_TIMED_NARRATION_INVALID");
    }
    if (typeof segment.text !== "string" || !segment.text.trim()) {
      throw new Error("AI_NEWS_PACKAGE_TIMED_NARRATION_INVALID");
    }
    const start = Number(segment.startTime);
    const end = Number(segment.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < previousEnd) {
      throw new Error("AI_NEWS_PACKAGE_TIMED_NARRATION_INVALID");
    }
    previousEnd = end;
  }
  return segments;
}

export class AiNewsContentPackageOrchestrator {
  /**
   * @param {object} options
   * @param {object} options.runtime - WorkerRuntime instance (required).
   * @param {object} options.checkpointStore - CheckpointStore instance (required).
   * @param {object} [options.evidenceLedger] - Optional EvidenceLedger for stage receipts.
   */
  constructor({ runtime, checkpointStore, evidenceLedger } = {}) {
    if (!runtime || typeof runtime.run !== "function") {
      throw new Error("AI_NEWS_PACKAGE_ORCHESTRATOR_RUNTIME_REQUIRED");
    }
    if (!checkpointStore || typeof checkpointStore.write !== "function" || typeof checkpointStore.read !== "function") {
      throw new Error("AI_NEWS_PACKAGE_ORCHESTRATOR_CHECKPOINT_STORE_REQUIRED");
    }
    if (evidenceLedger && typeof evidenceLedger.append !== "function") {
      throw new Error("AI_NEWS_PACKAGE_ORCHESTRATOR_EVIDENCE_LEDGER_INVALID");
    }
    this.runtime = runtime;
    this.checkpointStore = checkpointStore;
    this.evidenceLedger = evidenceLedger || null;
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
   * Produce one deterministic AI News content package.
   *
   * @param {object} input
   * @param {string} input.packageTaskId - Unique, stable task id for idempotent checkpoints.
   * @param {string} input.ownerId - Owner scope (validated; propagates to every stage).
   * @param {string} input.asOf - Strict ISO timestamp anchoring research recency (required for determinism).
   * @param {Array} input.sources - Owner/agent-supplied source descriptors for the research brief.
   * @param {string} input.publicBrand - Public brand (never an internal agent name).
   * @param {"hindi"|"hinglish"|"english"} input.language
   * @param {string} input.tone - factual|explainer|urgent|measured.
   * @param {string} input.format - explainer_short|explainer_standard|news_recap.
   * @param {number} input.targetSeconds - 45-600.
   * @param {Array} [input.timedNarrationSegments] - Optional owner-supplied timed narration.
   * @returns {Promise<object>} Frozen package result.
   */
  async createContentPackage(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("AI_NEWS_PACKAGE_INPUT_INVALID");
    }
    if (typeof input.packageTaskId !== "string" || !PACKAGE_TASK_ID_PATTERN.test(input.packageTaskId)) {
      throw new Error("AI_NEWS_PACKAGE_TASK_ID_INVALID");
    }
    if (typeof input.ownerId !== "string" || !OWNER_ID_PATTERN.test(input.ownerId)) {
      throw new Error("AI_NEWS_PACKAGE_OWNER_ID_INVALID");
    }

    const { packageTaskId, ownerId } = input;

    const stageRecords = [];
    const outputs = {};

    const runStage = async ({ stage, jobType }, payload) => {
      const stageTaskId = `${packageTaskId}#${stage}`;
      const result = await this.runtime.run(
        {
          taskId: stageTaskId,
          jobType,
          agentId: AI_NEWS_AGENT_ID,
          payload,
          context: {}
        },
        async () => {
          switch (jobType) {
            case "ai-news.research-brief.v1":
              return createDeterministicResearchBrief(payload.researchInput);
            case "ai-news.editorial-plan.v1":
              return createDeterministicEditorialPlan(payload.editorialInput);
            case "ai-news.metadata-plan.v1":
              return createDeterministicMetadataPlan(payload.metadataInput);
            case "ai-news.subtitle-plan.v1":
              return createDeterministicSubtitlePlan(payload.subtitleInput);
            default:
              throw new Error(`AI_NEWS_PACKAGE_STAGE_JOB_TYPE_UNKNOWN:${jobType}`);
          }
        },
        { checkpointStore: this.checkpointStore }
      );

      if (!result || result.status !== "success") {
        const reason = String(result?.error?.message || result?.error || "STAGE_FAILED").slice(0, 200);
        throw new Error(`AI_NEWS_PACKAGE_STAGE_FAILED:${stage}:${reason}`);
      }
      const output = assertContract(result.output, stage);
      outputs[stage] = output;
      stageRecords.push({
        stage,
        status: "completed",
        taskId: stageTaskId,
        jobType,
        resultHash: stableHash(output),
        readiness: output.readiness ?? null,
        reasonCode: output.reasonCode ?? null
      });
      this.#recordEvidence(packageTaskId, "ai_news_stage_completed", {
        stage,
        stageTaskId,
        resultHash: stableHash(output),
        readiness: output.readiness ?? null
      });
      return output;
    };

    const markNotRun = (stage, reasonCode) => {
      stageRecords.push({
        stage,
        status: "not_run",
        taskId: `${packageTaskId}#${stage}`,
        jobType: STAGES.find((entry) => entry.stage === stage).jobType,
        resultHash: null,
        readiness: null,
        reasonCode
      });
    };

    try {
      // 1. Research brief — the root contract every later stage validates against.
      const researchInput = {
        schemaVersion: SCHEMA_VERSION,
        ownerId,
        agentId: AI_NEWS_AGENT_ID,
        asOf: input.asOf,
        sources: input.sources
      };
      const brief = await runStage(STAGES[0], { researchInput });

      let packageReadiness = "deterministic_package_complete";
      let packageReasonCode = null;

      let editorialPlan = null;
      let metadataPlan = null;
      let subtitlePlan = null;
      let subtitleStatus = "skipped_pending_input";
      let subtitleReasonCode = "NARRATION_REGISTRY_REQUIRED";
      let subtitleWaitingForNarrationInput = false;

      if (brief.readiness !== "ready_for_editorial_review") {
        packageReadiness = "blocked";
        packageReasonCode = brief.reasonCode || "BRIEF_NOT_READY";
        markNotRun("editorial_plan", "UPSTREAM_BLOCKED");
        markNotRun("metadata_thumbnail_plan", "UPSTREAM_BLOCKED");
        markNotRun("subtitle_plan", "UPSTREAM_BLOCKED");
      } else {
        // 2. Editorial plan (structure only; no narration text).
        editorialPlan = await runStage(STAGES[1], {
          editorialInput: {
            schemaVersion: SCHEMA_VERSION,
            brief,
            publicBrand: input.publicBrand,
            language: input.language,
            tone: input.tone,
            format: input.format,
            targetSeconds: input.targetSeconds
          }
        });
        if (editorialPlan.readiness !== "editorial_plan_only") {
          packageReadiness = "blocked";
          packageReasonCode = editorialPlan.reasonCode || "EDITORIAL_PLAN_BLOCKED";
          markNotRun("metadata_thumbnail_plan", "UPSTREAM_BLOCKED");
          markNotRun("subtitle_plan", "UPSTREAM_BLOCKED");
        } else {
          // Chain binding before the next stage runs (fail closed on tampering).
          assertBinding(editorialPlan.briefId, brief.briefId, "AI_NEWS_PACKAGE_BRIEF_PLAN_MISMATCH");

          // 3. Metadata + thumbnail plan (drafts only).
          metadataPlan = await runStage(STAGES[2], {
            metadataInput: { schemaVersion: SCHEMA_VERSION, brief, editorialPlan }
          });
          if (metadataPlan.readiness !== "metadata_thumbnail_plan_only") {
            packageReadiness = "blocked";
            packageReasonCode = metadataPlan.reasonCode || "METADATA_PLAN_BLOCKED";
            markNotRun("subtitle_plan", "UPSTREAM_BLOCKED");
          } else {
            assertBinding(metadataPlan.editorialPlanId, editorialPlan.planId, "AI_NEWS_PACKAGE_PLAN_ID_MISMATCH");
            assertBinding(metadataPlan.briefId, brief.briefId, "AI_NEWS_PACKAGE_METADATA_BRIEF_MISMATCH");

            // 4. Subtitle plan — requires owner-supplied timed narration.
            if (input.timedNarrationSegments !== undefined) {
              const segments = validateTimedNarrationSegments(input.timedNarrationSegments);
              const narration = createNarrationInputRegistry({
                schemaVersion: SCHEMA_VERSION,
                ownerId,
                agentId: AI_NEWS_AGENT_ID,
                language: editorialPlan.language,
                segments
              });
              subtitlePlan = await runStage(STAGES[3], {
                subtitleInput: { schemaVersion: SCHEMA_VERSION, brief, editorialPlan, narration }
              });
              if (subtitlePlan.readiness === "subtitle_plan_only") {
                assertBinding(subtitlePlan.editorialPlanId, editorialPlan.planId, "AI_NEWS_PACKAGE_SUBTITLE_PLAN_MISMATCH");
                assertBinding(subtitlePlan.briefId, brief.briefId, "AI_NEWS_PACKAGE_SUBTITLE_BRIEF_MISMATCH");
                subtitleStatus = "completed";
                subtitleReasonCode = null;
              } else {
                packageReadiness = "blocked";
                packageReasonCode = subtitlePlan.reasonCode || "SUBTITLE_PLAN_BLOCKED";
                subtitleStatus = "blocked";
              }
            } else {
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
              this.#recordEvidence(packageTaskId, "ai_news_stage_skipped", {
                stage: "subtitle_plan",
                reasonCode: subtitleReasonCode
              });
              subtitleWaitingForNarrationInput = true;
              packageReadiness = "package_incomplete_pending_narration_input";
            }
          }
        }
      }

      if (subtitleWaitingForNarrationInput) {
        stageRecords.push({
          stage: "subtitle_plan",
          status: subtitleStatus,
          taskId: `${packageTaskId}#subtitle_plan`,
          jobType: STAGES[3].jobType,
          resultHash: null,
          readiness: null,
          reasonCode: subtitleReasonCode
        });
      }

      const completedStages = stageRecords.filter((record) => record.status === "completed").length;
      const packageIdSeed = {
        schemaVersion: SCHEMA_VERSION,
        orchestrator: "ai_news_content_package_v1",
        briefId: brief.briefId,
        editorialPlanId: editorialPlan?.planId ?? null,
        metadataPlanId: metadataPlan?.planId ?? null,
        registryId: subtitlePlan?.registryId ?? null,
        subtitlePlanId: subtitlePlan?.planId ?? null,
        packageReadiness
      };
      const packageId = stableHash(packageIdSeed);

      const packageResult = {
        schemaVersion: SCHEMA_VERSION,
        orchestrator: "ai_news_content_package_v1",
        packageId,
        packageTaskId,
        agentId: AI_NEWS_AGENT_ID,
        ownerId,
        readiness: packageReadiness,
        reasonCode: packageReasonCode,
        briefId: brief.briefId,
        researchBrief: brief,
        editorialPlan,
        metadataThumbnailPlan: metadataPlan,
        subtitlePlan,
        stages: stageRecords,
        stagesCompleted: completedStages,
        provenance: {
          generationMode: "deterministic_local",
          providerCalls: 0,
          networkCalls: 0,
          generatedMediaCount: 0,
          mediaStatus: "not_generated",
          note: "Deterministic plans only. Narration audio, images, rendering, and publishing require owner-approved providers or owner-supplied input and are NOT produced by this orchestrator."
        },
        publication: { requested: false, status: "not_requested" }
      };

      await this.checkpointStore.write(`${packageTaskId}#package`, {
        step: "content_package_ready",
        progress: 100,
        data: {
          readiness: packageReadiness,
          reasonCode: packageReasonCode,
          packageId,
          briefId: brief.briefId,
          stagesCompleted: completedStages,
          providerCalls: 0,
          generatedMediaCount: 0
        }
      });
      this.#recordEvidence(packageTaskId, "ai_news_content_package_completed", {
        readiness: packageReadiness,
        reasonCode: packageReasonCode,
        packageId,
        resultHash: stableHash(packageResult)
      });

      return Object.freeze(packageResult);
    } catch (error) {
      await this.checkpointStore.write(`${packageTaskId}#package`, {
        step: "content_package_stage_failed",
        progress: 0,
        data: {
          errorCode: String(error?.message || "AI_NEWS_PACKAGE_STAGE_FAILED").slice(0, 200),
          resumable: true,
          executionStarted: false
        }
      }).catch(() => {});
      this.#recordEvidence(packageTaskId, "ai_news_content_package_failed", {
        errorCode: String(error?.message || "AI_NEWS_PACKAGE_STAGE_FAILED").slice(0, 200)
      });
      throw error;
    }
  }
}
