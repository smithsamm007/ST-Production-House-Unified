import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTOR_ARTIFACT_ERROR_CODES,
  evaluateExecutorArtifact,
  projectExecutorResult,
  recordExecutorArtifact,
} from "../src/pipeline/episodePipeline.js";
import { createArtifactDescriptor } from "../src/media/artifactDescriptor.js";

const RELEASE = { agentId: "agent-01" };

function makeDescriptor({ agentId = "agent-01", contentSha256 = "a".repeat(64), state = "UNVERIFIED" } = {}) {
  const descriptor = createArtifactDescriptor({
    artifactType: "audio",
    mimeType: "audio/mpeg",
    contentSha256,
    producer: { agentId, runId: "run-1", stageId: "tts", providerId: "edge-tts" },
    createdAt: "2026-09-25T10:00:00.000Z",
  });
  if (state === "UNVERIFIED") return descriptor;
  return { ...descriptor, verification: { ...descriptor.verification, state: "VERIFIED", inspectedBy: "ffprobe", inspectedAt: "2026-09-25T10:00:00.000Z", reasonCode: null } };
}

// ---------------------------------------------------------------------------
// projectExecutorResult: inbound allowlist (Rule 17)
// ---------------------------------------------------------------------------

test("projectExecutorResult reduces executor results to the allowlist", () => {
  const projected = projectExecutorResult({
    success: true,
    failureCode: null,
    quotaState: "OK",
    mediaStatus: "verified",
    generationMode: "provider_generated",
    descriptor: { contentSha256: "a".repeat(64) },
    outcome: { outcomeId: "x" },
    inspection: { success: true },
    outputPath: "/media/secret-path/narration.mp3",
    attempts: [{ providerId: "edge-tts" }],
    stderrTail: "internal error detail",
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    "descriptor", "failureCode", "generationMode", "inspection", "mediaStatus", "outcome", "quotaState", "success",
  ]);
  assert.equal(projected.outputPath, undefined, "unknown fields can never reach persistence");
});

test("projectExecutorResult rejects malformed input", () => {
  for (const hostile of [null, 42, "x", [], true]) {
    assert.throws(() => projectExecutorResult(hostile), /EXECUTOR_RESULT_MALFORMED/);
  }
});

// ---------------------------------------------------------------------------
// evaluateExecutorArtifact: fail-closed gates
// ---------------------------------------------------------------------------

test("verdict fails closed on missing result, bad release, unknown stage", () => {
  assert.throws(() => evaluateExecutorArtifact({ stage: "audio", release: RELEASE, executorResult: null }), /EXECUTOR_RESULT_MALFORMED/);
  assert.throws(() => evaluateExecutorArtifact({ stage: "audio", release: null, executorResult: {} }), /EXECUTOR_STAGE_MISMATCH/);
  assert.throws(() => evaluateExecutorArtifact({ stage: "hologram", release: RELEASE, executorResult: {} }), /UNKNOWN_PIPELINE_STAGE/);
});

test("hand-forged VERIFIED descriptor without a matching inspection is rejected", () => {
  const forged = makeDescriptor({ state: "VERIFIED" });
  assert.throws(
    () => evaluateExecutorArtifact({
      stage: "audio",
      release: RELEASE,
      executorResult: { success: true, descriptor: forged, inspection: null, outcome: null, quotaState: "OK", mediaStatus: "verified", generationMode: "provider_generated", failureCode: null },
    }),
    /EXECUTOR_DESCRIPTOR_INVALID/,
    "forgery gate: no inspection backing",
  );

  const mismatched = makeDescriptor({ state: "VERIFIED", contentSha256: "b".repeat(64) });
  assert.throws(
    () => evaluateExecutorArtifact({
      stage: "audio",
      release: RELEASE,
      executorResult: {
        success: true,
        descriptor: mismatched,
        inspection: { success: true, contentSha256: "a".repeat(64) },
        outcome: null,
        quotaState: "OK",
        mediaStatus: "verified",
        generationMode: "provider_generated",
        failureCode: null,
      },
    }),
    /EXECUTOR_DESCRIPTOR_INVALID/,
    "forgery gate: inspection of DIFFERENT bytes",
  );
});

test("cross-Director descriptor fails closed (per-Director isolation)", () => {
  const other = makeDescriptor({ agentId: "agent-02" });
  assert.throws(
    () => evaluateExecutorArtifact({
      stage: "audio",
      release: RELEASE,
      executorResult: { success: false, descriptor: other, inspection: null, outcome: null, quotaState: "OK", mediaStatus: "unverified", generationMode: "not_evidenced", failureCode: "PROVIDER_CALL_FAILED" },
    }),
    /EXECUTOR_AGENT_SCOPE_MISMATCH/,
  );
});

test("descriptor missing identity anchor fails closed", () => {
  const bad = makeDescriptor({});
  const corrupted = { ...bad, contentSha256: "nothex" };
  assert.throws(
    () => evaluateExecutorArtifact({
      stage: "audio",
      release: RELEASE,
      executorResult: { success: false, descriptor: corrupted, inspection: null, outcome: null, quotaState: "OK", mediaStatus: "unverified", generationMode: "not_evidenced", failureCode: "PROVIDER_CALL_FAILED" },
    }),
    /EXECUTOR_DESCRIPTOR_INVALID/,
  );
});

test("error codes are exported and closed", () => {
  assert.deepEqual([...EXECUTOR_ARTIFACT_ERROR_CODES].sort(), [
    "EXECUTOR_AGENT_SCOPE_MISMATCH",
    "EXECUTOR_DESCRIPTOR_INVALID",
    "EXECUTOR_INSPECTION_UNAVAILABLE",
    "EXECUTOR_OUTCOME_TAMPERED",
    "EXECUTOR_RESULT_MALFORMED",
    "EXECUTOR_STAGE_MISMATCH",
  ]);
});

// ---------------------------------------------------------------------------
// evaluateExecutorArtifact: truthful verdicts
// ---------------------------------------------------------------------------

test("honest success: verified descriptor + matching inspection → recorded verdict", () => {
  const contentSha256 = "c".repeat(64);
  const descriptor = makeDescriptor({ contentSha256, state: "VERIFIED" });
  const verdict = evaluateExecutorArtifact({
    stage: "audio",
    release: RELEASE,
    executorResult: {
      success: true,
      descriptor,
      inspection: { success: true, contentSha256 },
      outcome: { outcomeType: "tts_generation_outcome_v1", outcomeId: "whatever" },
      quotaState: "OK",
      mediaStatus: "verified",
      generationMode: "provider_generated",
      failureCode: null,
    },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.waiting, false);
  assert.equal(verdict.verified, true);
  assert.equal(verdict.sha256, contentSha256);
  assert.equal(verdict.kind, "audio");
  assert.equal(verdict.generationMode, "provider_generated");
  assert.equal(verdict.failureCode, null);
});

test("honest unverified: exit 0 without inspection → unverified verdict, never verified", () => {
  const descriptor = makeDescriptor({ state: "UNVERIFIED" });
  const verdict = evaluateExecutorArtifact({
    stage: "audio",
    release: RELEASE,
    executorResult: {
      success: false,
      descriptor,
      inspection: { success: false, contentSha256: null, reasonCode: "FFPROBE_EXIT_NONZERO" },
      outcome: null,
      quotaState: "OK",
      mediaStatus: "unverified",
      generationMode: "not_evidenced",
      failureCode: "INSPECTION_FAILED",
    },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.generationMode, "not_evidenced");
  assert.ok(verdict.failureCode, "the honest failure code is preserved");
});

test("honest WAITING_FOR_QUOTA: no media, truthful waiting verdict", () => {
  const verdict = evaluateExecutorArtifact({
    stage: "audio",
    release: RELEASE,
    executorResult: { success: false, descriptor: null, inspection: null, outcome: null, quotaState: "WAITING_FOR_QUOTA", mediaStatus: "unverified", generationMode: "not_evidenced", failureCode: "QUOTA_EXHAUSTED" },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.waiting, true);
  assert.equal(verdict.sha256, null, "no media hash is fabricated for waiting work");
  assert.equal(verdict.quotaState, "WAITING_FOR_QUOTA");
  assert.equal(verdict.failureCode, "QUOTA_EXHAUSTED");
});

test("descriptor without success or waiting state is malformed (fail closed)", () => {
  assert.throws(
    () => evaluateExecutorArtifact({
      stage: "audio",
      release: RELEASE,
      executorResult: { success: true, descriptor: null, inspection: null, outcome: null, quotaState: "OK", mediaStatus: "unverified", generationMode: "not_evidenced", failureCode: null },
    }),
    /EXECUTOR_RESULT_MALFORMED/,
  );
});

// ---------------------------------------------------------------------------
// recordExecutorArtifact: real persistence through ProductionRepository
// ---------------------------------------------------------------------------

test("recordExecutorArtifact persists real executor provenance; deterministic default unchanged", async () => {
  const { createDemoStorageAdapter } = await import("../src/db/demoStorageAdapter.js");
  const { runMigrations } = await import("../src/db/index.js");
  const { ProductionRepository } = await import("../src/catalog/productionRepository.js");
  const { randomUUID } = await import("node:crypto");

  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const production = new ProductionRepository(db);
  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, "owner@rec.test", "x".repeat(64), "owner", "authenticated"],
  );
  await db.query(
    "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)",
    ["agent-01", "JARVIS", "st.agent.jarvis", true],
  );
  const channelId = randomUUID();
  await db.query(
    `INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [channelId, ownerId, "rec-test", "Recording Test", "tag", "Hindi", "agent-01"],
  );
  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Recording", season: 1, episode: 1,
  });

  // 1. A REAL verified executor artifact records with provider_generated
  //    provenance and ffprobe_verified = true.
  const contentSha256 = "d".repeat(64);
  const verdict = evaluateExecutorArtifact({
    stage: "audio",
    release: { agentId: "agent-01" },
    executorResult: {
      success: true,
      descriptor: makeDescriptor({ contentSha256, state: "VERIFIED" }),
      inspection: { success: true, contentSha256 },
      outcome: null,
      quotaState: "OK",
      mediaStatus: "verified",
      generationMode: "provider_generated",
      failureCode: null,
    },
  });
  const stored = await recordExecutorArtifact({ releaseId: release.id, ownerId, production, stage: "audio", verdict });
  assert.ok(stored, "artifact must be recorded");
  assert.equal(stored.generationMode, "provider_generated");
  assert.equal(stored.ffprobeVerified, true);
  assert.match(stored.storageUri, /^local:\/\/provider_generated\//, "storage URI names the ACTUAL mode");
  assert.equal(stored.sha256, contentSha256);

  // 2. Deterministic stage recording (existing pipeline path) is unchanged.
  const deterministic = await production.recordArtifact({
    releaseId: release.id, ownerId, kind: "metadata", stage: "story",
    sha256: "e".repeat(64), sizeBytes: 42, mimeType: "application/json",
  });
  assert.equal(deterministic.generationMode, "deterministic_local");
  assert.equal(deterministic.ffprobeVerified, false);
  assert.match(deterministic.storageUri, /^local:\/\/deterministic_local\//);

  // 3. Idempotent by content: re-recording the same hash returns null.
  const again = await recordExecutorArtifact({ releaseId: release.id, ownerId, production, stage: "audio", verdict });
  assert.equal(again, null, "identical artifact stored once (idempotent resume)");
});
