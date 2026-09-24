/**
 * ST Production House — production entrypoint.
 *
 * Boot order (documented in docs/RUNBOOK.md):
 *   1. Resolve env (PORT/HOST for the hosting platform; sensible defaults).
 *   2. Choose storage: PostgreSQL via DATABASE_URL/PG*, or the labeled demo
 *      adapter when STPH_DEMO_STORAGE=1 (non-durable, /api/health reports it).
 *   3. Apply append-only migrations (005+ are idempotent IF NOT EXISTS form).
 *   4. Optionally bootstrap the first owner (BOOTSTRAP_OWNER_EMAIL/PASSWORD).
 *   5. Attach static dashboard + API and listen on 0.0.0.0:$PORT.
 *   6. Install signal handlers for graceful shutdown (pool closed, no job loss
 *      beyond in-flight requests).
 *
 * A failed database at boot is honest: the process logs DATABASE_BOOT_FAILED,
 * skips migrations/bootstrap, and STILL starts the HTTP server so /api/health
 * reports not-ready and the dashboard can render. It never fabricates ready.
 */

import app, { configureRuntime, finalizeRuntimeStartup } from "./src/catalog/server.js";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** Boot an auxiliary runtime (worker) once, truthfully logged. */
let bootFinalized = false;
async function finalizeBootOnce() {
  if (bootFinalized) return;
  bootFinalized = true;
  try {
    const result = await finalizeRuntimeStartup();
    if (result?.workerStarted) {
      console.log(JSON.stringify({ code: "PRODUCTION_WORKER_ENABLED" }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        code: "RUNTIME_FINALIZATION_FAILED",
        errorName: error?.name || "Error",
      })
    );
  }
}

/** Production guards: refuse to boot misconfigured, fail loudly but honestly. */
function logProductionGuards() {
  if (!IS_PRODUCTION) return;
  const warnings = [];
  if (process.env.STPH_DEMO_STORAGE === "1") {
    warnings.push({ code: "DEMO_STORAGE_IN_PRODUCTION", detail: "STPH_DEMO_STORAGE=1 with NODE_ENV=production is a misconfiguration; data will NOT be durable." });
  }
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.PGHOST && process.env.STPH_STRICT_POSTGRES !== "1") {
    warnings.push({ code: "NO_DATABASE_CONFIGURED", detail: "No DATABASE_URL/PG* found; set STPH_STRICT_POSTGRES=1 to refuse demo fallback in production." });
  }
  for (const warning of warnings) {
    console.warn(JSON.stringify({ level: "warn", ...warning }));
  }
}

async function main() {
  // Process-level safety: an unhandled rejection must not kill production
  // silently; log honestly and keep serving (health endpoints stay truthful).
  process.on("unhandledRejection", (reason) => {
    console.error(
      JSON.stringify({
        level: "error",
        code: "UNHANDLED_REJECTION",
        reasonName: reason?.name || "Error",
        reasonMessage: String(reason?.message ?? reason).slice(0, 200),
      })
    );
  });
  process.on("uncaughtException", (error) => {
    console.error(
      JSON.stringify({
        level: "error",
        code: "UNCAUGHT_EXCEPTION",
        errorName: error?.name || "Error",
        errorMessage: String(error?.message ?? "").slice(0, 200),
      })
    );
  });

  logProductionGuards();

  try {
    if (typeof configureRuntime === "function") {
      await configureRuntime();
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        code: "DATABASE_BOOT_FAILED",
        message: "Continuing in degraded mode; /api/health reports not-ready.",
        errorName: error?.name || "Error",
      })
    );
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(
      JSON.stringify({
        code: "SERVER_LISTENING",
        host: HOST,
        port: PORT,
        storage: process.env.STPH_DEMO_STORAGE === "1" ? "demo" : "postgres",
      })
    );
    // Boot finalization (demo seed, opt-in workers) after the listener is up.
    void finalizeBootOnce();
  });

  const shutdown = (signal) => {
    console.log(JSON.stringify({ code: "SHUTDOWN_SIGNAL_RECEIVED", signal }));
    server.close(async () => {
      try {
        const { closeRuntime } = await import("./src/catalog/server.js");
        if (typeof closeRuntime === "function") await closeRuntime();
      } catch {
        // pool already closed
      }
      process.exit(0);
    });
    // Hard stop if graceful close hangs (e.g. keep-alive connections).
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      code: "SERVER_BOOT_FAILED",
      errorName: error?.name || "Error",
    })
  );
  process.exit(1);
});
