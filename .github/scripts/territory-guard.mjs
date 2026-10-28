#!/usr/bin/env node
/**
 * ST Production House — repository-territory guard.
 *
 * Detects unexpected deletion of protected Node control-plane paths during
 * Android app synchronization. Introduced after commit 6161dd8 (the
 * AI-Studio sync that silently deleted the entire Node backend). See
 * docs/TERRITORY_GUARD.md and docs/audit/PHASE0_RECOVERY_DECISION.md.
 *
 * Exit codes:
 *   0 — territory respected (or all deletions explicitly approved)
 *   1 — protected paths were deleted without documented approval
 *   2 — usage error / git failure
 *
 * Pure decision logic is exported as evaluateTerritory() so tests cover it
 * without git. Deletions become legal only via
 * automation/territory/approved-deletions.json (documented, reviewed,
 * human-approved entries).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Root manifests and entrypoints that must always exist. */
const PROTECTED_ROOT_FILES = [
  "package.json",
  "package-lock.json",
  "server.js",
  "eslint.config.js",
];

/** Whole directories owned by the Node control plane. */
const PROTECTED_PREFIXES = ["src/", "tests/", "sql/", "automation/", "scripts/", "public/", "specs/"];
// Not protected: app/, gradle*, settings.gradle.kts, build.gradle.kts, docs/,
// README.md, .github/**, .env* (each side may change these as reviewed files).

function isProtected(path) {
  if (PROTECTED_ROOT_FILES.includes(path)) return true;
  return PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * @param {object} input
 * @param {string[]} input.deleted deletions (paths) observed base -> head
 * @param {Array<{path: string, reason: string, approvedBy: string, approvedOn: string}>} [input.approvals]
 *   documented, reviewed approvals. An entry is ignored unless all fields are
 *   non-empty strings, so a placeholder can never silently authorize a change.
 * @returns {{ok: boolean, unapproved: string[], approved: string[]}}
 */
export function evaluateTerritory({ deleted = [], approvals = [] } = {}) {
  const validApprovals = (Array.isArray(approvals) ? approvals : []).filter(
    (entry) =>
      entry &&
      typeof entry.path === "string" && entry.path.length > 0 &&
      typeof entry.reason === "string" && entry.reason.length > 0 &&
      typeof entry.approvedBy === "string" && entry.approvedBy.length > 0 &&
      typeof entry.approvedOn === "string" && entry.approvedOn.length > 0,
  );
  const approved = new Set(validApprovals.map((entry) => entry.path));

  const protectedDeleted = deleted.filter(isProtected);
  const unapproved = protectedDeleted.filter((path) => !approved.has(path));
  const approvedHits = protectedDeleted.filter((path) => approved.has(path));

  return { ok: unapproved.length === 0, unapproved, approved: approvedHits };
}

function nameStatusBase(baseRef, headRef) {
  try {
    const out = execFileSync("git", ["diff", "--name-status", `${baseRef}..${headRef}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").filter(Boolean);
  } catch (error) {
    fail(2, `territory-guard: could not read git diff ${baseRef}..${headRef}: ${error.message}`);
  }
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function cli(args) {
  if (args.length !== 3 || args[0] !== "--base") {
    fail(2, "usage: territory-guard.mjs --base <base-ref> <head-ref>");
  }
  const [baseRef, headRef] = [args[1], args[2]];
  const lines = nameStatusBase(baseRef, headRef);
  const deleted = lines.filter((line) => line.startsWith("D\t")).map((line) => line.split("\t")[1]);

  let approvals;
  try {
    approvals = JSON.parse(readApproved());
  } catch (error) {
    fail(2, `territory-guard: cannot parse automation/territory/approved-deletions.json: ${error.message}`);
  }

  const result = evaluateTerritory({ deleted, approvals });
  if (!result.ok) {
    fail(
      1,
      [
        "territory-guard: PROTECTED BACKEND PATHS DELETED WITHOUT APPROVAL",
        "",
        "The following Node control-plane files disappeared in this comparison. Symmetric",
        "Android app syncs must not delete backend territory (see docs/TERRITORY_GUARD.md).",
        "",
        ...result.unapproved.map((path) => `  - ${path}`),
        "",
        `Unapproved deletions: ${result.unapproved.length}`,
      ].join("\n"),
    );
  }
  console.log(
    `territory-guard: OK (deleted=${deleted.length}, protected=${result.approved.length ? "approved:" + result.approved.length : 0})`,
  );
}

function readApproved() {
  const path = new URL("../../automation/territory/approved-deletions.json", import.meta.url);
  return readFileSync(path, "utf8");
}

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("territory-guard.mjs")) {
  cli(process.argv.slice(2));
}
