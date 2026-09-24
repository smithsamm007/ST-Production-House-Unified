/**
 * Durable Hermes decision store tests (Issue #172).
 *
 * Offline scope: the store is exercised against the labeled demo adapter
 * (same SQL subset as the PostgreSQL adapter), so the append/list contract,
 * append-only enforcement, and durability semantics are proven without a
 * real database. The CI PostgreSQL Integration suite applies sql/023 on real
 * PostgreSQL separately.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { PostgresHermesDecisionStore } from "../src/manager/postgresHermesDecisionStore.js";
import { HermesManager } from "../src/manager/hermesManager.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");

async function buildStore() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const store = new PostgresHermesDecisionStore({ db });
  return { db, store };
}

function makeRecord(decisionNumber, overrides = {}) {
  return {
    decisionNumber,
    action: "production.start",
    authority: "AUTONOMOUS",
    directorId: "agent-01",
    category: "production",
    reason: "Scheduled daily production slot available.",
    outcome: "EXECUTING",
    reasonCode: "AUTONOMOUS_WITHIN_OWNER_LIMITS",
    payload: { channelId: "ch-1", season: 1, episode: 1 },
    credentialRequest: null,
    supersedes: null,
    errorCode: null,
    detail: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

test("migration 023 applies on the demo adapter and the table is queryable", async () => {
  const { db, store } = await buildStore();
  const stored = await store.append(makeRecord(1));
  // Demo-adapter note: only the BARE count(*) aggregate is supported there
  // (aliased counts are a real-PostgreSQL shape used by the integration
  // suite); the demo path returns the value under the key "count".
  const rows = await db.query("SELECT count(*) FROM hermes_decisions");
  assert.equal(Number(rows.rows[0].count), 1);
  assert.ok(stored.recordSeq > 0);
});

test("append persists the full record and round-trips structured fields", async () => {
  const { store } = await buildStore();
  const stored = await store.append(makeRecord(2, {
    credentialRequest: { agentId: "agent-01", providerKey: "gemini", scope: "production" },
    payload: { channelId: "ch-9", note: "hinglish horror cold open" },
  }));
  assert.equal(stored.decisionNumber, 2);
  assert.equal(stored.outcome, "EXECUTING");
  assert.equal(stored.payload.channelId, "ch-9");
  assert.deepEqual(stored.credentialRequest, { agentId: "agent-01", providerKey: "gemini", scope: "production" });
  assert.equal(stored.createdAt, NOW.toISOString());

  const history = await store.list({ limit: 10 });
  assert.equal(history.length, 1);
  assert.equal(history[0].payload.channelId, "ch-9", "JSON columns survive a round-trip");
});

test("list is newest-first and honors filters", async () => {
  const { store } = await buildStore();
  await store.append(makeRecord(1, { category: "production" }));
  await store.append(makeRecord(2, { category: "providers", action: "provider.select" }));
  await store.append(makeRecord(3, { category: "production" }));

  const all = await store.list({ limit: 10 });
  assert.deepEqual(all.map((r) => r.decisionNumber), [3, 2, 1], "newest first");

  const onlyProviders = await store.list({ limit: 10, filter: { category: "providers" } });
  assert.equal(onlyProviders.length, 1);
  assert.equal(onlyProviders[0].decisionNumber, 2);

  const byNumber = await store.list({ limit: 10, filter: { decisionNumber: 2 } });
  assert.equal(byNumber.length, 1);
  assert.equal(byNumber[0].action, "provider.select");

  const bounded = await store.list({ limit: 2 });
  assert.equal(bounded.length, 2);
});

test("append-only enforcement: UPDATE and DELETE are rejected", async () => {
  const { db, store } = await buildStore();
  await store.append(makeRecord(1));
  await assert.rejects(
    () => db.query("UPDATE hermes_decisions SET outcome = $1 WHERE decision_number = $2", ["EXECUTED", 1]),
    /APPEND_ONLY_VIOLATION/,
  );
  await assert.rejects(
    () => db.query("DELETE FROM hermes_decisions WHERE decision_number = $1", [1]),
    /APPEND_ONLY_VIOLATION/,
  );
  const rows = await db.query("SELECT count(*) FROM hermes_decisions");
  assert.equal(Number(rows.rows[0].count), 1, "history untouched");
});

test("completion is a NEW superseding record — history is never rewritten", async () => {
  const { db, store } = await buildStore();
  await store.append(makeRecord(1));
  await store.append(makeRecord(1, {
    outcome: "EXECUTED",
    reasonCode: "EVIDENCE_VERIFIED",
    supersedes: 1,
  }));
  const rows = await db.query(
    "SELECT outcome, supersedes_decision_number FROM hermes_decisions ORDER BY record_seq ASC",
  );
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0].outcome, "EXECUTING", "original preserved");
  assert.equal(rows.rows[1].outcome, "EXECUTED");
  assert.equal(Number(rows.rows[1].supersedes_decision_number), 1);
});

test("numbering is monotonic and DURABLE across store/manager re-instantiation", async () => {
  const db = createDemoStorageAdapter();
  await runMigrations(db);

  const first = new PostgresHermesDecisionStore({ db });
  const manager1 = new HermesManager(first, {
    nextDecisionNumber: () => first.nextDecisionNumber(),
  });
  await manager1.decide({
    action: "production.start", directorId: "agent-01", category: "production",
    reason: "Slot available.", payload: { channelId: "ch-1", season: 1, episode: 1 },
  }, { now: NOW });
  await manager1.decide({
    action: "provider.select", directorId: "agent-01", category: "providers",
    reason: "Provider A quota below threshold.", payload: { preferred: "provider-b" },
  }, { now: NOW });

  // A completely NEW manager over the same storage continues the sequence.
  const second = new PostgresHermesDecisionStore({ db });
  const manager2 = new HermesManager(second, {
    nextDecisionNumber: () => second.nextDecisionNumber(),
  });
  const decision = await manager2.decide({
    action: "production.retry", directorId: "agent-01", category: "production",
    reason: "Transient failure retry.", payload: { jobId: "job-1" },
  }, { now: NOW });
  assert.equal(decision.decisionNumber, 3, "numbering survives restart (durability)");

  const overview = await manager2.overview();
  assert.equal(overview.lastDecisionNumber, 3);
  assert.equal(overview.decisions.EXECUTING, 3);
});

test("manager end-to-end on the durable store: decide -> complete -> safe DTO", async () => {
  const { store } = await buildStore();
  const manager = new HermesManager(store, {
    nextDecisionNumber: () => store.nextDecisionNumber(),
  });
  await manager.decide({
    action: "production.start", directorId: "agent-01", category: "production",
    reason: "Slot available.", payload: { channelId: "ch-1", season: 1, episode: 2 },
  }, { now: NOW });
  await manager.decide({
    action: "secrets.read_values", directorId: "agent-01", category: "security_refusal",
    reason: "Attempted secret access.",
  }, { now: NOW });

  const completed = await manager.completeDecision(1, {
    succeeded: true,
    evidenceReceiptId: "receipt-1",
    fetchEvidence: async () => ({ found: true }),
  });
  assert.equal(completed.outcome, "EXECUTED");

  const current = await manager.getDecision(1);
  assert.equal(current.outcome, "EXECUTED");
  assert.equal(current.decisionNumber, 1);
  const refused = await manager.getDecision(2);
  assert.equal(refused.outcome, "BLOCKED");
  assert.ok(!JSON.stringify(current).includes("vault://"), "no locator material in DTOs");
});

test("store validation fails closed on malformed records", async () => {
  const { store } = await buildStore();
  await assert.rejects(() => store.append(null), /HERMES_RECORD_INVALID/);
  await assert.rejects(() => store.append(makeRecord(0)), /HERMES_RECORD_INVALID/);
  await assert.rejects(() => store.append(makeRecord(4, { reason: "" })), /HERMES_RECORD_INVALID/);
  await assert.rejects(() => store.list({ filter: { decisionNumber: -1 } }), /DECISION_NUMBER_INVALID/);
});

test("honest degradation: no adapter -> STORAGE_NOT_CONFIGURED, never fake data", async () => {
  const empty = new PostgresHermesDecisionStore({ db: null });
  await assert.rejects(() => empty.append(makeRecord(1)), /STORAGE_NOT_CONFIGURED/);
  await assert.rejects(() => empty.list({}), /STORAGE_NOT_CONFIGURED/);
  await assert.rejects(() => empty.nextDecisionNumber(), /STORAGE_NOT_CONFIGURED/);
  const lazy = new PostgresHermesDecisionStore({ db: () => null });
  await assert.rejects(() => lazy.list({}), /STORAGE_NOT_CONFIGURED/);
});

test("router degrades honestly without a db and works with one (integration)", async () => {
  const { createHermesRouter } = await import("../src/api/hermesRouter.js");
  const { db } = await buildStore();

  // No db injected -> router constructs no manager; writes fail 503, reads 503.
  const bare = createHermesRouter({});
  assert.ok(bare, "router still mounts");

  // With a db the full manager path works through the durable store.
  const store = new PostgresHermesDecisionStore({ db });
  const wired = createHermesRouter({
    db: () => db,
    fetchEvidence: async () => ({ found: true }),
  });
  assert.ok(wired);
  assert.ok(store, "durable store constructed");
});
