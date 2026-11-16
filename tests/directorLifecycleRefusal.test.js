/**
 * D-4 regression — lifecycle refusals must be handled everywhere, not just at the guard.
 *
 * PR #280 introduced `CANONICAL_DIRECTOR_PENDING_ACTIVATION` for the six seeded
 * Directors that are waiting for Owner activation. The database guards rejected
 * their work correctly, but every application call site tested only
 * `CANONICAL_DIRECTOR_NOT_ACTIVE`, so a pending Director produced a 500 or a
 * thrown bridge error instead of an honest conflict.
 *
 * These tests pin the contract:
 *   - `lifecycleRefusalCode` recognizes BOTH refusals and nothing else;
 *   - the HTTP mapping gives both a 409 and preserves the original code;
 *   - the HERMES job bridge records a FAILED decision for a pending Director,
 *     with no job row and no release, and never leaves the decision EXECUTING;
 *   - an active Director still queues work, and an unrelated error still fails
 *     loudly instead of being reclassified as a lifecycle conflict.
 *
 * Real modules throughout: the canonical guard reads the migrated schema, and
 * the bridge runs the same transactional queue path the owner API uses. No
 * providers are called.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  LIFECYCLE_REFUSAL_CODES,
  lifecycleRefusalCode,
  isLifecycleRefusal,
} from "../src/catalog/directorLifecycle.js";
import { createCanonicalDirectorGuard, enforceOperationalActive } from "../src/catalog/canonicalDirectorLifecycle.js";
import { statusForCode } from "../src/catalog/canonicalDirectorServer.js";
import { createHermesJobBridge } from "../src/manager/hermesJobBridge.js";
import { HermesManager, InMemoryHermesDecisionStore } from "../src/manager/hermesManager.js";
import { ProductionRepository } from "../src/catalog/productionRepository.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");

// ---------------------------------------------------------------------------
// The shared refusal contract
// ---------------------------------------------------------------------------

test("the refusal contract covers both lifecycle codes and nothing else", () => {
  assert.deepEqual([...LIFECYCLE_REFUSAL_CODES], [
    "CANONICAL_DIRECTOR_NOT_ACTIVE",
    "CANONICAL_DIRECTOR_PENDING_ACTIVATION",
  ]);

  assert.equal(lifecycleRefusalCode({ code: "CANONICAL_DIRECTOR_PENDING_ACTIVATION" }),
    "CANONICAL_DIRECTOR_PENDING_ACTIVATION");
  assert.equal(lifecycleRefusalCode({ code: "CANONICAL_DIRECTOR_NOT_ACTIVE" }),
    "CANONICAL_DIRECTOR_NOT_ACTIVE");
  // A bare code string is accepted too (callers sometimes hold the code only).
  assert.equal(lifecycleRefusalCode("CANONICAL_DIRECTOR_PENDING_ACTIVATION"),
    "CANONICAL_DIRECTOR_PENDING_ACTIVATION");

  // Unrelated failures must NOT be reclassified as lifecycle conflicts.
  for (const value of [
    undefined, null, {}, { code: "CANONICAL_DIRECTOR_NOT_FOUND" },
    { code: "PRODUCTION_QUEUE_FAILED" }, { code: "23503" }, new Error("boom"),
  ]) {
    assert.equal(lifecycleRefusalCode(value), null);
    assert.equal(isLifecycleRefusal(value), false);
  }
  assert.equal(isLifecycleRefusal({ code: "CANONICAL_DIRECTOR_PENDING_ACTIVATION" }), true);
});

test("both refusals map to a conflict, unrelated codes keep their mapping", () => {
  assert.equal(statusForCode("CANONICAL_DIRECTOR_PENDING_ACTIVATION"), 409);
  assert.equal(statusForCode("CANONICAL_DIRECTOR_NOT_ACTIVE"), 409);
  assert.equal(statusForCode("CANONICAL_DIRECTOR_NOT_FOUND"), 404);
  assert.equal(statusForCode("INSUFFICIENT_PRIVILEGES"), 403);
  assert.equal(statusForCode("SOMETHING_UNEXPECTED"), 500);
});

// ---------------------------------------------------------------------------
// Bridge harness: real guard over the migrated schema
// ---------------------------------------------------------------------------

async function buildHarness({ agentId, directorCode }) {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const production = new ProductionRepository(db);

  const agent = (await db.query("SELECT id FROM agents WHERE id = $1", [agentId])).rows[0];
  assert.ok(agent, `${agentId} must exist in the migrated registry`);

  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `owner-${ownerId.slice(0, 8)}@refusal.test`, "x".repeat(64), "owner", "authenticated"]
  );
  const channelId = randomUUID();
  await db.query(
    `INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [channelId, ownerId, `refusal-${channelId.slice(0, 8)}`, "Refusal Test", null, "Hindi", agentId]
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

  const guard = createCanonicalDirectorGuard(db);
  const bridge = createHermesJobBridge({ production, evidence, canonicalGuard: guard });

  const decision = await manager.decide({
    action: "production.start",
    directorId: agentId,
    category: "production",
    reason: "Scheduled slot for the refusal regression.",
    payload: { channelId, title: "Nightfall Ward 7", season: 1, episode: 1 },
  }, { now: NOW });

  return { db, manager, bridge, ownerId, channelId, evidenceRows, decision, directorCode };
}

const jobsFor = async (db, agentId) =>
  (await db.query("SELECT id FROM jobs WHERE agent_id = $1", [agentId])).rows.length;

const releasesFor = async (db, channelId) =>
  (await db.query("SELECT id FROM production_releases WHERE channel_id = $1", [channelId])).rows.length;

// ---------------------------------------------------------------------------
// Bridge behaviour per lifecycle state
// ---------------------------------------------------------------------------

test("a pending Director yields a recorded FAILED decision, no job and no release", async () => {
  // agent-director-cosmos is seeded by sql/034 as suspended + PENDING_OWNER_ACTIVATION.
  const h = await buildHarness({ agentId: "agent-director-cosmos", directorCode: "COSMOS" });

  const result = await h.bridge(h.manager, h.ownerId, h.decision.decisionNumber);

  assert.equal(result.status, "FAILED", "the bridge must report failure, never success");
  assert.equal(result.errorCode, "CANONICAL_DIRECTOR_PENDING_ACTIVATION",
    "the pending code must be preserved, not collapsed into NOT_ACTIVE");
  assert.equal(result.decision.outcome, "FAILED", "the decision reaches a terminal state");

  assert.equal(await jobsFor(h.db, "agent-director-cosmos"), 0, "no job row is inserted");
  assert.equal(await releasesFor(h.db, h.channelId), 0, "no release row is inserted");
  assert.equal(h.evidenceRows.length, 0, "no production_queued evidence is fabricated");

  // The decision is NOT stranded in EXECUTING.
  const stored = await h.manager.getDecision(h.decision.decisionNumber);
  assert.notEqual(stored.outcome, "EXECUTING");
  assert.equal(stored.errorCode, "CANONICAL_DIRECTOR_PENDING_ACTIVATION");
});

test("a retired mapping still fails closed with NOT_ACTIVE and queues nothing", async () => {
  const db = await (async () => {
    const adapter = createDemoStorageAdapter();
    await runMigrations(adapter);
    return adapter;
  })();
  // A retired canonical Director beyond the seeded set: proves the retired path
  // independently of the pending fixture.
  await db.query(
    "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)",
    ["agent-97", "REGRESSION_RETIRED", "st.agent.regression-retired", true]
  );
  await db.query(
    `INSERT INTO canonical_director_mappings
       (canonical_director_code, underlying_agent_id, display_name, namespace, status,
        retired_at, retired_reason, suspended_note)
     VALUES ($1, $2, $3, $4, 'retired', now(), $5, NULL)`,
    ["REGRESSION-RETIRED", "agent-97", "REGRESSION_RETIRED", "st.agent.regression-retired", "regression fixture"]
  );

  const production = new ProductionRepository(db);
  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `owner-${ownerId.slice(0, 8)}@retired.test`, "x".repeat(64), "owner", "authenticated"]
  );
  const channelId = randomUUID();
  await db.query(
    `INSERT INTO channels (id, owner_id, slug, display_name, agent_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [channelId, ownerId, `retired-${channelId.slice(0, 8)}`, "Retired Test", "agent-97"]
  );

  const store = new InMemoryHermesDecisionStore();
  let counter = 0;
  const manager = new HermesManager(store, { nextDecisionNumber: async () => (counter += 1) });
  const bridge = createHermesJobBridge({
    production,
    evidence: { append: async (event) => ({ id: randomUUID(), ...event }) },
    canonicalGuard: createCanonicalDirectorGuard(db),
  });
  const decision = await manager.decide({
    action: "production.start",
    directorId: "agent-97",
    category: "production",
    reason: "Retired Director regression.",
    payload: { channelId, title: "Nightfall Ward 8", season: 1, episode: 1 },
  }, { now: NOW });

  const result = await bridge(manager, ownerId, decision.decisionNumber);
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "CANONICAL_DIRECTOR_NOT_ACTIVE");
  assert.equal(await jobsFor(db, "agent-97"), 0);
  assert.equal((await manager.getDecision(decision.decisionNumber)).outcome, "FAILED");
});

test("an active Director still queues work (no behaviour change)", async () => {
  // agent-02 is seeded active (SHERLOCK) by sql/034.
  const h = await buildHarness({ agentId: "agent-02", directorCode: "SHERLOCK" });

  const result = await h.bridge(h.manager, h.ownerId, h.decision.decisionNumber);

  assert.equal(result.status, "QUEUED");
  assert.ok(result.jobId, "the job row exists");
  assert.equal(await jobsFor(h.db, "agent-02"), 1);
  assert.equal(h.evidenceRows.length, 1);
});

test("an unrelated guard failure is rethrown, never reclassified as a lifecycle refusal", async () => {
  const h = await buildHarness({ agentId: "agent-02", directorCode: "SHERLOCK" });
  const failing = createHermesJobBridge({
    production: new ProductionRepository(h.db),
    evidence: { append: async (event) => ({ id: randomUUID(), ...event }) },
    canonicalGuard: {
      assertActive: async () => {
        const error = new Error("CANONICAL_DIRECTOR_GUARD_NOT_CONFIGURED");
        error.code = "CANONICAL_DIRECTOR_GUARD_NOT_CONFIGURED";
        throw error;
      },
    },
  });

  await assert.rejects(
    () => failing(h.manager, h.ownerId, h.decision.decisionNumber),
    (err) => err.code === "CANONICAL_DIRECTOR_GUARD_NOT_CONFIGURED",
    "an infrastructure failure must surface, not masquerade as a lifecycle conflict"
  );
  assert.equal(await jobsFor(h.db, "agent-02"), 0, "nothing is queued when the guard is broken");
});

test("when recording the refusal itself fails, the bridge reports that honestly", async () => {
  const h = await buildHarness({ agentId: "agent-director-aadi", directorCode: "AADI" });
  const manager = {
    getDecision: async () => ({ ...h.decision, outcome: "EXECUTING" }),
    completeDecision: async () => {
      const error = new Error("DECISION_STORE_UNAVAILABLE");
      error.code = "DECISION_STORE_UNAVAILABLE";
      throw error;
    },
  };

  // The refusal is never converted into a success claim: persistence failing is
  // surfaced, and no job is created either way.
  await assert.rejects(
    () => h.bridge(manager, h.ownerId, h.decision.decisionNumber),
    (err) => err.code === "DECISION_STORE_UNAVAILABLE"
  );
  assert.equal(await jobsFor(h.db, "agent-director-aadi"), 0);
});

test("re-processing a refused decision does not queue work on a retry", async () => {
  const h = await buildHarness({ agentId: "agent-director-chronos", directorCode: "CHRONOS" });
  const first = await h.bridge(h.manager, h.ownerId, h.decision.decisionNumber);
  assert.equal(first.status, "FAILED");

  // A second execution attempt hits the terminal-state guard and is refused
  // without creating a job.
  const second = await h.bridge(h.manager, h.ownerId, h.decision.decisionNumber);
  assert.equal(second.status, "REFUSED");
  assert.equal(second.errorCode, "DECISION_NOT_EXECUTING");
  assert.equal(await jobsFor(h.db, "agent-director-chronos"), 0);
});

test("a storage outage is not reclassified as a lifecycle refusal", async () => {
  // The manual-run route maps only lifecycle refusals to 409; everything else
  // must keep failing as a server error. Proven here at the guard boundary.
  const outage = {
    async query() {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      error.code = "ECONNREFUSED";
      throw error;
    },
  };

  await assert.rejects(
    () => enforceOperationalActive(outage, "agent-01"),
    (err) => {
      assert.equal(err.code, "ECONNREFUSED");
      assert.equal(isLifecycleRefusal(err), false, "an outage is never a lifecycle conflict");
      return true;
    }
  );
});
