import { randomUUID } from "node:crypto";
import {
  classifyRetryError,
  calculateNextAttemptDelay,
  sanitizeErrorMessage,
  appendEvidenceEventXact,
} from "../retry/retryManager.js";

/**
 * Normalizes an object for database operations.
 */
function toJobObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    capability: row.capability,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    backoffMetadata: row.backoff_metadata || {},
  };
}

/**
 * Validates the lease duration as a bounded positive integer.
 */
function validateLeaseDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0 || seconds > 86400) {
    throw new Error("INVALID_LEASE_DURATION");
  }
}

/**
 * Idempotent job creation.
 * Checks idempotency_key and returns existing job if already present,
 * or inserts a new job if not.
 */
export async function createJob(clientOrAdapter, { agentId, capability, idempotencyKey, payload, maxAttempts = 3, priority = 100 }) {
  const jobId = randomUUID();

  const run = async (client) => {
    let res = await client.query(
      `INSERT INTO jobs (id, agent_id, capability, idempotency_key, status, priority, attempts, max_attempts, payload)
       VALUES ($1, $2, $3, $4, 'queued', $5, 0, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *;`,
      [jobId, agentId, capability, idempotencyKey, priority, maxAttempts, JSON.stringify(payload)]
    );

    if (res.rowCount === 0 || !res.rows[0]) {
      res = await client.query(
        "SELECT * FROM jobs WHERE idempotency_key = $1;",
        [idempotencyKey]
      );
    }
    return toJobObject(res.rows[0]);
  };

  if (typeof clientOrAdapter.withTransaction === "function") {
    return await clientOrAdapter.withTransaction(run);
  } else {
    return await run(clientOrAdapter);
  }
}

/**
 * Safe lease acquisition.
 * Checks agent's concurrency limit under locks, selects the highest priority queued job,
 * and leases it.
 */
export async function claimJob(clientOrAdapter, { agentId, capability, leaseOwner, leaseDurationSeconds }) {
  validateLeaseDuration(leaseDurationSeconds);

  const run = async (client) => {
    // 1. Lock agent row to serialize concurrent lease claims for this agent
    const agentRes = await client.query(
      "SELECT concurrency_limit FROM agents WHERE id = $1 FOR UPDATE;",
      [agentId]
    );
    if (agentRes.rowCount === 0) {
      throw new Error(`AGENT_NOT_FOUND: ${agentId}`);
    }
    const concurrencyLimit = agentRes.rows[0].concurrency_limit;

    // 2. Count active (non-expired) jobs currently in 'leased' or 'running' state
    const activeCountRes = await client.query(
      `SELECT count(*)::integer AS active_count FROM jobs
       WHERE agent_id = $1
         AND status IN ('leased', 'running')
         AND (lease_expires_at IS NULL OR lease_expires_at >= now());`,
      [agentId]
    );
    const activeCount = activeCountRes.rows[0].active_count;

    if (activeCount >= concurrencyLimit) {
      return null; // Concurrency limit reached
    }

    // 3. Find next claimable queued job for this agent and capability
    // Sorted by priority ASC, created_at ASC (matching index/standard)
    // Avoid claiming jobs that are already exhausted (attempts >= max_attempts)
    // EXCLUDE future-scheduled jobs (next_attempt_at is NULL or <= now())
    const nextJobRes = await client.query(
      `SELECT id FROM jobs
       WHERE agent_id = $1
         AND capability = $2
         AND status = 'queued'
         AND attempts < max_attempts
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED;`,
      [agentId, capability]
    );

    if (nextJobRes.rowCount === 0) {
      return null; // No queued jobs available
    }

    const targetJobId = nextJobRes.rows[0].id;

    // 4. Update job to leased using safe interval arithmetic
    const leasedJobRes = await client.query(
      `UPDATE jobs
       SET status = 'leased',
           lease_owner = $2,
           lease_expires_at = now() + ($3 * interval '1 second'),
           attempts = attempts + 1,
           updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [targetJobId, leaseOwner, leaseDurationSeconds]
    );

    return toJobObject(leasedJobRes.rows[0]);
  };

  if (typeof clientOrAdapter.withTransaction === "function") {
    return await clientOrAdapter.withTransaction(run);
  } else {
    return await run(clientOrAdapter);
  }
}

/**
 * Lease renewal / extension.
 * Verifies that the job is currently leased or running and matches the lease owner.
 * Rejects already-expired leases in SQL.
 */
export async function renewLease(clientOrAdapter, { jobId, leaseOwner, leaseDurationSeconds }) {
  validateLeaseDuration(leaseDurationSeconds);

  const run = async (client) => {
    // Rejects already expired leases: AND (lease_expires_at IS NULL OR lease_expires_at >= now())
    const res = await client.query(
      `UPDATE jobs
       SET lease_expires_at = now() + ($3 * interval '1 second'),
           updated_at = now()
       WHERE id = $1
         AND lease_owner = $2
         AND status IN ('leased', 'running')
         AND (lease_expires_at IS NULL OR lease_expires_at >= now())
       RETURNING *;`,
      [jobId, leaseOwner, leaseDurationSeconds]
    );

    if (res.rowCount === 0) {
      throw new Error("LEASE_NOT_FOUND_OR_EXPIRED_OR_OWNER_MISMATCH");
    }
    return toJobObject(res.rows[0]);
  };

  if (typeof clientOrAdapter.withTransaction === "function") {
    return await clientOrAdapter.withTransaction(run);
  } else {
    return await run(clientOrAdapter);
  }
}

/**
 * Transition job to running.
 */
export async function startJob(clientOrAdapter, { jobId, leaseOwner }) {
  const run = async (client) => {
    const res = await client.query(
      `UPDATE jobs
       SET status = 'running',
           updated_at = now()
       WHERE id = $1
         AND lease_owner = $2
         AND status = 'leased'
       RETURNING *;`,
      [jobId, leaseOwner]
    );

    if (res.rowCount === 0) {
      throw new Error("JOB_NOT_CLAIMED_OR_OWNER_MISMATCH");
    }
    return toJobObject(res.rows[0]);
  };

  if (typeof clientOrAdapter.withTransaction === "function") {
    return await clientOrAdapter.withTransaction(run);
  } else {
    return await run(clientOrAdapter);
  }
}

/**
 * Complete job successfully.
 * Aligned with DB trigger: only running jobs can transition to succeeded.
 */
export async function completeJob(clientOrAdapter, { jobId, leaseOwner, resultPayload }) {
  const run = async (client) => {
    const res = await client.query(
      `UPDATE jobs
       SET status = 'succeeded',
           payload = jsonb_set(payload, '{result}', $3::jsonb, true),
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1
         AND lease_owner = $2
         AND status = 'running'
       RETURNING *;`,
      [jobId, leaseOwner, JSON.stringify(resultPayload)]
    );

    if (res.rowCount === 0) {
      throw new Error("JOB_NOT_FOUND_OR_LEASE_MISMATCH");
    }
    return toJobObject(res.rows[0]);
  };

  if (typeof clientOrAdapter.withTransaction === "function") {
    return await clientOrAdapter.withTransaction(run);
  } else {
    return await run(clientOrAdapter);
  }
}

/**
 * Helper fail function used internally to handle transition steps sequentially.
 */
async function failJobInternal(client, { jobId, leaseOwner, errorPayload, isLeaseExpiry = false }, retryOptions = {}) {
  // 1. Fetch agent_id, capability, attempts, max_attempts, payload
  const checkRes = await client.query(
    `SELECT agent_id, capability, attempts, max_attempts, payload, backoff_metadata
     FROM jobs
     WHERE id = $1 AND lease_owner = $2 AND status IN ('leased', 'running')
     FOR UPDATE;`,
    [jobId, leaseOwner]
  );
  if (checkRes.rowCount === 0) {
    throw new Error("JOB_NOT_FOUND_OR_LEASE_MISMATCH");
  }
  const {
    agent_id: agentId,
    capability,
    attempts,
    max_attempts: maxAttempts,
    payload,
    backoff_metadata: oldBackoffMetadata
  } = checkRes.rows[0];

  // 2. Classify and sanitize error details
  const errorMessage = errorPayload?.message || errorPayload?.err || String(errorPayload);
  const sanitizedMsg = sanitizeErrorMessage(errorMessage);
  const classification = isLeaseExpiry ? "transient" : classifyRetryError(errorMessage);

  const cleanErrorPayload = {
    ...errorPayload,
    message: sanitizedMsg
  };

  // 3. Transition to 'failed' intermediate status to store error context
  await client.query(
    `UPDATE jobs
     SET status = 'failed',
         payload = jsonb_set(payload, '{error}', $3::jsonb, true),
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status IN ('leased', 'running');`,
    [jobId, leaseOwner, JSON.stringify(cleanErrorPayload)]
  );

  let finalRes;
  const isFatal = classification === "fatal";
  const isExhausted = attempts >= maxAttempts;
  const newBackoffMetadata = { ...oldBackoffMetadata };

  if (isFatal || isExhausted) {
    // Terminal failure: transition to 'dead_letter' durably
    newBackoffMetadata.final_failure_reason = isFatal ? "fatal_error" : "attempts_exhausted";
    newBackoffMetadata.last_classification = classification;

    finalRes = await client.query(
      `UPDATE jobs
       SET status = 'dead_letter',
           backoff_metadata = $2,
           updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [jobId, JSON.stringify(newBackoffMetadata)]
    );

    // Append append-only dead_letter evidence event (safe, allowlisted fields only)
    const evidencePayload = {
      jobId,
      agentId,
      capability,
      attempts,
      maxAttempts,
      classification,
      reason: isFatal ? "fatal_error" : "attempts_exhausted",
      error: sanitizedMsg
    };

    await appendEvidenceEventXact(client, {
      subjectId: jobId,
      kind: "job_dead_letter",
      classification: "exhausted_dead_letter",
      payload: evidencePayload
    });

  } else {
    // Retryable transient failure: transition to 'queued' with exponential backoff scheduling
    const delaySec = calculateNextAttemptDelay(attempts, retryOptions);
    const nextAttemptDate = new Date(Date.now() + delaySec * 1000);

    newBackoffMetadata.last_delay_sec = delaySec;
    newBackoffMetadata.last_classification = classification;
    newBackoffMetadata.retry_count = (newBackoffMetadata.retry_count || 0) + 1;

    finalRes = await client.query(
      `UPDATE jobs
       SET status = 'queued',
           next_attempt_at = now() + ($2 * interval '1 second'),
           backoff_metadata = $3,
           updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [jobId, delaySec, JSON.stringify(newBackoffMetadata)]
    );

    // Append append-only retry evidence event (safe, allowlisted fields only)
    const evidencePayload = {
      jobId,
      agentId,
      capability,
      attempts,
      maxAttempts,
      classification,
      nextAttemptAt: nextAttemptDate.toISOString(),
      delaySec
    };

    await appendEvidenceEventXact(client, {
      subjectId: jobId,
      kind: "job_retry",
      classification: "retry_scheduled",
      payload: evidencePayload
    });
  }

  return toJobObject(finalRes.rows[0]);
}

/**
 * Fail a job due to error.
 */
export async function failJob(clientOrAdapter, { jobId, leaseOwner, errorPayload }, retryOptions = {}) {
  const run = async (client) => {
    return await failJobInternal(client, { jobId, leaseOwner, errorPayload, isLeaseExpiry: false }, retryOptions);
  };

  if (typeof clientOrAdapter.withTransaction === "function") {
    return await clientOrAdapter.withTransaction(run);
  } else {
    return await run(clientOrAdapter);
  }
}

/**
 * Reclaim expired leases.
 */
export async function reclaimExpiredLeases(clientOrAdapter, retryOptions = {}) {
  const run = async (client) => {
    const expiredRes = await client.query(
      `SELECT id, lease_owner, attempts, max_attempts FROM jobs
       WHERE status IN ('leased', 'running')
         AND lease_expires_at < now()
       FOR UPDATE SKIP LOCKED;`
    );

    const reclaimed = [];
    for (const row of expiredRes.rows) {
      const updated = await failJobInternal(client, {
        jobId: row.id,
        leaseOwner: row.lease_owner,
        errorPayload: { message: "Lease expired and reclaimed" },
        isLeaseExpiry: true
      }, retryOptions);
      reclaimed.push(updated);
    }
    return reclaimed;
  };

  if (typeof clientOrAdapter.withTransaction === "function") {
    return await clientOrAdapter.withTransaction(run);
  } else {
    return await run(clientOrAdapter);
  }
}

/**
 * Manual replay of a dead_letter job.
 * Requires explicit owner-authorized evidence, never resets history silently,
 * and enforces strict agent/job isolation.
 */
export async function replayJob(clientOrAdapter, { jobId, agentId, ownerId, evidenceId }) {
  const run = async (client) => {
    // 1. Verify owner authorization exists in DB
    const ownerRes = await client.query(
      "SELECT id FROM owners WHERE id = $1;",
      [ownerId]
    );
    if (ownerRes.rowCount === 0) {
      throw new Error("OWNER_NOT_FOUND");
    }

    // 2. Verify evidence exists in DB
    const evidenceRes = await client.query(
      "SELECT id FROM evidence_events WHERE id = $1;",
      [evidenceId]
    );
    if (evidenceRes.rowCount === 0) {
      throw new Error("REPLAY_AUTHORIZATION_EVIDENCE_NOT_FOUND");
    }

    // 3. Select and lock the job
    const jobRes = await client.query(
      "SELECT * FROM jobs WHERE id = $1 FOR UPDATE;",
      [jobId]
    );
    if (jobRes.rowCount === 0) {
      throw new Error("JOB_NOT_FOUND");
    }
    const job = jobRes.rows[0];

    // 4. Enforce strict agent isolation: prevent cross-agent replay
    if (job.agent_id !== agentId) {
      throw new Error("AGENT_ISOLATION_VIOLATION");
    }

    // 5. Ensure job is in dead_letter status
    if (job.status !== "dead_letter") {
      throw new Error("JOB_NOT_IN_DEAD_LETTER_STATE");
    }

    // 6. Never reset history silently: increment max_attempts while leaving attempts intact
    const originalMaxAttempts = job.max_attempts;
    const newMaxAttempts = originalMaxAttempts + 3;
    const oldBackoffMetadata = job.backoff_metadata || {};

    const newBackoffMetadata = {
      ...oldBackoffMetadata,
      replayed_by_owner: ownerId,
      replay_evidence_id: evidenceId,
      replayed_at: new Date().toISOString(),
    };

    const res = await client.query(
      `UPDATE jobs
       SET status = 'queued',
           max_attempts = $2,
           next_attempt_at = now(),
           backoff_metadata = $3,
           updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [jobId, newMaxAttempts, JSON.stringify(newBackoffMetadata)]
    );

    // 7. Append append-only job replay evidence event
    const evidencePayload = {
      jobId,
      agentId,
      ownerId,
      evidenceId,
      previousMaxAttempts: originalMaxAttempts,
      newMaxAttempts,
      attempts: job.attempts,
    };

    await appendEvidenceEventXact(client, {
      subjectId: jobId,
      kind: "job_replay_authorized",
      classification: "owner_authorized_replay",
      payload: evidencePayload
    });

    return toJobObject(res.rows[0]);
  };

  if (typeof clientOrAdapter.withTransaction === "function") {
    return await clientOrAdapter.withTransaction(run);
  } else {
    return await run(clientOrAdapter);
  }
}
