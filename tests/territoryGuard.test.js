import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTerritory } from "../.github/scripts/territory-guard.mjs";

function approval(path, extra = {}) {
  return {
    path,
    reason: "Reviewed backend migration documented in docs/TERRITORY_GUARD.md",
    approvedBy: "owner",
    approvedOn: "2026-10-27",
    ...extra,
  };
}

test("prohibited: deleting protected root manifests fails and names every path", () => {
  const result = evaluateTerritory({
    deleted: ["package.json", "package-lock.json", "server.js", "eslint.config.js"],
    approvals: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unapproved, [
    "package.json",
    "package-lock.json",
    "server.js",
    "eslint.config.js",
  ]);
});

test("prohibited: deleting whole protected directories fails", () => {
  const result = evaluateTerritory({
    deleted: [
      "src/catalog/server.js",
      "src/media/ffmpegAssemblyExecutor.js",
      "tests/backlogFeeder.test.js",
      "sql/031_motion_stage.sql",
      "automation/backlog/lifecycle.json",
      "scripts/real_media_smoke.mjs",
      "public/dashboard.js",
      "specs/issue-01.md",
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.unapproved.length, 8);
  assert.deepEqual(result.approved, []);
});

test("permitted: app-only synchronization changes pass the guard", () => {
  const result = evaluateTerritory({
    deleted: [
      "app/src/main/java/com/example/stproductionhouse/MainActivity.kt",
      "app/src/main/res/values/strings.xml",
      "app/src/test/java/com/example/stproductionhouse/ProductionHouseTest.kt",
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.unapproved, []);
});

test("permitted: modification of a protected path is a reviewed-change concern, not a disappearance", () => {
  // The guard traps disappearances; legitimate modified backend files are
  // handled by review + the restored verification gates, not this guard.
  const result = evaluateTerritory({ deleted: [] });
  assert.equal(result.ok, true);
});

test("permitted: deletion is allowed only with a complete documented approval", () => {
  const result = evaluateTerritory({
    deleted: ["src/legacy/removedModule.js"],
    approvals: [approval("src/legacy/removedModule.js")],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.unapproved, []);
  assert.deepEqual(result.approved, ["src/legacy/removedModule.js"]);
});

test("placeholder approvals are rejected, never authorized silently", () => {
  const missingFields = evaluateTerritory({
    deleted: ["src/legacy/removedModule.js"],
    approvals: [{ path: "src/legacy/removedModule.js" }],
  });
  assert.equal(missingFields.ok, false);

  const emptyStrings = evaluateTerritory({
    deleted: ["src/legacy/removedModule.js"],
    approvals: [approval("src/legacy/removedModule.js", { approvedBy: "", approvedOn: "" })],
  });
  assert.equal(emptyStrings.ok, false);

  const emptyReason = evaluateTerritory({
    deleted: ["package.json"],
    approvals: [approval("package.json", { reason: "" })],
  });
  assert.equal(emptyReason.ok, false);
});

test("approval is per-path, not a wildcard", () => {
  const result = evaluateTerritory({
    deleted: ["src/legacy/a.js", "src/legacy/b.js"],
    approvals: [approval("src/legacy/a.js")],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unapproved, ["src/legacy/b.js"]);
});

test("mixed app deletion and unapproved backend deletion still fails", () => {
  const result = evaluateTerritory({
    deleted: [
      "app/src/main/AndroidManifest.xml",
      "src/pipeline/episodePipeline.js",
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unapproved, ["src/pipeline/episodePipeline.js"]);
});

test("empty and malformed approval arrays are tolerated safely", () => {
  assert.equal(evaluateTerritory({ deleted: ["src/a.js"], approvals: undefined }).ok, false);
  assert.equal(evaluateTerritory({ deleted: ["src/a.js"], approvals: null }).ok, false);
  assert.equal(evaluateTerritory({ deleted: ["src/a.js"], approvals: [42, "x"] }).ok, false);
});
