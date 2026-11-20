/**
 * ST Production House — Director fleet policy (Day 5 / D7).
 *
 * The single, frozen source of truth for:
 *   - the Director lifecycle and its legal transitions,
 *   - what a Director must have configured before it can become ACTIVE,
 *   - the Owner's fleet capacity,
 *   - the production stage graph and the evidence a stage must produce,
 *   - fleet health vocabulary.
 *
 * Nothing here performs I/O. The repository enforces these rules in SQL; this
 * module is the shared contract used by the repository, the API, the tests and
 * the daily report, so there is exactly one definition (R5: no drifting enums).
 */

export const DIRECTOR_LIFECYCLE_STATES = Object.freeze({
  DRAFT: "DRAFT",
  CONFIGURED: "CONFIGURED",
  READY: "READY",
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  SUSPENDED: "SUSPENDED",
  RETIRING: "RETIRING",
  RETIRED: "RETIRED",
});

export const LIFECYCLE_STATE_LIST = Object.freeze(Object.values(DIRECTOR_LIFECYCLE_STATES));

/** States in which HERMES may assign production work. */
export const WORK_CAPABLE_STATES = Object.freeze([DIRECTOR_LIFECYCLE_STATES.ACTIVE]);

/** States that no longer consume a fleet capacity slot. */
export const CAPACITY_EXEMPT_STATES = Object.freeze([DIRECTOR_LIFECYCLE_STATES.RETIRED]);

/** Owner policy: the maximum number of registered, non-retired Directors. */
export const FLEET_CAPACITY = 50;

/**
 * Legal transitions. Everything not listed is refused. Retirement is terminal:
 * history is preserved and a retired Director never returns to work.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(["CONFIGURED", "RETIRED"]),
  CONFIGURED: Object.freeze(["READY", "DRAFT", "SUSPENDED", "RETIRED"]),
  READY: Object.freeze(["ACTIVE", "CONFIGURED", "SUSPENDED", "RETIRED"]),
  ACTIVE: Object.freeze(["PAUSED", "SUSPENDED", "RETIRING", "RETIRED"]),
  PAUSED: Object.freeze(["ACTIVE", "SUSPENDED", "RETIRING", "RETIRED"]),
  SUSPENDED: Object.freeze(["RETIRING", "RETIRED"]),
  RETIRING: Object.freeze(["RETIRED", "SUSPENDED"]),
  RETIRED: Object.freeze([]),
});

export const FLEET_ERROR = Object.freeze({
  DIRECTOR_ID_INVALID: "DIRECTOR_ID_INVALID",
  DIRECTOR_NOT_FOUND: "DIRECTOR_NOT_FOUND",
  DIRECTOR_ALREADY_EXISTS: "DIRECTOR_ALREADY_EXISTS",
  DIRECTOR_FLEET_CAPACITY_REACHED: "DIRECTOR_FLEET_CAPACITY_REACHED",
  DIRECTOR_TRANSITION_INVALID: "DIRECTOR_TRANSITION_INVALID",
  DIRECTOR_NOT_READY: "DIRECTOR_NOT_READY",
  DIRECTOR_NOT_WORK_CAPABLE: "DIRECTOR_NOT_WORK_CAPABLE",
  DIRECTOR_NOT_AUTHORIZED: "DIRECTOR_NOT_AUTHORIZED",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_DEPENDENCY_UNSATISFIED: "TASK_DEPENDENCY_UNSATISFIED",
  TASK_DEPENDENCY_CYCLE: "TASK_DEPENDENCY_CYCLE",
  TASK_STAGE_EVIDENCE_MISSING: "TASK_STAGE_EVIDENCE_MISSING",
  TASK_NOT_ASSIGNABLE: "TASK_NOT_ASSIGNABLE",
  TASK_LEASE_UNAVAILABLE: "TASK_LEASE_UNAVAILABLE",
  TASK_FENCING_TOKEN_STALE: "TASK_FENCING_TOKEN_STALE",
  TASK_LEASE_NOT_ACTIVE: "TASK_LEASE_NOT_ACTIVE",
  TASK_RESULT_REQUIRED: "TASK_RESULT_REQUIRED",
  TASK_NOT_CANCELLABLE: "TASK_NOT_CANCELLABLE",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  ACTOR_REQUIRED: "ACTOR_REQUIRED",
  CORRELATION_ID_REQUIRED: "CORRELATION_ID_REQUIRED",
  REASON_REQUIRED: "REASON_REQUIRED",
});

export class FleetError extends Error {
  constructor(code, message = null, status = 409, detail = null) {
    super(message ?? code);
    this.name = "FleetError";
    this.code = code;
    this.status = status;
    if (detail) this.detail = detail;
  }
}

const DIRECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isDirectorId(value) {
  return typeof value === "string" && DIRECTOR_ID_PATTERN.test(value);
}

export function assertDirectorId(value) {
  if (!isDirectorId(value)) {
    throw new FleetError(FLEET_ERROR.DIRECTOR_ID_INVALID, "Director id must match ^[a-z0-9][a-z0-9_-]{1,63}$.", 400);
  }
  return value;
}

export function assertCorrelationId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new FleetError(FLEET_ERROR.CORRELATION_ID_REQUIRED, "A correlation id (UUID) is required.", 400);
  }
  return value;
}

export function assertReason(value) {
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 500) {
    throw new FleetError(FLEET_ERROR.REASON_REQUIRED, "A reason of 3–500 characters is required.", 400);
  }
  return value.trim();
}

/** A management action always has an authenticated actor and a reason. */
export function assertActor(actor) {
  if (!actor || typeof actor.id !== "string" || actor.id.length === 0) {
    throw new FleetError(FLEET_ERROR.ACTOR_REQUIRED, "An authenticated actor is required.", 401);
  }
  const role = actor.role ?? "SYSTEM";
  if (!["OWNER", "HERMES", "FORGE", "SYSTEM"].includes(role)) {
    throw new FleetError(FLEET_ERROR.ACTOR_REQUIRED, "Unknown actor role.", 403);
  }
  return { id: actor.id, role };
}

export function isKnownLifecycleState(value) {
  return typeof value === "string" && LIFECYCLE_STATE_LIST.includes(value);
}

export function isTransitionAllowed(from, to) {
  if (!isKnownLifecycleState(from) || !isKnownLifecycleState(to)) return false;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransitionAllowed(from, to) {
  if (!isTransitionAllowed(from, to)) {
    throw new FleetError(
      FLEET_ERROR.DIRECTOR_TRANSITION_INVALID,
      `Director lifecycle transition ${from} -> ${to} is not permitted.`,
      409
    );
  }
  return { from, to };
}

/**
 * Readiness requirements. Each entry is evaluated from persisted configuration
 * only — never from a caller's assertion.
 */
export const READINESS_REQUIREMENTS = Object.freeze([
  Object.freeze({ code: "UNIVERSE_IDENTITY", description: "Display name, universe name and niche are recorded." }),
  Object.freeze({ code: "AUDIENCE_AND_LANGUAGE", description: "Target audience and at least one language are recorded." }),
  Object.freeze({ code: "GENRES_AND_FORMATS", description: "At least one genre and one content format are recorded." }),
  Object.freeze({ code: "CREATIVE_DIRECTION", description: "A creative direction statement is recorded." }),
  Object.freeze({ code: "TEAM_CONFIGURATION", description: "A team configuration is recorded." }),
  Object.freeze({ code: "PRODUCTION_CONFIGURATION", description: "A production configuration is recorded." }),
  Object.freeze({ code: "PROVIDER_REFERENCES", description: "Provider references are recorded as opaque locators." }),
  Object.freeze({ code: "PLATFORM_DESTINATIONS", description: "At least one platform destination reference is recorded." }),
  Object.freeze({ code: "OWNER_AUTHORIZATION", description: "The Owner has authorized the Director for activation." }),
]);

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.keys(value);
  return [];
}

/** True when an opaque provider/platform reference is a safe locator, not a secret. */
export function isOpaqueLocator(value) {
  if (typeof value !== "string") return false;
  if (!/^vault:\/\/[A-Za-z0-9._~\-/]{3,200}$/.test(value)) return false;
  return !/(?:api[_-]?key|secret|token|password|bearer)\s*[:=]/i.test(value);
}

/**
 * Evaluate readiness from a persisted Director record.
 * Returns `{ ready, requirements: [{code, satisfied, detail}] }`.
 */
export function evaluateReadiness(director) {
  const providerRefs = asArray(director?.providerConfig).filter(isOpaqueLocator);
  const platformRefs = asArray(director?.platformConnections);
  const results = [
    {
      code: "UNIVERSE_IDENTITY",
      satisfied: hasText(director?.displayName) && hasText(director?.universeName) && hasText(director?.niche),
    },
    {
      code: "AUDIENCE_AND_LANGUAGE",
      satisfied: hasText(director?.targetAudience) && asArray(director?.languages).length > 0,
    },
    {
      code: "GENRES_AND_FORMATS",
      satisfied: asArray(director?.genres).length > 0 && asArray(director?.contentFormats).length > 0,
    },
    { code: "CREATIVE_DIRECTION", satisfied: hasText(director?.creativeDirection) },
    {
      code: "TEAM_CONFIGURATION",
      satisfied: director?.teamConfig != null && Object.keys(director.teamConfig).length > 0,
    },
    {
      code: "PRODUCTION_CONFIGURATION",
      satisfied: director?.productionConfig != null && Object.keys(director.productionConfig).length > 0,
    },
    { code: "PROVIDER_REFERENCES", satisfied: providerRefs.length > 0 },
    { code: "PLATFORM_DESTINATIONS", satisfied: platformRefs.length > 0 },
    { code: "OWNER_AUTHORIZATION", satisfied: typeof director?.ownerAuthorizedAt === "string" && director.ownerAuthorizedAt.length > 0 },
  ];
  const withDetail = results.map((entry) => ({
    ...entry,
    detail: entry.satisfied ? "recorded" : "missing",
  }));
  return {
    ready: withDetail.every((entry) => entry.satisfied),
    requirements: withDetail,
    missing: withDetail.filter((entry) => !entry.satisfied).map((entry) => entry.code),
  };
}

// ---------------------------------------------------------------------------
// Production stage graph
// ---------------------------------------------------------------------------

export const PRODUCTION_STAGES = Object.freeze([
  "RESEARCH",
  "SCRIPT",
  "CHARACTERS",
  "VISUALS",
  "ANIMATION",
  "VOICE",
  "MUSIC",
  "ASSEMBLY",
  "FFPROBE",
  "QC",
  "PACKAGE",
  "OWNER_APPROVAL",
  "PUBLISHING",
  "ANALYTICS",
]);

/**
 * Upstream stages each stage depends on. This is a dependency GRAPH, not one
 * global queue: independent branches (e.g. VISUALS and VOICE) can run in
 * parallel and only ASSEMBLY needs both.
 */
export const STAGE_DEPENDENCIES = Object.freeze({
  RESEARCH: Object.freeze([]),
  SCRIPT: Object.freeze(["RESEARCH"]),
  CHARACTERS: Object.freeze(["SCRIPT"]),
  VISUALS: Object.freeze(["SCRIPT", "CHARACTERS"]),
  ANIMATION: Object.freeze(["VISUALS"]),
  VOICE: Object.freeze(["SCRIPT"]),
  MUSIC: Object.freeze(["SCRIPT"]),
  ASSEMBLY: Object.freeze(["ANIMATION", "VOICE", "MUSIC"]),
  FFPROBE: Object.freeze(["ASSEMBLY"]),
  QC: Object.freeze(["FFPROBE"]),
  PACKAGE: Object.freeze(["QC"]),
  OWNER_APPROVAL: Object.freeze(["PACKAGE"]),
  PUBLISHING: Object.freeze(["OWNER_APPROVAL"]),
  ANALYTICS: Object.freeze(["PUBLISHING"]),
});

/**
 * Evidence a stage must persist before it counts as complete. A queued task or a
 * called handler is never completion; the evidence row is.
 */
export const STAGE_EVIDENCE_REQUIREMENTS = Object.freeze({
  RESEARCH: Object.freeze(["research_brief"]),
  SCRIPT: Object.freeze(["script"]),
  CHARACTERS: Object.freeze(["character_sheet"]),
  VISUALS: Object.freeze(["visual_assets"]),
  ANIMATION: Object.freeze(["animation_render"]),
  VOICE: Object.freeze(["voice_track"]),
  MUSIC: Object.freeze(["audio_mix"]),
  ASSEMBLY: Object.freeze(["assembled_media"]),
  FFPROBE: Object.freeze(["ffprobe_report"]),
  QC: Object.freeze(["qc_report"]),
  PACKAGE: Object.freeze(["final_package"]),
  OWNER_APPROVAL: Object.freeze(["owner_approval"]),
  PUBLISHING: Object.freeze(["publish_receipt"]),
  ANALYTICS: Object.freeze(["analytics_snapshot"]),
});

/** Stages whose evidence must carry a real artifact hash (verified media). */
export const STAGE_HASH_REQUIRED = Object.freeze([
  "ANIMATION",
  "ASSEMBLY",
  "FFPROBE",
  "PACKAGE",
]);

export function isKnownStage(stage) {
  return typeof stage === "string" && PRODUCTION_STAGES.includes(stage);
}

export function dependenciesOf(stage) {
  if (!isKnownStage(stage)) {
    throw new FleetError(FLEET_ERROR.TASK_NOT_ASSIGNABLE, `Unknown production stage: ${stage}`, 400);
  }
  return STAGE_DEPENDENCIES[stage];
}

export function evidenceRequiredFor(stage) {
  return STAGE_EVIDENCE_REQUIREMENTS[stage] ?? [];
}

/** Downstream (transitive) stages, used to propagate cancellation. */
export function downstreamStagesOf(stage) {
  const result = [];
  const queue = [stage];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [candidate, deps] of Object.entries(STAGE_DEPENDENCIES)) {
      if (deps.includes(current) && !result.includes(candidate)) {
        result.push(candidate);
        queue.push(candidate);
      }
    }
  }
  return result;
}

/** Refuse a dependency set that is not a legal upstream stage (cycle/self). */
export function assertDependencyEdge(taskStage, dependsOnStage) {
  if (!isKnownStage(taskStage) || !isKnownStage(dependsOnStage)) {
    throw new FleetError(FLEET_ERROR.TASK_NOT_ASSIGNABLE, "Unknown production stage.", 400);
  }
  if (taskStage === dependsOnStage) {
    throw new FleetError(FLEET_ERROR.TASK_DEPENDENCY_CYCLE, "A stage cannot depend on itself.", 409);
  }
  if (downstreamStagesOf(taskStage).includes(dependsOnStage)) {
    throw new FleetError(FLEET_ERROR.TASK_DEPENDENCY_CYCLE, "Downstream stage cannot be an upstream dependency.", 409);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fleet health
// ---------------------------------------------------------------------------

export const FLEET_HEALTH_STATE = Object.freeze({
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  BLOCKED: "BLOCKED",
  OFFLINE: "OFFLINE",
  SUSPENDED: "SUSPENDED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
});

/** A Director runtime heartbeat older than this is genuinely expired. */
export const HEARTBEAT_TTL_SECONDS = 90;

/** Repeated failures that escalate rather than silently retry. */
export const ESCALATION_THRESHOLDS = Object.freeze({
  FAILED_TASKS: 3,
  BLOCKED_STAGES: 2,
});

export function classifyDirectorHealth({
  director,
  activeTasks = 0,
  queuedTasks = 0,
  blockedTasks = 0,
  failedTasks = 0,
  oldestQueuedSeconds = null,
  providerBlocked = false,
  heartbeatAgeSeconds = null,
}) {
  const state = director?.lifecycleState;
  if (state === DIRECTOR_LIFECYCLE_STATES.SUSPENDED || state === DIRECTOR_LIFECYCLE_STATES.RETIRING) {
    return FLEET_HEALTH_STATE.SUSPENDED;
  }
  if (state === DIRECTOR_LIFECYCLE_STATES.RETIRED) return FLEET_HEALTH_STATE.SUSPENDED;
  if (state === DIRECTOR_LIFECYCLE_STATES.DRAFT || state === DIRECTOR_LIFECYCLE_STATES.CONFIGURED) {
    return FLEET_HEALTH_STATE.NOT_CONFIGURED;
  }
  if (state === DIRECTOR_LIFECYCLE_STATES.PAUSED) return FLEET_HEALTH_STATE.OFFLINE;
  // ACTIVE or READY: health is derived from real work records only.
  if (heartbeatAgeSeconds === null) {
    // No registered runtime at all: honest, not "offline because a tab closed".
    if (activeTasks === 0 && queuedTasks === 0) return FLEET_HEALTH_STATE.OFFLINE;
  } else if (heartbeatAgeSeconds > HEARTBEAT_TTL_SECONDS) {
    return FLEET_HEALTH_STATE.OFFLINE;
  }
  if (blockedTasks > 0 || providerBlocked) return FLEET_HEALTH_STATE.BLOCKED;
  if (failedTasks > 0 || (oldestQueuedSeconds !== null && oldestQueuedSeconds > 3600)) {
    return FLEET_HEALTH_STATE.DEGRADED;
  }
  return FLEET_HEALTH_STATE.HEALTHY;
}

export function escalationCodeForHealth(healthState, counters = {}) {
  if (healthState === FLEET_HEALTH_STATE.OFFLINE) return "DIRECTOR_HEARTBEAT_LOST";
  if (healthState === FLEET_HEALTH_STATE.BLOCKED) {
    return counters.providerBlocked ? "DIRECTOR_PROVIDER_BLOCKED" : "DIRECTOR_PRODUCTION_BLOCKED";
  }
  if (healthState === FLEET_HEALTH_STATE.DEGRADED) {
    return counters.failedTasks >= ESCALATION_THRESHOLDS.FAILED_TASKS
      ? "DIRECTOR_REPEATED_TASK_FAILURE"
      : "DIRECTOR_QUEUE_STALLED";
  }
  return null;
}
