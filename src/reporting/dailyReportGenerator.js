/**
 * ST Production House — daily FORGE Owner report generator (Day 4 / D6).
 *
 * Every number in this report comes from a persisted record. There is no model
 * inference and no placeholder arithmetic. A section the platform cannot
 * observe is labelled NOT_RUN (no durable source) or BLOCKED (the source exists
 * but could not be read) — never "0 completed" by assumption.
 *
 * Accuracy states (Rule 1 / Rule 2):
 *   IMPLEMENTED          code exists and is wired in this repository
 *   UNIT_TESTED          covered by node:test unit tests
 *   INTEGRATION_TESTED   covered by PostgreSQL integration tests
 *   CI_VERIFIED          a recorded CI run supports it
 *   PROVIDER_VERIFIED    a real provider/platform receipt exists
 *   PRODUCTION_VERIFIED  real production output was verified (e.g. ffprobe)
 *   BLOCKED              the source exists but could not be read
 *   NOT_RUN              no durable evidence exists for this claim
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { localDateString, windowForReportDate } from "./reportSchedule.js";

export const REPORT_ACCURACY_STATES = Object.freeze({
  IMPLEMENTED: "IMPLEMENTED",
  UNIT_TESTED: "UNIT_TESTED",
  INTEGRATION_TESTED: "INTEGRATION_TESTED",
  CI_VERIFIED: "CI_VERIFIED",
  PROVIDER_VERIFIED: "PROVIDER_VERIFIED",
  PRODUCTION_VERIFIED: "PRODUCTION_VERIFIED",
  BLOCKED: "BLOCKED",
  NOT_RUN: "NOT_RUN",
});

export const ACCURACY_LEGEND = Object.freeze({
  IMPLEMENTED: "Code exists and is mounted in this repository.",
  UNIT_TESTED: "Covered by node:test unit tests.",
  INTEGRATION_TESTED: "Covered by PostgreSQL integration tests against the real schema.",
  CI_VERIFIED: "A recorded CI run identifies the commit and result.",
  PROVIDER_VERIFIED: "A real provider or platform receipt exists for the operation.",
  PRODUCTION_VERIFIED: "Real production output was verified (for example ffprobe).",
  BLOCKED: "The evidence source exists but could not be read for this report.",
  NOT_RUN: "No durable evidence exists; the activity is not claimed to have happened.",
});

function metric(value, { source, verification, evidence = null, note = null } = {}) {
  return {
    value,
    source,
    verification,
    evidence,
    ...(note ? { note } : {}),
  };
}

function notRun(reason, { source = null, note = null } = {}) {
  return { value: null, source, verification: REPORT_ACCURACY_STATES.NOT_RUN, reason, ...(note ? { note } : {}) };
}

function blocked(code, { source = null, note = null } = {}) {
  return { value: null, source, verification: REPORT_ACCURACY_STATES.BLOCKED, reason: code, ...(note ? { note } : {}) };
}

async function queryRows(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function guard(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, code: error?.code ?? "SOURCE_QUERY_FAILED" };
  }
}

/** Deterministic JSON (sorted keys) so the evidence hash is reproducible. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return "null";
}

export function hashReportPayload(payload) {
  return crypto.createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * Next READY, unblocked milestone from the canonical backlog manifest.
 * Read-only: the manifest and the Owner's lifecycle file are never written.
 */
export async function selectTomorrowsObjective({ backlogDirectory = process.cwd() } = {}) {
  const slicesPath = path.join(backlogDirectory, "automation", "backlog", "slices.json");
  const lifecyclePath = path.join(backlogDirectory, "automation", "backlog", "lifecycle.json");
  try {
    const slices = JSON.parse(await fs.readFile(slicesPath, "utf8"));
    const lifecycle = JSON.parse(await fs.readFile(lifecyclePath, "utf8"));
    const promoted = new Set(Array.isArray(lifecycle.promotedSliceIds) ? lifecycle.promotedSliceIds : []);
    const candidates = (Array.isArray(slices.slices) ? slices.slices : []).filter(
      (slice) => slice && typeof slice.sliceId === "string" && !promoted.has(slice.sliceId) && slice.ownerGated !== true
    );
    const selected = candidates[0] ?? null;
    if (!selected) {
      return {
        verification: REPORT_ACCURACY_STATES.NOT_RUN,
        reason: "NO_READY_UNBLOCKED_SLICE",
        source: "automation/backlog/slices.json",
        candidateCount: 0,
      };
    }
    return {
      verification: REPORT_ACCURACY_STATES.IMPLEMENTED,
      source: "automation/backlog/slices.json",
      sliceId: selected.sliceId,
      lane: selected.lane ?? null,
      ownerGated: selected.ownerGated === true,
      title: selected.title ?? null,
      brief: typeof selected.brief === "string" ? selected.brief.slice(0, 400) : null,
      candidateCount: candidates.length,
      rationale:
        "First non-promoted, non-owner-gated slice in manifest order; completed and promoted slices are not reopened.",
    };
  } catch (error) {
    return {
      verification: REPORT_ACCURACY_STATES.NOT_RUN,
      reason: error?.code === "ENOENT" ? "BACKLOG_MANIFEST_UNAVAILABLE" : "BACKLOG_MANIFEST_UNREADABLE",
      source: "automation/backlog/slices.json",
    };
  }
}

/**
 * Collect every section from real persisted records.
 */
export async function collectForgeDailyReport({
  pool,
  reportDate = null,
  timeZone = "Asia/Kolkata",
  generatedAt = new Date(),
  windowStart = null,
  windowEnd = null,
  backlogDirectory = process.cwd(),
} = {}) {
  if (!pool || typeof pool.query !== "function") throw new Error("REPORT_POOL_REQUIRED");
  const date = reportDate ?? localDateString(generatedAt, timeZone);
  const window = windowForReportDate({ reportDate: date, timeZone });
  const from = windowStart ? new Date(windowStart) : window.windowStart;
  const to = windowEnd ? new Date(windowEnd) : window.windowEnd;
  const params = [from.toISOString(), to.toISOString()];
  const windowRef = { start: from.toISOString(), end: to.toISOString() };

  const repoCi = await guard(() =>
    queryRows(
      pool,
      `SELECT run_id, workflow_name, status, commit_sha, recorded_at
         FROM forge_ci_results
        WHERE recorded_at >= $1 AND recorded_at < $2
        ORDER BY recorded_at DESC
        LIMIT 20`,
      params
    )
  );
  const repoCiLatest = await guard(() =>
    queryRows(
      pool,
      `SELECT run_id, workflow_name, status, commit_sha, recorded_at
         FROM forge_ci_results
        ORDER BY recorded_at DESC
        LIMIT 1`
    )
  );
  const prsInWindow = await guard(() =>
    queryRows(
      pool,
      `SELECT state, count(*)::int AS count
         FROM forge_pull_requests
        WHERE updated_at >= $1 AND updated_at < $2
        GROUP BY state`,
      params
    )
  );
  const prsAll = await guard(() =>
    queryRows(pool, "SELECT state, count(*)::int AS count FROM forge_pull_requests GROUP BY state")
  );

  const tasksCreated = await guard(() =>
    queryRows(pool, "SELECT count(*)::int AS count FROM forge_tasks WHERE created_at >= $1 AND created_at < $2", params)
  );
  const taskResults = await guard(() =>
    queryRows(
      pool,
      `SELECT outcome, count(*)::int AS count
         FROM forge_task_results
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY outcome`,
      params
    )
  );
  const tasksByStatus = await guard(() =>
    queryRows(pool, "SELECT status, count(*)::int AS count FROM forge_tasks GROUP BY status ORDER BY status")
  );
  const tasksRetried = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*)::int AS count FROM forge_tasks
        WHERE attempt_count > 1 AND updated_at >= $1 AND updated_at < $2`,
      params
    )
  );
  const leaseRecoveries = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*)::int AS count FROM forge_worker_leases
        WHERE release_reason = 'expired' AND leased_at >= $1 AND leased_at < $2`,
      params
    )
  );
  const reconciliations = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*)::int AS count,
              COALESCE(SUM(jsonb_array_length(decisions)), 0)::int AS decisions
         FROM forge_reconciliations
        WHERE started_at >= $1 AND started_at < $2`,
      params
    )
  );
  const externalOps = await guard(() =>
    queryRows(
      pool,
      "SELECT count(*)::int AS count FROM forge_external_ops WHERE status = 'IN_FLIGHT'"
    )
  );
  const queueAges = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*) FILTER (WHERE status IN ('READY', 'NOT_STARTED'))::int AS ready,
              count(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
              min(created_at) FILTER (WHERE status IN ('READY', 'NOT_STARTED')) AS oldest_ready
         FROM forge_tasks`
    )
  );

  const approvalsInWindow = await guard(() =>
    queryRows(
      pool,
      `SELECT status, count(*)::int AS count
         FROM forge_publishing_approvals
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY status`,
      params
    )
  );
  const hermesDecisions = await guard(() =>
    queryRows(
      pool,
      `SELECT hermes_decision, count(*)::int AS count
         FROM forge_publishing_approvals
        WHERE hermes_decided_at >= $1 AND hermes_decided_at < $2
        GROUP BY hermes_decision`,
      params
    )
  );
  const approvalOutstanding = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*) FILTER (WHERE status = 'AWAITING_OWNER')::int AS awaiting,
              count(*) FILTER (WHERE status = 'AWAITING_OWNER' AND deadline_at <= clock_timestamp())::int AS overdue
         FROM forge_publishing_approvals`
    )
  );
  const policies = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*) FILTER (WHERE active = true AND revoked_at IS NULL)::int AS active,
              count(*) FILTER (WHERE active = false OR revoked_at IS NOT NULL)::int AS revoked
         FROM forge_delegation_policies`
    )
  );

  const directors = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*) FILTER (WHERE enabled = true)::int AS active,
              count(*) FILTER (WHERE enabled = false)::int AS disabled
         FROM agents`
    )
  );
  const schedules = await guard(() =>
    queryRows(
      pool,
      "SELECT count(*) FILTER (WHERE schedule_enabled = true)::int AS enabled FROM director_schedules"
    )
  );
  const jobsByStatus = await guard(() =>
    queryRows(
      pool,
      `SELECT status::text AS status, count(*)::int AS count
         FROM jobs
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY status
        ORDER BY status`,
      params
    )
  );
  const jobsByDirector = await guard(() =>
    queryRows(
      pool,
      `SELECT agent_id, count(*)::int AS count
         FROM jobs
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY agent_id
        ORDER BY count DESC
        LIMIT 20`,
      params
    )
  );

  const artifactsInWindow = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ffprobe_verified = true)::int AS verified,
              count(*) FILTER (WHERE ffprobe_verified = false)::int AS unverified
         FROM artifacts
        WHERE created_at >= $1 AND created_at < $2`,
      params
    )
  );
  const artifactsByKind = await guard(() =>
    queryRows(
      pool,
      `SELECT kind, count(*)::int AS count
         FROM artifacts
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY kind
        ORDER BY count DESC
        LIMIT 20`,
      params
    )
  );

  const publishingRequests = await guard(() =>
    queryRows(
      pool,
      `SELECT status::text AS status, count(*)::int AS count
         FROM publishing_requests
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY status`,
      params
    )
  );
  const publishingReceipts = await guard(() =>
    queryRows(
      pool,
      "SELECT count(*)::int AS count FROM publishing_receipts WHERE received_at >= $1 AND received_at < $2",
      params
    )
  );
  const publishingUncertain = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*)::int AS count
         FROM publishing_requests r
        WHERE r.status = 'approved'
          AND r.created_at >= $1 AND r.created_at < $2
          AND NOT EXISTS (SELECT 1 FROM publishing_receipts p WHERE p.publishing_request_id = r.id)`,
      params
    )
  );
  const analytics = await guard(() =>
    queryRows(
      pool,
      "SELECT count(*)::int AS count FROM owner_analytics_records WHERE collected_at >= $1 AND collected_at < $2",
      params
    )
  );

  const authEvents = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE event_type ~* '(fail|denied|reject|invalid)')::int AS failures
         FROM authentication_audit_events
        WHERE occurred_at >= $1 AND occurred_at < $2`,
      params
    )
  );
  const migrations = await guard(() =>
    queryRows(pool, "SELECT count(*)::int AS applied FROM schema_migrations")
  );
  const database = await guard(async () => {
    const { rows } = await pool.query("SELECT 1 AS ok");
    return rows[0]?.ok === 1;
  });
  const workers = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*) FILTER (WHERE released_at IS NULL AND lease_expires_at > clock_timestamp())::int AS live,
              count(*) FILTER (WHERE released_at IS NULL AND lease_expires_at <= clock_timestamp())::int AS expired
         FROM forge_worker_leases`
    )
  );
  const circuits = await guard(() =>
    queryRows(pool, "SELECT count(*)::int AS open FROM resilience_circuits WHERE state = 'open'")
  );
  const quota = await guard(() =>
    queryRows(
      pool,
      `SELECT count(*)::int AS exhausted
         FROM provider_quota_limits
        WHERE enabled = true AND usage_count + reserved_count >= quota_limit`
    )
  );

  const notificationEvents = await guard(() =>
    queryRows(
      pool,
      `SELECT priority, count(*)::int AS count
         FROM forge_notification_events
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY priority`,
      params
    )
  );
  const notificationDeliveries = await guard(() =>
    queryRows(
      pool,
      `SELECT state, channel, count(*)::int AS count
         FROM forge_notification_deliveries
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY state, channel`,
      params
    )
  );
  const channelConfiguration = await guard(() =>
    queryRows(
      pool,
      "SELECT channel, runtime_configured, owner_enabled, status_reason FROM forge_notification_channels ORDER BY channel"
    )
  );

  const count = (rowsResult, predicate = null) => {
    if (!rowsResult?.ok) return null;
    const entries = rowsResult.value ?? [];
    if (typeof predicate === "function") {
      return entries.filter(predicate).reduce((sum, row) => sum + Number(row.count ?? 0), 0);
    }
    if (entries.length === 1 && entries[0].count !== undefined) return Number(entries[0].count ?? 0);
    return entries.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  };

  const tasksCompleted = count(taskResults, (row) => row.outcome === "SUCCEEDED");
  const tasksFailed = count(taskResults, (row) => row.outcome === "FAILED");
  const blockedTasks = count(tasksByStatus, (row) => ["BLOCKED", "DEAD_LETTER"].includes(row.status));
  const failedJobs = count(jobsByStatus, (row) => row.status === "failed");
  const deadLetterJobs = count(jobsByStatus, (row) => row.status === "dead_letter");
  const uploadsAttempted = count(publishingRequests);
  const uploadsFailed = count(publishingRequests, (row) => ["rejected", "expired"].includes(row.status));
  const receiptsConfirmed = count(publishingReceipts);
  const uncertainUploads = count(publishingUncertain);
  const artifactTotals = artifactsInWindow.ok ? artifactsInWindow.value[0] : null;
  const qcVerified = artifactTotals ? Number(artifactTotals.verified ?? 0) : null;
  const deadLetters = count(notificationDeliveries, (row) => row.state === "dead_letter");
  const unconfiguredDeliveries = count(notificationDeliveries, (row) => row.state === "unconfigured");
  const unconfiguredChannels = channelConfiguration.ok
    ? channelConfiguration.value.filter((row) => row.runtime_configured !== true).map((row) => row.channel)
    : [];
  const disabledChannels = channelConfiguration.ok
    ? channelConfiguration.value.filter((row) => row.owner_enabled !== true).map((row) => row.channel)
    : [];

  const blockers = [];
  if ((blockedTasks ?? 0) > 0) {
    blockers.push({
      code: "FORGE_TASKS_BLOCKED",
      description: `${blockedTasks} FORGE task(s) are BLOCKED or DEAD_LETTER.`,
      impact: "Those slices cannot progress until the blocker is resolved.",
      responsibleComponent: "FORGE task queue",
      ownerAction: null,
      recommendedNextStep: "Inspect the blocked task records and the failing check, then fix or re-scope the slice.",
      evidence: { table: "forge_tasks", count: blockedTasks },
    });
  }
  if ((externalOps ?? 0) > 0) {
    blockers.push({
      code: "EXTERNAL_OP_UNRECONCILED",
      description: `${externalOps} external operation(s) remain IN_FLIGHT.`,
      impact: "A branch or PR write may be uncertain and must not be retried blindly.",
      responsibleComponent: "FORGE external-operation journal",
      ownerAction: null,
      recommendedNextStep: "Reconcile against GitHub before any retry; keep the journal entry until observed.",
      evidence: { table: "forge_external_ops", count: externalOps },
    });
  }
  if ((deadLetters ?? 0) > 0) {
    blockers.push({
      code: "NOTIFICATION_DEAD_LETTER",
      description: `${deadLetters} notification delivery(ies) are in dead-letter state.`,
      impact: "An Owner alert may not have reached every configured channel.",
      responsibleComponent: "Notification delivery worker",
      ownerAction: "Review the dead-letter list in the Owner inbox.",
      recommendedNextStep: "Fix the failing transport and use the bounded manual retry.",
      evidence: { table: "forge_notification_deliveries", count: deadLetters },
    });
  }
  if (unconfiguredChannels.length > 0) {
    blockers.push({
      code: "EXTERNAL_CHANNELS_UNCONFIGURED",
      description: `No transport is configured for: ${unconfiguredChannels.join(", ")}.`,
      impact: "Those channels are recorded as unconfigured; no message was delivered through them.",
      responsibleComponent: "Deployment configuration",
      ownerAction: "Provide the transport credential if external delivery is required.",
      recommendedNextStep: "Keep relying on the durable in-app inbox until a transport is configured.",
      evidence: { table: "forge_notification_channels", channels: unconfiguredChannels },
    });
  }
  if ((approvalOutstanding.ok ? Number(approvalOutstanding.value[0]?.overdue ?? 0) : 0) > 0) {
    blockers.push({
      code: "APPROVAL_OVERDUE",
      description: `${approvalOutstanding.value[0].overdue} publishing approval(s) passed the five-hour deadline.`,
      impact: "HERMES will decide them on the next deadline cycle under the active delegated policy.",
      responsibleComponent: "HERMES approval engine",
      ownerAction: "Respond to the request if delegated publishing is not intended.",
      recommendedNextStep: "Run one deadline cycle and confirm the durable decision record.",
      evidence: { table: "forge_publishing_approvals" },
    });
  }
  if ((uncertainUploads ?? 0) > 0) {
    blockers.push({
      code: "PUBLISHING_UNCERTAIN",
      description: `${uncertainUploads} approved publishing request(s) have no platform receipt.`,
      impact: "Upload success cannot be claimed without a receipt.",
      responsibleComponent: "Publishing adapter",
      ownerAction: null,
      recommendedNextStep: "Verify the platform state manually before any retry; add the receipt when confirmed.",
      evidence: { table: "publishing_requests" },
    });
  }
  if ((circuits.ok ? Number(circuits.value[0]?.open ?? 0) : 0) > 0) {
    blockers.push({
      code: "PROVIDER_CIRCUIT_OPEN",
      description: `${circuits.value[0].open} provider circuit(s) are open.`,
      impact: "Provider calls against those targets fail closed until the circuit closes.",
      responsibleComponent: "Provider resilience layer",
      ownerAction: null,
      recommendedNextStep: "Wait for the half-open probe or route to a permitted free slot.",
      evidence: { table: "resilience_circuits" },
    });
  }
  if ((quota.ok ? Number(quota.value[0]?.exhausted ?? 0) : 0) > 0) {
    blockers.push({
      code: "PROVIDER_QUOTA_EXHAUSTED",
      description: `${quota.value[0].exhausted} provider quota slot(s) are exhausted.`,
      impact: "New dispatches on those slots are refused.",
      responsibleComponent: "Provider quota ledger",
      ownerAction: "Decide whether a permitted free slot or reset window is acceptable.",
      recommendedNextStep: "Route to a free/emergency slot; never borrow another Director's credential.",
      evidence: { table: "provider_quota_limits" },
    });
  }
  if (!database.ok) {
    blockers.push({
      code: "DATABASE_UNREACHABLE",
      description: "The report could not confirm database health.",
      impact: "Operational numbers may be incomplete.",
      responsibleComponent: "PostgreSQL",
      ownerAction: null,
      recommendedNextStep: "Check the database connection and re-run the report.",
      evidence: { errorCode: database.code ?? "DB_HEALTH_FAILED" },
    });
  }

  const productionActivity =
    (receiptsConfirmed ?? 0) > 0 || (qcVerified ?? 0) > 0 || (tasksCompleted ?? 0) > 0;
  const productionActivityDetail = [
    `${receiptsConfirmed ?? 0} confirmed platform upload receipt(s)`,
    `${qcVerified ?? 0} ffprobe-verified artifact(s)`,
    `${tasksCompleted ?? 0} FORGE task result(s) recorded as SUCCEEDED`,
  ].join("; ");

  const whatChanged = [];
  if (tasksCompleted !== null) whatChanged.push(`${tasksCompleted} FORGE task(s) completed and ${tasksFailed ?? 0} failed in the reporting window.`);
  if (prsInWindow.ok) whatChanged.push(`${count(prsInWindow, (row) => row.state === "merged") ?? 0} pull request(s) merged and ${count(prsInWindow, (row) => row.state === "open") ?? 0} updated as open.`);
  if (uploadsAttempted !== null) whatChanged.push(`${uploadsAttempted} publishing request(s) created and ${receiptsConfirmed ?? 0} platform receipt(s) confirmed.`);
  if (artifactTotals) whatChanged.push(`${Number(artifactTotals.total ?? 0)} artifact(s) recorded, ${Number(artifactTotals.verified ?? 0)} verified by ffprobe.`);
  if (approvalsInWindow.ok) whatChanged.push(`${count(approvalsInWindow) ?? 0} publishing approval request(s) created.`);
  if (notificationEvents.ok) whatChanged.push(`${count(notificationEvents) ?? 0} notification event(s) persisted.`);

  const sections = {
    executiveSummary: {
      overallCondition: blockers.length === 0 ? "NOMINAL" : "DEGRADED",
      whatChanged,
      remainsBlocked: blockers.map((blocker) => blocker.description),
      productionActivity,
      productionActivityDetail,
      note: "No percentage progress is reported. Every statement above is derived from a persisted record.",
    },
    repository: {
      startingCommitSha: repoCi.ok && repoCi.value.length > 0 ? repoCi.value[repoCi.value.length - 1].commit_sha : notRun("NO_DURABLE_COMMIT_RECORD", { source: "forge_ci_results" }),
      endingCommitSha: repoCiLatest.ok && repoCiLatest.value[0] ? repoCiLatest.value[0].commit_sha : notRun("NO_DURABLE_COMMIT_RECORD", { source: "forge_ci_results" }),
      mergedPullRequests: prsInWindow.ok
        ? metric(count(prsInWindow, (row) => row.state === "merged"), {
            source: "forge_pull_requests",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { window: windowRef },
          })
        : blocked(prsInWindow.code, { source: "forge_pull_requests" }),
      openPullRequests: prsAll.ok
        ? metric(count(prsAll, (row) => row.state === "open"), {
            source: "forge_pull_requests",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
          })
        : blocked(prsAll.code, { source: "forge_pull_requests" }),
      issuesCompleted: notRun("NO_ISSUE_TRACKER_MIRROR", {
        note: "GitHub issues are not mirrored into PostgreSQL; the report does not guess them.",
      }),
      issuesOutstanding: notRun("NO_ISSUE_TRACKER_MIRROR"),
      componentsChanged: notRun("NO_DURABLE_DIFF_RECORD"),
      ciRuns: repoCi.ok
        ? metric(repoCi.value.length, {
            source: "forge_ci_results",
            verification: REPORT_ACCURACY_STATES.CI_VERIFIED,
            evidence: {
              window: windowRef,
              runs: repoCi.value.slice(0, 10).map((row) => ({
                runId: row.run_id,
                workflow: row.workflow_name,
                status: row.status,
                commitSha: row.commit_sha,
              })),
            },
          })
        : blocked(repoCi.code, { source: "forge_ci_results" }),
    },
    forgeOperations: {
      tasksCreated: tasksCreated.ok
        ? metric(count(tasksCreated), { source: "forge_tasks", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED, evidence: { window: windowRef } })
        : blocked(tasksCreated.code, { source: "forge_tasks" }),
      tasksCompleted: tasksCompleted === null
        ? blocked(taskResults.code, { source: "forge_task_results" })
        : metric(tasksCompleted, { source: "forge_task_results", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED, evidence: { window: windowRef, outcome: "SUCCEEDED" } }),
      tasksFailed: tasksFailed === null
        ? blocked(taskResults.code, { source: "forge_task_results" })
        : metric(tasksFailed, { source: "forge_task_results", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED, evidence: { window: windowRef, outcome: "FAILED" } }),
      tasksRetried: tasksRetried.ok
        ? metric(count(tasksRetried), { source: "forge_tasks", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(tasksRetried.code, { source: "forge_tasks" }),
      tasksBlocked: tasksByStatus.ok
        ? metric(blockedTasks, { source: "forge_tasks", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(tasksByStatus.code, { source: "forge_tasks" }),
      leaseRecoveryEvents: leaseRecoveries.ok
        ? metric(count(leaseRecoveries), { source: "forge_worker_leases", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(leaseRecoveries.code, { source: "forge_worker_leases" }),
      reconciliations: reconciliations.ok
        ? metric(Number(reconciliations.value[0]?.count ?? 0), {
            source: "forge_reconciliations",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { decisions: Number(reconciliations.value[0]?.decisions ?? 0) },
          })
        : blocked(reconciliations.code, { source: "forge_reconciliations" }),
      externalOpsInFlight: externalOps.ok
        ? metric(Number(externalOps.value[0]?.count ?? 0), { source: "forge_external_ops", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(externalOps.code, { source: "forge_external_ops" }),
      queueHealth: queueAges.ok
        ? metric(Number(queueAges.value[0]?.ready ?? 0), {
            source: "forge_tasks",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: {
              inProgress: Number(queueAges.value[0]?.in_progress ?? 0),
              oldestReadyAt: queueAges.value[0]?.oldest_ready ?? null,
            },
          })
        : blocked(queueAges.code, { source: "forge_tasks" }),
    },
    hermesOperations: {
      approvalRequestsCreated: approvalsInWindow.ok
        ? metric(count(approvalsInWindow), { source: "forge_publishing_approvals", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED, evidence: { window: windowRef } })
        : blocked(approvalsInWindow.code, { source: "forge_publishing_approvals" }),
      ownerApprovals: approvalsInWindow.ok
        ? metric(count(approvalsInWindow, (row) => row.status === "OWNER_APPROVED"), { source: "forge_publishing_approvals", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(approvalsInWindow.code, { source: "forge_publishing_approvals" }),
      ownerRejections: approvalsInWindow.ok
        ? metric(count(approvalsInWindow, (row) => row.status === "OWNER_REJECTED"), { source: "forge_publishing_approvals", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(approvalsInWindow.code, { source: "forge_publishing_approvals" }),
      expiredRequestsEvaluated: hermesDecisions.ok
        ? metric(count(hermesDecisions), { source: "forge_publishing_approvals", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED, evidence: { window: windowRef } })
        : blocked(hermesDecisions.code, { source: "forge_publishing_approvals" }),
      hermesApprovals: hermesDecisions.ok
        ? metric(count(hermesDecisions, (row) => row.hermes_decision === "APPROVE"), { source: "forge_publishing_approvals", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(hermesDecisions.code, { source: "forge_publishing_approvals" }),
      hermesRejections: hermesDecisions.ok
        ? metric(count(hermesDecisions, (row) => row.hermes_decision === "REJECT"), { source: "forge_publishing_approvals", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(hermesDecisions.code, { source: "forge_publishing_approvals" }),
      activeDelegationPolicies: policies.ok
        ? metric(Number(policies.value[0]?.active ?? 0), {
            source: "forge_delegation_policies",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { revoked: Number(policies.value[0]?.revoked ?? 0) },
          })
        : blocked(policies.code, { source: "forge_delegation_policies" }),
      outstandingDecisions: approvalOutstanding.ok
        ? metric(Number(approvalOutstanding.value[0]?.awaiting ?? 0), {
            source: "forge_publishing_approvals",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { overdue: Number(approvalOutstanding.value[0]?.overdue ?? 0) },
          })
        : blocked(approvalOutstanding.code, { source: "forge_publishing_approvals" }),
    },
    directorOperations: {
      activeDirectors: directors.ok
        ? metric(Number(directors.value[0]?.active ?? 0), {
            source: "agents",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { disabled: Number(directors.value[0]?.disabled ?? 0) },
          })
        : blocked(directors.code, { source: "agents" }),
      suspendedDirectors: notRun("NO_DIRECTOR_SUSPENSION_RECORD"),
      enabledSchedules: schedules.ok
        ? metric(Number(schedules.value[0]?.enabled ?? 0), { source: "director_schedules", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(schedules.code, { source: "director_schedules" }),
      jobsByStatus: jobsByStatus.ok
        ? metric(Number(jobsByStatus.value.reduce((sum, row) => sum + Number(row.count ?? 0), 0)), {
            source: "jobs",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { window: windowRef, byStatus: jobsByStatus.value, byDirector: jobsByDirector.ok ? jobsByDirector.value : null },
          })
        : blocked(jobsByStatus.code, { source: "jobs" }),
      failedJobs: jobsByStatus.ok
        ? metric(failedJobs, { source: "jobs", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(jobsByStatus.code, { source: "jobs" }),
      blockedJobs: jobsByStatus.ok
        ? metric(deadLetterJobs, { source: "jobs", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(jobsByStatus.code, { source: "jobs" }),
      providerAvailability: quota.ok
        ? metric(Number(quota.value[0]?.exhausted ?? 0), {
            source: "provider_quota_limits",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            note: "Value is the number of exhausted quota slots, not a success rate.",
          })
        : blocked(quota.code, { source: "provider_quota_limits" }),
      crossDirectorIsolationIncidents: notRun("NO_ISOLATION_INCIDENT_RECORD", {
        note: "Isolation is enforced by RLS and covered by tests; no incident ledger exists.",
      }),
    },
    mediaProduction: {
      artifactsProduced: artifactsInWindow.ok
        ? metric(Number(artifactTotals?.total ?? 0), {
            source: "artifacts",
            verification: REPORT_ACCURACY_STATES.PRODUCTION_VERIFIED,
            evidence: { window: windowRef, byKind: artifactsByKind.ok ? artifactsByKind.value : null },
          })
        : blocked(artifactsInWindow.code, { source: "artifacts" }),
      ffprobeVerified: artifactsInWindow.ok
        ? metric(Number(artifactTotals?.verified ?? 0), {
            source: "artifacts",
            verification: REPORT_ACCURACY_STATES.PRODUCTION_VERIFIED,
            evidence: { ffprobeVerified: true },
          })
        : blocked(artifactsInWindow.code, { source: "artifacts" }),
      artifactsAwaitingQc: artifactsInWindow.ok
        ? metric(Number(artifactTotals?.unverified ?? 0), {
            source: "artifacts",
            verification: REPORT_ACCURACY_STATES.BLOCKED,
            note: "Recorded but not ffprobe-verified; QC cannot be claimed.",
          })
        : blocked(artifactsInWindow.code, { source: "artifacts" }),
      researchCompleted: notRun("NO_DURABLE_RESEARCH_STAGE_RECORD"),
      scriptsGenerated: notRun("NO_DURABLE_SCRIPT_RECORD"),
      scriptsReviewed: notRun("NO_DURABLE_SCRIPT_REVIEW_RECORD"),
      charactersGenerated: notRun("NO_DURABLE_CHARACTER_STAGE_RECORD"),
      visualsGenerated: notRun("NO_DURABLE_VISUAL_STAGE_RECORD"),
      voiceProduced: notRun("NO_DURABLE_VOICE_STAGE_RECORD"),
      musicProduced: notRun("NO_DURABLE_MUSIC_STAGE_RECORD"),
      ffmpegRendersCompleted: notRun("NO_DURABLE_RENDER_RECORD", {
        note: "Only recorded artifacts are counted; an executor existing is not a completed render.",
      }),
      finalPackagesProduced: notRun("NO_DURABLE_PACKAGE_RECORD"),
    },
    publishingAndAnalytics: {
      uploadsAttempted: publishingRequests.ok
        ? metric(uploadsAttempted, {
            source: "publishing_requests",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { window: windowRef, byStatus: publishingRequests.value },
          })
        : blocked(publishingRequests.code, { source: "publishing_requests" }),
      uploadsConfirmedByReceipt: publishingReceipts.ok
        ? metric(receiptsConfirmed, {
            source: "publishing_receipts",
            verification: REPORT_ACCURACY_STATES.PROVIDER_VERIFIED,
            evidence: { window: windowRef },
          })
        : blocked(publishingReceipts.code, { source: "publishing_receipts" }),
      failedUploads: publishingRequests.ok
        ? metric(uploadsFailed, { source: "publishing_requests", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(publishingRequests.code, { source: "publishing_requests" }),
      uncertainUploads: publishingUncertain.ok
        ? metric(uncertainUploads, {
            source: "publishing_requests",
            verification: REPORT_ACCURACY_STATES.NOT_RUN,
            reason: "NO_PLATFORM_RECEIPT",
            note: "Approved requests without a receipt are not counted as uploads.",
          })
        : blocked(publishingUncertain.code, { source: "publishing_requests" }),
      analyticsCollected: analytics.ok
        ? metric(Number(analytics.value[0]?.count ?? 0), {
            source: "owner_analytics_records",
            verification: REPORT_ACCURACY_STATES.PROVIDER_VERIFIED,
            evidence: { window: windowRef },
          })
        : blocked(analytics.code, { source: "owner_analytics_records" }),
    },
    securityAndInfrastructure: {
      authenticationEvents: authEvents.ok
        ? metric(Number(authEvents.value[0]?.total ?? 0), { source: "authentication_audit_events", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED, evidence: { window: windowRef } })
        : blocked(authEvents.code, { source: "authentication_audit_events" }),
      failedSecurityChecks: authEvents.ok
        ? metric(Number(authEvents.value[0]?.failures ?? 0), {
            source: "authentication_audit_events",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            note: "Counts audit event types matching fail/denied/reject/invalid.",
          })
        : blocked(authEvents.code, { source: "authentication_audit_events" }),
      databaseHealth: database.ok
        ? metric(database.value ? "reachable" : "unreachable", {
            source: "postgres: SELECT 1",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
          })
        : blocked(database.code, { source: "postgres" }),
      migrationsApplied: migrations.ok
        ? metric(Number(migrations.value[0]?.applied ?? 0), { source: "schema_migrations", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(migrations.code, { source: "schema_migrations" }),
      workerHealth: workers.ok
        ? metric(Number(workers.value[0]?.live ?? 0), {
            source: "forge_worker_leases",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { expiredLeases: Number(workers.value[0]?.expired ?? 0) },
          })
        : blocked(workers.code, { source: "forge_worker_leases" }),
      providerOutages: circuits.ok
        ? metric(Number(circuits.value[0]?.open ?? 0), { source: "resilience_circuits", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(circuits.code, { source: "resilience_circuits" }),
      backupStatus: notRun("NO_DURABLE_BACKUP_RECORD", {
        note: "The backup/restore drill exists and is tested, but no run record is persisted.",
      }),
      storageStatus: notRun("NO_DURABLE_STORAGE_TELEMETRY"),
      cloudRuntimeStatus: notRun("NO_DURABLE_CLOUD_TELEMETRY", {
        note: "A CI success is not proof of cloud production runtime.",
      }),
    },
    notifications: {
      eventsCreated: notificationEvents.ok
        ? metric(count(notificationEvents), {
            source: "forge_notification_events",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { window: windowRef, byPriority: notificationEvents.value },
          })
        : blocked(notificationEvents.code, { source: "forge_notification_events" }),
      deliveriesByChannel: notificationDeliveries.ok
        ? metric(Number(notificationDeliveries.value.reduce((sum, row) => sum + Number(row.count ?? 0), 0)), {
            source: "forge_notification_deliveries",
            verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
            evidence: { window: windowRef, rows: notificationDeliveries.value },
          })
        : blocked(notificationDeliveries.code, { source: "forge_notification_deliveries" }),
      deadLetterDeliveries: notificationDeliveries.ok
        ? metric(deadLetters, { source: "forge_notification_deliveries", verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED })
        : blocked(notificationDeliveries.code, { source: "forge_notification_deliveries" }),
      unconfiguredDeliveries: notificationDeliveries.ok
        ? metric(unconfiguredDeliveries, {
            source: "forge_notification_deliveries",
            verification: REPORT_ACCURACY_STATES.NOT_RUN,
            reason: "CHANNEL_UNCONFIGURED",
            note: "Stored honestly as unconfigured; these were not delivery attempts.",
          })
        : blocked(notificationDeliveries.code, { source: "forge_notification_deliveries" }),
      channels: channelConfiguration.ok
        ? metric(channelConfiguration.value.length, {
            source: "forge_notification_channels",
            verification: REPORT_ACCURACY_STATES.IMPLEMENTED,
            evidence: {
              configured: channelConfiguration.value.filter((row) => row.runtime_configured === true).map((row) => row.channel),
              unconfigured: unconfiguredChannels,
              disabledByOwner: disabledChannels,
            },
          })
        : blocked(channelConfiguration.code, { source: "forge_notification_channels" }),
    },
    blockers,
    tomorrowsObjective: await selectTomorrowsObjective({ backlogDirectory }),
  };

  const claims = [
    {
      claimId: "forge.tasks.completed",
      statement: "FORGE tasks completed in the reporting window",
      verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
      evidence: { table: "forge_task_results", window: windowRef },
    },
    {
      claimId: "ci.recorded_runs",
      statement: "CI runs recorded for this period",
      verification: REPORT_ACCURACY_STATES.CI_VERIFIED,
      evidence: { table: "forge_ci_results", window: windowRef },
    },
    {
      claimId: "publishing.confirmed_uploads",
      statement: "Uploads confirmed by a platform receipt",
      verification: REPORT_ACCURACY_STATES.PROVIDER_VERIFIED,
      evidence: { table: "publishing_receipts", window: windowRef },
    },
    {
      claimId: "media.ffprobe_verified",
      statement: "Artifacts verified by ffprobe",
      verification: REPORT_ACCURACY_STATES.PRODUCTION_VERIFIED,
      evidence: { table: "artifacts", predicate: "ffprobe_verified = true", window: windowRef },
    },
    {
      claimId: "notifications.delivery",
      statement: "Notification delivery outcomes per channel",
      verification: REPORT_ACCURACY_STATES.INTEGRATION_TESTED,
      evidence: { table: "forge_notification_deliveries", note: "An outbox row alone is never counted as external delivery.", window: windowRef },
    },
  ];

  const payload = {
    schemaVersion: 1,
    reportDate: date,
    timezone: timeZone,
    generatedAt: new Date(generatedAt).toISOString(),
    window: windowRef,
    accuracyLegend: ACCURACY_LEGEND,
    sections,
    claims,
    evidenceRefs: [
      ...new Set([
        "forge_tasks",
        "forge_task_results",
        "forge_worker_leases",
        "forge_reconciliations",
        "forge_external_ops",
        "forge_pull_requests",
        "forge_ci_results",
        "forge_publishing_approvals",
        "forge_delegation_policies",
        "forge_notification_events",
        "forge_notification_deliveries",
        "forge_notification_channels",
        "agents",
        "jobs",
        "artifacts",
        "publishing_requests",
        "publishing_receipts",
        "owner_analytics_records",
        "authentication_audit_events",
        "resilience_circuits",
        "provider_quota_limits",
        "schema_migrations",
      ]),
    ].map((table) => ({ kind: "postgres_table", table, window: windowRef })),
  };

  payload.evidenceHash = hashReportPayload(payload);
  return payload;
}

/** Recompute the evidence hash from a stored payload (tamper check). */
export function verifyReportEvidenceHash(payload) {
  if (!payload || typeof payload !== "object") return false;
  const { evidenceHash, ...rest } = payload;
  if (typeof evidenceHash !== "string") return false;
  return hashReportPayload(rest) === evidenceHash;
}
