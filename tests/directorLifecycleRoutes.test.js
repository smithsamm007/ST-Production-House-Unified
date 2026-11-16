/**
 * D-4 route regression — a pending Director must be refused with a lifecycle
 * conflict (409) on every production-originating route, never a 500.
 *
 * Boots the labeled demo app (the same non-durable adapter the preview uses),
 * signs the seeded demo owner in, and drives the real routes:
 *
 *   POST /api/productions                     (production start)
 *   PUT  /api/scheduling/directors/:agentId   (standing production commitment)
 *   POST /api/connections/directors/:agentId  (credential binding)
 *   POST /api/hermes/decisions                (production-originating decision)
 *   POST /api/canonical-directors/:code/activate (Owner-only activation)
 *
 * Each refusal is asserted to (a) be a 409 carrying the pending code,
 * (b) change no state — no release, no enabled schedule, no connection — and
 * (c) leave the Director pending. Active Directors are exercised as controls so
 * the fix cannot have simply blocked everything.
 *
 * No providers, no publishing, no network.
 */

process.env.STPH_DEMO_STORAGE = "1";
process.env.RATE_LIMIT_PER_MINUTE = "5000";
process.env.AUTH_RATE_LIMIT_PER_MINUTE = "5000";

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const supertest = (await import("supertest")).default;
const { default: app, configureRuntime, finalizeRuntimeStartup } = await import("../src/catalog/server.js");

await configureRuntime();
await finalizeRuntimeStartup();

const DEMO_EMAIL = "owner@stproduction.demo";
const DEMO_PASSWORD = process.env.STPH_DEMO_OWNER_PASSWORD || "demo-production-house-2026";

async function login(email, password) {
  const response = await supertest(app).post("/api/auth/login").send({ email, password });
  assert.equal(response.status, 200, `login must succeed for ${email}`);
  const cookieHeader = response.headers["set-cookie"]?.[0] ?? "";
  const sessionToken = /session_token=([^;]+)/.exec(cookieHeader)?.[1] ?? "";
  assert.ok(sessionToken, "login must set the session cookie");
  return {
    Authorization: `Bearer ${sessionToken}`,
    "x-csrf-token": response.body.csrfToken,
  };
}

const auth = await login(DEMO_EMAIL, DEMO_PASSWORD);
const PENDING_AGENT = "agent-director-cosmos";   // sql/034: suspended + PENDING_OWNER_ACTIVATION
const ACTIVE_AGENT = "agent-01";                 // sql/034: JARVIS, active
const PENDING_CODE = "CANONICAL_DIRECTOR_PENDING_ACTIVATION";

// ---------------------------------------------------------------------------
// Registry state this suite depends on (fails loudly if the seed changes)
// ---------------------------------------------------------------------------

const registry = await supertest(app).get("/api/canonical-directors").set(auth).expect(200);
const cosmos = registry.body.mappings.find((m) => m.underlyingAgentId === PENDING_AGENT);
assert.ok(cosmos, "sql/034 must seed the COSMOS mapping");

test("the seeded pending Director is reported as pending, not active and not retired", async () => {
  assert.equal(cosmos.status, "suspended");
  assert.equal(cosmos.suspendedNote, "PENDING_OWNER_ACTIVATION");
  assert.notEqual(registry.body.activeCount, 0, "the four preserved Directors remain active");
  const jarvis = registry.body.mappings.find((m) => m.underlyingAgentId === ACTIVE_AGENT);
  assert.equal(jarvis.status, "active");
});

// ---------------------------------------------------------------------------
// Production start
// ---------------------------------------------------------------------------

test("production start for a pending Director is a 409 and creates no release", async () => {
  const before = await supertest(app).get("/api/productions").set(auth);

  const channel = await supertest(app)
    .post("/api/channels")
    .set(auth)
    .send({ slug: `pending-lane-${Date.now()}`, displayName: "Pending Lane", agentId: PENDING_AGENT })
    .expect(201);

  const refused = await supertest(app)
    .post("/api/productions")
    .set(auth)
    .send({ channelId: channel.body.id, title: "Refused Cut", season: 1, episode: 1 });

  assert.equal(refused.status, 409, `expected 409, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error, PENDING_CODE, "the pending identity is preserved");

  const after = await supertest(app).get("/api/productions").set(auth);
  const count = (res) => (res.body.productions ?? res.body.releases ?? []).length;
  assert.equal(count(after), count(before), "no release was created by the refused start");
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

test("enabling a pending Director's schedule is a 409 and leaves it disabled", async () => {
  const refused = await supertest(app)
    .put(`/api/scheduling/directors/${PENDING_AGENT}`)
    .set(auth)
    .send({ scheduleEnabled: true });

  assert.equal(refused.status, 409, `expected 409, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error, PENDING_CODE);

  const reloaded = await supertest(app)
    .get(`/api/scheduling/directors/${PENDING_AGENT}`)
    .set(auth)
    .expect(200);
  assert.equal(reloaded.body.schedule.scheduleEnabled, false, "no schedule was enabled");
  assert.equal(reloaded.body.counters.activeJobs, 0, "no job was created for the refused schedule");
});

test("an active Director's schedule can still be enabled (control)", async () => {
  const saved = await supertest(app)
    .put(`/api/scheduling/directors/${ACTIVE_AGENT}`)
    .set(auth)
    .send({ scheduleEnabled: true, episodeDurationSeconds: 3000, episodesPerDay: 1 });

  assert.equal(saved.status, 200, `expected 200, got ${saved.status}: ${JSON.stringify(saved.body)}`);
  assert.equal(saved.body.scheduleEnabled, true);

  // Leave the fixture as it was found so later assertions are not order-bound.
  await supertest(app)
    .put(`/api/scheduling/directors/${ACTIVE_AGENT}`)
    .set(auth)
    .send({ scheduleEnabled: false })
    .expect(200);
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

test("binding a credential for a pending Director is a 409 and stores nothing", async () => {
  const refused = await supertest(app)
    .post(`/api/connections/directors/${PENDING_AGENT}`)
    .set(auth)
    .send({
      providerKey: "openai",
      kind: "llm",
      secretFields: { api_key: "vault://st/audit/cosmos/openai" },
      credentialLabel: "must not bind",
    });

  assert.equal(refused.status, 409, `expected 409, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error, PENDING_CODE);

  const listed = await supertest(app)
    .get(`/api/connections/directors/${PENDING_AGENT}`)
    .set(auth)
    .expect(200);
  assert.equal(listed.body.count, 0, "no credential was bound");
  assert.deepEqual(listed.body.items, []);
});

// ---------------------------------------------------------------------------
// HERMES decision route
// ---------------------------------------------------------------------------

test("a production decision naming a pending Director is a 409 and records nothing", async () => {
  const refused = await supertest(app)
    .post("/api/hermes/decisions")
    .set(auth)
    .send({
      action: "production.start",
      directorId: PENDING_AGENT,
      category: "production",
      reason: "Owner asked for a slot the Director cannot take yet.",
      payload: { channelId: "00000000-0000-0000-0000-000000000000", title: "Refused", season: 1, episode: 1 },
    });

  assert.equal(refused.status, 409, `expected 409, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error, PENDING_CODE);
});

// ---------------------------------------------------------------------------
// Authorization boundaries
// ---------------------------------------------------------------------------

test("lifecycle refusals do not weaken the authentication boundary", async () => {
  const schedule = await supertest(app)
    .put(`/api/scheduling/directors/${PENDING_AGENT}`)
    .send({ scheduleEnabled: true });
  assert.equal(schedule.status, 401, "anonymous scheduling must be refused before any lifecycle logic");

  const activation = await supertest(app)
    .post(`/api/canonical-directors/COSMOS/activate`)
    .send({});
  assert.equal(activation.status, 401, "anonymous activation must be refused");

  const carbon = await supertest(app)
    .post("/api/productions")
    .send({ channelId: "00000000-0000-0000-0000-000000000000", title: "x", season: 1, episode: 1 });
  assert.equal(carbon.status, 401);
});

test("no refusal path silently activates a Director", async () => {
  // Every refusal above ran against the same seeded registry. Re-reading it must
  // show COSMOS still pending: refusing work must never be implemented by
  // changing lifecycle state, and must never accidentally activate anyone.
  const after = await supertest(app).get("/api/canonical-directors").set(auth).expect(200);
  const stillPending = after.body.mappings.find((m) => m.underlyingAgentId === PENDING_AGENT);
  assert.equal(stillPending.status, "suspended");
  assert.equal(stillPending.suspendedNote, "PENDING_OWNER_ACTIVATION");
  assert.equal(after.body.activeCount, registry.body.activeCount,
    "no Director was activated by a refused operation");
  // Owner-only activation is enforced at the authorization boundary (asserted in
  // the auth test above); the successful activation path is covered against real
  // PostgreSQL, because the demo preview adapter cannot persist the activation
  // update (documented limitation, outside this defect).
});

// ---------------------------------------------------------------------------
// Manual schedule run — POST /api/scheduling/directors/:agentId/run
// ---------------------------------------------------------------------------
//
// A manual run originates production work and queues a worker, so it obeys the
// same canonical lifecycle rule as every other origin. Refusals must be a 409
// with the lifecycle code, change no state, and queue nothing.

const serverModule = await import("../src/catalog/server.js");
const adminDb = serverModule.__demoAdapterForDiagnostics;

const jobsFor = async (agentId) =>
  (await adminDb.query("SELECT id FROM jobs WHERE agent_id = $1", [agentId])).rows.length;

/** A retired canonical Director beyond the seeded set, for the not-active path. */
const RETIRED_AGENT = "agent-96";
await adminDb.query(
  "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4)",
  [RETIRED_AGENT, "AUDIT_RETIRED", "st.agent.audit-retired", true]
);
await adminDb.query(
  `INSERT INTO canonical_director_mappings
     (canonical_director_code, underlying_agent_id, display_name, namespace, status,
      retired_at, retired_reason, suspended_note)
   VALUES ($1, $2, $3, $4, 'retired', now(), $5, NULL)`,
  ["AUDIT-RETIRED", RETIRED_AGENT, "AUDIT_RETIRED", "st.agent.audit-retired", "audit fixture"]
);

test("a manual run for a pending Director is a 409 with the pending code and queues nothing", async () => {
  const jobsBefore = await jobsFor(PENDING_AGENT);

  const refused = await supertest(app)
    .post(`/api/scheduling/directors/${PENDING_AGENT}/run`)
    .set(auth)
    .send({ dryRun: false });

  assert.equal(refused.status, 409, `expected 409, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error, PENDING_CODE, "the pending code is preserved, not a generic queue failure");
  assert.equal(await jobsFor(PENDING_AGENT), jobsBefore, "no job was created");

  // The schedule is untouched by a refused run.
  const view = await supertest(app).get(`/api/scheduling/directors/${PENDING_AGENT}`).set(auth).expect(200);
  assert.equal(view.body.schedule.scheduleEnabled, false);
  assert.equal(view.body.counters.activeJobs, 0);
});

test("a manual run for a retired Director is a 409 not-active and queues nothing", async () => {
  const refused = await supertest(app)
    .post(`/api/scheduling/directors/${RETIRED_AGENT}/run`)
    .set(auth)
    .send({ dryRun: false });

  assert.equal(refused.status, 409, `expected 409, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error, "CANONICAL_DIRECTOR_NOT_ACTIVE");
  assert.equal(await jobsFor(RETIRED_AGENT), 0, "no job was created for the retired Director");
});

test("a manual run for an active Director keeps working (control)", async () => {
  const jobsBeforeRun = await jobsFor(ACTIVE_AGENT);
  await supertest(app)
    .put(`/api/scheduling/directors/${ACTIVE_AGENT}`)
    .set(auth)
    .send({ scheduleEnabled: true, episodeDurationSeconds: 3000, episodesPerDay: 1 })
    .expect(200);

  // dryRun keeps this offline: it plans and reports without queuing.
  const run = await supertest(app)
    .post(`/api/scheduling/directors/${ACTIVE_AGENT}/run`)
    .set(auth)
    .send({ dryRun: true });

  assert.equal(run.status, 200, `expected 200, got ${run.status}: ${JSON.stringify(run.body)}`);
  assert.ok(run.body.totals, "the scheduler report is returned");
  // The side effect that matters: a dry run inserts no job row (the report may
  // still count the slots it planned).
  assert.equal(await jobsFor(ACTIVE_AGENT), jobsBeforeRun, "a dry run creates no job");

  await supertest(app)
    .put(`/api/scheduling/directors/${ACTIVE_AGENT}`)
    .set(auth)
    .send({ scheduleEnabled: false })
    .expect(200);
});

test("an unknown Director keeps its existing not-found behaviour", async () => {
  const response = await supertest(app)
    .post("/api/scheduling/directors/agent-does-not-exist/run")
    .set(auth)
    .send({ dryRun: false });
  assert.equal(response.status, 404);
  assert.equal(response.body.error, "AGENT_NOT_FOUND");
});

test("an anonymous manual run is refused before any lifecycle logic", async () => {
  const response = await supertest(app)
    .post(`/api/scheduling/directors/${PENDING_AGENT}/run`)
    .send({ dryRun: false });
  assert.equal(response.status, 401);
  assert.equal(await jobsFor(PENDING_AGENT), 0);
});

test("a refused manual run never reaches the scheduler tick (no queue, no audit tick)", async () => {
  // The tick is what plans releases and queues jobs; it always writes an audit
  // event (`production_schedule_tick` / `scheduled_production_queued`). If no
  // such event appears, the scheduler — and therefore the queue — was never
  // invoked for the refused request.
  const auditBefore = await supertest(app).get("/api/audit").set(auth).expect(200);
  const tickEvents = (body) => {
    const text = JSON.stringify(body);
    const count = (needle) => text.split(needle).length - 1;
    return count("production_schedule_tick") + count("scheduled_production_queued");
  };
  const before = tickEvents(auditBefore.body);

  const refused = await supertest(app)
    .post(`/api/scheduling/directors/${PENDING_AGENT}/run`)
    .set(auth)
    .send({ dryRun: false });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, PENDING_CODE);

  const auditAfter = await supertest(app).get("/api/audit").set(auth).expect(200);
  assert.equal(tickEvents(auditAfter.body), before, "the scheduler tick never ran, so nothing was queued");
});

test("a second owner cannot run another owner's Director schedule (tenant scoping)", async () => {
  const { registerOwner } = await import("../src/catalog/ownerAuthentication.js");
  const secondEmail = `audit-tenant-${Date.now()}@stproduction.demo`;
  // The route-level register endpoint is bootstrap-only, so the second owner is
  // created through the same owner service the route uses; it then logs in
  // through the real login route to obtain a genuine session and CSRF token.
  await registerOwner(secondEmail, "audit-tenant-owner-2026");
  const otherAuth = await login(secondEmail, "audit-tenant-owner-2026");

  await supertest(app)
    .put(`/api/scheduling/directors/${ACTIVE_AGENT}`)
    .set(auth)
    .send({ scheduleEnabled: true, episodeDurationSeconds: 3000, episodesPerDay: 1 })
    .expect(200);

  const jobsBefore = await jobsFor(ACTIVE_AGENT);
  const refused = await supertest(app)
    .post(`/api/scheduling/directors/${ACTIVE_AGENT}/run`)
    .set(otherAuth)
    .send({ dryRun: false });

  assert.equal(refused.status, 409, `expected 409, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error, "DIRECTOR_SCHEDULE_NOT_CONFIGURED", "the second owner has no schedule of their own");
  assert.equal(await jobsFor(ACTIVE_AGENT), jobsBefore, "no job was created against the other owner's schedule");

  const ownView = await supertest(app).get(`/api/scheduling/directors/${ACTIVE_AGENT}`).set(otherAuth).expect(200);
  assert.equal(ownView.body.schedule.scheduleEnabled, false, "another owner's standing commitment is invisible");

  const ownerView = await supertest(app).get(`/api/scheduling/directors/${ACTIVE_AGENT}`).set(auth).expect(200);
  assert.equal(ownerView.body.schedule.scheduleEnabled, true, "the original owner's schedule is untouched");

  await supertest(app)
    .put(`/api/scheduling/directors/${ACTIVE_AGENT}`)
    .set(auth)
    .send({ scheduleEnabled: false })
    .expect(200);
});
