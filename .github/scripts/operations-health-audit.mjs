/**
 * ST Production House — Scheduled operations health audit (S-M28-01).
 *
 * Loads the validated health manifest, derives which required EXTERNAL
 * secrets are actually configured in the environment, and classifies every
 * autonomous workflow as RUNNABLE or PAUSED. Emits:
 *
 *   - a truthful step summary on the GitHub Actions run
 *   - automation/operations/health-report.json as a workflow artifact
 *
 * No fake green: a missing credential is reported as PAUSED with the exact
 * missing secret NAMES; the script never reads, prints, or serializes secret
 * values, and exits non-zero only on manifest/environment corruption — not
 * on PAUSED findings (paused is a truthful state, not a failure of the audit).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  validateHealthManifest,
  deriveConfiguredSecrets,
  buildHealthReport,
} from "../../src/operations/healthManifest.js";

const MANIFEST_PATH = "automation/operations/health-manifest.json";
const REPORT_PATH = "automation/operations/health-report.json";

async function main() {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    console.error(JSON.stringify({ code: "HEALTH_MANIFEST_PARSE_FAILED", message: String(error?.message ?? error) }));
    process.exit(1);
  }

  validateHealthManifest(manifest);

  const configuredSecrets = deriveConfiguredSecrets(manifest, process.env);
  const report = buildHealthReport(manifest, configuredSecrets, {
    generatedAt: new Date().toISOString(),
    environment: process.env.HEALTH_AUDIT_ENVIRONMENT ?? "github-actions-scheduled",
  });

  await mkdir("automation/operations", { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const lines = [
    "## Operations Health Audit (truthful, no fake green)",
    "",
    `Environment: \`${report.environment}\``,
    `Generated: ${report.generatedAt}`,
    `Summary: ${report.summary.runnable}/${report.summary.total} RUNNABLE, ${report.summary.paused} PAUSED`,
    "",
    "| Workflow | Status | Missing credentials |",
    "|---|---|---|",
  ];
  for (const entry of report.workflows) {
    const missing = entry.missingSecrets.length > 0 ? entry.missingSecrets.join(", ") : "—";
    lines.push(`| ${entry.workflowId} | ${entry.status} | ${missing} |`);
  }
  lines.push(
    "",
    "PAUSED workflows are not failures of this audit; they are truthful reports that",
    "required external credentials are not configured. No workflow availability is",
    "fabricated (AGENTS.md Rules 1-3)."
  );
  const summary = lines.join("\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }
  console.log(summary);

  // Machine-readable verdict for the workflow step (never a fabricated ok).
  console.log(
    JSON.stringify({
      code: "OPERATIONS_HEALTH_REPORTED",
      runnable: report.summary.runnable,
      paused: report.summary.paused,
      criticalPaused: report.workflows.filter((w) => w.critical && w.status === "PAUSED").map((w) => w.workflowId),
    })
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ code: "OPERATIONS_HEALTH_AUDIT_FAILED", message: String(error?.message ?? error) }));
  process.exit(1);
});
