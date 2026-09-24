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
    this.timer = setTimeout(() => this.#tick(), 0);
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
      this.timer = setTimeout(() => this.#tick(), this.pollMs);
    }
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
      await runEpisodePipeline({
        ownerId,
        releaseId,
        production: this.production,
        jobs: this.jobs,
        evidenceLedger: this.evidenceLedger,
        log: this.log,
      });
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
