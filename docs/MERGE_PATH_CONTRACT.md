# Merge Path Contract

The merge path is the referee: it decides whether a verified exact head may enter
`main`. This document records the two code paths that can merge, the scopes they
need, the stable error codes they emit, and the owner settings they depend on.

Nothing in this document is a claim that a merge has been observed. Observed
behaviour is recorded only with a run URL and result.

## 1. The two paths

| Path | Workflow | Trigger | Role |
|---|---|---|---|
| Referee | `.github/workflows/autonomous-merge.yml` | `pull_request` → `main`; `workflow_dispatch` | Runs the exact-head suite, then arms auto-merge (`gh pr merge --auto`) |
| Controller | `.github/workflows/exact-head-merge.yml` | `workflow_run` completion of CI, PR Gate or Referee | Re-evaluates `merge-eligibility.mjs`, merges, and confirms GitHub's merged state |

Both paths are told the exact head they may act on. Neither path deletes the
head branch: branch cleanup is the owner's decision, and a mistaken delete would
destroy competing implementations that still need review.

## 2. Permission contract

A workflow that declares a `permissions:` block receives `none` for every scope
it omits. That makes an under-declared workflow fail with HTTP 403 **inside a
step**, which only surfaces as a red step — or, if the step masks its own
failure, not at all.

| Path | Required scopes | Why |
|---|---|---|
| Referee | `contents: write` | `gh pr merge` performs the merge |
| Referee | `pull-requests: write` | arming auto-merge, reading pull-request state |
| Referee | `checks: read`, `statuses: read` | GitHub's own mergeability decision |
| Controller | `contents: write`, `pull-requests: write`, `actions: write` | merge, read pull requests, dispatch post-merge CI |

`tests/mergeWorkflowContract.test.js` asserts this contract statically: any
workflow containing `gh pr merge` must declare `contents: write` and
`pull-requests: write`. That test exists because the referee previously declared
`contents: read` and `pull-requests: read`, so both `gh pr ready` and
`gh pr merge` returned 403 while the job reported success.

## 3. Exact-head contract

`merge-eligibility.mjs` requires, for the exact expected SHA:

- the pull request is `open`, not a draft, and based on `main`;
- `pull_request.head.sha === expectedHeadSha`;
- `mergeable === true`;
- each required workflow (ST Production House CI, PR Gate, Autonomous Merge
  Referee) has a latest run at that same `head_sha`, with an allowed event
  (`pull_request` or `workflow_dispatch`), `status === completed` and
  `conclusion === success`. A run at any other SHA is `stale_workflow:*`.

The referee re-reads `head.sha` from the API immediately before arming
auto-merge and fails with `AUTONOMOUS_MERGE_HEAD_MOVED` if it no longer matches
the head it tested. The controller re-reads the head immediately before merging
and fails with `MERGE_HEAD_MOVED`. Both pin the merge request itself with
`--match-head-commit`, so GitHub rejects a merge if the head moved between the
last read and the merge.

## 4. Stable error codes

| Code | Meaning |
|---|---|
| `AUTONOMOUS_MERGE_HEAD_MOVED` | the head changed between the test run and arming |
| `AUTONOMOUS_MERGE_ARM_FAILED` | `gh pr merge --auto` failed; the reason is included |
| `AUTONOMOUS_MERGE_NOT_ARMED` | the command succeeded but GitHub reports no armed auto-merge |
| `AUTONOMOUS_MERGE_ARMED` | auto-merge is armed for this head (informational) |
| `AUTONOMOUS_MERGE_DUPLICATE_CLAIM` | another open pull request claims the same closing issue |
| `AUTONOMOUS_MERGE_CLAIM_UNIQUE` | no competing claim (informational) |
| `AUTONOMOUS_MERGE_CLAIM_UNKNOWN` | the pull request was not in the open-pull-request list |
| `MERGE_REQUEST_FAILED` | `gh pr merge` failed; the reason is included |
| `MERGE_NOT_CONFIRMED` | `gh pr merge` returned, but GitHub does not report the head as merged |
| `MERGE_VERIFIED` | GitHub reports `merged: true`; the merge commit SHA is printed |
| `MERGE_ELIGIBILITY` | controller verdict: `eligible=<bool> reasons=<csv>` |
| `MAIN_BASELINE_GREEN` | the current `main` has a successful CI run (informational) |
| `MAIN_BASELINE_MISSING` | no CI run is recorded for the current `main` (advisory) |
| `MAIN_BASELINE_RED` | the current `main` has no successful CI run (advisory) |

A failed merge request must exit non-zero. Masking it with `|| true` or
`|| echo` is a policy violation: it turns "the merge never happened" into a
green check.

## 5. Duplicate-claim guard

`duplicate-claim-check.mjs` parses closing keywords (`Closes`, `Fixes`,
`Resolves`) from every open pull request and fails with
`AUTONOMOUS_MERGE_DUPLICATE_CLAIM` when two open pull requests claim the same
issue. It never closes, edits or merges either one: competing implementations
are an owner decision, and picking one automatically would discard work that may
be the better implementation. The guard only stops the merge path from
arbitrarily resolving the race.

## 6. Main baseline is advisory, never a merge condition

The controller records the state of `main`'s own CI and never blocks on it.

The earlier design required a successful run on the current `main` before any
merge. That was both redundant and circular:

- **Redundant.** On a `pull_request` run, `ci.yml` checks out `github.sha`,
  which GitHub sets to the synthetic merge commit of the head and the current
  base. A green exact-head gate therefore already proves "this head merged with
  `main` passes" — the only thing a merge needs. A past green run on `main`
  proves nothing about a different head.
- **Circular.** `main` only changes when a pull request merges, so requiring a
  green `main` before merging means a red `main` can never be repaired through
  the governed path. The repository would freeze permanently.

Codes: `MAIN_BASELINE_GREEN` (informational), `MAIN_BASELINE_MISSING` and
`MAIN_BASELINE_RED` (advisory warnings). None of them sets `found=false` or
short-circuits the controller; `tests/mergeWorkflowContract.test.js` and
`tests/autopilotWorkflows.test.js` assert that the baseline block cannot block.

What replaces the old guarantee is the exact-head contract of §3 plus two owner
settings: **require branches to be up to date before merging** (so a stale base
cannot be merged) and **require the three gates** (so auto-merge cannot pass on
the referee's own suite alone).

If `main` is red, that is a real problem — recorded on every controller run —
but the fix is to merge a verified pull request that repairs it, not to freeze.

## 7. Owner-configured prerequisites

These live in repository settings, not in code, and cannot be verified from a
checkout:

1. **Branch protection / ruleset on `main`** requiring the three gates (CI,
   PR Gate, Autonomous Merge Referee) and a pull-request review. Without it,
   auto-merge would be gated only by whatever the referee itself ran.
2. **Allow auto-merge** enabled for the repository. If it is off,
   `gh pr merge --auto` fails and the referee now reports
   `AUTONOMOUS_MERGE_ARM_FAILED` instead of a notice.
3. **Actions workflow permissions** for the repository set to allow workflows to
   create and approve pull requests, otherwise the explicit scopes above are
   still capped.
4. **`GITHUB_TOKEN` merge rights**: merges performed with the workflow token do
   not trigger further workflow runs, which is why the controller dispatches
   `ci.yml` on `main` explicitly after a verified merge.

## 8. How to prove the path works

1. Dispatch the referee (`autonomous-merge.yml`) with `pr_number` and
   `expected_head` on a real pull request and read the step log.
2. Confirm `AUTONOMOUS_MERGE_HEAD_CONFIRMED` and `AUTONOMOUS_MERGE_ARMED` for the
   expected SHA, or the specific failure code.
3. Confirm the controller run reports `MERGE_ELIGIBILITY eligible=true` and then
   `MERGE_VERIFIED` with a merge commit SHA, and that the pull request page shows
   merged.
4. Record the run URL. Without it, nothing here is proven.

## 9. Known limits

- The static tests check the workflow contract, not GitHub's behaviour. A green
  `npm test` does not mean a merge succeeded.
- Repository settings in §7 are outside the repository; a correct workflow can
  still be blocked by them.
- `aws`/`gh` credentials are not available to this checkout, so pull-request
  inventory and run history must be read by the owner or by a token-bearing
  environment.

## When auto-merge cannot be armed

If the repository has auto-merge disabled, `gh pr merge --auto` merges the pull
request immediately instead of queueing an armed auto-merge. The referee used to
treat that as `AUTONOMOUS_MERGE_NOT_ARMED` and exit 1 even though the verified
head had already merged, so a successful merge produced a red gate.

The referee now accepts either outcome **on the verified head**:

- `AUTONOMOUS_MERGE_ARMED` — GitHub reports an armed auto-merge.
- `AUTONOMOUS_MERGE_ALREADY_MERGED` — the pull request is already merged
  (auto-merge disabled, or the queue completed before the check).

The failure paths are unchanged: `AUTONOMOUS_MERGE_ARM_FAILED` for a rejected
merge request, `AUTONOMOUS_MERGE_NOT_ARMED` when there is neither an armed
auto-merge nor a merged pull request, and `AUTONOMOUS_MERGE_HEAD_MOVED` for a
head that changed after verification.
