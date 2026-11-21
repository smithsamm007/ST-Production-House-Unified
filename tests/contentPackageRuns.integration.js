/**
 * S-M18-01 — durable Owner read API for content package runs and evidence.
 *
 * Real PostgreSQL (disposable database, canonical migrations through 046), real
 * `PostgresContentPackageReadRepository`, real `PostgresDirectorFleetRepository`
 * and the real mounted fleet router behind the real FORGE Owner-session gate.
 * No providers, publishing, jumps or mocked rows in the read path.
 *
 *   A  unauthenticated read is rejected (401)
 *   B  a non-Owner role is rejected by the real Owner gate (403)
 *   C  Owner lists runs in deterministic descending order with real counts
 *   D  keyset pagination never skips or duplicates (including equal timestamps)
 *   E  Director/state/stage/taskStatus/time filters scope correctly
 *   F  invalid filters and cursors are clean 4xx codes
 *   G  run detail exposes stages, dependencies, worker and retry/failure class
 *   H  a completed task does not imply a completed package
 *   I  a completed package does not imply publishing (no inference)
 *   J  evidence timeline is chronological with hashes and verification levels
 *   K  fixture evidence is labelled and never production-verified
 *   L  missing evidence stays missing; unknown runs are 404, not fabricated
 *   M  cross-Director records never leak through another Director's query
 *   N  internal fields, secret-shaped payloads and paths never serialize
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import supertest from "supertest";
import pg from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter.js";
import { MigrationRunner } from "../src/db/migrationRunner.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../src/recovery/drillRunner.js";
import { PostgresDirectorFleetRepository } from "../src/fleet/fleetRepository.js";
import { PostgresContentPackageReadRepository } from "../src/fleet/contentPackageReadRepository.js";
import { HermesFleetManager } from "../src/fleet/hermesFleetManager.js";
import { createFleetRouter } from "../src/api/fleetRouter.js";
import { createForgeOwnerSessionGate } from "../src/catalog/server.js";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || "";
const OWNER = { id: "owner-slice18", role: "owner" };
const VIEWER = { id: "viewer-slice18", role: "viewer" };

const HASH_RESEARCH = "1".repeat(64);
const HASH_RESEARCH_SUMMARY = "2".repeat(64);
const HASH_PACKAGE = "3".repeat(64);
const HASH_BETA = "4".repeat(64);

const ALPHA_RUN = "aaaaaaaa-1111-4111-8111-111111111111";
const ALPHA_PACKAGE_RUN = "aaaaaaaa-2222-4222-8222-222222222222";
const BETA_RUN = "bbbbbbbb-1111-4111-8111-111111111111";
const BETA_RUN_TIE = "bbbbbbbb-2222-4222-8222-222222222222";
const MISSING_RUN = "99999999-9999-4999-8999-999999999999";

const TASK_ALPHA_RESEARCH = "cccccccc-1111-4111-8111-111111111111";
const TASK_ALPHA_SCRIPT = "cccccccc-2222-4222-8222-222222222222";
const TASK_ALPHA_VISUALS = "cccccccc-3333-4333-8333-333333333333";
const TASK_ALPHA_PACKAGE = "cccccccc-4444-4444-8444-444444444444";
const TASK_BETA_PUBLISHING = "dddddddd-1111-4111-8111-111111111111";

const EVIDENCE_RESEARCH = "eeeeeeee-1111-4111-8111-111111111111";
const EVIDENCE_RESEARCH_SUMMARY = "eeeeeeee-2222-4222-8222-222222222222";
const EVIDENCE_PACKAGE = "eeeeeeee-3333-4333-8333-333333333333";

const SECRET = "sk-live-should-never-serialize-0123456789";

function buildApp({ pool, role }) {
  const repository = new PostgresDirectorFleetRepository(pool);
  const manager = new HermesFleetManager({ repository });
  const contentPackageReads = new PostgresContentPackageReadRepository(pool);
  const app = express();
  app.use(express.json());
  // Mirrors the real chain: authenticated session -> Owner lookup -> Owner gate.
  app.use((req, _res, next) => {
    const token = req.get("x-owner-token");
    if (token === "owner-token") req.ownerId = OWNER.id;
    if (token === "viewer-token") req.ownerId = VIEWER.id;
    next();
  });
  app.use(
    createForgeOwnerSessionGate({
      findOwnerById: async (id) => {
        if (id === OWNER.id) return OWNER;
        if (id === VIEWER.id) return VIEWER;
        return null;
      },
    })
  );
  app.use(
    "/api/fleet",
    createFleetRouter({
      repository,
      manager,
      contentPackageReads,
      getOwnerId: (req) => req?.forgeSession?.id ?? null,
      verifyCsrf: () => true,
    })
  );
  return { app: app, role };
}

const owner = (request) => request.set("x-owner-token", "owner-token");

async function seed(pool) {
  await pool.query(`
    INSERT INTO director_fleet (director_id, display_name, universe_name, niche, lifecycle_state)
    VALUES ('director-alpha', 'Alpha Director', 'Alpha Universe', 'technology', 'ACTIVE'),
           ('director-beta', 'Beta Director', 'Beta Universe', 'history', 'ACTIVE')
  `);

  await pool.query(
    `INSERT INTO director_projects (id, director_id, project_key, universe_id, title, state, created_at, updated_at)
     VALUES ($1, 'director-alpha', 'alpha-ep-1', 'universe-alpha', 'Alpha Episode 1', 'IN_PRODUCTION',
             clock_timestamp() - interval '4 minutes', clock_timestamp() - interval '3 minutes'),
            ($2, 'director-alpha', 'alpha-ep-2', 'universe-alpha', 'Alpha Episode 2', 'COMPLETED',
             clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '1 minute'),
            ($3, 'director-beta', 'beta-ep-1', 'universe-beta', 'Beta Episode 1', 'PLANNED',
             now() - interval '2 minutes', now() - interval '2 minutes'),
            ($4, 'director-beta', 'beta-ep-2', 'universe-beta', 'Beta Episode 2', 'PLANNED',
             now() - interval '2 minutes', now() - interval '2 minutes')`,
    [ALPHA_RUN, ALPHA_PACKAGE_RUN, BETA_RUN, BETA_RUN_TIE]
  );

  await pool.query(
    `INSERT INTO director_tasks
       (id, director_id, project_id, universe_id, stage, task_type, status, priority,
        idempotency_key, attempt_count, max_attempts, active_fencing_token, claimed_worker_key,
        provider_state, blocked_reason, last_error, result_ref, correlation_id, created_at, assigned_at, updated_at)
     VALUES
       ($1, 'director-alpha', $5, 'universe-alpha', 'RESEARCH', 'production', 'COMPLETED', 10,
        'alpha-ep-1-research', 1, 3, 4, 'worker-alpha-1', 'UNCONSTRAINED', NULL, NULL,
        'director-stage://research/finished', gen_random_uuid(),
        clock_timestamp() - interval '4 minutes', clock_timestamp() - interval '4 minutes', clock_timestamp() - interval '3 minutes'),
       ($2, 'director-alpha', $5, 'universe-alpha', 'SCRIPT', 'production', 'RETRY_SCHEDULED', 20,
        'alpha-ep-1-script', 1, 3, 0, 'worker-alpha-1', 'UNCONSTRAINED', NULL,
        'STAGE_TIMEOUT: /srv/stph/private/alpha-script.txt', NULL, gen_random_uuid(),
        clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '2 minutes'),
       ($3, 'director-alpha', $5, 'universe-alpha', 'VISUALS', 'production', 'BLOCKED', 30,
        'alpha-ep-1-visuals', 0, 3, 0, NULL, 'UNAVAILABLE', 'PROVIDER_UNAVAILABLE',
        'PROVIDER_NOT_CONFIGURED: visual provider slot', NULL, gen_random_uuid(),
        clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '2 minutes'),
       ($4, 'director-alpha', $6, 'universe-alpha', 'PACKAGE', 'production', 'COMPLETED', 10,
        'alpha-ep-2-package', 1, 3, 7, 'worker-alpha-1', 'UNCONSTRAINED', NULL, NULL,
        'director-stage://package/finished', gen_random_uuid(),
        clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute'),
       ($7, 'director-beta', $8, 'universe-beta', 'PUBLISHING', 'production', 'BLOCKED', 10,
        'beta-ep-1-publishing', 0, 3, 0, NULL, 'UNAVAILABLE', 'PROVIDER_UNAVAILABLE',
        'PROVIDER_NOT_CONFIGURED: publishing destination', NULL, gen_random_uuid(),
        clock_timestamp() - interval '2 minutes', NULL, clock_timestamp() - interval '2 minutes')`,
    [TASK_ALPHA_RESEARCH, TASK_ALPHA_SCRIPT, TASK_ALPHA_VISUALS, TASK_ALPHA_PACKAGE, ALPHA_RUN, ALPHA_PACKAGE_RUN, TASK_BETA_PUBLISHING, BETA_RUN]
  );

  await pool.query(
    `INSERT INTO director_task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`,
    [TASK_ALPHA_SCRIPT, TASK_ALPHA_RESEARCH]
  );

  await pool.query(
    `INSERT INTO director_workers (worker_key, instance_id, role, status, state, last_heartbeat_at)
     VALUES ('worker-alpha-1', 'instance-alpha-1', 'production', 'active', 'IDLE', clock_timestamp())`
  );

  await pool.query(
    `INSERT INTO director_task_evidence
       (id, task_id, director_id, stage, evidence_type, artifact_hash, payload,
        handler_name, handler_version, verification_level, environment, test_fixture,
        worker_key, fencing_token, input_refs, output_refs, validation, started_at, completed_at, created_at)
     VALUES
       ($1, $4, 'director-alpha', 'RESEARCH', 'research_brief', $7,
        $11::jsonb,
        'research-brief-structurer', '1.0.0', 'PRODUCTION_VERIFIED', 'PRODUCTION', FALSE,
        'worker-alpha-1', 4, '["director-stage://research/input-1"]'::jsonb,
        '["director-stage://research/output-1","/etc/passwd"]'::jsonb,
        '{"checks":[{"name":"document.readable","passed":true,"detail":"/srv/private/detail"},{"name":"document.min_words","passed":true}],"checkpoint":"research:abc"}'::jsonb,
        clock_timestamp() - interval '4 minutes', clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '3 minutes'),
       ($2, $4, 'director-alpha', 'RESEARCH', 'research_brief_summary', $8,
        '{}'::jsonb, 'research-brief-structurer', '1.0.0', 'PRODUCTION_VERIFIED', 'PRODUCTION', FALSE,
        'worker-alpha-1', 4, '[]'::jsonb, '["director-stage://research/output-2"]'::jsonb,
        '{"checks":[{"name":"summary.size","passed":true}]}'::jsonb,
        clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '2 minutes'),
       ($3, $5, 'director-alpha', 'PACKAGE', 'package_manifest', $9,
        '{"note":"fixture"}'::jsonb, 'package-manifest-validator', '1.0.0', 'INTEGRATION_TESTED', 'TEST', TRUE,
        'worker-alpha-1', 7, '["director-stage://package/input-1"]'::jsonb,
        '["director-stage://package/output-1"]'::jsonb,
        '{"checks":[{"name":"manifest.canonical","passed":true}]}'::jsonb,
        clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute', clock_timestamp() - interval '1 minute'),
       ('eeeeeeee-4444-4444-8444-444444444444', $6, 'director-beta', 'PUBLISHING', 'publish_receipt', $10,
        '{}'::jsonb, 'publishing-adapter', '1.0.0', 'PROVIDER_VERIFIED', 'PRODUCTION', FALSE,
        'worker-beta-1', 9, '[]'::jsonb, '["director-stage://publishing/output-1"]'::jsonb,
        '{"checks":[{"name":"receipt.signature","passed":true}]}'::jsonb,
        clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '90 seconds', clock_timestamp() - interval '90 seconds')`,
    [
      EVIDENCE_RESEARCH,
      EVIDENCE_RESEARCH_SUMMARY,
      EVIDENCE_PACKAGE,
      TASK_ALPHA_RESEARCH,
      TASK_ALPHA_PACKAGE,
      TASK_BETA_PUBLISHING,
      HASH_RESEARCH,
      HASH_RESEARCH_SUMMARY,
      HASH_PACKAGE,
      HASH_BETA,
      JSON.stringify({ apiKey: SECRET, internalNote: "never" }),
    ]
  );
}

test(
  "PostgreSQL 15 content package runs: durable Owner reads, pagination, isolation and evidence truth",
  { skip: POSTGRES_URL ? false : "POSTGRES_TEST_URL / DATABASE_URL not configured in this sandbox" },
  async () => {
    const created = await createDisposableDatabase(POSTGRES_URL, "stph_acceptance");
    const pool = new pg.Pool({ connectionString: created.connectionString, max: 8 });
    pool.on("error", () => {});

    try {
      await new MigrationRunner(new PostgresAdapter({}, pool)).runMigrations();
      await seed(pool);
      const { app } = buildApp({ pool });

      // ------------------------------------------------ A/B: auth + role gate
      for (const path of ["/api/fleet/content-packages", `/api/fleet/content-packages/${ALPHA_RUN}`, `/api/fleet/content-packages/${ALPHA_RUN}/evidence`]) {
        const anonymous = await supertest(app).get(path);
        assert.equal(anonymous.status, 401, `${path} must require an Owner session`);
      }
      const viewerPackages = await supertest(app).get("/api/fleet/content-packages").set("x-owner-token", "viewer-token");
      assert.equal(viewerPackages.status, 403);
      assert.equal(viewerPackages.body.code, "FORBIDDEN");

      // ------------------------------------------------ C: deterministic list
      const list = await owner(supertest(app).get("/api/fleet/content-packages"));
      assert.equal(list.status, 200);
      assert.equal(list.body.count, 4);
      assert.deepEqual(
        list.body.runs.map((run) => run.runId),
        [BETA_RUN_TIE, BETA_RUN, ALPHA_PACKAGE_RUN, ALPHA_RUN],
        "newest first, tie broken by id descending"
      );
      const alphaRun = list.body.runs.find((run) => run.runId === ALPHA_RUN);
      assert.deepEqual({ ...alphaRun.tasks.byStatus }, {
        CREATED: 0, QUEUED: 0, ASSIGNED: 0, RUNNING: 0, BLOCKED: 1,
        RETRY_SCHEDULED: 1, FAILED: 0, COMPLETED: 1, CANCELLED: 0, DEAD_LETTER: 0,
      });
      assert.equal(alphaRun.package.status, "NOT_SCHEDULED", "no PACKAGE stage ran for this run");
      assert.equal(alphaRun.publishing.status, "NOT_SCHEDULED");
      assert.equal(alphaRun.evidence.productionVerified, 2);
      assert.equal(alphaRun.evidence.fixtures, 0);

      const packageRun = list.body.runs.find((run) => run.runId === ALPHA_PACKAGE_RUN);
      assert.equal(packageRun.package.status, "COMPLETED");
      assert.equal(packageRun.package.completed, true);
      assert.equal(packageRun.package.productionVerified, false, "fixture evidence is never production-verified");
      assert.equal(packageRun.publishing.status, "NOT_SCHEDULED", "a completed package is not a publication");
      assert.equal(packageRun.publishing.verifiedReceipt, false);

      const betaRun = list.body.runs.find((run) => run.runId === BETA_RUN);
      assert.equal(betaRun.publishing.status, "BLOCKED");
      assert.equal(betaRun.publishing.verifiedReceipt, true, "only the recorded PROVIDER_VERIFIED receipt counts");

      // ------------------------------------------------ D: stable pagination
      const walked = [];
      let cursor = null;
      for (let page = 0; page < 6; page += 1) {
        const query = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : "?limit=1";
        const response = await owner(supertest(app).get(`/api/fleet/content-packages${query}`));
        assert.equal(response.status, 200);
        assert.ok(response.body.count <= 1);
        walked.push(...response.body.runs.map((run) => run.runId));
        cursor = response.body.page.nextCursor;
        if (!cursor) break;
      }
      assert.deepEqual(walked, [BETA_RUN_TIE, BETA_RUN, ALPHA_PACKAGE_RUN, ALPHA_RUN], "no skips, no duplicates");
      assert.equal(new Set(walked).size, walked.length);

      const firstPage = await owner(supertest(app).get("/api/fleet/content-packages?limit=2"));
      assert.equal(firstPage.body.runs.length, 2);
      assert.ok(firstPage.body.page.hasMore);
      const secondPage = await owner(
        supertest(app).get(`/api/fleet/content-packages?limit=2&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`)
      );
      assert.equal(secondPage.body.runs.length, 2);
      assert.equal(secondPage.body.page.hasMore, false);
      assert.equal(secondPage.body.page.nextCursor, null);

      // ------------------------------------------------ E: filters
      const byDirector = await owner(supertest(app).get("/api/fleet/content-packages?directorId=director-alpha"));
      assert.deepEqual(byDirector.body.runs.map((run) => run.runId), [ALPHA_PACKAGE_RUN, ALPHA_RUN]);

      const byState = await owner(supertest(app).get("/api/fleet/content-packages?state=COMPLETED"));
      assert.deepEqual(byState.body.runs.map((run) => run.runId), [ALPHA_PACKAGE_RUN]);

      const byStage = await owner(supertest(app).get("/api/fleet/content-packages?stage=PACKAGE"));
      assert.deepEqual(byStage.body.runs.map((run) => run.runId), [ALPHA_PACKAGE_RUN]);

      const byTaskStatus = await owner(supertest(app).get("/api/fleet/content-packages?taskStatus=RETRY_SCHEDULED"));
      assert.deepEqual(byTaskStatus.body.runs.map((run) => run.runId), [ALPHA_RUN]);

      const future = await owner(supertest(app).get(`/api/fleet/content-packages?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`));
      assert.equal(future.body.count, 0);
      const combined = await owner(
        supertest(app).get("/api/fleet/content-packages?directorId=director-beta&state=PLANNED&stage=PUBLISHING")
      );
      assert.deepEqual(combined.body.runs.map((run) => run.runId), [BETA_RUN]);

      // ------------------------------------------------ F: invalid inputs
      for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?state=PUBLISHED", "?stage=RENDER", "?directorId=Bad%20Id"]) {
        const response = await owner(supertest(app).get(`/api/fleet/content-packages${query}`));
        assert.equal(response.status, 400, `${query} must be a clean 4xx`);
        assert.equal(response.body.code, "QUERY_INVALID", query);
      }
      const badCursor = await owner(supertest(app).get("/api/fleet/content-packages?cursor=bm90LWpzb24"));
      assert.equal(badCursor.status, 400);
      assert.equal(badCursor.body.code, "CURSOR_INVALID");
      const badFromTo = await owner(
        supertest(app).get("/api/fleet/content-packages?from=2026-11-21T00:00:00Z&to=2026-11-01T00:00:00Z")
      );
      assert.equal(badFromTo.status, 400);

      // ------------------------------------------------ G/H/I: detail
      const detail = await owner(supertest(app).get(`/api/fleet/content-packages/${ALPHA_RUN}`));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run.director.directorId, "director-alpha");
      assert.equal(detail.body.run.director.displayName, "Alpha Director");
      assert.equal(detail.body.progress.tasks, 3);
      assert.deepEqual(detail.body.progress.stagesPresent, ["RESEARCH", "SCRIPT", "VISUALS"]);

      const scriptTask = detail.body.tasks.find((task) => task.stage === "SCRIPT");
      assert.equal(scriptTask.status, "RETRY_SCHEDULED");
      assert.equal(scriptTask.retryScheduled, true);
      assert.deepEqual(scriptTask.dependencies, [TASK_ALPHA_RESEARCH]);
      assert.deepEqual({ ...scriptTask.failure }, { code: "STAGE_TIMEOUT", class: "TRANSIENT", providerState: null });
      assert.equal(JSON.stringify(detail.body).includes("/srv"), false, "paths never serialize");
      assert.equal(JSON.stringify(detail.body).includes("private"), false);

      const visualsTask = detail.body.tasks.find((task) => task.stage === "VISUALS");
      assert.equal(visualsTask.status, "BLOCKED");
      assert.equal(visualsTask.blockedReason, "PROVIDER_UNAVAILABLE");
      assert.equal(visualsTask.failure.code, "PROVIDER_NOT_CONFIGURED");
      assert.equal(visualsTask.failure.class, "PROVIDER");

      const researchTask = detail.body.tasks.find((task) => task.stage === "RESEARCH");
      assert.equal(researchTask.status, "COMPLETED");
      assert.deepEqual({ ...researchTask.worker }, { workerKey: "worker-alpha-1", role: "production", state: "IDLE" });
      assert.equal(researchTask.evidence.productionVerified, 2);
      assert.deepEqual([...researchTask.evidence.artifactHashes].sort(), [HASH_RESEARCH, HASH_RESEARCH_SUMMARY].sort());

      assert.equal(detail.body.package.status, "NOT_SCHEDULED", "a completed task is not a completed package");
      assert.equal(detail.body.publishing.status, "NOT_SCHEDULED");
      assert.equal(detail.body.production.productionVerified, true);
      assert.equal(JSON.stringify(detail.body).includes(SECRET), false);

      const packageDetail = await owner(supertest(app).get(`/api/fleet/content-packages/${ALPHA_PACKAGE_RUN}`));
      assert.equal(packageDetail.body.package.completed, true);
      assert.equal(packageDetail.body.package.productionVerified, false);
      assert.equal(packageDetail.body.production.fixtureOnly, true);
      assert.equal(packageDetail.body.publishing.status, "NOT_SCHEDULED");
      assert.equal(packageDetail.body.publishing.verifiedReceipt, false);

      // ------------------------------------------------ L: missing / invalid
      const missing = await owner(supertest(app).get(`/api/fleet/content-packages/${MISSING_RUN}`));
      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, "CONTENT_PACKAGE_NOT_FOUND");
      const invalid = await owner(supertest(app).get("/api/fleet/content-packages/not-a-uuid"));
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.code, "CONTENT_PACKAGE_ID_INVALID");

      // ------------------------------------------------ J/K/N: evidence timeline
      const timeline = await owner(supertest(app).get(`/api/fleet/content-packages/${ALPHA_RUN}/evidence`));
      assert.equal(timeline.status, 200);
      assert.equal(timeline.body.packageId, ALPHA_RUN);
      assert.equal(timeline.body.events.length, 2);
      assert.deepEqual(timeline.body.events.map((event) => event.evidenceId), [EVIDENCE_RESEARCH, EVIDENCE_RESEARCH_SUMMARY]);
      assert.equal(timeline.body.summary.productionVerified, 2);
      assert.equal(timeline.body.summary.fixtures, 0);
      const researchEvent = timeline.body.events[0];
      assert.equal(researchEvent.artifactHash, HASH_RESEARCH);
      assert.equal(researchEvent.verificationLevel, "PRODUCTION_VERIFIED");
      assert.equal(researchEvent.productionVerified, true);
      assert.equal(researchEvent.handlerName, "research-brief-structurer");
      assert.equal(researchEvent.handlerVersion, "1.0.0");
      assert.equal(researchEvent.testFixture, false);
      assert.equal(researchEvent.validation.outcome, "PASSED");
      assert.deepEqual(researchEvent.validation.checks.map((check) => ({ ...check })), [
        { name: "document.readable", passed: true },
        { name: "document.min_words", passed: true },
      ]);
      assert.deepEqual([...researchEvent.refs.input.refs], ["director-stage://research/input-1"]);
      assert.deepEqual([...researchEvent.refs.output.refs], ["director-stage://research/output-1"]);
      assert.equal(researchEvent.refs.output.omitted, 1, "the /etc/passwd reference is dropped");
      assert.equal(JSON.stringify(timeline.body).includes("/etc/passwd"), false);
      assert.equal(JSON.stringify(timeline.body).includes(SECRET), false);
      assert.equal(JSON.stringify(timeline.body).includes("apiKey"), false);

      const fixtureTimeline = await owner(supertest(app).get(`/api/fleet/content-packages/${ALPHA_PACKAGE_RUN}/evidence`));
      assert.equal(fixtureTimeline.body.events.length, 1);
      const fixtureEvent = fixtureTimeline.body.events[0];
      assert.equal(fixtureEvent.testFixture, true);
      assert.equal(fixtureEvent.verificationLevel, "INTEGRATION_TESTED", "levels are preserved, never upgraded");
      assert.equal(fixtureEvent.productionVerified, false);
      assert.equal(fixtureEvent.artifactHash, HASH_PACKAGE);
      assert.equal(fixtureTimeline.body.summary.fixtures, 1);
      assert.equal(fixtureTimeline.body.summary.productionVerified, 0);
      assert.equal(fixtureTimeline.body.summary.fixtureOnly, true);

      const withoutFixtures = await owner(
        supertest(app).get(`/api/fleet/content-packages/${ALPHA_PACKAGE_RUN}/evidence?includeTestFixtures=false`)
      );
      assert.equal(withoutFixtures.body.events.length, 0, "fixtures can be excluded without inventing records");
      assert.equal(withoutFixtures.body.summary.fixtures, 1, "the summary still reports the real fixture count");

      const productionOnly = await owner(
        supertest(app).get(`/api/fleet/content-packages/${ALPHA_RUN}/evidence?verificationLevel=PRODUCTION_VERIFIED`)
      );
      assert.equal(productionOnly.body.events.length, 2);
      const packageOnly = await owner(supertest(app).get(`/api/fleet/content-packages/${ALPHA_RUN}/evidence?stage=PACKAGE`));
      assert.equal(packageOnly.body.events.length, 0, "a stage with no evidence stays empty");

      const evidenceCursorPage = await owner(
        supertest(app).get(`/api/fleet/content-packages/${ALPHA_RUN}/evidence?limit=1`)
      );
      assert.equal(evidenceCursorPage.body.events.length, 1);
      assert.ok(evidenceCursorPage.body.page.hasMore);
      const evidenceSecondPage = await owner(
        supertest(app).get(
          `/api/fleet/content-packages/${ALPHA_RUN}/evidence?limit=1&cursor=${encodeURIComponent(evidenceCursorPage.body.page.nextCursor)}`
        )
      );
      assert.deepEqual(evidenceSecondPage.body.events.map((event) => event.evidenceId), [EVIDENCE_RESEARCH_SUMMARY]);
      assert.equal(evidenceSecondPage.body.page.hasMore, false);

      const missingTimeline = await owner(supertest(app).get(`/api/fleet/content-packages/${MISSING_RUN}/evidence`));
      assert.equal(missingTimeline.status, 404);

      // ------------------------------------------------ M: Director isolation
      const betaList = await owner(supertest(app).get("/api/fleet/content-packages?directorId=director-beta"));
      assert.deepEqual(betaList.body.runs.map((run) => run.runId), [BETA_RUN_TIE, BETA_RUN]);
      const betaDetail = await owner(supertest(app).get(`/api/fleet/content-packages/${BETA_RUN}`));
      assert.equal(betaDetail.body.run.directorId, "director-beta");
      assert.ok(betaDetail.body.tasks.every((task) => task.taskId !== TASK_ALPHA_RESEARCH));
      const betaTimeline = await owner(supertest(app).get(`/api/fleet/content-packages/${BETA_RUN}/evidence`));
      assert.ok(betaTimeline.body.events.every((event) => event.taskId === TASK_BETA_PUBLISHING));
      assert.equal(JSON.stringify(betaTimeline.body).includes(EVIDENCE_RESEARCH), false);
      // The alpha run never exposes beta records in either direction.
      assert.equal(JSON.stringify(detail.body).includes(TASK_BETA_PUBLISHING), false);
      const alphaTimeline = await owner(supertest(app).get(`/api/fleet/content-packages/${ALPHA_RUN}/evidence`));
      assert.ok(alphaTimeline.body.events.every((event) => event.taskId === TASK_ALPHA_RESEARCH));
      assert.equal(JSON.stringify(alphaTimeline.body).includes(HASH_BETA), false);

      // ------------------------------------------------ N: DTO allowlists
      assert.deepEqual(Object.keys(alphaRun).sort(), [
        "createdAt", "directorId", "evidence", "package", "projectKey", "publishing",
        "runId", "state", "tasks", "title", "universeId", "updatedAt",
      ]);
      assert.deepEqual(Object.keys(researchEvent).sort(), [
        "artifactHash", "completedAt", "createdAt", "environment", "evidenceId", "evidenceType",
        "fencingToken", "handlerName", "handlerVersion", "productionVerified", "providerVerified",
        "refs", "stage", "startedAt", "taskId", "testFixture", "validation", "verificationLevel", "workerKey",
      ]);
      assert.equal(Object.keys(researchTask).includes("lastError"), false);
      assert.equal(Object.keys(researchTask).includes("input"), false);
    } finally {
      await pool.end().catch(() => {});
      await dropDisposableDatabase(POSTGRES_URL, created.databaseName).catch(() => {});
    }
  }
);
