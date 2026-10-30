# Phase 0 — Backend Recovery Decision Paper (2026-10-27)

Status: PAPER (decision requested from owner). Uncommitted; delivery belongs
to the Changes panel. Companion to `docs/audit/ANDROID_APP_AUDIT.md` and the
owner's 27 October daily progress report. Every fact in this paper was
re-verified against `main` (`5ba62d9`) and git history today, 27 October 2026.

---

## 1. Commit archaeology — exactly what happened

| Hash | Author & date | What it actually contains |
|---|---|---|
| `59a2a5f` → `f553ca8` | Oct 22 (PRs #238, #240, #242, #243-commits) | **Last healthy state.** 321 tracked files under `src/ tests/ sql/`, `package.json` + `package-lock.json` (deps: `pg`, `express`, `argon2`, dev `supertest`), full test matrix, `npm run verify`, scripts, `sql/001–031`, automation backlog + lifecycle, public dashboard. Last verified-green main CI run (Oct 21, run 39661222981) predates only the motion/completeness additions. |
| `f553ca8` | Oct 22 15:05 UTC | Adds S-M41-01 episode-completeness gate (new src + 4 test files). Backend still complete. |
| `6161dd8` | Oct 25 22:50 IST, authored by owner (Google AI Studio sync) | Subject says only *"refactor: remove local motion stage and update env"*. Actual diff: **305 files changed, 86,635 lines deleted** — every `src/` module except none retained, all 31 SQL migrations, both package manifests, `server.js`, `public/dashboard.js`, all scripts, `automation/backlog/*` backend, `specs/`, eslint config — plus the entire Android app (`app/**`, 21 screens, Gradle) added. |
| `390a77d` | Oct 25 17:26 UTC | PR-branch (`task/243-…`) merged `origin/main` into itself; the 6 documented conflict resolutions (`slices.json`, executor docs, 4 backend/test files) keep only the completeness-gate slice on top of the AI-Studio tree. |
| `5ba62d9` | Oct 25 17:27 UTC | Merge PR #244 "anyway" per owner instruction at the time. **Tree = Android app + 8 surviving backend files** (2 in `src/media/`, 6 in `tests/`). |

### Survivors on current main (verified `ls`/`git ls-tree`)

- `src/media/episodeCompleteness.js`, `src/media/ffmpegAssemblyExecutor.js`
- `tests/`: `assemblyCompletenessReal`, `episodeCompleteness`, `executorPipelineIntegration`, `ffmpegAssemblyExecutor`, `motionPipelineBinding`, `productionExecutorRunner`

**None of the 6 test files can run.** Verified import scan: `executorPipelineIntegration.test.js` imports ≥12 deleted modules (`episodePipeline`, `executorIntegration`, `demoStorageAdapter`, `artifactDescriptor`, `ttsAdapter`, `visualAdapter`, `assemblyPlan`, `motionStage`, …); the others reference `pg`/express-era contracts. There is no `package.json`, so the CI "dependency lockfile not found" failure is structural, not transient.

This matches the daily report's §1/§7 facts exactly (src: 2 files, tests: 6 files, no manifests, `lifecycle.json` absent; only `automation/backlog/slices.json` survives, restored by the PR-#244 merge).

## 2. Intentional vs accidental — the reconciliation the report asked for

- **Intentional (owner-stated):** the main pivot to the **Android app** ("Main pivot: Android was intentional"; PR #244 merged with owner approval). The UI replacement is not a regression.
- **Not stated anywhere:** the commit whose message describes only a *motion-stage* removal deleting the **entire Node engine**. Nothing in the commit body, docs, or issue tracker records that decision or its consequences (CI imports, missing manifest, dead automation feeder). Three GitHub Actions pipelines (feeder run 40531679548, health audit run 40511505471, dev pipeline run 40527897330) fail precisely because files they import were deleted in the same commit that added the app.
- **Classification:** UI pivot = intentional; backend deletion = **an undocumented side effect of the AI-Studio sync that must now be explicitly ratified or rolled back**. "Accidentally lost" vs "intentionally removed" is not resolvable from the artifacts — that is exactly what this paper asks the owner to decide.

## 3. Options

### Option A — Android client over the restored Node control plane (recommended)

Recover `f553ca8`'s engine additively beneath the Android app and make the app its authenticated client (the audit's F6 showed the Compose entities already mirror the Node contracts: 4-slot 1+2+1 package, 8-stage enum, job statuses, cap-50 catalogue, Rule-7 approval fields).

- Cost: mostly mechanical restore (`git checkout f553ca8 -- src tests sql …` style, file-by-file review rather than blind bulk), plus re-adding 2 manifests + 2 automation JSONs + 3 workflow-imported modules (`src/orchestration/roadmapParser.js`, `src/automation/backlogFeeder.js`, `src/operations/healthManifest.js`) and `automation/validate-plan.mjs`.
- Tests: the ~150-unit + 19-suite integration matrix authored in history comes back with it; verification is running it, not rewriting it.
- Risk: revision of the owner's earlier "merge anyway" stance; requires an explicit AI-Studio sync territory rule (next AI-Studio push must touch `app/**` only) or the same sweep recurs.
- Benefit: stops CI bleeding today, keeps the largest working asset in the history alive, restores the governed backlog so the autonomous pipeline has an eligible READY issue, and gives the Android app a real backend to bind to (honest Option from the audit).

### Option B — Ratify the deletion: Kotlin-only repo, rebuilt backend planned fresh

- The Android prototype stays, but per its own audit it is a mock-layer UI with no network; "production readiness" becomes a greenfield build while a verified engine sits deprecated in history.
- CI, feeder, health audit and the governed backlog stay broken or get disabled by editing workflows to match reality; the automation estate (10 workflows, multi-agent governance) loses its purpose.
- Cost is not avoided — it is re-inferred later, against the same history.

**Recommendation: Option A**, in one governed recovery PR under a new, narrowly scoped regression-recovery issue (report §5's exact ask). Do **not** reopen closed issues (#236/#243 stay closed); do not touch `app/**`; `docs/audit/**` documents the rationale.

## 4. The recovery slice (P0 → P1 of the daily report, concretized)

1. New issue: *"Regression recovery: restore Node control plane deleted in 6161dd8; make Android repo additive"* — branch `task/<n>-backend-recovery`.
2. Restore from `f553ca8`: `package.json`, `package-lock.json`, `eslint.config.js`, `automation/validate-plan.mjs`, `automation/backlog/lifecycle.json`, `automation/operations/health-manifest.json`, and the full `src/ tests/ sql/ specs/ scripts/ public/ server.js` tree (excluding nothing app-side; `app/**`, `gradle*`, `settings.gradle.kts`, `build.gradle.kts`, `.gradle/` untouched).
3. Restore the three modules the workflows import (already inside the `src/` restore) and re-run: `npm ci`, `npm test`, `npm run lint`, `npm run verify`, `npm run plan:check` — paste real output in the PR body (R6). Integration suites run where Postgres is available.
4. Reconcile `automation/backlog/slices.json` (survivor, PR-#244 version) against `f553ca8`'s version + lifecycle.json; keep the merged superset, do not silently drop entries.
5. Territorial guard: extend the repo-lint/backlog checks so a sync that deletes protected paths (`package.json`, `src/**`, `sql/**`, `automation/**`) fails the PR with a human-readable message. This is the regression guard the report's P1 asks for and prevents recurrence of a 6161dd8-style sweep.
6. Docs in the same PR (R7): ROADMAP.md "Current Baseline" corrected to reflect the restored engine; README either split (Node backend + Android client) or amended with the backend restore note.

## 5. Decision requested from owner

- [ ] Ratify Option A (recommended) or B.
- [ ] For A: approve the recovery PR scope in §4 and the AI-Studio territory rule (`app/**` only for future AI-Studio syncs).
- [ ] Confirm that historical close-state of #236/#243 is not reopened; recovery is tracked under the new issue.

No provider credentials, live publishing, or paid services are touched by this slice; owner-gated work stays under issue #118 as the report requires.
