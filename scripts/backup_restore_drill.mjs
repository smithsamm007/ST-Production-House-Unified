#!/usr/bin/env node
/**
 * ST Production House — executable backup/restore drill (TASK-5.1, RUNBOOK §7).
 *
 * WHAT THIS PROVES, and what it does not:
 * - Proves, with real bytes and real PostgreSQL: a logical backup manifest
 *   built from the live schema digest-identically restores into a FRESH
 *   schema through the canonical migration sequence, and the fail-closed
 *   verification (every table's row count + order-independent digest, the
 *   schema_migrations history, and migration re-application as a no-op) holds.
 * - Does NOT contact providers, does NOT upload anywhere, does NOT touch the
 *   production/preview database: it creates two uniquely-named drill schemas
 *   in the addressed database and CASCADE-drops them when done.
 * - Does NOT pretend to be pg_dump: for production grading, schedule a native
 *   backup tool as well (docs/production/BACKUP_RESTORE_DRILL.md).
 *
 * Usage:
 *   DRILL_DATABASE_URL=postgresql://... node scripts/backup_restore_drill.mjs
 *   (falls back to POSTGRES_TEST_URL; refuses to run with neither)
 *
 * Exit 0 only on verdict PASS. Evidence is written to
 * artifacts/backup-restore-drill/report-<timestamp>.json (git-ignored).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runBackupRestoreDrill } from "../src/recovery/drillRunner.js";

const connectionString =
  process.env.DRILL_DATABASE_URL ||
  process.env.POSTGRES_TEST_URL ||
  "";

if (!connectionString) {
  console.error(
    JSON.stringify({
      code: "DRILL_NOT_RUN",
      reason: "No DRILL_DATABASE_URL or POSTGRES_TEST_URL configured; refusing to fabricate a drill result.",
    })
  );
  process.exit(1);
}

try {
  const report = await runBackupRestoreDrill(connectionString);
  const artifactDir = path.join(process.cwd(), "artifacts", "backup-restore-drill");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(
    artifactDir,
    `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  await writeFile(artifactPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({ ...report, evidenceFile: artifactPath }));
  process.exit(report.verdict === "PASS" ? 0 : 1);
} catch (error) {
  console.error(
    JSON.stringify({
      code: String(error.code || "BACKUP_RESTORE_DRILL_ERROR"),
      errorName: error.name || "Error",
      message: String(error.message || "").slice(0, 400),
    })
  );
  process.exit(1);
}
