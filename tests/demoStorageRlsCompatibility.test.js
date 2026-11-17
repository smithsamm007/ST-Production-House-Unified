import test from "node:test";
import assert from "node:assert/strict";

import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/migrationRunner.js";

test("DemoStorageAdapter applies migrations 001-040 with honest RLS boundary and keeps unknown SQL fail-closed", async () => {
  const db = createDemoStorageAdapter();
  assert.equal(db.isDemoStorage, true);
  assert.equal(db.enforcesPostgresRls, false);

  const result = await runMigrations(db);
  assert.ok(result.appliedCount >= 40, `Expected >= 40 applied migrations, got ${result.appliedCount}`);

  // Honest-label contract: demo storage explicitly records unapplied PG-only RLS/privilege DDL
  assert.ok(
    db.unappliedPostgresOnlySecurityStatements.length > 0,
    "DemoStorageAdapter must explicitly record unapplied PostgreSQL-only RLS/privilege statements"
  );
  assert.ok(
    db.unappliedPostgresOnlySecurityStatements.some((s) =>
      s.includes("DROP POLICY IF EXISTS director_self_isolation_policy ON forge_director_isolated_records")
    ),
    "Expected migration 038 DROP POLICY statement to be recorded"
  );

  // Unknown SQL must still fail closed — no broad SQL suppression
  await assert.rejects(
    () => db.query("TRUNCATE TABLE jobs"),
    /DEMO_SQL_UNSUPPORTED/
  );
  await assert.rejects(
    () => db.query("CREATE MATERIALIZED VIEW demo_unsupported_mv AS SELECT 1"),
    /DEMO_SQL_UNSUPPORTED/
  );
});
