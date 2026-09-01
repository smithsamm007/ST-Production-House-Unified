import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RepoLinter } from "../src/orchestration/repoLinter.js";

test("RepoLinter: finds files matching extensions and ignores node_modules", () => {
  const files = RepoLinter.findFiles(process.cwd(), [".mjs", ".js"]);
  assert.ok(files.length > 0);
  assert.ok(files.every((f) => !f.includes("node_modules")));
});

test("RepoLinter: validates syntax of clean JS files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-test-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
  const validFile = path.join(tmpDir, "valid.js");
  const invalidFile = path.join(tmpDir, "invalid.js");

  fs.writeFileSync(validFile, "export const x = 42;\n");
  fs.writeFileSync(invalidFile, "export const x = ;\n"); // Syntax error

  const resultValid = RepoLinter.checkSyntax([validFile]);
  assert.equal(resultValid.passed, true);
  assert.equal(resultValid.errors.length, 0);

  const resultInvalid = RepoLinter.checkSyntax([invalidFile]);
  assert.equal(resultInvalid.passed, false);
  assert.equal(resultInvalid.errors.length, 1);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("RepoLinter: enforces Rule 17 by detecting potential hardcoded plaintext secrets", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-sec-"));
  const cleanFile = path.join(tmpDir, "clean.js");
  const dirtyFile = path.join(tmpDir, "dirty.js");

  fs.writeFileSync(cleanFile, "export const key = 'vault://secret/prod/key';\n");
  fs.writeFileSync(dirtyFile, "export const api_key = 'sk_live_1234567890abcdef1234';\n");

  const checkClean = RepoLinter.checkContractRules([cleanFile]);
  assert.equal(checkClean.passed, true);

  const checkDirty = RepoLinter.checkContractRules([dirtyFile]);
  assert.equal(checkDirty.passed, false);
  assert.equal(checkDirty.violations.length, 1);
  assert.ok(checkDirty.violations[0].rule.includes("Rule 17"));

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("RepoLinter: checks sequential SQL migrations", () => {
  const result = RepoLinter.checkMigrations("sql");
  assert.equal(result.passed, true);
  assert.ok(result.migrationCount >= 16);
});

test("RepoLinter: runs full audit on the repository and returns healthy", () => {
  const audit = RepoLinter.runAudit(process.cwd());
  assert.equal(audit.healthy, true);
  assert.equal(audit.syntax.passed, true);
  assert.equal(audit.contract.passed, true);
  assert.equal(audit.migrations.passed, true);
});
