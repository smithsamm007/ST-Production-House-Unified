/**
 * Director Communication — durable PostgreSQL custody (disposable database).
 *
 * Verifies migration 041 and PostgresConversationRepository against a real
 * PostgreSQL instance created for this test and dropped afterwards:
 *   - one row per message with a total order across repository instances
 *   - DB-enforced idempotency for a retried clientMessageId
 *   - restart durability (a new repository reads the same history)
 *   - concurrent appends from two instances cannot duplicate a message
 *   - Owner and Director scoping
 *   - a failed insert throws instead of implying persistence
 *
 * Nothing here touches a persistent database: the database is created from the
 * canonical migration set and dropped in the finally block.
 */
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { PostgresConversationRepository } from "../src/communication/postgresConversationRepository.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";

test(
  "PostgreSQL 15 Director communication custody: ordering, idempotency, restart, concurrency, scoping",
  { skip: !POSTGRES_URL ? "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" : false },
  async () => {
    const created = await createDisposableDatabase(POSTGRES_URL, "stph_acceptance");
    const pool = new pg.Pool({ connectionString: created.connectionString, max: 8 });
    try {
      const migrations = await new MigrationRunner(new PostgresAdapter({}, pool)).runMigrations();
      assert.ok(migrations.appliedCount > 0, "canonical migrations must apply");

      const ownerA = (
        await pool.query(
          "INSERT INTO owners (email, password_hash) VALUES ($1, $2) RETURNING id;",
          ["comm-a@stproduction.test", "not-a-real-hash"]
        )
      ).rows[0].id;
      const ownerB = (
        await pool.query(
          "INSERT INTO owners (email, password_hash) VALUES ($1, $2) RETURNING id;",
          ["comm-b@stproduction.test", "not-a-real-hash"]
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO agents (id, name, namespace, enabled) VALUES
           ('agent-comm-01', 'COMM-ONE', 'st.agent.comm-one', true),
           ('agent-comm-02', 'COMM-TWO', 'st.agent.comm-two', true);`
      );

      const repo = new PostgresConversationRepository(pool);
      const otherInstance = new PostgresConversationRepository(pool);

      assert.deepEqual(await repo.listMessages(ownerA, "agent-comm-01"), []);

      const ownerMessage = {
        id: "msg-comm-owner-1",
        agentId: "agent-comm-01",
        kind: "conversation",
        sender: "owner",
        source: "owner",
        clientMessageId: "cmid-pg-owner-0001",
        correlationId: "corr-pg-0001",
        body: "Hi JARVIS",
        timestamp: new Date().toISOString(),
      };
      const replyMessage = {
        id: "dir-comm-reply-1",
        agentId: "agent-comm-01",
        kind: "conversation",
        sender: "director",
        source: "director_ai",
        outcome: "DIRECTOR_RESPONDED",
        model: "gemini-4-hydrogen",
        clientMessageId: "cmid-pg-owner-0001",
        correlationId: "corr-pg-0001",
        latencyMs: 321,
        body: "Ready to work on the next episode.",
        timestamp: new Date().toISOString(),
      };

      const first = await repo.appendMessage(ownerA, "agent-comm-01", ownerMessage);
      assert.equal(first.created, true);
      const second = await repo.appendMessage(ownerA, "agent-comm-01", replyMessage);
      assert.equal(second.created, true);

      const history = await repo.listMessages(ownerA, "agent-comm-01");
      assert.equal(history.length, 2);
      assert.equal(history[0].source, "owner");
      assert.equal(history[1].source, "director_ai");
      assert.equal(history[1].model, "gemini-4-hydrogen");
      assert.equal(history[1].latencyMs, 321);

      // Idempotency: the same clientMessageId + role cannot be stored twice.
      const duplicate = await repo.appendMessage(ownerA, "agent-comm-01", ownerMessage);
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.message.id, first.message.id);
      assert.equal((await repo.listMessages(ownerA, "agent-comm-01")).length, 2);

      // Restart: a fresh repository instance reads the same durable history.
      const afterRestart = await otherInstance.listMessages(ownerA, "agent-comm-01");
      assert.equal(afterRestart.length, 2);
      const delivery = await otherInstance.findDelivery(
        ownerA,
        "agent-comm-01",
        "cmid-pg-owner-0001"
      );
      assert.equal(delivery?.ownerMessage.id, first.message.id);
      assert.equal(delivery?.directorResponse.id, second.message.id);

      // Concurrency: two instances racing the same clientMessageId store one row.
      const concurrent = await Promise.all([
        repo.appendMessage(ownerA, "agent-comm-02", {
          ...ownerMessage,
          id: "msg-comm-race-a",
          agentId: "agent-comm-02",
          clientMessageId: "cmid-pg-race-0001",
        }),
        otherInstance.appendMessage(ownerA, "agent-comm-02", {
          ...ownerMessage,
          id: "msg-comm-race-b",
          agentId: "agent-comm-02",
          clientMessageId: "cmid-pg-race-0001",
        }),
      ]);
      assert.equal(concurrent.filter((entry) => entry.created).length, 1);
      assert.equal(concurrent[0].message.id, concurrent[1].message.id);
      assert.equal((await repo.listMessages(ownerA, "agent-comm-02")).length, 1);

      // Scoping: another Owner and another Director read nothing.
      assert.deepEqual(await repo.listMessages(ownerB, "agent-comm-01"), []);
      assert.deepEqual(await repo.listMessages(ownerA, "agent-comm-03"), []);

      // Explicit failure: an unknown Director cannot be persisted silently.
      await assert.rejects(
        () =>
          repo.appendMessage(ownerA, "agent-comm-unknown", {
            ...ownerMessage,
            id: "msg-comm-bad",
            agentId: "agent-comm-unknown",
            clientMessageId: "cmid-pg-bad-0001",
          }),
        (err) => /foreign key|violates|DIRECTOR_COMM_PERSIST_FAILED/i.test(String(err.message))
      );
    } finally {
      await pool.end().catch(() => {});
      assert.equal(await dropDisposableDatabase(POSTGRES_URL, created.name), true);
    }
  }
);
