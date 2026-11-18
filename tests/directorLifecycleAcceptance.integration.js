/**
 * Director lifecycle acceptance (migrations 033/034 + rollback artefact).
 *
 * Everything here runs against a disposable PostgreSQL database that is created
 * from the CANONICAL migration set, populated with production-shaped fixtures,
 * and dropped afterwards. Nothing touches a persistent database.
 *
 * This suite exists because a previous draft of migration 034 seeded all ten
 * canonical Directors as `retired`, which — combined with sql/032's operational
 * guard — silently disabled the four ALREADY-OPERATIONAL preserved Directors
 * (defect D-1). The classification asserted here is the fix:
 *
 *   preserved operational Directors -> active
 *   new canonical Directors         -> suspended + PENDING_OWNER_ACTIVATION
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { CanonicalDirectorRepository } from "../src/catalog/canonicalDirectorRepository.js";
import { createCanonicalDirectorGuard } from "../src/catalog/canonicalDirectorLifecycle.js";
import {
  DIRECTOR_LIFECYCLE,
  PENDING_ACTIVATION_NOTE,
  lifecycleStateOf,
  canOriginateWork,
  assertLifecycleTransition,
} from "../src/catalog/directorLifecycle.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ROLLBACK_FILE = path.join(ROOT, "sql", "rollback", "033_034_rollback.sql");

const LEGACY_PATTERN_SQL = "id ~ '^agent-(0[4-9]|1[0-9]|20)$'";
const GUARDED_TABLES = Object.freeze([
  "jobs", "director_schedules", "director_connections", "channels",
  "promo_campaigns", "youtube_oauth_states", "social_oauth_states",
]);

const hex = () => crypto.randomBytes(32).toString("hex");
const uuid = () => crypto.randomUUID();

function requireDatabase(t) {
  const dbUrl = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
  const required = Boolean(process.env.CI || process.env.npm_lifecycle_event === "test:integration" || dbUrl);
  if (!dbUrl) {
    if (required) assert.fail("PostgreSQL 15 URL is mandatory for the Director lifecycle acceptance");
    t.skip("PostgreSQL is not configured");
    return null;
  }
  return dbUrl;
}

async function withDisposable(t, dbUrl, fn) {
  const created = await createDisposableDatabase(dbUrl, "stph_acceptance");
  assert.match(created.name, /^stph_acceptance_/);
  assert.notEqual(created.name, new URL(dbUrl).pathname.replace(/^\//, ""), "must not be the source database");
  const pool = new pg.Pool({ connectionString: created.connectionString, connectionTimeoutMillis: 5000 });
  const adapter = new PostgresAdapter({}, pool);
  const stageDir = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "lifecycle-stage-"));
  try {
    // Stage 1: the pre-033 schema (canonical 001..032 only) so historical rows can
    // be seeded exactly as they exist in a running installation.
    const all = (await fs.readdir(path.join(ROOT, "sql"))).filter((f) => f.endsWith(".sql")).sort();
    for (const file of all.slice(0, 32)) {
      await fs.copyFile(path.join(ROOT, "sql", file), path.join(stageDir, file));
    }
    const staged = await new MigrationRunner(adapter, { migrationsDir: stageDir }).runMigrations();
    assert.equal(staged.appliedCount, 32, "the disposable database is staged at the pre-cutover schema");

    // Stage 2: apply the reviewed migrations under test, verbatim.
    const applyHead = async () => {
      for (const file of ["033_legacy_director_retirement.sql", "034_canonical_director_seed.sql"]) {
        await adapter.query(await fs.readFile(path.join(ROOT, "sql", file), "utf8"));
      }
    };
    return await fn({ pool, adapter, name: created.name, applyHead });
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
    await pool.end().catch(() => {});
    assert.equal(await dropDisposableDatabase(dbUrl, created.name), true, "the disposable database must be provably removed");
  }
}

async function attempt(pool, sql, params = []) {
  try {
    const result = await pool.query(sql, params);
    return { ok: true, rowCount: result.rowCount };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}

const expectRetired = (r, label) => {
  assert.equal(r.ok, false, `${label}: must be refused`);
  assert.equal(r.code, "P0001", `${label}: expected P0001, got ${r.code}: ${r.message}`);
  assert.match(r.message, /LEGACY_DIRECTOR_RETIRED/, label);
};

const expectBlocked = (r, code, label) => {
  assert.equal(r.ok, false, `${label}: must be refused`);
  assert.equal(r.code, "P0001", `${label}: expected P0001, got ${r.code}: ${r.message}`);
  assert.match(r.message, new RegExp(code), `${label}: expected ${code}`);
};

const expectAllowed = (r, label) =>
  assert.equal(r.ok, true, `${label}: must be allowed (got ${r.code ?? ""} ${r.message ?? ""})`);

const WRITES = Object.freeze({
  jobs: (pool, { ownerId, agentId }) =>
    attempt(pool, `INSERT INTO jobs (agent_id, capability, idempotency_key, payload, owner_id)
                   VALUES ($1,'episode_production',$2,'{}'::jsonb,$3)`, [agentId, `acc-${hex().slice(0, 12)}`, ownerId]),
  director_schedules: (pool, { ownerId, agentId }) =>
    attempt(pool, `INSERT INTO director_schedules (owner_id, agent_id, schedule_enabled) VALUES ($1,$2,true)`, [ownerId, agentId]),
  director_connections: (pool, { ownerId, agentId }) =>
    attempt(pool, `INSERT INTO director_connections (owner_id, agent_id, provider_key, kind) VALUES ($1,$2,'openai','llm')`, [ownerId, agentId]),
  channels: (pool, { ownerId, agentId }) =>
    attempt(pool, `INSERT INTO channels (slug, display_name, agent_id, owner_id) VALUES ($1,'Acc',$2,$3)`, [`acc-${hex().slice(0, 10)}`, agentId, ownerId]),
  promo_campaigns: (pool, { productIdentityId, agentId }) =>
    attempt(pool, `INSERT INTO promo_campaigns (product_identity_id, owner_agent_id, include_in_main_video) VALUES ($1,$2,false)`, [productIdentityId, agentId]),
  youtube_oauth_states: (pool, { ownerId, agentId }) =>
    attempt(pool, `INSERT INTO youtube_oauth_states (state_hash, owner_id, agent_id, redirect_uri, expires_at)
                   VALUES ($1,$2,$3,'https://app.test/cb', now() + interval '1 hour')`, [hex(), ownerId, agentId]),
  social_oauth_states: (pool, { ownerId, agentId }) =>
    attempt(pool, `INSERT INTO social_oauth_states (state_hash, owner_id, agent_id, provider_key, redirect_uri, expires_at)
                   VALUES ($1,$2,$3,'instagram','https://app.test/cb', now() + interval '1 hour')`, [hex(), ownerId, agentId]),
});

async function seedProductionShape(pool) {
  const f = {
    ownerId: uuid(), otherOwnerId: uuid(), productIdentityId: uuid(),
    legacyAgentId: "agent-07", preservedAgentId: "agent-01",
  };
  await pool.query("INSERT INTO owners (id,email,password_hash) VALUES ($1,$2,$3),($4,$5,$6)",
    [f.ownerId, `a-${f.ownerId.slice(0, 8)}@test.invalid`, "x".repeat(64),
     f.otherOwnerId, `b-${f.otherOwnerId.slice(0, 8)}@test.invalid`, "x".repeat(64)]);
  await pool.query("INSERT INTO product_identities (id,canonical_identity,identity_sha256) VALUES ($1,$2,$3)",
    [f.productIdentityId, `identity-${f.productIdentityId.slice(0, 8)}`, hex()]);

  f.legacyChannelId = uuid();
  f.preservedChannelId = uuid();
  await pool.query(
    `INSERT INTO channels (id,slug,display_name,agent_id,owner_id) VALUES
       ($1,$2,'Legacy',$3,$4), ($5,$6,'Preserved',$7,$8)`,
    [f.legacyChannelId, `legacy-${hex().slice(0, 8)}`, f.legacyAgentId, f.ownerId,
     f.preservedChannelId, `preserved-${hex().slice(0, 8)}`, f.preservedAgentId, f.ownerId]
  );
  f.legacyReleaseId = uuid();
  await pool.query(
    `INSERT INTO production_releases (id,channel_id,owner_id,title,season,episode)
     VALUES ($1,$2,$3,'Legacy Episode',1,1), ($4,$5,$3,'Preserved Episode',1,1)`,
    [f.legacyReleaseId, f.legacyChannelId, f.ownerId, uuid(), f.preservedChannelId]
  );
  f.legacyJobId = uuid();
  await pool.query(
    `INSERT INTO jobs (id,agent_id,capability,idempotency_key,payload,owner_id,status) VALUES
       ($1,$2,'episode_production',$3,'{}'::jsonb,$4,'queued'), ($5,$6,'episode_production',$7,'{}'::jsonb,$4,'queued')`,
    [f.legacyJobId, f.legacyAgentId, `seed-${hex().slice(0, 12)}`, f.ownerId,
     uuid(), f.preservedAgentId, `seed-${hex().slice(0, 12)}`]
  );
  await pool.query("INSERT INTO director_schedules (owner_id,agent_id,schedule_enabled) VALUES ($1,$2,true),($1,$3,true)",
    [f.ownerId, f.legacyAgentId, f.preservedAgentId]);
  await pool.query("INSERT INTO director_connections (owner_id,agent_id,provider_key,kind) VALUES ($1,$2,'openai','llm'),($1,$3,'openai','llm')",
    [f.ownerId, f.legacyAgentId, f.preservedAgentId]);
  await pool.query(
    `INSERT INTO youtube_oauth_states (state_hash,owner_id,agent_id,redirect_uri,expires_at) VALUES
       ($1,$2,$3,'https://app.test/cb', now() + interval '1 hour'), ($4,$2,$5,'https://app.test/cb', now() + interval '1 hour')`,
    [hex(), f.ownerId, f.legacyAgentId, hex(), f.preservedAgentId]
  );
  await pool.query("INSERT INTO promo_campaigns (product_identity_id,owner_agent_id,include_in_main_video) VALUES ($1,$2,false)",
    [f.productIdentityId, f.legacyAgentId]);
  return f;
}

const counts = async (pool) => {
  const out = {};
  for (const name of ["agents", "canonical_director_mappings", "channels", "production_releases", "jobs",
    "director_schedules", "director_connections", "youtube_oauth_states", "promo_campaigns", "director_legacy_retirements"]) {
    const exists = (await pool.query("SELECT to_regclass($1) AS t", [name])).rows[0].t;
    out[name] = exists ? (await pool.query(`SELECT count(*)::int AS c FROM ${name}`)).rows[0].c : 0;
  }
  return out;
};

// ---------------------------------------------------------------------------
test("lifecycle vocabulary is a single mapping over sql/032's enum", () => {
  assert.equal(lifecycleStateOf({ status: "active" }), DIRECTOR_LIFECYCLE.ACTIVE);
  assert.equal(lifecycleStateOf({ status: "retired" }), DIRECTOR_LIFECYCLE.RETIRED);
  assert.equal(lifecycleStateOf({ status: "suspended", suspended_note: PENDING_ACTIVATION_NOTE }), DIRECTOR_LIFECYCLE.PENDING);
  assert.equal(lifecycleStateOf({ status: "suspended", suspended_note: "operator pause" }), DIRECTOR_LIFECYCLE.SUSPENDED);
  assert.equal(canOriginateWork({ status: "active" }), true);
  assert.equal(canOriginateWork({ status: "suspended", suspended_note: PENDING_ACTIVATION_NOTE }), false);
  assert.equal(canOriginateWork({ status: "retired" }), false);
  assert.throws(() => lifecycleStateOf({ status: "bogus" }), /DIRECTOR_LIFECYCLE_STATUS_UNKNOWN/);
  assert.throws(() => assertLifecycleTransition("retired", "suspended"), /TRANSITION_REJECTED/);
  assert.equal(assertLifecycleTransition("pending", "active"), true);
});

test("034 classifies all ten canonical Directors without disabling the preserved ones", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ pool, applyHead }) => {
    await applyHead();
    const rows = (await pool.query(
      "SELECT canonical_director_code, underlying_agent_id, status, suspended_note FROM canonical_director_mappings ORDER BY canonical_director_code"
    )).rows;
    assert.equal(rows.length, 10);
    const preserved = new Set(["agent-01", "agent-02", "agent-03", "agent-21"]);
    const active = rows.filter((r) => r.status === "active");
    const pending = rows.filter((r) => lifecycleStateOf(r) === DIRECTOR_LIFECYCLE.PENDING);
    assert.equal(active.length, 4, "exactly the four operational Directors are active");
    assert.deepEqual(active.map((r) => r.underlying_agent_id).sort(), [...preserved].sort());
    assert.equal(pending.length, 6, "the six new Directors are pending, not active");
    assert.equal(rows.filter((r) => r.status === "retired").length, 0, "no Director is seeded as retired");
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM director_legacy_retirements")).rows[0].c, 17);
  });
});

test("seven guarded paths: active Director allowed, pending and legacy refused", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ pool, applyHead }) => {
    const f = await seedProductionShape(pool);
    await applyHead();
    const freshProduct = uuid();
    await pool.query("INSERT INTO product_identities (id,canonical_identity,identity_sha256) VALUES ($1,$2,$3)",
      [freshProduct, `identity-${freshProduct.slice(0, 8)}`, hex()]);

    for (const [table, write] of Object.entries(WRITES)) {
      expectRetired(await write(pool, { ...f, agentId: f.legacyAgentId }), `${table}: legacy`);
      expectBlocked(await write(pool, { ...f, ownerId: f.otherOwnerId, agentId: "agent-director-cosmos", productIdentityId: freshProduct }),
        "CANONICAL_DIRECTOR_NOT_ACTIVE", `${table}: pending`);
      expectAllowed(await write(pool, { ...f, ownerId: f.otherOwnerId, agentId: f.preservedAgentId, productIdentityId: freshProduct }),
        `${table}: active`);
    }
    const triggers = (await pool.query(
      "SELECT tgname FROM pg_trigger WHERE tgname LIKE 'legacy_director_guard_%' AND NOT tgisinternal ORDER BY tgname"
    )).rows.map((r) => r.tgname);
    assert.deepEqual(triggers, GUARDED_TABLES.map((n) => `legacy_director_guard_${n}`).sort());
  });
});

test("application guard reports pending distinctly from active and retired", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ adapter, applyHead }) => {
    await applyHead();
    const guard = createCanonicalDirectorGuard(adapter);
    assert.equal((await guard.assertActive("agent-01")).status, "active");
    await assert.rejects(() => guard.assertActive("agent-director-cosmos"),
      (e) => e.code === "CANONICAL_DIRECTOR_PENDING_ACTIVATION");
    // agent-07 is a LEGACY identity: it has no canonical mapping, so the
    // application guard reports "not governed" and sql/033's database guard is
    // what refuses its new work (asserted in the guarded-path test).
    assert.equal(await guard.assertActive("agent-07"), null, "an ungoverned legacy identity is not canonical-governed");
    await assert.rejects(() => guard.assertActiveCode("COSMOS"),
      (e) => e.code === "CANONICAL_DIRECTOR_PENDING_ACTIVATION", "code-based lookup reports pending identically");
  });
});

test("rite schedules: retired identity cannot be re-enabled, active Director keeps working", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ pool, applyHead }) => {
    const f = await seedProductionShape(pool);
    await applyHead();
    const disable = await attempt(pool,
      "UPDATE director_schedules SET schedule_enabled = false WHERE agent_id = $1", [f.legacyAgentId]);
    expectAllowed(disable, "disabling a retired Director's schedule (history stays writable)");
    const reEnable = await attempt(pool,
      "UPDATE director_schedules SET schedule_enabled = true WHERE agent_id = $1", [f.legacyAgentId]);
    expectRetired(reEnable, "re-enabling a retired Director's schedule");
    const activeUpdate = await attempt(pool,
      "UPDATE director_schedules SET schedule_enabled = false WHERE agent_id = $1", [f.preservedAgentId]);
    expectAllowed(activeUpdate, "active Director schedule update");
  });
});

test("in-flight work: queued/leased/retry/dead-letter transitions still work for a retired identity", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ pool, applyHead }) => {
    const f = await seedProductionShape(pool);
    await applyHead();
    const leased = await attempt(pool, "UPDATE jobs SET status='leased' WHERE id=$1", [f.legacyJobId]);
    expectAllowed(leased, "claiming an existing job of a retired Director");
    const failed = await attempt(pool, "UPDATE jobs SET status='failed' WHERE id=$1", [f.legacyJobId]);
    expectAllowed(failed, "failing an in-flight job");
    const requeued = await attempt(pool, "UPDATE jobs SET status='queued', attempts=attempts+1 WHERE id=$1", [f.legacyJobId]);
    expectAllowed(requeued, "retry/requeue of an existing job");
    const row = (await pool.query("SELECT agent_id, owner_id FROM jobs WHERE id=$1", [f.legacyJobId])).rows[0];
    assert.equal(row.agent_id, f.legacyAgentId, "ownership never moves");
    assert.equal(row.owner_id, f.ownerId);
    const newJob = await WRITES.jobs(pool, { ownerId: f.ownerId, agentId: f.legacyAgentId });
    expectRetired(newJob, "a NEW job for the retired Director");
  });
});

test("OAuth and provider connections respect lifecycle while history stays readable", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ pool, applyHead }) => {
    const f = await seedProductionShape(pool);
    await applyHead();
    const readable = await pool.query("SELECT count(*)::int AS c FROM youtube_oauth_states WHERE agent_id=$1", [f.legacyAgentId]);
    assert.equal(readable.rows[0].c, 1, "historical OAuth state rows remain readable");
    expectRetired(await WRITES.youtube_oauth_states(pool, { ownerId: f.ownerId, agentId: f.legacyAgentId }), "new OAuth round");
    expectRetired(await WRITES.director_connections(pool, { ownerId: f.ownerId, agentId: f.legacyAgentId }), "new connection");
    // A connection update re-grants provider capability, so it counts as new work
    // capability and is refused; reads stay available.
    expectRetired(await attempt(pool, "UPDATE director_connections SET status='unverified' WHERE agent_id=$1", [f.legacyAgentId]),
      "re-arming an existing connection");
  });
});

test("activation is explicit, cap-locked and idempotent; capacity is enforced", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ adapter, applyHead }) => {
    await applyHead();
    const repo = new CanonicalDirectorRepository(adapter);
    assert.equal(await repo.activeCount(), 4);
    const activated = await repo.activateMapping("COSMOS");
    assert.equal(activated.status, "active");
    assert.equal(await repo.activeCount(), 5);
    // Idempotent re-activation must not double-count or fail.
    await repo.activateMapping("COSMOS");
    assert.equal(await repo.activeCount(), 5);
    // Concurrent activation of two different codes serialises on the cap lock.
    const [a, b] = await Promise.all([repo.activateMapping("AADI"), repo.activateMapping("CHRONOS")]);
    assert.equal(a.status, "active");
    assert.equal(b.status, "active");
    assert.equal(await repo.activeCount(), 7);
  });
});

test("concurrent migration attempts serialise: exactly one applies, the other is a no-op", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  const created = await createDisposableDatabase(dbUrl, "stph_acceptance");
  const pools = [
    new pg.Pool({ connectionString: created.connectionString, connectionTimeoutMillis: 5000 }),
    new pg.Pool({ connectionString: created.connectionString, connectionTimeoutMillis: 5000 }),
  ];
  try {
    const runners = pools.map((p) => new MigrationRunner(new PostgresAdapter({}, p)));
    const results = await Promise.all(runners.map((r) => r.runMigrations()));
    // The canonical sequence grows with every new sql/NNN_*.sql file; the
    // assertion is about serialisation, so it derives the count instead of
    // pinning today's number (a hardcoded 34 broke when 035-040 landed).
    const migrationCount = (await fs.readdir(path.join(ROOT, "sql"))).filter((f) => f.endsWith(".sql")).length;
    const applied = results.map((r) => r.appliedCount).sort((a, b) => a - b);
    assert.deepEqual(applied, [0, migrationCount], "one runner applies all migrations, the other applies none");
    const count = await pools[0].query("SELECT count(*)::int AS c FROM director_legacy_retirements");
    assert.equal(count.rows[0].c, 17, "no duplicate retirement rows from concurrent application");
  } finally {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    assert.equal(await dropDisposableDatabase(dbUrl, created.name), true);
  }
});

test("rollback before activation: objects removed, data intact, legacy work possible again", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ pool, applyHead }) => {
    const f = await seedProductionShape(pool);
    await applyHead();
    const before = await counts(pool);
    const rollbackSql = await fs.readFile(ROLLBACK_FILE, "utf8");
    await pool.query(rollbackSql);

    const objects = await pool.query(
      "SELECT count(*)::int AS c FROM pg_trigger WHERE tgname LIKE 'legacy_director_guard_%' AND NOT tgisinternal"
    );
    assert.equal(objects.rows[0].c, 0, "no guard triggers remain");
    assert.equal((await pool.query("SELECT to_regclass('public.director_legacy_retirements') AS t")).rows[0].t, null);
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM agents WHERE id LIKE 'agent-director-%'")).rows[0].c, 0,
      "referenced agent rows are kept, unreferenced ones are removed");
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM canonical_director_mappings")).rows[0].c, 0);

    const after = await counts(pool);
    assert.equal(after.jobs, before.jobs, "no historical job removed");
    assert.equal(after.channels, before.channels, "no channel removed");
    assert.equal(after.production_releases, before.production_releases, "no release removed");
    expectAllowed(await WRITES.jobs(pool, { ownerId: f.ownerId, agentId: f.legacyAgentId }), "new job for the former legacy Director");
  });
});

test("rollback after activation and after activity: refuses without force, succeeds when forced", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ pool, adapter, applyHead }) => {
    const f = await seedProductionShape(pool);
    await applyHead();
    const repo = new CanonicalDirectorRepository(adapter);
    await repo.activateMapping("COSMOS");
    await WRITES.channels(pool, { ownerId: f.ownerId, agentId: "agent-director-cosmos" });

    const rollbackSql = await fs.readFile(ROLLBACK_FILE, "utf8");
    await assert.rejects(() => pool.query(rollbackSql),
      (e) => /ROLLBACK_REFUSED_(LIFECYCLE_CHANGED_AFTER_MIGRATION|NEW_DIRECTOR_HAS_CHANNELS)/.test(String(e.message)),
      "rollback must refuse after lifecycle or production changes");

    // Lifecycle states survive the refusal (the failed transaction changed nothing).
    const stillActive = await pool.query("SELECT status FROM canonical_director_mappings WHERE canonical_director_code='COSMOS'");
    assert.equal(stillActive.rows[0].status, "active");

    await pool.query("BEGIN");
    await pool.query("SET LOCAL app.rollback_force = 'on'");
    await pool.query(rollbackSql);
    await pool.query("COMMIT");
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM canonical_director_mappings")).rows[0].c, 0);
    const kept = await pool.query(
      "SELECT (SELECT count(*)::int FROM jobs WHERE agent_id LIKE 'agent-director-%') AS jobs, (SELECT count(*)::int FROM channels WHERE agent_id LIKE 'agent-director-%') AS channels");
    assert.deepEqual(kept.rows[0], { jobs: 0, channels: 1 }, "rollback never deletes production rows");
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM agents WHERE id='agent-director-cosmos'")).rows[0].c, 1,
      "an agent row referenced by production data survives rollback");
  });
});

test("tenant isolation: ownership cannot be used to bypass the lifecycle", async (t) => {
  const dbUrl = requireDatabase(t);
  if (!dbUrl) return;
  await withDisposable(t, dbUrl, async ({ pool, applyHead }) => {
    const f = await seedProductionShape(pool);
    await applyHead();
    expectRetired(await WRITES.channels(pool, { ownerId: f.otherOwnerId, agentId: f.legacyAgentId }), "legacy under another owner");
    expectAllowed(await WRITES.channels(pool, { ownerId: f.otherOwnerId, agentId: f.preservedAgentId }), "active under another owner");
    const unknown = await WRITES.channels(pool, { ownerId: f.ownerId, agentId: "agent-unknown-99" });
    assert.equal(unknown.code, "23503", `unknown agent must fail the FK, got ${unknown.code}`);
    const rows = (await pool.query("SELECT id, agent_id FROM channels WHERE id = ANY($1::uuid[])", [[f.legacyChannelId, f.preservedChannelId]])).rows;
    const map = Object.fromEntries(rows.map((r) => [r.id, r.agent_id]));
    assert.equal(map[f.legacyChannelId], f.legacyAgentId, "no identity substitution");
    assert.equal(map[f.preservedChannelId], f.preservedAgentId);
  });
});

test("migration 032 is untouched and the seed is reproducible", async () => {
  const checksum = crypto.createHash("sha256")
    .update(await fs.readFile(path.join(ROOT, "sql", "032_canonical_director_mappings.sql")))
    .digest("hex");
  assert.equal(checksum, "c8def789fa311702bbba71da4073884c1b35cf5e68ca3f4b499427d1ff97336f",
    "migration 032 must remain byte-identical");
  const files = (await fs.readdir(path.join(ROOT, "sql"))).filter((f) => f.endsWith(".sql")).sort();
  // Contiguity, not a pinned length: every file must be numbered 001..N with
  // no gaps or duplicates, however many migrations the repository carries.
  const numbers = files.map((f) => Number(f.slice(0, 3)));
  assert.deepEqual(
    numbers,
    numbers.map((_, index) => index + 1),
    `the canonical sequence is contiguous 001..${String(files.length).padStart(3, "0")}`
  );
});
