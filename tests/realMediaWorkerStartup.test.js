/**
 * Real-media worker startup contract (defect: async factory bound without await).
 *
 * `createRealMediaRunnerFactory` is `async` because it resolves the per-Director
 * governed provider-capacity source at binding time. `finalizeRuntimeStartup`
 * used to bind its return value directly:
 *
 *     executorRunnerFactory = createRealMediaRunnerFactory({...});
 *
 * That stores a Promise. `ProductionWorkerLoop` accepts only `null` or a
 * function (`WORKER_EXECUTOR_RUNNER_FACTORY_INVALID`), so the constructor threw
 * inside the startup `try`, `logInternalError("WORKER_START_FAILED", ...)`
 * swallowed it, and NO worker started whenever STPH_ENABLE_REAL_MEDIA=1 — the
 * whole leased production queue stayed idle while the process reported healthy.
 *
 * These tests pin both halves:
 *   1. the consequence — an un-awaited factory value is rejected loudly instead
 *      of starting a loop that can never run a job;
 *   2. the call site — `src/catalog/server.js` awaits the factory, so dropping
 *      the `await` again fails here rather than silently in production.
 *
 * Offline by construction: stub repositories, a stub transport, no binary spawn.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createRealMediaRunnerFactory } from "../src/catalog/server.js";
import { bindProductionRunner } from "../src/pipeline/productionExecutorRunner.js";
import { ProductionWorkerLoop } from "../src/pipeline/workerLoop.js";
import { createNodeMediaTransports } from "../src/media/nodeMediaTransport.js";

const MEDIA_PATHS = Object.freeze({
  audio: path.join("artifacts", "media", "audio"),
  visual: path.join("artifacts", "media", "visuals"),
  episode: path.join("artifacts", "media", "episodes"),
  thumbnail: path.join("artifacts", "media", "thumbnails"),
  runPrefix: "episode",
});

const STUB_TRANSPORTS = Object.freeze({
  spawnImpl: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnErrorCode: "ENOENT" }),
  readFileImpl: async () => { throw new Error("ENOENT"); },
});

function loopWith(executorRunnerFactory) {
  return new ProductionWorkerLoop({
    jobsRepository: {},
    productionRepository: {},
    executorRunnerFactory,
    log: () => {},
  });
}

test("the real-media factory is async, so its return value is not a valid runner factory", async () => {
  const pending = createRealMediaRunnerFactory({
    bindProductionRunner,
    transports: STUB_TRANSPORTS,
    mediaPaths: MEDIA_PATHS,
  });
  assert.equal(typeof pending.then, "function", "factory must be async for the await contract to matter");
  assert.throws(
    () => loopWith(pending),
    (error) => error.message === "WORKER_EXECUTOR_RUNNER_FACTORY_INVALID",
    "a Promise bound as the factory must be rejected, not accepted as a runnable loop"
  );
  await pending;
});

test("an awaited factory is a function and the worker loop accepts it", async () => {
  const factory = await createRealMediaRunnerFactory({
    bindProductionRunner,
    transports: STUB_TRANSPORTS,
    mediaPaths: MEDIA_PATHS,
  });
  assert.equal(typeof factory, "function");
  const loop = loopWith(factory);
  assert.equal(typeof loop.executorRunnerFactory, "function");
});

test("runtime startup awaits the real-media runner factory at its only call site", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "catalog", "server.js"), "utf8");
  const bindings = source.match(/executorRunnerFactory\s*=\s*(?:await\s+)?createRealMediaRunnerFactory\(/g) ?? [];
  assert.equal(bindings.length, 1, "expected exactly one executorRunnerFactory binding of the real-media factory");
  assert.match(
    bindings[0],
    /=\s*await\s+createRealMediaRunnerFactory\(/,
    "the async factory must be awaited: binding the Promise makes the worker fail to start"
  );
});
