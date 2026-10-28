import { createHash } from "node:crypto";

export class CheckpointValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckpointValidationError";
  }
}

export class CheckpointCorruptedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckpointCorruptedError";
  }
}

/**
 * Normalizes and computes a stable sha256 hash of a JSON-serializable object
 * to ensure integrity checks and idempotency.
 */
function stableHash(value) {
  function stable(val) {
    if (Array.isArray(val)) return val.map(stable);
    if (val && typeof val === "object") {
      return Object.fromEntries(
        Object.keys(val).sort().map((key) => [key, stable(val[key])])
      );
    }
    return val;
  }
  const serialized = JSON.stringify(stable(value));
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Deep freezes an object recursively to ensure strict immutability.
 */
export function deepFreeze(obj) {
  if (obj && typeof obj === "object") {
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
      const val = obj[key];
      if (val && typeof val === "object" && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
  }
  return obj;
}

export class CheckpointStore {
  /**
   * Constructs the CheckpointStore.
   * Prohibits silent in-memory fallbacks and requires a valid durable adapter.
   */
  constructor(adapter) {
    if (!adapter) {
      throw new Error("CheckpointStore requires a durable checkpoint adapter.");
    }

    // Validate adapter interface
    if (typeof adapter.get !== "function" || typeof adapter.set !== "function") {
      throw new Error("Invalid checkpoint adapter interface. Must implement 'get' and 'set' methods.");
    }

    // Enforce that silent in-memory persistence is blocked in production, only explicitly named test adapter in tests is allowed
    const isExplicitTestAdapter =
      adapter.name === "TestCheckpointAdapter" ||
      adapter.constructor?.name === "TestCheckpointAdapter";

    if (!isExplicitTestAdapter && adapter.isInMemory === true) {
      throw new Error("Silent in-memory persistence is prohibited in production CheckpointStore. A durable checkpoint adapter is required.");
    }

    this.adapter = adapter;
  }

  /**
   * Writes a checkpoint for a specific task.
   * Enforces rigorous validation on step, progress, and references.
   */
  async write(taskId, { step, progress, data = {}, artifactRefs = [], evidenceRefs = [] }) {
    if (!taskId || typeof taskId !== "string" || !taskId.trim()) {
      throw new CheckpointValidationError("Invalid or missing 'taskId'");
    }
    if (!step || typeof step !== "string" || !step.trim()) {
      throw new CheckpointValidationError("Invalid or missing 'step' string");
    }
    if (typeof progress !== "number" || progress < 0 || progress > 100 || Number.isNaN(progress)) {
      throw new CheckpointValidationError("Progress must be a number between 0 and 100");
    }
    if (typeof data !== "object" || data === null) {
      throw new CheckpointValidationError("Checkpoint 'data' must be a valid object");
    }
    if (!Array.isArray(artifactRefs)) {
      throw new CheckpointValidationError("artifactRefs must be an array");
    }
    if (!Array.isArray(evidenceRefs)) {
      throw new CheckpointValidationError("evidenceRefs must be an array");
    }

    // Validate artifactRefs elements
    for (const art of artifactRefs) {
      if (!art || typeof art !== "object") {
        throw new CheckpointValidationError("Each artifact reference must be an object");
      }
      if (!art.path || !art.sha256) {
        throw new CheckpointValidationError("Artifact references must contain 'path' and 'sha256' properties");
      }
    }

    // Deep copy inputs to preserve isolation and avoid mutation
    const cleanData = JSON.parse(JSON.stringify(data));
    const cleanArtifacts = JSON.parse(JSON.stringify(artifactRefs));
    const cleanEvidence = JSON.parse(JSON.stringify(evidenceRefs));

    // Calculate core payload hash (independent of updatedAt metadata) to support robust write idempotency
    const corePayload = {
      step,
      progress,
      data: cleanData,
      artifactRefs: cleanArtifacts,
      evidenceRefs: cleanEvidence
    };

    const payloadHash = stableHash(corePayload);

    // Read previous checkpoint to handle idempotency
    const existing = await this.read(taskId);
    if (existing && existing.payloadHash === payloadHash) {
      // Idempotent write: exact same checkpoint state already exists
      return existing;
    }

    const updatedAt = new Date().toISOString();
    const checkpointRecord = {
      taskId,
      ...corePayload,
      updatedAt,
      payloadHash,
      checksum: stableHash({ taskId, ...corePayload, updatedAt, payloadHash })
    };

    // Store checkpoint using the persistence adapter
    await this.adapter.set(taskId, JSON.stringify(checkpointRecord));

    return deepFreeze(JSON.parse(JSON.stringify(checkpointRecord)));
  }

  /**
   * Reads the checkpoint for a task, verifying its data integrity.
   */
  async read(taskId) {
    if (!taskId || typeof taskId !== "string") {
      throw new CheckpointValidationError("Invalid 'taskId'");
    }

    const raw = await this.adapter.get(taskId);
    if (!raw) return null;

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new CheckpointCorruptedError(`Failed to parse checkpoint JSON for task ${taskId}`);
    }

    // Check integrity of the fields
    if (!record || typeof record !== "object") {
      throw new CheckpointCorruptedError(`Malformed checkpoint record for task ${taskId}`);
    }

    const { checksum, taskId: rTaskId, payloadHash, ...stateFields } = record;

    // Verify record checksum
    const computedChecksum = stableHash({ taskId: rTaskId, ...stateFields, payloadHash });
    if (computedChecksum !== checksum) {
      throw new CheckpointCorruptedError(`Data integrity check failed for task ${taskId} checkpoint`);
    }

    // Verify payloadHash (re-compute core payload hash)
    const { step, progress, data, artifactRefs, evidenceRefs } = stateFields;
    const computedPayloadHash = stableHash({ step, progress, data, artifactRefs, evidenceRefs });
    if (computedPayloadHash !== payloadHash) {
      throw new CheckpointCorruptedError(`Payload integrity check failed for task ${taskId} checkpoint`);
    }

    return deepFreeze(record);
  }

  /**
   * Resumes execution state by returning the last written checkpoint for the task,
   * or null if no checkpoint exists.
   */
  async resume(taskId) {
    return this.read(taskId);
  }
}
