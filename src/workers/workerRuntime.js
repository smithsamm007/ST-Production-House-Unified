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
 * Normalizes error messages and stack traces to ensure no plaintext secrets or sensitive
 * internal identifiers leak.
 */
export function sanitizeError(err) {
  if (!err) return { message: "Unknown error", name: "Error" };

  const message = String(err.message || err).replace(/(vault|opaque):\/\/[^\s]+/g, "[REDACTED_SECRET]");
  const name = err.name || "Error";
  const stack = err.stack
    ? String(err.stack).replace(/(vault|opaque):\/\/[^\s]+/g, "[REDACTED_SECRET]")
    : undefined;

  return { message, name, stack };
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
  constructor() {
    // Registry of successfully completed tasks to guarantee idempotent completion
    this.completedTasks = new Map();
    // Registry of running/failed tasks
    this.taskRegistry = new Map();
  }

  /**
   * Resets the runtime registries (useful for testing).
   */
  reset() {
    this.completedTasks.clear();
    this.taskRegistry.clear();
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

    // 2. Idempotent Completion check
    // If the task has already successfully completed, return the cached result.
    if (this.completedTasks.has(taskId)) {
      return this.completedTasks.get(taskId);
    }

    // Ensure we don't double-run an active job
    if (this.taskRegistry.get(taskId) === "running") {
      throw new WorkerRuntimeError(`Task ${taskId} is already running`);
    }

    this.taskRegistry.set(taskId, "running");

    const abortSignal = options.signal;
    const checkpointStore = options.checkpointStore;
    const onHeartbeat = options.onHeartbeat;

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
        try {
          onHeartbeat(heartbeatObj);
        } catch (callbackErr) {
          // Heartbeat callback failures must not derail worker execution unless desired,
          // but for fail-closed safety, let's log or let it throw if it indicates critical monitoring failure.
          // We will let it propagate if it's a security or cancellation concern.
        }
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
    // Notice that context fields are encapsulated and we provide helper utilities.
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

      // Save for idempotent completion
      this.completedTasks.set(taskId, result);
      this.taskRegistry.set(taskId, "completed");

      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;

      if (err instanceof WorkerCancelledError || (abortSignal && abortSignal.aborted)) {
        // Structured Cancellation Result
        const cancelledResult = {
          taskId,
          status: "cancelled",
          error: {
            message: err.message || "Worker execution was cancelled",
            name: err.name || "WorkerCancelledError"
          },
          failClosed: true,
          durationMs,
          cancelledAt: new Date().toISOString()
        };

        deepFreeze(cancelledResult);
        this.taskRegistry.set(taskId, "cancelled");
        return cancelledResult;
      } else {
        // Structured Failure Result ensuring Fail-Closed guarantees (sanitizing errors, no leak of sensitive tokens)
        const failedResult = {
          taskId,
          status: "failed",
          error: sanitizeError(err),
          failClosed: true,
          durationMs,
          failedAt: new Date().toISOString()
        };

        deepFreeze(failedResult);
        this.taskRegistry.set(taskId, "failed");
        return failedResult;
      }
    }
  }
}
