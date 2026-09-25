/**
 * ST Production House — real-executor pipeline integration (Issue #183).
 *
 * Wires the REAL media executors (TTS #177/#179, visual #181, FFmpeg
 * assembly #174/#175) into the episode pipeline through ONE injected,
 * Director-scoped stage runner. The bridge (#182) persists every real
 * result with honest provenance.
 *
 * Architecture (Master Prompt §3/§4 — Director isolation):
 *   - The runner is invoked with `release.agentId` ONLY. There is no shared
 *     mutable production context: every profile, request, and plan is built
 *     per-call from the release's own identity. A runner implementation that
 *     serves multiple Directors must keep runtime state, provider slots,
 *     credentials, and asset paths Director-scoped on ITS side of this
 *     boundary — nothing here shares state across releases.
 *   - Executor results flow through evaluateExecutorArtifact (#182), whose
 *     `EXECUTOR_AGENT_SCOPE_MISMATCH` gate fails closed on any result whose
 *     descriptor was produced by a different Director. This module is
 *     stateless: it never caches credentials, prompts, or provider slots.
 *
 * Honesty contract (Rules 1–3):
 *   - No runner injected → the caller runs the historical deterministic
 *     path. This module NEVER fabricates executor results.
 *   - WAITING_FOR_QUOTA / CREDENTIAL_MISSING are DURABLE WAITS, not stage
 *     failures: they surface as { blocked: true, waiting: true } with the
 *     stable code so the scheduler can resume later — never a fake success
 *     and never a destructive failure that would discard completed stages.
 *   - Every failure carries its stable executor code; no stderr, argv, or
 *     path detail escapes through this boundary (the #182 projection drops
 *     them before persistence).
 */

import {
  evaluateExecutorArtifact,
  EXECUTOR_WAIT_CODES,
} from "./episodePipeline.js";

export const EXECUTOR_INTEGRATION_VERSION = "executor_integration_v1";

/** Stages this module can drive through real executors. */
export const EXECUTOR_STAGES = Object.freeze(["audio", "visual", "assembly"]);

/** Stable executor failure codes that mean WAIT, not fail (bridge-owned). */
export { EXECUTOR_WAIT_CODES };

/**
 * Immutable per-call execution context for one release stage. Built from the
 * release's own binding; nothing is shared or cached across releases.
 */
export function createStageExecutionContext({ release, stage, stageInputs }) {
  if (!release || typeof release !== "object" || typeof release.agentId !== "string" || release.agentId.length === 0) {
    const error = new Error("EXECUTOR_STAGE_MISMATCH");
    error.code = "EXECUTOR_STAGE_MISMATCH";
    throw error;
  }
  if (!EXECUTOR_STAGES.includes(stage)) {
    throw new Error("UNKNOWN_PIPELINE_STAGE");
  }
  return Object.freeze({
    contextVersion: EXECUTOR_INTEGRATION_VERSION,
    stage,
    agentId: release.agentId,
    releaseId: release.id ?? null,
    title: typeof stageInputs?.title === "string" ? stageInputs.title : null,
    season: typeof stageInputs?.season === "number" ? stageInputs.season : null,
    episode: typeof stageInputs?.episode === "number" ? stageInputs.episode : null,
    channelId: typeof stageInputs?.channelId === "string" ? stageInputs.channelId : null,
  });
}

/**
 * Run ONE pipeline stage through the injected real-executor runner and
 * evaluate the result through the #182 bridge.
 *
 *   runner: async ({ release, stage, stageInputs, agentId }) => executorResult
 *
 * The runner contract mirrors the real executors' result shape
 * (`success`, `failureCode`, `quotaState`, `mediaStatus`, `generationMode`,
 * `descriptor`, `outcome`, `inspection`). The runner is Director-scoped by
 * construction: it receives `release.agentId` and must only use that
 * Director's provider slots, credentials, and asset paths.
 *
 * Returns one of:
 *   { status: "recorded", verdict, executorResult }   — media result recorded
 *   { status: "waiting",  verdict, failureCode }      — durable wait (resume later)
 *   { status: "failed",   verdict, failureCode }      — truthful stage failure
 *
 * Throws only for contract violations (UNKNOWN_PIPELINE_STAGE,
 * EXECUTOR_STAGE_MISMATCH, or bridge gate codes) — never for honest
 * executor failures, which are returned, not thrown.
 */
export async function runStageWithExecutor({ release, stage, stageInputs, runner }) {
  if (typeof runner !== "function") {
    const error = new Error("EXECUTOR_RUNNER_REQUIRED");
    error.code = "EXECUTOR_RUNNER_REQUIRED";
    throw error;
  }
  const context = createStageExecutionContext({ release, stage, stageInputs });

  const executorResult = await runner({
    release,
    stage,
    stageInputs,
    agentId: context.agentId,
  });

  const verdict = evaluateExecutorArtifact({ stage, release, executorResult });

  if (verdict.waiting === true) {
    return Object.freeze({ status: "waiting", verdict, failureCode: verdict.failureCode ?? "QUOTA_EXHAUSTED" });
  }
  if (verdict.verified !== true) {
    // Unverified but shaped result (executor ran, inspection failed): a
    // truthful stage failure carrying the executor's stable code.
    return Object.freeze({ status: "failed", verdict, failureCode: verdict.failureCode ?? "EXECUTOR_INSPECTION_UNAVAILABLE" });
  }
  return Object.freeze({ status: "recorded", verdict, executorResult });
}

/**
 * Classify an executor result WITHOUT running the bridge — used by the
 * pipeline to decide whether a stage outcome is a durable wait (keep
 * earlier stages intact, mark the job waiting) before recording.
 * Fail-closed: unknown codes are failures, never waits.
 */
export function classifyExecutorWait(executorResult) {
  if (executorResult === null || typeof executorResult !== "object" || Array.isArray(executorResult)) {
    return { waiting: false, failureCode: "EXECUTOR_RESULT_MALFORMED" };
  }
  if (executorResult.quotaState === "WAITING_FOR_QUOTA") {
    const code = typeof executorResult.failureCode === "string" ? executorResult.failureCode : "QUOTA_EXHAUSTED";
    if (EXECUTOR_WAIT_CODES.includes(code)) {
      return { waiting: true, failureCode: code };
    }
  }
  return { waiting: false, failureCode: typeof executorResult.failureCode === "string" ? executorResult.failureCode : null };
}

// Re-exports so the pipeline (and tests) consume one integration surface.
export { evaluateExecutorArtifact, projectExecutorResult, recordExecutorArtifact } from "./episodePipeline.js";
