/**
 * Day 5 / D7 — Director fleet orchestration acceptance on real PostgreSQL.
 *
 * Disposable database, canonical migrations (sql/001..045), real repositories,
 * real mounted routes. Nothing touches a persistent database, a provider or a
 * publishing destination.
 *
 *   A  register a Director
 *   B  enforce the 50-Director fleet capacity
 *   C  reject a duplicate Director id
 *   D  activate only an eligible Director
 *   E  prevent suspended Director task assignment
 *   F  prevent retired Director task assignment
 *   G  Director A cannot read Director B's project
 *   H  Director A cannot modify Director B's task
 *   I  Director A cannot read Director B's evidence/credentials
 *   J  idempotent Director task creation
 *   K  transactional HERMES assignment + audit
 *   L  two workers cannot claim the same task concurrently
 *   M  stale fencing tokens are rejected
 *   N  expired leases recover after a restart
 *   O  production-stage dependencies are enforced
 *   P  downstream execution without upstream evidence is refused
 *   Q  cancellation propagates to dependent tasks
 *   R  provider quota exhaustion is a blocked state, not a retry loop
 *   S  bounded retries end in dead letter
 *   T  fleet health snapshot from actual records
 *   U  genuinely expired worker heartbeats
 *   V  HERMES escalation notifications are persisted durably
 *   W  Owner approval boundary for restricted (publishing) assignment
 *   X  Owner rejection cannot be overridden
 *   Y  artifact hash + destination binding is revalidated before execution
 *   Z  daily report fleet counts reconcile with SQL
 *   AA append-only audit history and per-Director isolation
 *   AB real mounted API routes (auth, CSRF, isolation, lifecycle)
 *   AC multi-instance claim and restart recovery through new repositories
 *   AD unavailable providers produce honest blocked states
 *   AE no secrets leak into events, escalations or the report
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import supertest from "supertest";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";
import {
  PostgresDirectorFleetRepository,
} from "../src/fleet/fleetRepository.js";
import { HermesFleetManager } from "../src/fleet/hermesFleetManager.js";
import { FleetHealthService } from "../src/fleet/fleetHealthService.js";
import { createFleetRouter } from "../src/api/fleetRouter.js";
import { collectForgeDailyReport, verifyReportEvidenceHash } from "../src/reporting/dailyReportGenerator.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";
const HASH = "b".repeat(64);
const quiet = { log() {}, warn() {}, error() {} };

const OWNER = { id: "owner-fleet", role: "OWNER" };
const HERMES = { id: "hermes-manager", role: "HERMES" };

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
  "PostgreSQL 15 Director fleet: registry, isolation, fenced orchestration, health and report reconciliation",
  { skip: POSTGRES_URL ? false : "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" },
  async () => {
    const created = await createDisposableDatabase(POSTGRES_URL, "stph_acceptance");
    const pool = new pg.Pool({ connectionString: created.connectionString, max: 12 });
    // Teardown drops the disposable database WITH (FORCE); observe the idle-client
    // 57P01 a closing socket can receive instead of failing on teardown noise.
    pool.on("error", () => {});
    const extraPools = [];
    const newPool = () => {
      const instance = new pg.Pool({ connectionString: created.connectionString, max: 4 });
      instance.on("error", () => {});
      extraPools.push(instance);
      return instance;
    };

    try {
      const migrations = await new MigrationRunner(new PostgresAdapter({}, pool)).runMigrations();
      assert.ok(migrations.appliedCount >= 45, "migration 045 must be part of the canonical set");

      const ownerId = (
        await pool.query("INSERT INTO owners (email, password_hash) VALUES ($1, 'test-hash') RETURNING id", [
          `d7-owner-${Date.now()}@example.test`,
        ])
      ).rows[0].id;

      const repo = new PostgresDirectorFleetRepository(pool);
      const manager = new HermesFleetManager({ repository: repo });

      // ---------------------------------------------------------------- A, D
      const jarvis = await repo.registerDirector({
        ...completeConfig("jarvis"),
        actor: OWNER,
        correlationId: randomUUID(),
        reason: "Register the first Director",
      });
      assert.equal(jarvis.lifecycleState, "DRAFT");
      assert.deepEqual(jarvis.providerConfig, ["vault://stph/jarvis/primary"]);

      await assert.rejects(
        () =>
          repo.transition({
            directorId: "Unknown Director",
            to: "CONFIGURED",
            reason: "Configured",
            actor: OWNER,
            correlationId: randomUUID(),
          }),
        (error) => error.code === "DIRECTOR_ID_INVALID",
        "sanity: an invalid id shape must fail closed"
      );

      await repo.transition({
        directorId: "jarvis",
        to: "CONFIGURED",
        reason: "Configuration recorded",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      // Owner authorization is still missing -> READY must be refused.
      await assert.rejects(
        () =>
          repo.transition({
            directorId: "jarvis",
            to: "READY",
            reason: "Ready check",
            actor: OWNER,
            correlationId: randomUUID(),
          }),
        (error) => error.code === "DIRECTOR_NOT_READY" && error.detail.missing.includes("OWNER_AUTHORIZATION")
      );
      await repo.setOwnerAuthorization({
        directorId: "jarvis",
        authorized: true,
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const ready = await repo.transition({
        directorId: "jarvis",
        to: "READY",
        reason: "Readiness satisfied",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      assert.equal(ready.lifecycleState, "READY");
      const activated = await manager.activateDirector({
        directorId: "jarvis",
        actor: OWNER,
        correlationId: randomUUID(),
        reason: "Owner activation",
      });
      assert.equal(activated.director.lifecycleState, "ACTIVE");
      // HERMES may not activate on its own.
      await assert.rejects(
        () =>
          manager.activateDirector({
            directorId: "jarvis",
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Hermes activation attempt",
          }),
        (error) => error.code === "DIRECTOR_NOT_AUTHORIZED" && error.status === 403
      );

      // ------------------------------------------------------------------ C
      await assert.rejects(
        () =>
          repo.registerDirector({
            ...completeConfig("jarvis"),
            actor: OWNER,
            correlationId: randomUUID(),
          }),
        (error) => error.code === "DIRECTOR_ALREADY_EXISTS"
      );

      // A second, fully configured Director for isolation tests.
      await repo.registerDirector({ ...completeConfig("cosmos"), actor: OWNER, correlationId: randomUUID() });
      await repo.setOwnerAuthorization({
        directorId: "cosmos",
        authorized: true,
        actor: OWNER,
        correlationId: randomUUID(),
      });
      await repo.transition({
        directorId: "cosmos",
        to: "CONFIGURED",
        reason: "Configured",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      await repo.transition({
        directorId: "cosmos",
        to: "READY",
        reason: "Ready",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      await repo.transition({
        directorId: "cosmos",
        to: "ACTIVE",
        reason: "Active",
        actor: OWNER,
        correlationId: randomUUID(),
      });

      const jarvisProject = await repo.createProject({
        directorId: "jarvis",
        projectKey: "jarvis-ep-001",
        universeId: "jarvis-universe",
        title: "Episode 001",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const cosmosProject = await repo.createProject({
        directorId: "cosmos",
        projectKey: "cosmos-ep-001",
        universeId: "cosmos-universe",
        title: "Cosmos Episode 001",
        actor: OWNER,
        correlationId: randomUUID(),
      });

      // -------------------------------------------------------------- G, H, I
      assert.equal(await repo.getProject({ directorId: "jarvis", projectId: cosmosProject.projectId }), null);
      const jarvisProjects = await repo.listProjects("jarvis");
      assert.deepEqual(jarvisProjects.map((project) => project.projectId), [jarvisProject.projectId]);

      const cosmosTask = await repo.createTask({
        directorId: "cosmos",
        projectId: cosmosProject.projectId,
        stage: "RESEARCH",
        idempotencyKey: `cosmos-research-${Date.now()}`,
        correlationId: randomUUID(),
      });
      assert.equal(await repo.getTask({ directorId: "jarvis", taskId: cosmosTask.task.taskId }), null);
      await assert.rejects(
        () =>
          repo.cancelTask({
            directorId: "jarvis",
            taskId: cosmosTask.task.taskId,
            actor: OWNER,
            correlationId: randomUUID(),
            reason: "Cross-director cancellation attempt",
          }),
        (error) => error.code === "TASK_NOT_FOUND"
      );
      await assert.rejects(
        () =>
          repo.completeTask({
            directorId: "jarvis",
            taskId: cosmosTask.task.taskId,
            workerKey: "worker-x",
            fencingToken: 1,
            resultRef: "cross-director",
            evidence: [],
          }),
        (error) => error.code === "TASK_NOT_FOUND"
      );
      // Evidence reads are Director-scoped, and the credential surface is never
      // shared: each Director sees only its own opaque vault locator.
      assert.deepEqual(
        await repo.listEvidence({ directorId: "jarvis", taskId: cosmosTask.task.taskId }),
        []
      );
      const jarvisRecord = await repo.getDirector("jarvis");
      const cosmosRecord = await repo.getDirector("cosmos");
      assert.deepEqual(jarvisRecord.providerConfig, ["vault://stph/jarvis/primary"]);
      assert.deepEqual(cosmosRecord.providerConfig, ["vault://stph/cosmos/primary"]);

      // ------------------------------------------------------------------ J
      const researchKey = `jarvis-research-${Date.now()}`;
      const researchFirst = await repo.createTask({
        directorId: "jarvis",
        projectId: jarvisProject.projectId,
        stage: "RESEARCH",
        idempotencyKey: researchKey,
        correlationId: randomUUID(),
      });
      const researchAgain = await repo.createTask({
        directorId: "jarvis",
        projectId: jarvisProject.projectId,
        stage: "RESEARCH",
        idempotencyKey: researchKey,
        correlationId: randomUUID(),
      });
      assert.equal(researchAgain.deduplicated, true);
      assert.equal(researchAgain.task.taskId, researchFirst.task.taskId);
      assert.equal(researchFirst.task.status, "CREATED");

      // ------------------------------------------------------------------ K
      const assigned = await repo.assignTask({
        directorId: "jarvis",
        taskId: researchFirst.task.taskId,
        actor: HERMES,
        correlationId: randomUUID(),
        reason: "Fleet scheduling: research first",
      });
      assert.equal(assigned.status, "QUEUED");
      assert.equal(assigned.assignmentReason, "Fleet scheduling: research first");
      const auditAfterAssign = await repo.listAudit("jarvis");
      const assignmentAudit = auditAfterAssign.find((row) => row.action === "DIRECTOR_TASK_ASSIGNED");
      assert.ok(assignmentAudit, "assignment must be audited");
      assert.equal(assignmentAudit.previousState, "CREATED");
      assert.equal(assignmentAudit.newState, "QUEUED");
      assert.equal(assignmentAudit.actorRole, "HERMES");

      // ------------------------------------------------------------ L, AC
      const repoB = new PostgresDirectorFleetRepository(newPool());
      const claims = await Promise.all([
        repo.claimTask({ workerKey: "worker-a", leaseSeconds: 30, directorId: "jarvis" }),
        repoB.claimTask({ workerKey: "worker-b", leaseSeconds: 30, directorId: "jarvis" }),
      ]);
      const winners = claims.filter((claim) => claim?.claimed === true);
      assert.equal(winners.length, 1, "exactly one worker may claim a task");
      const winningClaim = winners[0];
      assert.equal(winningClaim.task.status, "RUNNING");
      assert.equal(winningClaim.fencingToken, 1);
      assert.ok(claims.some((claim) => claim === null), "the loser must receive no task");

      // ------------------------------------------------------------------ M
      await assert.rejects(
        () =>
          repo.completeTask({
            directorId: "jarvis",
            taskId: winningClaim.task.taskId,
            workerKey: winningClaim.workerKey,
            fencingToken: winningClaim.fencingToken + 99,
            resultRef: "stale-attempt",
            evidence: [{ evidenceType: "research_brief", payload: { sources: 0 } }],
          }),
        (error) => error.code === "TASK_FENCING_TOKEN_STALE"
      );

      // ------------------------------------------------------------------ P
      const researchDone = await repo.completeTask({
        directorId: "jarvis",
        taskId: winningClaim.task.taskId,
        workerKey: winningClaim.workerKey,
        fencingToken: winningClaim.fencingToken,
        resultRef: "evidence://research-brief-001",
        evidence: [{ evidenceType: "research_brief", payload: { sources: 1 } }],
      });
      assert.equal(researchDone.status, "COMPLETED");
      const storedEvidence = await repo.listEvidence({
        directorId: "jarvis",
        taskId: winningClaim.task.taskId,
      });
      assert.equal(storedEvidence.length, 1);
      assert.equal(storedEvidence[0].evidenceType, "research_brief");

      // ------------------------------------------------------------------ O
      const assembly = await repo.createTask({
        directorId: "jarvis",
        projectId: jarvisProject.projectId,
        stage: "ASSEMBLY",
        idempotencyKey: `jarvis-assembly-${Date.now()}`,
        correlationId: randomUUID(),
      });
      await assert.rejects(
        () =>
          repo.assignTask({
            directorId: "jarvis",
            taskId: assembly.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Assembly before upstream stages",
          }),
        (error) => error.code === "TASK_DEPENDENCY_UNSATISFIED"
      );
      const scriptTask = await repo.createTask({
        directorId: "jarvis",
        projectId: jarvisProject.projectId,
        stage: "SCRIPT",
        idempotencyKey: `jarvis-script-${Date.now()}`,
        correlationId: randomUUID(),
        dependsOnTaskIds: [researchFirst.task.taskId],
      });
      const scriptAssigned = await repo.assignTask({
        directorId: "jarvis",
        taskId: scriptTask.task.taskId,
        actor: HERMES,
        correlationId: randomUUID(),
        reason: "Script after research evidence",
      });
      assert.equal(scriptAssigned.status, "QUEUED");

      // A SCRIPT task without completed research evidence is refused: create a
      // second project that has no upstream evidence at all.
      const emptyProject = await repo.createProject({
        directorId: "jarvis",
        projectKey: "jarvis-empty",
        universeId: "jarvis-universe",
        title: "Empty pipeline project",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      const orphanScript = await repo.createTask({
        directorId: "jarvis",
        projectId: emptyProject.projectId,
        stage: "SCRIPT",
        idempotencyKey: `jarvis-orphan-script-${Date.now()}`,
        correlationId: randomUUID(),
      });
      await assert.rejects(
        () =>
          repo.assignTask({
            directorId: "jarvis",
            taskId: orphanScript.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Script without research",
          }),
        (error) => error.code === "TASK_DEPENDENCY_UNSATISFIED"
      );

      // ------------------------------------------------------------------ Q
      const cancelParent = await repo.createTask({
        directorId: "jarvis",
        projectId: emptyProject.projectId,
        stage: "RESEARCH",
        idempotencyKey: `jarvis-cancel-parent-${Date.now()}`,
        correlationId: randomUUID(),
      });
      const cancelChild = await repo.createTask({
        directorId: "jarvis",
        projectId: emptyProject.projectId,
        stage: "SCRIPT",
        idempotencyKey: `jarvis-cancel-child-${Date.now()}`,
        correlationId: randomUUID(),
        dependsOnTaskIds: [cancelParent.task.taskId],
      });
      const cancellation = await repo.cancelTask({
        directorId: "jarvis",
        taskId: cancelParent.task.taskId,
        actor: OWNER,
        correlationId: randomUUID(),
        reason: "Owner cancelled the research branch",
      });
      assert.equal(cancellation.task.status, "CANCELLED");
      assert.deepEqual(cancellation.propagatedTaskIds, [cancelChild.task.taskId]);
      const childAfterCancel = await repo.getTask({
        directorId: "jarvis",
        taskId: cancelChild.task.taskId,
      });
      assert.equal(childAfterCancel.status, "BLOCKED");
      assert.equal(childAfterCancel.blockedReason, "TASK_DEPENDENCY_CANCELLED");

      // ------------------------------------------------------------------ N
      const recoverTask = await repo.createTask({
        directorId: "jarvis",
        projectId: jarvisProject.projectId,
        stage: "CHARACTERS",
        idempotencyKey: `jarvis-characters-${Date.now()}`,
        correlationId: randomUUID(),
      });
      // CHARACTERS depends on a COMPLETED SCRIPT with evidence -> refused now.
      await assert.rejects(
        () =>
          repo.assignTask({
            directorId: "jarvis",
            taskId: recoverTask.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Characters before script evidence",
          }),
        (error) => error.code === "TASK_DEPENDENCY_UNSATISFIED"
      );

      // Script must be finished with evidence before characters can run.
      const scriptClaim = await repo.claimTask({ workerKey: "worker-a", directorId: "jarvis" });
      assert.equal(scriptClaim.claimed, true);
      assert.equal(scriptClaim.task.stage, "SCRIPT");
      await repo.completeTask({
        directorId: "jarvis",
        taskId: scriptClaim.task.taskId,
        workerKey: "worker-a",
        fencingToken: scriptClaim.fencingToken,
        resultRef: "evidence://script-001",
        evidence: [{ evidenceType: "script", payload: { scenes: 4 } }],
      });
      const reflectChars = await repo.assignTask({
        directorId: "jarvis",
        taskId: recoverTask.task.taskId,
        actor: HERMES,
        correlationId: randomUUID(),
        reason: "Characters after script evidence",
      });
      assert.equal(reflectChars.status, "QUEUED");

      const leasingClaim = await repo.claimTask({ workerKey: "worker-a", leaseSeconds: 5, directorId: "jarvis" });
      assert.equal(leasingClaim.claimed, true);
      assert.equal(leasingClaim.task.stage, "CHARACTERS");
      await pool.query(
        "UPDATE director_task_leases SET lease_expires_at = clock_timestamp() - interval '5 seconds' WHERE released_at IS NULL"
      );
      const restartedRepo = new PostgresDirectorFleetRepository(newPool());
      const recovered = await restartedRepo.recoverExpiredLeases({ directorId: "jarvis" });
      assert.ok(recovered.some((entry) => entry.taskId === leasingClaim.task.taskId && entry.outcome === "RETRY_SCHEDULED"));
      await assert.rejects(
        () =>
          repo.completeTask({
            directorId: "jarvis",
            taskId: leasingClaim.task.taskId,
            workerKey: "worker-a",
            fencingToken: leasingClaim.fencingToken,
            resultRef: "late-result",
            evidence: [{ evidenceType: "character_sheet", payload: {} }],
          }),
        (error) => error.code === "TASK_NOT_ASSIGNABLE" || error.code === "TASK_LEASE_NOT_ACTIVE"
      );
      const reclaim = await restartedRepo.claimTask({ workerKey: "worker-b", directorId: "jarvis" });
      assert.equal(reclaim.claimed, true);
      assert.ok(reclaim.fencingToken > leasingClaim.fencingToken, "fencing token must advance on re-claim");

      // -------------------------------------------------------------- R, AD
      const attemptsBefore = (
        await pool.query("SELECT attempt_count FROM director_tasks WHERE id = $1", [reclaim.task.taskId])
      ).rows[0].attempt_count;
      const blockedByProvider = await restartedRepo.markProviderBlocked({
        directorId: "jarvis",
        taskId: reclaim.task.taskId,
        providerState: "QUOTA_EXHAUSTED",
        cooldownSeconds: 900,
        detail: "provider quota exhausted (test double, no provider contacted)",
      });
      assert.equal(blockedByProvider.status, "BLOCKED");
      assert.equal(blockedByProvider.providerState, "QUOTA_EXHAUSTED");
      const afterBlockAttempts = (
        await pool.query("SELECT attempt_count, next_run_at > clock_timestamp() AS future FROM director_tasks WHERE id = $1", [
          reclaim.task.taskId,
        ])
      ).rows[0];
      assert.equal(afterBlockAttempts.attempt_count, attemptsBefore, "a blocked provider must not burn attempts");
      assert.equal(afterBlockAttempts.future, true, "a blocked provider must wait for a cooldown window");
      const noHotLoop = await restartedRepo.claimTask({
        workerKey: "worker-b",
        directorId: "jarvis",
      });
      assert.equal(noHotLoop, null, "a quota-blocked task must not be claimed continuously");

      // ------------------------------------------------------------------ S
      const voiceTask = await repo.createTask({
        directorId: "jarvis",
        projectId: jarvisProject.projectId,
        stage: "VOICE",
        idempotencyKey: `jarvis-voice-${Date.now()}`,
        correlationId: randomUUID(),
        maxAttempts: 2,
      });
      await repo.assignTask({
        directorId: "jarvis",
        taskId: voiceTask.task.taskId,
        actor: HERMES,
        correlationId: randomUUID(),
        reason: "Voice after script",
      });
      // The due queue may surface any task, so drive the voice task by id.
      const claimVoice = async () => {
        const claim = await repo.claimTask({ workerKey: "worker-a", directorId: "jarvis" });
        if (claim?.task?.taskId === voiceTask.task.taskId) return claim;
        // Put anything else back into the queue honestly instead of failing it.
        if (claim?.claimed) {
          await repo.failTask({
            directorId: "jarvis",
            taskId: claim.task.taskId,
            workerKey: "worker-a",
            fencingToken: claim.fencingToken,
            error: "TEST_PARKED",
            retryable: true,
          });
          await pool.query(
            "UPDATE director_tasks SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = $1",
            [claim.task.taskId]
          );
        }
        return claim;
      };
      const voiceClaim = await claimVoice();
      assert.ok(voiceClaim?.claimed, "the voice task must be claimable");
      assert.equal(voiceClaim.task.taskId, voiceTask.task.taskId);
      const firstFailure = await repo.failTask({
        directorId: "jarvis",
        taskId: voiceTask.task.taskId,
        workerKey: "worker-a",
        fencingToken: voiceClaim.fencingToken,
        error: "VOICE_PROVIDER_TIMEOUT",
        retryable: true,
      });
      assert.equal(firstFailure.status, "RETRY_SCHEDULED");
      assert.equal(firstFailure.attemptCount, 1);
      await pool.query(
        "UPDATE director_tasks SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [voiceTask.task.taskId]
      );
      const secondClaim = await claimVoice();
      assert.equal(secondClaim.task.taskId, voiceTask.task.taskId);
      const secondFailure = await repo.failTask({
        directorId: "jarvis",
        taskId: voiceTask.task.taskId,
        workerKey: "worker-a",
        fencingToken: secondClaim.fencingToken,
        error: "VOICE_PROVIDER_TIMEOUT",
        retryable: true,
      });
      assert.equal(secondFailure.status, "DEAD_LETTER");
      assert.equal(secondFailure.attemptCount, 2);
      assert.equal(secondFailure.blockedReason, "RETRY_EXHAUSTED");

      // ------------------------------------------------------------------ E
      const pausedAssignment = await repo.createTask({
        directorId: "cosmos",
        projectId: cosmosProject.projectId,
        stage: "RESEARCH",
        idempotencyKey: `cosmos-research-2-${Date.now()}`,
        correlationId: randomUUID(),
      });
      await manager.pauseDirector({
        directorId: "cosmos",
        actor: HERMES,
        correlationId: randomUUID(),
        reason: "Operational pause for maintenance",
      });
      await assert.rejects(
        () =>
          repo.assignTask({
            directorId: "cosmos",
            taskId: pausedAssignment.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Assign while paused",
          }),
        (error) => error.code === "DIRECTOR_NOT_WORK_CAPABLE"
      );
      await manager.suspendDirector({
        directorId: "cosmos",
        actor: HERMES,
        correlationId: randomUUID(),
        reason: "Security suspension",
      });
      await assert.rejects(
        () =>
          repo.assignTask({
            directorId: "cosmos",
            taskId: pausedAssignment.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Assign while suspended",
          }),
        (error) => error.code === "DIRECTOR_NOT_WORK_CAPABLE"
      );
      // A suspended Director cannot be resumed directly.
      await assert.rejects(
        () =>
          manager.resumeDirector({
            directorId: "cosmos",
            actor: OWNER,
            correlationId: randomUUID(),
            reason: "Illegal resume",
          }),
        (error) => error.code === "DIRECTOR_TRANSITION_INVALID"
      );

      // ------------------------------------------------------------------ F
      await repo.registerDirector({ ...completeConfig("retired-one"), actor: OWNER, correlationId: randomUUID() });
      await repo.transition({
        directorId: "retired-one",
        to: "RETIRED",
        reason: "Director retired before activation",
        actor: OWNER,
        correlationId: randomUUID(),
      });
      await assert.rejects(
        () =>
          repo.createProject({
            directorId: "retired-one",
            projectKey: "retired-project",
            universeId: "retired-universe",
            title: "Should not exist",
          }),
        (error) => error.code === "DIRECTOR_NOT_WORK_CAPABLE"
      );
      await assert.rejects(
        () =>
          repo.createTask({
            directorId: "retired-one",
            projectId: jarvisProject.projectId,
            stage: "RESEARCH",
            idempotencyKey: `retired-task-${Date.now()}`,
            correlationId: randomUUID(),
          }),
        (error) => error.code === "DIRECTOR_NOT_WORK_CAPABLE"
      );

      // -------------------------------------------------------------- T, U
      await repo.heartbeatWorker({ workerKey: "worker-a", instanceId: "instance-1" });
      const liveWorkers = await repo.listWorkers();
      assert.equal(liveWorkers.find((worker) => worker.workerKey === "worker-a").expired, false);
      await pool.query(
        "UPDATE director_workers SET last_heartbeat_at = clock_timestamp() - interval '10 minutes' WHERE worker_key = 'worker-a'"
      );
      const staleWorkers = await repo.listWorkers();
      assert.equal(staleWorkers.find((worker) => worker.workerKey === "worker-a").expired, true);
      const expiredWorkers = await repo.expireWorkers();
      assert.ok(expiredWorkers.some((worker) => worker.workerKey === "worker-a"));

      // A live registered runtime exists now (worker-a is genuinely dead).
      await repo.heartbeatWorker({ workerKey: "worker-live", instanceId: "instance-2" });

      const snapshot = await repo.fleetSnapshot();
      const sqlCounts = (
        await pool.query("SELECT lifecycle_state, count(*)::int AS count FROM director_fleet GROUP BY lifecycle_state")
      ).rows;
      const sqlActive = Number(sqlCounts.find((row) => row.lifecycle_state === "ACTIVE")?.count ?? 0);
      const sqlBlockedTasks = Number(
        (await pool.query("SELECT count(*)::int AS count FROM director_tasks WHERE status = 'BLOCKED'")).rows[0].count
      );
      assert.equal(snapshot.counts.active, sqlActive);
      assert.equal(
        snapshot.directors.reduce((sum, row) => sum + row.blockedTasks, 0),
        sqlBlockedTasks
      );
      const jarvisRow = snapshot.directors.find((row) => row.directorId === "jarvis");
      assert.ok(jarvisRow);
      assert.equal(jarvisRow.healthState, "BLOCKED");
      assert.equal(jarvisRow.escalationCode, "DIRECTOR_PROVIDER_BLOCKED");
      assert.equal(
        snapshot.directors.find((row) => row.directorId === "retired-one").healthState,
        "SUSPENDED"
      );
      assert.equal(snapshot.workers.expired >= 1, true);

      // ------------------------------------------------------------------ V
      const notified = [];
      const healthService = new FleetHealthService({
        repository: repo,
        notifier: {
          dispatch: async (spec) => {
            notified.push(spec);
            return { event: { id: randomUUID() } };
          },
        },
        ownerId,
      });
      const firstScan = await healthService.scan();
      assert.ok(firstScan.escalations.length >= 1);
      const jarvisEscalation = firstScan.escalations.find((row) => row.directorId === "jarvis");
      assert.ok(jarvisEscalation);
      assert.ok(jarvisEscalation.notificationEventId, "a durable notification must be recorded");
      assert.ok(notified.length >= 1);
      assert.ok(notified.every((spec) => spec.ownerId === ownerId));
      const secondScan = await healthService.scan();
      const secondJarvis = secondScan.escalations.find((row) => row.directorId === "jarvis");
      assert.equal(secondJarvis.escalationId, jarvisEscalation.escalationId, "escalations must dedupe per day");
      const escalationRows = await pool.query(
        "SELECT count(*)::int AS count FROM director_fleet_escalations WHERE director_id = 'jarvis' AND code = $1",
        [jarvisEscalation.code]
      );
      assert.equal(Number(escalationRows.rows[0].count), 1);

      // ----------------------------------------------------------- W, X, Y
      const publishingTask = await repo.createTask({
        directorId: "jarvis",
        projectId: jarvisProject.projectId,
        stage: "PUBLISHING",
        taskType: "production",
        idempotencyKey: `jarvis-publish-${Date.now()}`,
        correlationId: randomUUID(),
      });
      await assert.rejects(
        () =>
          manager.assignTask({
            directorId: "jarvis",
            taskId: publishingTask.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Publish without owner approval",
          }),
        (error) => error.code === "DIRECTOR_NOT_AUTHORIZED" && error.status === 403
      );
      const expiredApproval = {
        ownerId,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        artifactHash: HASH,
        destination: "youtube:jarvis",
      };
      await assert.rejects(
        () =>
          manager.assignTask({
            directorId: "jarvis",
            taskId: publishingTask.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Publish with an expired approval",
            ownerApproval: expiredApproval,
          }),
        (error) => error.code === "DIRECTOR_NOT_AUTHORIZED"
      );
      const rejectedApproval = {
        ownerId,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        artifactHash: HASH,
        destination: "youtube:jarvis",
        decision: "REJECTED",
      };
      await assert.rejects(
        () =>
          manager.assignTask({
            directorId: "jarvis",
            taskId: publishingTask.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Publish despite an owner rejection",
            ownerApproval: rejectedApproval,
          }),
        (error) => error.code === "DIRECTOR_NOT_AUTHORIZED" && /rejection/i.test(error.message)
      );
      const unboundApproval = {
        ownerId,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      await assert.rejects(
        () =>
          manager.assignTask({
            directorId: "jarvis",
            taskId: publishingTask.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Publish with an unbound approval",
            ownerApproval: unboundApproval,
          }),
        (error) => error.code === "DIRECTOR_NOT_AUTHORIZED"
      );
      const boundApproval = {
        ownerId,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        artifactHash: HASH,
        destination: "youtube:jarvis",
      };
      // The approval boundary passes, and the durable dependency rule still
      // refuses execution: publishing is never granted by an approval alone.
      await assert.rejects(
        () =>
          manager.assignTask({
            directorId: "jarvis",
            taskId: publishingTask.task.taskId,
            actor: HERMES,
            correlationId: randomUUID(),
            reason: "Publish with a bound approval",
            ownerApproval: boundApproval,
          }),
        (error) => error.code === "TASK_DEPENDENCY_UNSATISFIED"
      );

      // -------------------------------------------------------------- AA
      await assert.rejects(
        () => pool.query("UPDATE director_fleet_audit SET reason = 'tampered' WHERE director_id = 'jarvis'"),
        (error) => /APPEND_ONLY_VIOLATION/.test(error.message)
      );
      const cosmosAudit = await repo.listAudit("cosmos");
      assert.ok(cosmosAudit.length >= 1);
      assert.ok(cosmosAudit.every((row) => row.directorId === "cosmos"));
      assert.ok(!cosmosAudit.some((row) => row.directorId === "jarvis"));

      // -------------------------------------------------------------- AE
      // No secret material anywhere in the persisted pages the Owner can read.
      const serialized = JSON.stringify([
        await repo.getDirector("jarvis"),
        await repo.listAudit("jarvis"),
        await repo.fleetSnapshot(),
        await repo.listEscalations({}),
        notified,
      ]);
      assert.ok(!/(?:sk-|Bearer\s|api[_-]?key\s*[:=]|client_secret)/i.test(serialized));
      assert.ok(serialized.includes("vault://stph/jarvis/primary"));

      // --------------------------------------------------------------- Z
      const report = await collectForgeDailyReport({
        pool,
        reportDate: new Date().toISOString().slice(0, 10),
        timeZone: "Asia/Kolkata",
      });
      assert.equal(verifyReportEvidenceHash(report), true, "report evidence hash must verify");
      const fleetSection = report.sections.directorFleet;
      assert.ok(fleetSection, "the report must contain a Director fleet section");
      assert.equal(fleetSection.directorFleetOverview.active.value, sqlActive);
      assert.equal(fleetSection.directorFleetOverview.retired.value, 1);
      const completedStages = Number(
        (await pool.query("SELECT count(*)::int AS count FROM director_tasks WHERE status = 'COMPLETED'")).rows[0].count
      );
      assert.equal(fleetSection.universeProductionOverview.completedStages.value, completedStages);
      assert.equal(fleetSection.universeProductionOverview.verifiedMediaArtifacts.value, 0);
      assert.equal(fleetSection.universeProductionOverview.confirmedPublishingActivity.verification, "NOT_RUN");
      assert.equal(fleetSection.hermesManagementOverview.assignmentsMade.value >= 1, true);
      assert.ok(report.evidenceRefs.some((ref) => ref.table === "director_fleet"));
      assert.ok(!/(?:sk-|Bearer\s|api[_-]?key\s*[:=])/i.test(JSON.stringify(report)));

      // -------------------------------------------------------------- AB
      const buildApp = ({ sessionOwner = null, csrf = true } = {}) => {
        const app = express();
        app.use((req, res, next) => {
          if (sessionOwner) req.forgeSession = { id: sessionOwner, role: "owner", authenticated: true };
          req.forgeCsrfVerified = csrf;
          next();
        });
        app.use(
          "/api/fleet",
          createFleetRouter({
            repository: repo,
            manager,
            healthService,
            verifyCsrf: (req) => req.forgeCsrfVerified === true,
            getOwnerId: (req) => req.forgeSession?.id ?? null,
            logger: quiet,
          })
        );
        return app;
      };

      const ownerApp = supertest(buildApp({ sessionOwner: ownerId }));
      const noSession = supertest(buildApp({ sessionOwner: null }));
      const noCsrf = supertest(buildApp({ sessionOwner: ownerId, csrf: false }));

      assert.equal((await noSession.get("/api/fleet/directors")).status, 401);
      assert.equal(
        (await noCsrf.post("/api/fleet/directors").send({ directorId: "csrf-blocked", displayName: "Nope" })).status,
        403
      );

      const list = await ownerApp.get("/api/fleet/directors");
      assert.equal(list.status, 200);
      assert.ok(list.body.directors.some((row) => row.directorId === "jarvis"));

      const registered = await ownerApp.post("/api/fleet/directors").send({
        directorId: "http-director",
        displayName: "HTTP Director",
        universeName: "HTTP Universe",
        niche: "api tests",
      });
      assert.equal(registered.status, 201);
      assert.equal(registered.body.director.lifecycleState, "DRAFT");

      assert.equal((await ownerApp.get("/api/fleet/directors/does-not-exist")).status, 404);
      const detail = await ownerApp.get("/api/fleet/directors/jarvis");
      assert.equal(detail.status, 200);
      assert.equal(detail.body.director.lifecycleState, "ACTIVE");
      assert.equal(detail.body.readiness.ready, true);

      const readiness = await ownerApp.get("/api/fleet/directors/http-director/readiness");
      assert.equal(readiness.status, 200);
      assert.equal(readiness.body.ready, false);

      const prematureActivation = await ownerApp
        .post("/api/fleet/directors/http-director/activate")
        .send({ reason: "Activate before configuration" });
      assert.equal(prematureActivation.status, 409);
      // A DRAFT Director cannot jump straight to ACTIVE; readiness is enforced
      // again on the READY -> ACTIVE edge.
      assert.equal(prematureActivation.body.code, "DIRECTOR_TRANSITION_INVALID");

      const crossProject = await ownerApp.post("/api/fleet/directors/jarvis/tasks").send({
        projectId: cosmosProject.projectId,
        stage: "RESEARCH",
        idempotencyKey: `http-cross-project-${Date.now()}`,
      });
      assert.equal(crossProject.status, 404);
      assert.equal(crossProject.body.code, "PROJECT_NOT_FOUND");

      const health = await ownerApp.get("/api/fleet/health");
      assert.equal(health.status, 200);
      assert.equal(typeof health.body.counts.active, "number");

      const scanResponse = await ownerApp.post("/api/fleet/health/scan").send({});
      assert.equal(scanResponse.status, 200);
      assert.ok(Array.isArray(scanResponse.body.escalations));

      const workers = await ownerApp.get("/api/fleet/workers");
      assert.equal(workers.status, 200);

      const javascriptAudit = await ownerApp.get("/api/fleet/directors/jarvis/audit");
      assert.equal(javascriptAudit.status, 200);
      assert.ok(javascriptAudit.body.audit.length >= 1);

      // --------------------------------------------------------------- B
      const occupied = Number(
        (
          await pool.query("SELECT count(*)::int AS count FROM director_fleet WHERE lifecycle_state <> 'RETIRED'")
        ).rows[0].count
      );
      for (let index = occupied; index < 50; index += 1) {
        await repo.registerDirector({
          directorId: `capacity-${String(index).padStart(2, "0")}`,
          displayName: `Capacity Director ${index}`,
          actor: OWNER,
          correlationId: randomUUID(),
        });
      }
      const full = Number(
        (
          await pool.query("SELECT count(*)::int AS count FROM director_fleet WHERE lifecycle_state <> 'RETIRED'")
        ).rows[0].count
      );
      assert.equal(full, 50, "the fleet must be able to hold 50 Directors");
      await assert.rejects(
        () =>
          repo.registerDirector({
            directorId: "capacity-overflow",
            displayName: "Overflow Director",
            actor: OWNER,
            correlationId: randomUUID(),
          }),
        (error) => error.code === "DIRECTOR_FLEET_CAPACITY_REACHED"
      );
      // The database enforces the same invariant even if the repository is
      // bypassed entirely.
      await assert.rejects(
        () =>
          pool.query(
            "INSERT INTO director_fleet (director_id, display_name, lifecycle_state) VALUES ('db-bypass', 'DB Bypass', 'DRAFT')"
          ),
        (error) => /DIRECTOR_FLEET_CAPACITY_REACHED/.test(error.message)
      );
    } finally {
      for (const instance of extraPools) await instance.end().catch(() => {});
      await pool.end().catch(() => {});
      await dropDisposableDatabase(POSTGRES_URL, created.databaseName).catch(() => {});
    }
  }
);
