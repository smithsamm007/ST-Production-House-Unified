# Operations Health Manifest and Truthful Scheduled Self-Audit

> Status: implemented (offline audit only). This slice reports the truth
> about workflow readiness; it does not configure credentials, start
> workflows, or contact providers. Missing credentials are reported as
> PAUSED — never as success (AGENTS.md Rules 1–3).

## Purpose

Module 28 offline portion: the repository can now answer, with durable
evidence, **which of its autonomous workflows are actually runnable right
now** — the basis for any future claim of 24×7 cloud operation.

## Components

### `automation/operations/health-manifest.json`

The manifest lists every autonomous workflow (18 total) with:

- `workflowId` — stable identifier
- `path` — the workflow file (unique)
- `requiredSecrets` — the EXTERNAL secrets the workflow requires, as
  verified from each workflow file's actual `secrets.*` usage. The
  runner-provided `GITHUB_TOKEN` is deliberately never listed (listing it
  would fabricate a PAUSED state).
- `critical` — whether the governed loop depends on it
- `description`

A test cross-checks the manifest against the workflows actually present on
disk (coverage must be exact) and against sample secret usage.

### `src/operations/healthManifest.js` (pure module)

- `validateHealthManifest` — schema validation with stable error codes
  (`HEALTH_MANIFEST_*`, `HEALTH_WORKFLOW_*`); fail-closed, no mutation.
- `deriveConfiguredSecrets(manifest, env)` — returns sorted required-secret
  **names** that are present and non-empty. Values are never returned,
  logged, or serialized (Rule 17).
- `classifyWorkflowReadiness(workflow, configuredSecrets)` — one workflow is
  either `RUNNABLE` (all required external secrets configured) or `PAUSED`
  (with the exact missing names). No third "assumed available" state.
- `buildHealthReport(manifest, configuredSecrets, { generatedAt, environment })`
  — deterministic full report; the timestamp is injected by the caller (the
  module uses no clock).

### `.github/scripts/operations-health-audit.mjs` (runner)

Loads and validates the manifest, classifies workflows from the real
environment, writes `automation/operations/health-report.json` (uploaded as
the `operations-health-report` artifact, 30-day retention), and renders a
truthful step summary table. Exits non-zero only on manifest/environment
corruption — PAUSED findings are truthful states, not audit failures. The
machine verdict line reports `runnable`, `paused`, and `criticalPaused`
counts; it never fabricates an `ok`.

### `.github/workflows/operations-health.yml` (schedule)

Hourly self-audit (`cron '23 * * * *'`, offset from the other scheduled
workflows) plus `workflow_dispatch`. Passes the required secret **values**
only into the environment mapping (the audit reads presence, never prints
values) and uploads the report artifact even on failure.

## Truthfulness boundaries

1. PAUSED is reported with exact missing secret names; availability is never
   assumed from configuration files alone.
2. Secret values are never read into the report, logs, or summary.
3. The audit does not start, trigger, or repair workflows; it reports only.
4. No provider calls, no network I/O outside the Actions runner itself.

## Verification

`tests/healthManifest.test.js` (12 tests) covers: valid-manifest pass-through
without mutation, the full stable-code rejection matrix, name-only secret
derivation (with hostile env rejection), RUNNABLE/PAUSED classification,
deterministic report building with injected timestamp validation, and three
repository-level tests proving the real manifest exactly covers the workflow
files on disk, matches sample secret usage, and never lists builtin secrets.

Evidence from this slice: `npm test` 540/540 passing (12 new),
`npm run verify`, `npm run lint`, and `npm run plan:check` all pass on the
slice branch.
