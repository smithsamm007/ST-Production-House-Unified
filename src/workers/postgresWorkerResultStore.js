import crypto from "node:crypto";

function required(value, code, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) throw new Error(code);
  return value;
}

export class PostgresWorkerResultStore {
  constructor(adapter, { ownerId, agentId } = {}) {
    if (!adapter || typeof adapter.query !== "function" || typeof adapter.withTransaction !== "function") {
      throw new Error("POSTGRES_WORKER_RESULT_TRANSACTION_ADAPTER_REQUIRED");
    }
    this.adapter = adapter;
    this.ownerId = required(ownerId, "WORKER_RESULT_OWNER_ID_REQUIRED", 100);
    this.agentId = required(agentId, "WORKER_RESULT_AGENT_ID_REQUIRED", 200);
    this.name = "PostgresWorkerResultStore";
    this.isInMemory = false;
  }

  async get(taskId) {
    required(taskId, "WORKER_RESULT_TASK_ID_REQUIRED", 160);
    const result = await this.adapter.query(
      "SELECT result_record FROM worker_results WHERE task_id=$1 AND owner_id=$2 AND agent_id=$3",
      [taskId, this.ownerId, this.agentId]
    );
    return result.rowCount === 0 ? null : JSON.stringify(result.rows[0].result_record);
  }

  async set(taskId, serializedResult) {
    required(taskId, "WORKER_RESULT_TASK_ID_REQUIRED", 160);
    if (typeof serializedResult !== "string" || Buffer.byteLength(serializedResult, "utf8") > 1_048_576) {
      throw new Error("WORKER_RESULT_INVALID_OR_TOO_LARGE");
    }
    let record;
    try { record = JSON.parse(serializedResult); } catch { throw new Error("WORKER_RESULT_INVALID_JSON"); }
    if (!record || Array.isArray(record) || record.taskId !== taskId || record.status !== "success") {
      throw new Error("WORKER_RESULT_RECORD_INVALID");
    }
    const resultHash = crypto.createHash("sha256").update(serializedResult).digest("hex");
    return this.adapter.withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO worker_results(task_id,owner_id,agent_id,result_record,result_hash)
         VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(task_id) DO NOTHING RETURNING task_id`,
        [taskId, this.ownerId, this.agentId, serializedResult, resultHash]
      );
      if (inserted.rowCount === 1) return;
      const existing = await client.query(
        "SELECT owner_id,agent_id,result_hash FROM worker_results WHERE task_id=$1 FOR UPDATE",
        [taskId]
      );
      if (existing.rowCount !== 1 || existing.rows[0].owner_id !== this.ownerId || existing.rows[0].agent_id !== this.agentId) {
        throw new Error("WORKER_RESULT_SCOPE_MISMATCH");
      }
      if (existing.rows[0].result_hash !== resultHash) throw new Error("WORKER_RESULT_CONFLICT");
    });
  }
}
