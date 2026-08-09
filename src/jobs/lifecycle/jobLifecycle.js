import { randomUUID } from "node:crypto";

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
  };
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
    const nextJobRes = await client.query(
      `SELECT id FROM jobs
       WHERE agent_id = $1
         AND capability = $2
         AND status = 'queued'
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED;`,
      [agentId, capability]
    );

    if (nextJobRes.rowCount === 0) {
      return null; // No queued jobs available
    }

    const targetJobId = nextJobRes.rows[0].id;

    // 4. Update job to leased
    const leasedJobRes = await client.query(
      `UPDATE jobs
       SET status = 'leased',
           lease_owner = $2,
           lease_expires_at = now() + ($3 || ' second')::interval,
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
 */
export async function renewLease(clientOrAdapter, { jobId, leaseOwner, leaseDurationSeconds }) {
  const run = async (client) => {
    const res = await client.query(
      `UPDATE jobs
       SET lease_expires_at = now() + ($3 || ' second')::interval,
           updated_at = now()
       WHERE id = $1
         AND lease_owner = $2
         AND status IN ('leased', 'running')
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
         AND status IN ('leased', 'running')
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
async function failJobInternal(client, { jobId, leaseOwner, errorPayload }) {
  // 1. Check job attempts & max_attempts
  const checkRes = await client.query(
    "SELECT attempts, max_attempts FROM jobs WHERE id = $1 AND lease_owner = $2 AND status IN ('leased', 'running') FOR UPDATE;",
    [jobId, leaseOwner]
  );
  if (checkRes.rowCount === 0) {
    throw new Error("JOB_NOT_FOUND_OR_LEASE_MISMATCH");
  }
  const { attempts, max_attempts: maxAttempts } = checkRes.rows[0];

  // 2. Transition status to failed to store error context & trigger valid transition
  let res = await client.query(
    `UPDATE jobs
     SET status = 'failed',
         payload = jsonb_set(payload, '{error}', $3::jsonb, true),
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status IN ('leased', 'running')
     RETURNING *;`,
    [jobId, leaseOwner, JSON.stringify(errorPayload)]
  );

  // 3. If attempts >= maxAttempts, transition to dead_letter, otherwise transition to queued
  if (attempts >= maxAttempts) {
    res = await client.query(
      `UPDATE jobs
       SET status = 'dead_letter',
           updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [jobId]
    );
  } else {
    res = await client.query(
      `UPDATE jobs
       SET status = 'queued',
           updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [jobId]
    );
  }

  return toJobObject(res.rows[0]);
}

/**
 * Fail a job due to error.
 */
export async function failJob(clientOrAdapter, { jobId, leaseOwner, errorPayload }) {
  const run = async (client) => {
    return await failJobInternal(client, { jobId, leaseOwner, errorPayload });
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
export async function reclaimExpiredLeases(clientOrAdapter) {
  const run = async (client) => {
    const expiredRes = await client.query(
      `SELECT id, lease_owner, attempts, max_attempts FROM jobs
       WHERE status IN ('leased', 'running')
         AND lease_expires_at < now()
       FOR UPDATE;`
    );

    const reclaimed = [];
    for (const row of expiredRes.rows) {
      const updated = await failJobInternal(client, {
        jobId: row.id,
        leaseOwner: row.lease_owner,
        errorPayload: { message: "Lease expired and reclaimed" },
      });
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
