/**
 * ST Production House — Pipeline Controller & Continuous Delivery Orchestrator
 * Integrates planning, task generation, continuous execution, self-healing test loops,
 * and evidence ledger accounting.
 */

import { RoadmapParser } from "./roadmapParser.js";
import { TaskEnvelope } from "./taskEnvelope.js";
import { TestFixLoop } from "./testFixLoop.js";
import { EvidenceLedger } from "../evidence/evidenceLedger.js";
import { evaluateMergeEligibility } from "../../.github/scripts/merge-eligibility.mjs";

export class PipelineController {
  #evidenceLedger;
  #activeLanes = new Set();
  #completedTasks = new Set();
  #blockedTasks = new Map();

  constructor(options = {}) {
    this.#evidenceLedger = options.evidenceLedger || new EvidenceLedger();
  }

  /**
   * Ingest a roadmap markdown string and extract eligible executable tasks.
   * @param {string} roadmapMarkdown
   * @returns {Array<object>} Eligible tasks
   */
  planFromRoadmap(roadmapMarkdown) {
    const allTasks = RoadmapParser.parseRoadmap(roadmapMarkdown);
    const completedList = [...this.#completedTasks];
    const activeLaneList = [...this.#activeLanes];
    return RoadmapParser.resolveExecutableTasks(allTasks, completedList, activeLaneList);
  }

  /**
   * Dispatch a task into a governed execution lane.
   * @param {object} taskSpec
   * @returns {object} Initialized task envelope
   */
  dispatchTask(taskSpec) {
    if (this.#activeLanes.has(taskSpec.lane)) {
      throw new Error(`LANE_BUSY: ${taskSpec.lane} is currently locked by an active task`);
    }

    const envelope = TaskEnvelope.create(taskSpec);
    this.#activeLanes.add(envelope.lane);

    // Record dispatch evidence
    this.#evidenceLedger.append({
      subjectId: envelope.taskId,
      kind: "workflow_checkpoint",
      classification: "pipeline_dispatch",
      payload: {
        lane: envelope.lane,
        assignee: envelope.assignee,
        branchName: envelope.branchName
      }
    });

    return envelope;
  }

  /**
   * Execute an automated task with the self-healing test-fix loop.
   * @param {object} envelope - Task envelope
   * @param {Function} runnerFn - Async function executing task logic and tests
   * @returns {Promise<object>} Result outcome
   */
  async executeWithHealing(envelope, runnerFn) {
    let attemptCount = 0;
    let lastError = null;

    while (attemptCount < 3) {
      try {
        const runResult = await runnerFn({
          attempt: attemptCount + 1,
          envelope
        });

        // Success! Release lane lock and record completion
        this.#activeLanes.delete(envelope.lane);
        this.#completedTasks.add(envelope.taskId);

        const evidence = this.#evidenceLedger.append({
          subjectId: envelope.taskId,
          kind: "workflow_checkpoint",
          classification: "pipeline_completed",
          payload: {
            lane: envelope.lane,
            attemptCount: attemptCount + 1,
            outputHash: runResult?.hash || null
          }
        });

        return Object.freeze({
          success: true,
          status: "completed",
          taskId: envelope.taskId,
          lane: envelope.lane,
          attempts: attemptCount + 1,
          evidenceHash: evidence.eventHash
        });
      } catch (err) {
        lastError = err;
        const evaluation = TestFixLoop.evaluateAttempt({
          attemptCount,
          taskId: envelope.taskId,
          error: err
        });

        attemptCount = evaluation.attemptCount;

        if (!evaluation.canRetry) {
          // Escalate and mark blocked
          this.#activeLanes.delete(envelope.lane);
          this.#blockedTasks.set(envelope.taskId, evaluation);

          this.#evidenceLedger.append({
            subjectId: envelope.taskId,
            kind: "workflow_checkpoint",
            classification: "pipeline_blocked",
            payload: {
              lane: envelope.lane,
              attempts: attemptCount,
              reason: evaluation.reason,
              detail: evaluation.detail
            }
          });

          return Object.freeze({
            success: false,
            status: "blocked",
            taskId: envelope.taskId,
            lane: envelope.lane,
            attempts: attemptCount,
            reason: evaluation.reason,
            detail: evaluation.detail
          });
        }
      }
    }

    // Fallback if loop finishes unexpectedly
    this.#activeLanes.delete(envelope.lane);
    return Object.freeze({
      success: false,
      status: "blocked",
      taskId: envelope.taskId,
      lane: envelope.lane,
      attempts: attemptCount,
      reason: "MAX_ATTEMPTS_EXCEEDED"
    });
  }

  /**
   * Evaluate whether a completed PR is eligible for automated merge referee gate.
   * @param {object} params
   * @returns {object}
   */
  evaluateMerge(params) {
    return evaluateMergeEligibility(params);
  }

  /**
   * Get current pipeline state overview.
   */
  getState() {
    return Object.freeze({
      activeLanes: [...this.#activeLanes],
      completedTasks: [...this.#completedTasks],
      blockedTasks: Object.fromEntries(this.#blockedTasks.entries()),
      evidenceCount: this.#evidenceLedger.list().length
    });
  }
}
