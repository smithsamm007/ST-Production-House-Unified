/**
 * Day 6 — real application bootstrap and mounted-route verification.
 *
 * This test does NOT mount an isolated router. It spawns the actual production
 * entrypoint (`server.js`), lets it configure PostgreSQL custody and apply the
 * canonical migrations, registers the first Owner through the real auth route,
 * signs in, and then exercises the Director Fleet / worker routes over real HTTP
 * with a real session cookie and a real CSRF token. Finally it sends SIGTERM and
 * requires a clean, graceful exit.
 *
 * No provider, publishing destination, deployment or persistent database is
 * touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_EMAIL = `boot-owner-${Date.now()}@example.test`;
const OWNER_PASSWORD = "BootAcceptance!Passphrase2026";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const body = await response.json();
        if (body?.status === "ok" || body?.database?.status === "ok" || body?.storage === "postgres") return body;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw new Error(`SERVER_NOT_READY: ${lastError ? lastError.message : "timeout"}`);
}

test(
  "real server.js bootstrap: PostgreSQL custody, auth, CSRF and mounted fleet/worker routes",
  { skip: POSTGRES_URL ? false : "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" },
  async () => {
    const created = await createDisposableDatabase(POSTGRES_URL, "stph_acceptance");
    const port = 46000 + Math.floor(Math.random() * 500);
    const baseUrl = `http://127.0.0.1:${port}`;
    let child = null;
    let stdout = "";
    let stderr = "";

    try {
      child = spawn(process.execPath, ["server.js"], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          NODE_ENV: "test",
          HOST: "127.0.0.1",
          PORT: String(port),
          DATABASE_URL: created.connectionString,
          POSTGRES_TEST_URL: "",
          STPH_STRICT_POSTGRES: "1",
          STPH_APPROVAL_WORKER: "disabled",
          STPH_NOTIFICATION_WORKER: "disabled",
          STPH_REPORT_SCHEDULER: "disabled",
          STPH_ENABLE_WORKERS: "0",
          STPH_DIRECTOR_WORKERS: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const health = await waitForHealth(baseUrl);
      assert.ok(stdout.includes("SERVER_LISTENING"), "the real entrypoint must report SERVER_LISTENING");
      assert.equal(health.storage ?? health?.database?.storage, "postgres");

      // ------------------------------------------------ first Owner + sign-in
      const registration = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      const registrationText = await registration.text();
      assert.equal(registration.status, 201, `owner registration failed: ${registrationText}`);

      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      const loginText = await login.text();
      assert.equal(login.status, 200, `owner login failed: ${loginText}`);
      const loginBody = JSON.parse(loginText);
      const setCookie = login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie")];
      const cookie = setCookie
        .filter(Boolean)
        .map((value) => String(value).split(";")[0])
        .join("; ");
      assert.match(cookie, /session_token=/);
      const csrf = loginBody.csrfToken;
      assert.equal(typeof csrf, "string");
      const authed = (init = {}) => ({
        ...init,
        headers: {
          cookie,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const mutation = (body) => authed({ method: "POST", headers: { "x-csrf-token": csrf }, body: JSON.stringify(body) });

      // --------------------------------------------- AD: unauthenticated/CSRF
      const unauthenticated = await fetch(`${baseUrl}/api/fleet/directors`);
      assert.equal(unauthenticated.status, 401, "an Owner session is required");
      const csrfRefused = await fetch(`${baseUrl}/api/fleet/directors`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ directorId: "boot-alpha", displayName: "Boot Alpha" }),
      });
      assert.equal(csrfRefused.status, 403, "a mutation without a CSRF token must be refused");
      const csrfBody = await csrfRefused.json().catch(() => ({}));
      assert.equal(csrfBody.code === "CSRF_REJECTED" || /CSRF/i.test(JSON.stringify(csrfBody)), true, JSON.stringify(csrfBody));

      // ------------------------------------------------------ mounted routes
      const directorResponse = await fetch(
        `${baseUrl}/api/fleet/directors`,
        mutation({ directorId: "boot-alpha", displayName: "Boot Alpha", reason: "Boot acceptance registration" })
      );
      const directorBody = await directorResponse.json().catch(() => ({}));
      assert.equal(directorResponse.status, 201, JSON.stringify(directorBody));

      const fleetList = await fetch(`${baseUrl}/api/fleet/directors`, authed());
      assert.equal(fleetList.status, 200);
      const fleetBody = await fleetList.json();
      assert.equal(fleetBody.directors.length, 1);
      assert.equal(fleetBody.directors[0].directorId, "boot-alpha");

      const workerRegister = await fetch(
        `${baseUrl}/api/fleet/workers/register`,
        mutation({
          workerKey: "boot-worker",
          instanceId: "boot-instance-1",
          stageTypes: ["RESEARCH"],
          capabilities: ["document.structure"],
        })
      );
      const registeredWorker = await workerRegister.json().catch(() => ({}));
      assert.equal(workerRegister.status, 201, JSON.stringify(registeredWorker));
      assert.equal(registeredWorker.worker.state, "REGISTERED");

      const heartbeat = await fetch(
        `${baseUrl}/api/fleet/workers/boot-worker/heartbeat`,
        mutation({ instanceId: "boot-instance-1", state: "IDLE" })
      );
      const heartbeatBody = await heartbeat.json().catch(() => ({}));
      assert.equal(heartbeat.status, 200, JSON.stringify(heartbeatBody));
      assert.equal(heartbeatBody.worker?.state, "IDLE");

      const registryList = await fetch(`${baseUrl}/api/fleet/workers/registry`, authed());
      assert.equal(registryList.status, 200);
      assert.equal((await registryList.json()).count, 1);

      const metrics = await fetch(`${baseUrl}/api/fleet/workers/metrics`, authed());
      assert.equal(metrics.status, 200);
      const metricsBody = await metrics.json();
      assert.equal(metricsBody.workers.registered, 1);

      const deadLetters = await fetch(`${baseUrl}/api/fleet/tasks/dead-letters`, authed());
      assert.equal(deadLetters.status, 200);
      assert.equal((await deadLetters.json()).count, 0);

      const emptyClaim = await fetch(`${baseUrl}/api/fleet/tasks/claim`, mutation({ workerKey: "boot-worker" }));
      assert.equal(emptyClaim.status, 204, "an empty queue is a 204, never a fabricated task");

      const missingTaskId = "00000000-0000-4000-8000-000000000000";
      const missingCompletion = await fetch(
        `${baseUrl}/api/fleet/tasks/${missingTaskId}/complete`,
        mutation({
          directorId: "boot-alpha",
          workerKey: "boot-worker",
          fencingToken: 1,
          resultRef: "director-stage://boot/missing",
          evidence: [],
        })
      );
      assert.equal(missingCompletion.status, 404);
      assert.equal((await missingCompletion.json()).code, "TASK_NOT_FOUND");

      const emptyEvidence = await fetch(
        `${baseUrl}/api/fleet/directors/boot-alpha/tasks/${missingTaskId}/evidence`,
        authed()
      );
      assert.equal(emptyEvidence.status, 200);
      assert.equal((await emptyEvidence.json()).count, 0);

      const drain = await fetch(
        `${baseUrl}/api/fleet/workers/boot-worker/drain`,
        mutation({ reason: "Boot acceptance drain" })
      );
      const drainBody = await drain.json().catch(() => ({}));
      assert.equal(drain.status, 200, JSON.stringify(drainBody));
      assert.equal(drainBody.worker?.state, "DRAINING");
      const drainedClaim = await fetch(`${baseUrl}/api/fleet/tasks/claim`, mutation({ workerKey: "boot-worker" }));
      assert.ok([204, 409].includes(drainedClaim.status), `a drained worker must not receive work (got ${drainedClaim.status})`);
      if (drainedClaim.status !== 204) {
        assert.equal((await drainedClaim.json()).claimed, false);
      }

      // -------------------------------------------------------- migrations
      const admin = new pg.Pool({ connectionString: created.connectionString, max: 2 });
      // The server's disposable database is dropped WITH (FORCE) after shutdown; a
      // closing socket can receive 57P01 as an idle-client error during teardown.
      admin.on("error", () => {});
      try {
        const applied = await admin.query("SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1");
        assert.equal(applied.rows[0].filename, "046_director_worker_runtime.sql");
        const tables = await admin.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name IN ('director_workers','director_task_checkpoints','director_lease_violations','director_worker_events')"
        );
        assert.equal(tables.rows.length, 4);
      } finally {
        await admin.end();
      }

      // ------------------------------------------- Z: graceful shutdown
      child.kill("SIGTERM");
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SERVER_DID_NOT_EXIT")), 20_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(exitCode, 0, `server must exit cleanly; stderr=${stderr.slice(-800)}`);
      assert.ok(stdout.includes("SHUTDOWN_SIGNAL_RECEIVED"), "graceful shutdown must be observable");
      assert.equal(/UNCAUGHT_EXCEPTION|UNHANDLED_REJECTION/.test(stdout + stderr), false);
      child = null;
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await sleep(100);
      await dropDisposableDatabase(POSTGRES_URL, created.databaseName).catch(() => {});
    }
  }
);
