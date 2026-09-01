import test from "node:test";
import assert from "node:assert/strict";
import { DevelopmentPlanError, executionOrder, parseDevelopmentPlan } from "../src/automation/developmentPlan.js";

test("development plan parses granular tasks and returns deterministic execution order", () => {
  const plan = parseDevelopmentPlan(`# Release\n\n## Goal\nShip the first control-plane slice.\n\n## Tasks\n- [ ] B-2: Add verification (depends on: A-1)\n- [x] A-1: Define task contract\n- [ ] C-3: Wire CI (depends on: B-2)\n`);

  assert.equal(plan.goal, "Ship the first control-plane slice.");
  assert.deepEqual(executionOrder(plan), ["A-1", "B-2", "C-3"]);
  assert.equal(plan.tasks[1].completed, true);
});

test("development plan rejects malformed, unknown, and cyclic tasks", () => {
  assert.throws(
    () => parseDevelopmentPlan("## Goal\nA goal\n## Tasks\n- [ ] invalid task"),
    DevelopmentPlanError
  );
  assert.throws(
    () => parseDevelopmentPlan("## Goal\nA goal\n## Tasks\n- [ ] A-1: Task (depends on: B-2)"),
    /unknown task B-2/
  );

  const cyclic = parseDevelopmentPlan("## Goal\nA goal\n## Tasks\n- [ ] A-1: First (depends on: B-2)\n- [ ] B-2: Second (depends on: A-1)");
  assert.throws(() => executionOrder(cyclic), /cycle/);
});
