import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { PostgresQuotaRepository } from "../src/quotas/postgresQuotaRepository.js";

test("Task 3.6 durable provider quota PostgreSQL 15 acceptance", async (t) => {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL 15 URL is mandatory for Task 3.6 integration acceptance");
    t.diagnostic("PostgreSQL is not configured; Task 3.6 live suite is not run by the unit command");
    return;
  }

  const schema = `quota_${process.pid}_${Date.now()}`;
  const connection = { connectionString: dbUrl, connectionTimeoutMillis: 5000 };
  const bootstrap = new pg.Pool(connection);
  let pool;
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema},public` });
    const adapter = new PostgresAdapter({}, pool);
    const runner = new MigrationRunner(adapter);
    await runner.runMigrations();
    const rerun = await runner.runMigrations();
    assert.equal(rerun.appliedCount, 0, "migration 013 and predecessors must rerun without changes");

    const ownerId = crypto.randomUUID();
    const otherOwnerId = crypto.randomUUID();
    const agentId = `quota-agent-${Date.now()}`;
    await adapter.query(
      `INSERT INTO owners (id,email,password_hash) VALUES ($1,$2,'test'),($3,$4,'test')`,
      [ownerId, `quota-${ownerId}@test.invalid`, otherOwnerId, `quota-${otherOwnerId}@test.invalid`]
    );
    await adapter.query(
      `INSERT INTO agents (id,name,namespace) VALUES ($1,$2,$3)`,
      [agentId, `QUOTA_${Date.now()}`, `st.quota.${Date.now()}`]
    );

    const repository = new PostgresQuotaRepository(adapter);
    const credentialId = crypto.randomUUID();
    const scope = { ownerId, agentId, slot: "primary", provider: "provider-a", credentialId };
    await repository.configureQuota(scope, { limit: 1, tier: "free" });

    await t.test("concurrent final-unit reservation is atomic and restart durable", async () => {
      const results = await Promise.allSettled([
        repository.reserve({ ...scope, idempotencyKey: "concurrent-a" }),
        repository.reserve({ ...scope, idempotencyKey: "concurrent-b" })
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const reservation = results.find((result) => result.status === "fulfilled").value;

      const restarted = new PostgresQuotaRepository(adapter);
      const state = await restarted.getQuotaState(scope);
      assert.equal(state.reservedCount, 1);
      assert.equal(state.usageCount, 0);

      const committed = await restarted.commit(reservation);
      assert.equal(committed.status, "committed");
      const repeated = await restarted.commit(reservation);
      assert.equal(repeated.status, "committed");
      const after = await restarted.getQuotaState(scope);
      assert.equal(after.reservedCount, 0);
      assert.equal(after.usageCount, 1);
      const evidence = await adapter.query(
        `SELECT payload FROM evidence_events
         WHERE subject_id=$1 AND kind='provider_quota_committed'`,
        [reservation.id]
      );
      assert.equal(evidence.rowCount, 1, "idempotent commit appends evidence exactly once");
      assert.equal(evidence.rows[0].payload.ownerId, ownerId);
      assert.equal(evidence.rows[0].payload.credentialId, credentialId);
    });

    await t.test("release is idempotent and opposite terminal transitions fail closed", async () => {
      const localScope = {
        ownerId, agentId, slot: "emergency_1", provider: "local-a", credentialId: null
      };
      await repository.configureQuota(localScope, { limit: 2, tier: "free" });
      const reservation = await repository.reserve({ ...localScope, idempotencyKey: "release-a" });
      assert.equal((await repository.release(reservation)).status, "released");
      assert.equal((await repository.release(reservation)).status, "released");
      await assert.rejects(repository.commit(reservation), /QUOTA_RESERVATION_TERMINAL_STATE_CONFLICT/);
      const state = await repository.getQuotaState(localScope);
      assert.equal(state.reservedCount, 0);
      assert.equal(state.usageCount, 0);
    });

    await t.test("owner, agent, provider and credential isolation cannot be crossed", async () => {
      assert.equal(await repository.getQuotaState({ ...scope, ownerId: otherOwnerId }), null);
      assert.equal(await repository.getQuotaState({ ...scope, provider: "provider-b" }), null);
      assert.equal(await repository.getQuotaState({ ...scope, credentialId: crypto.randomUUID() }), null);
    });

    await t.test("database-time cooldowns are bounded and survive repository restart", async () => {
      const cooldownScope = {
        ownerId, agentId, slot: "secondary", provider: "provider-cooldown", credentialId: crypto.randomUUID()
      };
      await repository.configureQuota(cooldownScope, { limit: 2, tier: "free" });
      for (const retryAfterSeconds of [0, -1, 3601, Number.MAX_SAFE_INTEGER]) {
        await assert.rejects(
          repository.recordCooldown(cooldownScope, { errorCode: "RATE_LIMIT", retryAfterSeconds }),
          /INVALID_RETRY_AFTER/
        );
      }
      await repository.recordCooldown(cooldownScope, { errorCode: "RATE_LIMIT", retryAfterSeconds: 1 });
      await assert.rejects(
        new PostgresQuotaRepository(adapter).reserve({ ...cooldownScope, idempotencyKey: "cooldown-active" }),
        /PROVIDER_IN_COOLDOWN/
      );
      await adapter.query(
        `UPDATE provider_quota_limits SET cooldown_until=now()-interval '1 second', cooldown_code='RATE_LIMIT'
         WHERE owner_id=$1 AND agent_id=$2 AND slot=$3 AND provider=$4 AND credential_key=$5`,
        [ownerId, agentId, cooldownScope.slot, cooldownScope.provider, cooldownScope.credentialId]
      );
      const reservation = await repository.reserve({ ...cooldownScope, idempotencyKey: "cooldown-expired" });
      await repository.release(reservation);
    });

    await t.test("expired trials fail closed at the database clock boundary", async () => {
      const trialScope = {
        ownerId, agentId, slot: "tertiary", provider: "provider-trial", credentialId: crypto.randomUUID()
      };
      await repository.configureQuota(trialScope, {
        limit: 1,
        tier: "trial",
        trialExpiryTimestamp: new Date(Date.now() + 60_000).toISOString()
      });
      await adapter.query(
        `UPDATE provider_quota_limits SET trial_expires_at=now()-interval '1 second'
         WHERE owner_id=$1 AND agent_id=$2 AND slot=$3 AND provider=$4 AND credential_key=$5`,
        [ownerId, agentId, trialScope.slot, trialScope.provider, trialScope.credentialId]
      );
      await assert.rejects(
        repository.reserve({ ...trialScope, idempotencyKey: "expired-trial" }),
        /trial_expired/
      );
    });

    await t.test("evidence failure rolls back reservation state", async () => {
      const rollbackScope = {
        ownerId, agentId, slot: "emergency_2", provider: "local-rollback", credentialId: null
      };
      await repository.configureQuota(rollbackScope, { limit: 1, tier: "free" });
      await adapter.query(`
        CREATE FUNCTION reject_quota_evidence() RETURNS trigger AS $$
        BEGIN
          IF NEW.kind='provider_quota_reserved' THEN RAISE EXCEPTION 'INJECTED_EVIDENCE_FAILURE'; END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_quota_evidence_trigger BEFORE INSERT ON evidence_events
        FOR EACH ROW EXECUTE FUNCTION reject_quota_evidence();
      `);
      try {
        await assert.rejects(
          repository.reserve({ ...rollbackScope, idempotencyKey: "rollback-evidence" }),
          /INJECTED_EVIDENCE_FAILURE/
        );
      } finally {
        await adapter.query("DROP TRIGGER reject_quota_evidence_trigger ON evidence_events");
        await adapter.query("DROP FUNCTION reject_quota_evidence()")
      }
      const state = await repository.getQuotaState(rollbackScope);
      assert.equal(state.reservedCount, 0);
      const reservationRows = await adapter.query(
        "SELECT count(*)::int AS count FROM provider_quota_reservations WHERE idempotency_key='rollback-evidence'"
      );
      assert.equal(reservationRows.rows[0].count, 0);
    });

    await adapter.closePool();
    pool = null;
  } finally {
    if (pool) await pool.end().catch(() => {});
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await bootstrap.end();
  }
});
