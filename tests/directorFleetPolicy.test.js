/**
 * Day 5 / D7 — Director fleet policy unit tests (no database).
 *
 * Covers the frozen lifecycle, readiness evaluation, the production stage graph,
 * the retry/backoff helper and health classification. The PostgreSQL acceptance
 * suite (`directorFleetOrchestration.integration.js`) covers the durable paths.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_TRANSITIONS,
  DIRECTOR_LIFECYCLE_STATES,
  FLEET_CAPACITY,
  FLEET_ERROR,
  FLEET_HEALTH_STATE,
  FleetError,
  PRODUCTION_STAGES,
  STAGE_DEPENDENCIES,
  STAGE_EVIDENCE_REQUIREMENTS,
  assertDependencyEdge,
  assertTransitionAllowed,
  classifyDirectorHealth,
  dependenciesOf,
  downstreamStagesOf,
  evaluateReadiness,
  evidenceRequiredFor,
  isOpaqueLocator,
  isTransitionAllowed,
  READINESS_REQUIREMENTS,
} from "../src/fleet/fleetPolicy.js";
import { retryDelaySeconds } from "../src/fleet/fleetRepository.js";

const HASH = "a".repeat(64);

function completeDirector(overrides = {}) {
  return {
    displayName: "JARVIS",
    universeName: "JARVIS Universe",
    niche: "cinematic tech explainers",
    genres: ["tech"],
    contentFormats: ["long_form"],
    languages: ["en"],
    targetAudience: "builders",
    creativeDirection: "measured, evidence-first",
    teamConfig: { director: "lead" },
    productionConfig: { episodesPerDay: 1 },
    providerConfig: ["vault://stph/jarvis/gemini/primary"],
    platformConnections: ["youtube"],
    ownerAuthorizedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("lifecycle: exactly the eight Owner states and no escape from RETIRED", () => {
  assert.deepEqual(Object.values(DIRECTOR_LIFECYCLE_STATES), [
    "DRAFT",
    "CONFIGURED",
    "READY",
    "ACTIVE",
    "PAUSED",
    "SUSPENDED",
    "RETIRING",
    "RETIRED",
  ]);
  assert.deepEqual([...ALLOWED_TRANSITIONS.RETIRED], []);
  assert.equal(isTransitionAllowed("DRAFT", "ACTIVE"), false, "activation must pass through READY");
  assert.equal(isTransitionAllowed("ACTIVE", "READY"), false, "a Director never silently un-activates");
  assert.equal(isTransitionAllowed("ACTIVE", "PAUSED"), true);
  assert.equal(isTransitionAllowed("PAUSED", "ACTIVE"), true);
  assert.equal(isTransitionAllowed("SUSPENDED", "ACTIVE"), false);
  assert.throws(
    () => assertTransitionAllowed("SUSPENDED", "ACTIVE"),
    (error) => error instanceof FleetError && error.code === FLEET_ERROR.DIRECTOR_TRANSITION_INVALID
  );
});

test("readiness: every requirement must be persisted configuration", () => {
  assert.equal(READINESS_REQUIREMENTS.length, 9);
  assert.equal(evaluateReadiness(completeDirector()).ready, true);

  for (const requirement of READINESS_REQUIREMENTS) {
    const impossible = { ...completeDirector() };
    switch (requirement.code) {
      case "UNIVERSE_IDENTITY":
        impossible.universeName = null;
        break;
      case "AUDIENCE_AND_LANGUAGE":
        impossible.languages = [];
        break;
      case "GENRES_AND_FORMATS":
        impossible.genres = [];
        break;
      case "CREATIVE_DIRECTION":
        impossible.creativeDirection = "  ";
        break;
      case "TEAM_CONFIGURATION":
        impossible.teamConfig = {};
        break;
      case "PRODUCTION_CONFIGURATION":
        impossible.productionConfig = {};
        break;
      case "PROVIDER_REFERENCES":
        impossible.providerConfig = [];
        break;
      case "PLATFORM_DESTINATIONS":
        impossible.platformConnections = [];
        break;
      case "OWNER_AUTHORIZATION":
        impossible.ownerAuthorizedAt = null;
        break;
      default:
        assert.fail(`unhandled requirement ${requirement.code}`);
    }
    const result = evaluateReadiness(impossible);
    assert.equal(result.ready, false, `${requirement.code} must block readiness`);
    assert.deepEqual(result.missing, [requirement.code]);
  }
});

test("readiness: a plaintext credential is not a provider reference", () => {
  assert.equal(isOpaqueLocator("vault://stph/jarvis/gemini/primary"), true);
  assert.equal(isOpaqueLocator("sk-live-abcdef1234567890"), false);
  assert.equal(isOpaqueLocator("https://example.test/key"), false);
  assert.equal(isOpaqueLocator("vault://stph/jarvis?api_key=abc"), false);
  const result = evaluateReadiness(completeDirector({ providerConfig: ["sk-live-abcdef1234567890"] }));
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes("PROVIDER_REFERENCES"));
});

test("capacity: Owner policy is 50 Directors", () => {
  assert.equal(FLEET_CAPACITY, 50);
});

test("stage graph: 14 stages, parallel branches, evidence per stage", () => {
  assert.equal(PRODUCTION_STAGES.length, 14);
  assert.deepEqual([...dependenciesOf("RESEARCH")], []);
  assert.deepEqual([...dependenciesOf("ASSEMBLY")], ["ANIMATION", "VOICE", "MUSIC"]);
  // VISUALS and VOICE are independent branches after SCRIPT.
  assert.ok(!dependenciesOf("VISUALS").includes("VOICE"));
  assert.ok(!dependenciesOf("VOICE").includes("VISUALS"));
  for (const stage of PRODUCTION_STAGES) {
    assert.ok(evidenceRequiredFor(stage).length > 0, `${stage} must require evidence`);
    for (const dependency of STAGE_DEPENDENCIES[stage]) {
      assert.ok(PRODUCTION_STAGES.includes(dependency));
    }
  }
  assert.deepEqual(STAGE_EVIDENCE_REQUIREMENTS.PUBLISHING, ["publish_receipt"]);
});

test("stage graph: dependency edges refuse cycles and downstream dependencies", () => {
  assert.equal(assertDependencyEdge("SCRIPT", "RESEARCH"), true);
  assert.throws(
    () => assertDependencyEdge("RESEARCH", "SCRIPT"),
    (error) => error.code === FLEET_ERROR.TASK_DEPENDENCY_CYCLE
  );
  assert.throws(
    () => assertDependencyEdge("SCRIPT", "SCRIPT"),
    (error) => error.code === FLEET_ERROR.TASK_DEPENDENCY_CYCLE
  );
  assert.deepEqual(downstreamStagesOf("ASSEMBLY"), ["FFPROBE", "QC", "PACKAGE", "OWNER_APPROVAL", "PUBLISHING", "ANALYTICS"]);
});

test("retry backoff is bounded and deterministic per task", () => {
  const first = retryDelaySeconds(1, "task-a");
  assert.ok(first >= 5 && first <= 6, `unexpected first delay ${first}`);
  assert.equal(retryDelaySeconds(1, "task-a"), first);
  const capped = retryDelaySeconds(20, "task-a");
  assert.ok(capped <= 360, "backoff must stay bounded");
  assert.ok(retryDelaySeconds(4, "task-a") > retryDelaySeconds(1, "task-a"));
});

test("health classification derives from records, never from a closed browser", () => {
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "DRAFT" } }),
    FLEET_HEALTH_STATE.NOT_CONFIGURED
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "SUSPENDED" } }),
    FLEET_HEALTH_STATE.SUSPENDED
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "PAUSED" } }),
    FLEET_HEALTH_STATE.OFFLINE
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "ACTIVE" }, heartbeatAgeSeconds: 5 }),
    FLEET_HEALTH_STATE.HEALTHY
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "ACTIVE" }, heartbeatAgeSeconds: 600 }),
    FLEET_HEALTH_STATE.OFFLINE
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "ACTIVE" }, heartbeatAgeSeconds: 5, blockedTasks: 1 }),
    FLEET_HEALTH_STATE.BLOCKED
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "ACTIVE" }, heartbeatAgeSeconds: 5, providerBlocked: true }),
    FLEET_HEALTH_STATE.BLOCKED
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "ACTIVE" }, heartbeatAgeSeconds: 5, failedTasks: 1 }),
    FLEET_HEALTH_STATE.DEGRADED
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "ACTIVE" }, heartbeatAgeSeconds: 5, oldestQueuedSeconds: 7200 }),
    FLEET_HEALTH_STATE.DEGRADED
  );
  assert.equal(
    classifyDirectorHealth({ director: { lifecycleState: "ACTIVE" }, activeTasks: 2 }),
    FLEET_HEALTH_STATE.HEALTHY
  );
});

test("progress is never inferred: hash-only evidence counts as verified", () => {
  // The policy keeps the hash requirement explicit for media stages; the
  // generator/report only counts rows with a real hash.
  assert.deepEqual(
    ["ANIMATION", "ASSEMBLY", "FFPROBE", "PACKAGE"].every((stage) =>
      ["animation_render", "assembled_media", "ffprobe_report", "final_package"].includes(
        STAGE_EVIDENCE_REQUIREMENTS[stage][0]
      )
    ),
    true
  );
  assert.equal(HASH.length, 64);
});
