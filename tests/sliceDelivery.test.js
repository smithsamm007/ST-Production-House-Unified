import test from "node:test";
import assert from "node:assert/strict";

import {
  SLICE_DELIVERY_ACTIONS,
  SLICE_DELIVERY_VERDICTS,
  issueNumberFromBranch,
  mapSliceToIssue,
  planSliceDelivery,
  selectCanonicalCandidate,
  summarizeDelivery,
  tagSliceId
} from "../src/automation/sliceDelivery.js";

const slice = (sliceId, ownerGated = false, lane = "lane-3") => ({
  sliceId,
  lane,
  ownerGated,
  title: sliceId,
  brief: "b",
  acceptance: ["a"]
});

const baseInput = (overrides = {}) => ({
  slices: [slice("S-M43-01")],
  promotedSliceIds: [],
  issues: [{ number: 263, title: "[S-M43-01] measured QC", state: "OPEN" }],
  openPullRequests: [],
  candidatesBySlice: {},
  ...overrides
});

test("slice tags are parsed from issue titles only", () => {
  assert.equal(tagSliceId("[S-M43-01] measured QC"), "S-M43-01");
  assert.equal(tagSliceId("measured QC without a tag"), null);
  assert.equal(tagSliceId(undefined), null);
});

test("task branch names resolve to their issue number", () => {
  assert.equal(issueNumberFromBranch("task/263-measured-media-qc"), 263);
  assert.equal(issueNumberFromBranch("integration/262-263-264"), null);
  assert.equal(issueNumberFromBranch("main"), null);
});

test("slice to issue mapping is deterministic and prefers the lowest issue number", () => {
  const mapping = mapSliceToIssue([
    { number: 270, title: "[S-M43-01] duplicate", state: "OPEN" },
    { number: 263, title: "[S-M43-01] canonical", state: "OPEN" },
    { number: 999, title: "untagged issue", state: "OPEN" }
  ]);
  assert.deepEqual(Object.keys(mapping), ["S-M43-01"]);
  assert.equal(mapping["S-M43-01"].number, 263);
});

test("a single candidate branch is canonical without needing CI evidence", () => {
  const choice = selectCanonicalCandidate([{ branch: "task/263-a", headSha: "a".repeat(40), aheadBy: 2, verifiedHead: false }]);
  assert.equal(choice.status, "SELECTED");
  assert.equal(choice.reason, "SINGLE_CANDIDATE");
  assert.deepEqual(choice.duplicates, []);
});

test("one verified candidate wins over unverified competitors", () => {
  const choice = selectCanonicalCandidate([
    { branch: "task/263-b", headSha: "b".repeat(40), aheadBy: 1, verifiedHead: false },
    { branch: "task/263-a", headSha: "a".repeat(40), aheadBy: 4, verifiedHead: true }
  ]);
  assert.equal(choice.status, "SELECTED");
  assert.equal(choice.reason, "SINGLE_VERIFIED_CANDIDATE");
  assert.equal(choice.selected.branch, "task/263-a");
  assert.deepEqual(choice.duplicates.map((candidate) => candidate.branch), ["task/263-b"]);
});

test("two verified implementations are never chosen automatically", () => {
  const choice = selectCanonicalCandidate([
    { branch: "task/263-a", headSha: "a".repeat(40), aheadBy: 4, verifiedHead: true },
    { branch: "task/263-b", headSha: "b".repeat(40), aheadBy: 4, verifiedHead: true }
  ]);
  assert.equal(choice.status, "AMBIGUOUS");
  assert.equal(choice.reason, "MULTIPLE_VERIFIED_CANDIDATES");
  assert.equal(choice.selected, null);
  assert.deepEqual(choice.ambiguousBranches, ["task/263-a", "task/263-b"]);
});

test("several unverified implementations are also left to the owner", () => {
  const choice = selectCanonicalCandidate([
    { branch: "task/263-a", headSha: "a".repeat(40), aheadBy: 4, verifiedHead: false },
    { branch: "task/263-b", headSha: "b".repeat(40), aheadBy: 4, verifiedHead: false }
  ]);
  assert.equal(choice.status, "AMBIGUOUS");
  assert.equal(choice.reason, "MULTIPLE_UNVERIFIED_CANDIDATES");
});

test("owner-gated slices are never actionable even with a candidate branch", () => {
  const report = planSliceDelivery(
    baseInput({
      slices: [slice("S-M20-LIVE", true, "lane-1")],
      issues: [{ number: 120, title: "[S-M20-LIVE] credential onboarding", state: "OPEN" }],
      candidatesBySlice: { "S-M20-LIVE": [{ branch: "task/120-x", headSha: "a".repeat(40) }] }
    })
  );
  assert.equal(report.actions[0].action, SLICE_DELIVERY_ACTIONS.OWNER_ACTION_REQUIRED);
  assert.deepEqual(report.ownerGatedRemaining, ["S-M20-LIVE"]);
  assert.equal(report.automatableRemaining, 0);
  assert.equal(report.verdict, SLICE_DELIVERY_VERDICTS.AUTOMATABLE_COMPLETE);
});

test("one governed pull request in flight holds every other slice", () => {
  const report = planSliceDelivery(
    baseInput({
      slices: [slice("S-M42-01"), slice("S-M44-01")],
      issues: [
        { number: 262, title: "[S-M42-01] duration", state: "OPEN" },
        { number: 264, title: "[S-M44-01] evidence", state: "OPEN" }
      ],
      openPullRequests: [{ number: 265, headRefName: "task/262-target-duration-unification", headSha: "c".repeat(40) }],
      candidatesBySlice: {
        "S-M42-01": [{ branch: "task/262-target-duration-unification", headSha: "c".repeat(40) }],
        "S-M44-01": [{ branch: "task/264-durable-rehearsal-evidence", headSha: "d".repeat(40) }]
      }
    })
  );
  assert.equal(report.governedPullRequestsInFlight.length, 1);
  assert.equal(report.actions.find((a) => a.sliceId === "S-M42-01").action, SLICE_DELIVERY_ACTIONS.PULL_REQUEST_IN_FLIGHT);
  assert.equal(report.actions.find((a) => a.sliceId === "S-M44-01").action, SLICE_DELIVERY_ACTIONS.HOLD_ONE_PULL_REQUEST_IN_FLIGHT);
});

test("the canonical branch is opened when nothing is in flight", () => {
  const report = planSliceDelivery(
    baseInput({
      candidatesBySlice: { "S-M43-01": [{ branch: "task/263-measured-media-qc", headSha: "a".repeat(40), aheadBy: 3, verifiedHead: true }] }
    })
  );
  const action = report.actions[0];
  assert.equal(action.action, SLICE_DELIVERY_ACTIONS.OPEN_PULL_REQUEST);
  assert.equal(action.branch, "task/263-measured-media-qc");
  assert.equal(action.issueNumber, 263);
  assert.equal(action.verificationEvidence, true);
});

test("two open pull requests for one slice are reported, never auto-closed", () => {
  const report = planSliceDelivery(
    baseInput({
      openPullRequests: [
        { number: 265, headRefName: "task/263-a", headSha: "a".repeat(40) },
        { number: 266, headRefName: "task/263-b", headSha: "b".repeat(40) }
      ],
      candidatesBySlice: { "S-M43-01": [{ branch: "task/263-c", headSha: "c".repeat(40) }] }
    })
  );
  const action = report.actions[0];
  assert.equal(action.action, SLICE_DELIVERY_ACTIONS.AMBIGUOUS_DUPLICATE_PULL_REQUESTS);
  assert.deepEqual(action.pullRequests.map((pullRequest) => pullRequest.number), [265, 266]);
});

test("slices without a branch await implementation or promotion", () => {
  const withIssue = planSliceDelivery(baseInput());
  assert.equal(withIssue.actions[0].action, SLICE_DELIVERY_ACTIONS.AWAIT_IMPLEMENTATION);

  const withoutIssue = planSliceDelivery(baseInput({ issues: [] }));
  assert.equal(withoutIssue.actions[0].action, SLICE_DELIVERY_ACTIONS.AWAIT_PROMOTION);
});

test("a branch with no commits ahead of main is never a delivery candidate", () => {
  const choice = selectCanonicalCandidate([{ branch: "task/263-empty", headSha: "a".repeat(40), aheadBy: 0 }]);
  assert.equal(choice.status, "NONE");
  assert.equal(choice.reason, "NO_COMMITS_AHEAD");

  const report = planSliceDelivery(
    baseInput({
      candidatesBySlice: { "S-M43-01": [{ branch: "task/263-empty", headSha: "a".repeat(40), aheadBy: 0 }] }
    })
  );
  assert.equal(report.actions[0].action, SLICE_DELIVERY_ACTIONS.AWAIT_IMPLEMENTATION);
});

test("at most one pull request is opened per run, deterministically", () => {
  const report = planSliceDelivery(
    baseInput({
      slices: [slice("S-M44-01"), slice("S-M42-01")],
      issues: [
        { number: 262, title: "[S-M42-01] duration", state: "OPEN" },
        { number: 264, title: "[S-M44-01] evidence", state: "OPEN" }
      ],
      candidatesBySlice: {
        "S-M42-01": [{ branch: "task/262-duration", headSha: "a".repeat(40), aheadBy: 2 }],
        "S-M44-01": [{ branch: "task/264-evidence", headSha: "b".repeat(40), aheadBy: 3 }]
      }
    })
  );

  const opened = report.actions.filter((action) => action.action === SLICE_DELIVERY_ACTIONS.OPEN_PULL_REQUEST);
  assert.equal(opened.length, 1, "a single run must never open two pull requests");
  assert.equal(opened[0].sliceId, "S-M42-01", "the lowest slice id goes first");

  const held = report.actions.find((action) => action.sliceId === "S-M44-01");
  assert.equal(held.action, SLICE_DELIVERY_ACTIONS.HOLD_ONE_PULL_REQUEST_IN_FLIGHT);
  assert.equal(held.reason, "ONE_PULL_REQUEST_PER_RUN");
});

test("merged slices are recorded as merged and stop counting as remaining", () => {
  const report = planSliceDelivery(baseInput({ promotedSliceIds: ["S-M43-01"] }));
  assert.equal(report.actions[0].action, SLICE_DELIVERY_ACTIONS.ALREADY_MERGED);
  assert.equal(report.automatableRemaining, 0);
  assert.equal(report.verdict, SLICE_DELIVERY_VERDICTS.AUTOMATABLE_COMPLETE);
});

test("the verdict stays WORK_REMAINING until every automatable slice is merged", () => {
  const report = planSliceDelivery(
    baseInput({
      slices: [slice("S-M42-01"), slice("S-M43-01")],
      promotedSliceIds: ["S-M42-01"],
      issues: [{ number: 263, title: "[S-M43-01] measured QC", state: "OPEN" }]
    })
  );
  assert.equal(report.automatableRemaining, 1);
  assert.equal(report.verdict, SLICE_DELIVERY_VERDICTS.WORK_REMAINING);
});

test("malformed input fails with a stable code", () => {
  assert.throws(() => planSliceDelivery({ slices: null, promotedSliceIds: [], issues: [], openPullRequests: [] }), {
    code: "SLICE_DELIVERY_INPUT_INVALID"
  });
  assert.throws(() => summarizeDelivery({}), { code: "SLICE_DELIVERY_REPORT_INVALID" });
});

test("the summary names the most important remaining decision", () => {
  const ambiguous = planSliceDelivery(
    baseInput({
      candidatesBySlice: {
        "S-M43-01": [
          { branch: "task/263-a", headSha: "a".repeat(40), verifiedHead: true },
          { branch: "task/263-b", headSha: "b".repeat(40), verifiedHead: true }
        ]
      }
    })
  );
  assert.match(summarizeDelivery(ambiguous), /owner must choose between 2 candidate branches for S-M43-01/);
});
