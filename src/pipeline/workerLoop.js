/**
 * ST Production House — Durable production worker loop.
 *
 * Claims `episode_production` jobs through the jobs repository lease mechanism
 * (time-bounded, reclaimable) and runs the deterministic pipeline. Bounded
 * concurrency, opt-in via STPH_ENABLE_WORKERS=1; previews/tests never spawn it.
 *
 * Contract (AGENTS.md Rules 5, 13; CONVENTIONS 5–6):
 * - A crashed stage leaves the job failed or the lease expired (reclaimable).
 * - The loop never fabricates success; failures are logged with codes only.
 * - Real media (Issue #187): when an `executorRunnerFactory` is supplied
 *   (STPH_ENABLE_REAL_MEDIA=1 in production), each claimed job runs through
 *   the REAL executors via a per-Director runner binding; otherwise the
 *   historical deterministic pipeline runs unchanged. Wait outcomes re-queue
 *   the job (durable WAITING_FOR_QUOTA semantics, attempts enforced).
 * - Per-Director duration (sql/029): when a `directorScheduleProvider` is
 *   supplied, the Director's OWN persisted schedule is resolved for the
 *   claimed job and handed to the pipeline, so the render target and QC window
 *   use the configured episode duration. A provider error is logged with a
 *   stable code and the job continues with the job-payload/default duration —
 *   never a fabricated configuration.
 * - Local motion (Issue #241): `motionEnabled` (STPH_ENABLE_LOCAL_MOTION=1 in
 *   production) inserts the local FFmpeg motion stage between visual and
 *   assembly. Default OFF keeps the pre-existing stage order exactly.
 */

import { runEpisodePipeline } from "./episodePipeline.js";

const DEFAULT_LEASE_SECONDS = Number.parseInt(process.env.STPH_WORKER_LEASE_SECONDS || "120", 10);
const DEFAULT_POLL_MS = Number.parseInt(process.env.STPH_WORKER_POLL_MS || "5000", 10);
const DEFAULT_CONCURRENCY = Number.parseInt(process.env.STPH_WORKER_CONCURRENCY || "1", 10);

export class ProductionWorkerLoop {
  constructor({
    jobsRepository,
    productionRepository,
    evidenceLedger = null,
    enabledAgentsProvider = null,
    executorRunnerFactory = null,
    directorScheduleProvider = null,
    motionEnabled = false,
    log = () => {},
    pollMs = DEFAULT_POLL_MS,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    concurrency = DEFAULT_CONCURRENCY,
  }) {
    if (!jobsRepository || !productionRepository) {
      throw new Error("WORKER_REPOSITORIES_REQUIRED");
    }
    this.jobs = jobsRepository;
    this.production = productionRepository;
    this.evidenceLedger = evidenceLedger;
    this.enabledAgentsProvider = enabledAgentsProvider;
    if (executorRunnerFactory !== null && typeof executorRunnerFactory !== "function") {
      throw new Error("WORKER_EXECUTOR_RUNNER_FACTORY_INVALID");
    }
    this.executorRunnerFactory = executorRunnerFactory;
    if (directorScheduleProvider !== null && typeof directorScheduleProvider !== "function") {
      throw new Error("WORKER_DIRECTOR_SCHEDULE_PROVIDER_INVALID");
    }
    this.directorScheduleProvider = directorScheduleProvider;
    if (typeof motionEnabled !== "boolean") {
      throw new Error("WORKER_MOTION_FLAG_INVALID");
    }
    this.motionEnabled = motionEnabled;
    this.log = log;
    this.pollMs = Math.max(500, pollMs);
    this.leaseSeconds = Math.min(900, Math.max(15, leaseSeconds));
    this.concurrency = Math.min(8, Math.max(1, concurrency));
    this.stopped = true;
    this.timer = null;
    this.inFlight = 0;
    this.workerId = `worker-${process.pid}-${Date.now().toString(36)}`;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = this.#unref(setTimeout(() => this.#tick(), 0));
    this.log(JSON.stringify({ code: "PRODUCTION_WORKER_STARTED", workerId: this.workerId, pollMs: this.pollMs }));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.log(JSON.stringify({ code: "PRODUCTION_WORKER_STOPPED", workerId: this.workerId }));
  }

  async #tick() {
    if (this.stopped) return;
    try {
      while (this.inFlight < this.concurrency) {
        const job = await this.claimNext();
        if (!job) break;
        this.inFlight += 1;
        this.process(job)
          .catch((error) =>
            this.log(JSON.stringify({ code: "WORKER_PROCESS_ERROR", jobId: job.id, errorName: error?.name ?? "Error" }))
          )
          .finally(() => {
            this.inFlight -= 1;
          });
      }
    } catch (error) {
      this.log(JSON.stringify({ code: "WORKER_TICK_ERROR", errorName: error?.name ?? "Error" }));
    }
    if (!this.stopped) {
      // Unref: an idle polling loop must not keep the Node event loop alive on
      // its own. A real deployment stays up through its HTTP server; a test
      // process that finished its work can now exit honestly at EOF.
      this.timer = this.#unref(setTimeout(() => this.#tick(), this.pollMs));
    }
  }

  /** Marks a timer handle non-keeping (no-op for injected test fakes). */
  #unref(handle) {
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }

  /** Claims one queued episode_production job via the jobs lease mechanism. */
  async claimNext() {
    let agents = [];
    if (typeof this.enabledAgentsProvider === "function") {
      agents = (await this.enabledAgentsProvider()) ?? [];
    }
    const leaseExpiresAt = new Date(Date.now() + this.leaseSeconds * 1000).toISOString();
    for (const agent of agents) {
      const job = await this.jobs.claimLease(agent.id, "episode_production", this.workerId, leaseExpiresAt);
      if (job) return job;
    }
    return null;
  }

  async process(job) {
    try {
      const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload ?? {};
      const ownerId = job.owner_id ?? job.ownerId ?? null;
      const releaseId = payload?.releaseId ?? null;
      if (!ownerId || !releaseId) {
        await this.jobs.updateStatus(job.id, "failed");
        this.log(JSON.stringify({ code: "WORKER_JOB_UNROUTABLE", jobId: job.id }));
        return;
      }
      // Real media (Issue #187): bind the per-Director production runner
      // when a factory is configured; without one the deterministic
      // pipeline runs (pre-existing behavior, unchanged).
      const agentId = job.agent_id ?? job.agentId ?? null;
      // The factory may be async (it resolves the per-Director governed
      // provider-capacity source at binding time); awaiting covers both
      // sync and async factories unchanged.
      const executorRunner = typeof this.executorRunnerFactory === "function"
        ? await this.executorRunnerFactory({ job, agentId })
        : null;
      // The Director's own persisted schedule (sql/029): resolved per job so
      // the configured episode duration reaches planning, the render target
      // and the QC window. Lookup failure is logged honestly and the run
      // falls back to the duration stamped on the job / the default.
      let directorSchedule = null;
      if (typeof this.directorScheduleProvider === "function" && agentId) {
        try {
          directorSchedule = await this.directorScheduleProvider({ ownerId, agentId });
        } catch {
          this.log(JSON.stringify({ code: "WORKER_DIRECTOR_SCHEDULE_LOOKUP_FAILED", jobId: job.id, agentId }));
        }
      }
      const result = await runEpisodePipeline({
        ownerId,
        releaseId,
        production: this.production,
        jobs: this.jobs,
        evidenceLedger: this.evidenceLedger,
        executorRunner,
        directorSchedule,
        motionEnabled: this.motionEnabled,
        log: this.log,
      });
      if (result?.waited === true) {
        // Durable wait (WAITING_FOR_QUOTA): re-queue for scheduler resume
        // when capacity returns — bounded by the job's retry budget so a
        // persistently unavailable provider cannot loop forever.
        const attempts = Number(job.attempts ?? 0);
        const maxAttempts = Number(job.max_attempts ?? job.maxAttempts ?? 3);
        try {
          if (attempts < maxAttempts) {
            await this.jobs.updateStatus(job.id, "queued");
          } else {
            await this.jobs.updateStatus(job.id, "failed");
            this.log(JSON.stringify({ code: "WORKER_JOB_WAIT_BUDGET_EXHAUSTED", jobId: job.id, releaseId, waitingCode: result.waitingCode ?? null }));
            return;
          }
        } catch {
          // Status already governs itself; the release stays `planned` and
          // evidence carries the wait — never a fabricated success.
        }
        this.log(JSON.stringify({ code: "WORKER_JOB_WAITING", jobId: job.id, releaseId, waitingCode: result.waitingCode ?? null }));
        return;
      }
      this.log(JSON.stringify({ code: "WORKER_JOB_SUCCEEDED", jobId: job.id, releaseId }));
    } catch (error) {
      try {
        await this.jobs.updateStatus(job.id, "failed");
      } catch {
        // Leave for lease-expiry reclaim if the job row is unreachable.
      }
      this.log(JSON.stringify({ code: "WORKER_JOB_FAILED", jobId: job.id, errorName: error?.name ?? "Error" }));
    }
  }
}

export default ProductionWorkerLoop;
