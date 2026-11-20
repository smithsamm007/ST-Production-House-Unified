/**
 * ST Production House — durable Director worker runtime (Day 6).
 *
 * A worker is an execution process, not a Director. This runtime:
 *   1. registers with FORGE and heartbeats on the database clock,
 *   2. discovers eligible work within its stage/capability/Director scope,
 *   3. claims atomically through the fenced Day 5 claim,
 *   4. validates the handler declaration, director state and upstream evidence,
 *   5. executes a real stage handler (or reports an honest blocked state),
 *   6. persists checkpoints, validates the output against the evidence contract,
 *   7. completes or fails with the fencing token it was given,
 *   8. drains gracefully on shutdown, losing no lease and inventing no result.
 *
 * The runtime never updates a task's state directly: every transition goes
 * through `PostgresDirectorWorkerRepository` → `PostgresDirectorFleetRepository`,
 * which enforces the lease and fencing token. A lost lease stops the run before
 * any result can be committed.
 */

import { randomUUID } from "node:crypto";

import { FleetError } from "../fleet/fleetPolicy.js";
import { WORKER_STATE } from "../fleet/workerRepository.js";
import {
  FAILURE_CLASS,
  STAGE_ERROR,
  StageError,
  VERIFICATION_LEVEL,
  classifyFailure,
  validateStageOutput,
} from "./evidenceContract.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOST_LEASE_CODES = new Set([
  "TASK_FENCING_TOKEN_STALE",
  "TASK_LEASE_NOT_ACTIVE",
  "LEASE_LOST",
]);

export class DirectorWorkerRuntime {
  constructor({
    repository,
    fleet = repository?.fleet ?? null,
    registry,
    workerKey,
    instanceId = `runtime-${process.pid}-${randomUUID().slice(0, 8)}`,
    workerType = "production_worker",
    stageTypes = [],
    capabilities = [],
    directorScope = [],
    leaseSeconds = 60,
    heartbeatSeconds = 20,
    pollIntervalMs = 500,
    concurrency = 1,
    maxPerDirector = 1,
    environment = "PRODUCTION",
    testFixture = false,
    artifactsRoot = null,
    actor = { id: "forge-worker", role: "FORGE" },
    logger = console,
    executionTimeoutMs = 120_000,
  } = {}) {
    if (!repository) throw new Error("DIRECTOR_WORKER_REPOSITORY_REQUIRED");
    if (!registry) throw new Error("STAGE_HANDLER_REGISTRY_REQUIRED");
    if (typeof workerKey !== "string" || workerKey.length === 0) throw new Error("WORKER_KEY_REQUIRED");
    if (!fleet) throw new Error("DIRECTOR_FLEET_REPOSITORY_REQUIRED");

    this.repository = repository;
    this.fleet = fleet;
    this.registry = registry;
    this.workerKey = workerKey;
    this.instanceId = instanceId;
    this.workerType = workerType;
    this.stageTypes = [...stageTypes];
    this.capabilities = [...capabilities];
    this.directorScope = [...directorScope];
    this.leaseSeconds = Math.max(5, Number(leaseSeconds) || 60);
    this.heartbeatSeconds = Math.max(1, Number(heartbeatSeconds) || 20);
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 500);
    this.concurrency = Math.max(1, Math.min(10, Number(concurrency) || 1));
    this.maxPerDirector = Math.max(1, Number(maxPerDirector) || 1);
    this.environment = environment;
    this.testFixture = environment === "TEST" && testFixture === true;
    this.artifactsRoot = artifactsRoot;
    this.actor = actor;
    this.logger = logger;
    this.executionTimeoutMs = Math.max(1000, Number(executionTimeoutMs) || 120_000);

    this.running = false;
    this.startedAt = null;
    this.lastHeartbeatAt = 0;
    this.inFlight = new Map();
    this.counters = { claimed: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, leaseLost: 0, checkpoints: 0, ticks: 0 };
    this.lastError = null;
  }

  #log(level, code, extra = {}) {
    try {
      this.logger?.[level]?.(JSON.stringify({ level, code, workerKey: this.workerKey, ...extra }));
    } catch {
      // Logging must never break execution.
    }
  }

  /** Registration is durable; a live key owned by another instance is refused. */
  async register() {
    const registration = await this.repository.registerWorker({
      workerKey: this.workerKey,
      workerType: this.workerType,
      instanceId: this.instanceId,
      role: "production",
      stageTypes: this.stageTypes,
      capabilities: this.capabilities,
      directorScope: this.directorScope,
      configVersion: 1,
      metadata: {
        environment: this.environment,
        concurrency: this.concurrency,
        leaseSeconds: this.leaseSeconds,
        handlerVersions: this.registry.list().map((entry) => `${entry.stage}:${entry.handlerVersion}`),
      },
      actor: this.actor,
    });
    await this.repository.setState({
      workerKey: this.workerKey,
      state: WORKER_STATE.STARTING,
      reason: "Runtime starting",
      actor: this.actor,
    });
    this.#log("log", "DIRECTOR_WORKER_REGISTERED", {
      instanceId: this.instanceId,
      duplicate: registration.duplicate,
      stageTypes: this.stageTypes,
    });
    return registration;
  }

  async heartbeatNow({ state = null } = {}) {
    const beat = await this.repository.heartbeat({ workerKey: this.workerKey, instanceId: this.instanceId, state });
    this.lastHeartbeatAt = Date.now();
    return beat;
  }

  /**
   * Run until stopped. Claims are bounded by `concurrency`; the loop never spins
   * on an empty queue and never retries a provider block in a tight loop.
   */
  async start({ signal = null } = {}) {
    if (this.running) return { alreadyRunning: true };
    this.running = true;
    this.startedAt = new Date();
    await this.register();
    await this.heartbeatNow({ state: WORKER_STATE.IDLE });

    const onAbort = () => {
      void this.stop({ reason: "Process signal" });
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    while (this.running) {
      try {
        await this.tickOnce();
      } catch (error) {
        this.lastError = String(error?.code ?? error?.message ?? "WORKER_LOOP_ERROR");
        this.#log("warn", "DIRECTOR_WORKER_LOOP_ERROR", { error: this.lastError.slice(0, 160) });
        // Backoff after an infrastructure error instead of spinning.
        await sleep(Math.min(this.pollIntervalMs * 4, 10_000));
        continue;
      }
      if (this.inFlight.size >= this.concurrency) {
        await Promise.race([...this.inFlight.values()].map((entry) => entry.done).concat(sleep(this.pollIntervalMs)));
        continue;
      }
      if (this.running) await sleep(this.pollIntervalMs);
    }

    await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.done));
    return { stopped: true, counters: { ...this.counters } };
  }

  /**
   * One bounded iteration: heartbeat, expire nothing, claim up to the remaining
   * concurrency and execute. Public so tests can drive the loop deterministically.
   */
  async tickOnce() {
    this.counters.ticks += 1;
    if (Date.now() - this.lastHeartbeatAt >= this.heartbeatSeconds * 1000) {
      const beat = await this.heartbeatNow();
      if (beat?.restartRequested === true) {
        this.#log("log", "DIRECTOR_WORKER_RESTART_REQUESTED");
        await this.stop({ reason: "Owner restart request" });
        return { claimed: 0 };
      }
    }

    const worker = await this.repository.getWorker(this.workerKey);
    if (!worker) throw new Error("WORKER_NOT_REGISTERED");
    if ([WORKER_STATE.DRAINING, WORKER_STATE.OFFLINE, WORKER_STATE.STOPPED].includes(worker.state)) {
      return { claimed: 0, workerState: worker.state };
    }

    const free = this.concurrency - this.inFlight.size;
    let claimed = 0;
    for (let index = 0; index < free; index += 1) {
      const claim = await this.repository.claimTask({
        workerKey: this.workerKey,
        leaseSeconds: this.leaseSeconds,
        directorId: this.directorScope.length === 1 ? this.directorScope[0] : null,
        maxPerDirector: this.maxPerDirector,
      });
      if (!claim || claim.claimed !== true) break;
      claimed += 1;
      this.counters.claimed += 1;
      const entry = { claim, controller: new AbortController() };
      entry.done = this.executeClaim(claim, entry.controller.signal)
        .catch((error) => {
          this.lastError = String(error?.code ?? error?.message ?? "WORKER_EXECUTION_ERROR");
          this.#log("warn", "DIRECTOR_WORKER_EXECUTION_ERROR", { error: this.lastError.slice(0, 160) });
        })
        .finally(() => {
          this.inFlight.delete(claim.task.taskId);
        });
      this.inFlight.set(claim.task.taskId, entry);
    }
    return { claimed };
  }

  /**
   * Execute one claimed task. Every path either completes with validated evidence
   * or reports an honest failure/block; a lost lease commits nothing.
   */
  async executeClaim(claim, signal = null) {
    const { task, fencingToken } = claim;
    const directorId = task.directorId;
    const taskId = task.taskId;
    let renewal = null;
    let leaseLost = false;

    const direction = new AbortController();
    const abort = () => direction.abort();
    if (signal) signal.addEventListener("abort", abort, { once: true });

    const startRenewal = () => {
      const interval = Math.max(500, Math.floor((this.leaseSeconds * 1000) / 3));
      renewal = setInterval(async () => {
        try {
          await this.repository.renewLease({
            workerKey: this.workerKey,
            taskId,
            fencingToken,
            leaseSeconds: this.leaseSeconds,
          });
        } catch (error) {
          if (LOST_LEASE_CODES.has(error?.code)) {
            leaseLost = true;
            direction.abort();
            this.counters.leaseLost += 1;
            this.#log("warn", "DIRECTOR_WORKER_LEASE_LOST", { taskId });
          }
        }
      }, interval);
      renewal.unref?.();
    };

    try {
      startRenewal();

      const current = await this.fleet.getTask({ directorId, taskId });
      if (!current || current.cancelRequested === true) {
        await this.fleet.finalizeCancellation({ directorId, taskId, reason: "Cancelled before execution" });
        await this.repository.releaseLease({
          taskId,
          workerKey: this.workerKey,
          fencingToken,
          reason: "cancelled",
        });
        this.counters.cancelled += 1;
        return { outcome: "CANCELLED", taskId };
      }

      if (this.directorScope.length > 0 && !this.directorScope.includes(directorId)) {
        await this.repository.failTask({
          directorId,
          taskId,
          workerKey: this.workerKey,
          fencingToken,
          error: "WORKER_SCOPE_DENIED",
          retryable: false,
        });
        this.counters.failed += 1;
        return { outcome: "SCOPE_DENIED", taskId };
      }

      let descriptor;
      try {
        descriptor = this.registry.describe(task.stage);
        this.registry.assertRunnable(task.stage);
      } catch (error) {
        // Unsupported or provider-blocked stage: an honest blocked state, never a
        // placeholder result and never an attempt-consuming retry loop.
        const result = await this.repository.failTask({
          directorId,
          taskId,
          workerKey: this.workerKey,
          fencingToken,
          error: error?.code ?? STAGE_ERROR.UNSUPPORTED_STAGE,
          retryable: false,
        });
        if (result.blocked) this.counters.blocked += 1;
        else this.counters.failed += 1;
        this.#log("log", "DIRECTOR_WORKER_STAGE_UNAVAILABLE", { taskId, stage: task.stage, code: error?.code });
        return { outcome: result.blocked ? "BLOCKED" : "FAILED", taskId, code: error?.code };
      }

      const upstreamEvidence = await this.fleet.listProjectEvidence({ directorId, projectId: task.projectId });
      const checkpoint = await this.repository.latestCheckpoint(taskId);

      // A durable marker that the handler began: a claimed task is not a start.
      await this.repository.recordExecutionStarted({
        workerKey: this.workerKey,
        taskId,
        stage: task.stage,
        fencingToken,
      });

      const startedAt = new Date();
      const result = this.registry.execute({
        stage: task.stage,
        task: { ...task, input: task.input ?? {} },
        input: current.input ?? {},
        upstreamEvidence,
        resumeFrom: checkpoint ? { key: checkpoint.key, payload: checkpoint.payload } : null,
        environment: this.environment,
        testFixture: this.testFixture,
      });
      const completedAt = new Date();
      const elapsedMs = completedAt.getTime() - startedAt.getTime();

      if (elapsedMs > this.executionTimeoutMs) {
        throw new StageError(STAGE_ERROR.STAGE_TIMEOUT, `Stage exceeded ${this.executionTimeoutMs}ms.`);
      }
      if (leaseLost || direction.signal.aborted) {
        this.#log("warn", "DIRECTOR_WORKER_LEASE_LOST_NO_COMMIT", { taskId });
        return { outcome: "LEASE_LOST", taskId };
      }

      const validation = validateStageOutput({
        resultRef: result.resultRef,
        evidence: result.evidence,
        requiredHash: descriptor.hashRequired === true,
      });
      if (!validation.ok) {
        await this.repository.failTask({
          directorId,
          taskId,
          workerKey: this.workerKey,
          fencingToken,
          error: `${STAGE_ERROR.STAGE_OUTPUT_INVALID}: ${validation.errors.join("; ").slice(0, 180)}`,
          retryable: false,
        });
        this.counters.failed += 1;
        return { outcome: "OUTPUT_INVALID", taskId, errors: validation.errors };
      }

      for (const entry of result.checkpoints) {
        try {
          const written = await this.repository.writeCheckpoint({
            taskId,
            workerKey: this.workerKey,
            fencingToken,
            key: entry.key,
            payload: entry.payload ?? {},
          });
          if (written.created) this.counters.checkpoints += 1;
        } catch (error) {
          if (LOST_LEASE_CODES.has(error?.code)) {
            this.counters.leaseLost += 1;
            return { outcome: "LEASE_LOST", taskId };
          }
          throw error;
        }
      }

      // Final cancellation check: the fence and the cancel flag are both re-read
      // inside the completing transaction.
      const completed = await this.repository.completeTask({
        directorId,
        taskId,
        workerKey: this.workerKey,
        fencingToken,
        resultRef: result.resultRef,
        evidence: result.evidence.map((entry) => ({
          ...entry,
          handlerName: entry.handlerName ?? result.handlerName,
          handlerVersion: entry.handlerVersion ?? result.handlerVersion,
          verificationLevel: entry.verificationLevel ?? result.verificationLevel,
          environment: entry.environment ?? this.environment,
          testFixture: entry.testFixture === true,
          workerKey: this.workerKey,
          fencingToken,
          startedAt: entry.startedAt ?? result.startedAt,
          completedAt: entry.completedAt ?? result.completedAt,
        })),
        allowTestFixtures: this.testFixture,
      });
      this.counters.completed += 1;
      this.#log("log", "DIRECTOR_WORKER_TASK_COMPLETED", {
        taskId,
        stage: task.stage,
        directorId,
        handler: result.handlerName,
        handlerVersion: result.handlerVersion,
        verificationLevel: result.verificationLevel,
        elapsedMs,
      });
      return { outcome: "COMPLETED", taskId, task: completed };
    } catch (error) {
      const code = error?.code ?? "STAGE_EXECUTION_FAILED";

      if (LOST_LEASE_CODES.has(code)) {
        // A stale token must never commit anything; the existing recovery path
        // requeues the task for a healthy worker.
        this.counters.leaseLost += 1;
        this.#log("warn", "DIRECTOR_WORKER_STALE_FENCE_REJECTED", { taskId, code });
        return { outcome: "LEASE_LOST", taskId, code };
      }
      if (code === "TASK_NOT_CANCELLABLE") {
        this.counters.cancelled += 1;
        return { outcome: "CANCELLED", taskId };
      }
      if (code === "TASK_EVIDENCE_INVALID" || code === "TASK_EVIDENCE_HASH_INVALID") {
        this.counters.failed += 1;
        return { outcome: "EVIDENCE_REJECTED", taskId, code };
      }

      const classification = classifyFailure(code, {
        retryable: error instanceof StageError ? false : undefined,
      });
      try {
        const failed = await this.repository.failTask({
          directorId,
          taskId,
          workerKey: this.workerKey,
          fencingToken,
          error: code,
          retryable: classification.retryable,
        });
        if (failed.blocked) this.counters.blocked += 1;
        else this.counters.failed += 1;
        this.#log("warn", "DIRECTOR_WORKER_TASK_FAILED", {
          taskId,
          code,
          failureClass: classification.failureClass,
          status: failed.task?.status ?? null,
        });
        return { outcome: failed.blocked ? "BLOCKED" : "FAILED", taskId, code, classification };
      } catch (failureError) {
        this.lastError = String(failureError?.code ?? failureError?.message ?? code);
        this.#log("warn", "DIRECTOR_WORKER_FAILURE_REPORT_REJECTED", { taskId, code: this.lastError });
        return { outcome: "FAILURE_NOT_RECORDED", taskId, code: this.lastError };
      }
    } finally {
      if (renewal) clearInterval(renewal);
      if (signal) signal.removeEventListener("abort", abort);
      // Clear the worker's current-task pointer only when the lease was released
      // through a completing path; a lost lease is cleaned by recovery.
      try {
        const worker = await this.repository.getWorker(this.workerKey);
        if (worker && worker.currentTaskId === taskId && !leaseLost) {
          await this.repository.heartbeat({
            workerKey: this.workerKey,
            instanceId: this.instanceId,
            state: worker.state === WORKER_STATE.BUSY ? WORKER_STATE.IDLE : worker.state,
          });
        }
      } catch {
        // Best effort; the durable state is already recorded.
      }
    }
  }

  /**
   * Graceful shutdown: stop claiming, let in-flight work finish (bounded), then
   * release anything still leased so a restarted process can reclaim it.
   */
  async stop({ reason = "Graceful shutdown", timeoutMs = 15_000 } = {}) {
    if (!this.running && this.inFlight.size === 0) return { stopped: true, counters: { ...this.counters } };
    this.running = false;
    try {
      await this.repository.setState({
        workerKey: this.workerKey,
        state: WORKER_STATE.DRAINING,
        reason,
        actor: this.actor,
      });
    } catch {
      // Registration may be gone; shutdown still proceeds.
    }

    const pending = [...this.inFlight.values()].map((entry) => entry.done);
    if (pending.length > 0) {
      await Promise.race([Promise.allSettled(pending), sleep(timeoutMs)]);
    }

    for (const [taskId, entry] of this.inFlight.entries()) {
      try {
        await this.repository.releaseLease({
          taskId,
          workerKey: this.workerKey,
          fencingToken: entry.claim.fencingToken,
          reason: "restart",
        });
        entry.controller.abort();
      } catch {
        // The lease may already be released.
      }
    }

    try {
      await this.repository.setState({
        workerKey: this.workerKey,
        state: WORKER_STATE.STOPPED,
        reason,
        actor: this.actor,
      });
    } catch {
      // Already stopped.
    }
    this.#log("log", "DIRECTOR_WORKER_STOPPED", { reason, counters: this.counters });
    return { stopped: true, counters: { ...this.counters } };
  }

  /** Prefer this over process-level signal handlers in library use. */
  installSignalHandlers(target = process) {
    const handler = () => {
      void this.stop({ reason: "Process signal" }).finally(() => {
        target.exitCode = 0;
      });
    };
    target.on?.("SIGTERM", handler);
    target.on?.("SIGINT", handler);
    return () => {
      target.off?.("SIGTERM", handler);
      target.off?.("SIGINT", handler);
    };
  }

  status() {
    return {
      workerKey: this.workerKey,
      instanceId: this.instanceId,
      running: this.running,
      environment: this.environment,
      testFixture: this.testFixture,
      stageTypes: this.stageTypes,
      capabilities: this.capabilities,
      directorScope: this.directorScope,
      concurrency: this.concurrency,
      inFlight: [...this.inFlight.keys()],
      counters: { ...this.counters },
      lastError: this.lastError,
      verificationLevel: VERIFICATION_LEVEL.IMPLEMENTED,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
    };
  }
}

export function createDirectorWorkerRuntime(options) {
  return new DirectorWorkerRuntime(options);
}

export { FleetError, FAILURE_CLASS };
