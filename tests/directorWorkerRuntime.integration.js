/**
 * Day 6 — durable Director worker runtime acceptance on real PostgreSQL.
 *
 * Disposable database, canonical migrations (sql/001..046), real repositories,
 * real worker runtimes, real mounted routes. Every input document is written by
 * this test into a temporary artifact root and is labelled TEST data; the hashes
 * are computed from its actual bytes. Nothing contacts a provider, spends money,
 * publishes, deploys or migrates a persistent database.
 *
 *   A  worker registration
 *   B  duplicate worker registration handling
 *   C  worker heartbeat persistence
 *   D  worker heartbeat expiry
 *   E  worker capability / stage validation
 *   F  claim of an eligible task
 *   G  rejection of unsupported stages
 *   H  rejection of missing upstream dependencies
 *   I  rejection of missing upstream evidence
 *   J  provider-independent handler execution
 *   K  evidence persistence and hash validation
 *   L  fenced task completion
 *   M  stale fencing token rejection
 *   N  lease renewal
 *   O  lease-loss execution cancellation
 *   P  worker restart recovery
 *   Q  two-worker concurrent claims
 *   R  two-Director concurrent execution
 *   S  Director isolation (DB rows and mounted API)
 *   T  suspended Director receives no work
 *   U  bounded retry with backoff
 *   V  permanent error is terminal immediately
 *   W  provider-unconfigured task stays blocked
 *   X  quota exhaustion does not consume retry attempts
 *   Y  dead-letter behaviour
 *   Z  graceful worker shutdown
 *   AA duplicate evidence/checkpoint prevention
 *   AB real application bootstrap (tests/applicationBoot.integration.js)
 *   AC real mounted route verification
 *   AD Owner authentication and CSRF enforcement
 *   AE daily report reconciliation
 *   AF no secret leakage
 *   AG task cancellation
 *   AH worker draining
 *   AI stale worker cannot complete a task
 *   AJ multiple workers recover safely after restart
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import supertest from "supertest";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";
import { PostgresDirectorFleetRepository, retryDelaySeconds } from "../src/fleet/fleetRepository.js";
import { PostgresDirectorWorkerRepository } from "../src/fleet/workerRepository.js";
import { HermesFleetManager } from "../src/fleet/hermesFleetManager.js";
import { createFleetRouter } from "../src/api/fleetRouter.js";
import { createDirectorWorkerRuntime } from "../src/worker/workerRuntime.js";
import { createStageHandlerRegistry, StageHandlerRegistry } from "../src/worker/stageHandlers.js";
import { STAGE_ERROR } from "../src/worker/evidenceContract.js";
import { collectForgeDailyReport, verifyReportEvidenceHash } from "../src/reporting/dailyReportGenerator.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";
const quiet = { log() {}, warn() {}, error() {} };
const OWNER = { id: "owner-worker-day6", role: "OWNER" };
const sha = (value) => createHash("sha256").update(value).digest("hex");

const SOURCE = [
  "# Research brief: on-device speech recognition",
  "",
  "On-device speech recognition removes the network round trip from voice interfaces and keeps audio on the handset.",
  "Recent small models run in a few hundred megabytes and stream partial results in well under a second.",
  "Battery cost dominates the design trade-off, not raw accuracy.",
  "Teams report that quantised models lose under two percent word accuracy on short utterances.",
  "Latency budgets of 300 milliseconds are achievable on mid-range phones when the vocabulary is bounded.",
  "",
  "- Small models now fit in mobile memory budgets.",
  "- Quantisation preserves accuracy for short commands.",
  "- Privacy is a product feature, not only a compliance claim.",
  "- Battery cost constrains always-on listening.",
  "- Streaming partials change interaction design.",
  "",
].join("\n");

const SCRIPT = [
  "SCENE 1 — INT. STUDIO — DAY",
  "The host opens with the measured latency chart on screen and explains what on-device recognition changes for the viewer.",
  "The camera holds on the chart while the narration states the baseline numbers recorded in the research brief.",
  "SCENE 2 — INT. WORKSHOP — NIGHT",
  "An engineer demonstrates a quantised model running on a mid-range handset with the network disabled.",
  "The host asks what the battery cost is and the engineer answers with the measured figure rather than a guess.",
  "SCENE 3 — EXT. ROOFTOP — DUSK",
  "Closing narration restates the three findings and points to the written brief for the full measurements.",
  "The episode ends on the device screen showing a completed transcription with no network connection active.",
].join("\n");

const CHARACTERS = [
  { name: "Host", role: "presenter", continuityKey: "host-primary" },
  { name: "Engineer", role: "expert", continuityKey: "engineer-primary" },
];

function completeConfig(directorId) {
  return {
    directorId,
    displayName: directorId,
    universeName: `${directorId} universe`,
    niche: "documentary technology",
    genres: ["tech", "documentary"],
    contentFormats: ["long_form"],
    languages: ["en", "hi"],
    targetAudience: "engineers",
    creativeDirection: "evidence-first, measured",
    teamConfig: { lead: "director", editor: "shared-pool" },
    productionConfig: { episodesPerDay: 1, maxEpisodeSeconds: 2400 },
    providerConfig: [`vault://stph/${directorId}/primary`],
    platformConnections: ["youtube"],
  };
}

test(
  "PostgreSQL 15 Director worker runtime: registration, real stage execution, fencing, isolation, recovery and reporting",
  { skip: POSTGRES_URL ? false : "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" },
  async () => {
    const created = await createDisposableDatabase(POSTGRES_URL, "stph_acceptance");
    const pool = new pg.Pool({ connectionString: created.connectionString, max: 16 });
    const artifactsRoot = mkdtempSync(path.join(os.tmpdir(), "stph-worker-acceptance-"));
    mkdirSync(path.join(artifactsRoot, "inputs"), { recursive: true });
    writeFileSync(path.join(artifactsRoot, "inputs", "alpha-source.md"), SOURCE);
    writeFileSync(path.join(artifactsRoot, "inputs", "beta-source.md"), `Beta universe briefing.\n\n${SOURCE}`);
    writeFileSync(path.join(artifactsRoot, "inputs", "script.txt"), SCRIPT);
    writeFileSync(path.join(artifactsRoot, "inputs", "characters.json"), JSON.stringify(CHARACTERS));

    try {
      const migrations = await new MigrationRunner(new PostgresAdapter({}, pool)).runMigrations();
      assert.ok(migrations.appliedCount >= 46, "migration 046 must be part of the canonical set");

      const ownerId = (
        await pool.query("INSERT INTO owners (email, password_hash) VALUES ($1, 'test-hash') RETURNING id", [
          `day6-owner-${Date.now()}@example.test`,
        ])
      ).rows[0].id;

      const repo = new PostgresDirectorFleetRepository(pool);
      const workers = new PostgresDirectorWorkerRepository(pool, { fleet: repo });
      const manager = new HermesFleetManager({ repository: repo });
      const registry = createStageHandlerRegistry({
        artifactsRoot,
        ffprobeAvailable: false,
        environment: "TEST",
      });

      const activate = async (directorId) => {
        await repo.registerDirector({
          ...completeConfig(directorId),
          lifecycleState: "CONFIGURED",
          actor: OWNER,
          correlationId: randomUUID(),
          reason: `Register ${directorId}`,
        });
        await repo.setOwnerAuthorization({
          directorId,
          authorized: true,
          actor: OWNER,
          correlationId: randomUUID(),
          reason: "Owner authorized activation",
        });
        await repo.transition({
          directorId,
          to: "READY",
          reason: "Configuration complete",
          actor: OWNER,
          correlationId: randomUUID(),
        });
        await repo.transition({
          directorId,
          to: "ACTIVE",
          reason: "Owner activated the Director",
          actor: OWNER,
          correlationId: randomUUID(),
        });
      };

      const makeTask = async ({
        directorId,
        projectId,
        stage,
        key,
        input = {},
        dependsOnTaskIds = [],
        maxAttempts = 3,
        priority = 100,
      }) => {
        const created = await repo.createTask({
          directorId,
          projectId,
          stage,
          idempotencyKey: key,
          correlationId: randomUUID(),
          dependsOnTaskIds,
          input,
          maxAttempts,
          priority,
        });
        const assigned = await manager.assignTask({
          directorId,
          taskId: created.task.taskId,
          actor: OWNER,
          correlationId: randomUUID(),
          reason: "Day 6 acceptance scheduling",
        });
        return assigned.task;
      };

      const makeRuntime = async ({
        workerKey,
        stageTypes,
        capabilities,
        directorScope,
        concurrency = 1,
        testFixture = true,
        instanceId = null,
      }) => {
        const runtime = createDirectorWorkerRuntime({
          repository: workers,
          fleet: repo,
          registry,
          workerKey,
          instanceId: instanceId ?? `${workerKey}-instance`,
          stageTypes,
          capabilities,
          directorScope,
          concurrency,
          environment: "TEST",
          testFixture,
          artifactsRoot,
          pollIntervalMs: 25,
          heartbeatSeconds: 60,
          leaseSeconds: 30,
          logger: quiet,
        });
        await runtime.register();
        return runtime;
      };

      const taskRow = async (taskId) =>
        (await pool.query("SELECT * FROM director_tasks WHERE id = $1", [taskId])).rows[0];

      // ------------------------------------------------------------- setup
      await activate("alpha");
      await activate("beta");
      await activate("sierra");
      const projectA = await repo.createProject({
        directorId: "alpha",
        projectKey: "alpha-ep-1",
        universeId: "alpha-universe",
        title: "On-device speech recognition",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const projectB = await repo.createProject({
        directorId: "beta",
        projectKey: "beta-ep-1",
        universeId: "beta-universe",
        title: "Beta episode",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const projectS = await repo.createProject({
        directorId: "sierra",
        projectKey: "sierra-ep-1",
        universeId: "sierra-universe",
        title: "Sierra episode",
        actor: OWNER,
        correlationId: randomUUID(),
      });

      // ------------------------------------------------------ A, B, C, D, E
      const registrationA = await workers.registerWorker({
        workerKey: "worker-alpha",
        instanceId: "alpha-instance-1",
        stageTypes: ["RESEARCH", "SCRIPT", "CHARACTERS", "QC"],
        capabilities: ["document.structure", "metadata.validation", "qc.rules"],
        directorScope: ["alpha"],
        actor: { id: "forge", role: "FORGE" },
      });
      assert.equal(registrationA.registered, true);
      assert.equal(registrationA.worker.state, "REGISTERED");
      assert.equal(registrationA.worker.stageTypes.length, 4);

      const duplicate = await workers.registerWorker({
        workerKey: "worker-alpha",
        instanceId: "alpha-instance-1",
        stageTypes: ["RESEARCH", "SCRIPT", "CHARACTERS", "QC"],
        capabilities: ["document.structure", "metadata.validation", "qc.rules"],
        directorScope: ["alpha"],
      });
      assert.equal(duplicate.duplicate, true, "re-registering the same runtime is idempotent");
      await assert.rejects(
        () =>
          workers.registerWorker({
            workerKey: "worker-alpha",
            instanceId: "a-different-process",
            stageTypes: ["RESEARCH"],
            capabilities: ["document.structure"],
            directorScope: ["alpha"],
          }),
        (error) => error.code === "WORKER_KEY_IN_USE"
      );

      const firstBeat = await workers.heartbeat({ workerKey: "worker-alpha", instanceId: "alpha-instance-1", state: "IDLE" });
      assert.equal(firstBeat.state, "IDLE");
      assert.ok(firstBeat.lastHeartbeatAt);
      const heartbeatRow = (await pool.query("SELECT last_heartbeat_at, state FROM director_workers WHERE worker_key = $1", ["worker-alpha"])).rows[0];
      assert.equal(heartbeatRow.state, "IDLE");
      assert.ok(Date.now() - new Date(heartbeatRow.last_heartbeat_at).getTime() < 5000);

      await pool.query("UPDATE director_workers SET last_heartbeat_at = clock_timestamp() - interval '10 minutes' WHERE worker_key = $1", [
        "worker-alpha",
      ]);
      const staleList = await workers.listWorkers();
      const staleAlpha = staleList.find((worker) => worker.workerKey === "worker-alpha");
      assert.equal(staleAlpha.expired, true);
      assert.equal(staleAlpha.online, false);
      const expired = await repo.expireWorkers({ ttlSeconds: 90 });
      assert.ok(expired.some((worker) => worker.workerKey === "worker-alpha"));
      await workers.heartbeat({ workerKey: "worker-alpha", instanceId: "alpha-instance-1", state: "OFFLINE" });
      await workers.heartbeat({ workerKey: "worker-alpha", instanceId: "alpha-instance-1", state: "IDLE" });

      const capabilityCheck = StageHandlerRegistry.validateCapabilities({ stageTypes: ["RESEARCH"], capabilities: [] });
      assert.equal(capabilityCheck.ok, false);
      assert.match(capabilityCheck.problems.join(" "), /missing capability document\.structure/);

      const workerBeta = await makeRuntime({
        workerKey: "worker-beta",
        stageTypes: ["RESEARCH", "SCRIPT", "CHARACTERS"],
        capabilities: ["document.structure", "metadata.validation"],
        directorScope: ["beta"],
      });
      const workerAlpha = await makeRuntime({
        workerKey: "worker-alpha",
        instanceId: "alpha-instance-1",
        stageTypes: ["RESEARCH", "SCRIPT", "CHARACTERS", "QC"],
        capabilities: ["document.structure", "metadata.validation", "qc.rules"],
        directorScope: ["alpha"],
      });

      // A worker whose stage types do not cover the queued work claims nothing.
      const wrongStageRuntime = await makeRuntime({
        workerKey: "worker-voice-only",
        stageTypes: ["VOICE"],
        capabilities: [],
        directorScope: ["alpha"],
      });
      const researchA = await makeTask({
        directorId: "alpha",
        projectId: projectA.projectId,
        stage: "RESEARCH",
        key: `alpha-research-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
      });
      assert.equal((await wrongStageRuntime.tickOnce()).claimed, 0, "a VOICE-only worker must not claim RESEARCH work");

      // ------------------------------------------- F, Q, R, J, K, L, M
      const researchB = await makeTask({
        directorId: "beta",
        projectId: projectB.projectId,
        stage: "RESEARCH",
        key: `beta-research-${randomUUID()}`,
        input: { sourceRef: "inputs/beta-source.md" },
      });
      const [claimAlpha, claimBeta] = await Promise.all([
        workers.claimTask({ workerKey: "worker-alpha" }),
        workers.claimTask({ workerKey: "worker-beta" }),
      ]);
      assert.equal(claimAlpha.claimed, true);
      assert.equal(claimBeta.claimed, true);
      assert.notEqual(claimAlpha.task.taskId, claimBeta.task.taskId, "two workers never claim the same task");
      assert.equal(claimAlpha.task.directorId, "alpha");
      assert.equal(claimBeta.task.directorId, "beta");
      assert.equal(claimAlpha.fencingToken, 1);
      const leaseRows = await pool.query(
        "SELECT task_id, count(*)::int AS count FROM director_task_leases WHERE task_id = ANY($1) AND released_at IS NULL GROUP BY task_id",
        [[claimAlpha.task.taskId, claimBeta.task.taskId]]
      );
      assert.equal(leaseRows.rows.length, 2);
      assert.ok(leaseRows.rows.every((row) => Number(row.count) === 1), "no task has two active leases");

      const [outAlpha, outBeta] = await Promise.all([
        workerAlpha.executeClaim(claimAlpha),
        workerBeta.executeClaim(claimBeta),
      ]);
      assert.equal(outAlpha.outcome, "COMPLETED");
      assert.equal(outBeta.outcome, "COMPLETED");
      assert.equal((await taskRow(researchA.taskId)).status, "COMPLETED");
      assert.equal((await taskRow(researchB.taskId)).status, "COMPLETED");

      const evidenceA = await repo.listEvidence({ directorId: "alpha", taskId: researchA.taskId });
      const evidenceB = await repo.listEvidence({ directorId: "beta", taskId: researchB.taskId });
      assert.equal(evidenceA.length, 1);
      assert.equal(evidenceA[0].evidenceType, "research_brief");
      assert.equal(evidenceA[0].artifactHash, sha(Buffer.from(SOURCE, "utf8")), "hash comes from the real input bytes");
      assert.equal(evidenceA[0].handlerName, "research-brief-structurer");
      assert.equal(evidenceA[0].verificationLevel, "IMPLEMENTED");
      assert.equal(evidenceA[0].environment, "TEST");
      assert.equal(evidenceA[0].testFixture, true);
      assert.equal(evidenceA[0].workerKey, "worker-alpha");
      assert.equal(Number(evidenceA[0].fencingToken), 1);
      assert.deepEqual(evidenceA[0].payload.mediaFiles, []);
      assert.equal(evidenceA[0].payload.metadataOnly, true);
      assert.equal(evidenceB[0].payload.sourceHash, sha(Buffer.from(`Beta universe briefing.\n\n${SOURCE}`, "utf8")));

      // A stage body cannot be completed on the strength of fixture evidence when
      // the caller is a production worker.
      const scriptA = await makeTask({
        directorId: "alpha",
        projectId: projectA.projectId,
        stage: "SCRIPT",
        key: `alpha-script-${randomUUID()}`,
        input: { scriptRef: "inputs/script.txt" },
      });
      const scriptClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(scriptClaim.task.taskId, scriptA.taskId);
      await assert.rejects(
        () =>
          workers.completeTask({
            directorId: "alpha",
            taskId: scriptA.taskId,
            workerKey: "worker-alpha",
            fencingToken: scriptClaim.fencingToken + 1,
            resultRef: "director-stage://script/stale",
            evidence: [],
            allowTestFixtures: true,
          }),
        (error) => ["TASK_FENCING_TOKEN_STALE", "TASK_LEASE_NOT_ACTIVE"].includes(error.code)
      );
      const scriptResult = registry.execute({
        stage: "SCRIPT",
        task: { input: { scriptRef: "inputs/script.txt" } },
        input: { scriptRef: "inputs/script.txt" },
        environment: "TEST",
        testFixture: true,
      });
      await assert.rejects(
        () =>
          workers.completeTask({
            directorId: "alpha",
            taskId: scriptA.taskId,
            workerKey: "worker-alpha",
            fencingToken: scriptClaim.fencingToken,
            resultRef: scriptResult.resultRef,
            evidence: scriptResult.evidence,
            allowTestFixtures: false,
          }),
        (error) => error.code === "TASK_STAGE_EVIDENCE_MISSING",
        "fixture-only evidence must not satisfy a production completion"
      );
      const completedScript = await workers.completeTask({
        directorId: "alpha",
        taskId: scriptA.taskId,
        workerKey: "worker-alpha",
        fencingToken: scriptClaim.fencingToken,
        resultRef: scriptResult.resultRef,
        evidence: scriptResult.evidence,
        allowTestFixtures: true,
      });
      assert.equal(completedScript.status, "COMPLETED");
      const scriptEvidence = await repo.listEvidence({ directorId: "alpha", taskId: scriptA.taskId });
      assert.equal(scriptEvidence[0].artifactHash, sha(Buffer.from(SCRIPT, "utf8")));
      assert.equal(scriptEvidence[0].payload.generated, false);

      // AA: re-adding the same evidence type updates rather than duplicating.
      await repo.addEvidence({
        directorId: "alpha",
        taskId: scriptA.taskId,
        evidenceType: "script",
        artifactHash: scriptEvidence[0].artifactHash,
        payload: { refreshed: true },
      });
      const dedupedEvidence = await repo.listEvidence({ directorId: "alpha", taskId: scriptA.taskId });
      assert.equal(dedupedEvidence.length, 1, "evidence is unique per (task, type)");

      // ------------------------------------------------------ H, I: dependencies
      const charactersA = await makeTask({
        directorId: "alpha",
        projectId: projectA.projectId,
        stage: "CHARACTERS",
        key: `alpha-characters-${randomUUID()}`,
        input: { characters: CHARACTERS },
        dependsOnTaskIds: [scriptA.taskId],
        priority: 50,
      });
      // An explicitly declared dependency that has not completed is refused.
      const pendingDependency = await repo.createTask({
        directorId: "beta",
        projectId: projectB.projectId,
        stage: "RESEARCH",
        idempotencyKey: `beta-pending-${randomUUID()}`,
        correlationId: randomUUID(),
        input: { sourceRef: "inputs/beta-source.md" },
      });
      await assert.rejects(
        () =>
          makeTask({
            directorId: "beta",
            projectId: projectB.projectId,
            stage: "SCRIPT",
            key: `beta-script-${randomUUID()}`,
            input: { scriptRef: "inputs/script.txt" },
            dependsOnTaskIds: [pendingDependency.task.taskId],
          }),
        (error) => error.code === "TASK_DEPENDENCY_UNSATISFIED",
        "an unfinished dependency is refused"
      );

      const lostEvidenceProject = await repo.createProject({
        directorId: "alpha",
        projectKey: `alpha-lost-evidence-${randomUUID()}`,
        universeId: "alpha-universe",
        title: "Evidence loss scenario",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const lostResearch = await makeTask({
        directorId: "alpha",
        projectId: lostEvidenceProject.projectId,
        stage: "RESEARCH",
        key: `alpha-lost-research-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        priority: 1,
      });
      const lostClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      const lostOutcome = await workerAlpha.executeClaim(lostClaim);
      assert.equal(lostOutcome.outcome, "COMPLETED");
      assert.equal((await taskRow(lostResearch.taskId)).status, "COMPLETED");
      await pool.query("DELETE FROM director_task_evidence WHERE task_id = $1", [lostResearch.taskId]);
      await assert.rejects(
        () =>
          makeTask({
            directorId: "alpha",
            projectId: lostEvidenceProject.projectId,
            stage: "SCRIPT",
            key: `alpha-lost-script-${randomUUID()}`,
            input: { scriptRef: "inputs/script.txt" },
          }),
        (error) => error.code === "TASK_DEPENDENCY_UNSATISFIED",
        "a completed upstream stage without its evidence does not unlock downstream work"
      );

      // ------------------------------------------------ O: lease-loss abort
      const lossProject = await repo.createProject({
        directorId: "alpha",
        projectKey: `alpha-lease-loss-${randomUUID()}`,
        universeId: "alpha-universe",
        title: "Lease loss scenario",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const lossTask = await makeTask({
        directorId: "alpha",
        projectId: lossProject.projectId,
        stage: "RESEARCH",
        key: `alpha-lease-loss-task-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        priority: 1,
      });
      const lossClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(lossClaim.task.taskId, lossTask.taskId);
      await workers.releaseLease({
        taskId: lossTask.taskId,
        workerKey: "worker-alpha",
        fencingToken: lossClaim.fencingToken,
        reason: "reclaimed",
      });
      const lossOutcome = await workerAlpha.executeClaim(lossClaim);
      assert.equal(lossOutcome.outcome, "LEASE_LOST");
      assert.equal((await taskRow(lossTask.taskId)).status, "RUNNING", "a lost lease commits nothing");
      const violations = await pool.query("SELECT count(*)::int AS count FROM director_lease_violations");
      assert.ok(Number(violations.rows[0].count) >= 1, "the refused commit is recorded durably");

      // -------------------------------- N, P, AJ: renewal, recovery, re-claim
      const lostLeaseRecovery = await repo.recoverExpiredLeases();
      assert.ok(lostLeaseRecovery.some((entry) => entry.taskId === lossTask.taskId));
      assert.equal((await taskRow(lossTask.taskId)).status, "RETRY_SCHEDULED");
      // A requeued task is genuinely re-executable by a healthy worker.
      const lossRetryClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(lossRetryClaim.task.taskId, lossTask.taskId);
      assert.equal((await workerAlpha.executeClaim(lossRetryClaim)).outcome, "COMPLETED");

      const renewTask = await makeTask({
        directorId: "alpha",
        projectId: projectA.projectId,
        stage: "CHARACTERS",
        key: `alpha-renew-${randomUUID()}`,
        input: { characters: CHARACTERS },
        dependsOnTaskIds: [scriptA.taskId],
        priority: 1,
      });
      // charactersA (priority 50) stays queued; the priority-1 task is chosen.
      const renewClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(renewClaim.task.taskId, renewTask.taskId);
      const renewed = await workers.renewLease({
        workerKey: "worker-alpha",
        taskId: renewClaim.task.taskId,
        fencingToken: renewClaim.fencingToken,
        leaseSeconds: 60,
      });
      assert.ok(new Date(renewed.leaseExpiresAt).getTime() > Date.now());
      await assert.rejects(
        () =>
          workers.renewLease({
            workerKey: "worker-beta",
            taskId: renewClaim.task.taskId,
            fencingToken: renewClaim.fencingToken,
            leaseSeconds: 60,
          }),
        (error) => error.code === "LEASE_LOST"
      );

      // The renewed lease is usable: the same worker completes the stage.
      const renewOutcome = await workerAlpha.executeClaim(renewClaim);
      assert.equal(renewOutcome.outcome, "COMPLETED");

      // Two workers abandon their claims; recovery must requeue both, and healthy
      // workers must then execute them without duplicate work.
      const abandonProjectA = await repo.createProject({
        directorId: "alpha",
        projectKey: `alpha-abandon-${randomUUID()}`,
        universeId: "alpha-universe",
        title: "Abandoned leases alpha",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const abandonProjectB = await repo.createProject({
        directorId: "beta",
        projectKey: `beta-abandon-${randomUUID()}`,
        universeId: "beta-universe",
        title: "Abandoned leases beta",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const abandonOne = await makeTask({
        directorId: "alpha",
        projectId: abandonProjectA.projectId,
        stage: "RESEARCH",
        key: `alpha-abandon-1-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        priority: 1,
      });
      const abandonTwo = await makeTask({
        directorId: "beta",
        projectId: abandonProjectB.projectId,
        stage: "RESEARCH",
        key: `beta-abandon-2-${randomUUID()}`,
        input: { sourceRef: "inputs/beta-source.md" },
      });
      const abandonClaimOne = await workers.claimTask({ workerKey: "worker-alpha" });
      const abandonClaimTwo = await workers.claimTask({ workerKey: "worker-beta" });
      assert.equal(abandonClaimOne.task.taskId, abandonOne.taskId);
      assert.equal(abandonClaimTwo.task.taskId, abandonTwo.taskId);
      assert.notEqual(abandonClaimOne.task.taskId, abandonClaimTwo.task.taskId);
      await pool.query(
        "UPDATE director_task_leases SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE task_id = ANY($1) AND released_at IS NULL",
        [[abandonClaimOne.task.taskId, abandonClaimTwo.task.taskId]]
      );
      const recovered = await repo.recoverExpiredLeases();
      assert.equal(recovered.length >= 2, true, "both abandoned leases are recovered");
      for (const abandoned of [abandonOne, abandonTwo]) {
        const requeued = await taskRow(abandoned.taskId);
        assert.equal(requeued.status, "RETRY_SCHEDULED");
        assert.equal(Number(requeued.attempt_count), 1);
      }

      const recoveryOne = await workers.claimTask({ workerKey: "worker-alpha" });
      const recoveryTwo = await workers.claimTask({ workerKey: "worker-beta" });
      assert.equal(recoveryOne.task.taskId, abandonOne.taskId);
      assert.equal(recoveryTwo.task.taskId, abandonTwo.taskId);
      assert.notEqual(recoveryOne.task.taskId, recoveryTwo.task.taskId);
      const [recoveredOutcomeOne, recoveredOutcomeTwo] = await Promise.all([
        workerAlpha.executeClaim(recoveryOne),
        workerBeta.executeClaim(recoveryTwo),
      ]);
      assert.equal(recoveredOutcomeOne.outcome, "COMPLETED");
      assert.equal(recoveredOutcomeTwo.outcome, "COMPLETED");
      assert.equal(Number((await taskRow(abandonTwo.taskId)).attempt_count), 2);

      // ------------------------------------------------ T: suspended Director
      const sierraTask = await makeTask({
        directorId: "sierra",
        projectId: projectS.projectId,
        stage: "RESEARCH",
        key: `sierra-research-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        priority: 1,
      });
      await manager.suspendDirector({
        directorId: "sierra",
        actor: OWNER,
        correlationId: randomUUID(),
        reason: "Owner suspended Sierra",
      });
      const sierraWorker = await makeRuntime({
        workerKey: "worker-sierra",
        stageTypes: ["RESEARCH"],
        capabilities: ["document.structure"],
        directorScope: ["sierra"],
      });
      assert.equal((await sierraWorker.tickOnce()).claimed, 0, "a suspended Director receives no work");
      assert.equal((await taskRow(sierraTask.taskId)).status, "QUEUED");

      // ------------------------------------------- U, V, Y: retry and terminal
      const retryProject = await repo.createProject({
        directorId: "alpha",
        projectKey: `alpha-retry-${randomUUID()}`,
        universeId: "alpha-universe",
        title: "Retry scenario",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      // V: a genuinely invalid stage input is a permanent, terminal failure.
      const invalidInputTask = await makeTask({
        directorId: "alpha",
        projectId: retryProject.projectId,
        stage: "RESEARCH",
        key: `alpha-invalid-input-${randomUUID()}`,
        input: { sourceRef: "inputs/does-not-exist.md" },
        maxAttempts: 3,
        priority: 1,
      });
      const invalidClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(invalidClaim.task.taskId, invalidInputTask.taskId);
      const invalidOutcome = await workerAlpha.executeClaim(invalidClaim);
      assert.equal(invalidOutcome.outcome, "FAILED");
      assert.equal(invalidOutcome.code, STAGE_ERROR.STAGE_INPUT_INVALID);
      const permanentTask = await taskRow(invalidInputTask.taskId);
      assert.equal(permanentTask.status, "DEAD_LETTER", "an invalid input is terminal on the first occurrence");
      assert.equal(Number(permanentTask.attempt_count), 1, "a permanent failure is not retried");

      // U: a transient infrastructure failure is retried with backoff.
      const retryTask = await makeTask({
        directorId: "alpha",
        projectId: retryProject.projectId,
        stage: "RESEARCH",
        key: `alpha-retry-task-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        maxAttempts: 3,
        priority: 1,
      });
      assert.ok(retryDelaySeconds(2, retryTask.taskId) >= retryDelaySeconds(1, retryTask.taskId), "backoff grows with attempts");
      const retryClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(retryClaim.task.taskId, retryTask.taskId);

      const bounded = await makeTask({
        directorId: "alpha",
        projectId: retryProject.projectId,
        stage: "RESEARCH",
        key: `alpha-bounded-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        maxAttempts: 2,
        priority: 1,
      });
      let boundedClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(boundedClaim.task.taskId, bounded.taskId);
      const firstFailure = await workers.failTask({
        directorId: "alpha",
        taskId: bounded.taskId,
        workerKey: "worker-alpha",
        fencingToken: boundedClaim.fencingToken,
        error: "ETIMEDOUT",
      });
      assert.equal(firstFailure.task.status, "RETRY_SCHEDULED");
      assert.ok(new Date(firstFailure.task.nextRunAt).getTime() > Date.now());
      assert.equal(firstFailure.classification.failureClass, "TRANSIENT");
      assert.equal(firstFailure.classification.retryable, true);
      await pool.query("UPDATE director_tasks SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = $1", [
        bounded.taskId,
      ]);
      boundedClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(boundedClaim.task.taskId, bounded.taskId);
      const secondFailure = await workers.failTask({
        directorId: "alpha",
        taskId: bounded.taskId,
        workerKey: "worker-alpha",
        fencingToken: boundedClaim.fencingToken,
        error: "ECONNRESET",
      });
      assert.equal(secondFailure.task.status, "DEAD_LETTER");
      assert.equal(secondFailure.task.blockedReason, "RETRY_EXHAUSTED");
      const deadLetters = await workers.listDeadLetters({ directorId: "alpha" });
      assert.ok(deadLetters.some((task) => task.taskId === bounded.taskId));

      // -------------------------------------------------------- W, X: provider
      const voiceTask = await makeTask({
        directorId: "alpha",
        projectId: projectA.projectId,
        stage: "VOICE",
        key: `alpha-voice-${randomUUID()}`,
        dependsOnTaskIds: [scriptA.taskId],
        priority: 1,
      });
      const voiceWorker = await makeRuntime({
        workerKey: "worker-voice",
        stageTypes: ["VOICE"],
        capabilities: [],
        directorScope: ["alpha"],
      });
      const voiceClaim = await workers.claimTask({ workerKey: "worker-voice" });
      assert.equal(voiceClaim.task.taskId, voiceTask.taskId);
      const voiceOutcome = await voiceWorker.executeClaim(voiceClaim);
      assert.equal(voiceOutcome.outcome, "BLOCKED");
      assert.equal(voiceOutcome.code, STAGE_ERROR.PROVIDER_NOT_CONFIGURED);
      const blockedVoice = await taskRow(voiceTask.taskId);
      assert.equal(blockedVoice.status, "BLOCKED");
      assert.equal(blockedVoice.provider_state, "UNAVAILABLE");
      assert.equal(Number(blockedVoice.attempt_count), 1);

      const quotaTask = await makeTask({
        directorId: "alpha",
        projectId: projectA.projectId,
        stage: "MUSIC",
        key: `alpha-music-${randomUUID()}`,
        dependsOnTaskIds: [scriptA.taskId],
        priority: 1,
      });
      // The voice-only worker cannot claim a MUSIC task.
      assert.equal((await workers.claimTask({ workerKey: "worker-voice" }))?.claimed === true, false);
      const musicWorker = await makeRuntime({
        workerKey: "worker-music",
        stageTypes: ["MUSIC"],
        capabilities: [],
        directorScope: ["alpha"],
      });
      const alphaClaim = await workers.claimTask({ workerKey: "worker-music" });
      assert.equal(alphaClaim.task.taskId, quotaTask.taskId);
      const quotaBlocked = await workers.failTask({
        directorId: "alpha",
        taskId: quotaTask.taskId,
        workerKey: "worker-music",
        fencingToken: alphaClaim.fencingToken,
        error: STAGE_ERROR.PROVIDER_QUOTA_EXHAUSTED,
      });
      assert.equal(quotaBlocked.blocked, true);
      const quotaRow = await taskRow(quotaTask.taskId);
      assert.equal(quotaRow.status, "BLOCKED");
      assert.equal(quotaRow.provider_state, "QUOTA_EXHAUSTED");
      assert.equal(Number(quotaRow.attempt_count), 1, "quota exhaustion never consumes another attempt");
      assert.ok(new Date(quotaRow.next_run_at).getTime() > Date.now(), "a cooldown is enforced");
      // A blocked task is not claimable during the cooldown.
      const blockedClaim = await workers.claimTask({ workerKey: "worker-music" });
      assert.notEqual(blockedClaim?.task?.taskId, quotaTask.taskId);
      await musicWorker.stop({ reason: "Acceptance teardown", timeoutMs: 50 }).catch(() => {});

      // -------------------------------------------- Z: graceful shutdown path
      const shutdownRuntime = await makeRuntime({
        workerKey: "worker-shutdown",
        stageTypes: ["RESEARCH"],
        capabilities: ["document.structure"],
        directorScope: ["alpha"],
      });
      const shutdownProject = await repo.createProject({
        directorId: "alpha",
        projectKey: `alpha-shutdown-${randomUUID()}`,
        universeId: "alpha-universe",
        title: "Shutdown scenario",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const shutdownTask = await makeTask({
        directorId: "alpha",
        projectId: shutdownProject.projectId,
        stage: "RESEARCH",
        key: `alpha-shutdown-task-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        priority: 1,
      });
      const shutdownClaim = await workers.claimTask({ workerKey: "worker-shutdown" });
      assert.equal(shutdownClaim.task.taskId, shutdownTask.taskId);
      shutdownRuntime.inFlight.set(shutdownTask.taskId, {
        claim: shutdownClaim,
        controller: new AbortController(),
        done: new Promise((resolve) => setTimeout(resolve, 400)),
      });
      const stopped = await shutdownRuntime.stop({ reason: "Acceptance graceful shutdown", timeoutMs: 50 });
      assert.equal(stopped.stopped, true);
      const stoppedRow = await workers.getWorker("worker-shutdown");
      assert.equal(stoppedRow.state, "STOPPED");
      const releasedLease = (await pool.query("SELECT release_reason FROM director_task_leases WHERE task_id = $1", [shutdownTask.taskId])).rows[0];
      assert.equal(releasedLease.release_reason, "restart");
      const history = await workers.workerHistory({ workerKey: "worker-shutdown" });
      assert.ok(history.some((entry) => entry.action === "WORKER_STATE_CHANGED"));
      await repo.recoverExpiredLeases();
      assert.equal((await taskRow(shutdownTask.taskId)).status, "RETRY_SCHEDULED");
      const shutdownReclaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(shutdownReclaim.task.taskId, shutdownTask.taskId);
      assert.equal((await workerAlpha.executeClaim(shutdownReclaim)).outcome, "COMPLETED");

      // ------------------------------------------- AG: cancellation
      const cancelTaskRow = await makeTask({
        directorId: "alpha",
        projectId: projectA.projectId,
        stage: "CHARACTERS",
        key: `alpha-cancel-${randomUUID()}`,
        input: { characters: CHARACTERS },
        dependsOnTaskIds: [scriptA.taskId],
        priority: 1,
      });
      const cancelClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(cancelClaim.task.taskId, cancelTaskRow.taskId);
      await manager.cancelTask({
        directorId: "alpha",
        taskId: cancelTaskRow.taskId,
        actor: OWNER,
        correlationId: randomUUID(),
        reason: "Owner cancelled the stage",
      });
      const cancelOutcome = await workerAlpha.executeClaim(cancelClaim);
      assert.equal(cancelOutcome.outcome, "CANCELLED");
      assert.equal((await taskRow(cancelTaskRow.taskId)).status, "CANCELLED");

      // ------------------------------------------- AF: no secret leakage
      const secretProject = await repo.createProject({
        directorId: "alpha",
        projectKey: `alpha-secret-${randomUUID()}`,
        universeId: "alpha-universe",
        title: "Secret refusal scenario",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const SECRET = "sk-live-abcdefghijklmnop1234";
      const secretTask = await makeTask({
        directorId: "alpha",
        projectId: secretProject.projectId,
        stage: "RESEARCH",
        key: `alpha-secret-task-${randomUUID()}`,
        input: { sourceText: SOURCE, apiKey: SECRET },
        priority: 1,
      });
      const secretClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(
        secretClaim.task.taskId,
        secretTask.taskId,
        `secret scenario claimed ${secretClaim.task.stage} ${secretClaim.task.taskId} instead of the target task`
      );
      const storedSecretInput = (await taskRow(secretTask.taskId)).input;
      assert.equal(storedSecretInput.apiKey, SECRET, `stored input keys: ${Object.keys(storedSecretInput).join(",")}`);
      const secretOutcome = await workerAlpha.executeClaim(secretClaim);
      assert.equal(
        secretOutcome.outcome,
        "FAILED",
        `secret outcome ${JSON.stringify(secretOutcome)} row=${JSON.stringify(await taskRow(secretTask.taskId)).slice(0, 500)}`
      );
      const secretRow = await taskRow(secretTask.taskId);
      assert.match(secretRow.last_error, /SECRET_MATERIAL_REJECTED/);
      assert.equal(secretRow.last_error.includes(SECRET), false);
      assert.equal((await repo.listEvidence({ directorId: "alpha", taskId: secretTask.taskId })).length, 0);

      // ------------------------------------------- AH: worker draining
      await workers.drain({ workerKey: "worker-beta", actor: OWNER, correlationId: randomUUID(), reason: "Owner drained beta" });
      const drainedBeta = await workers.getWorker("worker-beta");
      assert.equal(drainedBeta.state, "DRAINING");
      const drainedClaim = await workers.claimTask({ workerKey: "worker-beta" });
      assert.equal(drainedClaim.claimed, false);
      await workers.requestRestart({ workerKey: "worker-beta", actor: OWNER, correlationId: randomUUID(), reason: "Owner restart" });
      const restartRequested = await workers.getWorker("worker-beta");
      assert.ok(restartRequested.restartRequestedAt);

      // --------------------------------------- AI: stale worker cannot commit
      const staleProject = await repo.createProject({
        directorId: "alpha",
        projectKey: `alpha-stale-${randomUUID()}`,
        universeId: "alpha-universe",
        title: "Stale fence scenario",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const staleTask = await makeTask({
        directorId: "alpha",
        projectId: staleProject.projectId,
        stage: "RESEARCH",
        key: `alpha-stale-task-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        priority: 1,
      });
      const originalWorker = await makeRuntime({
        workerKey: "worker-stale-original",
        stageTypes: ["RESEARCH"],
        capabilities: ["document.structure"],
        directorScope: ["alpha"],
      });
      const replacementWorker = await makeRuntime({
        workerKey: "worker-stale-replacement",
        stageTypes: ["RESEARCH"],
        capabilities: ["document.structure"],
        directorScope: ["alpha"],
      });
      const staleClaim = await workers.claimTask({ workerKey: "worker-stale-original" });
      assert.equal(staleClaim.task.taskId, staleTask.taskId);
      await pool.query(
        "UPDATE director_task_leases SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE task_id = $1 AND released_at IS NULL",
        [staleTask.taskId]
      );
      await repo.recoverExpiredLeases();
      const replacementClaim = await workers.claimTask({ workerKey: "worker-stale-replacement" });
      assert.equal(replacementClaim.task.taskId, staleTask.taskId);
      assert.equal(replacementClaim.fencingToken, staleClaim.fencingToken + 1);
      const staleOutcome = await originalWorker.executeClaim(staleClaim);
      assert.equal(staleOutcome.outcome, "LEASE_LOST");
      assert.equal((await taskRow(staleTask.taskId)).status, "RUNNING");
      const replacementOutcome = await replacementWorker.executeClaim(replacementClaim);
      assert.equal(replacementOutcome.outcome, "COMPLETED");
      assert.equal((await taskRow(staleTask.taskId)).status, "COMPLETED");

      // ------------------------------------------------ AA: checkpoint dedupe
      const checkpointProject = await repo.createProject({
        directorId: "alpha",
        projectKey: `alpha-checkpoint-${randomUUID()}`,
        universeId: "alpha-universe",
        title: "Checkpoint scenario",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const checkpointTask = await makeTask({
        directorId: "alpha",
        projectId: checkpointProject.projectId,
        stage: "RESEARCH",
        key: `alpha-checkpoint-task-${randomUUID()}`,
        input: { sourceRef: "inputs/alpha-source.md" },
        priority: 1,
      });
      const checkpointClaim = await workers.claimTask({ workerKey: "worker-alpha" });
      assert.equal(checkpointClaim.task.taskId, checkpointTask.taskId);
      const firstCheckpoint = await workers.writeCheckpoint({
        taskId: checkpointTask.taskId,
        workerKey: "worker-alpha",
        fencingToken: checkpointClaim.fencingToken,
        key: "research:unit",
        payload: { step: 1 },
      });
      const secondCheckpoint = await workers.writeCheckpoint({
        taskId: checkpointTask.taskId,
        workerKey: "worker-alpha",
        fencingToken: checkpointClaim.fencingToken,
        key: "research:unit",
        payload: { step: 2 },
      });
      assert.equal(firstCheckpoint.created, true);
      assert.equal(secondCheckpoint.created, false, "a replayed checkpoint is not duplicated");
      const checkpointRows = await workers.listCheckpoints(checkpointTask.taskId);
      assert.equal(checkpointRows.length, 1);
      await workers.releaseLease({
        taskId: checkpointTask.taskId,
        workerKey: "worker-alpha",
        fencingToken: checkpointClaim.fencingToken,
        reason: "restart",
      });
      await repo.recoverExpiredLeases();

      // ------------------------------------------------------ S: isolation
      assert.equal(await repo.getTask({ directorId: "alpha", taskId: researchB.taskId }), null);
      assert.deepEqual(await repo.listEvidence({ directorId: "alpha", taskId: researchB.taskId }), []);
      assert.equal(await repo.getTask({ directorId: "beta", taskId: researchA.taskId }), null);

      // Database-level isolation: a Director runtime role sees only its own rows.
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'st_dir_alpha') THEN
          CREATE ROLE st_dir_alpha NOLOGIN;
        END IF;
      END $$;`);
      await pool.query("GRANT SELECT ON director_tasks, director_projects, director_task_evidence TO st_dir_alpha");
      const rlsClient = await pool.connect();
      try {
        await rlsClient.query("SET ROLE st_dir_alpha");
        const visible = await rlsClient.query("SELECT DISTINCT director_id FROM director_tasks");
        assert.deepEqual(visible.rows.map((row) => row.director_id), ["alpha"]);
        const hiddenEvidence = await rlsClient.query("SELECT count(*)::int AS count FROM director_task_evidence WHERE director_id = 'beta'");
        assert.equal(Number(hiddenEvidence.rows[0].count), 0);
      } finally {
        await rlsClient.query("RESET ROLE");
        rlsClient.release();
      }

      // Mounted API: worker operations, isolation and CSRF.
      const app = express();
      app.use((req, res, next) => {
        req.forgeSession = { id: ownerId };
        req.forgeCsrfVerified = req.get("x-csrf-token") === "valid-csrf";
        next();
      });
      app.use(
        "/api/fleet",
        createFleetRouter({
          repository: repo,
          manager,
          workerRepository: workers,
          verifyCsrf: (req) => req.forgeCsrfVerified === true,
          getOwnerId: (req) => req.forgeSession?.id ?? null,
        })
      );
      const api = supertest(app);
      const registryResponse = await api.get("/api/fleet/workers/registry").expect(200);
      assert.ok(registryResponse.body.workers.some((worker) => worker.workerKey === "worker-alpha"));
      const metricsResponse = await api.get("/api/fleet/workers/metrics").expect(200);
      assert.ok(metricsResponse.body.tasks.claimed >= 1);
      const crossDirector = await api.get(`/api/fleet/directors/alpha/tasks/${researchB.taskId}/execution`);
      assert.equal(crossDirector.status, 404);
      const ownExecution = await api.get(`/api/fleet/directors/alpha/tasks/${researchA.taskId}/execution`).expect(200);
      assert.equal(ownExecution.body.evidence.length, 1);
      assert.equal(ownExecution.body.evidence[0].handlerName, "research-brief-structurer");
      const deadLetterRoute = await api.get("/api/fleet/tasks/dead-letters").expect(200);
      assert.ok(deadLetterRoute.body.count >= 1);
      const checkpointRoute = await api.get(`/api/fleet/tasks/${checkpointTask.taskId}/checkpoints`).expect(200);
      assert.equal(checkpointRoute.body.count, 1);
      const csrfRefused = await api
        .post("/api/fleet/workers/worker-alpha/drain")
        .send({ reason: "no token" });
      assert.equal(csrfRefused.status, 403);
      assert.equal(csrfRefused.body.code, "CSRF_REJECTED");
      const drainAccepted = await api
        .post("/api/fleet/workers/worker-alpha/drain")
        .set("x-csrf-token", "valid-csrf")
        .send({ reason: "Owner drain from acceptance test" });
      assert.equal(drainAccepted.status, 200);
      assert.equal(drainAccepted.body.worker.state, "DRAINING");
      assert.equal((await workers.claimTask({ workerKey: "worker-alpha" })).claimed, false);
      await workers.setState({ workerKey: "worker-alpha", state: "IDLE", reason: "Acceptance test resumes the worker" });

      // --------------------------------------------------- AE: report
      const report = await collectForgeDailyReport({
        pool,
        reportDate: new Date().toISOString().slice(0, 10),
        timeZone: "UTC",
      });
      assert.equal(verifyReportEvidenceHash(report), true, "the report evidence hash must verify");
      const section = report.sections.workerExecution;
      assert.ok(section, "the daily report must carry worker execution metrics");
      const sql = async (text) => Number((await pool.query(text)).rows[0].count);
      assert.equal(
        section.workersRegistered.value,
        await sql("SELECT count(*)::int AS count FROM director_workers")
      );
      assert.equal(
        section.tasksCompleted.value,
        await sql("SELECT count(*)::int AS count FROM director_tasks WHERE status = 'COMPLETED' AND claim_count > 0")
      );
      assert.equal(
        section.tasksDeadLettered.value,
        await sql("SELECT count(*)::int AS count FROM director_tasks WHERE status = 'DEAD_LETTER'")
      );
      assert.equal(
        section.leaseViolations.value,
        await sql(
          "SELECT count(*)::int AS count FROM director_lease_violations WHERE created_at >= '1970-01-01' AND created_at < '2100-01-01'"
        )
      );
      assert.equal(
        section.evidenceRecordsCreated.value,
        await sql(
          "SELECT count(*)::int AS count FROM director_task_evidence WHERE handler_name IS NOT NULL AND created_at >= '1970-01-01' AND created_at < '2100-01-01'"
        )
      );
      assert.ok(section.stageTypesExecuted.value.includes("RESEARCH"));
      assert.ok(section.stageTypesExecuted.value.includes("SCRIPT"));
      const reportText = JSON.stringify(report);
      const secretEvidence = (await pool.query("SELECT count(*)::int AS count FROM director_task_evidence WHERE worker_key = $1 AND created_at > clock_timestamp() - interval '1 hour'", ["worker-alpha"])).rows[0];
      assert.ok(Number(secretEvidence.count) >= 1);
      assert.equal(reportText.includes(SECRET), false, "no secret material may reach the report");

      // Worker metrics reconcile with the same rows the repository reports.
      const metrics = await workers.metrics();
      assert.equal(metrics.workers.registered, await sql("SELECT count(*)::int AS count FROM director_workers"));
      assert.equal(metrics.tasks.deadLettered, await sql("SELECT count(*)::int AS count FROM director_tasks WHERE status = 'DEAD_LETTER'"));
      assert.ok(metrics.tasks.handlerStarted >= metrics.tasks.completed);
      assert.ok(metrics.evidence.stageTypesExecuted.includes("RESEARCH"));
      assert.ok(metrics.tasks.recoveredAfterRestart >= 2);

      // ---------------------------------- worker capability metadata is durable
      const finalWorker = await workers.getWorker("worker-shutdown");
      assert.equal(finalWorker.state, "STOPPED");
      assert.deepEqual(finalWorker.capabilities, ["document.structure"]);
      assert.deepEqual(finalWorker.stageTypes, ["RESEARCH"]);

      // Any remaining in-flight work is released so the disposable DB closes cleanly.
      for (const runtime of [workerAlpha, workerBeta, sierraWorker, voiceWorker, originalWorker, replacementWorker, wrongStageRuntime]) {
        await runtime.stop({ reason: "Acceptance teardown", timeoutMs: 50 }).catch(() => {});
      }
    } finally {
      await pool.end().catch(() => {});
      await dropDisposableDatabase(POSTGRES_URL, created.databaseName).catch(() => {});
    }
  }
);

