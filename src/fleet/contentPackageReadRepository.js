/**
 * ST Production House — durable Owner read model for content package runs.
 *
 * Backlog slice S-M18-01 (Module 18 owner-dashboard surface, part 1).
 *
 * A "content package run" is the canonical durable unit of production: one
 * `director_projects` row owned by one Director, whose `director_tasks` rows are
 * the ordered production stages (RESEARCH … PACKAGE … PUBLISHING) and whose
 * `director_task_evidence` rows are the stage evidence. Nothing here invents a
 * second execution system, a parallel evidence ledger or synthetic records:
 * every field is projected from those four tables (plus `director_fleet` and
 * `director_workers` for identity and runtime state).
 *
 * Truthfulness rules enforced in this module:
 *   * a COMPLETED task never implies a completed package, and neither implies a
 *     published artifact;
 *   * `productionVerified` is only true for PRODUCTION_VERIFIED evidence that is
 *     not a test fixture and was recorded in the PRODUCTION environment;
 *   * fixtures are labelled (`testFixture: true`) and never upgraded;
 *   * arbitrary payloads, free-text errors, secret-shaped values and filesystem
 *     paths are never serialized — only explicit allowlists leave this module;
 *   * missing evidence stays missing (empty timeline, package NOT_SCHEDULED).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECTOR_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const HASH = /^[a-f0-9]{64}$/;

export const PROJECT_STATES = Object.freeze(["PLANNED", "IN_PRODUCTION", "COMPLETED", "CANCELLED"]);
export const TASK_STATUSES = Object.freeze([
  "CREATED",
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "BLOCKED",
  "RETRY_SCHEDULED",
  "FAILED",
  "COMPLETED",
  "CANCELLED",
  "DEAD_LETTER",
]);
export const STAGES = Object.freeze([
  "RESEARCH",
  "SCRIPT",
  "CHARACTERS",
  "VISUALS",
  "ANIMATION",
  "VOICE",
  "MUSIC",
  "ASSEMBLY",
  "FFPROBE",
  "QC",
  "PACKAGE",
  "OWNER_APPROVAL",
  "PUBLISHING",
  "ANALYTICS",
]);
export const VERIFICATION_LEVELS = Object.freeze([
  "IMPLEMENTED",
  "UNIT_TESTED",
  "INTEGRATION_TESTED",
  "CI_VERIFIED",
  "PROVIDER_VERIFIED",
  "PRODUCTION_VERIFIED",
  "BLOCKED",
  "NOT_RUN",
]);

const VERIFICATION_RANK = Object.freeze(
  Object.fromEntries(VERIFICATION_LEVELS.map((level, index) => [level, index]))
);

/** Failure codes a worker can record; anything else is reported as unclassified. */
export const KNOWN_FAILURE_CODES = Object.freeze([
  "UNSUPPORTED_STAGE",
  "DEPENDENCY_NOT_SATISFIED",
  "REQUIRED_EVIDENCE_MISSING",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "OWNER_APPROVAL_REQUIRED",
  "STAGE_INPUT_INVALID",
  "STAGE_OUTPUT_INVALID",
  "STAGE_EXECUTION_FAILED",
  "STAGE_TIMEOUT",
  "LEASE_LOST",
  "TASK_CANCELLED",
  "SECRET_MATERIAL_REJECTED",
]);

const PROVIDER_FAILURE_CODES = Object.freeze(["PROVIDER_NOT_CONFIGURED", "PROVIDER_QUOTA_EXHAUSTED"]);
const TRANSIENT_FAILURE_CODES = Object.freeze(["LEASE_LOST", "STAGE_TIMEOUT", "STAGE_EXECUTION_FAILED"]);

/** Blocked reasons the runtime writes; free text is never echoed. */
const KNOWN_BLOCKED_REASONS = Object.freeze([
  "RETRY_EXHAUSTED",
  "DEPENDENCY_NOT_SATISFIED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_QUOTA_EXHAUSTED",
  "OWNER_APPROVAL_REQUIRED",
  "CANCELLED",
  "SUSPENDED",
]);

const REF_SCHEMES = Object.freeze(["director-stage", "artifact", "sha256", "evidence"]);

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export class ContentPackageQueryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ContentPackageQueryError";
    this.code = code;
    this.status = status;
  }
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function assertEnum(value, allowed, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ContentPackageQueryError("QUERY_INVALID", `${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function parseTimestamp(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ContentPackageQueryError("QUERY_INVALID", `${field} must be an ISO-8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ContentPackageQueryError("QUERY_INVALID", `${field} must be an ISO-8601 timestamp.`);
  }
  return parsed.toISOString();
}

export function parseLimit(value, { fallback = DEFAULT_LIMIT } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) {
    throw new ContentPackageQueryError("QUERY_INVALID", `limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new ContentPackageQueryError("QUERY_INVALID", `limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return parsed;
}

/**
 * PostgreSQL timestamps carry microseconds; a JS Date only keeps milliseconds.
 * Callers pass the database's own ISO text (`cursor_time`) so a keyset page can
 * never skip a row that shares the same millisecond.
 */
export function encodeCursor(occurredAt, id) {
  const time =
    typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt))
      ? occurredAt
      : toIso(occurredAt);
  if (!time || typeof id !== "string" || !UUID.test(id)) {
    throw new ContentPackageQueryError("CURSOR_INVALID", "The pagination cursor is not valid.");
  }
  return Buffer.from(JSON.stringify({ t: time, id }), "utf8").toString("base64url");
}

export function decodeCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length < 8 || value.length > 400) {
    throw new ContentPackageQueryError("CURSOR_INVALID", "The pagination cursor is not valid.");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new ContentPackageQueryError("CURSOR_INVALID", "The pagination cursor is not valid.");
  }
  const time = typeof parsed?.t === "string" ? new Date(parsed.t) : null;
  if (!time || !Number.isFinite(time.getTime()) || typeof parsed?.id !== "string" || !UUID.test(parsed.id)) {
    throw new ContentPackageQueryError("CURSOR_INVALID", "The pagination cursor is not valid.");
  }
  return { time: parsed.t, id: parsed.id };
}

export function parseRunFilters(query = {}) {
  const directorId = query.directorId;
  if (directorId !== undefined && directorId !== null && directorId !== "") {
    if (typeof directorId !== "string" || !DIRECTOR_ID.test(directorId)) {
      throw new ContentPackageQueryError("QUERY_INVALID", "directorId is not a valid Director id.");
    }
  }
  const from = parseTimestamp(query.from, "from");
  const to = parseTimestamp(query.to, "to");
  if (from && to && from > to) {
    throw new ContentPackageQueryError("QUERY_INVALID", "from must not be later than to.");
  }
  return Object.freeze({
    directorId: directorId ? directorId : null,
    state: assertEnum(query.state, PROJECT_STATES, "state"),
    stage: assertEnum(query.stage, STAGES, "stage"),
    taskStatus: assertEnum(query.taskStatus, TASK_STATUSES, "taskStatus"),
    from,
    to,
    limit: parseLimit(query.limit),
    cursor: decodeCursor(query.cursor),
  });
}

export function parseEvidenceFilters(query = {}) {
  return Object.freeze({
    stage: assertEnum(query.stage, STAGES, "stage"),
    verificationLevel: assertEnum(query.verificationLevel, VERIFICATION_LEVELS, "verificationLevel"),
    includeTestFixtures: !(query.includeTestFixtures === "false" || query.includeTestFixtures === false),
    limit: parseLimit(query.limit, { fallback: 50 }),
    cursor: decodeCursor(query.cursor),
  });
}

/** Only opaque, scheme-qualified references survive; paths and secrets do not. */
export function sanitizeRefs(values) {
  const refs = [];
  let omitted = 0;
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string" || value.length === 0 || value.length > 300) {
      omitted += 1;
      continue;
    }
    const match = /^([a-z][a-z0-9+.-]*):/.exec(value);
    const safe = match &&
      REF_SCHEMES.includes(match[1]) &&
      !/\s/.test(value) &&
      !value.includes("..") &&
      !value.startsWith("file:");
    if (safe) refs.push(value);
    else omitted += 1;
  }
  return Object.freeze({ refs: Object.freeze(refs), omitted });
}

/**
 * Validation objects recorded by the stage handlers are `{checks|rules: [...]}`.
 * Only the check name and its boolean outcome are serialized; free-text detail
 * can carry a filesystem path, so it is dropped.
 */
export function sanitizeValidation(validation) {
  const source = Array.isArray(validation?.checks)
    ? validation.checks
    : Array.isArray(validation?.rules)
      ? validation.rules
      : [];
  const checks = [];
  let omitted = 0;
  for (const entry of source) {
    if (entry && typeof entry === "object" && typeof entry.name === "string" && typeof entry.passed === "boolean") {
      checks.push(Object.freeze({ name: entry.name.slice(0, 120), passed: entry.passed }));
    } else {
      omitted += 1;
    }
  }
  const failed = checks.filter((check) => !check.passed).length;
  return Object.freeze({
    recorded: source.length > 0,
    checks: Object.freeze(checks),
    passed: checks.length - failed,
    failed,
    omitted,
    outcome: source.length === 0 ? "NOT_RECORDED" : failed === 0 ? "PASSED" : "FAILED",
  });
}

export function failureOf(lastError) {
  if (lastError === undefined || lastError === null || lastError === "") return null;
  const text = String(lastError);
  const code = KNOWN_FAILURE_CODES.find((candidate) => text.includes(candidate));
  if (!code) return Object.freeze({ code: "FAILURE_RECORDED", class: null, providerState: null });
  const failureClass = PROVIDER_FAILURE_CODES.includes(code)
    ? "PROVIDER"
    : TRANSIENT_FAILURE_CODES.includes(code)
      ? "TRANSIENT"
      : "PERMANENT";
  return Object.freeze({ code, class: failureClass, providerState: null });
}

function blockedReasonOf(value) {
  return typeof value === "string" && KNOWN_BLOCKED_REASONS.includes(value) ? value : null;
}

function artifactHashOf(value) {
  return typeof value === "string" && HASH.test(value) ? value : null;
}

function verificationOf(level) {
  return VERIFICATION_LEVELS.includes(level) ? level : "NOT_RUN";
}

function isProductionVerified(row) {
  return (
    verificationOf(row.verification_level) === "PRODUCTION_VERIFIED" &&
    row.test_fixture !== true &&
    row.environment === "PRODUCTION"
  );
}

function isProviderVerified(row) {
  return verificationOf(row.verification_level) === "PROVIDER_VERIFIED" && row.test_fixture !== true;
}

function highestLevel(rows) {
  let best = "NOT_RUN";
  for (const row of rows) {
    const level = verificationOf(row.verification_level);
    if ((VERIFICATION_RANK[level] ?? -1) > (VERIFICATION_RANK[best] ?? -1)) best = level;
  }
  return best;
}

function evidenceSummary(rows) {
  const hashes = new Set();
  let productionVerified = 0;
  let providerVerified = 0;
  let fixtures = 0;
  for (const row of rows) {
    if (row.test_fixture === true) fixtures += 1;
    if (isProductionVerified(row)) productionVerified += 1;
    if (isProviderVerified(row)) providerVerified += 1;
    const hash = artifactHashOf(row.artifact_hash);
    if (hash) hashes.add(hash);
  }
  return Object.freeze({
    total: rows.length,
    fixtures,
    productionVerified,
    providerVerified,
    highestVerificationLevel: highestLevel(rows),
    artifactHashes: Object.freeze([...hashes]),
    fixtureOnly: rows.length > 0 && fixtures === rows.length,
  });
}

function emptyStatusCounts() {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
}

function evidenceEventDto(row) {
  const level = verificationOf(row.verification_level);
  return Object.freeze({
    evidenceId: row.id,
    taskId: row.task_id,
    stage: row.stage,
    evidenceType: row.evidence_type,
    artifactHash: artifactHashOf(row.artifact_hash),
    handlerName: row.handler_name ?? null,
    handlerVersion: row.handler_version ?? null,
    verificationLevel: level,
    environment: row.environment ?? null,
    testFixture: row.test_fixture === true,
    productionVerified: isProductionVerified(row),
    providerVerified: isProviderVerified(row),
    workerKey: row.worker_key ?? null,
    fencingToken: row.fencing_token === null || row.fencing_token === undefined ? null : Number(row.fencing_token),
    validation: sanitizeValidation(row.validation),
    refs: Object.freeze({
      input: sanitizeRefs(row.input_refs),
      output: sanitizeRefs(row.output_refs),
    }),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at),
  });
}

function taskDto(row, { dependencies = [], evidenceRows = [] } = {}) {
  return Object.freeze({
    taskId: row.id,
    stage: row.stage,
    taskType: row.task_type,
    status: row.status,
    priority: Number(row.priority),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    retryScheduled: row.status === "RETRY_SCHEDULED",
    providerState: row.provider_state,
    providerRequirement: row.provider_requirement ?? null,
    blockedReason: blockedReasonOf(row.blocked_reason),
    failure: failureOf(row.last_error),
    cancelRequested: row.cancel_requested === true,
    fencingToken: Number(row.active_fencing_token),
    resultRecorded: row.result_ref !== null && row.result_ref !== undefined,
    worker: row.claimed_worker_key
      ? Object.freeze({
          workerKey: row.claimed_worker_key,
          role: row.worker_role ?? null,
          state: row.worker_state ?? null,
        })
      : null,
    dependencies: Object.freeze([...dependencies]),
    evidence: evidenceSummary(evidenceRows),
    createdAt: toIso(row.created_at),
    assignedAt: toIso(row.assigned_at),
    nextRunAt: toIso(row.next_run_at),
    updatedAt: toIso(row.updated_at),
  });
}

function packageState(tasks, evidenceByTask) {
  const pkg = tasks.find((task) => task.stage === "PACKAGE") ?? null;
  const rows = pkg ? evidenceByTask.get(pkg.id) ?? [] : [];
  const summary = evidenceSummary(rows);
  return Object.freeze({
    stage: "PACKAGE",
    status: pkg?.status ?? "NOT_SCHEDULED",
    taskId: pkg?.id ?? null,
    completed: pkg?.status === "COMPLETED",
    productionVerified: summary.productionVerified > 0 && summary.artifactHashes.length > 0,
    artifactHashes: summary.artifactHashes,
  });
}

function publicationState(tasks, evidenceByTask) {
  const publishing = tasks.find((task) => task.stage === "PUBLISHING") ?? null;
  const rows = publishing ? evidenceByTask.get(publishing.id) ?? [] : [];
  const receipt = rows.some(
    (row) => /receipt|publish/i.test(String(row.evidence_type)) && isProviderVerified(row)
  );
  return Object.freeze({
    stage: "PUBLISHING",
    status: publishing?.status ?? "NOT_SCHEDULED",
    taskId: publishing?.id ?? null,
    verifiedReceipt: receipt,
  });
}

function runSummaryDto(project, { statusCounts = {}, evidence, package: pkg, publishing }) {
  return Object.freeze({
    runId: project.id,
    directorId: project.director_id,
    projectKey: project.project_key,
    universeId: project.universe_id,
    title: project.title,
    state: project.state,
    createdAt: toIso(project.created_at),
    updatedAt: toIso(project.updated_at),
    tasks: Object.freeze({ total: Object.values(statusCounts).reduce((sum, value) => sum + value, 0), byStatus: Object.freeze({ ...statusCounts }) }),
    evidence: Object.freeze(evidence),
    package: pkg,
    publishing,
  });
}

export class PostgresContentPackageReadRepository {
  constructor(pool, { logger = console } = {}) {
    if (!pool) throw new Error("CONTENT_PACKAGE_READ_POOL_REQUIRED");
    this.pool = pool;
    this.logger = logger;
  }

  async listRuns(query = {}) {
    const filters = parseRunFilters(query);
    const { rows } = await this.pool.query(
      `SELECT p.*,
              to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
         FROM director_projects p
        WHERE ($1::text IS NULL OR p.director_id = $1)
          AND ($2::text IS NULL OR p.state = $2)
          AND ($3::timestamptz IS NULL OR p.created_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR p.created_at <= $4::timestamptz)
          AND ($5::text IS NULL OR EXISTS (
                SELECT 1 FROM director_tasks t WHERE t.project_id = p.id AND t.stage = $5))
          AND ($6::text IS NULL OR EXISTS (
                SELECT 1 FROM director_tasks t WHERE t.project_id = p.id AND t.status = $6))
          AND ($7::timestamptz IS NULL OR (p.created_at, p.id) < ($7::timestamptz, $8::uuid))
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $9`,
      [
        filters.directorId,
        filters.state,
        filters.from,
        filters.to,
        filters.stage,
        filters.taskStatus,
        filters.cursor?.time ?? null,
        filters.cursor?.id ?? null,
        filters.limit + 1,
      ]
    );

    const pageRows = rows.slice(0, filters.limit);
    const hasMore = rows.length > filters.limit;
    const ids = pageRows.map((row) => row.id);
    if (ids.length === 0) {
      return Object.freeze({
        count: 0,
        runs: Object.freeze([]),
        page: Object.freeze({ limit: filters.limit, hasMore: false, nextCursor: null }),
      });
    }

    const [counts, evidence, stageTasks] = await Promise.all([
      this.pool.query(
        `SELECT project_id, status, count(*)::int AS count
           FROM director_tasks
          WHERE project_id = ANY($1::uuid[])
          GROUP BY project_id, status`,
        [ids]
      ),
      this.pool.query(
        `SELECT t.project_id,
                count(*)::int AS total,
                count(*) FILTER (WHERE e.test_fixture)::int AS fixtures,
                count(*) FILTER (WHERE e.verification_level = 'PRODUCTION_VERIFIED'
                                   AND NOT e.test_fixture
                                   AND e.environment = 'PRODUCTION')::int AS production_verified,
                count(*) FILTER (WHERE e.verification_level = 'PROVIDER_VERIFIED'
                                   AND NOT e.test_fixture)::int AS provider_verified
           FROM director_task_evidence e
           JOIN director_tasks t ON t.id = e.task_id AND t.director_id = e.director_id
          WHERE t.project_id = ANY($1::uuid[])
          GROUP BY t.project_id`,
        [ids]
      ),
      this.pool.query(
        `SELECT DISTINCT ON (project_id, stage) project_id, id, stage, status
           FROM director_tasks
          WHERE project_id = ANY($1::uuid[]) AND stage IN ('PACKAGE', 'PUBLISHING')
          ORDER BY project_id, stage, created_at DESC, id DESC`,
        [ids]
      ),
    ]);

    const statusByProject = new Map();
    for (const row of counts.rows) {
      const bucket = statusByProject.get(row.project_id) ?? emptyStatusCounts();
      bucket[row.status] = Number(row.count);
      statusByProject.set(row.project_id, bucket);
    }

    const evidenceByProject = new Map();
    for (const row of evidence.rows) {
      evidenceByProject.set(row.project_id, {
        total: Number(row.total),
        fixtures: Number(row.fixtures),
        productionVerified: Number(row.production_verified),
        providerVerified: Number(row.provider_verified),
        fixtureOnly: Number(row.total) > 0 && Number(row.fixtures) === Number(row.total),
      });
    }

    const tasksByProject = new Map();
    for (const row of stageTasks.rows) {
      const list = tasksByProject.get(row.project_id) ?? [];
      list.push(row);
      tasksByProject.set(row.project_id, list);
    }

    const stageTaskIds = stageTasks.rows.map((row) => row.id);
    const stageEvidence = stageTaskIds.length
      ? await this.pool.query(
          `SELECT * FROM director_task_evidence WHERE task_id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC`,
          [stageTaskIds]
        )
      : { rows: [] };
    const stageEvidenceByTask = new Map();
    for (const row of stageEvidence.rows) {
      const list = stageEvidenceByTask.get(row.task_id) ?? [];
      list.push(row);
      stageEvidenceByTask.set(row.task_id, list);
    }

    const runs = pageRows.map((project) =>
      runSummaryDto(project, {
        statusCounts: statusByProject.get(project.id) ?? emptyStatusCounts(),
        evidence: evidenceByProject.get(project.id) ?? {
          total: 0,
          fixtures: 0,
          productionVerified: 0,
          providerVerified: 0,
          fixtureOnly: false,
        },
        package: packageState(tasksByProject.get(project.id) ?? [], stageEvidenceByTask),
        publishing: publicationState(tasksByProject.get(project.id) ?? [], stageEvidenceByTask),
      })
    );

    const last = pageRows.at(-1);
    return Object.freeze({
      count: runs.length,
      runs: Object.freeze(runs),
      page: Object.freeze({
        limit: filters.limit,
        hasMore,
        nextCursor: hasMore ? encodeCursor(last.cursor_time ?? last.created_at, last.id) : null,
      }),
    });
  }

  async getRun(projectId) {
    if (typeof projectId !== "string" || !UUID.test(projectId)) {
      throw new ContentPackageQueryError("CONTENT_PACKAGE_ID_INVALID", "A valid content package id is required.");
    }
    const project = await this.pool.query(
      `SELECT p.*, d.display_name, d.lifecycle_state
         FROM director_projects p
         LEFT JOIN director_fleet d ON d.director_id = p.director_id
        WHERE p.id = $1`,
      [projectId]
    );
    if (project.rows.length === 0) {
      throw new ContentPackageQueryError("CONTENT_PACKAGE_NOT_FOUND", "Content package not found.", 404);
    }
    const row = project.rows[0];

    const [tasks, evidence] = await Promise.all([
      this.pool.query(
        `SELECT t.*, w.role AS worker_role, w.state AS worker_state
           FROM director_tasks t
           LEFT JOIN director_workers w ON w.worker_key = t.claimed_worker_key
          WHERE t.project_id = $1
          ORDER BY t.created_at ASC, t.id ASC`,
        [projectId]
      ),
      this.pool.query(
        `SELECT e.*
           FROM director_task_evidence e
           JOIN director_tasks t ON t.id = e.task_id AND t.director_id = e.director_id
          WHERE t.project_id = $1
          ORDER BY COALESCE(e.completed_at, e.created_at) ASC, e.id ASC`,
        [projectId]
      ),
    ]);

    const taskIds = tasks.rows.map((task) => task.id);
    const dependencies = taskIds.length
      ? await this.pool.query(
          `SELECT task_id, depends_on_task_id
             FROM director_task_dependencies
            WHERE task_id = ANY($1::uuid[])`,
          [taskIds]
        )
      : { rows: [] };

    const evidenceByTask = new Map();
    for (const evidenceRow of evidence.rows) {
      const list = evidenceByTask.get(evidenceRow.task_id) ?? [];
      list.push(evidenceRow);
      evidenceByTask.set(evidenceRow.task_id, list);
    }
    const dependenciesByTask = new Map();
    for (const dependency of dependencies.rows) {
      const list = dependenciesByTask.get(dependency.task_id) ?? [];
      list.push(dependency.depends_on_task_id);
      dependenciesByTask.set(dependency.task_id, list);
    }

    const projectedTasks = tasks.rows.map((task) =>
      taskDto(task, {
        dependencies: dependenciesByTask.get(task.id) ?? [],
        evidenceRows: evidenceByTask.get(task.id) ?? [],
      })
    );

    const statusCounts = emptyStatusCounts();
    for (const task of tasks.rows) statusCounts[task.status] += 1;
    const allEvidence = evidence.rows;
    const allEvidenceSummary = evidenceSummary(allEvidence);
    const pkg = packageState(tasks.rows, evidenceByTask);

    return Object.freeze({
      run: Object.freeze({
        runId: row.id,
        directorId: row.director_id,
        director: Object.freeze({
          directorId: row.director_id,
          displayName: row.display_name ?? null,
          lifecycleState: row.lifecycle_state ?? null,
        }),
        projectKey: row.project_key,
        universeId: row.universe_id,
        title: row.title,
        state: row.state,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      }),
      progress: Object.freeze({
        tasks: tasks.rows.length,
        byStatus: Object.freeze({ ...statusCounts }),
        stagesPresent: Object.freeze([...new Set(tasks.rows.map((task) => task.stage))]),
      }),
      package: pkg,
      publishing: publicationState(tasks.rows, evidenceByTask),
      production: Object.freeze({
        artifactHashes: allEvidenceSummary.artifactHashes,
        productionVerified: allEvidenceSummary.productionVerified > 0,
        providerVerified: allEvidenceSummary.providerVerified > 0,
        fixtureCount: allEvidenceSummary.fixtures,
        fixtureOnly: allEvidenceSummary.fixtureOnly,
      }),
      evidence: Object.freeze(allEvidenceSummary),
      tasks: Object.freeze(projectedTasks),
    });
  }

  async listEvidence(projectId, query = {}) {
    if (typeof projectId !== "string" || !UUID.test(projectId)) {
      throw new ContentPackageQueryError("CONTENT_PACKAGE_ID_INVALID", "A valid content package id is required.");
    }
    const filters = parseEvidenceFilters(query);
    const exists = await this.pool.query("SELECT 1 FROM director_projects WHERE id = $1", [projectId]);
    if (exists.rows.length === 0) {
      throw new ContentPackageQueryError("CONTENT_PACKAGE_NOT_FOUND", "Content package not found.", 404);
    }

    const { rows } = await this.pool.query(
      `SELECT e.*,
              to_char(COALESCE(e.completed_at, e.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
         FROM director_task_evidence e
         JOIN director_tasks t ON t.id = e.task_id AND t.director_id = e.director_id
        WHERE t.project_id = $1
          AND ($2::text IS NULL OR t.stage = $2)
          AND ($3::text IS NULL OR e.verification_level = $3)
          AND ($4::boolean OR e.test_fixture = false)
          AND ($5::timestamptz IS NULL
               OR (COALESCE(e.completed_at, e.created_at), e.id) > ($5::timestamptz, $6::uuid))
        ORDER BY COALESCE(e.completed_at, e.created_at) ASC, e.id ASC
        LIMIT $7`,
      [
        projectId,
        filters.stage,
        filters.verificationLevel,
        filters.includeTestFixtures,
        filters.cursor?.time ?? null,
        filters.cursor?.id ?? null,
        filters.limit + 1,
      ]
    );

    const pageRows = rows.slice(0, filters.limit);
    const hasMore = rows.length > filters.limit;
    const summary = await this.pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE e.test_fixture)::int AS fixtures,
              count(*) FILTER (WHERE e.verification_level = 'PRODUCTION_VERIFIED'
                                 AND NOT e.test_fixture
                                 AND e.environment = 'PRODUCTION')::int AS production_verified,
              count(*) FILTER (WHERE e.verification_level = 'PROVIDER_VERIFIED'
                                 AND NOT e.test_fixture)::int AS provider_verified
         FROM director_task_evidence e
         JOIN director_tasks t ON t.id = e.task_id AND t.director_id = e.director_id
        WHERE t.project_id = $1`,
      [projectId]
    );
    const totals = summary.rows[0] ?? { total: 0, fixtures: 0, production_verified: 0, provider_verified: 0 };
    const last = pageRows.at(-1);

    return Object.freeze({
      packageId: projectId,
      events: Object.freeze(pageRows.map(evidenceEventDto)),
      summary: Object.freeze({
        total: Number(totals.total),
        fixtures: Number(totals.fixtures),
        productionVerified: Number(totals.production_verified),
        providerVerified: Number(totals.provider_verified),
        fixtureOnly: Number(totals.total) > 0 && Number(totals.fixtures) === Number(totals.total),
      }),
      page: Object.freeze({
        limit: filters.limit,
        hasMore,
        nextCursor: hasMore ? encodeCursor(last.cursor_time ?? last.completed_at ?? last.created_at, last.id) : null,
      }),
    });
  }
}
