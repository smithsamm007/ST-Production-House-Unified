import test from "node:test";
import assert from "node:assert/strict";
import { parseRoadmapTasks, TaskLoopManager, loadWorkspaceRoadmap } from "../automation/continuousPipeline.js";

test("Continuous Pipeline - Task Parser extracts tasks from ROADMAP markdown", () => {
  const sampleMarkdown = `
## Continuous Task Execution Matrix

| Task ID | Component Scope | High-Level Goal | Dependencies | Verification Command |
|---|---|---|---|---|
| **TASK-101** | \`automation/continuousPipeline.js\` | Task parser | None | \`node --test tests/continuousPipeline.test.js\` |
| **TASK-102** | \`src/credentials/credentialBroker.js\` | Credential broker | TASK-101 | \`node --test tests/credentialBroker.test.js\` |
  `;

  const tasks = parseRoadmapTasks(sampleMarkdown);
  assert.equal(tasks.length, 2);

  assert.equal(tasks[0].taskId, "TASK-101");
  assert.equal(tasks[0].scope, "automation/continuousPipeline.js");
  assert.equal(tasks[0].goal, "Task parser");
  assert.deepEqual(tasks[0].dependencies, []);
  assert.equal(tasks[0].verificationCmd, "node --test tests/continuousPipeline.test.js");

  assert.equal(tasks[1].taskId, "TASK-102");
  assert.deepEqual(tasks[1].dependencies, ["TASK-101"]);
});

test("Continuous Pipeline - Task Loop Manager tracks attempts, retries, and exhaustion", () => {
  const manager = new TaskLoopManager({ maxAttempts: 2 });

  const taskId = "TASK-101";
  assert.equal(manager.getTaskState(taskId).status, "PENDING");

  // Attempt 1
  manager.recordAttemptStart(taskId);
  assert.equal(manager.getTaskState(taskId).attempts, 1);
  assert.equal(manager.getTaskState(taskId).status, "RUNNING");

  // Attempt 1 fails
  manager.recordFailure(taskId, new Error("Transient error"));
  assert.equal(manager.getTaskState(taskId).status, "RETRY_QUEUED");
  assert.equal(manager.shouldRetry(taskId), true);

  // Attempt 2
  manager.recordAttemptStart(taskId);
  assert.equal(manager.getTaskState(taskId).attempts, 2);

  // Attempt 2 fails -> exhausted
  manager.recordFailure(taskId, new Error("Second failure"));
  assert.equal(manager.getTaskState(taskId).status, "FAILED_EXHAUSTED");
  assert.equal(manager.shouldRetry(taskId), false);
});

test("Continuous Pipeline - Task Loop Manager records success", () => {
  const manager = new TaskLoopManager({ maxAttempts: 3 });
  const taskId = "TASK-102";

  manager.recordAttemptStart(taskId);
  manager.recordSuccess(taskId);

  assert.equal(manager.getTaskState(taskId).status, "COMPLETED");
  assert.equal(manager.shouldRetry(taskId), false);
});

test("Continuous Pipeline - loadWorkspaceRoadmap parses ROADMAP.md in repo root", () => {
  const tasks = loadWorkspaceRoadmap();
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.length >= 1);
  assert.equal(tasks[0].taskId, "TASK-101");
});
