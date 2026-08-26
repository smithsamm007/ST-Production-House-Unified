const REQUIRED_WORKFLOWS = Object.freeze([
  'ST Production House CI',
  'PR Gate',
  'Autonomous Merge Referee'
]);

const SUCCESS = 'success';
const COMPLETED = 'completed';

function latestRunsByName(workflowRuns) {
  const latest = new Map();
  for (const run of workflowRuns ?? []) {
    if (!run || typeof run.name !== 'string') continue;
    const previous = latest.get(run.name);
    const runTime = Date.parse(run.updated_at ?? run.created_at ?? 0);
    const previousTime = Date.parse(previous?.updated_at ?? previous?.created_at ?? 0);
    if (!previous || runTime >= previousTime) latest.set(run.name, run);
  }
  return latest;
}

export function evaluateMergeEligibility({
  pullRequest,
  expectedHeadSha,
  workflowRuns,
  requiredWorkflows = REQUIRED_WORKFLOWS
}) {
  const reasons = [];

  if (!pullRequest || pullRequest.state !== 'open') reasons.push('pull_request_not_open');
  if (pullRequest?.draft !== false) reasons.push('pull_request_is_draft');
  if (pullRequest?.base?.ref !== 'main') reasons.push('base_is_not_main');
  if (!expectedHeadSha || pullRequest?.head?.sha !== expectedHeadSha) {
    reasons.push('stale_or_mismatched_head');
  }
  if (pullRequest?.mergeable !== true) reasons.push('pull_request_not_mergeable');

  const latest = latestRunsByName(workflowRuns);
  for (const name of requiredWorkflows) {
    const run = latest.get(name);
    if (!run) {
      reasons.push(`missing_workflow:${name}`);
      continue;
    }
    if (run.head_sha !== expectedHeadSha) reasons.push(`stale_workflow:${name}`);
    if (run.event !== 'pull_request') reasons.push(`wrong_event:${name}`);
    if (run.status !== COMPLETED) reasons.push(`incomplete_workflow:${name}:${run.status ?? 'missing'}`);
    if (run.conclusion !== SUCCESS) reasons.push(`unsuccessful_workflow:${name}:${run.conclusion ?? 'missing'}`);
  }

  return Object.freeze({
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons)
  });
}

export { REQUIRED_WORKFLOWS };
