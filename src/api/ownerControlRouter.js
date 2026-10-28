/**
 * ST Production House — Owner control mutation routes (S-M18-02, Module 18).
 *
 * Part 2 of the owner-dashboard surface: authenticated, CSRF-protected
 * MUTATION routes for job control, the owner-approval queue, and emergency
 * pause. Mounted behind `requireAuth` in `ownerServer.js`.
 *
 * Routes
 * ------
 *   GET  /control/approvals                      → pending approval queue
 *   POST /control/jobs/:jobId/retry              → requeue a retryable job
 *   POST /control/jobs/:jobId/cancel             → cancel a non-terminal job
 *   GET  /control/pauses                         → active emergency pauses
 *   POST /control/pauses                         → set an emergency pause
 *   POST /control/pauses/:pauseId/clear          → clear an emergency pause
 *
 * Security contract (AGENTS.md Rule 6 and Rules 15/17):
 * - Every mutation requires a valid session (requireAuth, mounted outside)
 *   AND a per-session CSRF token delivered via the `x-csrf-token` header.
 * - CSRF tokens are issued per session and stored server-side, hashed.
 *   A session created before this feature cannot mutate: it has no CSRF
 *   material, so the check fails closed.
 * - Identity is server-authoritative: the session's ownerId scopes every
 *   job/pause/audit query. Client-supplied owner fields are rejected.
 * - Cross-owner jobs/pauses are indistinguishable 404s (no existence leak).
 * - Job retry/cancel write the owner_control_audit row in the SAME store
 *   transaction as the status change (Rule 6); the store contract enforces
 *   this, so a mutation without its audit row cannot exist.
 * - Emergency pause set/clear reuse the production resilience repository,
 *   which already writes its own in-transaction evidence event; the router
 *   additionally records an owner_control_audit row. If that extra audit
 *   insert fails, the response is an honest 500 while the durable pause
 *   state remains visible via GET /control/pauses (never fabricated).
 * - Responses use strict field allowlists (Rule 17). Unknown fields never
 *   serialize. Error bodies use a fixed public error-code allowlist.
 * - Approval decisions are READ-ONLY here (queue listing). Publishing
 *   approval remains owner-gated per Rule 7 and out of scope for this slice.
 */

import { Router } from "express";
import { createHash } from "node:crypto";
import { deepRedactAndSanitize } from "../jobs/retry/retryManager.js";

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_ID_RE = /^[a-zA-Z0-9_-]{3,80}$/;
const MAX_LIMIT = 200;

// Job statuses that may transition to `queued` via an owner retry. Derived
// from the jobs.status trigger contract (sql/010 + sql/017): failed → queued
// and dead_letter → queued are the only legal requeue paths.
const RETRYABLE_STATUSES = new Set(["failed", "dead_letter"]);

// Owner cancel is legal from queued/leased/running only (sql/017 trigger).
const CANCELLABLE_STATUSES = new Set(["queued", "leased", "running"]);

// Pause scope types mirror sql/014 emergency_pauses.scope_type exactly (R5).
const PAUSE_SCOPE_TYPES = new Set(["global_owner", "agent", "operation"]);
const PAUSE_REASON_CODES = new Set(["OWNER_REQUEST", "SECURITY_EVENT", "QUOTA_EXHAUSTED", "RECOVERY_GUARD"]);
const MAX_DETAIL_BYTES = 2048;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(code, status) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status ?? 400;
  return error;
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail(code);
  }
}

function requireString(value, code, { max, pattern } = {}) {
  if (typeof value !== "string" || value.length === 0) throw fail(code);
  if (max !== undefined && value.length > max) throw fail(code);
  if (pattern && !pattern.test(value)) throw fail(code);
  return value;
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function boundedJson(value, code) {
  if (value === null || value === undefined) return {};
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw fail(code);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_DETAIL_BYTES) {
    throw fail(code);
  }
  return value;
}

// ---------------------------------------------------------------------------
// CSRF: per-session tokens, hashed at rest
// ---------------------------------------------------------------------------

function issueCsrfToken(sessions, tokenHash) {
  const raw = createHash("sha256")
    .update(`${tokenHash}:${Date.now()}:${Math.random()}`)
    .digest("hex");
  sessions.get(tokenHash).csrfTokenHash = createHash("sha256").update(raw).digest("hex");
  return raw;
}

function requireCsrf(req, sessions) {
  const tokenHash = createHash("sha256")
    .update(String(req.headers.authorization || "").substring(7).trim())
    .digest("hex");
  const session = sessions.get(tokenHash);
  const provided = req.headers["x-csrf-token"];
  if (
    !session ||
    typeof session.csrfTokenHash !== "string" ||
    typeof provided !== "string" ||
    provided.length < 16 ||
    provided.length > 128 ||
    createHash("sha256").update(provided).digest("hex") !== session.csrfTokenHash
  ) {
    throw fail("CSRF_TOKEN_INVALID", 403);
  }
}

// ---------------------------------------------------------------------------
// Safe DTO projections (Rule 17)
// ---------------------------------------------------------------------------

function approvalDto(row) {
  return {
    id: row.id,
    status: row.status,
    destination: row.destination,
    captionSnapshot: row.caption_snapshot,
    mode: row.mode,
    artifactSha256: row.artifact_sha256,
    artifactKind: row.artifact_kind,
    jobCapability: row.job_capability,
    createdAt: toIso(row.created_at),
    approvalExpiresAt: toIso(row.approval_expires_at),
  };
}

function jobDto(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    capability: row.capability,
    status: row.status,
    priority: row.priority,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: toIso(row.lease_expires_at),
    nextAttemptAt: toIso(row.next_attempt_at),
    updatedAt: toIso(row.updated_at),
  };
}

function pauseDto(row) {
  return {
    id: row.id,
    scopeType: row.scope_type,
    agentId: row.agent_id ?? null,
    operation: row.operation ?? null,
    reasonCode: row.reason_code,
    active: row.active === true,
    createdAt: toIso(row.created_at),
    clearedAt: toIso(row.cleared_at),
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOwnerControlRouter(options = {}) {
  const router = Router();

  const sessions = options.sessions; // shared with ownerServer (requireAuth)
  const store = options.jobControlStore; // jobs, approvals, pauses, audit
  const ledger = options.evidenceLedger;
  const resilience = options.resilienceRepository; // PostgresResilienceRepository
  const dbAdapter = options.dbAdapter; // PostgresAdapter (owner_control_audit)
  const hasLedger = ledger !== null && ledger !== undefined;

  if (!sessions || typeof sessions.get !== "function") {
    throw new Error("OWNER_CONTROL_SESSIONS_REQUIRED");
  }
  // The job control store is validated at request time (honest 503) rather
  // than at construction, so the owner API can boot without production
  // dependencies configured and still serve authenticated reads.
  function requireStore() {
    if (!store || typeof store !== "object" || typeof store.getJobForOwner !== "function") {
      throw fail("JOB_CONTROL_STORE_UNAVAILABLE", 503);
    }
  }

  // Wrap every route so domain failures become clean allowlisted 4xx/5xx and
  // unexpected failures become a generic 500 (no stack, no input echo).
  function guarded(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : null;
        const status = typeof error?.httpStatus === "number" ? error.httpStatus : 500;
        const safeMessage = deepRedactAndSanitize(String(error?.message ?? "INTERNAL_SERVER_ERROR"));
        if (code && status !== 500) {
          res.status(status).json({ error: code });
        } else {
          res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
        }
        // Sanitized detail for server logs only, behind an explicit opt-in.
        if (process.env.STPH_CONTROL_DEBUG === "1") {
          console.error(`[ownerControl] ${code ?? "UNHANDLED"}: ${safeMessage}`);
        }
      }
    };
  }

  function ownerIdOf(req) {
    const ownerId = req.session?.ownerId;
    if (typeof ownerId !== "string" || !OWNER_ID_RE.test(ownerId)) {
      throw fail("UNAUTHORIZED", 401);
    }
    return ownerId;
  }

  function parseLimit(raw) {
    if (raw === undefined || raw === null || raw === "") return 50;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
      throw fail("QUERY_INVALID");
    }
    return value;
  }

  function requireJobId(req) {
    const raw = req.params?.jobId;
    if (typeof raw !== "string" || !UUID_RE.test(raw)) throw fail("JOB_ID_INVALID");
    return raw;
  }

  function requirePauseId(req) {
    const raw = req.params?.pauseId;
    if (typeof raw !== "string" || !UUID_RE.test(raw)) throw fail("PAUSE_ID_INVALID");
    return raw;
  }

  function requireDb() {
    if (!dbAdapter || typeof dbAdapter.query !== "function") {
      throw fail("DATABASE_ADAPTER_UNAVAILABLE", 503);
    }
  }

  function requireResilience() {
    if (!resilience || typeof resilience.setPause !== "function" || typeof resilience.clearPause !== "function") {
      throw fail("RESILIENCE_REPOSITORY_UNAVAILABLE", 503);
    }
  }

  async function recordAudit({ ownerId, agentId, jobId, action, fromStatus, toStatus, detail }) {
    requireDb();
    await dbAdapter.query(
      `INSERT INTO owner_control_audit (owner_id, agent_id, job_id, action, from_status, to_status, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ownerId, agentId, jobId, action, fromStatus, toStatus, JSON.stringify(detail ?? {})]
    );
  }

  // -------------------------------------------------------------------------
  // GET /control/approvals — the pending owner-approval queue (read-only)
  // -------------------------------------------------------------------------
  router.get(
    "/approvals",
    guarded(async (req, res) => {
      requireStore();
      const ownerId = ownerIdOf(req);
      const limit = parseLimit(req.query?.limit);
      const rows = await store.listPendingApprovals(ownerId, limit);
      const approvals = (rows ?? []).map(approvalDto);
      res.status(200).json({ ownerId, count: approvals.length, approvals });
    })
  );

  // -------------------------------------------------------------------------
  // POST /control/jobs/:jobId/retry — requeue a retryable job (owner action)
  // -------------------------------------------------------------------------
  router.post(
    "/jobs/:jobId/retry",
    guarded(async (req, res) => {
      requireCsrf(req, sessions);
      const ownerId = ownerIdOf(req);
      const jobId = requireJobId(req);
      requirePlainObject(req.body ?? {}, "REQUEST_BODY_INVALID");

      requireStore();
      const job = await store.getJobForOwner(ownerId, jobId);
      if (!job) throw fail("NOT_FOUND", 404);
      if (!RETRYABLE_STATUSES.has(job.status)) {
        throw fail("JOB_NOT_RETRYABLE", 409);
      }
      const fromStatus = job.status;
      const updated = await store.retryJob(ownerId, jobId, fromStatus, {
        action: "job_retry",
        detail: { capability: job.capability ?? null, attempts: Number(job.attempts) },
      });
      if (!updated) throw fail("NOT_FOUND", 404);

      if (hasLedger) {
        ledger.append({
          subjectId: jobId,
          kind: "owner_job_retry",
          classification: "owner_authorized_recovery",
          payload: { ownerId, agentId: updated.agentId ?? null, fromStatus, toStatus: "queued" },
        });
      }

      res.status(200).json({ job: jobDto(updated) });
    })
  );

  // -------------------------------------------------------------------------
  // POST /control/jobs/:jobId/cancel — cancel a non-terminal job
  // -------------------------------------------------------------------------
  router.post(
    "/jobs/:jobId/cancel",
    guarded(async (req, res) => {
      requireCsrf(req, sessions);
      const ownerId = ownerIdOf(req);
      const jobId = requireJobId(req);
      requirePlainObject(req.body ?? {}, "REQUEST_BODY_INVALID");

      requireStore();
      const job = await store.getJobForOwner(ownerId, jobId);
      if (!job) throw fail("NOT_FOUND", 404);
      if (!CANCELLABLE_STATUSES.has(job.status)) {
        throw fail("JOB_NOT_CANCELLABLE", 409);
      }
      const fromStatus = job.status;
      const updated = await store.cancelJob(ownerId, jobId, fromStatus, {
        action: "job_cancel",
        detail: { capability: job.capability ?? null, attempts: Number(job.attempts) },
      });
      if (!updated) throw fail("NOT_FOUND", 404);

      if (hasLedger) {
        ledger.append({
          subjectId: jobId,
          kind: "owner_job_cancel",
          classification: "owner_authorized_cancel",
          payload: { ownerId, agentId: updated.agentId ?? null, fromStatus, toStatus: "owner_cancelled" },
        });
      }

      res.status(200).json({ job: jobDto(updated) });
    })
  );

  // -------------------------------------------------------------------------
  // GET /control/pauses — active emergency pauses for the session owner
  // -------------------------------------------------------------------------
  router.get(
    "/pauses",
    guarded(async (req, res) => {
      requireStore();
      const ownerId = ownerIdOf(req);
      const rows = await store.listActivePauses(ownerId);
      const pauses = (rows ?? []).map(pauseDto);
      res.status(200).json({ ownerId, count: pauses.length, pauses });
    })
  );

  // -------------------------------------------------------------------------
  // POST /control/pauses — set an emergency pause (reuses the resilience repo)
  // -------------------------------------------------------------------------
  router.post(
    "/pauses",
    guarded(async (req, res) => {
      requireCsrf(req, sessions);
      const ownerId = ownerIdOf(req);
      requirePlainObject(req.body ?? {}, "REQUEST_BODY_INVALID");
      if (req.body.ownerId !== undefined && req.body.ownerId !== ownerId) {
        // Never let a client select another owner's scope.
        throw fail("SCOPE_MISMATCH", 403);
      }
      const scopeType = requireString(req.body.scopeType, "PAUSE_SCOPE_INVALID", {
        max: 20,
        pattern: /^[a-z_]+$/,
      });
      if (!PAUSE_SCOPE_TYPES.has(scopeType)) throw fail("PAUSE_SCOPE_INVALID");
      const reasonCode = requireString(req.body.reasonCode, "PAUSE_REASON_INVALID", { max: 40 });
      if (!PAUSE_REASON_CODES.has(reasonCode)) throw fail("PAUSE_REASON_INVALID");
      const approvalId = requireString(req.body.approvalId, "APPROVAL_ID_INVALID", { max: 160 });
      if (/\bvault:\/\//i.test(approvalId)) throw fail("APPROVAL_ID_INVALID");
      const detail = boundedJson(req.body.detail, "PAUSE_DETAIL_INVALID");

      requireResilience();

      const agentId =
        scopeType === "global_owner" ? null : requireString(req.body.agentId, "AGENT_ID_INVALID", { max: 200 });
      const operation =
        scopeType === "operation" ? requireString(req.body.operation, "OPERATION_INVALID", { max: 120 }) : null;

      const pause = await resilience.setPause(
        { ownerId, agentId, scopeType, operation },
        { reasonCode, approvalId, authorizedOwnerId: ownerId }
      );

      await recordAudit({
        ownerId,
        agentId,
        jobId: null,
        action: "emergency_pause_set",
        fromStatus: null,
        toStatus: "active",
        detail: { pauseId: pause.id, scopeType, reasonCode, operation, ...detail },
      });
      if (hasLedger) {
        ledger.append({
          subjectId: pause.id,
          kind: "owner_emergency_pause_set",
          classification: "owner_authorized_pause",
          payload: { ownerId, agentId, scopeType, operation, reasonCode },
        });
      }

      res.status(201).json({
        pause: {
          id: pause.id,
          scopeType: pause.scopeType,
          agentId: pause.agentId ?? null,
          operation: pause.operation ?? null,
          reasonCode: pause.reasonCode,
          active: true,
        },
      });
    })
  );

  // -------------------------------------------------------------------------
  // POST /control/pauses/:pauseId/clear — clear an active emergency pause
  // -------------------------------------------------------------------------
  router.post(
    "/pauses/:pauseId/clear",
    guarded(async (req, res) => {
      requireCsrf(req, sessions);
      const ownerId = ownerIdOf(req);
      const pauseId = requirePauseId(req);
      requirePlainObject(req.body ?? {}, "REQUEST_BODY_INVALID");
      const approvalId = requireString(req.body.approvalId, "APPROVAL_ID_INVALID", { max: 160 });
      if (/\bvault:\/\//i.test(approvalId)) throw fail("APPROVAL_ID_INVALID");

      requireResilience();

      await resilience.clearPause({ ownerId, pauseId }, { approvalId, authorizedOwnerId: ownerId });

      await recordAudit({
        ownerId,
        agentId: null,
        jobId: null,
        action: "emergency_pause_cleared",
        fromStatus: "active",
        toStatus: "cleared",
        detail: { pauseId, approvalId },
      });
      if (hasLedger) {
        ledger.append({
          subjectId: pauseId,
          kind: "owner_emergency_pause_cleared",
          classification: "owner_authorized_recovery",
          payload: { ownerId, pauseId, approvalId },
        });
      }

      res.status(200).json({ pause: { id: pauseId, active: false } });
    })
  );

  return Object.assign(router, { issueCsrfToken });
}

export default createOwnerControlRouter;
