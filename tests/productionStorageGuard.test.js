/**
 * Production storage custody guard (Rule 3/17 hardening).
 *
 * Proves the production-fail-closed behavior of configureRuntime():
 *   - STPH_DEMO_STORAGE=1 with NODE_ENV=production refuses to boot outright;
 *   - production without a database configuration boots DEGRADED
 *     ("unconfigured") — never the silent labeled demo fallback;
 *   - non-production behavior is unchanged (demo fallback still available).
 *
 * All environment deltas are explicit, saved, and restored, and the database
 * and secret-manager variables are cleared so the tests cannot drift with
 * the workspace .env (a workspace-exported STPH_SECRET_MANAGER_ADAPTER is a
 * legitimate operator configuration — the guard must isolate it).
 */

import test from "node:test";
import assert from "node:assert/strict";

const DB_ENV_KEYS = ["DATABASE_URL", "POSTGRES_URL", "PGHOST", "POSTGRES_HOST", "STPH_STRICT_POSTGRES", "STPH_DEMO_STORAGE", "NODE_ENV", "STPH_SECRET_MANAGER_ADAPTER", "STPH_SECRET_MANAGER_ADAPTER_MODULE", "STPH_SECRET_MANAGER_ENV_SEED"];
const savedEnv = new Map(DB_ENV_KEYS.map((key) => [key, process.env[key]]));

function clearProductionEnv() {
  for (const key of DB_ENV_KEYS) delete process.env[key];
}

test.after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function freshConfigureRuntime() {
  const server = await import("../src/catalog/server.js");
  server.__resetOauthSecretManagerForTests?.();
  return server;
}

test("production + STPH_DEMO_STORAGE=1 refuses to boot (fail closed)", async () => {
  clearProductionEnv();
  process.env.NODE_ENV = "production";
  process.env.STPH_DEMO_STORAGE = "1";
  const { configureRuntime } = await freshConfigureRuntime();
  await assert.rejects(() => configureRuntime(), /PRODUCTION_DEMO_STORAGE_REFUSED/);
});

test("production without a database configuration boots honestly degraded, never demo", async () => {
  clearProductionEnv();
  process.env.NODE_ENV = "production";
  const { configureRuntime, getOauthSecretManagerStatus } = await freshConfigureRuntime();
  const runtime = await configureRuntime();
  assert.equal(runtime.storageMode, "unconfigured");
  // No custody object was fabricated and no secret-manager wiring happened.
  assert.equal(runtime.oauthSecretManager, false);
  const status = getOauthSecretManagerStatus();
  assert.equal(status.declared, false);
  assert.equal(status.bound, false);
});

test("production with a database configuration never falls back to demo custody", async () => {
  clearProductionEnv();
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgresql://postgres@127.0.0.1:1433/nonexistent";
  const { configureRuntime } = await freshConfigureRuntime();
  // A dead configured database is an honest LOUD failure — the boot must not
  // drift into the non-durable demo adapter (suite runs without any DB server).
  await assert.rejects(() => configureRuntime());
});

test("non-production keeps the documented demo fallback for the sandbox workflow", async () => {
  clearProductionEnv();
  process.env.STPH_DEMO_STORAGE = "1";
  const { configureRuntime } = await freshConfigureRuntime();
  const runtime = await configureRuntime();
  assert.equal(runtime.storageMode, "demo");
});
