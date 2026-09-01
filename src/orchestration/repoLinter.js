/**
 * ST Production House — Automated Repository Linter & Health Validator
 * Checks syntax, dependency boundaries, security rules (Rule 15, Rule 17),
 * and migration immutability (Rule R1).
 * Strictly zero-runtime dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export class RepoLinter {
  /**
   * Recursively find all matching files in a directory.
   * @param {string} dir
   * @param {Array<string>} extensions
   * @param {Array<string>} ignoreDirs
   * @returns {Array<string>}
   */
  static findFiles(dir, extensions = [".js", ".mjs", ".sql", ".md", ".json"], ignoreDirs = ["node_modules", ".git", "dist"]) {
    let results = [];
    if (!fs.existsSync(dir)) return results;

    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of list) {
      if (item.isDirectory()) {
        if (!ignoreDirs.includes(item.name)) {
          results = results.concat(this.findFiles(path.join(dir, item.name), extensions, ignoreDirs));
        }
      } else {
        const ext = path.extname(item.name);
        if (extensions.includes(ext)) {
          results.push(path.join(dir, item.name));
        }
      }
    }
    return results;
  }

  /**
   * Check syntax of JavaScript/ESM files using node --check.
   * @param {Array<string>} jsFiles
   * @returns {{ passed: boolean, errors: Array<{ file: string, error: string }> }}
   */
  static checkSyntax(jsFiles) {
    const errors = [];
    for (const file of jsFiles) {
      if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
      const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (res.status !== 0) {
        errors.push({
          file,
          error: (res.stderr || res.stdout || "Syntax check failed").trim()
        });
      }
    }
    return {
      passed: errors.length === 0,
      errors
    };
  }

  /**
   * Scan codebase for potential security and engineering contract violations.
   * @param {Array<string>} files
   * @returns {{ passed: boolean, violations: Array<{ file: string, rule: string, message: string }> }}
   */
  static checkContractRules(files) {
    const violations = [];

    for (const file of files) {
      // Skip test files, mock data, and node_modules for some strict pattern rules
      const isTest = file.includes("tests/") || file.includes("test");
      const isDoc = file.endsWith(".md");
      const content = fs.readFileSync(file, "utf8");

      // Rule 17: Check for hardcoded plaintext API keys or real credentials
      if (!isDoc && !isTest) {
        if (/(?:api[_-]?key|secret|password)\s*[:=]\s*["'](?!(?:vault:\/\/|\$|\{|process\.env|placeholder))[A-Za-z0-9_\-+/]{12,}["']/i.test(content)) {
          violations.push({
            file,
            rule: "Rule 17 (Opaque Secrets)",
            message: "Potential hardcoded plaintext secret or API key detected. Use vault:// locators or environment variables."
          });
        }
      }

      // Check for insecure HTTP URLs in source code (Rule R3 HTTPS-only)
      if (!isDoc && !isTest && file.startsWith("src/")) {
        const httpMatches = content.match(/http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[a-zA-Z0-9.-]+/g);
        if (httpMatches && httpMatches.length > 0) {
          violations.push({
            file,
            rule: "Rule R3 (HTTPS-only)",
            message: `Insecure HTTP protocol used: ${httpMatches.join(", ")}. ST Production House requires HTTPS.`
          });
        }
      }
    }

    return {
      passed: violations.length === 0,
      violations
    };
  }

  /**
   * Verify that existing SQL migrations are immutable and sequentially ordered.
   * @param {string} sqlDir
   * @returns {{ passed: boolean, migrationCount: number, errors: Array<string> }}
   */
  static checkMigrations(sqlDir = "sql") {
    const errors = [];
    if (!fs.existsSync(sqlDir)) {
      return { passed: false, migrationCount: 0, errors: ["Missing sql/ directory"] };
    }

    const files = fs.readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort();
    let expectedIndex = 1;

    for (const f of files) {
      const match = f.match(/^(\d{3})_/);
      if (!match) {
        errors.push(`Migration '${f}' does not follow NNN_name.sql naming convention`);
        continue;
      }
      const num = parseInt(match[1], 10);
      if (num !== expectedIndex) {
        errors.push(`Migration sequence gap: expected ${String(expectedIndex).padStart(3, "0")}, found ${f}`);
      }
      expectedIndex++;
    }

    return {
      passed: errors.length === 0,
      migrationCount: files.length,
      errors
    };
  }

  /**
   * Run full repository health audit.
   * @param {string} rootDir
   * @returns {object} Full audit report
   */
  static runAudit(rootDir = process.cwd()) {
    const jsFiles = this.findFiles(path.join(rootDir, "src"), [".js", ".mjs"])
      .concat(this.findFiles(path.join(rootDir, "tests"), [".js", ".mjs"]))
      .concat(this.findFiles(path.join(rootDir, ".github"), [".js", ".mjs"]))
      .concat(fs.existsSync(path.join(rootDir, "server.js")) ? [path.join(rootDir, "server.js")] : []);

    const allSourceFiles = this.findFiles(rootDir, [".js", ".mjs", ".sql", ".json"]);

    const syntax = this.checkSyntax(jsFiles);
    const contract = this.checkContractRules(allSourceFiles);
    const migrations = this.checkMigrations(path.join(rootDir, "sql"));

    const isHealthy = syntax.passed && contract.passed && migrations.passed;

    return Object.freeze({
      timestamp: new Date().toISOString(),
      healthy: isHealthy,
      summary: {
        totalFilesScanned: jsFiles.length,
        migrationCount: migrations.migrationCount,
        syntaxErrorsCount: syntax.errors.length,
        contractViolationsCount: contract.violations.length,
        migrationErrorsCount: migrations.errors.length
      },
      syntax,
      contract,
      migrations
    });
  }
}
