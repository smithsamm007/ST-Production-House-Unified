import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMergeEligibility, REQUIRED_WORKFLOWS } from '../.github/scripts/merge-eligibility.mjs';

const HEAD = 'a'.repeat(40);

function pull(overrides = {}) {
  return {
    state: 'open',
    draft: false,
    mergeable: true,
    head: { sha: HEAD },
    base: { ref: 'main' },
    ...overrides
  };
}

function successfulRuns(overrides = {}) {
  return REQUIRED_WORKFLOWS.map((name, index) => ({
    name,
    head_sha: HEAD,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    updated_at: `2026-08-26T00:0${index}:00Z`,
    ...(overrides[name] ?? {})
  }));
}

test('accepts only an open, ready, mergeable exact head with every successful workflow', () => {
  const result = evaluateMergeEligibility({
    pullRequest: pull(),
    expectedHeadSha: HEAD,
    workflowRuns: successfulRuns()
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

for (const [label, mutate, reason] of [
  ['draft', { draft: true }, 'pull_request_is_draft'],
  ['closed', { state: 'closed' }, 'pull_request_not_open'],
  ['stale head', { head: { sha: 'b'.repeat(40) } }, 'stale_or_mismatched_head'],
  ['conflicted', { mergeable: false }, 'pull_request_not_mergeable'],
  ['wrong base', { base: { ref: 'develop' } }, 'base_is_not_main']
]) {
  test(`rejects ${label} pull requests`, () => {
    const result = evaluateMergeEligibility({
      pullRequest: pull(mutate),
      expectedHeadSha: HEAD,
      workflowRuns: successfulRuns()
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes(reason));
  });
}

for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'action_required', null]) {
  test(`rejects ${conclusion ?? 'missing'} referee conclusion`, () => {
    const result = evaluateMergeEligibility({
      pullRequest: pull(),
      expectedHeadSha: HEAD,
      workflowRuns: successfulRuns({
        'Autonomous Merge Referee': { conclusion }
      })
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((reason) => reason.startsWith('unsuccessful_workflow:Autonomous Merge Referee')));
  });
}

test('rejects pending workflows', () => {
  const result = evaluateMergeEligibility({
    pullRequest: pull(),
    expectedHeadSha: HEAD,
    workflowRuns: successfulRuns({
      'ST Production House CI': { status: 'in_progress', conclusion: null }
    })
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.startsWith('incomplete_workflow:ST Production House CI')));
});

test('rejects a missing required workflow', () => {
  const result = evaluateMergeEligibility({
    pullRequest: pull(),
    expectedHeadSha: HEAD,
    workflowRuns: successfulRuns().filter((run) => run.name !== 'PR Gate')
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('missing_workflow:PR Gate'));
});

test('uses the latest run and rejects a newer failure after an older success', () => {
  const runs = successfulRuns();
  runs.push({
    name: 'PR Gate',
    head_sha: HEAD,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    updated_at: '2026-08-26T01:00:00Z'
  });
  const result = evaluateMergeEligibility({
    pullRequest: pull(),
    expectedHeadSha: HEAD,
    workflowRuns: runs
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('unsuccessful_workflow:PR Gate:failure'));
});
