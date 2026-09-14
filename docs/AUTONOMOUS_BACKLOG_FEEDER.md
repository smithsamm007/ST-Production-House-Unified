# Autonomous Backlog Feeder

> Status: implemented (deterministic planner + governed runner). This slice
> closes the loop between the roadmap and the autonomous coding lanes. It
> performs no provider calls, no media generation, and no publication.

## Problem it solves

The repository already ships the full autonomous machinery — three-lane Night
Shift coder, Awake Resume controller, CI + PR Gate + Autonomous Merge Referee,
and the Jules bridge/watchdogs. A 2026-09 audit found the loop was **starved**:
Night Shift's scheduled runs completed in ~20 seconds with "Ready queue empty"
because nothing converted the roadmap backlog into `ready` + lane-labeled
issues. Two latent first-dispatch failures were also found (missing
`in-progress`/`autopilot` labels; no coding-credential preflight).

## Components

| Component | Role |
|---|---|
| `automation/backlog/slices.json` | Machine-readable governed slice backlog (source of truth for what the loop may pick up) |
| `src/automation/backlogFeeder.js` | Pure module: manifest validation, deterministic promotion planning, issue payload construction. Offline, no I/O |
| `.github/scripts/backlog-feeder.mjs` | The ONLY component with GitHub side effects: creates/promotes/re-feeds slice issues idempotently |
| `.github/workflows/backlog-feeder.yml` | Runs the feeder every 3 hours and on every issue close (the closed-loop trigger) |
| `automation/backlog/lifecycle.json` | Append-only record of completed slice ids (created on first completion) |
| `night-shift.yml` (patched) | Truthful credential preflight; governance labels ensured before first dispatch |

## Promotion rules (fail-closed)

1. **Owner-gated slices are never auto-promoted.** Slices with
   `ownerGated: true` (live provider credentials, OAuth, publishing
   enablement, analytics) are surfaced on a `[BACKLOG]` tracking issue as
   `OWNER_ACTION_REQUIRED`. This encodes AGENTS.md Rules 7, 16, and 17.
2. **Deterministic planning.** Identical observed state produces identical
   promotion decisions. No clocks or randomness in the planner.
3. **Lane concurrency.** At most one in-flight slice per lane and a bounded
   total of open ready issues (`limits` block of the manifest).
4. **Dependency gating.** A slice is promotable only when every `dependsOn`
   slice is recorded as completed in `lifecycle.json`. Forward references are
   structurally impossible (dependencies must be declared earlier in the
   manifest), so cycles cannot be expressed.
5. **Idempotency.** Issues carry a `[S-XX-NN]` title tag; the runner detects
   existing tagged issues before creating duplicates, including a re-check
   immediately before creation to survive schedule/event races.
6. **Honest close handling.** On issue close:
   - `completed` → the slice id is appended to `lifecycle.json` (dependents
     become eligible) and the change is committed by the workflow.
   - any other close reason → the issue is re-labeled `ready` with a comment;
     **no dependency credit is recorded** and nothing is claimed complete.
7. **Rule 15.** Internal agent names are rejected in promotable issue text.
8. **Rule 17.** The manifest and payloads never carry secrets or locators.

## Workflow loop (end-to-end)

```
backlog-feeder (cron 3h / issue closed)
  → validates manifest
  → observes open ready+lane issues, existing tagged issues, lifecycle
  → creates governed issues for promotable slices
  → night-shift lane claims a ready issue (credential preflight first)
  → aider implements → npm test + npm run verify on the exact tree
  → draft PR opened ready, lane + autopilot labels
  → ci.yml + pr-gate.yml + autonomous-merge.yml (exact-head)
  → merge referee merges after all gates pass
  → issue auto-closes (Closes #N) → issue-closed event re-triggers feeder
  → feeder records completion in lifecycle.json → dependents become eligible
```

## Lifecycle file

`automation/backlog/lifecycle.json` is written by the runner when a slice
issue closes as completed. It is append-only in spirit: the runner only adds
ids. If the file is absent, the loop starts with an empty history (no slice
is treated as completed without the closed-issue evidence).

## Verification

- `node --test tests/backlogFeeder.test.js` — 13 unit tests
- `npm test` — full suite green (465 tests at merge time)
- `npm run verify`, `npm run lint`, `npm run plan:check` — pass
