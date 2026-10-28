import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('night shift exposes exactly three governed lanes and dispatches every exact-head gate', () => {
  const workflow = read('.github/workflows/night-shift.yml');
  assert.match(workflow, /lane: \[lane-1, lane-2, lane-3\]/);
  assert.match(workflow, /group: night-shift-\$\{\{ matrix\.lane \}\}/);
  assert.match(workflow, /workflow run ci\.yml/);
  assert.match(workflow, /workflow run pr-gate\.yml/);
  assert.match(workflow, /workflow run autonomous-merge\.yml/);
  assert.match(workflow, /expected_head="\$\(git rev-parse HEAD\)"/);
});

test('wake controller never bypasses owner-only gates and wakes only a free labeled lane', () => {
  const workflow = read('.github/workflows/awake-resume.yml');
  assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /JULES_KEY: \$\{\{ secrets\.JULES_API_KEY \}\}/);
  assert.match(workflow, /workflow run jules-command-files\.yml/);
  assert.match(workflow, /for lane in lane-1 lane-2 lane-3/);
  assert.match(workflow, /startsWith|startswith\(\"task\/\"\)/i);
  assert.match(workflow, /gh workflow run pr-gate\.yml/);
  for (const label of [
    'owner-action-required',
    'credentials-required',
    'oauth-required',
    'publishing-approval-required',
    'security-approval-required'
  ]) assert.match(workflow, new RegExp(label));
});

test('merge controller is globally serialized and re-verifies remaining autopilot PRs', () => {
  const workflow = read('.github/workflows/exact-head-merge.yml');
  assert.match(workflow, /group: exact-head-merge-global/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /Current main .* has not passed post-merge CI/);
  assert.match(workflow, /gh workflow run ci\.yml[^\n]*--ref main/);

  const reverify = read('.github/workflows/post-merge-reverify.yml');
  assert.match(reverify, /head_branch == 'main'/);
  assert.match(reverify, /conclusion == 'success'/);
  assert.match(reverify, /gh pr list[^\n]*--label autopilot/);
  assert.match(reverify, /workflow run autonomous-merge\.yml/);
});

test('issue #92: wake controller observes gate activity BEFORE any merge refresh', () => {
  const workflow = read('.github/workflows/awake-resume.yml');
  const observeIndex = workflow.indexOf('active="$(gh run list --commit "$head"');
  const passedIndex = workflow.indexOf('passed="$(gh run list --commit "$head"');
  const refreshIndex = workflow.indexOf('repos/$GITHUB_REPOSITORY/merges"');
  assert.ok(observeIndex !== -1, 'active-run observation exists');
  assert.ok(passedIndex > observeIndex, 'gate-pass check follows the active-run observation');
  assert.ok(refreshIndex > passedIndex, 'merge refresh happens only after both head checks');
  assert.match(workflow, /no reconciliation while verification is in flight/);
  assert.match(workflow, /conflicts with main and requires correction in its existing lane/);
});

test('issue #90: night-shift recovery never re-queues an issue that already has a PR', () => {
  const workflow = read('.github/workflows/night-shift.yml');
  assert.match(workflow, /Return failed issue to a recoverable queue \(only when no PR exists\)/);
  assert.match(workflow, /gh pr list --state open --search "Closes #\$number"/);
  assert.match(workflow, /already has an open autonomous PR; it stays in-progress/);
});

test('issue #90: autodev verifies before publishing and attaches real evidence', () => {
  const workflow = read('.github/workflows/autodev.yml');
  const verifyIndex = workflow.indexOf('npm test 2>&1 | tee /tmp/npm-test.log');
  const commitIndex = workflow.indexOf('git add -A');
  const prIndex = workflow.indexOf('gh pr create');
  assert.ok(verifyIndex !== -1, 'verification step exists');
  assert.ok(commitIndex > verifyIndex, 'commit happens only after verification');
  assert.ok(prIndex > commitIndex, 'PR creation happens only after commit');
  assert.match(workflow, /Verify before publishing/);
  assert.match(workflow, /produced no repository change/);
  assert.match(workflow, /npm-test\.log/);
  assert.match(workflow, /npm-verify\.log/);
});
