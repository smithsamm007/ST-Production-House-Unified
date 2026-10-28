const SHA256_HEX = /^[0-9a-f]{64}$/;

function required(value, code, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new Error(code);
  }
  return value;
}

export class PostgresCheckpointAdapter {
  constructor(adapter, { ownerId, agentId } = {}) {
    if (!adapter || typeof adapter.query !== "function" || typeof adapter.withTransaction !== "function") {
      throw new Error("POSTGRES_CHECKPOINT_TRANSACTION_ADAPTER_REQUIRED");
    }
    this.adapter = adapter;
    this.ownerId = required(ownerId, "CHECKPOINT_OWNER_ID_REQUIRED", 100);
    this.agentId = required(agentId, "CHECKPOINT_AGENT_ID_REQUIRED", 200);
    this.name = "PostgresCheckpointAdapter";
    this.isInMemory = false;
  }

  async get(taskId) {
    required(taskId, "CHECKPOINT_TASK_ID_REQUIRED", 160);
    const result = await this.adapter.query(
      `SELECT checkpoint_record
         FROM job_checkpoints
        WHERE task_id = $1 AND owner_id = $2 AND agent_id = $3`,
      [taskId, this.ownerId, this.agentId]
    );
    if (result.rowCount === 0) return null;
    return JSON.stringify(result.rows[0].checkpoint_record);
  }

  async set(taskId, serializedRecord) {
    required(taskId, "CHECKPOINT_TASK_ID_REQUIRED", 160);
    if (typeof serializedRecord !== "string" || Buffer.byteLength(serializedRecord, "utf8") > 1_048_576) {
      throw new Error("CHECKPOINT_RECORD_INVALID_OR_TOO_LARGE");
    }

    let record;
    try {
      record = JSON.parse(serializedRecord);
    } catch {
      throw new Error("CHECKPOINT_RECORD_INVALID_JSON");
    }
    if (!record || Array.isArray(record) || record.taskId !== taskId) {
      throw new Error("CHECKPOINT_RECORD_SCOPE_MISMATCH");
    }
    if (!SHA256_HEX.test(record.payloadHash) || !SHA256_HEX.test(record.checksum)) {
      throw new Error("CHECKPOINT_RECORD_HASH_INVALID");
    }

    return this.adapter.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO job_checkpoints
           (task_id, owner_id, agent_id, checkpoint_record, payload_hash, checksum)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (task_id) DO UPDATE SET
           checkpoint_record = EXCLUDED.checkpoint_record,
           payload_hash = EXCLUDED.payload_hash,
           checksum = EXCLUDED.checksum,
           version = job_checkpoints.version + 1,
           updated_at = now()
         WHERE job_checkpoints.owner_id = EXCLUDED.owner_id
           AND job_checkpoints.agent_id = EXCLUDED.agent_id
         RETURNING version`,
        [taskId, this.ownerId, this.agentId, serializedRecord, record.payloadHash, record.checksum]
      );
      if (result.rowCount !== 1) throw new Error("CHECKPOINT_SCOPE_MISMATCH");
      return { version: Number(result.rows[0].version) };
    });
  }
}
