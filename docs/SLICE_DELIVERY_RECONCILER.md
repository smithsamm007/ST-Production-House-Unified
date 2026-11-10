# Slice Delivery Reconciler

> Status: implemented (pure planner + governed runner). Opens pull requests and
> dispatches gates. It never merges, never closes a branch, and never records a
> slice as complete.

## The gap it closes

The governed loop was complete except at one joint. `pr-gate.yml`,
`autonomous-merge.yml` and `exact-head-merge.yml` all trigger on
`pull_request` events, and `night-shift.yml` opens pull requests only for work
it implements itself. A slice whose code already sits on a verified branch
therefore reached **no** gate: it could not merge, and the loop could not
report it as delivered. The same blind spot let duplicate branches accumulate
for one slice — two competing implementations of the same slice were opened
under #265 and #266 with nothing in the loop able to reconcile them.

`slice-delivery.yml` observes real state, decides which single pull request is
legitimate to open, opens it, and dispatches the existing exact-head gates so
the governed merge path finishes the work.

## Components

| Component | Role |
|---|---|
| `src/automation/sliceDelivery.js` | Pure planner: branch candidates, canonical selection, ambiguity detection, verdicts. No I/O, no clocks, no randomness |
| `.github/scripts/slice-delivery-reconciler.mjs` | The only component with GitHub side effects: opens one pull request and dispatches CI, PR Gate and the Merge Referee on the exact head |
| `.github/workflows/slice-delivery.yml` | Hourly schedule + `workflow_dispatch` (with `dry_run`), uploads `slice-delivery-report` |

## Decisions and their guarantees

1. **Owner-gated slices are never actionable.** Slices with
   `ownerGated: true` in `automation/backlog/slices.json` report
   `OWNER_ACTION_REQUIRED` even when a branch for them exists (AGENTS.md Rules
   7, 16, 17).
2. **One pull request in flight.** While any pull request whose head is a
   governed `task/<issue#>-…` branch is open, every other slice is held with
   `HOLD_ONE_PULL_REQUEST_IN_FLIGHT`. Unrelated or human branches never trip
   the rule.
3. **A single candidate is always canonical.** Several candidates are only
   resolved when exactly one carries verification evidence — a successful
   `ST Production House CI` run on that exact head SHA.
4. **Two implementations are never chosen automatically.** Two verified
   candidates produce `AMBIGUOUS_CANONICAL_BRANCH` (`MULTIPLE_VERIFIED_CANDIDATES`);
   several unverified ones produce the same action with
   `MULTIPLE_UNVERIFIED_CANDIDATES`. Automation does not discard someone's
   implementation to break a tie; the owner decides.
5. **Two open pull requests for one slice are reported, not closed.**
   `AMBIGUOUS_DUPLICATE_PULL_REQUESTS` names both numbers. Closing another
   author's pull request is not a decision this runner is entitled to make.
6. **Branches are never deleted or force-pushed.** The runner only fetches
   (`+refs/heads/*:refs/remotes/origin/*`) and opens a pull request.
7. **Nothing here merges.** After opening a pull request the runner dispatches
   `ci.yml`, `pr-gate.yml` and `autonomous-merge.yml` for the exact head and
   stops. Merging remains the exclusive job of the merge referee and the
   exact-head merge controller.
8. **Completion is never claimed here.** A slice becomes `ALREADY_MERGED` only
   when its id is present in `automation/backlog/lifecycle.json`, which the
   backlog feeder writes on an issue closed as completed.

## Verdicts

| Verdict | Meaning |
|---|---|
| `AUTOMATABLE_COMPLETE` | Every non-owner-gated slice in the manifest is recorded as merged |
| `WORK_REMAINING` | At least one automatable slice is unmerged (awaiting promotion, implementation, a pull request, or an owner decision) |

`AUTOMATABLE_COMPLETE` is **not** a claim that the product is operational. It
says only that no automatable slice remains, and the report lists
`ownerGatedRemaining` — the slices that need credentials, OAuth grants,
publishing approval or analytics scopes from the owner. Launch readiness is a
separate, owner-gated judgement.

## Pull request titles and bodies

Squash-merges turn the pull request title into the commit subject, so the title
is taken verbatim from the branch's first commit subject when it is a
conventional commit; otherwise it falls back to
`chore(automation): deliver <slice> — <issue title>`. The body always carries
`Closes #<issue>` and states plainly that it contains **no pasted test output**,
because the reconciler cannot run the suite before the pull request exists. The
dispatched exact-head runs are the authoritative evidence, and the pull request
merges only if they pass.

## Usage

```bash
# plan only, no side effects
node .github/scripts/slice-delivery-reconciler.mjs --dry-run

# live (what the workflow runs)
node .github/scripts/slice-delivery-reconciler.mjs
```

The report is written to git-ignored
`artifacts/automation/slice-delivery-report.json` and uploaded as the
`slice-delivery-report` artifact. Structured log codes:
`SLICE_DELIVERY_REPORT`, `SLICE_DELIVERY_DRY_RUN`,
`SLICE_DELIVERY_PULL_REQUEST_OPENED`, `SLICE_DELIVERY_GATE_DISPATCHED`,
`SLICE_DELIVERY_ACTION_FAILED`, plus one `SLICE_DELIVERY_<ACTION>` per slice.

## Verification

- `node --test tests/sliceDelivery.test.js` — planner, ambiguity, one-PR rule,
  owner-gating and verdict coverage
- `npm run lint` — syntax and contract rules, including the new workflow and runner
- `automation/operations/health-manifest.json` registers the workflow, so the
  operations health audit classifies it like every other autonomous workflow

## Known limits

- The workflow needs `pull-requests: write` and `actions: write` on the
  runner-provided token; on a fork, or with Actions disabled, it reports
  `SLICE_DELIVERY_ACTION_FAILED` rather than pretending to deliver.
- Verification evidence is recognised only from a successful
  `ST Production House CI` run on the exact head SHA. A branch verified only
  locally counts as unverified, which is what makes competing branches
  ambiguous rather than silently tie-broken.
- The reconciler cannot manufacture owner credentials: the four LIVE slices stay
  `OWNER_ACTION_REQUIRED` until the owner supplies them.
