import test from "node:test";
import assert from "node:assert/strict";
import {
  persistLifecycleToGit,
  recordPromotion
} from "../.github/scripts/backlog-feeder.mjs";

test("lifecycle: recordPromotion appends once and is idempotent", () => {
  const lifecycle = { schemaVersion: 1, promotedSliceIds: ["S-A-01"] };
  assert.equal(recordPromotion(lifecycle, "S-B-02"), true);
  assert.deepEqual(lifecycle.promotedSliceIds, ["S-A-01", "S-B-02"]);
  assert.equal(recordPromotion(lifecycle, "S-B-02"), false);
  assert.deepEqual(lifecycle.promotedSliceIds, ["S-A-01", "S-B-02"]);
});

test("lifecycle: unchanged lifecycle is an honest no-op with zero git calls", () => {
  const calls = [];
  const result = persistLifecycleToGit({
    changed: false,
    sliceIds: [],
    branch: "main",
    runGit: (args) => calls.push(args)
  });
  assert.deepEqual(result, { committed: false });
  assert.deepEqual(calls, []);
});

test("lifecycle: recorded completions are committed and pushed to the default branch", () => {
  const calls = [];
  const result = persistLifecycleToGit({
    changed: true,
    sliceIds: ["S-M21-01"],
    branch: "main",
    runGit: (args) => calls.push(args)
  });
  assert.deepEqual(result, { committed: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["add", "automation/backlog/lifecycle.json"]);
  assert.equal(calls[1][calls[1].length - 2], "-m");
  assert.match(calls[1][calls[1].length - 1], /S-M21-01/);
  assert.deepEqual(calls[2], ["push", "origin", "HEAD:refs/heads/main"]);
});

test("lifecycle: push failure is loud and fails with a stable code, never fake success", () => {
  const calls = [];
  const boom = () => {
    throw new Error("git push denied");
  };
  assert.throws(
    () =>
      persistLifecycleToGit({
        changed: true,
        sliceIds: ["S-X-01"],
        branch: "main",
        runGit: (args) => {
          calls.push(args);
          if (args[0] === "push") boom();
        }
      }),
    (error) => error.code === "BACKLOG_LIFECYCLE_PUSH_FAILED"
  );
  // Commit was attempted but nothing was reported as committed
  assert.equal(calls.some((args) => args[0] === "push"), true);
});
