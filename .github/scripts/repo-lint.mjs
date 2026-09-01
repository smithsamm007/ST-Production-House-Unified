#!/usr/bin/env node
import fs from "node:fs";
import { RepoLinter } from "../../src/orchestration/repoLinter.js";

const audit = RepoLinter.runAudit(process.cwd());

console.log("=== ST Production House Repository Health Audit ===");
console.log(`Scanned: ${audit.summary.totalFilesScanned} JS/ESM files, ${audit.summary.migrationCount} SQL migrations`);
console.log(`Status: ${audit.healthy ? "PASSED (HEALTHY)" : "FAILED (ISSUES FOUND)"}\n`);

if (!audit.syntax.passed) {
  console.error("Syntax Errors:");
  audit.syntax.errors.forEach((e) => console.error(`  - ${e.file}: ${e.error}`));
}

if (!audit.contract.passed) {
  console.error("Engineering Contract Violations:");
  audit.contract.violations.forEach((v) => console.error(`  - [${v.rule}] ${v.file}: ${v.message}`));
}

if (!audit.migrations.passed) {
  console.error("Migration Sequence Errors:");
  audit.migrations.errors.forEach((e) => console.error(`  - ${e}`));
}

// Generate GitHub Step Summary if running in GitHub Actions
if (process.env.GITHUB_STEP_SUMMARY) {
  const summaryMd = `
### 🛡️ Repository Health & Lint Summary

| Metric | Result | Status |
|---|---|---|
| **Syntax & Compilation** | ${audit.syntax.passed ? "0 errors" : `${audit.syntax.errors.length} errors`} | ${audit.syntax.passed ? "✅ PASS" : "❌ FAIL"} |
| **Contract & Security Rules** | ${audit.contract.passed ? "0 violations" : `${audit.contract.violations.length} violations`} | ${audit.contract.passed ? "✅ PASS" : "❌ FAIL"} |
| **SQL Migration Integrity** | ${audit.migrations.migrationCount} sequential migrations | ${audit.migrations.passed ? "✅ PASS" : "❌ FAIL"} |
| **Total Scanned Files** | ${audit.summary.totalFilesScanned} files | ℹ️ OK |

${!audit.healthy ? `
> ⚠️ **Failures Detected:**
${audit.syntax.errors.map((e) => `- Syntax: \`${e.file}\`: ${e.error}`).join("\n")}
${audit.contract.violations.map((v) => `- Security/Contract: \`${v.file}\` (${v.rule}): ${v.message}`).join("\n")}
${audit.migrations.errors.map((e) => `- Migration: ${e}`).join("\n")}
` : "> ✅ **All repository linting, syntax, and security invariants passed.**"}
`;

  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd);
}

if (!audit.healthy) {
  process.exit(1);
} else {
  console.log("All linting and health checks passed successfully.");
  process.exit(0);
}
