/**
 * ST Production House — Cloud operations health manifest (S-M28-01, Module 28).
 *
 * Pure, offline components for the scheduled truthful self-audit:
 *
 * 1. `validateHealthManifest` — schema-validates
 *    `automation/operations/health-manifest.json` with stable error codes.
 *    The manifest lists every autonomous workflow and the EXTERNAL secrets it
 *    requires (verified from the workflow files' actual `secrets.*` usage).
 *    The built-in `GITHUB_TOKEN` is deliberately not listable: it is always
 *    provided by the runner, and listing it would fabricate a PAUSED state.
 *
 * 2. `deriveConfiguredSecrets` — given an environment object, returns the
 *    sorted names of the manifest's required secrets that are present and
 *    non-empty. Only NAMES are returned; values are never read, logged, or
 *    serialized.
 *
 * 3. `classifyWorkflowReadiness` / `buildHealthReport` — deterministic
 *    classification: every workflow is either `RUNNABLE` (all required
 *    external secrets configured) or `PAUSED` (missing credentials). There is
 *    no third "assumed available" state and no fabricated availability
 *    (AGENTS.md Rules 1–3): a missing credential is reported as PAUSED,
 *    never as success.
 *
 * No provider calls, no network I/O, no filesystem access, no clocks:
 * `generatedAt` is injected by the caller for determinism.
 */

const SCHEMA_VERSION = 1;
const MANIFEST_TYPE = "st_health_manifest";
const BUILTIN_SECRETS = new Set(["GITHUB_TOKEN", "GH_TOKEN", "GH_REPO"]);
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const WORKFLOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PATH_RE = /^\.github\/workflows\/[a-zA-Z0-9._-]+\.yml$/;

const MAX_WORKFLOWS = 100;
const MAX_SECRETS_PER_WORKFLOW = 10;

function auditError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw auditError(code);
  }
}

function requireString(value, code, max, pattern) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw auditError(code);
  }
  if (pattern && !pattern.test(value)) throw auditError(code);
  return value;
}

/**
 * Validates the health manifest shape. Throws a stable-coded error on the
 * first violation; returns the manifest unchanged on success (no mutation).
 */
export function validateHealthManifest(manifest) {
  requirePlainObject(manifest, "HEALTH_MANIFEST_INVALID");

  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw auditError("HEALTH_MANIFEST_SCHEMA_UNSUPPORTED");
  }
  if (manifest.manifestType !== MANIFEST_TYPE) {
    throw auditError("HEALTH_MANIFEST_TYPE_MISMATCH");
  }
  requireString(manifest.description, "HEALTH_MANIFEST_DESCRIPTION_INVALID", 2000);

  if (!Array.isArray(manifest.workflows) || manifest.workflows.length === 0 || manifest.workflows.length > MAX_WORKFLOWS) {
    throw auditError("HEALTH_MANIFEST_WORKFLOWS_INVALID");
  }

  const seenIds = new Set();
  const seenPaths = new Set();
  for (const workflow of manifest.workflows) {
    requirePlainObject(workflow, "HEALTH_WORKFLOW_INVALID");

    const id = requireString(workflow.workflowId, "HEALTH_WORKFLOW_ID_INVALID", 80, WORKFLOW_ID_RE);
    if (seenIds.has(id)) throw auditError("HEALTH_WORKFLOW_DUPLICATE_ID");
    seenIds.add(id);

    const path = requireString(workflow.path, "HEALTH_WORKFLOW_PATH_INVALID", 120, PATH_RE);
    if (seenPaths.has(path)) throw auditError("HEALTH_WORKFLOW_DUPLICATE_PATH");
    seenPaths.add(path);

    if (!Array.isArray(workflow.requiredSecrets) || workflow.requiredSecrets.length > MAX_SECRETS_PER_WORKFLOW) {
      throw auditError("HEALTH_WORKFLOW_SECRETS_INVALID");
    }
    const seenSecrets = new Set();
    for (const secret of workflow.requiredSecrets) {
      requireString(secret, "HEALTH_WORKFLOW_SECRETS_INVALID", 100, SECRET_NAME_RE);
      if (BUILTIN_SECRETS.has(secret)) {
        throw auditError("HEALTH_WORKFLOW_BUILTIN_SECRET_REDUNDANT");
      }
      if (seenSecrets.has(secret)) throw auditError("HEALTH_WORKFLOW_SECRETS_INVALID");
      seenSecrets.add(secret);
    }

    if (typeof workflow.critical !== "boolean") {
      throw auditError("HEALTH_WORKFLOW_CRITICAL_INVALID");
    }
    requireString(workflow.description, "HEALTH_WORKFLOW_DESCRIPTION_INVALID", 300);
  }

  return manifest;
}

/**
 * Returns the sorted unique names of manifest-required secrets that are
 * present and non-empty in `env`. Values are never returned or serialized.
 */
export function deriveConfiguredSecrets(manifest, env) {
  validateHealthManifest(manifest);
  if (env === null || typeof env !== "object") {
    throw auditError("HEALTH_ENV_INVALID");
  }
  const names = new Set();
  for (const workflow of manifest.workflows) {
    for (const secret of workflow.requiredSecrets) {
      const value = env[secret];
      if (typeof value === "string" && value.length > 0) {
        names.add(secret);
      }
    }
  }
  return Object.freeze([...names].sort());
}

/**
 * Classifies one workflow truthfully: RUNNABLE when every required external
 * secret is configured, PAUSED otherwise (with the exact missing names).
 */
export function classifyWorkflowReadiness(workflow, configuredSecrets) {
  requirePlainObject(workflow, "HEALTH_WORKFLOW_INVALID");
  if (!Array.isArray(configuredSecrets)) {
    throw auditError("HEALTH_CONFIGURED_SECRETS_INVALID");
  }
  const configured = new Set(configuredSecrets);
  const missingSecrets = workflow.requiredSecrets.filter((secret) => !configured.has(secret));
  return {
    workflowId: workflow.workflowId,
    path: workflow.path,
    critical: workflow.critical,
    requiredSecrets: [...workflow.requiredSecrets],
    missingSecrets,
    status: missingSecrets.length === 0 ? "RUNNABLE" : "PAUSED",
  };
}

/**
 * Builds the full deterministic health report. `generatedAt` must be an
 * ISO-8601 string supplied by the caller (the runner injects the run time);
 * this module itself uses no clock, so identical inputs yield identical
 * reports apart from that field.
 */
export function buildHealthReport(manifest, configuredSecrets, { generatedAt, environment = "unknown" } = {}) {
  validateHealthManifest(manifest);
  if (typeof generatedAt !== "string" || Number.isNaN(new Date(generatedAt).getTime())) {
    throw auditError("HEALTH_REPORT_TIMESTAMP_INVALID");
  }
  const workflows = manifest.workflows.map((workflow) => classifyWorkflowReadiness(workflow, configuredSecrets));
  const runnable = workflows.filter((entry) => entry.status === "RUNNABLE").length;
  const paused = workflows.length - runnable;
  return {
    manifestType: MANIFEST_TYPE,
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    environment,
    summary: { total: workflows.length, runnable, paused },
    workflows,
  };
}

export const HEALTH_MANIFEST_TYPE = MANIFEST_TYPE;
export const HEALTH_SCHEMA_VERSION = SCHEMA_VERSION;
