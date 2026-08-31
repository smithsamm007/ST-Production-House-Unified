import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parses markdown ROADMAP.md task tables into structured task definitions.
 * @param {string} markdownContent
 * @returns {Array<{ taskId: string, scope: string, goal: string, dependencies: string[], verificationCmd: string }>}
 */
export function parseRoadmapTasks(markdownContent) {
  if (!markdownContent || typeof markdownContent !== "string") {
    return [];
  }

  const tasks = [];
  const lines = markdownContent.split(/\r?\n/);

  for (const line of lines) {
    // Look for table rows starting with | **TASK-
    if (line.includes("| **TASK-") || line.includes("| TASK-")) {
      const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 5) {
        const taskId = parts[0].replace(/\*\*/g, "").trim();
        const scope = parts[1].replace(/`/g, "").trim();
        const goal = parts[2].trim();
        const rawDeps = parts[3].trim();
        const dependencies = rawDeps.toUpperCase() === "NONE" ? [] : rawDeps.split(",").map((d) => d.trim());
        const verificationCmd = parts[4].replace(/`/g, "").trim();

        tasks.push({
          taskId,
          scope,
          goal,
          dependencies,
          verificationCmd
        });
      }
    }
  }

  return tasks;
}

/**
 * Manages task execution state, retries, and failure tracking for fault-tolerant loop management.
 */
export class TaskLoopManager {
  constructor({ maxAttempts = 3, retryDelayMs = 0 } = {}) {
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.taskState = new Map();
  }

  getTaskState(taskId) {
    if (!this.taskState.has(taskId)) {
      this.taskState.set(taskId, {
        attempts: 0,
        status: "PENDING",
        errors: []
      });
    }
    return this.taskState.get(taskId);
  }

  recordAttemptStart(taskId) {
    const state = this.getTaskState(taskId);
    state.attempts += 1;
    state.status = "RUNNING";
    return state;
  }

  recordSuccess(taskId) {
    const state = this.getTaskState(taskId);
    state.status = "COMPLETED";
    return state;
  }

  recordFailure(taskId, error) {
    const state = this.getTaskState(taskId);
    const sanitizedMsg = typeof error === "string" ? error : (error?.message ?? String(error));
    state.errors.push(sanitizedMsg);

    if (state.attempts >= this.maxAttempts) {
      state.status = "FAILED_EXHAUSTED";
    } else {
      state.status = "RETRY_QUEUED";
    }
    return state;
  }

  shouldRetry(taskId) {
    const state = this.getTaskState(taskId);
    return state.status === "RETRY_QUEUED" && state.attempts < this.maxAttempts;
  }
}

/**
 * Loads ROADMAP.md from workspace root if available.
 */
export function loadWorkspaceRoadmap(workspaceRoot = process.cwd()) {
  const path = resolve(workspaceRoot, "ROADMAP.md");
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, "utf-8");
  return parseRoadmapTasks(content);
}
