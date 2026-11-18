import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { PostgresForgeRepository } from "../src/forge/postgresForgeRepository.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";

test(
  "PostgreSQL 15 FORGE Phase 2.7: migrations 035-038, atomic leases, evidence chain, and non-owner Director RLS isolation",
  { skip: !POSTGRES_URL ? "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" : false },
  async () => {
    const pool = new pg.Pool({ connectionString: POSTGRES_URL });
    try {
      const migrations = [
        "sql/035_forge_tasks_and_leases.sql",
        "sql/036_forge_providers_and_budgets.sql",
        "sql/037_forge_delivery_and_evidence.sql",
        "sql/038_forge_governance_and_director_rls.sql",
        "sql/039_director_rls_closure.sql",
        "sql/040_rls_strict_allowlist_and_function_hardening.sql",
      ];
      for (const file of migrations) {
        const sql = await readFile(path.join(process.cwd(), file), "utf8");
        await pool.query(sql);
      }

      // Function hardening: malformed agent IDs fail closed to NULL
      const badFn = await pool.query(
        "SELECT forge_director_role_for_agent('../evil;DROP') AS r1, forge_director_role_for_agent('') AS r2, forge_director_role_for_agent('agent-01') AS r3"
      );
      assert.equal(badFn.rows[0].r1, null);
      assert.equal(badFn.rows[0].r2, null);
      assert.equal(badFn.rows[0].r3, "st_dir_agent_01");

      const repo = new PostgresForgeRepository(pool);
      const { task } = await repo.enqueueTask({
        issueNumber: 350,
        slug: "pg-rls-verify",
        title: "Verify PostgreSQL 15 FORGE persistence",
        idempotencyKey: `idem-pg-${Date.now()}`,
      });
      const w1 = await repo.registerWorker({ workerKey: `w1-${Date.now()}`, role: "coder" });
      const w2 = await repo.registerWorker({ workerKey: `w2-${Date.now()}`, role: "coder" });

      // Lease 1 expires immediately (0s TTL), Lease 2 reclaims atomically with fencingToken=2
      const l1 = await repo.claimLease({ taskId: task.id, workerId: w1.id, leaseTtlSeconds: 0 });
      assert.equal(l1.ok, true);
      assert.equal(l1.fencingToken, 1);

      const l2 = await repo.claimLease({ taskId: task.id, workerId: w2.id, leaseTtlSeconds: 60 });
      assert.equal(l2.ok, true);
      assert.equal(l2.fencingToken, 2);

      // Serialized hash-chained evidence append
      const ev1 = await repo.appendEvidence({ eventType: "PG_TEST_1", actorId: "forge-ctrl", taskId: task.id });
      const ev2 = await repo.appendEvidence({ eventType: "PG_TEST_2", actorId: "forge-ctrl", taskId: task.id });
      assert.equal(ev2.prev_hash, ev1.record_hash);

      // Provision isolated non-owner Director roles and verify FORCE RLS
      const { roleName: roleA } = await repo.provisionDirectorRuntimeRole("agent_01");
      const { roleName: roleB } = await repo.provisionDirectorRuntimeRole("agent_02");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${roleA}`);
        await client.query(
          "INSERT INTO forge_director_isolated_records (director_id, director_role, record_type, payload) VALUES ($1, $2, $3, $4::jsonb)",
          ["agent-01", roleA, "lore", JSON.stringify({ secret: "ward7" })]
        );
        await client.query("COMMIT");

        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${roleB}`);
        // Spoofed session variable must have zero effect on current_user RLS
        await client.query("SET LOCAL app.current_director_id = 'agent-01'");
        const crossSelect = await client.query(
          "SELECT * FROM forge_director_isolated_records WHERE director_id = 'agent-01'"
        );
        assert.equal(crossSelect.rows.length, 0, "Director B must see 0 rows of Director A under FORCE RLS");

        const crossUpdate = await client.query(
          "UPDATE forge_director_isolated_records SET record_type = 'tampered' WHERE director_id = 'agent-01'"
        );
        assert.equal(crossUpdate.rowCount, 0, "Director B cannot UPDATE Director A rows");

        const crossDelete = await client.query(
          "DELETE FROM forge_director_isolated_records WHERE director_id = 'agent-01'"
        );
        assert.equal(crossDelete.rowCount, 0, "Director B cannot DELETE Director A rows");

        // A rejected statement aborts the transaction, so the privilege
        // assertion below needs a savepoint to run in a usable transaction
        // (otherwise it observes 25P02 instead of a permission decision).
        await client.query("SAVEPOINT before_spoofed_insert");
        await assert.rejects(
          () =>
            client.query(
              "INSERT INTO forge_director_isolated_records (director_id, director_role, record_type) VALUES ('agent-01', $1, 'spoof')",
              [roleA]
            ),
          /row-level security policy/i
        );
        await client.query("ROLLBACK TO SAVEPOINT before_spoofed_insert");

        // PostgreSQL authorises SET ROLE against the SESSION user, and a
        // superuser session may assume any role: role assumption is therefore
        // constrained by the connection identity, not by RLS. A Director
        // runtime identity is a non-superuser that belongs to exactly one
        // st_dir_* role, so model that pooler identity and prove it cannot
        // assume the other Director's role.
        await client.query("SAVEPOINT before_role_escalation");
        await client.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'st_test_director_pooler') THEN
              CREATE ROLE st_test_director_pooler NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN;
            END IF;
          END $$;
        `);
        await client.query(`GRANT ${roleB} TO st_test_director_pooler`);
        await client.query("SET LOCAL SESSION AUTHORIZATION st_test_director_pooler");
        await assert.rejects(
          () => client.query(`SET LOCAL ROLE ${roleA}`),
          /permission denied/i,
          "Director B must not be able to SET ROLE to Director A"
        );
        await client.query("RESET SESSION AUTHORIZATION");
        await client.query("ROLLBACK TO SAVEPOINT before_role_escalation");
        await client.query("ROLLBACK");

        // Generic non-st_dir_* runtime role must NOT bypass Director RLS (closed allowlist check)
        await client.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'st_generic_runtime') THEN
              CREATE ROLE st_generic_runtime NOINHERIT NOLOGIN;
            END IF;
          END $$;
        `);
        await client.query("GRANT SELECT ON forge_director_isolated_records TO st_generic_runtime");
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE st_generic_runtime");
        const allowlistCheck = await client.query("SELECT forge_is_authorized_control_plane_role() AS allowed");
        assert.equal(allowlistCheck.rows[0].allowed, false, "Generic runtime role must not pass control-plane allowlist");
        const genericSelect = await client.query("SELECT * FROM forge_director_isolated_records");
        assert.equal(genericSelect.rows.length, 0, "Generic non-st_dir_* role must see 0 Director rows under FORCE RLS");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }
);
