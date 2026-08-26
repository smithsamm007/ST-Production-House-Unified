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
