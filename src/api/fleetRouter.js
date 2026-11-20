/**
 * ST Production House — Owner Director Fleet API (Day 5 / D7).
 *
 * Mounted behind the same authenticated Owner session, Owner-role gate and CSRF
 * guard as every other Owner route (`src/catalog/server.js`), and it fails
 * closed with 503 when durable PostgreSQL is not configured.
 *
 * The router never trusts a client-supplied identity: the Owner id and the actor
 * role come from the authenticated session. Director ids, task ids and every
 * other identifier in a URL are re-validated server-side.
 *
 * Routes (all JSON):
 *   GET    /directors                              fleet list + live health
 *   POST   /directors                              register (DRAFT/CONFIGURED only)
 *   GET    /directors/:directorId                  detail (director, readiness, audit)
 *   GET    /directors/:directorId/readiness        readiness evaluation
 *   GET    /directors/:directorId/audit            append-only decision history
 *   PATCH  /directors/:directorId/configuration    persisted configuration patch
 *   POST   /directors/:directorId/authorization    Owner activation authorization
 *   POST   /directors/:directorId/activate         lifecycle: ACTIVE   (Owner only)
 *   POST   /directors/:directorId/pause            lifecycle: PAUSED
 *   POST   /directors/:directorId/resume           lifecycle: ACTIVE   (Owner only)
 *   POST   /directors/:directorId/suspend          lifecycle: SUSPENDED
 *   POST   /directors/:directorId/retirement       RETIRING or RETIRED (Owner only)
 *   GET    /directors/:directorId/projects         Director-scoped projects
 *   POST   /directors/:directorId/projects         create a project
 *   GET    /directors/:directorId/projects/overview stage progress + evidence
 *   GET    /directors/:directorId/tasks            Director-scoped tasks
 *   POST   /directors/:directorId/tasks            idempotent task creation
 *   POST   /directors/:directorId/tasks/:taskId/assign     HERMES assignment
 *   POST   /directors/:directorId/tasks/:taskId/cancel     cancellation
 *   POST   /directors/:directorId/tasks/:taskId/provider-block  honest block
 *   GET    /directors/:directorId/tasks/:taskId/evidence   stage evidence
 *   GET    /directors/:directorId/workload         task counts by status
 *   GET    /health                                 fleet snapshot from records
 *   POST   /health/scan                            escalate + notify
 *   GET    /escalations                            durable escalations
 *   GET    /workers                                registered runtimes
 *   POST   /workers/heartbeat                      runtime heartbeat
 *   POST   /tasks/claim                            atomic claim (fenced lease)
 *   POST   /tasks/recover                          expire leases / requeue
 *   POST   /tasks/:taskId/complete                 evidence-gated completion
 *   POST   /tasks/:taskId/fail                     bounded retry / dead letter
 *   GET    /workers/registry                       runtime registry + capabilities
 *   POST   /workers/register                       durable runtime registration
 *   POST   /workers/:workerKey/heartbeat           instance-checked heartbeat
 *   GET    /workers/:workerKey/history             append-only worker audit
 *   POST   /workers/:workerKey/drain               Owner drain control
 *   POST   /workers/:workerKey/restart             Owner restart request
 *   GET    /workers/metrics                        execution metrics from SQL
 *   GET    /tasks/dead-letters                     dead-letter inspection
 *   GET    /tasks/:taskId/checkpoints              durable checkpoints
 *   GET    /directors/:directorId/tasks/:taskId/execution  evidence + checkpoints + worker
 *
 * Nothing here publishes, spends money or contacts a provider.
 */

import { randomUUID } from "node:crypto";

import express from "express";

function fail(res, code, message, status = 400) {
  return res.status(status).json({ code, message: message ?? code });
}

function publicError(error) {
  const status = Number(error?.status) || 500;
  return {
    code: error?.code ?? "FLEET_REQUEST_FAILED",
    message: status < 500 ? error.message : "The fleet request could not be processed.",
    detail: status < 500 ? (error?.detail ?? null) : null,
    status,
  };
}

export function createFleetRouter({
  repository,
  manager,
  healthService = null,
  workerRepository = null,
  workerRuntimeProvider = () => null,
  getOwnerId = (req) => req?.forgeSession?.id ?? null,
  verifyCsrf = () => false,
  logger = console,
  instanceId = `fleet-http-${process.pid}`,
} = {}) {
  if (!repository) throw new Error("FLEET_REPOSITORY_REQUIRED");
  if (!manager) throw new Error("FLEET_MANAGER_REQUIRED");
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  const guard = (handler) => async (req, res) => {
    try {
      const ownerId = getOwnerId(req);
      if (!ownerId) return fail(res, "UNAUTHORIZED", "Authenticated Owner session required.", 401);
      const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
      if (mutation && verifyCsrf(req) !== true) {
        return fail(res, "CSRF_REJECTED", "A valid CSRF token is required for mutations.", 403);
      }
      return await handler(req, res, ownerId);
    } catch (error) {
      const shaped = publicError(error);
      if (shaped.status >= 500) {
        logger.error?.(
          JSON.stringify({ level: "error", code: shaped.code, message: String(error?.message ?? "").slice(0, 200) })
        );
      }
      return fail(res, shaped.code, shaped.message, shaped.status);
    }
  };

  const actorOf = (ownerId) => ({ id: ownerId, role: "OWNER" });
  const correlationOf = (req) => {
    const header = req.get?.("x-correlation-id") ?? req.headers?.["x-correlation-id"];
    if (typeof header === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(header)) {
      return header;
    }
    return req.body?.correlationId ?? randomUUID();
  };

  // ------------------------------------------------------------- fleet list
  router.get(
    "/directors",
    guard(async (req, res) => {
      const snapshot = await repository.fleetSnapshot();
      return res.status(200).json({
        generatedAt: snapshot.generatedAt,
        capacity: snapshot.capacity,
        counts: snapshot.counts,
        workers: { total: snapshot.workers.total, live: snapshot.workers.live, expired: snapshot.workers.expired },
        directors: snapshot.directors,
      });
    })
  );

  router.post(
    "/directors",
    guard(async (req, res, ownerId) => {
      const body = req.body ?? {};
      const director = await repository.registerDirector({
        directorId: body.directorId,
        displayName: body.displayName,
        universeName: body.universeName ?? null,
        niche: body.niche ?? null,
        genres: body.genres ?? [],
        contentFormats: body.contentFormats ?? [],
        languages: body.languages ?? [],
        targetAudience: body.targetAudience ?? null,
        creativeDirection: body.creativeDirection ?? null,
        underlyingAgentId: body.underlyingAgentId ?? null,
        teamConfig: body.teamConfig ?? {},
        productionConfig: body.productionConfig ?? {},
        providerConfig: body.providerConfig ?? {},
        platformConnections: body.platformConnections ?? {},
        lifecycleState: body.lifecycleState ?? "DRAFT",
        actor: actorOf(ownerId),
        correlationId: correlationOf(req),
        reason: body.reason ?? "Director registered",
      });
      return res.status(201).json({ director });
    })
  );

  router.get(
    "/directors/:directorId",
    guard(async (req, res) => {
      const detail = await manager.inspectDirector({ directorId: req.params.directorId });
      return res.status(200).json(detail);
    })
  );

  router.get(
    "/directors/:directorId/readiness",
    guard(async (req, res) => {
      return res.status(200).json(await manager.readiness({ directorId: req.params.directorId }));
    })
  );

  router.get(
    "/directors/:directorId/audit",
    guard(async (req, res) => {
      const audit = await repository.listAudit(req.params.directorId, { limit: req.query.limit });
      return res.status(200).json({ count: audit.length, audit });
    })
  );

  router.patch(
    "/directors/:directorId/configuration",
    guard(async (req, res, ownerId) => {
      const director = await repository.updateConfiguration({
        directorId: req.params.directorId,
        patch: req.body ?? {},
        actor: actorOf(ownerId),
        correlationId: correlationOf(req),
        reason: req.body?.reason ?? "Director configuration updated",
      });
      return res.status(200).json({ director });
    })
  );

  router.post(
    "/directors/:directorId/authorization",
    guard(async (req, res, ownerId) => {
      const director = await repository.setOwnerAuthorization({
        directorId: req.params.directorId,
        authorized: req.body?.authorized === true,
        actor: actorOf(ownerId),
        correlationId: correlationOf(req),
        reason: req.body?.reason ?? null,
      });
      return res.status(200).json({ director });
    })
  );

  for (const [path, method] of [
    ["activate", "activateDirector"],
    ["pause", "pauseDirector"],
    ["resume", "resumeDirector"],
    ["suspend", "suspendDirector"],
  ]) {
    router.post(
      `/directors/:directorId/${path}`,
      guard(async (req, res, ownerId) => {
        const result = await manager[method]({
          directorId: req.params.directorId,
          actor: actorOf(ownerId),
          correlationId: correlationOf(req),
          reason: req.body?.reason ?? `${path} requested through the Owner console`,
        });
        return res.status(200).json(result);
      })
    );
  }

  router.post(
    "/directors/:directorId/retirement",
    guard(async (req, res, ownerId) => {
      const complete = req.body?.complete === true;
      const result = complete
        ? await manager.retireDirector({
            directorId: req.params.directorId,
            actor: actorOf(ownerId),
            correlationId: correlationOf(req),
            reason: req.body?.reason ?? "Retirement completed",
          })
        : await manager.requestRetirement({
            directorId: req.params.directorId,
            actor: actorOf(ownerId),
            correlationId: correlationOf(req),
            reason: req.body?.reason ?? "Retirement requested",
          });
      return res.status(200).json(result);
    })
  );

  router.get(
    "/directors/:directorId/projects",
    guard(async (req, res) => {
      const projects = await repository.listProjects(req.params.directorId);
      return res.status(200).json({ count: projects.length, projects });
    })
  );

  router.post(
    "/directors/:directorId/projects",
    guard(async (req, res, ownerId) => {
      const project = await repository.createProject({
        directorId: req.params.directorId,
        projectKey: req.body?.projectKey,
        universeId: req.body?.universeId,
        title: req.body?.title,
        actor: actorOf(ownerId),
        correlationId: correlationOf(req),
      });
      return res.status(201).json({ project });
    })
  );

  router.get(
    "/directors/:directorId/projects/overview",
    guard(async (req, res) => {
      const overview = await repository.projectOverview({ directorId: req.params.directorId });
      return res.status(200).json({ count: overview.length, projects: overview });
    })
  );

  router.get(
    "/directors/:directorId/tasks",
    guard(async (req, res) => {
      const tasks = await repository.listTasks({
        directorId: req.params.directorId,
        status: typeof req.query.status === "string" ? req.query.status : null,
        stage: typeof req.query.stage === "string" ? req.query.stage : null,
      });
      return res.status(200).json({ count: tasks.length, tasks });
    })
  );

  router.post(
    "/directors/:directorId/tasks",
    guard(async (req, res) => {
      const body = req.body ?? {};
      const result = await repository.createTask({
        directorId: req.params.directorId,
        projectId: body.projectId,
        stage: body.stage,
        taskType: body.taskType,
        priority: body.priority,
        idempotencyKey: body.idempotencyKey,
        correlationId: correlationOf(req),
        dependsOnTaskIds: Array.isArray(body.dependsOnTaskIds) ? body.dependsOnTaskIds : [],
        dueAt: body.dueAt ?? null,
        maxAttempts: body.maxAttempts,
        providerRequirement: body.providerRequirement ?? null,
        assignmentReason: body.assignmentReason ?? null,
        input: body.input ?? {},
      });
      return res.status(result.deduplicated ? 200 : 201).json(result);
    })
  );

  router.post(
    "/directors/:directorId/tasks/:taskId/assign",
    guard(async (req, res, ownerId) => {
      const result = await manager.assignTask({
        directorId: req.params.directorId,
        taskId: req.params.taskId,
        actor: actorOf(ownerId),
        correlationId: correlationOf(req),
        reason: req.body?.reason ?? "HERMES fleet scheduling",
        ownerApproval: req.body?.ownerApproval ?? null,
      });
      return res.status(200).json(result);
    })
  );

  router.post(
    "/directors/:directorId/tasks/:taskId/cancel",
    guard(async (req, res, ownerId) => {
      const result = await manager.cancelTask({
        directorId: req.params.directorId,
        taskId: req.params.taskId,
        actor: actorOf(ownerId),
        correlationId: correlationOf(req),
        reason: req.body?.reason ?? "Cancelled through the Owner console",
      });
      return res.status(200).json(result);
    })
  );

  router.post(
    "/directors/:directorId/tasks/:taskId/provider-block",
    guard(async (req, res) => {
      const task = await repository.markProviderBlocked({
        directorId: req.params.directorId,
        taskId: req.params.taskId,
        providerState: req.body?.providerState ?? "QUOTA_EXHAUSTED",
        cooldownSeconds: req.body?.cooldownSeconds,
        detail: req.body?.detail ?? null,
      });
      return res.status(200).json({ task });
    })
  );

  router.get(
    "/directors/:directorId/tasks/:taskId/evidence",
    guard(async (req, res) => {
      const evidence = await repository.listEvidence({
        directorId: req.params.directorId,
        taskId: req.params.taskId,
      });
      return res.status(200).json({ count: evidence.length, evidence });
    })
  );

  router.get(
    "/directors/:directorId/workload",
    guard(async (req, res) => {
      return res.status(200).json(await manager.workload({ directorId: req.params.directorId }));
    })
  );

  // ------------------------------------------------------------ worker runtime
  // A registered runtime may only claim within its stage types, capabilities and
  // Director scope. These routes require the same Owner session + CSRF as every
  // other fleet mutation; a browser is never accepted as a worker heartbeat.
  const requireWorkerRepository = (res) => {
    if (workerRepository) return true;
    fail(res, "WORKER_RUNTIME_UNAVAILABLE", "The durable worker registry is not configured.", 503);
    return false;
  };

  router.get(
    "/workers/registry",
    guard(async (req, res) => {
      if (!requireWorkerRepository(res)) return undefined;
      const workers = await workerRepository.listWorkers();
      return res.status(200).json({
        count: workers.length,
        workers,
        runtime: workerRuntimeProvider?.()?.status?.() ?? null,
      });
    })
  );

  router.get(
    "/workers/metrics",
    guard(async (req, res) => {
      if (!requireWorkerRepository(res)) return undefined;
      return res.status(200).json(await workerRepository.metrics());
    })
  );

  router.post(
    "/workers/register",
    guard(async (req, res) => {
      if (!requireWorkerRepository(res)) return undefined;
      const body = req.body ?? {};
      const registration = await workerRepository.registerWorker({
        workerKey: body.workerKey,
        workerType: body.workerType ?? "production_worker",
        instanceId: body.instanceId ?? instanceId,
        runtimeInstanceId: body.runtimeInstanceId ?? null,
        role: body.role ?? "production",
        stageTypes: Array.isArray(body.stageTypes) ? body.stageTypes : [],
        capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
        directorScope: Array.isArray(body.directorScope) ? body.directorScope : [],
        configVersion: body.configVersion ?? 1,
        metadata: body.metadata ?? {},
        actor: { id: "forge-runtime", role: "FORGE" },
        correlationId: correlationOf(req),
      });
      return res.status(registration.registered ? 201 : 200).json(registration);
    })
  );

  router.post(
    "/workers/:workerKey/heartbeat",
    guard(async (req, res) => {
      if (!requireWorkerRepository(res)) return undefined;
      const beat = await workerRepository.heartbeat({
        workerKey: req.params.workerKey,
        instanceId: req.body?.instanceId ?? instanceId,
        state: req.body?.state ?? null,
        metadata: req.body?.metadata ?? null,
      });
      return res.status(200).json({ worker: beat });
    })
  );

  router.get(
    "/workers/:workerKey/history",
    guard(async (req, res) => {
      if (!requireWorkerRepository(res)) return undefined;
      const history = await workerRepository.workerHistory({
        workerKey: req.params.workerKey,
        limit: req.query.limit,
      });
      return res.status(200).json({ count: history.length, history });
    })
  );

  router.post(
    "/workers/:workerKey/drain",
    guard(async (req, res, ownerId) => {
      if (!requireWorkerRepository(res)) return undefined;
      const result = await workerRepository.drain({
        workerKey: req.params.workerKey,
        reason: req.body?.reason ?? "Owner requested drain through the console",
        actor: actorOf(ownerId),
        correlationId: correlationOf(req),
      });
      return res.status(200).json(result);
    })
  );

  router.post(
    "/workers/:workerKey/restart",
    guard(async (req, res, ownerId) => {
      if (!requireWorkerRepository(res)) return undefined;
      const result = await workerRepository.requestRestart({
        workerKey: req.params.workerKey,
        reason: req.body?.reason ?? "Owner requested restart through the console",
        actor: actorOf(ownerId),
        correlationId: correlationOf(req),
      });
      return res.status(200).json(result);
    })
  );

  router.get(
    "/tasks/dead-letters",
    guard(async (req, res) => {
      if (!requireWorkerRepository(res)) return undefined;
      const tasks = await workerRepository.listDeadLetters({
        directorId: typeof req.query.directorId === "string" ? req.query.directorId : null,
        limit: req.query.limit,
      });
      return res.status(200).json({ count: tasks.length, tasks });
    })
  );

  router.get(
    "/tasks/:taskId/checkpoints",
    guard(async (req, res) => {
      if (!requireWorkerRepository(res)) return undefined;
      const checkpoints = await workerRepository.listCheckpoints(req.params.taskId);
      return res.status(200).json({ count: checkpoints.length, checkpoints });
    })
  );

  router.get(
    "/directors/:directorId/tasks/:taskId/execution",
    guard(async (req, res) => {
      const task = await repository.getTask({
        directorId: req.params.directorId,
        taskId: req.params.taskId,
      });
      if (!task) return fail(res, "TASK_NOT_FOUND", "Task not found for this Director.", 404);
      const evidence = await repository.listEvidence({
        directorId: req.params.directorId,
        taskId: req.params.taskId,
      });
      const checkpoints = workerRepository ? await workerRepository.listCheckpoints(req.params.taskId) : [];
      return res.status(200).json({ task, evidence, checkpoints });
    })
  );

  // ------------------------------------------------------------ fleet health
  router.get(
    "/health",
    guard(async (req, res) => {
      const snapshot = await repository.fleetSnapshot();
      return res.status(200).json(snapshot);
    })
  );

  router.post(
    "/health/scan",
    guard(async (req, res, ownerId) => {
      if (!healthService) {
        return fail(res, "FLEET_HEALTH_UNAVAILABLE", "Fleet health scanning is not configured.", 503);
      }
      const result = await healthService.scan({ ownerId });
      return res.status(200).json({
        generatedAt: result.generatedAt,
        counts: result.snapshot.counts,
        expiredWorkers: result.expiredWorkers,
        escalations: result.escalations,
        ownerScoped: Boolean(ownerId),
      });
    })
  );

  router.get(
    "/escalations",
    guard(async (req, res) => {
      const escalations = await repository.listEscalations({
        directorId: typeof req.query.directorId === "string" ? req.query.directorId : null,
        limit: req.query.limit,
      });
      return res.status(200).json({ count: escalations.length, escalations });
    })
  );

  // ----------------------------------------------------------------- workers
  router.get(
    "/workers",
    guard(async (req, res) => {
      const workers = await repository.listWorkers();
      return res.status(200).json({ count: workers.length, workers });
    })
  );

  router.post(
    "/workers/heartbeat",
    guard(async (req, res) => {
      const worker = await repository.heartbeatWorker({
        workerKey: req.body?.workerKey,
        instanceId: req.body?.instanceId ?? instanceId,
        role: req.body?.role ?? "production",
        metadata: req.body?.metadata ?? {},
      });
      return res.status(200).json({ worker });
    })
  );

  router.post(
    "/tasks/claim",
    guard(async (req, res) => {
      // Claims go through the worker registry when it exists: worker state,
      // capability and Director scope are enforced here, and the atomic claim
      // itself remains the fenced Day 5 operation.
      const claim = workerRepository
        ? await workerRepository.claimTask({
            workerKey: req.body?.workerKey,
            leaseSeconds: req.body?.leaseSeconds,
            directorId: req.body?.directorId ?? null,
            maxPerDirector: req.body?.maxPerDirector ?? null,
          })
        : await repository.claimTask({
            workerKey: req.body?.workerKey,
            leaseSeconds: req.body?.leaseSeconds,
            directorId: req.body?.directorId ?? null,
          });
      if (!claim) return res.status(204).end();
      return res.status(claim.claimed ? 200 : 409).json(claim);
    })
  );

  router.post(
    "/tasks/recover",
    guard(async (req, res) => {
      const recovered = await repository.recoverExpiredLeases({
        directorId: req.body?.directorId ?? null,
      });
      return res.status(200).json({ count: recovered.length, recovered });
    })
  );

  router.post(
    "/tasks/:taskId/complete",
    guard(async (req, res) => {
      const body = req.body ?? {};
      const task = await repository.completeTask({
        directorId: body.directorId,
        taskId: req.params.taskId,
        workerKey: body.workerKey,
        fencingToken: body.fencingToken,
        resultRef: body.resultRef,
        evidence: body.evidence ?? [],
        correlationId: correlationOf(req),
      });
      return res.status(200).json({ task });
    })
  );

  router.post(
    "/tasks/:taskId/fail",
    guard(async (req, res) => {
      const body = req.body ?? {};
      const task = await repository.failTask({
        directorId: body.directorId,
        taskId: req.params.taskId,
        workerKey: body.workerKey,
        fencingToken: body.fencingToken,
        error: body.error ?? "TASK_FAILED",
        retryable: body.retryable !== false,
        correlationId: correlationOf(req),
      });
      return res.status(200).json({ task });
    })
  );

  router.use((req, res) => fail(res, "FLEET_ROUTE_NOT_FOUND", "Unknown fleet route.", 404));
  return router;
}
