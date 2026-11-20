/**
 * Day 6 — stage handler registry and evidence contract unit tests.
 *
 * Pure tests: no database, no provider, no network. Every "real input" here is a
 * file written by the test into a temporary artifact root and clearly treated as
 * test data (the handlers hash its actual bytes).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  StageHandlerRegistry,
  createStageHandlerRegistry,
} from "../src/worker/stageHandlers.js";
import {
  EVIDENCE_ERROR,
  STAGE_ERROR,
  StageError,
  VERIFICATION_LEVEL,
  assertNoSecretMaterial,
  canonicalJson,
  classifyFailure,
  findSecretMaterial,
  validateEvidenceEntry,
  validateStageOutput,
} from "../src/worker/evidenceContract.js";
import { PRODUCTION_STAGES } from "../src/fleet/fleetPolicy.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "stph-stage-"));
  mkdirSync(path.join(root, "inputs"), { recursive: true });
  return root;
}

const SOURCE = [
  "# Research brief: on-device speech recognition",
  "",
  "On-device speech recognition removes the network round trip from voice interfaces and keeps audio on the handset.",
  "Recent small models run in a few hundred megabytes and stream partial results in well under a second.",
  "Battery cost dominates the design trade-off, not raw accuracy.",
  "Teams report that quantised models lose under two percent word accuracy on short utterances.",
  "Latency budgets of 300 milliseconds are achievable on mid-range phones when the vocabulary is bounded.",
  "",
  "- Small models now fit in mobile memory budgets.",
  "- Quantisation preserves accuracy for short commands.",
  "- Privacy is a product feature, not only a compliance claim.",
  "- Battery cost constrains always-on listening.",
  "- Streaming partials change interaction design.",
  "",
].join("\n");

const SCRIPT = [
  "SCENE 1 — INT. STUDIO — DAY",
  "The host opens with the measured latency chart on screen and explains what on-device recognition changes for the viewer.",
  "The camera holds on the chart while the narration states the baseline numbers recorded in the research brief.",
  "SCENE 2 — INT. WORKSHOP — NIGHT",
  "An engineer demonstrates a quantised model running on a mid-range handset with the network disabled.",
  "The host asks what the battery cost is and the engineer answers with the measured figure rather than a guess.",
  "SCENE 3 — EXT. ROOFTOP — DUSK",
  "Closing narration restates the three findings and points to the written brief for the full measurements.",
  "The episode ends on the device screen showing a completed transcription with no network connection active.",
].join("\n");

test("the registry declares a handler for every production stage and refuses unknown stages", () => {
  const registry = createStageHandlerRegistry({ artifactsRoot: makeRoot(), ffprobeAvailable: false });
  const declarations = registry.list();
  assert.equal(declarations.length, PRODUCTION_STAGES.length);
  assert.deepEqual(
    declarations.map((entry) => entry.stage).sort(),
    [...PRODUCTION_STAGES].sort()
  );
  assert.throws(() => registry.describe("NOT_A_STAGE"), (error) => error.code === STAGE_ERROR.UNSUPPORTED_STAGE);
  assert.throws(() => registry.describe("not_a_stage"), (error) => error.code === STAGE_ERROR.UNSUPPORTED_STAGE);
});

test("provider-backed stages are declared unavailable instead of silently succeeding", () => {
  const registry = createStageHandlerRegistry({ artifactsRoot: makeRoot(), ffprobeAvailable: false });
  for (const stage of ["VISUALS", "ANIMATION", "VOICE", "MUSIC", "ASSEMBLY", "PUBLISHING", "ANALYTICS"]) {
    const declaration = registry.describe(stage);
    assert.equal(declaration.available, false, `${stage} must be unavailable`);
    assert.equal(declaration.providerRequired, true);
    assert.equal(declaration.unavailableCode, STAGE_ERROR.PROVIDER_NOT_CONFIGURED);
    assert.throws(() => registry.execute({ stage, task: { input: {} } }), (error) => error.code === STAGE_ERROR.PROVIDER_NOT_CONFIGURED);
  }
  const ownerStage = registry.describe("OWNER_APPROVAL");
  assert.equal(ownerStage.available, false);
  assert.equal(ownerStage.unavailableCode, STAGE_ERROR.OWNER_APPROVAL_REQUIRED);
  // FFPROBE is real but only when the binary exists.
  assert.equal(registry.describe("FFPROBE").available, false);
  assert.throws(() => registry.execute({ stage: "FFPROBE", task: { input: {} } }));
});

test("capability validation refuses a stage without its required capability", () => {
  const ok = StageHandlerRegistry.validateCapabilities({
    stageTypes: ["RESEARCH"],
    capabilities: ["document.structure"],
  });
  assert.equal(ok.ok, true);
  const missing = StageHandlerRegistry.validateCapabilities({ stageTypes: ["RESEARCH"], capabilities: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join(" "), /missing capability document\.structure/);
  const unknown = StageHandlerRegistry.validateCapabilities({ stageTypes: ["TELEPORT"], capabilities: [] });
  assert.match(unknown.problems.join(" "), /unknown stage type TELEPORT/);
});

test("RESEARCH structures a real persisted document and hashes its actual bytes", () => {
  const root = makeRoot();
  writeFileSync(path.join(root, "inputs", "source.md"), SOURCE);
  const registry = createStageHandlerRegistry({ artifactsRoot: root, ffprobeAvailable: false, environment: "TEST" });
  const result = registry.execute({
    stage: "RESEARCH",
    task: { input: { sourceRef: "inputs/source.md" } },
    environment: "TEST",
    testFixture: true,
  });
  assert.match(result.resultRef, /^director-stage:\/\/research\//);
  assert.equal(result.evidence.length, 1);
  const evidence = result.evidence[0];
  assert.equal(evidence.evidenceType, "research_brief");
  assert.equal(evidence.artifactHash, sha(Buffer.from(SOURCE, "utf8")));
  assert.equal(evidence.payload.metadataOnly, true);
  assert.deepEqual(evidence.payload.mediaFiles, []);
  assert.equal(evidence.payload.providerUsed, false);
  assert.equal(evidence.payload.findingCount, 5);
  assert.equal(evidence.handlerName, "research-brief-structurer");
  assert.equal(evidence.testFixture, true);
  assert.equal(evidence.environment, "TEST");
  assert.equal(validateStageOutput({ resultRef: result.resultRef, evidence: result.evidence }).ok, true);
});

test("RESEARCH refuses a source that is too thin to be a brief", () => {
  const root = makeRoot();
  writeFileSync(path.join(root, "inputs", "thin.md"), "Too short.");
  const registry = createStageHandlerRegistry({ artifactsRoot: root, ffprobeAvailable: false });
  assert.throws(
    () => registry.execute({ stage: "RESEARCH", task: { input: { sourceRef: "inputs/thin.md" } } }),
    (error) => error instanceof StageError && error.code === STAGE_ERROR.STAGE_INPUT_INVALID
  );
});

test("artifact references cannot escape the worker artifact root", () => {
  const root = makeRoot();
  writeFileSync(path.join(root, "..", "outside.txt"), SOURCE);
  const registry = createStageHandlerRegistry({ artifactsRoot: root, ffprobeAvailable: false });
  assert.throws(
    () => registry.execute({ stage: "RESEARCH", task: { input: { sourceRef: "../outside.txt" } } }),
    (error) => error.code === STAGE_ERROR.STAGE_INPUT_INVALID
  );
});

test("SCRIPT validates structure and reports measured metadata only", () => {
  const root = makeRoot();
  writeFileSync(path.join(root, "inputs", "script.txt"), SCRIPT);
  const registry = createStageHandlerRegistry({ artifactsRoot: root, ffprobeAvailable: false });
  const result = registry.execute({ stage: "SCRIPT", task: { input: { scriptRef: "inputs/script.txt" } } });
  const evidence = result.evidence[0];
  assert.equal(evidence.evidenceType, "script");
  assert.equal(evidence.artifactHash, sha(Buffer.from(SCRIPT, "utf8")));
  assert.equal(evidence.payload.metadataOnly, true);
  assert.equal(evidence.payload.generated, false);
  assert.equal(evidence.payload.providerUsed, false);
  assert.equal(evidence.payload.sceneCount, 3);
  assert.ok(evidence.payload.wordCount > 100);

  assert.throws(
    () => registry.execute({ stage: "SCRIPT", task: { input: { scriptText: "Just a paragraph with no scenes and far too few words." } } }),
    (error) => error.code === STAGE_ERROR.STAGE_INPUT_INVALID
  );
});

test("CHARACTERS validates metadata and never claims a design exists", () => {
  const registry = createStageHandlerRegistry({ artifactsRoot: makeRoot(), ffprobeAvailable: false });
  const result = registry.execute({
    stage: "CHARACTERS",
    task: {
      input: {
        characters: [
          { name: "Host", role: "presenter", continuityKey: "host-primary" },
          { name: "Engineer", role: "expert", continuityKey: "engineer-primary" },
        ],
      },
    },
  });
  const evidence = result.evidence[0];
  assert.equal(evidence.evidenceType, "character_sheet");
  assert.equal(evidence.payload.containsDesign, false);
  assert.equal(evidence.payload.metadataOnly, true);
  assert.equal(evidence.payload.characterCount, 2);
  assert.equal(evidence.artifactHash, sha(Buffer.from(canonicalJson(result.payload.characters), "utf8")));

  assert.throws(
    () =>
      registry.execute({
        stage: "CHARACTERS",
        task: {
          input: {
            characters: [
              { name: "Host", role: "presenter", continuityKey: "host-primary" },
              { name: "Host", role: "expert", continuityKey: "host-secondary" },
            ],
          },
        },
      }),
    (error) => error.code === STAGE_ERROR.STAGE_INPUT_INVALID
  );
});

test("PACKAGE validates a manifest and hashes canonical bytes deterministically", () => {
  const registry = createStageHandlerRegistry({ artifactsRoot: makeRoot(), ffprobeAvailable: false });
  const manifest = {
    projectId: "11111111-1111-4111-8111-111111111111",
    stages: [{ stage: "RESEARCH", artifactHash: "a".repeat(64) }],
    mediaFiles: [],
  };
  const first = registry.execute({ stage: "PACKAGE", task: { input: { manifest } } });
  const second = registry.execute({ stage: "PACKAGE", task: { input: { manifest } } });
  assert.equal(first.evidence[0].artifactHash, second.evidence[0].artifactHash);
  assert.equal(first.evidence[0].artifactHash, sha(Buffer.from(canonicalJson(manifest), "utf8")));
  assert.equal(first.evidence[0].payload.metadataOnly, true);
  assert.throws(
    () => registry.execute({ stage: "PACKAGE", task: { input: { manifest: { projectId: "", stages: [] } } } }),
    (error) => error.code === STAGE_ERROR.STAGE_INPUT_INVALID
  );
});

test("QC executes rules over measured ffprobe evidence and refuses missing evidence", () => {
  const registry = createStageHandlerRegistry({ artifactsRoot: makeRoot(), ffprobeAvailable: false });
  const upstreamEvidence = [
    {
      stage: "FFPROBE",
      evidenceType: "ffprobe_report",
      artifactHash: "c".repeat(64),
      taskId: "22222222-2222-4222-8222-222222222222",
      payload: { durationSeconds: 12.5, videoStreams: 1, audioStreams: 1 },
    },
  ];
  const result = registry.execute({ stage: "QC", task: { input: {} }, upstreamEvidence });
  assert.equal(result.evidence[0].evidenceType, "qc_report");
  assert.equal(result.evidence[0].artifactHash, "c".repeat(64));
  assert.equal(result.evidence[0].payload.passed, true);
  assert.throws(
    () => registry.execute({ stage: "QC", task: { input: {} }, upstreamEvidence: [] }),
    (error) => error.code === STAGE_ERROR.REQUIRED_EVIDENCE_MISSING
  );
  assert.throws(
    () =>
      registry.execute({
        stage: "QC",
        task: { input: {} },
        upstreamEvidence: [{ ...upstreamEvidence[0], payload: { durationSeconds: 0, videoStreams: 0, audioStreams: 0 } }],
      }),
    (error) => error.code === STAGE_ERROR.STAGE_OUTPUT_INVALID
  );
});

test("secret-shaped input is refused before any handler runs", () => {
  const registry = createStageHandlerRegistry({ artifactsRoot: makeRoot(), ffprobeAvailable: false });
  assert.throws(
    () =>
      registry.execute({
        stage: "RESEARCH",
        task: { input: { sourceText: SOURCE, apiKey: "sk-live-abcdefghijklmnop" } },
      }),
    (error) => error.code === STAGE_ERROR.SECRET_MATERIAL_REJECTED
  );
  assert.equal(findSecretMaterial({ nested: { authorization: "Bearer abcdefghijkl" } }), "$.nested.authorization");
  assert.equal(findSecretMaterial({ providerRef: "vault://stph/jarvis/primary" }), null);
  assert.throws(
    () => assertNoSecretMaterial({ note: "token=supersecretvalue" }),
    (error) => error.code === STAGE_ERROR.SECRET_MATERIAL_REJECTED
  );
});

test("the evidence contract refuses a fixture that claims production verification", () => {
  const base = {
    evidenceType: "script",
    handlerName: "script-structure-validator",
    handlerVersion: "1.0.0",
    artifactHash: "d".repeat(64),
    payload: { outputKind: "script_structure_report" },
  };
  assert.equal(validateEvidenceEntry(base).ok, true);
  assert.equal(validateEvidenceEntry({ ...base, verificationLevel: "NOT_A_LEVEL" }).ok, false);
  const fixtureClaim = validateEvidenceEntry({
    ...base,
    testFixture: true,
    verificationLevel: VERIFICATION_LEVEL.PRODUCTION_VERIFIED,
  });
  assert.equal(fixtureClaim.ok, false);
  assert.match(fixtureClaim.errors.join(" "), /test-fixture evidence cannot claim/);
  assert.equal(validateEvidenceEntry({ ...base, handlerName: null }).ok, false);
  assert.equal(validateEvidenceEntry({ ...base, payload: { note: "token=abcdefghijkl" } }).ok, false);
  assert.equal(validateStageOutput({ resultRef: "x", evidence: [base], requiredHash: true }).ok, true);
  assert.equal(validateStageOutput({ resultRef: "", evidence: [base] }).ok, false);
  assert.equal(validateStageOutput({ resultRef: "x", evidence: [] }).ok, false);
  assert.equal(EVIDENCE_ERROR.EVIDENCE_FIXTURE_ASSERTION, "TASK_EVIDENCE_FIXTURE_ASSERTION");
});

test("failure classification distinguishes transient, permanent and provider conditions", () => {
  assert.deepEqual(classifyFailure("ECONNRESET"), {
    failureClass: "TRANSIENT",
    retryable: true,
    consumeAttempt: true,
    providerState: null,
  });
  assert.equal(classifyFailure("STAGE_INPUT_INVALID").failureClass, "PERMANENT");
  assert.equal(classifyFailure("STAGE_INPUT_INVALID").retryable, false);
  const quota = classifyFailure(STAGE_ERROR.PROVIDER_QUOTA_EXHAUSTED);
  assert.equal(quota.failureClass, "PROVIDER");
  assert.equal(quota.consumeAttempt, false);
  assert.equal(quota.providerState, "QUOTA_EXHAUSTED");
  assert.equal(classifyFailure(STAGE_ERROR.PROVIDER_NOT_CONFIGURED).providerState, "UNAVAILABLE");
});
