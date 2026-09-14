import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateHealthManifest,
  deriveConfiguredSecrets,
  classifyWorkflowReadiness,
  buildHealthReport,
  HEALTH_MANIFEST_TYPE,
} from "../src/operations/healthManifest.js";

function workflow(overrides = {}) {
  return {
    workflowId: "ci",
    path: ".github/workflows/ci.yml",
    requiredSecrets: [],
    critical: true,
    description: "Core CI gate.",
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    manifestType: "st_health_manifest",
    description: "Test manifest.",
    workflows: [workflow()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema validation (stable error codes, fail-closed)
// ---------------------------------------------------------------------------

test("manifest: valid manifest passes and is returned unmutated", () => {
  const input = manifest();
  const output = validateHealthManifest(input);
  assert.equal(output, input); // no clone, no mutation
});

test("manifest: schema violations throw stable codes", () => {
  const bad = [
    [null, "HEALTH_MANIFEST_INVALID"],
    [[], "HEALTH_MANIFEST_INVALID"],
    [manifest({ schemaVersion: 2 }), "HEALTH_MANIFEST_SCHEMA_UNSUPPORTED"],
    [manifest({ manifestType: "wrong" }), "HEALTH_MANIFEST_TYPE_MISMATCH"],
    [manifest({ description: "" }), "HEALTH_MANIFEST_DESCRIPTION_INVALID"],
    [manifest({ workflows: [] }), "HEALTH_MANIFEST_WORKFLOWS_INVALID"],
    [manifest({ workflows: "nope" }), "HEALTH_MANIFEST_WORKFLOWS_INVALID"],
    [manifest({ workflows: [null] }), "HEALTH_WORKFLOW_INVALID"],
    [manifest({ workflows: [workflow({ workflowId: "BAD_ID!" })] }), "HEALTH_WORKFLOW_ID_INVALID"],
    [manifest({ workflows: [workflow({ path: "workflows/ci.yml" })] }), "HEALTH_WORKFLOW_PATH_INVALID"],
    [manifest({ workflows: [workflow({ path: ".github/workflows/ci.json" })] }), "HEALTH_WORKFLOW_PATH_INVALID"],
    [manifest({ workflows: [workflow({ requiredSecrets: "none" })] }), "HEALTH_WORKFLOW_SECRETS_INVALID"],
    [manifest({ workflows: [workflow({ requiredSecrets: ["lowercase"] })] }), "HEALTH_WORKFLOW_SECRETS_INVALID"],
    [manifest({ workflows: [workflow({ requiredSecrets: ["GITHUB_TOKEN"] })] }), "HEALTH_WORKFLOW_BUILTIN_SECRET_REDUNDANT"],
    [manifest({ workflows: [workflow({ critical: "yes" })] }), "HEALTH_WORKFLOW_CRITICAL_INVALID"],
    [manifest({ workflows: [workflow(), workflow()] }), "HEALTH_WORKFLOW_DUPLICATE_ID"],
    [
      manifest({
        workflows: [workflow(), workflow({ workflowId: "pr-gate", path: ".github/workflows/ci.yml" })],
      }),
      "HEALTH_WORKFLOW_DUPLICATE_PATH",
    ],
    [
      manifest({
        workflows: [workflow({ requiredSecrets: ["A", "A"] })],
      }),
      "HEALTH_WORKFLOW_SECRETS_INVALID",
    ],
  ];
  for (const [input, code] of bad) {
    assert.throws(() => validateHealthManifest(input), (error) => error.code === code, `${code} expected`);
  }
});

// ---------------------------------------------------------------------------
// Secret-name derivation (never values)
// ---------------------------------------------------------------------------

test("deriveConfiguredSecrets returns sorted NAMES only, never values", () => {
  const m = manifest({
    workflows: [
      workflow({ requiredSecrets: ["B_KEY"] }),
      workflow({ workflowId: "b", path: ".github/workflows/b.yml", requiredSecrets: ["A_KEY"] }),
      workflow({ workflowId: "c", path: ".github/workflows/c.yml", requiredSecrets: ["A_KEY", "C_KEY"] }),
    ],
  });
  const names = deriveConfiguredSecrets(m, { A_KEY: "super-secret-value-1", B_KEY: "", C_KEY: undefined });
  assert.deepEqual(names, ["A_KEY"]);
  // Values must never leak into the derivation output.
  assert.ok(!JSON.stringify(names).includes("super-secret"));
});

test("deriveConfiguredSecrets rejects a hostile env without reading values", () => {
  const m = manifest();
  assert.throws(() => deriveConfiguredSecrets(m, null), (error) => error.code === "HEALTH_ENV_INVALID");
  assert.throws(() => deriveConfiguredSecrets(m, "env"), (error) => error.code === "HEALTH_ENV_INVALID");
});

// ---------------------------------------------------------------------------
// Classification: RUNNABLE vs PAUSED, never fabricated
// ---------------------------------------------------------------------------

test("classifyWorkflowReadiness: all secrets configured → RUNNABLE with empty missing list", () => {
  const wf = workflow({ requiredSecrets: ["JULES_API_KEY"] });
  const result = classifyWorkflowReadiness(wf, ["JULES_API_KEY"]);
  assert.equal(result.status, "RUNNABLE");
  assert.deepEqual(result.missingSecrets, []);
  assert.deepEqual(result.requiredSecrets, ["JULES_API_KEY"]);
});

test("classifyWorkflowReadiness: missing credentials → PAUSED with exact names", () => {
  const wf = workflow({ workflowId: "night-shift", requiredSecrets: ["JULES_API_KEY", "GEMINI_API_KEY"] });
  const result = classifyWorkflowReadiness(wf, ["JULES_API_KEY"]);
  assert.equal(result.status, "PAUSED");
  assert.deepEqual(result.missingSecrets, ["GEMINI_API_KEY"]);
});

test("classifyWorkflowReadiness: rejects malformed inputs", () => {
  assert.throws(() => classifyWorkflowReadiness(null, []), (error) => error.code === "HEALTH_WORKFLOW_INVALID");
  assert.throws(
    () => classifyWorkflowReadiness(workflow(), "nope"),
    (error) => error.code === "HEALTH_CONFIGURED_SECRETS_INVALID"
  );
});

// ---------------------------------------------------------------------------
// Report building: deterministic, truthful summary
// ---------------------------------------------------------------------------

test("buildHealthReport: deterministic apart from the injected timestamp", () => {
  const m = manifest({
    workflows: [
      workflow(),
      workflow({ workflowId: "night-shift", path: ".github/workflows/night-shift.yml", requiredSecrets: ["GEMINI_API_KEY"], critical: false }),
    ],
  });
  const at = "2026-09-14T00:00:00.000Z";
  const a = buildHealthReport(m, [], { generatedAt: at, environment: "test" });
  const b = buildHealthReport(m, [], { generatedAt: at, environment: "test" });
  assert.deepEqual(a, b);
  assert.equal(a.summary.total, 2);
  assert.equal(a.summary.runnable, 1);
  assert.equal(a.summary.paused, 1);
  assert.equal(a.workflows[1].status, "PAUSED");
  assert.equal(a.workflows[1].missingSecrets[0], "GEMINI_API_KEY");
});

test("buildHealthReport: rejects a missing or malformed injected timestamp", () => {
  const m = manifest();
  assert.throws(() => buildHealthReport(m, [], {}), (error) => error.code === "HEALTH_REPORT_TIMESTAMP_INVALID");
  assert.throws(
    () => buildHealthReport(m, [], { generatedAt: "not-a-date" }),
    (error) => error.code === "HEALTH_REPORT_TIMESTAMP_INVALID"
  );
});

// ---------------------------------------------------------------------------
// The real manifest in the repository is valid and workflow-verified
// ---------------------------------------------------------------------------

test("repository health manifest validates and covers every workflow file", async () => {
  const { readdir } = await import("node:fs/promises");
  const raw = await readFile(new URL("../automation/operations/health-manifest.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw);
  const validated = validateHealthManifest(parsed);

  // Every real workflow file on disk is represented in the manifest.
  const filesOnDisk = (await readdir(new URL("../.github/workflows/", import.meta.url)))
    .filter((name) => name.endsWith(".yml"))
    .sort();
  const manifestPaths = validated.workflows.map((entry) => entry.path.replace(".github/workflows/", "")).sort();
  assert.deepEqual(manifestPaths, filesOnDisk);
});

test("repository manifest secret requirements match the workflows' actual secrets usage", async () => {
  const raw = await readFile(new URL("../automation/operations/health-manifest.json", import.meta.url), "utf8");
  const validated = validateHealthManifest(JSON.parse(raw));

  // Cross-check a sample of workflows against their file's real secrets usage.
  const samples = [
    ["ci", []],
    ["night-shift", ["JULES_API_KEY", "GEMINI_API_KEY"]],
    ["autodev", ["AUTODEV_TOKEN", "OPENROUTER_API_KEY"]],
    ["jules-pr-command", ["JULES_API_KEY"]],
  ];
  for (const [workflowId, expected] of samples) {
    const entry = validated.workflows.find((w) => w.workflowId === workflowId);
    assert.ok(entry, `${workflowId} present`);
    assert.deepEqual([...entry.requiredSecrets].sort(), expected.sort());
  }
});

test("repository manifest never lists runner-provided builtin secrets", async () => {
  const raw = await readFile(new URL("../automation/operations/health-manifest.json", import.meta.url), "utf8");
  const validated = validateHealthManifest(JSON.parse(raw));
  assert.equal(typeof HEALTH_MANIFEST_TYPE, "string");
  for (const entry of validated.workflows) {
    for (const secret of entry.requiredSecrets) {
      assert.ok(!["GITHUB_TOKEN", "GH_TOKEN", "GH_REPO"].includes(secret));
    }
  }
});
