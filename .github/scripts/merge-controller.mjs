import fs from 'node:fs';
import { evaluateMergeEligibility } from './merge-eligibility.mjs';

const [pullPath, runsPath, expectedHeadSha] = process.argv.slice(2);
if (!pullPath || !runsPath || !expectedHeadSha) {
  console.error('usage: merge-controller.mjs <pull.json> <workflow-runs.json> <expected-head-sha>');
  process.exit(2);
}

const pullRequest = JSON.parse(fs.readFileSync(pullPath, 'utf8'));
const runsPayload = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
const result = evaluateMergeEligibility({
  pullRequest,
  expectedHeadSha,
  workflowRuns: runsPayload.workflow_runs
});

console.log(JSON.stringify(result));
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${result.eligible}\n`);
}
