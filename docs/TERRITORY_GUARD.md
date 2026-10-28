# Repository Territory Guard — Runbook

The repository hosts two deliberately coexisting territories since the Phase 0
recovery (issue #245):

| Territory | Owner | Paths |
|---|---|---|
| **Node.js control plane** | backend / automation lifecycle | `package.json`, `package-lock.json`, `server.js`, `eslint.config.js`, `src/**`, `tests/**`, `sql/**`, `automation/**`, `scripts/**`, `public/**`, `specs/**` |
| **Android application** | owner console client | `app/**`, root Gradle config (`build.gradle.kts`, `settings.gradle.kts`, `gradle*`), app resources |

Shared, review-gated by both sides (not guarded): `docs/**`, `README.md`,
`.github/**`, `.env*` templates.

## Why the guard exists

Commit `6161dd8` (a Google AI Studio sync whose subject described only a
motion-stage removal) deleted ~330 backend paths — the whole Node engine,
31 SQL migrations, both package manifests, and automation backend — while
adding the Android app. PR #244's merge kept only 8 backend files, CI failed
on missing imports and a missing lockfile, and the failure was not covered by
the commit message. `docs/audit/PHASE0_RECOVERY_DECISION.md` records the full
archaeology; the backend was restored from `f553ca8` in issue #245.

The guard makes that class of silent sweep **fail CI** instead of ending up in
`main`.

## How it works

- `.github/scripts/territory-guard.mjs` compares `base..head` trees on pull
  requests and dispatch events (first CI job, `.github/workflows/ci.yml`,
  `needs`-gated before lint/tests).
- Any **deletion** under a protected root file or dotted prefix fails the run
  and lists every offending path with a message naming the boundary doc.
- **Modifications** of protected paths are not trapped by this guard; they are
  protected by normal review plus the restored verification gates
  (`npm test`, `npm run verify`, `npm run lint`).
- Pure decision logic is exported and unit-tested in
  `tests/territoryGuard.test.js` (prohibited deletion, app-only changes,
  approved deletion, placeholder approvals, wildcard rejection, mixed cases).

## Legitimate, reviewed deletions (the escape hatch)

To remove or migrate a protected path legitimately:

1. Land the replacement/transition code in the same PR.
2. Add an entry to `automation/territory/approved-deletions.json`:
   `{ "path": "…", "reason": "…", "approvedBy": "…", "approvedOn": "<ISO date>" }`.
   Every field must be a non-empty string: placeholder or partial entries are
   ignored by the guard and keep the deletion blocked. Approvals match
   exact paths only — no wildcards.
3. Reference this runbook and the motivating issue in the PR body; the owner
   reviews the approval entry as part of the review.

The approved-deletions file is itself guarded (`automation/**`), so an
Android-only sync cannot edit it without an explicitly reviewed backend
change.

## Recovery procedure (if a sweep reaches `main` despite all gates)

1. Identify the deleting commit: `git log --diff-filter=D -- <path>`.
2. Restore the exact historical tree: `git checkout <last-coherent-sha> -- <paths>`
   (Phase 0 used `f553ca8`; see `docs/audit/PHASE0_RECOVERY_DECISION.md` §1).
3. Re-run the verification gates listed below and reconcile
   `automation/backlog/lifecycle.json` with `automation/backlog/slices.json`.
4. Open a regression-recovery issue (never silently reuse closed issues) and a
   single recovery PR, as in issue #245.

## Verification commands

```
node .github/scripts/territory-guard.mjs --base <base-ref> <head-ref>   # exit 0 = territory respected
node --test --test-concurrency=1 tests/territoryGuard.test.js           # guard decision logic
npm test && npm run lint && npm run verify                              # restored repo gates
```
