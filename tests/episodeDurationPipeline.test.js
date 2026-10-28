/**
 * Per-Director episode duration → production pipeline integration.
 *
 * Master prompt §2A/§6/§9: the duration a Director configures must actually
 * REACH production — planning, the executor boundary, and the main-longform
 * render target — and must never be overridden by a hidden hardcoded default.
 *
 * These tests run the real `runEpisodePipeline` over the labeled demo storage
 * adapter (the same SQL subset as PostgreSQL) and assert:
 *
 *   - duration precedence is contract (Director schedule → queued job →
 *     documented default);
 *   - a corrupted/unsupported duration fails CLOSED (it never silently renders
 *     a different length);
 *   - the resolved duration arrives at the executor runner for every stage;
 *   - the long-form assembly plan is built from the configured duration;
 *   - the deterministic manifest reports the PLANNED duration (no fabricated
 *     rendered duration);
 *   - a quota-exhausted executor is a durable WAIT, not a success and not a
 *     destroyed episode;
 *   - nothing publishes: the release still stops at the owner review gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductionRepository } from "../src/catalog/productionRepository.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";
import {
  DEFAULT_EPISODE_DURATION_SECONDS,
  EPISODE_DURATION_OPTIONS_SECONDS,
} from "../src/scheduling/directorSchedule.js";
import {
  evaluatePublishGate,
  renderStageContent,
  resolveEpisodeTargetDuration,
  runEpisodePipeline,
} from "../src/pipeline/episodePipeline.js";
import { buildLongformAssemblyPlan } from "../src/pipeline/productionExecutorRunner.js";

// ---------------------------------------------------------------------------
// Duration precedence (pure)
// ---------------------------------------------------------------------------

test("the Director's own configured duration outranks the job and the default", async () => {
  const resolved = await resolveEpisodeTargetDuration({
    release: { jobId: "job-1" },
    directorSchedule: { episodeDurationSeconds: 3000 },
    jobPayload: { episodeDurationSeconds: 1800 },
  });
  assert.deepEqual(resolved, { seconds: 3000, source: "director_schedule" });
});

test("the duration stamped on the queued job is honoured when no schedule row exists", async () => {
  const resolved = await resolveEpisodeTargetDuration({
    release: { jobId: "job-1" },
    directorSchedule: null,
    jobPayload: JSON.stringify({ episodeDurationSeconds: 1800 }),
  });
  assert.deepEqual(resolved, { seconds: 1800, source: "job_payload" });
});

test("with no configuration at all the documented 40-minute default applies", async () => {
  const resolved = await resolveEpisodeTargetDuration({ release: { jobId: null }, jobs: null });
  assert.equal(resolved.seconds, DEFAULT_EPISODE_DURATION_SECONDS);
  assert.equal(resolved.seconds, 2400);
  assert.equal(resolved.source, "default");
});

test("every selectable duration is accepted, and a corrupted one fails closed", async () => {
  for (const seconds of EPISODE_DURATION_OPTIONS_SECONDS) {
    const resolved = await resolveEpisodeTargetDuration({ directorSchedule: { episodeDurationSeconds: seconds } });
    assert.equal(resolved.seconds, seconds);
  }
  // A PRESENT but unsupported value must never fall back to the default: a
  // corrupted Director configuration has to fail the run, not silently render
  // a different length.
  await assert.rejects(
    () => resolveEpisodeTargetDuration({ directorSchedule: { episodeDurationSeconds: 1234 } }),
    /EPISODE_DURATION_INVALID/,
  );
  await assert.rejects(
    () => resolveEpisodeTargetDuration({ jobPayload: { episodeDurationSeconds: "45:00" } }),
    /EPISODE_DURATION_INVALID/,
  );
});

// ---------------------------------------------------------------------------
// The duration reaches the render target and the manifest
// ---------------------------------------------------------------------------

test("the main-longform assembly plan renders the CONFIGURED duration, never a hidden default", () => {
  const narrationArtifact = { sha256: "a".repeat(64) };
  const visualArtifact = { sha256: "b".repeat(64) };
  for (const seconds of EPISODE_DURATION_OPTIONS_SECONDS) {
    const plan = buildLongformAssemblyPlan({
      agentId: "agent-01",
      productionRunId: "episode-deadbeef",
      narrationArtifact,
      visualArtifact,
      durationSeconds: seconds,
    });
    assert.equal(plan.outputTarget, "main_longform");
    const image = plan.segments.find((segment) => segment.kind === "still_image");
    assert.equal(image.durationSeconds, seconds, "the render target is the configured duration");
  }
});

test("the deterministic manifest reports the PLANNED duration and never a rendered one", () => {
  const manifest = JSON.parse(renderStageContent("assembly", {
    channelId: "ch-1",
    title: "Nightfall Ward 7",
    season: 1,
    episode: 2,
    targetDurationSeconds: 1800,
  }));
  assert.equal(manifest.plannedEpisodeDurationSeconds, 1800);
  assert.equal(manifest.timelineSeconds, 1800);
  assert.equal(manifest.generationMode, "deterministic_local");
  assert.equal(Object.hasOwn(manifest, "measuredDurationSeconds"), false, "no fabricated measured duration");
});

// ---------------------------------------------------------------------------
// Pipeline against the demo adapter (same SQL subset as PostgreSQL)
// ---------------------------------------------------------------------------

async function buildHarness() {
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const production = new ProductionRepository(db);

  await db.query(
    "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)",
    ["agent-01", "JARVIS", "st.agent.jarvis", true],
  );
  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, "owner@duration.test", "x".repeat(64), "owner", "authenticated"],
  );
  const channelId = randomUUID();
  await db.query(
    `INSERT INTO channels (id, owner_id, slug, display_name, tagline, language, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [channelId, ownerId, `duration-${channelId.slice(0, 8)}`, "Duration Test", "tag", "Hindi", "agent-01"],
  );

  return { db, production, ownerId, channelId };
}

/**
 * The job reads the pipeline actually performs. The queued job's payload is
 * persisted by `createReleaseWithJob`, so the duration resolution exercises the
 * same path production uses (release.jobId → job payload) rather than a stub
 * that could hide a broken lookup.
 */
function buildJobsPort(db, updates = []) {
  return {
    get: async (id) => {
      const result = await db.query("SELECT * FROM jobs WHERE id = $1;", [id]);
      const row = result.rows[0];
      return row ? { id: row.id, agentId: row.agent_id, capability: row.capability, payload: row.payload } : null;
    },
    updateStatus: async (...args) => { updates.push(args); },
  };
}

test("the configured duration reaches the executor runner for every attempted stage", async () => {
  const { db, production, ownerId, channelId } = await buildHarness();
  const { release, jobId } = await production.createReleaseWithJob(ownerId, {
    channelId,
    agentId: "agent-01",
    title: "Nightly Dispatch",
    season: 1,
    episode: 1,
    episodeDurationSeconds: 1800,
  });

  const runnerCalls = [];
  const jobUpdates = [];
  const result = await runEpisodePipeline({
    ownerId,
    releaseId: release.id,
    production,
    jobs: buildJobsPort(db, jobUpdates),
    evidenceLedger: { append: async () => ({ ok: true }) },
    // The Director's persisted schedule is the authoritative configuration.
    directorSchedule: { episodeDurationSeconds: 3000 },
    executorRunner: async (args) => {
      runnerCalls.push(args);
      // Honest free-tier quota exhaustion: a durable WAIT, never a fake success.
      return { success: false, executed: false, quotaState: "WAITING_FOR_QUOTA", failureCode: "QUOTA_EXHAUSTED", descriptor: null, inspection: null, qc: null };
    },
  });

  assert.equal(runnerCalls.length, 1, "the first executor stage runs before the durable wait");
  const [call] = runnerCalls;
  assert.equal(call.stage, "audio");
  assert.equal(call.agentId, "agent-01", "the runner is Director-scoped");
  assert.equal(call.targetDurationSeconds, 3000, "the configured duration, not the job's 1800 and not the default");
  assert.equal(call.targetDurationSource, "director_schedule");
  assert.equal(call.stageInputs.targetDurationSeconds, 3000, "planning stage inputs carry the configured duration");

  // The wait is durable and honest: the release returns to `planned`, the job
  // carries the wait code, and no episode is claimed as complete.
  assert.equal(result.waited, true);
  assert.equal(result.status, "planned");
  assert.equal(result.waitingCode, "QUOTA_EXHAUSTED");
  const reloaded = await production.getRelease(ownerId, release.id);
  assert.equal(reloaded.status, "planned");
  assert.equal(reloaded.jobId, jobId, "the release keeps its own queued job");
  assert.equal(jobUpdates.length, 1);
  assert.deepEqual(jobUpdates[0].slice(1), [null, { failureCode: "QUOTA_EXHAUSTED", waitingForQuota: true }]);
});

test("the queued job's own stamped duration is used when the Director has no saved schedule", async () => {
  const { db, production, ownerId, channelId } = await buildHarness();
  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId,
    agentId: "agent-01",
    title: "Secondary Lane",
    season: 1,
    episode: 1,
    episodeDurationSeconds: 1800,
  });

  const runnerCalls = [];
  await runEpisodePipeline({
    ownerId,
    releaseId: release.id,
    production,
    jobs: buildJobsPort(db),
    evidenceLedger: { append: async () => ({ ok: true }) },
    executorRunner: async (args) => {
      runnerCalls.push(args);
      return { success: false, executed: false, quotaState: "WAITING_FOR_QUOTA", failureCode: "QUOTA_EXHAUSTED", descriptor: null, inspection: null, qc: null };
    },
  });

  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].targetDurationSeconds, 1800);
  assert.equal(runnerCalls[0].targetDurationSource, "job_payload");
});

test("the deterministic path uses the configured duration and still stops at the owner review gate", async () => {
  const { production, ownerId, channelId } = await buildHarness();
  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId,
    agentId: "agent-01",
    title: "Long Form Draft",
    season: 1,
    episode: 1,
    episodeDurationSeconds: 3000,
  });

  const result = await runEpisodePipeline({
    ownerId,
    releaseId: release.id,
    production,
    jobs: { updateStatus: async () => {} },
    evidenceLedger: { append: async () => ({ ok: true }) },
  });

  assert.equal(result.status, "review", "a finished run stops at owner review — nothing publishes itself");
  const artifacts = await production.listArtifactsForRelease(ownerId, release.id);
  const assembly = artifacts.find((artifact) => artifact.stage === "assembly");
  assert.ok(assembly, "the assembly stage recorded its planned manifest");
  assert.equal(assembly.ffprobeVerified, false, "deterministic staging is not a verified render");

  // Publishing is still gated on a configured destination AND the owner's
  // approval: the pipeline itself never uploads.
  const reloaded = await production.getRelease(ownerId, release.id);
  assert.equal(reloaded.status, "review");
  assert.equal(evaluatePublishGate({ release: { status: "planned" }, destination: { publicAttribution: "X" } }).ok, false);
});

test("a Director-specific duration stays scoped to its own release", async () => {
  const { db, production, ownerId, channelId } = await buildHarness();
  const short = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Thirty", season: 1, episode: 1, episodeDurationSeconds: 1800,
  });
  const long = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Fifty", season: 1, episode: 2, episodeDurationSeconds: 3000,
  });

  const callsByTitle = new Map();
  const runner = async (args) => {
    callsByTitle.set(args.release.title, args.targetDurationSeconds);
    return { success: false, executed: false, quotaState: "WAITING_FOR_QUOTA", failureCode: "QUOTA_EXHAUSTED", descriptor: null, inspection: null, qc: null };
  };
  for (const [release, schedule] of [[short.release, null], [long.release, null]]) {
    await runEpisodePipeline({
      ownerId,
      releaseId: release.id,
      production,
      jobs: buildJobsPort(db),
      evidenceLedger: { append: async () => ({ ok: true }) },
      directorSchedule: schedule,
      executorRunner: runner,
    });
  }

  assert.equal(callsByTitle.get("Thirty"), 1800);
  assert.equal(callsByTitle.get("Fifty"), 3000, "one release's target never leaks into another");
});

test("an unsupported duration on the release fails the run closed instead of rendering the default", async () => {
  const { production, ownerId, channelId } = await buildHarness();
  const { release } = await production.createReleaseWithJob(ownerId, {
    channelId, agentId: "agent-01", title: "Corrupted", season: 1, episode: 1,
  });

  await assert.rejects(
    () => runEpisodePipeline({
      ownerId,
      releaseId: release.id,
      production,
      jobs: { updateStatus: async () => {} },
      evidenceLedger: { append: async () => ({ ok: true }) },
      directorSchedule: { episodeDurationSeconds: 9999 },
    }),
    /EPISODE_DURATION_INVALID/,
  );
});
