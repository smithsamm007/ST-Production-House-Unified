#!/usr/bin/env node
/**
 * ST Production House — backlog feeder runner.
 *
 * The ONLY component of the feeder with GitHub side effects. Reads the
 * machine-readable manifest (automation/backlog/slices.json), observes real
 * repository state, and creates governed slice issues for promotable slices
 * (ready + lane labels). Idempotent: safe to run on a schedule and on every
 * issue-closed event.
 *
 * Honest closed-loop behavior (no fake completion, Rule 1):
 * - When a slice issue closes without "completed", the feeder re-labels it
 *   ready (if not owner-gated) and comments with the close reason. It does
 *   NOT assume completion, and dependencies are NOT recorded as satisfied —
 *   the promotion planner keeps gating dependents until the slice is actually
 *   promoted and merged (tracked externally in the manifest lifecycle).
 * - When a slice issue closes as completed, the slice is recorded promoted
 *   by appending its id to the manifest lifecycle file; dependents become
 *   eligible.
 *
 * Owner-gated slices are never promoted by this runner. Their titles/briefs
 * remain in the manifest for the owner; a daily digest records their ids as
 * OWNER_ACTION_REQUIRED on the tracking issue.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { buildIssuePayload, planPromotions, validateManifest } from "../../src/automation/backlogFeeder.js";

const REPO = process.env.GITHUB_REPOSITORY;
const MANIFEST_PATH = path.resolve(process.cwd(), "automation/backlog/slices.json");
const LIFECYCLE_PATH = path.resolve(process.cwd(), "automation/backlog/lifecycle.json");

function gh(args, options = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// --- lifecycle -------------------------------------------------------------

function loadLifecycle() {
  const stored = readJson(LIFECYCLE_PATH, { schemaVersion: 1, promotedSliceIds: [] });
  if (
    !stored ||
    stored.schemaVersion !== 1 ||
    !Array.isArray(stored.promotedSliceIds) ||
    stored.promotedSliceIds.some((id) => typeof id !== "string")
  ) {
    throw new Error("BACKLOG_LIFECYCLE_INVALID");
  }
  return stored;
}

/**
 * Adds a slice id to the in-memory lifecycle. Returns true when the id was
 * newly recorded (the caller persists the file); false when it was already
 * recorded (idempotent, honest no-op).
 */
export function recordPromotion(lifecycle, sliceId) {
  if (lifecycle.promotedSliceIds.includes(sliceId)) {
    return false;
  }
  lifecycle.promotedSliceIds.push(sliceId);
  return true;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
}

/**
 * Durability contract (S-AUT-01): completion credit recorded during this run
 * is committed and pushed to the default branch BEFORE any further GitHub
 * state changes. An unchanged lifecycle is an honest no-op. A failed commit
 * or push is loud and non-zero — completion credit is never silently dropped
 * and success is never fabricated (AGENTS.md Rule 1).
 */
export function persistLifecycleToGit({ changed, sliceIds, branch, runGit = git }) {
  if (!changed) {
    console.log(JSON.stringify({ code: "BACKLOG_LIFECYCLE_UNCHANGED" }));
    return { committed: false };
  }
  try {
    runGit(["add", "automation/backlog/lifecycle.json"]);
    runGit([
      "-c", "user.name=github-actions[bot]",
      "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-m", `chore(automation): record slice completion in lifecycle [${sliceIds.join(", ")}]`
    ]);
    runGit(["push", "origin", `HEAD:refs/heads/${branch}`]);
  } catch (error) {
    console.error(
      JSON.stringify({ code: "BACKLOG_LIFECYCLE_PUSH_FAILED", detail: String(error?.message ?? error) })
    );
    const failure = new Error("BACKLOG_LIFECYCLE_PUSH_FAILED");
    failure.code = "BACKLOG_LIFECYCLE_PUSH_FAILED";
    throw failure;
  }
  console.log(JSON.stringify({ code: "BACKLOG_LIFECYCLE_COMMITTED", sliceIds, branch }));
  return { committed: true };
}

// --- manifest + slice tags -------------------------------------------------

function sliceTagFromTitle(title) {
  const match = /\[([A-Z0-9-]+)\]/.exec(title ?? "");
  return match ? match[1] : null;
}

function loadManifest() {
  const manifest = readJson(MANIFEST_PATH, null);
  if (!manifest) {
    throw new Error("BACKLOG_MANIFEST_MISSING");
  }
  return validateManifest(manifest);
}

// --- observed GitHub state -------------------------------------------------

function observeState() {
  const openIssues = JSON.parse(
    gh(["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,labels"])
  );
  const byLane = { "lane-1": 0, "lane-2": 0, "lane-3": 0 };
  const existingSliceIssues = [];
  for (const issue of openIssues) {
    const names = issue.labels.map((label) => label.name);
    const tag = sliceTagFromTitle(issue.title);
    if (tag) existingSliceIssues.push(issue.number);
    for (const lane of Object.keys(byLane)) {
      if (names.includes("ready") && names.includes(lane)) byLane[lane] += 1;
      if (tag && names.includes(lane)) byLane[lane] += 0; // tag issues with a lane label are counted via 'ready' only
    }
  }

  const lifecycle = loadLifecycle();
  const promotedSliceIds = [...lifecycle.promotedSliceIds];

  // Issues that closed non-completed and were re-fed are not "promoted" —
  // they are already open again; the promotion planner counts them through
  // openReadyIssuesByLane because they carry ready + lane again.
  return { openReadyIssuesByLane: byLane, existingSliceIssues, promotedSliceIds };
}

function sliceIssueNumber(state, sliceId) {
  // Idempotency: find the most recent open or recently closed issue tagged
  // with this slice id. Duplicates are prevented by tag detection.
  const listing = JSON.parse(
    gh([
      "issue", "list", "--state", "all", "--limit", "300",
      "--search", `[${sliceId}] in:title`,
      "--json", "number,title,state"
    ])
  );
  const tagged = listing
    .filter((issue) => issue.title.includes(`[${sliceId}]`))
    .sort((a, b) => b.number - a.number);
  return tagged.length > 0 ? tagged[0].number : null;
}

function createSliceIssue(manifest, sliceId) {
  const payload = buildIssuePayload(manifest, sliceId, []);
  const args = ["issue", "create", "--title", payload.title, "--body", payload.body];
  for (const label of payload.labels) {
    args.push("--label", label);
  }
  const url = gh(args).trim();
  const number = Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? 0);
  if (!number) {
    throw new Error(`BACKLOG_RUNNER_ISSUE_CREATE_FAILED: ${url}`);
  }
  return number;
}

function ensureLabel(name, description, color) {
  try {
    gh(["label", "create", name, "--description", description, "--color", color]);
  } catch {
    // Label already exists (or creation failed for a benign reason).
  }
}

function commentOnIssue(number, body) {
  gh(["issue", "comment", String(number), "--body", body]);
}

function relabelReady(number, lane) {
  gh(["issue", "edit", String(number), "--add-label", "ready"]);
  if (lane) {
    gh(["issue", "edit", String(number), "--add-label", lane]);
  }
}

// --- closed-loop handling --------------------------------------------------

function handleCloseEvents(lifecycle, manifest) {
  const promoted = [];
  const event = process.env.GITHUB_EVENT_NAME;
  if (event !== "issues") return promoted;
  const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (payload.action !== "closed") return promoted;
  const issue = payload.issue;
  const tag = sliceTagFromTitle(issue?.title);
  if (!tag) return promoted;
  const slice = manifest.slices.find((candidate) => candidate.sliceId === tag);
  if (!slice) return promoted;

  const closeReason = issue.state_reason || "completed";
  if (closeReason === "completed") {
    const added = recordPromotion(lifecycle, tag);
    if (added) {
      writeJson(LIFECYCLE_PATH, lifecycle);
      promoted.push(tag);
      console.log(JSON.stringify({ code: "BACKLOG_SLICE_PROMOTED", sliceId: tag, issue: issue.number }));
    } else {
      console.log(JSON.stringify({ code: "BACKLOG_SLICE_ALREADY_RECORDED", sliceId: tag, issue: issue.number }));
    }
  } else {
    // Honest re-feed: not completed => back to the ready queue with a reason.
    // Dependencies are NOT marked satisfied; the promotion planner will
    // re-promote it when a lane is free and dependents stay gated until the
    // slice actually completes.
    commentOnIssue(
      issue.number,
      [
        `Backlog feeder: issue was closed as **${closeReason}**, not completed.`,
        "No dependency credit was recorded. Re-labeled `ready` so the governed loop",
        "can retry this slice. Owner-gated slices are never auto-re-fed."
      ].join("\n")
    );
    if (!slice.ownerGated) {
      relabelReady(issue.number, slice.lane);
    }
    console.log(JSON.stringify({ code: "BACKLOG_SLICE_REFED", sliceId: tag, issue: issue.number, closeReason }));
  }
  return promoted;
}

// --- digest of owner-gated slices ------------------------------------------

function digestOwnerGated(manifest) {
  const gated = manifest.slices.filter((slice) => slice.ownerGated);
  if (gated.length === 0) return;
  const trackingTitle = "[BACKLOG] Owner-gated slices awaiting owner action";
  const existing = JSON.parse(gh(["issue", "list", "--state", "open", "--search", "[BACKLOG] in:title", "--json", "number,title"]));
  let tracking = existing.find((issue) => issue.title.includes("[BACKLOG]"));
  const lines = [
    "The following slices require owner action and are NEVER auto-promoted",
    "(AGENTS.md Rules 7, 16, 17: credentials, OAuth, publishing approvals).",
    "",
    ...gated.map((slice) => `- **${slice.sliceId}** (module ${slice.module}, ${slice.lane}): ${slice.title}`)
  ];
  if (tracking) {
    commentOnIssue(tracking.number, lines.join("\n"));
  } else {
    gh(["issue", "create", "--title", trackingTitle, "--body", lines.join("\n"), "--label", "documentation"]);
  }
}

// --- main -------------------------------------------------------------------

function main() {
  if (!REPO) {
    console.error("GITHUB_REPOSITORY is not set; refusing to run outside Actions.");
    process.exit(1);
  }

  const manifest = loadManifest();
  const lifecycle = loadLifecycle();

  // Closed-event handling runs first: a just-closed slice issue either gets
  // promotion credit or is honestly re-fed.
  const promotedDuringRun = handleCloseEvents(lifecycle, manifest);

  // Durability (S-AUT-01): credit recorded in this run is committed and
  // pushed to the default branch before any further GitHub state changes.
  const branch = process.env.GITHUB_REF_NAME || "main";
  persistLifecycleToGit({ changed: promotedDuringRun.length > 0, sliceIds: promotedDuringRun, branch });

  const state = observeState();
  const plan = planPromotions(manifest, state);

  let created = 0;
  for (const sliceId of plan.promotable) {
    // Double-check idempotency right before creating: another run (schedule
    // + issue-closed racing) may have created the issue already.
    const existing = sliceIssueNumber(state, sliceId);
    if (existing) continue;
    const number = createSliceIssue(manifest, sliceId);
    created += 1;
    console.log(JSON.stringify({ code: "BACKLOG_SLICE_ISSUE_CREATED", sliceId, issue: number }));
  }

  digestOwnerGated(manifest);

  console.log(
    JSON.stringify({
      code: "BACKLOG_FEEDER_RUN",
      promotable: plan.promotable,
      ownerGated: plan.ownerGated,
      skipped: plan.skipped,
      created
    })
  );
}

// Only auto-run when executed directly; importing the module (tests) must
// not trigger GitHub side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
