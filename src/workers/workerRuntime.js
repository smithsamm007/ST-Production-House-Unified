import { WorkEnvelope, SecurityViolationError, WorkEnvelopeValidationError } from "./workEnvelope.js";

export class WorkerCancelledError extends Error {
  constructor(message = "Worker execution was cooperatively cancelled") {
    super(message);
    this.name = "WorkerCancelledError";
  }
}

export class WorkerRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerRuntimeError";
  }
}

/**
 * Normalizes error messages and stack traces to ensure no plaintext secrets, bearer tokens,
 * credential URLs, cookies, or other sensitive internal identifiers leak publicly.
 */
export function sanitizeError(err) {
  if (!err) return { message: "Unknown error", name: "Error", stack: "[REDACTED_STACK_TRACE]" };

  let rawMessage = String(err.message || err);

  // 1. Redact Vault / Opaque URI locators
  rawMessage = rawMessage.replace(/(vault|opaque):\/\/[^\s]+/gi, "[REDACTED_SECRET]");

  // 2. Redact Bearer tokens
  rawMessage = rawMessage.replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED_TOKEN]");

  // 3. Redact Credential URLs: protocol://user:pass@host
  rawMessage = rawMessage.replace(/([a-zA-Z0-9+\-\.]+:\/\/)([^:]+):([^@]+)(@)/g, "$1[USER]:[PASSWORD]$4");

  // 4. Redact Cookies
  rawMessage = rawMessage.replace(/(Cookie:\s*|session=)[a-zA-Z0-9_\-\.=%]+/gi, "$1[REDACTED_COOKIE]");

  // 5. Redact secret-like key-value pairs (e.g. apikey=123, password: abc)
  rawMessage = rawMessage.replace(/(password|secret|token|apikey|privatekey|cookie)([:=]\s*)([a-zA-Z0-9_\-\.]+)/gi, "$1$2[REDACTED_VALUE]");

  const name = err.name || "Error";

  // DO NOT return raw stacks publicly.
  const stack = "[REDACTED_STACK_TRACE]";

  return { message: rawMessage, name, stack };
}

/**
 * Deep freezes an object recursively to ensure strict immutability.
 */
function deepFreeze(obj) {
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

export class WorkerRuntime {
  /**
   * Constructs the WorkerRuntime.
   * Requires a durable state/idempotency store. In-memory runtime maps cannot be the production authority.
   */
  constructor(options = {}) {
    const { idempotencyStore, isTestEnv = false } = options;

    if (!isTestEnv && !idempotencyStore) {
      throw new Error("WorkerRuntime requires a durable state/idempotency store. In-memory runtime maps are prohibited in production.");
    }

    if (idempotencyStore) {
      // Validate adapter interface
      if (typeof idempotencyStore.get !== "function" || typeof idempotencyStore.set !== "function") {
        throw new Error("Invalid idempotency store interface. Must implement 'get' and 'set' methods.");
      }

      const isExplicitTestStore =
        idempotencyStore.name === "TestIdempotencyStore" ||
        idempotencyStore.constructor?.name === "TestIdempotencyStore";

      if (!isTestEnv && !isExplicitTestStore && idempotencyStore.isInMemory === true) {
        throw new Error("Silent in-memory idempotency fallbacks are prohibited in production CheckpointStore/WorkerRuntime.");
      }
    }

    // Default to an explicitly named test in-memory store in tests if not provided
    this.idempotencyStore = idempotencyStore || {
      name: "TestIdempotencyStore",
      store: new Map(),
      async get(key) {
        return this.store.get(key) || null;
      },
      async set(key, val) {
        this.store.set(key, val);
      }
    };

    // Tracking active tasks in the current process
    this.activeTasks = new Set();
  }

  /**
   * Resets active tasks tracking (useful for testing).
   */
  reset() {
    this.activeTasks.clear();
  }

  /**
   * Safe execution harness for running task handlers with a WorkEnvelope.
   * Ensures cooperative cancellation, heartbeats, checkpointing, and fail-closed results.
   */
  async run(envelopeInput, handler, options = {}) {
    const startTime = Date.now();

    // 1. Parse and validate the WorkEnvelope
    let envelope;
    try {
      if (envelopeInput instanceof WorkEnvelope) {
        envelope = envelopeInput;
      } else {
        envelope = new WorkEnvelope(envelopeInput);
      }
    } catch (err) {
      // Input validation failure is an immediate fail-closed outcome
      const durationMs = Date.now() - startTime;
      return deepFreeze({
        taskId: envelopeInput?.taskId || "unknown",
        status: "failed",
        error: sanitizeError(err),
        failClosed: true,
        durationMs,
        failedAt: new Date().toISOString()
      });
    }

    const { taskId } = envelope;

    // Validate handler interface
    if (typeof handler !== "function") {
      const durationMs = Date.now() - startTime;
      return deepFreeze({
        taskId,
        status: "failed",
        error: sanitizeError(new Error("WorkerRuntime run requires a valid handler function.")),
        failClosed: true,
        durationMs,
        failedAt: new Date().toISOString()
      });
    }

    // 2. Idempotent Completion check
    // Query durable idempotencyStore
    try {
      const cachedResult = await this.idempotencyStore.get(taskId);
      if (cachedResult) {
        return typeof cachedResult === "string" ? JSON.parse(cachedResult) : cachedResult;
      }
    } catch (dbErr) {
      // If durable state fetch fails, fail-closed honest representation
      const durationMs = Date.now() - startTime;
      return deepFreeze({
        taskId,
        status: "failed",
        error: sanitizeError(new Error(`Failed to query durable state store: ${dbErr.message}`)),
        failClosed: true,
        durationMs,
        failedAt: new Date().toISOString()
      });
    }

    // Ensure we don't double-run an active job in same runtime context
    if (this.activeTasks.has(taskId)) {
      throw new WorkerRuntimeError(`Task ${taskId} is already running`);
    }

    this.activeTasks.add(taskId);

    const abortSignal = options.signal;
    const checkpointStore = options.checkpointStore;
    const onHeartbeat = options.onHeartbeat;

    // Validate checkpointStore if provided
    if (checkpointStore && (typeof checkpointStore.write !== "function" || typeof checkpointStore.read !== "function")) {
      this.activeTasks.delete(taskId);
      const durationMs = Date.now() - startTime;
      return deepFreeze({
        taskId,
        status: "failed",
        error: sanitizeError(new Error("Invalid CheckpointStore passed to WorkerRuntime")),
        failClosed: true,
        durationMs,
        failedAt: new Date().toISOString()
      });
    }

    // Local mutable state for artifacts and evidence accumulated during execution
    let accumulatedArtifactRefs = [];
    let accumulatedEvidenceRefs = [];

    // Cooperative cancellation checkers
    const isCanceled = () => {
      return !!(abortSignal && abortSignal.aborted);
    };

    const checkCancellation = () => {
      if (isCanceled()) {
        throw new WorkerCancelledError();
      }
    };

    // Heartbeat reporting function
    const heartbeat = (step, progress, metrics = {}) => {
      checkCancellation();

      const heartbeatObj = {
        taskId,
        step,
        progress,
        metrics,
        timestamp: new Date().toISOString()
      };

      if (onHeartbeat && typeof onHeartbeat === "function") {
        // DO NOT swallow heartbeat callback failures. Let them propagate to derail/fail-closed the execution.
        onHeartbeat(heartbeatObj);
      }

      return heartbeatObj;
    };

    // Checkpoint helper function exposed to the handler
    const checkpoint = async (step, progress, data = {}, extraArtifacts = [], extraEvidence = []) => {
      checkCancellation();

      // Accumulate references
      if (Array.isArray(extraArtifacts)) {
        accumulatedArtifactRefs.push(...extraArtifacts);
      }
      if (Array.isArray(extraEvidence)) {
        accumulatedEvidenceRefs.push(...extraEvidence);
      }

      // De-duplicate accumulated references
      const uniqueArtifacts = [];
      const seenPaths = new Set();
      for (const art of accumulatedArtifactRefs) {
        if (art && art.path && !seenPaths.has(art.path)) {
          seenPaths.add(art.path);
          uniqueArtifacts.push(art);
        }
      }
      accumulatedArtifactRefs = uniqueArtifacts;

      const uniqueEvidence = Array.from(new Set(accumulatedEvidenceRefs));
      accumulatedEvidenceRefs = uniqueEvidence;

      if (checkpointStore) {
        // DO NOT swallow checkpoint persistence failures.
        await checkpointStore.write(taskId, {
          step,
          progress,
          data,
          artifactRefs: accumulatedArtifactRefs,
          evidenceRefs: accumulatedEvidenceRefs
        });
      }
    };

    // Construct the context to provide to the handler.
    const handlerContext = {
      taskId,
      jobType: envelope.jobType,
      agentId: envelope.agentId,
      payload: envelope.payload,
      context: envelope.context,
      signal: abortSignal,
      isCanceled,
      checkCancellation,
      heartbeat,
      checkpoint,
      // Helper to add artifacts directly
      addArtifact: (art) => {
        if (art && art.path && art.sha256) {
          accumulatedArtifactRefs.push(art);
        }
      },
      // Helper to add evidence references
      addEvidence: (evId) => {
        if (evId) {
          accumulatedEvidenceRefs.push(evId);
        }
      }
    };

    try {
      // Check cancellation before invoking the handler
      checkCancellation();

      // Execute the user-provided handler
      const output = await handler(handlerContext);

      // Final cancellation check before committing success
      checkCancellation();

      const durationMs = Date.now() - startTime;

      // Unique-ify artifacts and evidence on completion
      const uniqueArtifacts = [];
      const seenPaths = new Set();
      for (const art of accumulatedArtifactRefs) {
        if (art && art.path && !seenPaths.has(art.path)) {
          seenPaths.add(art.path);
          uniqueArtifacts.push(art);
        }
      }
      const uniqueEvidence = Array.from(new Set(accumulatedEvidenceRefs));

      // Construct a structured successful HandlerResult
      const result = {
        taskId,
        status: "success",
        output: output || null,
        artifactRefs: uniqueArtifacts,
        evidenceRefs: uniqueEvidence,
        durationMs,
        completedAt: new Date().toISOString()
      };

      deepFreeze(result);

      // Save to durable idempotencyStore
      await this.idempotencyStore.set(taskId, JSON.stringify(result));
      this.activeTasks.delete(taskId);

      return result;
    } catch (err) {
      this.activeTasks.delete(taskId);
      const durationMs = Date.now() - startTime;

      if (err instanceof WorkerCancelledError || (abortSignal && abortSignal.aborted)) {
        // Structured Cancellation Result
        const cancelledResult = {
          taskId,
          status: "cancelled",
          error: {
            message: err.message || "Worker execution was cancelled",
            name: err.name || "WorkerCancelledError",
            stack: "[REDACTED_STACK_TRACE]"
          },
          failClosed: true,
          durationMs,
          cancelledAt: new Date().toISOString()
        };

        deepFreeze(cancelledResult);
        return cancelledResult;
      } else {
        // Structured Failure Result ensuring Fail-Closed guarantees (sanitizing errors, redacting secrets and stack)
        const failedResult = {
          taskId,
          status: "failed",
          error: sanitizeError(err),
          failClosed: true,
          durationMs,
          failedAt: new Date().toISOString()
        };

        deepFreeze(failedResult);
        return failedResult;
      }
    }
  }
}
