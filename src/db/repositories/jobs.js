// Phase 2: Job, Worker, and Evidence Repositories

export class JobLifecycleRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("JobLifecycleRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async createJob({
    ownerId,
    agentId,
    jobType,
    inputData,
    priority,
    timeoutMs
  }) {
    if (!ownerId || !agentId || !jobType) {
      throw new Error("createJob requires ownerId, agentId, jobType");
    }

    const validStatuses = ["queued", "running", "completed", "failed", "cancelled"];
    const validPriorities = ["low", "normal", "high", "critical"];

    if (priority && !validPriorities.includes(priority)) {
      throw new Error(`Invalid priority: ${priority}`);
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO jobs (
          owner_id, agent_id, job_type, input_data, priority,
          timeout_ms, status, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'queued', now())
        RETURNING id, status, created_at, updated_at
        `,
        [
          ownerId,
          agentId,
          jobType,
          JSON.stringify(inputData || {}),
          priority || "normal",
          timeoutMs || 300000
        ]
      );

      return {
        jobId: result.rows[0].id,
        status: result.rows[0].status,
        createdAt: result.rows[0].created_at,
        updatedAt: result.rows[0].updated_at
      };
    } finally {
      await conn.release();
    }
  }

  async getJob({ ownerId, agentId, jobId }) {
    if (!ownerId || !agentId || !jobId) {
      throw new Error("getJob requires ownerId, agentId, jobId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, owner_id, agent_id, job_type, status, priority,
          input_data, output_data, error_message, timeout_ms,
          started_at, completed_at, created_at, updated_at
        FROM jobs
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        `,
        [ownerId, agentId, jobId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        jobId: row.id,
        agentId: row.agent_id,
        jobType: row.job_type,
        status: row.status,
        priority: row.priority,
        inputData: JSON.parse(row.input_data || "{}"),
        outputData: row.output_data ? JSON.parse(row.output_data) : null,
        errorMessage: row.error_message,
        timeoutMs: row.timeout_ms,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } finally {
      await conn.release();
    }
  }

  async listJobs({
    ownerId,
    agentId,
    status,
    limit = 50,
    offset = 0
  }) {
    if (!ownerId || !agentId) {
      throw new Error("listJobs requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      let query = `
        SELECT
          id, job_type, status, priority, created_at, updated_at
        FROM jobs
        WHERE owner_id = $1 AND agent_id = $2
      `;
      const params = [ownerId, agentId];

      if (status) {
        query += ` AND status = $${params.length + 1}`;
        params.push(status);
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await conn.query(query, params);

      return result.rows.map(row => ({
        jobId: row.id,
        jobType: row.job_type,
        status: row.status,
        priority: row.priority,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    } finally {
      await conn.release();
    }
  }

  async updateJobStatus({
    ownerId,
    agentId,
    jobId,
    status,
    outputData,
    errorMessage
  }) {
    if (!ownerId || !agentId || !jobId || !status) {
      throw new Error("updateJobStatus requires ownerId, agentId, jobId, status");
    }

    const validStatuses = ["queued", "running", "completed", "failed", "cancelled"];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }

    const conn = await this.adapter.getConnection();
    try {
      let query = `
        UPDATE jobs
        SET status = $4, updated_at = now()
      `;
      const params = [ownerId, agentId, jobId, status];

      if (status === "running" && !outputData && !errorMessage) {
        query += `, started_at = now()`;
      }

      if (outputData) {
        query += `, output_data = $${params.length + 1}`;
        params.push(JSON.stringify(outputData));
      }

      if (errorMessage) {
        query += `, error_message = $${params.length + 1}`;
        params.push(errorMessage);
      }

      if (status === "completed" || status === "failed") {
        query += `, completed_at = now()`;
      }

      query += `
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        RETURNING id, status, updated_at
      `;

      const result = await conn.query(query, params);

      if (result.rows.length === 0) return null;

      return {
        jobId: result.rows[0].id,
        status: result.rows[0].status,
        updatedAt: result.rows[0].updated_at
      };
    } finally {
      await conn.release();
    }
  }
}

// Worker Lease Repository - Manages worker pool and concurrency
export class WorkerLeaseRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("WorkerLeaseRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async claimLease({
    ownerId,
    agentId,
    workerId,
    leaseTimeoutMs
  }) {
    if (!ownerId || !agentId || !workerId) {
      throw new Error("claimLease requires ownerId, agentId, workerId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        WITH available_job AS (
          SELECT id FROM jobs
          WHERE owner_id = $1 AND agent_id = $2
            AND status = 'queued'
            AND (emergency_pause_until IS NULL OR emergency_pause_until < now())
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        INSERT INTO worker_leases (owner_id, agent_id, worker_id, job_id, lease_until)
        SELECT $1, $2, $3, id, now() + interval '1 millisecond' * $4
        FROM available_job
        RETURNING id, job_id, lease_until
        `,
        [ownerId, agentId, workerId, leaseTimeoutMs || 300000]
      );

      if (result.rows.length === 0) {
        return null; // No job available
      }

      // Mark job as running
      await conn.query(
        `
        UPDATE jobs
        SET status = 'running', started_at = now()
        WHERE id = $1
        `,
        [result.rows[0].job_id]
      );

      return {
        leaseId: result.rows[0].id,
        jobId: result.rows[0].job_id,
        leaseUntil: result.rows[0].lease_until
      };
    } finally {
      await conn.release();
    }
  }

  async renewLease({
    ownerId,
    agentId,
    leaseId,
    leaseTimeoutMs
  }) {
    if (!ownerId || !agentId || !leaseId) {
      throw new Error("renewLease requires ownerId, agentId, leaseId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE worker_leases
        SET lease_until = now() + interval '1 millisecond' * $4, updated_at = now()
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        RETURNING id, lease_until
        `,
        [ownerId, agentId, leaseId, leaseTimeoutMs || 300000]
      );

      if (result.rows.length === 0) return null;

      return {
        leaseId: result.rows[0].id,
        leaseUntil: result.rows[0].lease_until
      };
    } finally {
      await conn.release();
    }
  }

  async releaseLease({ ownerId, agentId, leaseId }) {
    if (!ownerId || !agentId || !leaseId) {
      throw new Error("releaseLease requires ownerId, agentId, leaseId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        DELETE FROM worker_leases
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        RETURNING job_id
        `,
        [ownerId, agentId, leaseId]
      );

      if (result.rows.length === 0) return null;

      return { leaseId, released: true };
    } finally {
      await conn.release();
    }
  }

  async listActiveLeases({ ownerId, agentId }) {
    if (!ownerId || !agentId) {
      throw new Error("listActiveLeases requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, worker_id, job_id, lease_until, created_at
        FROM worker_leases
        WHERE owner_id = $1 AND agent_id = $2
          AND lease_until > now()
        ORDER BY created_at DESC
        `,
        [ownerId, agentId]
      );

      return result.rows.map(row => ({
        leaseId: row.id,
        workerId: row.worker_id,
        jobId: row.job_id,
        leaseUntil: row.lease_until,
        createdAt: row.created_at
      }));
    } finally {
      await conn.release();
    }
  }
}

// Job Evidence Repository - Stores execution results and audit trail
export class JobEvidenceRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("JobEvidenceRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async createEvidence({
    ownerId,
    agentId,
    jobId,
    evidenceType,
    evidenceData,
    provider
  }) {
    if (!ownerId || !agentId || !jobId || !evidenceType || !evidenceData) {
      throw new Error(
        "createEvidence requires ownerId, agentId, jobId, evidenceType, evidenceData"
      );
    }

    const validTypes = [
      "provider_request",
      "provider_response",
      "provider_error",
      "checkpoint_state",
      "retry_attempt",
      "quota_check"
    ];

    if (!validTypes.includes(evidenceType)) {
      throw new Error(`Invalid evidenceType: ${evidenceType}`);
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO job_evidence (
          owner_id, agent_id, job_id, evidence_type, evidence_data,
          provider, recorded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, now())
        RETURNING id, recorded_at
        `,
        [
          ownerId,
          agentId,
          jobId,
          evidenceType,
          JSON.stringify(evidenceData),
          provider || null
        ]
      );

      return {
        evidenceId: result.rows[0].id,
        recordedAt: result.rows[0].recorded_at
      };
    } finally {
      await conn.release();
    }
  }

  async getEvidence({ ownerId, agentId, evidenceId }) {
    if (!ownerId || !agentId || !evidenceId) {
      throw new Error("getEvidence requires ownerId, agentId, evidenceId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, job_id, evidence_type, evidence_data, provider, recorded_at
        FROM job_evidence
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        `,
        [ownerId, agentId, evidenceId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        evidenceId: row.id,
        jobId: row.job_id,
        evidenceType: row.evidence_type,
        evidenceData: JSON.parse(row.evidence_data),
        provider: row.provider,
        recordedAt: row.recorded_at
      };
    } finally {
      await conn.release();
    }
  }

  async listEvidence({
    ownerId,
    agentId,
    jobId,
    evidenceType,
    limit = 100
  }) {
    if (!ownerId || !agentId || !jobId) {
      throw new Error("listEvidence requires ownerId, agentId, jobId");
    }

    const conn = await this.adapter.getConnection();
    try {
      let query = `
        SELECT
          id, evidence_type, provider, recorded_at
        FROM job_evidence
        WHERE owner_id = $1 AND agent_id = $2 AND job_id = $3
      `;
      const params = [ownerId, agentId, jobId];

      if (evidenceType) {
        query += ` AND evidence_type = $${params.length + 1}`;
        params.push(evidenceType);
      }

      query += ` ORDER BY recorded_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await conn.query(query, params);

      return result.rows.map(row => ({
        evidenceId: row.id,
        evidenceType: row.evidence_type,
        provider: row.provider,
        recordedAt: row.recorded_at
      }));
    } finally {
      await conn.release();
    }
  }
}
