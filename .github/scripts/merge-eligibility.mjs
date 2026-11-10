const REQUIRED_WORKFLOWS = Object.freeze([
  'ST Production House CI',
  'PR Gate',
  'Autonomous Merge Referee'
]);

const SUCCESS = 'success';
const COMPLETED = 'completed';
const ALLOWED_EVENTS = new Set(['pull_request', 'workflow_dispatch']);

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

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/gi;

/** Issue numbers a pull request body claims to close (AGENTS.md amendment 2). */
export function closingIssueNumbers(body) {
  if (typeof body !== 'string') return [];
  const numbers = new Set();
  for (const match of body.matchAll(CLOSING_KEYWORD)) numbers.add(Number(match[1]));
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Other open pull requests that claim to close the same issue.
 *
 * Two open pull requests for one issue are competing implementations, not two
 * deliverables: merging either makes the other contradictory work. The merge
 * path refuses to proceed until the owner picks one.
 */
export function findDuplicateClaimants({ pullRequest, openPullRequests = [] }) {
  const claimed = new Set(closingIssueNumbers(pullRequest?.body));
  if (claimed.size === 0) return [];
  return (Array.isArray(openPullRequests) ? openPullRequests : [])
    .filter((candidate) => candidate && Number.isInteger(candidate.number) && candidate.number !== pullRequest.number)
    .filter((candidate) => closingIssueNumbers(candidate.body).some((issue) => claimed.has(issue)))
    .map((candidate) => candidate.number)
    .sort((a, b) => a - b);
}

export function evaluateMergeEligibility({
  pullRequest,
  expectedHeadSha,
  workflowRuns,
  requiredWorkflows = REQUIRED_WORKFLOWS,
  openPullRequests = null
}) {
  const reasons = [];

  if (!pullRequest || pullRequest.state !== 'open') reasons.push('pull_request_not_open');
  if (pullRequest?.draft !== false) reasons.push('pull_request_is_draft');
  if (pullRequest?.base?.ref !== 'main') reasons.push('base_is_not_main');
  if (!expectedHeadSha || pullRequest?.head?.sha !== expectedHeadSha) {
    reasons.push('stale_or_mismatched_head');
  }
  if (pullRequest?.mergeable !== true) reasons.push('pull_request_not_mergeable');
  if (Array.isArray(openPullRequests)) {
    for (const competitor of findDuplicateClaimants({ pullRequest, openPullRequests })) {
      reasons.push(`duplicate_claim:${competitor}`);
    }
  }

  const latest = latestRunsByName(workflowRuns);
  for (const name of requiredWorkflows) {
    const run = latest.get(name);
    if (!run) {
      reasons.push(`missing_workflow:${name}`);
      continue;
    }
    if (run.head_sha !== expectedHeadSha) reasons.push(`stale_workflow:${name}`);
    if (!ALLOWED_EVENTS.has(run.event)) reasons.push(`wrong_event:${name}`);
    if (run.status !== COMPLETED) reasons.push(`incomplete_workflow:${name}:${run.status ?? 'missing'}`);
    if (run.conclusion !== SUCCESS) reasons.push(`unsuccessful_workflow:${name}:${run.conclusion ?? 'missing'}`);
  }

  return Object.freeze({
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons)
  });
}

export { REQUIRED_WORKFLOWS };
