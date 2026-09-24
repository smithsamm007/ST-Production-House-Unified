/**
 * Hermes → durable job pipeline bridge tests (Issue #168).
 *
 * Honest-evidence scope (Rule 1): these tests prove that a `production.start`
 * decision queues a REAL episode release + `episode_production` job through
 * the same transactional path as the owner API, on the demo adapter (same
 * SQL subset as PostgreSQL), and that the pipeline can complete it. No live
 * providers, no publishing, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HermesManager, InMemoryHermesDecisionStore } from "../src/manager/hermesManager.js";
import { createHermesJobBridge, validateProductionStartPayload } from "../src/manager/hermesJobBridge.js";
import { ProductionRepository } from "../src/catalog/productionRepository.js";
import { runEpisodePipeline } from "../src/pipeline/episodePipeline.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const FUTURE = new Date(Date.now() + 60_000).toISOString();

async function buildHarness() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const production = new ProductionRepository(db);

  await db.query(
    "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)",
    ["agent-01", "JARVIS", "st.agent.jarvis", true]
  );
  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `owner-${ownerId.slice(0, 8)}@bridge.test`, "x".repeat(64), "owner", "authenticated"]
  );
  const channelId = randomUUID();
  await db.query(
    `INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [channelId, ownerId, "bridge-test", "Bridge Test Channel", "tag", "Hindi", "agent-01"]
  );

  const evidenceRows = [];
  const evidence = {
    append: async (event) => {
      const record = { id: randomUUID(), ...event };
      evidenceRows.push(record);
      return record;
    },
  };

  const store = new InMemoryHermesDecisionStore();
  let counter = 0;
  const manager = new HermesManager(store, {
    nextDecisionNumber: async () => {
      counter += 1;
      return counter;
    },
  });

  const bridge = createHermesJobBridge({ production, evidence });

  return { db, production, ownerId, channelId, evidence, evidenceRows, manager, bridge, store };
}

async function queueStartDecision(manager, { directorId = "agent-01", channelId, season = 1, episode = 1, title = "Nightfall Ward 7" }) {
  return manager.decide({
    action: "production.start",
    directorId,
    category: "production",
    reason: "Scheduled daily production slot available.",
    payload: { channelId, title, season, episode },
  }, { now: NOW });
}

test("payload validator accepts the owner-API bounds and rejects hostile shapes", () => {
  const ok = validateProductionStartPayload({ channelId: "ch-1", title: " Nightfall Ward 7 ", season: 1, episode: 2 });
  assert.deepEqual(ok, { channelId: "ch-1", title: "Nightfall Ward 7", season: 1, episode: 2 });
  assert.throws(() => validateProductionStartPayload(null), /PRODUCTION_PAYLOAD_INVALID/);
  assert.throws(() => validateProductionStartPayload({ channelId: "c", title: "t", season: 1, episode: 1, extra: true }), /PRODUCTION_PAYLOAD_INVALID/);
  assert.throws(() => validateProductionStartPayload({ channelId: "c", title: "", season: 1, episode: 1 }), /PRODUCTION_VALIDATION_FAILED/);
  assert.throws(() => validateProductionStartPayload({ channelId: "c", title: "t", season: 0, episode: 1 }), /PRODUCTION_VALIDATION_FAILED/);
  assert.throws(() => validateProductionStartPayload({ channelId: "c", title: "t", season: 101, episode: 1 }), /PRODUCTION_VALIDATION_FAILED/);
  assert.throws(() => validateProductionStartPayload({ channelId: "c", title: "t", season: 1, episode: 2001 }), /PRODUCTION_VALIDATION_FAILED/);
  assert.throws(() => validateProductionStartPayload({ channelId: "c", title: "t", season: 1.5, episode: 1 }), /PRODUCTION_VALIDATION_FAILED/);
});

test("a production.start decision queues a REAL episode_production job", async () => {
  const { manager, bridge, ownerId, channelId, db } = await buildHarness();
  await queueStartDecision(manager, { channelId, season: 1, episode: 1 });

  const result = await bridge(manager, ownerId, 1);
  assert.equal(result.status, "QUEUED");
  assert.ok(result.release.id, "release row exists");
  assert.ok(result.jobId, "job row exists");
  assert.ok(result.receiptId, "evidence receipt exists");

  const jobRows = await db.query(
    "SELECT id, agent_id, capability, status, owner_id, payload FROM jobs WHERE id = $1",
    [result.jobId]
  );
  const job = jobRows.rows[0];
  assert.ok(job, "job row is in the durable jobs table");
  assert.equal(job.capability, "episode_production");
  assert.equal(job.status, "queued", "job is QUEUED for the durable worker");
  assert.equal(job.agent_id, "agent-01");
  assert.equal(job.owner_id, ownerId);
  const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
  assert.equal(payload.releaseId, result.release.id);
});

test("the release row exists and the evidence ledger holds the receipt", async () => {
  const { manager, bridge, ownerId, channelId, production, evidenceRows } = await buildHarness();
  await queueStartDecision(manager, { channelId, season: 1, episode: 2 });
  const result = await bridge(manager, ownerId, 1);

  const release = await production.getRelease(ownerId, result.release.id);
  assert.ok(release, "release row is in the production_releases table");
  assert.equal(release.status, "planned");

  assert.equal(evidenceRows.length, 1);
  assert.equal(evidenceRows[0].kind, "production_queued");
  assert.equal(evidenceRows[0].subjectId, result.release.id);
  assert.equal(evidenceRows[0].payload.decisionNumber, 1);
});

test("queueing is idempotent per (channel, season, episode): re-execution fails honestly", async () => {
  const { manager, bridge, ownerId, channelId } = await buildHarness();
  await queueStartDecision(manager, { channelId, season: 1, episode: 3 });
  const first = await bridge(manager, ownerId, 1);
  assert.equal(first.status, "QUEUED");

  // A second decision for the SAME slot conflicts (Rule 8: one release per
  // slot; a failed attempt never duplicates the logical release).
  await queueStartDecision(manager, { channelId, season: 1, episode: 3 });
  const second = await bridge(manager, ownerId, 2);
  assert.equal(second.status, "FAILED");
  assert.equal(second.errorCode, "PRODUCTION_ALREADY_EXISTS");
  assert.equal(second.decision.outcome, "FAILED");
  assert.equal(second.decision.reasonCode, "EXECUTION_FAILED");
});

test("decision for another director's channel is refused (tenant isolation)", async () => {
  const { manager, bridge, ownerId, channelId } = await buildHarness();
  await queueStartDecision(manager, { directorId: "agent-02", channelId, season: 1, episode: 4 });
  const result = await bridge(manager, ownerId, 1);
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "DIRECTOR_CHANNEL_MISMATCH");
  assert.equal(result.decision.outcome, "FAILED");
});

test("unknown channel and disabled agent fail honestly", async () => {
  const { manager, bridge, ownerId, channelId, db } = await buildHarness();

  await queueStartDecision(manager, { channelId: randomUUID(), season: 1, episode: 5 });
  const missing = await bridge(manager, ownerId, 1);
  assert.equal(missing.status, "FAILED");
  assert.equal(missing.errorCode, "CHANNEL_NOT_FOUND");

  await db.query("UPDATE agents SET enabled = $1 WHERE id = $2", [false, "agent-01"]);
  await queueStartDecision(manager, { channelId, season: 1, episode: 6 });
  const disabled = await bridge(manager, ownerId, 2);
  assert.equal(disabled.status, "FAILED");
  assert.equal(disabled.errorCode, "AGENT_DISABLED");
});

test("non-production.start actions and non-EXECUTING decisions are refused", async () => {
  const { manager, bridge, ownerId, channelId } = await buildHarness();

  await manager.decide({
    action: "publishing.publish_publicly",
    directorId: "agent-01",
    category: "publishing",
    reason: "Attempt to publish via the execution bridge.",
    ownerApproval: { ownerId, expiresAt: FUTURE },
  }, { now: NOW });
  const refused = await bridge(manager, ownerId, 1);
  assert.equal(refused.status, "FAILED");
  assert.equal(refused.errorCode, "EXECUTION_ACTION_NOT_EXECUTABLE");

  await manager.decide({
    action: "secrets.read_values",
    directorId: "agent-01",
    category: "security_refusal",
    reason: "Prohibited.",
  }, { now: NOW });
  const blocked = await bridge(manager, ownerId, 2);
  assert.equal(blocked.status, "REFUSED", "a BLOCKED refusal stays BLOCKED — never rewritten");
  assert.equal(blocked.errorCode, "DECISION_NOT_EXECUTING");
  assert.equal(blocked.decision.outcome, "BLOCKED");
});

test("malformed decision payload fails closed with a stable code", async () => {
  const { manager, bridge, ownerId } = await buildHarness();
  await manager.decide({
    action: "production.start",
    directorId: "agent-01",
    category: "production",
    reason: "Bad payload.",
    payload: { channelId: "c", title: "t" }, // missing season/episode
  }, { now: NOW });
  const result = await bridge(manager, ownerId, 1);
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "PRODUCTION_VALIDATION_FAILED");
});

test("unknown decision number throws DECISION_NOT_FOUND (no fabrication)", async () => {
  const { manager, bridge, ownerId } = await buildHarness();
  await assert.rejects(() => bridge(manager, ownerId, 999), /DECISION_NOT_FOUND/);
});

test("END-TO-END: decision → queued job → durable pipeline → release in review with 4 artifacts", async () => {
  const { manager, bridge, ownerId, channelId, production, evidenceRows, db } = await buildHarness();

  // 1. Hermes decides to start production.
  await queueStartDecision(manager, { channelId, season: 1, episode: 7, title: "Whispers in the Ward" });

  // 2. The bridge executes the decision through the real queueing path.
  const result = await bridge(manager, ownerId, 1);
  assert.equal(result.status, "QUEUED");

  // 3. The job is queued in the durable jobs table.
  const jobBefore = await db.query("SELECT status FROM jobs WHERE id = $1", [result.jobId]);
  assert.equal(jobBefore.rows[0].status, "queued");

  // 4. The durable pipeline runs the release to completion (same legal
  //    transitions as the owner-triggered run route).
  const pipelineResult = await runEpisodePipeline({
    ownerId,
    releaseId: result.release.id,
    production,
    jobs: { updateStatus: async () => {} },
    evidenceLedger: { append: async (event) => ({ id: randomUUID(), ...event }) },
  });
  assert.equal(pipelineResult.status, "review");
  assert.equal(pipelineResult.artifacts.length, 4, "story → visual → audio → assembly");

  // 5. The decision completes EXECUTED — verified against the evidence
  //    ledger receipt the queueing attempt produced (Rule 1).
  const receipt = evidenceRows.find((row) => row.subjectId === result.release.id);
  const completed = await manager.completeDecision(1, {
    succeeded: true,
    evidenceReceiptId: receipt.id,
    fetchEvidence: async (id) => ({ found: evidenceRows.some((row) => row.id === id) }),
  });
  assert.equal(completed.outcome, "EXECUTED");
  assert.equal(completed.reasonCode, "EVIDENCE_VERIFIED");

  // 6. The audit trail shows the full honest lifecycle.
  const history = await manager.listDecisions({ limit: 10 });
  assert.equal(history[0].outcome, "EXECUTED");
  assert.equal(history[1].outcome, "EXECUTING");
});
