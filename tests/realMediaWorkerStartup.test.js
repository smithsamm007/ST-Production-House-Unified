/**
 * Real-media worker startup contract (defect: async factory bound without await).
 *
 * `src/catalog/server.js` once bound the runner factory without `await`:
 *
 *     executorRunnerFactory = createRealMediaRunnerFactory({...}); // a Promise
 *
 * `createRealMediaRunnerFactory` is async (it resolves per-Director governed
 * provider capacity at binding time) while `ProductionWorkerLoop` accepts only
 * `null` or a function (`src/pipeline/workerLoop.js:54`). The constructor threw
 * `WORKER_EXECUTOR_RUNNER_FACTORY_INVALID` inside the startup `try`, where
 * `logInternalError("WORKER_START_FAILED", ...)` swallowed it — so with
 * `STPH_ENABLE_REAL_MEDIA=1` no worker started at all and the leased queue
 * stayed idle while the process reported healthy.
 *
 * WHY THIS IS A SOURCE ASSERTION rather than a behavioural one:
 * the binding lives inside `finalizeRuntimeStartup`, which only reaches the
 * worker branch when PostgreSQL storage is configured (`STORAGE` is resolved at
 * import time). A test that actually ran that branch would need a database, so
 * there is no offline call path to exercise. This assertion is the only
 * automated detector for the regression: it fails the moment the `await` is
 * dropped. Precedent: `tests/mergeWorkflowContract.test.js` pins workflow
 * contracts the same way.
 *
 * It deliberately does NOT test `ProductionWorkerLoop`'s rejection of a
 * non-function factory: that behaviour already exists in `workerLoop`, is not
 * what regressed here, and a test of it passes whether or not this defect is
 * present — it would document the consequence without detecting the defect.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("runtime startup awaits the async real-media runner factory", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "catalog", "server.js"), "utf8");
  const bindings = source.match(/executorRunnerFactory\s*=\s*(?:await\s+)?createRealMediaRunnerFactory\(/g) ?? [];

  assert.equal(
    bindings.length,
    1,
    "expected exactly one executorRunnerFactory binding of the real-media factory"
  );
  assert.match(
    bindings[0],
    /=\s*await\s+createRealMediaRunnerFactory\(/,
    "the async factory must be awaited: binding the Promise makes " +
      "ProductionWorkerLoop throw WORKER_EXECUTOR_RUNNER_FACTORY_INVALID and no worker starts"
  );
});
