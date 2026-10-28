import test from "node:test";
import assert from "node:assert/strict";
import { RoadmapParser } from "../src/orchestration/roadmapParser.js";
import { TaskEnvelope } from "../src/orchestration/taskEnvelope.js";
import { TestFixLoop, MAX_RETRY_ATTEMPTS, FAILURE_TYPES } from "../src/orchestration/testFixLoop.js";
import { PipelineController } from "../src/orchestration/pipelineController.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

// ----------------------------------------------------
// 1. Roadmap Parser Tests
// ----------------------------------------------------
test("RoadmapParser: correctly parses markdown tasks and identifies statuses", () => {
  const sampleRoadmap = `
# Sample Roadmap
- [x] **TASK-1.1** \`[lane-1]\`: Digital identity baseline
- [x] **TASK-1.2** \`[lane-3]\`: Creative charter schema
- [ ] **TASK-2.1** \`[lane-1]\`: Credential broker locator
- [ ] **TASK-2.2** \`[lane-2]\`: Provider router
- [ ] **TASK-2.7** \`[lane-3]\`: Continuous development pipeline
  `;

  const tasks = RoadmapParser.parseRoadmap(sampleRoadmap);
  assert.equal(tasks.length, 5);

  assert.equal(tasks[0].taskId, "TASK-1.1");
  assert.equal(tasks[0].lane, "lane-1");
  assert.equal(tasks[0].status, "completed");
  assert.equal(tasks[0].assignee, "jules");

  assert.equal(tasks[4].taskId, "TASK-2.7");
  assert.equal(tasks[4].lane, "lane-3");
  assert.equal(tasks[4].status, "ready");
  assert.equal(tasks[4].assignee, "night-shift");
});

test("RoadmapParser: resolves executable tasks with dependencies and lane limits", () => {
  const tasks = [
    { taskId: "TASK-1", lane: "lane-1", status: "completed", dependencies: [] },
    { taskId: "TASK-2", lane: "lane-1", status: "ready", dependencies: ["TASK-1"] },
    { taskId: "TASK-3", lane: "lane-2", status: "ready", dependencies: ["TASK-99"] }, // unmet dep
    { taskId: "TASK-4", lane: "lane-3", status: "ready", dependencies: ["TASK-1"] }
  ];

  const eligible = RoadmapParser.resolveExecutableTasks(tasks, ["TASK-1"], ["lane-3"]);
  // lane-3 is already busy, TASK-3 has unmet dep, TASK-2 should be eligible
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].taskId, "TASK-2");
  assert.equal(eligible[0].lane, "lane-1");
});

test("RoadmapParser: parses individual issue spec markdown", () => {
  const specMarkdown = `
## Goal
Implement a fault-tolerant worker supervisor.

## Deliverables
- NEW \`src/workers/supervisor.js\`
- NEW \`tests/supervisor.test.js\`

## Acceptance criteria
- [ ] Supervisor restarts faulted worker
- [ ] Zero new npm dependencies
  `;

  const parsed = RoadmapParser.parseSpec(specMarkdown, { taskId: "TASK-3.1", lane: "lane-3" });
  assert.equal(parsed.taskId, "TASK-3.1");
  assert.equal(parsed.lane, "lane-3");
  assert.equal(parsed.deliverables.length, 2);
  assert.equal(parsed.acceptanceCriteria.length, 2);
  assert.ok(parsed.goal.includes("fault-tolerant worker supervisor"));
});

// ----------------------------------------------------
// 2. Task Envelope & Territory Guard Tests
// ----------------------------------------------------
test("TaskEnvelope: creates valid immutable execution envelope with branch slug", () => {
  const envelope = TaskEnvelope.create({
    taskId: "TASK-2.7",
    lane: "lane-3",
    issueNumber: 42,
    title: "Continuous pipeline orchestration",
    assignee: "night-shift",
    targetFiles: ["src/orchestration/pipelineController.js", "tests/orchestration.test.js"]
  });

  assert.equal(envelope.taskId, "TASK-2.7");
  assert.equal(envelope.lane, "lane-3");
  assert.equal(envelope.branchName, "task/42-continuous-pipeline-orchestration");
  assert.equal(envelope.assignee, "night-shift");
  assert.equal(envelope.status, "initialized");
  assert.ok(Object.isFrozen(envelope));
});

test("TaskEnvelope: rejects lane-assignee mismatch", () => {
  assert.throws(
    () => {
      TaskEnvelope.create({
        taskId: "TASK-2.1",
        lane: "lane-1",
        title: "Credential broker",
        assignee: "night-shift", // Lane 1 requires jules
        targetFiles: ["src/broker/locator.js"]
      });
    },
    { message: /LANE_ASSIGNEE_MISMATCH_JULES_REQUIRED/ }
  );
});

test("TaskEnvelope: enforces territory boundaries strictly", () => {
  // Jules trying to modify night-shift territory
  assert.throws(
    () => {
      TaskEnvelope.create({
        taskId: "TASK-2.1",
        lane: "lane-1",
        title: "Credential broker",
        assignee: "jules",
        targetFiles: ["src/api/server.js"] // Night-shift territory!
      });
    },
    { message: /TERRITORY_VIOLATION/ }
  );

  // Night-shift trying to modify jules territory
  assert.throws(
    () => {
      TaskEnvelope.create({
        taskId: "TASK-2.7",
        lane: "lane-3",
        title: "Pipeline orchestration",
        assignee: "night-shift",
        targetFiles: ["src/broker/locator.js"] // Jules territory!
      });
    },
    { message: /TERRITORY_VIOLATION/ }
  );
});

test("TaskEnvelope: enforces Rule 15 (agent names internal-only in titles)", () => {
  assert.throws(
    () => {
      TaskEnvelope.create({
        taskId: "TASK-3.2",
        lane: "lane-3",
        title: "Deploy JARVIS automation script", // Rule 15 violation
        assignee: "night-shift",
        targetFiles: ["src/jarvis/deterministicScriptPlan.js"]
      });
    },
    { message: /RULE_15_VIOLATION/ }
  );
});

test("TaskEnvelope: enforces Rule 17 (no plaintext secrets in task envelope)", () => {
  assert.throws(
    () => {
      TaskEnvelope.create({
        taskId: "TASK-2.1",
        lane: "lane-1",
        title: "Setup broker with api_key='sk_test_12345'", // Rule 17 violation
        assignee: "jules",
        targetFiles: ["src/broker/locator.js"]
      });
    },
    { message: /RULE_17_VIOLATION/ }
  );
});

test("TaskEnvelope: produces safe DTO conforming to allowlist", () => {
  const envelope = TaskEnvelope.create({
    taskId: "TASK-2.7",
    lane: "lane-3",
    issueNumber: 15,
    title: "Safe DTO test",
    assignee: "night-shift",
    targetFiles: ["src/orchestration/taskEnvelope.js"]
  });

  const dto = TaskEnvelope.toSafeDTO(envelope);
  assert.deepEqual(Object.keys(dto).sort(), [
    "attemptCount",
    "branchName",
    "createdAt",
    "lane",
    "status",
    "taskId"
  ]);
});

// ----------------------------------------------------
// 3. Test-Fix & Fault Tolerance Loop Tests
// ----------------------------------------------------
test("TestFixLoop: sanitizes passwords, bearer tokens, and credentials from diagnostics", () => {
  const rawLog = "Error at Bearer eyJhbGciOi... and password='super_secret_pwd' and postgres://user:pass123@localhost:5432/db";
  const sanitized = TestFixLoop.sanitizeDiagnosticOutput(rawLog);

  assert.ok(!sanitized.includes("eyJhbGciOi"));
  assert.ok(!sanitized.includes("super_secret_pwd"));
  assert.ok(!sanitized.includes("pass123"));
  assert.ok(sanitized.includes("[REDACTED]"));
});

test("TestFixLoop: correctly classifies failures and determines retry eligibility", () => {
  const syntaxErr = new SyntaxError("Unexpected token in file.js");
  const classification = TestFixLoop.classifyFailure(syntaxErr);
  assert.equal(classification.type, FAILURE_TYPES.SYNTAX_ERROR);
  assert.equal(classification.isFatal, false);

  const leakErr = new Error("RULE_17_VIOLATION: Plaintext secret detected");
  const leakClassification = TestFixLoop.classifyFailure(leakErr);
  assert.equal(leakClassification.type, FAILURE_TYPES.SECRET_LEAK_DETECTED);
  assert.equal(leakClassification.isFatal, true);
});

test("TestFixLoop: enforces max 3 attempts rule (Rule R9) and transitions to blocked", () => {
  // Attempt 1 -> retry
  const attempt1 = TestFixLoop.evaluateAttempt({
    attemptCount: 0,
    taskId: "TASK-2.7",
    error: new Error("AssertionError: 1 !== 2")
  });
  assert.equal(attempt1.action, "retry");
  assert.equal(attempt1.attemptCount, 1);
  assert.equal(attempt1.canRetry, true);

  // Attempt 2 -> retry
  const attempt2 = TestFixLoop.evaluateAttempt({
    attemptCount: 1,
    taskId: "TASK-2.7",
    error: new Error("AssertionError: 1 !== 2")
  });
  assert.equal(attempt2.action, "retry");
  assert.equal(attempt2.attemptCount, 2);
  assert.equal(attempt2.canRetry, true);

  // Attempt 3 -> escalate_blocked
  const attempt3 = TestFixLoop.evaluateAttempt({
    attemptCount: 2,
    taskId: "TASK-2.7",
    error: new Error("AssertionError: 1 !== 2")
  });
  assert.equal(attempt3.action, "escalate_blocked");
  assert.equal(attempt3.attemptCount, 3);
  assert.equal(attempt3.status, "blocked");
  assert.equal(attempt3.canRetry, false);
});

// ----------------------------------------------------
// 4. End-to-End Pipeline Controller Tests
// ----------------------------------------------------
test("PipelineController: orchestrates task planning, execution with healing, and evidence recording", async () => {
  const ledger = new EvidenceLedger();
  const pipeline = new PipelineController({ evidenceLedger: ledger });

  const sampleRoadmap = `
# Continuous Development Roadmap
- [ ] **TASK-2.7** \`[lane-3]\`: Autonomous test-fix loop implementation
  `;

  // 1. Plan
  const eligible = pipeline.planFromRoadmap(sampleRoadmap);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].taskId, "TASK-2.7");

  // 2. Dispatch
  const envelope = pipeline.dispatchTask({
    taskId: "TASK-2.7",
    lane: "lane-3",
    issueNumber: 99,
    title: "Autonomous test-fix loop implementation",
    assignee: "night-shift",
    targetFiles: ["src/orchestration/pipelineController.js"]
  });

  // Attempting to dispatch another task in lane-3 while locked throws
  assert.throws(
    () => {
      pipeline.dispatchTask({
        taskId: "TASK-2.8",
        lane: "lane-3",
        title: "Another task in same lane",
        assignee: "night-shift",
        targetFiles: ["src/orchestration/pipelineController.js"]
      });
    },
    { message: /LANE_BUSY/ }
  );

  // 3. Execute with simulated 1-failure healing
  let attemptsMade = 0;
  const result = await pipeline.executeWithHealing(envelope, async ({ attempt }) => {
    attemptsMade++;
    if (attempt === 1) {
      throw new Error("Temporary test flake in assertion");
    }
    return { hash: "sha256-verified-output-12345" };
  });

  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.equal(result.attempts, 2);
  assert.equal(attemptsMade, 2);
  assert.ok(result.evidenceHash);

  // Lane lock should now be released
  const state = pipeline.getState();
  assert.equal(state.activeLanes.length, 0);
  assert.equal(state.completedTasks.includes("TASK-2.7"), true);
  assert.ok(state.evidenceCount >= 2); // Dispatch + Completed events recorded
});

test("PipelineController: escalates to blocked when all 3 retry attempts fail", async () => {
  const ledger = new EvidenceLedger();
  const pipeline = new PipelineController({ evidenceLedger: ledger });

  const envelope = pipeline.dispatchTask({
    taskId: "TASK-9.9",
    lane: "lane-3",
    title: "Failing test task",
    assignee: "night-shift",
    targetFiles: ["src/orchestration/pipelineController.js"]
  });

  const result = await pipeline.executeWithHealing(envelope, async () => {
    throw new Error("Persistent syntax error in generated code");
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.attempts, 3);
  assert.equal(result.reason, "MAX_ATTEMPTS_EXCEEDED");

  const state = pipeline.getState();
  assert.ok(state.blockedTasks["TASK-9.9"]);
  assert.equal(state.activeLanes.length, 0);
});
