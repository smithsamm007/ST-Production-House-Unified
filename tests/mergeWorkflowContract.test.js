import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  closingIssueNumbers,
  evaluateMergeEligibility,
  findDuplicateClaimants
} from '../.github/scripts/merge-eligibility.mjs';

const root = process.cwd();
const workflowDir = path.join(root, '.github', 'workflows');

function workflow(name) {
  return fs.readFileSync(path.join(workflowDir, name), 'utf8');
}

function workflowNames() {
  return fs
    .readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

test('every workflow that merges a pull request declares contents: write', () => {
  const merging = workflowNames().filter((name) => workflow(name).includes('gh pr merge'));

  assert.ok(merging.length > 0, 'expected at least one merging workflow');

  for (const name of merging) {
    assert.match(
      workflow(name),
      /^ {2}contents: write$/m,
      `${name} calls gh pr merge but does not declare contents: write; ` +
        'an omitted scope in a permissions block is none, so the merge would 403'
    );
  }
});

test('every workflow that arms or merges declares pull-requests: write', () => {
  for (const name of workflowNames()) {
    const text = workflow(name);
    if (!text.includes('gh pr merge')) continue;
    assert.match(
      text,
      /^ {2}pull-requests: write$/m,
      `${name} manipulates a pull request but does not declare pull-requests: write`
    );
  }
});

test('the merge referee never promotes a draft or hides a failed merge request', () => {
  const text = workflow('autonomous-merge.yml');

  assert.doesNotMatch(text, /gh pr ready/, 'drafts must be rejected, never silently promoted');
  assert.doesNotMatch(
    text,
    /gh pr merge[\s\S]{0,400}?\|\|\s*\n?\s*echo/,
    'a failed merge request must not be converted into a success notice'
  );
  assert.match(text, /AUTONOMOUS_MERGE_ARM_FAILED/, 'arm failures need a stable error code');
  assert.match(text, /AUTONOMOUS_MERGE_NOT_ARMED/, 'an unarmed merge must fail loudly');
  assert.match(text, /AUTONOMOUS_MERGE_HEAD_MOVED/, 'a moved head must fail the referee');
});

test('the merge referee pins the merge request to a re-read head', () => {
  const text = workflow('autonomous-merge.yml');

  assert.match(
    text,
    /pulls\/\$PR_NUMBER" --jq '\.head\.sha'/,
    'the live head must be re-read from the API'
  );
  assert.match(text, /--match-head-commit "\$HEAD"/, 'the merge must be pinned to the re-read head');
});

test('the exact-head controller confirms the merge from GitHub state and merge commit', () => {
  const text = workflow('exact-head-merge.yml');

  assert.match(text, /--match-head-commit "\$EXPECTED_HEAD"/);
  assert.match(text, /\.merge_commit_sha/);
  assert.match(text, /MERGE_VERIFIED/);
  assert.match(text, /MERGE_NOT_CONFIRMED/);
  assert.match(text, /MERGE_REQUEST_FAILED/);
});

test('the controller names its main-baseline recovery path instead of failing silently', () => {
  const text = workflow('exact-head-merge.yml');

  assert.match(text, /MAIN_BASELINE_MISSING/);
  assert.match(text, /MAIN_BASELINE_RED/);
});

test('neither merge path deletes the head branch', () => {
  for (const name of ['autonomous-merge.yml', 'exact-head-merge.yml']) {
    assert.doesNotMatch(
      workflow(name),
      /--delete-branch/,
      `${name} must leave branch cleanup to the owner`
    );
  }
});

test('both merge paths consult the duplicate-claim guard', () => {
  for (const name of ['autonomous-merge.yml', 'exact-head-merge.yml']) {
    assert.match(workflow(name), /duplicate-claim-check\.mjs/, `${name} must refuse duplicate claims`);
  }

  const guard = fs.readFileSync(path.join(root, '.github', 'scripts', 'duplicate-claim-check.mjs'), 'utf8');
  assert.match(guard, /AUTONOMOUS_MERGE_DUPLICATE_CLAIM/);
  assert.match(guard, /AUTONOMOUS_MERGE_CLAIM_UNIQUE/);
});

test('the eligibility controller prints a stable machine-readable verdict', () => {
  const text = fs.readFileSync(path.join(root, '.github', 'scripts', 'merge-controller.mjs'), 'utf8');
  assert.match(text, /MERGE_ELIGIBILITY eligible=/);
});

test('closing keywords are parsed, never inferred', () => {
  assert.deepEqual(closingIssueNumbers('Closes #263'), [263]);
  assert.deepEqual(closingIssueNumbers('closes #12 and fixes #7'), [7, 12]);
  assert.deepEqual(closingIssueNumbers('Closes #263\nCloses #263'), [263]);
  assert.deepEqual(closingIssueNumbers('see #263 for context'), []);
  assert.deepEqual(closingIssueNumbers(undefined), []);
});

test('two open pull requests claiming one issue are duplicates', () => {
  const pullRequest = { number: 266, body: 'Closes #263' };
  const openPullRequests = [
    pullRequest,
    { number: 265, body: 'Closes #263' },
    { number: 267, body: 'Closes #262' },
    { number: 268, body: 'No issue reference' }
  ];

  assert.deepEqual(findDuplicateClaimants({ pullRequest, openPullRequests }), [265]);
  assert.deepEqual(findDuplicateClaimants({ pullRequest, openPullRequests: [pullRequest] }), []);
});

test('eligibility refuses a merge while a duplicate claim exists', () => {
  const head = 'a'.repeat(40);
  const pullRequest = {
    number: 266,
    state: 'open',
    draft: false,
    mergeable: true,
    base: { ref: 'main' },
    head: { sha: head },
    body: 'Closes #263'
  };
  const workflowRuns = ['ST Production House CI', 'PR Gate', 'Autonomous Merge Referee'].map((name) => ({
    name,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
    updated_at: '2026-01-01T00:00:00Z'
  }));

  const alone = evaluateMergeEligibility({ pullRequest, expectedHeadSha: head, workflowRuns, openPullRequests: [pullRequest] });
  assert.deepEqual(alone, { eligible: true, reasons: [] });

  const contested = evaluateMergeEligibility({
    pullRequest,
    expectedHeadSha: head,
    workflowRuns,
    openPullRequests: [pullRequest, { number: 265, body: 'Closes #263' }]
  });
  assert.equal(contested.eligible, false);
  assert.deepEqual(contested.reasons, ['duplicate_claim:265']);
});
