import test from "node:test";
import assert from "node:assert/strict";
import { ProductionRepository } from "../src/catalog/productionRepository.js";
import {
  renderStageContent,
  runEpisodePipeline,
  evaluatePublishGate,
  PIPELINE_STAGES,
} from "../src/pipeline/episodePipeline.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";
import { createHash, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Deterministic stage renderer
// ---------------------------------------------------------------------------

test("renderStageContent is deterministic (idempotent resume)", () => {
  const input = { channelId: "ch-1", title: "Nightfall Ward 7", season: 1, episode: 3 };
  for (const stage of PIPELINE_STAGES) {
    const a = renderStageContent(stage, input);
    const b = renderStageContent(stage, input);
    assert.equal(a, b, `${stage} must be a pure function of its inputs`);
    assert.ok(a.length > 0);
  }
});

test("renderStageContent rejects unknown stages (fail closed)", () => {
  assert.throws(() => renderStageContent("hologram", { channelId: "c", title: "t", season: 1, episode: 1 }), /UNKNOWN_PIPELINE_STAGE/);
});

// ---------------------------------------------------------------------------
// Publish gate (Rule 7)
// ---------------------------------------------------------------------------

test("evaluatePublishGate blocks without destination or attribution", () => {
  const release = { status: "review" };
  assert.equal(evaluatePublishGate({ release, destination: null }).ok, false);
  assert.equal(
    evaluatePublishGate({ release, destination: { publicAttribution: "" } }).code,
    "PUBLIC_PUBLISHING_IDENTITY_REQUIRED"
  );
  assert.equal(evaluatePublishGate({ release: { status: "planned" }, destination: { publicAttribution: "ST Anime" } }).code, "RELEASE_NOT_READY_FOR_PUBLISH");
  assert.equal(evaluatePublishGate({ release: null, destination: null }).code, "RELEASE_NOT_FOUND");
  assert.deepEqual(evaluatePublishGate({ release, destination: { publicAttribution: "ST Anime Official" } }), { ok: true });
});

// ---------------------------------------------------------------------------
// Pipeline against the demo adapter (same SQL subset as PostgreSQL)
// ---------------------------------------------------------------------------

async function buildHarness() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const production = new ProductionRepository(db);

  // Seed one agent + owner + channel directly through the adapter.
  await db.query(
    "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)",
    ["agent-01", "JARVIS", "st.agent.jarvis", true]
  );
  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, "owner@pipeline.test", "x".repeat(64), "owner", "authenticated"]
  );
  const channelId = randomUUID();
  await db.query(
    `INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [channelId, ownerId, "pipeline-test", "Pipeline Test Channel", "tag", "Hindi", "agent-01"]
  );

  const evidence = [];
  const evidenceLedger = { append: async (event) => { evidence.push(event); return { ok: true }; } };
  return { db, production, ownerId, channelId, evidence, evidenceLedger };
}

test("runEpisodePipeline produces verifiable artifacts for every stage", async () => {
  const { production, ownerId, channelId } = await buildHarness();

  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId,
    agentId: "agent-01",
    title: "Nightfall Ward 7",
    season: 1,
    episode: 1,
  });

  const result = await runEpisodePipeline({
    ownerId,
    releaseId: release.id,
    production,
    jobs: { updateStatus: async () => {} },
    evidenceLedger: { append: async () => ({ ok: true }) },
  });

  assert.equal(result.status, "review");
  assert.equal(result.artifacts.length, PIPELINE_STAGES.length);

  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  assert.equal(artifacts.length, PIPELINE_STAGES.length);
  for (const artifact of artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/, "artifact hash must be a real sha256");
    assert.equal(artifact.ffprobeVerified, false, "no media was rendered — verification stays false");
    assert.equal(artifact.generationMode, "deterministic_local");
  }

  // Release must now be in review status (owner gate before publish).
  const updated = await production.getRelease(ownerId, release.id);
  assert.equal(updated.status, "review");

  // Pipeline events: started+succeeded per stage.
  const events = await production.listPipelineEvents(ownerId, release.id);
  const succeeded = events.filter((e) => e.status === "succeeded");
  assert.ok(succeeded.length >= PIPELINE_STAGES.length);
});

test("duplicate release for same channel/season/episode fails closed with conflict", async () => {
  const { production, ownerId, channelId } = await buildHarness();

  await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Case 001", season: 1, episode: 1,
  });
  const second = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Case 001 duplicate", season: 1, episode: 1,
  });
  assert.equal(second.conflict, true, "second attempt must be rejected (Rule 8 semantics)");
});

test("identical deterministic re-run stores the same artifact once (content-addressed)", async () => {
  const { production, ownerId, channelId } = await buildHarness();

  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Idempotent Episode", season: 2, episode: 5,
  });
  const run1 = await runEpisodePipeline({
    ownerId, releaseId: release.id, production, jobs: { updateStatus: async () => {} },
  });
  const run2 = await runEpisodePipeline({
    ownerId, releaseId: release.id, production, jobs: { updateStatus: async () => {} },
  });

  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  assert.equal(artifacts.length, PIPELINE_STAGES.length, "re-run must not duplicate artifacts");
  const hashes1 = run1.artifacts.map((a) => a.sha256).sort();
  const hashes2 = run2.artifacts.map((a) => a.sha256).sort();
  assert.deepEqual(hashes2, hashes1, "deterministic content must produce identical hashes");
});

test("published release cannot be re-run", async () => {
  const { production, ownerId, channelId } = await buildHarness();
  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Locked", season: 1, episode: 9,
  });
  await production.updateReleaseStatus(ownerId, release.id, "published");
  await assert.rejects(
    () => runEpisodePipeline({ ownerId, releaseId: release.id, production, jobs: { updateStatus: async () => {} } }),
    /RELEASE_ALREADY_PUBLISHED/
  );
});

test("stage content hash matches recorded artifact sha256 (no fabricated evidence)", async () => {
  const { production, ownerId, channelId } = await buildHarness();
  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Hash Check", season: 1, episode: 2,
  });
  await runEpisodePipeline({ ownerId, releaseId: release.id, production, jobs: { updateStatus: async () => {} } });

  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  const story = artifacts.find((a) => a.stage === "story");
  const expected = createHash("sha256").update(renderStageContent("story", {
    channelId, title: "Hash Check", season: 1, episode: 2,
  })).digest("hex");
  assert.equal(story.sha256, expected, "recorded hash must be the real content hash");
});

test("owner scoping: another owner cannot see the release", async () => {
  const { production, ownerId, channelId } = await buildHarness();
  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Private", season: 1, episode: 4,
  });
  const otherOwner = randomUUID();
  assert.equal(await production.getRelease(otherOwner, release.id), null);
  assert.deepEqual(await production.listArtifactsForRelease(otherOwner, release.id), []);
  assert.deepEqual(await production.listPipelineEvents(otherOwner, release.id), []);
});
