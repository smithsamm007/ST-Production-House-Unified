import test from "node:test";
import assert from "node:assert/strict";
import { PostgresQuotaRepository } from "../src/quotas/postgresQuotaRepository.js";

test("Task 3.6 finalization locks quota before reservation", async () => {
  const queries = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const reservationRow = {
    id: "reservation-1",
    quota_id: "quota-1",
    owner_id: "owner-1",
    agent_id: "agent-1",
    slot: "primary",
    provider: "provider-a",
    credential_key: "__local__",
    idempotency_key: "request-1",
    units: 1,
    status: "reserved",
    usage_count: 0,
    reserved_count: 1,
    quota_limit: 1,
    created_at: now,
    updated_at: now,
  };

  const client = {
    async query(sql) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (normalized.startsWith("SELECT quota_id FROM provider_quota_reservations")) {
        return { rowCount: 1, rows: [{ quota_id: "quota-1" }] };
      }
      if (normalized.startsWith("SELECT id FROM provider_quota_limits")) {
        return { rowCount: 1, rows: [{ id: "quota-1" }] };
      }
      if (normalized.startsWith("SELECT r.*, q.usage_count")) {
        return { rowCount: 1, rows: [reservationRow] };
      }
      if (normalized.startsWith("UPDATE provider_quota_reservations")) {
        return { rowCount: 1, rows: [{ ...reservationRow, status: "committed" }] };
      }
      if (normalized.startsWith("SELECT event_hash FROM evidence_events")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const adapter = {
    async withTransaction(work) {
      return work(client);
    },
  };

  const repository = new PostgresQuotaRepository(adapter);
  const result = await repository.commit({
    id: "reservation-1",
    ownerId: "owner-1",
    agentId: "agent-1",
  });

  assert.equal(result.status, "committed");
  assert.match(queries[0], /^SELECT quota_id FROM provider_quota_reservations/);
  assert.match(queries[1], /^SELECT id FROM provider_quota_limits/);
  assert.match(queries[1], /FOR UPDATE/);
  assert.match(queries[2], /^SELECT r\.\*, q\.usage_count/);
  assert.match(queries[2], /FOR UPDATE OF r/);
  assert.doesNotMatch(queries[2], /FOR UPDATE OF r, q/);
});
