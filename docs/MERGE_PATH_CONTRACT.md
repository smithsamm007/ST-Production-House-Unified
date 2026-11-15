# Merge Path Contract

There is **one** merge path: `.github/workflows/exact-head-merge.yml` (the controller).
The referee (`.github/workflows/autonomous-merge.yml`) verifies an exact head and reports a
result; it holds no merge capability at all.

Nothing in this document is a claim that a merge has been observed. Observed behaviour is
recorded only with a run id and result.

## 1. The single merge path

| Path | Workflow | Trigger | Role |
|---|---|---|---|
| Referee | `.github/workflows/autonomous-merge.yml` | `pull_request` → `main`; `workflow_dispatch` | Runs the exact-head suite (roadmap, verify, unit/policy, PostgreSQL integration), refuses duplicate claims, re-reads the head, and reports `REFEREE_VERIFIED`. **Never merges.** |
| Controller | `.github/workflows/exact-head-merge.yml` | `workflow_run: completed` of ST Production House CI, PR Gate or Autonomous Merge Referee | Evaluates `merge-eligibility.mjs` against the live runs at the exact head, re-evaluates again immediately before merging, re-reads the head, merges with `--match-head-commit`, then confirms GitHub's merged state and merge commit |

Why the referee must not merge: GitHub's native auto-merge (`gh pr merge --auto`) obeys the
**branch-protection required status checks**, not this repository's eligibility controller.
A job that is not a required check can fail while the pull request is still merged — which is
exactly what happened on 2026-11-13 (§6.1). A verifying workflow that can also merge is the
bypass; removing the capability removes the bypass.

Why the controller evaluates eligibility and the referee does not: the referee is itself one
of the three required workflows. If it evaluated `merge-eligibility.mjs` during its own run,
its latest run at that head would be `in_progress`, the verdict would be
`incomplete_workflow:Autonomous Merge Referee:in_progress`, and **no pull request could ever
merge**. The controller runs after a gate completes, so all three runs have a conclusion.

Neither path deletes the head branch: branch cleanup is the owner's decision, and a mistaken
delete would destroy competing implementations that still need review.

## 2. Permission contract

A workflow that declares a `permissions:` block receives `none` for every scope it omits.
That makes an under-declared workflow fail with HTTP 403 **inside a step**, which only
surfaces as a red step — or, if the step masks its own failure, not at all.

| Path | Scopes | Why |
|---|---|---|
| Referee | `contents: read`, `pull-requests: read`, `checks: read`, `statuses: read` | read pull requests and run state; **no merge rights by design** |
| Controller | `contents: write`, `pull-requests: write`, `actions: write` | the merge, the pull-request reads, and the post-merge `ci.yml` dispatch |

`tests/mergeWorkflowContract.test.js` asserts this statically: exactly one workflow file may
contain `gh pr merge` (the controller), and it must declare `contents: write` and
`pull-requests: write`; the referee must contain neither `gh pr merge` nor `--auto` and must
not hold `contents: write`.

## 3. Exact-head contract

`merge-eligibility.mjs` requires, for the exact expected SHA:

- the pull request is `open`, not a draft, and based on `main`;
- `pull_request.head.sha === expectedHeadSha` (otherwise `stale_or_mismatched_head`);
- `mergeable === true`;
- each required workflow (ST Production House CI, PR Gate, Autonomous Merge Referee) has a
  latest run at that same `head_sha`, with an allowed event (`pull_request` or
  `workflow_dispatch`), `status === completed` and `conclusion === success`. A run at any
  other SHA is `stale_workflow:*`; an unfinished run is `incomplete_workflow:*`; any other
  conclusion is `unsuccessful_workflow:*`.

Because eligibility is a **whole-run** conclusion, a failed job inside `ci.yml` (for example
the PostgreSQL integration job) makes the run `failure` and therefore the head ineligible.
A green referee run contributes nothing that can override it — asserted directly in
`tests/mergeEligibility.test.js` ("a failed PostgreSQL CI run cannot be overridden by a
successful referee run").

The referee re-reads `head.sha` from the API after its own verification and fails with
`AUTONOMOUS_MERGE_HEAD_MOVED` if it moved. The controller re-reads the head immediately
before merging (`MERGE_HEAD_MOVED`) and pins the merge request with `--match-head-commit`, so
GitHub rejects a merge if the head moved between the last read and the merge.

## 4. Stable error codes

| Code | Meaning |
|---|---|
| `REFEREE_VERIFIED` | the referee finished its verification for this exact head; it performed no merge |
| `AUTONOMOUS_MERGE_HEAD_MOVED` | the head changed between the referee's test run and its final read |
| `AUTONOMOUS_MERGE_DUPLICATE_CLAIM` | another open pull request claims the same closing issue |
| `AUTONOMOUS_MERGE_CLAIM_UNIQUE` | no competing claim (informational) |
| `AUTONOMOUS_MERGE_CLAIM_UNKNOWN` | the pull request was not in the open-pull-request list |
| `MERGE_ELIGIBILITY` | controller verdict: `eligible=<bool> reasons=<csv>` |
| `MERGE_HEAD_MOVED` | the head changed between the controller's re-evaluation and the merge |
| `MERGE_REQUEST_FAILED` | `gh pr merge` failed; the reason is included |
| `MERGE_NOT_CONFIRMED` | the merge request returned, but GitHub does not report the head as merged |
| `MERGE_VERIFIED` | GitHub reports `merged: true`; the merge commit SHA is printed |
| `MAIN_BASELINE_GREEN` | the current `main` has a successful CI run (informational) |
| `MAIN_BASELINE_MISSING` | no CI run is recorded for the current `main` (advisory) |
| `MAIN_BASELINE_RED` | the current `main` has no successful CI run (advisory) |

A failed merge request must exit non-zero. Masking it with `|| true` or `|| echo` is a policy
violation: it turns "the merge never happened" into a green check.

## 5. Duplicate-claim guard

`duplicate-claim-check.mjs` parses closing keywords (`Closes`, `Fixes`, `Resolves`) from every
open pull request and fails with `AUTONOMOUS_MERGE_DUPLICATE_CLAIM` when two open pull
requests claim the same issue. It never closes, edits or merges either one: competing
implementations are an owner decision, and picking one automatically would discard work that
may be the better implementation. Both the referee and the controller run it.

## 6. Main baseline is advisory, never a merge condition

The controller records the state of `main`'s own CI and never blocks on it.

The earlier design required a successful run on the current `main` before any merge. That was
both redundant and circular:

- **Redundant.** On a `pull_request` run, `ci.yml` checks out `github.sha`, which GitHub sets
  to the synthetic merge commit of the head and the current base. A green exact-head gate
  therefore already proves "this head merged with `main` passes" — the only thing a merge
  needs. A past green run on `main` proves nothing about a different head.
- **Circular.** `main` only changes when a pull request merges, so requiring a green `main`
  before merging means a red `main` can never be repaired through the governed path.

Codes: `MAIN_BASELINE_GREEN` (informational), `MAIN_BASELINE_MISSING` and `MAIN_BASELINE_RED`
(advisory warnings). None of them sets `found=false` or short-circuits the controller;
`tests/mergeWorkflowContract.test.js` and `tests/autopilotWorkflows.test.js` assert that the
baseline block cannot block.

What replaces the old guarantee is the exact-head contract of §3 **plus** the single-merge-path
rule of §1: the only workflow that can merge re-checks all three gates at the exact head
immediately before doing so. Branch protection remains defence in depth, not the mechanism.

### 6.1 Observed incident — a red PostgreSQL job merged anyway (2026-11-13)

Recorded because it is the reason the merge path was rebuilt:

| Fact | Value |
|---|---|
| Head | `a9dafce` (PR #279) |
| CI run | `43492748764`, concluded **`failure`** |
| Failing job | `132118395367` — `PostgreSQL Integration Tests`, failed `19:32:03Z` |
| Merge | `19:32:54Z` by `github-actions[bot]`, merge commit `a593bfa` |
| Cause | the referee armed GitHub's native auto-merge, which waits on branch-protection required checks only; the PostgreSQL job was not one of them, so `merge-eligibility.mjs` was never consulted |
| Referee's own run | `43492748960`, **success** `19:33:00Z` — it ran the same 19-file PostgreSQL suite |

**The green referee run does not explain the red CI run, and this document does not claim it
does.** The two runs tested different trees: the referee checked out the bare head
(`a9dafce`, tree `34abc20`), while `ci.yml` checks out `github.sha`, the synthetic merge of the
head with the then-current base (`0b73d94`…`080c54d`), i.e. tree `90dfb1e` — the same tree as
merged `main`. Those two trees differ by 51 files (+111 / −2,762). The CI failure is therefore
**unexplained**, not a flake, and must be investigated on the merged-main tree with the
complete step log before anything about the migrated schema is concluded.

## 7. Owner-configured prerequisites

These live in repository settings, not in code, and cannot be verified from a checkout:

1. **Branch protection / ruleset on `main`** requiring the three gates (ST Production House CI,
   PR Gate, Autonomous Merge Referee) and a pull-request review, **including the
   `PostgreSQL Integration Tests` job**. This is defence in depth: the controller already
   refuses a merge unless all three whole-run conclusions are `success` at the exact head.
2. **Auto-merge setting**: no longer used. The repository may leave auto-merge disabled; no
   workflow arms it.
3. **Actions workflow permissions** for the repository set to allow workflows to create and
   approve pull requests, otherwise the explicit scopes above are still capped.
4. **`GITHUB_TOKEN` merge rights**: merges performed with the workflow token do not trigger
   further workflow runs, which is why the controller dispatches `ci.yml` on `main` explicitly
   after a verified merge.

## 8. How to prove the path works

1. Positive: open a pull request whose three gates all pass. Expect the referee to log
   `REFEREE_VERIFIED`, the controller to log `MERGE_ELIGIBILITY eligible=true`, then
   `MERGE_VERIFIED` with a merge commit SHA, and the pull request page to show merged.
2. Negative: a pull request with a deliberately failing PostgreSQL integration job must stay
   unmerged. Expect the controller to log
   `MERGE_ELIGIBILITY eligible=false reasons=unsuccessful_workflow:ST Production House CI:failure`
   and to perform no merge, even when the referee's own suite is green.
3. Referee: confirm its run contains no merge step and that its token cannot merge.
4. Record the run URL. Without it, nothing here is proven.

## 9. Known limits

- The static tests check the workflow contract, not GitHub's behaviour. A green `npm test` does
  not mean a merge succeeded.
- Repository settings in §7 are outside the repository; a correct workflow can still be
  blocked by them.
- `gh` credentials are not available to this checkout, so pull-request inventory and run
  history must be read by the owner or by a token-bearing environment.
- The PostgreSQL integration job's failure log is not retrievable from this workspace (payload
  truncation); the original CI failure remains open until it is re-run against the
  merged-main tree with the full step log captured.
