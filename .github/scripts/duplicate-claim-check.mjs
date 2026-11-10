#!/usr/bin/env node
/**
 * ST Production House — duplicate-claim guard for the merge path.
 *
 * AGENTS.md amendment 3 allows one pull request in flight at a time, and R6
 * requires every pull request to carry `Closes #<issue>`. When two open pull
 * requests claim the same issue they are competing implementations of one
 * deliverable, so merging either one strands the other. This guard fails closed
 * instead of guessing which one is canonical.
 *
 * It never closes, edits or merges anything: it only refuses to continue.
 *
 * Exit codes:
 *   0 — the claim is unique (AUTONOMOUS_MERGE_CLAIM_UNIQUE)
 *   1 — another open pull request claims the same issue
 *       (AUTONOMOUS_MERGE_DUPLICATE_CLAIM)
 *   2 — usage error, unreadable input, or the pull request is not in the list
 *       (AUTONOMOUS_MERGE_CLAIM_UNKNOWN)
 *
 * Usage: duplicate-claim-check.mjs <open-pull-requests.json> <pull-request-number>
 *   open-pull-requests.json is the output of:
 *   gh pr list --state open --limit 100 --json number,body
 */

import fs from 'node:fs';
import { findDuplicateClaimants } from './merge-eligibility.mjs';

const [openPath, numberArg] = process.argv.slice(2);

if (!openPath || !numberArg) {
  console.error('usage: duplicate-claim-check.mjs <open-pull-requests.json> <pull-request-number>');
  process.exit(2);
}

let openPullRequests;
try {
  openPullRequests = JSON.parse(fs.readFileSync(openPath, 'utf8'));
} catch (error) {
  console.error(`AUTONOMOUS_MERGE_CLAIM_UNKNOWN pr=${numberArg} reason=${error.message}`);
  process.exit(2);
}

const number = Number(numberArg);
const pullRequest = (Array.isArray(openPullRequests) ? openPullRequests : []).find(
  (candidate) => candidate && candidate.number === number
);

if (!pullRequest) {
  console.error(
    `AUTONOMOUS_MERGE_CLAIM_UNKNOWN pr=${numberArg} — the pull request is not in the open-pull-request list.`
  );
  process.exit(2);
}

const duplicates = findDuplicateClaimants({ pullRequest, openPullRequests });

if (duplicates.length > 0) {
  console.error(
    `::error::AUTONOMOUS_MERGE_DUPLICATE_CLAIM pr=${number} competitors=${duplicates.join(',')} — ` +
      `only one open pull request may claim an issue. The owner must choose the canonical one; ` +
      `this guard will not close or merge either.`
  );
  process.exit(1);
}

console.log(`AUTONOMOUS_MERGE_CLAIM_UNIQUE pr=${number}`);
