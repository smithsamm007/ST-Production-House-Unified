import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DirectorConnectionsRepository,
  runConnectionTest,
} from "../src/catalog/directorConnectionsRepository.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

// ---------------------------------------------------------------------------
// Harness (same demo-adapter contract as directorWorkspace.test.js)
// ---------------------------------------------------------------------------

async function buildHarness() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const repo = new DirectorConnectionsRepository(db);

  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `owner-${ownerId.slice(0, 8)}@workspace.test`, "x".repeat(64), "owner", "authenticated"]
  );
  for (const [id, name, ns] of [
    ["agent-01", "JARVIS", "st.agent.jarvis"],
    ["agent-02", "SHERLOCK", "st.agent.sherlock"],
  ]) {
    await db.query("INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)", [id, name, ns, true]);
  }
  return { db, repo, ownerId };
}

// ---------------------------------------------------------------------------
// Connection storage: opaque locators only, per-director isolation
// ---------------------------------------------------------------------------

test("connection stores locator-shaped secrets and never serializes them", async () => {
  const { repo, ownerId } = await buildHarness();

  const conn = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "gemini",
    kind: "llm",
    secretFields: { api_key: "vault://st/jarvis/gemini/key" },
    configFields: { model: "gemini-2.0", region: "us-central1" },
    credentialLabel: "Gemini key A",
  });

  assert.ok(conn.id, "connection row is returned");
  assert.equal(conn.status, "configured");
  assert.deepEqual(conn.secretFieldKeys, ["api_key"], "only field KEYS serialize");
  assert.equal(conn.configFields.model, "gemini-2.0");
  assert.equal(conn.catalog.displayName, "Google Gemini");
  assert.equal(conn.catalog.credentialUrl, "https://aistudio.google.com/app/apikey");
  assert.ok(!JSON.stringify(conn).includes("vault://"), "locator value must never serialize (Rule 17)");
});

test("plaintext secrets are structurally rejected before any write", async () => {
  const { repo, ownerId } = await buildHarness();

  await assert.rejects(
    () => repo.upsertConnection(ownerId, "agent-01", { providerKey: "openai", kind: "llm", secretFields: { api_key: "sk-plaintext-123" } }),
    /PLAINTEXT_SECRET_REJECTED/,
  );
  await assert.rejects(
    () => repo.upsertConnection(ownerId, "agent-01", { providerKey: "openai", kind: "llm", secretFields: { api_key: 42 } }),
    /SECRET_LOCATOR_REQUIRED/,
  );
  await assert.rejects(
    () => repo.upsertConnection(ownerId, "agent-01", { providerKey: "openai", kind: "llm", configFields: { base_url: "vault://smuggle" } }),
    /CONFIG_FIELD_LOCATOR_PROHIBITED/,
  );
  const hostileProtoMap = {};
  Object.defineProperty(hostileProtoMap, "__proto__", { value: "vault://x", enumerable: true, configurable: true, writable: true });
  await assert.rejects(
    () => repo.upsertConnection(ownerId, "agent-01", { providerKey: "openai", kind: "llm", secretFields: hostileProtoMap }),
    /CONNECTION_FIELD_KEY_INVALID/,
  );
  await assert.rejects(
    () => repo.upsertConnection(ownerId, "agent-01", { providerKey: "openai", kind: "llm" }),
    /CONNECTION_EMPTY/,
  );
});

test("upsert replaces the single connection per (owner, director, provider, kind)", async () => {
  const { repo, ownerId } = await buildHarness();

  const first = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "gemini", kind: "llm", secretFields: { api_key: "opaque://one" },
  });
  const second = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "gemini", kind: "llm", secretFields: { api_key: "opaque://two" }, configFields: { model: "m" },
  });
  assert.equal(second.id, first.id, "same logical connection (Rule 8: versions, not duplicates)");
  const list = await repo.listConnections(ownerId, "agent-01");
  assert.equal(list.length, 1);
});

test("connections are isolated per director and per owner", async () => {
  const { repo, ownerId } = await buildHarness();

  await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "gemini", kind: "llm", secretFields: { api_key: "vault://st/jarvis/gemini/key" },
  });
  assert.equal((await repo.listConnections(ownerId, "agent-02")).length, 0, "no cross-director leakage");
  assert.equal(await repo.getConnection(ownerId, "agent-02", "nonexistent"), null);
});

test("delete is scoped and honest", async () => {
  const { repo, ownerId } = await buildHarness();
  const conn = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "youtube", kind: "social", configFields: { channel_id: "UC123" },
  });
  assert.equal(await repo.deleteConnection(ownerId, "agent-02", conn.id), false, "cross-director delete is a no-op");
  assert.equal(await repo.deleteConnection(ownerId, "agent-01", conn.id), true);
  assert.equal(await repo.getConnection(ownerId, "agent-01", conn.id), null);
});

test("unknown providers serialize as custom catalog summaries", async () => {
  const { repo, ownerId } = await buildHarness();
  const conn = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "runpod", kind: "llm", secretFields: { api_key: "vault://st/jarvis/runpod/key" },
  });
  assert.equal(conn.catalog.custom, true);
  assert.equal(conn.catalog.displayName, "runpod");
  assert.equal(conn.catalog.credentialUrl, null);
});

// ---------------------------------------------------------------------------
// Connection tests: honest, fail-closed, secret-free
// ---------------------------------------------------------------------------

test("connection test without a transport records unverified — never success (Rule 1)", async () => {
  const { repo, ownerId } = await buildHarness();
  const conn = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "gemini", kind: "llm", secretFields: { api_key: "vault://st/jarvis/gemini/key" },
  });

  const result = await runConnectionTest(conn);
  assert.equal(result.outcome, "unverified");
  assert.match(result.detail, /LIVE_TRANSPORT_NOT_CONFIGURED/);

  const recorded = await repo.recordTestResult(null, {
    connectionId: conn.id, ownerId, agentId: "agent-01",
    outcome: result.outcome, detail: result.detail,
  });
  assert.equal(recorded.outcome, "unverified");
  const history = await repo.listTestResults(ownerId, "agent-01", conn.id);
  assert.equal(history.length, 1);
});

test("connection test history is append-only (mutation blocked)", async () => {
  const { repo, ownerId } = await buildHarness();
  const conn = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "gemini", kind: "llm", secretFields: { api_key: "vault://st/jarvis/gemini/key" },
  });
  const recorded = await repo.recordTestResult(null, {
    connectionId: conn.id, ownerId, agentId: "agent-01", outcome: "unverified",
  });
  await assert.rejects(
    () => repo.db.query("UPDATE director_connection_tests SET outcome = $1 WHERE id = $2", ["success", recorded.id]),
    /APPEND_ONLY_VIOLATION/,
  );
});

test("transport failures produce sanitized failure records without secret values", async () => {
  const { repo, ownerId } = await buildHarness();
  const conn = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "elevenlabs", kind: "media", secretFields: { api_key: "vault://st/jarvis/elevenlabs/key" },
  });

  const result = await runConnectionTest(conn, {
    transport: async () => {
      throw new Error("auth rejected for vault://st/jarvis/elevenlabs/key api_key=sk-live-999");
    },
  });
  assert.equal(result.outcome, "failed");
  assert.ok(!result.detail.includes("vault://"), "locator must be scrubbed from failure detail");
  assert.ok(!result.detail.includes("sk-live-999"), "secret-shaped strings must be scrubbed");

  const recorded = await repo.recordTestResult(null, {
    connectionId: conn.id, ownerId, agentId: "agent-01",
    outcome: result.outcome, latencyMs: result.latencyMs, errorCode: result.errorCode, detail: result.detail,
  });
  assert.equal(recorded.outcome, "failed");
  assert.ok(!JSON.stringify(recorded).includes("vault://"));
});

test("only an explicit ok:true transport produces success, and field keys are all it ever sees", async () => {
  const { repo, ownerId } = await buildHarness();
  const conn = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "gemini", kind: "llm",
    secretFields: { api_key: "vault://st/jarvis/gemini/key" },
    configFields: { model: "gemini-2.0" },
  });

  let seenByTransport = null;
  const result = await runConnectionTest(conn, {
    transport: async (input) => {
      seenByTransport = input;
      return { ok: true };
    },
  });
  assert.equal(result.outcome, "success");
  assert.equal(typeof result.latencyMs, "number");
  assert.deepEqual(seenByTransport.secretFieldKeys, ["api_key"], "transport receives keys, not values");
  assert.ok(!JSON.stringify(seenByTransport).includes("vault://"), "locator never reaches the transport boundary");
  assert.equal(seenByTransport.configFields.model, "gemini-2.0");

  const rejected = await runConnectionTest(conn, {
    transport: async () => ({ ok: false, reason: "Authentication rejected" }),
  });
  assert.equal(rejected.outcome, "failed");
  assert.match(rejected.detail, /Authentication rejected/);

  const dishonest = await runConnectionTest(conn, {
    transport: async () => ({ ok: "yes" }),
  });
  assert.equal(dishonest.outcome, "failed", "a non-boolean ok is not success (fail closed)");
});

test("test history is scoped per connection and per director", async () => {
  const { repo, ownerId } = await buildHarness();
  const connA = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "gemini", kind: "llm", secretFields: { api_key: "vault://st/jarvis/gemini/key" },
  });
  const connB = await repo.upsertConnection(ownerId, "agent-01", {
    providerKey: "openai", kind: "llm", secretFields: { api_key: "vault://st/jarvis/openai/key" },
  });
  await repo.recordTestResult(null, { connectionId: connA.id, ownerId, agentId: "agent-01", outcome: "unverified" });
  await repo.recordTestResult(null, { connectionId: connB.id, ownerId, agentId: "agent-01", outcome: "unverified" });
  assert.equal((await repo.listTestResults(ownerId, "agent-01", connA.id)).length, 1);
  assert.equal((await repo.listTestResults(ownerId, "agent-02", connA.id)).length, 0, "cross-director history is invisible");
});
