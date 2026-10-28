/**
 * Operator secret-manager adapter contract — unit tests (Issue #208).
 *
 * Offline only: no network, no real secret backend, no live credentials.
 * All operator configuration is set in-process (env-prefix shell commands are
 * blocked in this environment), mirroring how loadOAuthConfig is tested.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SECRET_MANAGER_ADAPTER_KINDS,
  isLocatorShaped,
  loadSecretManagerConfig,
  isSecretManagerConfigured,
  validateSecretManagerAdapter,
  guardSecretManagerAdapter,
  createBuiltinEnvSecretManager,
  loadConfiguredSecretManager,
} from "../src/credentials/oauthSecretManagerAdapter.js";

const ENV_KEYS = [
  "STPH_SECRET_MANAGER_ADAPTER",
  "STPH_SECRET_MANAGER_ADAPTER_MODULE",
  "STPH_SECRET_MANAGER_ENV_SEED",
];

test.after(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// ---------------------------------------------------------------------------
// Configuration parsing
// ---------------------------------------------------------------------------

test("adapter kinds are a bounded allowlist and configuration parses honestly", () => {
  assert.deepEqual([...SECRET_MANAGER_ADAPTER_KINDS], ["builtin-env", "vault-http", "custom"]);
  assert.deepEqual(loadSecretManagerConfig({}), { kind: null, customModule: null, seedVars: [] });
  assert.equal(isSecretManagerConfigured(loadSecretManagerConfig({})), false);

  assert.equal(
    isSecretManagerConfigured(loadSecretManagerConfig({ STPH_SECRET_MANAGER_ADAPTER: "builtin-env" })),
    true,
  );
  assert.equal(
    isSecretManagerConfigured(loadSecretManagerConfig({
      STPH_SECRET_MANAGER_ADAPTER: "custom",
      STPH_SECRET_MANAGER_ADAPTER_MODULE: "/somewhere/adapter.mjs",
    })),
    true,
  );
  assert.equal(
    isSecretManagerConfigured(loadSecretManagerConfig({ STPH_SECRET_MANAGER_ADAPTER: "custom" })),
    false,
    "custom kind without a module path is not configuration",
  );

  const parsed = loadSecretManagerConfig({
    STPH_SECRET_MANAGER_ENV_SEED: " A, ,, B ",
  });
  assert.deepEqual(parsed.seedVars, ["A", "B"], "seed list is trimmed and skips empties");
});

// ---------------------------------------------------------------------------
// Validation: structure, placeholders, locator shape
// ---------------------------------------------------------------------------

test("validateSecretManagerAdapter rejects malformed adapters and placeholders", () => {
  assert.throws(() => validateSecretManagerAdapter(null), /SECRET_MANAGER_ADAPTER_INVALID/);
  assert.throws(() => validateSecretManagerAdapter("nope"), /SECRET_MANAGER_ADAPTER_INVALID/);
  assert.throws(() => validateSecretManagerAdapter([]), /SECRET_MANAGER_ADAPTER_INVALID/);
  assert.throws(
    () => validateSecretManagerAdapter({ writeSecret() {}, readSecret() {} }),
    /SECRET_MANAGER_ADAPTER_INVALID/,
    "deleteSecret missing",
  );

  // Rule 3: the labeled in-memory placeholder from #206 must never pass.
  const placeholder = {
    isPlaceholder: true,
    label: "in-memory-secret-manager (placeholder, non-durable)",
    async writeSecret() {},
    async readSecret() {},
    async deleteSecret() {},
  };
  assert.throws(() => validateSecretManagerAdapter(placeholder), /SECRET_MANAGER_ADAPTER_PLACEHOLDER_REJECTED/);
});

test("guarded adapters enforce locator-shaped writeSecret results", async () => {
  const good = guardSecretManagerAdapter({
    async writeSecret() { return "vault://st/agent-01/youtube/oauth"; },
    async readSecret() { return { access_token: "untouched" }; },
    async deleteSecret() {},
  });
  assert.equal(await good.writeSecret({}), "vault://st/agent-01/youtube/oauth");

  const rawTokenAdapter = guardSecretManagerAdapter({
    async writeSecret() { return "ya29.raw-token-returned-by-mistake"; },
    async readSecret() { return {}; },
    async deleteSecret() {},
  });
  await assert.rejects(() => rawTokenAdapter.writeSecret({}), /SECRET_MANAGER_LOCATOR_INVALID/);

  const emptyAdapter = guardSecretManagerAdapter({
    async writeSecret() { return ""; },
    async readSecret() { return {}; },
    async deleteSecret() {},
  });
  await assert.rejects(() => emptyAdapter.writeSecret({}), /SECRET_MANAGER_LOCATOR_INVALID/);
});

test("guarded adapters sanitize unexpected errors but keep stable codes", async () => {
  const leaking = guardSecretManagerAdapter({
    async writeSecret() { throw new Error("backend refused vault://st/agent-01/youtube/oauth api_key=sk-live-999"); },
    async readSecret() { return {}; },
    async deleteSecret() { const e = new Error("gone"); e.code = "SECRET_MANAGER_ENTRY_NOT_FOUND"; throw e; },
  });

  await assert.rejects(
    () => leaking.writeSecret({}),
    (err) => err.code === "SECRET_MANAGER_ADAPTER_FAILED" &&
      !String(err.detail).includes("vault://") &&
      !String(err.detail).includes("sk-live-999"),
    "leaked locator and secret-shaped strings are redacted (Rule 17)",
  );

  await assert.rejects(
    () => leaking.deleteSecret({}),
    (err) => err.code === "SECRET_MANAGER_ENTRY_NOT_FOUND",
    "adapter-provided stable codes pass through untouched",
  );
});

// ---------------------------------------------------------------------------
// builtin-env adapter (explicitly non-durable stopgap)
// ---------------------------------------------------------------------------

test("builtin-env adapter is honest, locator-returning, and round-trips payloads", async () => {
  const manager = createBuiltinEnvSecretManager();
  assert.equal(manager.nonDurable, true);
  assert.match(manager.label, /non-durable/);

  const locator = await manager.writeSecret({
    ownerId: "owner-1",
    agentId: "agent-01",
    providerKey: "youtube",
    payload: { access_token: "ya29.roundtrip" },
  });
  assert.ok(isLocatorShaped(locator));
  assert.ok(locator.startsWith("opaque://builtin-env/"));

  const second = await manager.writeSecret({
    ownerId: "owner-1", agentId: "agent-02", providerKey: "youtube", payload: {},
  });
  assert.notEqual(locator, second, "locators are unique");

  assert.deepEqual(await manager.readSecret({ locator }), { access_token: "ya29.roundtrip" });
  await manager.deleteSecret({ locator });
  await assert.rejects(() => manager.readSecret({ locator }), /SECRET_MANAGER_ENTRY_NOT_FOUND/);
  await assert.rejects(() => manager.deleteSecret({ locator }), /SECRET_MANAGER_ENTRY_NOT_FOUND/);
});

test("builtin-env adapter validates writes and seeds only locator-shaped env refs", async () => {
  const manager = createBuiltinEnvSecretManager();
  await assert.rejects(
    () => manager.writeSecret({ ownerId: null, agentId: "agent-01", providerKey: "youtube", payload: {} }),
    /SECRET_MANAGER_ADAPTER_FAILED/,
  );
  await assert.rejects(
    () => manager.writeSecret({ ownerId: "owner-1", agentId: "agent-01", providerKey: "youtube", payload: "nope" }),
    /SECRET_MANAGER_ADAPTER_FAILED/,
  );

  const seeded = createBuiltinEnvSecretManager({
    seedVars: ["TEST_SEED_LOCATOR"],
    env: { TEST_SEED_LOCATOR: "vault://external/ref" },
  });
  const payload = await seeded.readSecret({ locator: "vault://external/ref" });
  assert.equal(payload.locator_ref, "vault://external/ref");
  assert.equal(payload.source, "env:TEST_SEED_LOCATOR");

  const skipped = createBuiltinEnvSecretManager({
    seedVars: ["TEST_SEED_LOCATOR"],
    env: { TEST_SEED_LOCATOR: "plaintext-not-a-locator" },
  });
  await assert.rejects(
    () => skipped.readSecret({ locator: "plaintext-not-a-locator" }),
    /SECRET_MANAGER_ENTRY_NOT_FOUND/,
    "non-locator env values are never seeded as secret references",
  );
});

// ---------------------------------------------------------------------------
// Loader: builtin-env + custom module resolution, fail-closed errors
// ---------------------------------------------------------------------------

test("loadConfiguredSecretManager returns null when nothing is declared", async () => {
  delete process.env.STPH_SECRET_MANAGER_ADAPTER;
  delete process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE;
  delete process.env.STPH_SECRET_MANAGER_ENV_SEED;
  assert.equal(await loadConfiguredSecretManager(), null);
});

test("loadConfiguredSecretManager wires builtin-env and fails closed on unknown kinds", async () => {
  process.env.STPH_SECRET_MANAGER_ADAPTER = "builtin-env";
  const wired = await loadConfiguredSecretManager();
  assert.ok(wired, "an adapter is returned");
  assert.match(wired.label, /guarded:/);
  assert.match(wired.label, /builtin-env/);
  const locator = await wired.writeSecret({ ownerId: "o", agentId: "agent-01", providerKey: "youtube", payload: {} });
  assert.ok(isLocatorShaped(locator));

  // Unknown kinds are not configuration: nothing is loaded (fail closed).
  process.env.STPH_SECRET_MANAGER_ADAPTER = "teleport";
  assert.equal(await loadConfiguredSecretManager(), null, "unknown kind loads nothing, honestly");
});

test("loadConfiguredSecretManager loads a custom factory module and validates it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stph-adapter-"));
  try {
    const goodModule = join(dir, "good-adapter.mjs");
    writeFileSync(goodModule, `
export default async function createSecretManager() {
  return {
    label: "operator-test-adapter",
    async writeSecret() { return "vault://operator/agent-01/youtube"; },
    async readSecret() { return { ok: true }; },
    async deleteSecret() {},
  };
}
`);
    process.env.STPH_SECRET_MANAGER_ADAPTER = "custom";
    process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE = pathToFileURL(goodModule).href;
    const wired = await loadConfiguredSecretManager();
    assert.match(wired.label, /operator-test-adapter/);
    assert.deepEqual(await wired.readSecret({ locator: "vault://operator/agent-01/youtube" }), { ok: true });

    const badModule = join(dir, "bad-adapter.mjs");
    writeFileSync(badModule, "export default async function createSecretManager() { return { label: 'x' }; }\n");
    process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE = pathToFileURL(badModule).href;
    await assert.rejects(() => loadConfiguredSecretManager(), /SECRET_MANAGER_ADAPTER_INVALID/);

    process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE = pathToFileURL(join(dir, "missing.mjs")).href;
    await assert.rejects(() => loadConfiguredSecretManager(), /SECRET_MANAGER_ADAPTER_MODULE_UNAVAILABLE/);

    const throwingModule = join(dir, "throwing-adapter.mjs");
    writeFileSync(throwingModule, `
export default async function createSecretManager() {
  throw new Error("license server unreachable for vault://license/ref");
}
`);
    process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE = pathToFileURL(throwingModule).href;
    await assert.rejects(
      () => loadConfiguredSecretManager(),
      (err) => err.code === "SECRET_MANAGER_ADAPTER_FAILED" && !String(err.detail).includes("vault://"),
      "factory failures are sanitized and stable",
    );
  } finally {
    delete process.env.STPH_SECRET_MANAGER_ADAPTER;
    delete process.env.STPH_SECRET_MANAGER_ADAPTER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});
