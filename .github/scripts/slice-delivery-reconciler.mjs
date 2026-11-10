#!/usr/bin/env node
/**
 * ST Production House — slice delivery reconciler runner.
 *
 * The ONLY component of slice delivery with GitHub side effects. It observes
 * real repository state (open issues, open pull requests, remote task
 * branches, exact-head CI runs), asks the pure planner
 * (src/automation/sliceDelivery.js) what to do, then performs at most one
 * action set per run:
 *
 *   OPEN_PULL_REQUEST  -> open the one canonical pull request for that slice
 *                         and dispatch CI + PR Gate + Merge Referee on its
 *                         exact head, so the existing governed merge path
 *                         takes over (nothing is merged here).
 *
 * Everything else (owner-gated slices, competing branches, competing pull
 * requests, the one-PR rule) is reported and left untouched. This runner
 * never closes a branch, never merges, never force-pushes, and never claims a
 * slice is complete: completion is recorded by the issue-closed path of the
 * backlog feeder only.
 *
 * Usage: node .github/scripts/slice-delivery-reconciler.mjs [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { validateManifest } from "../../src/automation/backlogFeeder.js";
import {
  SLICE_DELIVERY_ACTIONS,
  mapSliceToIssue,
  planSliceDelivery,
  summarizeDelivery
} from "../../src/automation/sliceDelivery.js";

const REPO = process.env.GITHUB_REPOSITORY;
const BASE_BRANCH = "main";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";

const MANIFEST_PATH = path.resolve("automation/backlog/slices.json");
const LIFECYCLE_PATH = path.resolve("automation/backlog/lifecycle.json");
const REPORT_PATH = path.resolve("artifacts/automation/slice-delivery-report.json");
const BODY_PATH = path.resolve(".git", "slice-delivery-pr-body.md");

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  }).trim();
}

function gh(args) {
  return run("gh", args);
}

function ghJson(args) {
  const raw = gh(args);
  return raw.length === 0 ? null : JSON.parse(raw);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function log(entry) {
  console.log(JSON.stringify(entry));
}

function fail(code, detail) {
  console.error(JSON.stringify({ code, detail: detail === undefined ? undefined : String(detail) }));
  process.exit(1);
}

if (!REPO) {
  fail("SLICE_DELIVERY_REPOSITORY_MISSING", "GITHUB_REPOSITORY is not set");
}

// --- observation -----------------------------------------------------------

const manifest = readJson(MANIFEST_PATH, null);
if (!manifest) fail("SLICE_DELIVERY_MANIFEST_MISSING", MANIFEST_PATH);
try {
  validateManifest(manifest);
} catch (error) {
  fail("SLICE_DELIVERY_MANIFEST_INVALID", error?.code ?? error);
}

const lifecycle = readJson(LIFECYCLE_PATH, { schemaVersion: 1, promotedSliceIds: [] });
const promotedSliceIds = Array.isArray(lifecycle.promotedSliceIds) ? lifecycle.promotedSliceIds : [];

const issues = ghJson([
  "issue", "list", "--repo", REPO, "--state", "all", "--limit", "400",
  "--json", "number,title,state,labels"
]) ?? [];

const openPullRequests = ghJson([
  "pr", "list", "--repo", REPO, "--state", "open", "--limit", "200",
  "--json", "number,headRefName,headSha,isDraft,title"
]) ?? [];

const issuesBySlice = mapSliceToIssue(issues);

// Remote task branches without touching the working tree.
run("git", ["fetch", "--no-tags", "origin", `+refs/heads/*:refs/remotes/origin/*`]);
const remoteBranches = run("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
  .split("\n")
  .map((ref) => ref.replace(/^origin\//, ""))
  .filter((branch) => branch.length > 0);

function headShaOf(branch) {
  return run("git", ["rev-parse", `refs/remotes/origin/${branch}`]);
}

function commitsAheadOf(branch) {
  const count = run("git", ["rev-list", "--count", `refs/remotes/origin/${BASE_BRANCH}..refs/remotes/origin/${branch}`]);
  const parsed = Number.parseInt(count || "0", 10);
  return Number.isInteger(parsed) ? parsed : 0;
}

const verificationCache = new Map();
function hasVerificationEvidence(sha) {
  if (!verificationCache.has(sha)) {
    const response = ghJson(["api", `repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`]);
    const runs = response && Array.isArray(response.workflow_runs) ? response.workflow_runs : [];
    verificationCache.set(
      sha,
      runs.some((run) => run.name === "ST Production House CI" && run.conclusion === "success")
    );
  }
  return verificationCache.get(sha);
}

const candidatesBySlice = {};
const needsCandidates = new Set(
  manifest.slices
    .filter((slice) => !promotedSliceIds.includes(slice.sliceId) && slice.ownerGated !== true)
    .map((slice) => slice.sliceId)
);

for (const sliceId of needsCandidates) {
  const issue = issuesBySlice[sliceId];
  if (!issue) continue;
  const prefix = `task/${issue.number}-`;
  const branches = remoteBranches.filter((branch) => branch.startsWith(prefix)).sort();
  if (branches.length === 0) continue;
  candidatesBySlice[sliceId] = branches.map((branch) => {
    const headSha = headShaOf(branch);
    return {
      branch,
      headSha,
      aheadBy: commitsAheadOf(branch),
      verifiedHead: hasVerificationEvidence(headSha)
    };
  });
}

// --- planning --------------------------------------------------------------

const report = planSliceDelivery({
  slices: manifest.slices,
  promotedSliceIds,
  issues,
  openPullRequests,
  candidatesBySlice
});

const summary = summarizeDelivery(report);

// --- action ----------------------------------------------------------------

function conventionalTitleFor(action) {
  const subjects = run("git", [
    "log", "--reverse", "--format=%s",
    `refs/remotes/origin/${BASE_BRANCH}..refs/remotes/origin/${action.branch}`
  ]).split("\n").filter((line) => line.trim().length > 0);
  const first = subjects[0] ?? "";
  if (/^[a-z]+(\([^)]+\))?!?: .+/.test(first)) return first;
  const issue = issuesBySlice[action.sliceId];
  const clean = issue ? issue.title.replace(/\[(S-[A-Z0-9-]+)\]\s*/, "").trim() : action.sliceId;
  return `chore(automation): deliver ${action.sliceId} — ${clean}`;
}

function pullRequestBodyFor(action, title) {
  const duplicates = action.duplicateBranches.length > 0 ? action.duplicateBranches : "none";
  return [
    "## Summary",
    "",
    `Automated delivery of slice \`${action.sliceId}\` from candidate branch \`${action.branch}\`.`,
    "",
    `Closes #${action.issueNumber}`,
    "",
    "## Verification",
    "",
    "This body intentionally contains no pasted test output. The reconciler",
    "cannot run the suite before the pull request exists, and reporting results",
    "it has not observed would violate AGENTS.md Rule 1. The exact-head gates",
    `were dispatched for \`${action.headSha}\`: ST Production House CI, PR Gate,`,
    "and the Autonomous Merge Referee. Those runs are the authoritative",
    "evidence for this pull request, and it merges only if they pass.",
    "",
    "## Provenance",
    "",
    `- slice: \`${action.sliceId}\``,
    `- branch: \`${action.branch}\``,
    `- head: \`${action.headSha}\``,
    `- commits ahead of ${BASE_BRANCH}: ${action.aheadBy}`,
    `- prior exact-head CI evidence for this head: ${action.verificationEvidence ? "yes" : "no"}`,
    `- competing branches deliberately not merged: ${Array.isArray(duplicates) ? duplicates.join(", ") : duplicates}`,
    "",
    "Opened by `.github/workflows/slice-delivery.yml`."
  ].join("\n");
}

function openPullRequest(action) {
  const title = conventionalTitleFor(action);
  const body = pullRequestBodyFor(action, title);
  fs.writeFileSync(BODY_PATH, `${body}\n`, "utf8");

  gh([
    "pr", "create", "--repo", REPO,
    "--base", BASE_BRANCH,
    "--head", action.branch,
    "--title", title,
    "--body-file", BODY_PATH
  ]);

  const number = gh(["pr", "view", action.branch, "--repo", REPO, "--json", "number", "--jq", ".number"]);
  log({ code: "SLICE_DELIVERY_PULL_REQUEST_OPENED", sliceId: action.sliceId, branch: action.branch, pullRequest: Number(number) });

  // Hand the exact head to the existing governed gates; never merge here.
  for (const workflow of ["ci.yml", "pr-gate.yml", "autonomous-merge.yml"]) {
    gh([
      "workflow", "run", workflow, "--repo", REPO, "--ref", action.branch,
      "-f", `pr_number=${number}`,
      "-f", `expected_head=${action.headSha}`
    ]);
    log({ code: "SLICE_DELIVERY_GATE_DISPATCHED", workflow, pullRequest: Number(number), head: action.headSha });
  }
}

const performed = [];

if (DRY_RUN) {
  log({ code: "SLICE_DELIVERY_DRY_RUN", verdict: report.verdict, plannedActions: report.actions.length });
} else {
  for (const action of report.actions) {
    if (action.action !== SLICE_DELIVERY_ACTIONS.OPEN_PULL_REQUEST) continue;
    try {
      openPullRequest(action);
      performed.push({ sliceId: action.sliceId, action: action.action, branch: action.branch });
    } catch (error) {
      fail("SLICE_DELIVERY_ACTION_FAILED", `${action.sliceId}: ${error?.message ?? error}`);
    }
  }
}

// --- reporting -------------------------------------------------------------

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(
  REPORT_PATH,
  `${JSON.stringify({ ...report, summary, performed, dryRun: DRY_RUN }, null, 2)}\n`,
  "utf8"
);

for (const action of report.actions) {
  const entry = { code: `SLICE_DELIVERY_${action.action}`, sliceId: action.sliceId };
  if (action.branch) entry.branch = action.branch;
  if (action.candidateBranches) entry.candidateBranches = action.candidateBranches;
  if (action.pullRequests) entry.pullRequests = action.pullRequests.map((pullRequest) => pullRequest.number);
  if (action.reason) entry.reason = action.reason;
  log(entry);
}

log({
  code: "SLICE_DELIVERY_REPORT",
  verdict: report.verdict,
  automatableRemaining: report.automatableRemaining,
  ownerGatedRemaining: report.ownerGatedRemaining,
  governedPullRequestsInFlight: report.governedPullRequestsInFlight.length,
  nextAction: summary
});

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = report.actions
    .map((action) => {
      const detail = action.branch
        ? `\`${action.branch}\``
        : action.candidateBranches
          ? action.candidateBranches.map((branch) => `\`${branch}\``).join("<br>")
          : action.pullRequests
            ? action.pullRequests.map((pullRequest) => `#${pullRequest.number}`).join("<br>")
            : "";
      return `| \`${action.sliceId}\` | ${action.action} | ${detail} |`;
    })
    .join("\n");

  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "### Slice delivery reconciliation",
      "",
      `- Verdict: **${report.verdict}**`,
      `- Automatable slices remaining: **${report.automatableRemaining}**`,
      `- Owner-gated slices remaining: ${report.ownerGatedRemaining.length}${report.ownerGatedRemaining.length > 0 ? ` (${report.ownerGatedRemaining.join(", ")})` : ""}`,
      `- Governed pull requests in flight: ${report.governedPullRequestsInFlight.length}`,
      `- Next action: ${summary ?? "none — no automatable work remains"}`,
      `- Mode: ${DRY_RUN ? "dry run (no side effects)" : "live"}`,
      "",
      "| Slice | Action | Branch / PR |",
      "|---|---|---|",
      rows
    ].join("\n") + "\n"
  );
}
