import test from "node:test";
import assert from "node:assert/strict";
import { PostgresCheckpointAdapter } from "../src/checkpoints/postgresCheckpointAdapter.js";

const transactionalAdapter = {
  query: async () => ({ rowCount: 0, rows: [] }),
  withTransaction: async (work) => work({ query: async () => ({ rowCount: 1, rows: [{ version: 1 }] }) }),
};

test("PostgresCheckpointAdapter fails closed without scope or transactions", () => {
  assert.throws(() => new PostgresCheckpointAdapter({}, { ownerId: "owner", agentId: "agent" }), /TRANSACTION_ADAPTER/);
  assert.throws(() => new PostgresCheckpointAdapter(transactionalAdapter, { agentId: "agent" }), /OWNER_ID_REQUIRED/);
  assert.throws(() => new PostgresCheckpointAdapter(transactionalAdapter, { ownerId: "owner" }), /AGENT_ID_REQUIRED/);
});

test("PostgresCheckpointAdapter rejects malformed, mismatched, and non-hashed records", async () => {
  const adapter = new PostgresCheckpointAdapter(transactionalAdapter, { ownerId: "owner", agentId: "agent" });
  await assert.rejects(adapter.set("task", "not-json"), /INVALID_JSON/);
  await assert.rejects(adapter.set("task", JSON.stringify({ taskId: "other" })), /SCOPE_MISMATCH/);
  await assert.rejects(adapter.set("task", JSON.stringify({ taskId: "task", payloadHash: "x", checksum: "y" })), /HASH_INVALID/);
});
