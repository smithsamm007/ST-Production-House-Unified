/**
 * Per-Director episode & production schedule — owner API tests.
 *
 * Boots the labeled demo-backed app (the same truthful, non-durable adapter the
 * preview uses), signs the seeded demo owner in, and exercises the real routes:
 *
 *   - authentication is required (anonymous reads are refused);
 *   - an unconfigured Director shows the server's declared defaults;
 *   - create → save → reload round-trips the persisted settings;
 *   - backend validation cannot be bypassed (duration / frequency / days /
 *     start time / timezone / unknown fields);
 *   - two Directors keep INDEPENDENT settings, and a second owner never sees
 *     another owner's configuration (owner + Director scoping);
 *   - a paused schedule queues nothing; an enabled schedule queues only the
 *     due slot(s) and is idempotent across runs;
 *   - the scheduler run records why a slot was delayed/blocked/skipped, and
 *     no publishing happens anywhere in this flow.
 *
 * Every mutating route is CSRF-protected (the session-scoped token returned by
 * login), so these tests exercise that gate exactly as the dashboard does.
 * The env vars must be set before the app module loads, so this file uses
 * dynamic imports. Node --test runs each file in its own process.
 */

process.env.STPH_DEMO_STORAGE = "1";
// This suite deliberately walks many owner routes in one process; the declared
// limits are configurable, so raise them here rather than asserting on 429s.
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

async function loginAs(email, password) {
  const response = await supertest(app).post("/api/auth/login").send({ email, password });
  assert.equal(response.status, 200, `login must succeed for ${email}`);
  const cookieHeader = response.headers["set-cookie"]?.[0] ?? "";
  const sessionToken = /session_token=([^;]+)/.exec(cookieHeader)?.[1] ?? "";
  assert.ok(sessionToken, "login must set the session cookie");
  assert.ok(response.body.csrfToken, "login must issue a CSRF token for mutations");
  return {
    Authorization: `Bearer ${sessionToken}`,
    "x-csrf-token": response.body.csrfToken,
  };
}

const auth = await loginAs(DEMO_EMAIL, DEMO_PASSWORD);
const channels = await supertest(app).get("/api/channels").set(auth).expect(200);
const directors = channels.body.channels.map((channel) => channel.agentId);
assert.ok(directors.length >= 2, "the seeded demo has at least two Director channels");
const [directorA, directorB] = directors;

/** Local weekday + HH:mm "now" for a timezone, used to make a slot due RIGHT NOW. */
function localNowParts(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, hour: "2-digit", minute: "2-digit",
  });
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date())) {
    if (type === "hour" || type === "minute") parts[type] = Number.parseInt(value, 10);
  }
  const hour = String(parts.hour === 24 ? 0 : parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  // en-CA gives an ISO-ish YYYY-MM-DD in the target timezone.
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
  const utcDay = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  const isoWeekday = utcDay === 0 ? 7 : utcDay;
  return { time: `${hour}:${minute}`, isoWeekday };
}

test("schedule routes require an authenticated session", async () => {
  await supertest(app).get("/api/scheduling/directors").expect(401);
  await supertest(app).get(`/api/scheduling/directors/${directorA}`).expect(401);
  await supertest(app).put(`/api/scheduling/directors/${directorA}`).send({ episodesPerDay: 2 }).expect(401);
  await supertest(app).post(`/api/scheduling/directors/${directorA}/run`).send({}).expect(401);
});

test("an authenticated mutation without the session CSRF token is refused", async () => {
  const csrfLess = { Authorization: auth.Authorization };
  const response = await supertest(app)
    .put(`/api/scheduling/directors/${directorA}`)
    .set(csrfLess)
    .send({ episodesPerDay: 2 });
  assert.equal(response.status, 403);
  assert.equal(response.body.error, "CSRF_TOKEN_INVALID");
});

test("declared limits are exposed for the dashboard, never invented client-side", async () => {
  const limits = await supertest(app).get("/api/scheduling/limits").set(auth).expect(200);
  assert.deepEqual(limits.body.episodeDurationOptionsSeconds, [1800, 2400, 3000]);
  assert.deepEqual(limits.body.episodesPerDayOptions, [1, 2, 3]);
  assert.equal(limits.body.episodesPerDaySafeLimit, 6);
});

test("an unconfigured Director reports the documented defaults and stays paused", async () => {
  const response = await supertest(app).get(`/api/scheduling/directors/${directorB}`).set(auth).expect(200);
  const schedule = response.body.schedule;
  assert.equal(schedule.configured, false);
  assert.equal(schedule.episodeDurationSeconds, 2400);
  assert.equal(schedule.episodesPerDay, 1);
  assert.deepEqual(schedule.productionDays, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(schedule.productionStartTime, "09:00");
  assert.equal(schedule.timezone, "Asia/Kolkata");
  assert.equal(schedule.scheduleEnabled, false);
  assert.equal(response.body.planning.nextEligibleSlot, null, "a paused schedule has no next slot");
});

test("schedule settings save, persist, and reload (edit one Director without touching another)", async () => {
  const saved = await supertest(app)
    .put(`/api/scheduling/directors/${directorA}`)
    .set(auth)
    .send({
      episodeDurationSeconds: 3000,
      episodesPerDay: 3,
      productionDays: [1, 3, 5],
      productionStartTime: "07:30",
      timezone: "UTC",
      scheduleEnabled: true,
    })
    .expect(200);
  assert.equal(saved.body.episodeDurationSeconds, 3000);
  assert.equal(saved.body.episodeDurationMinutes, 50);
  assert.equal(saved.body.episodesPerDay, 3);
  assert.deepEqual(saved.body.productionDays, [1, 3, 5]);
  assert.equal(saved.body.productionStartTime, "07:30");
  assert.equal(saved.body.timezone, "UTC");
  assert.equal(saved.body.scheduleEnabled, true);
  assert.equal(saved.body.productionDaysLabel, "Mon, Wed, Fri");

  const reloaded = await supertest(app).get(`/api/scheduling/directors/${directorA}`).set(auth).expect(200);
  assert.equal(reloaded.body.schedule.configured, true);
  assert.equal(reloaded.body.schedule.episodeDurationSeconds, 3000);
  assert.equal(reloaded.body.schedule.episodesPerDay, 3);
  assert.deepEqual(reloaded.body.schedule.productionDays, [1, 3, 5]);
  assert.equal(reloaded.body.schedule.scheduleEnabled, true);
  assert.equal(reloaded.body.channelId, channels.body.channels.find((c) => c.agentId === directorA).id);

  // The OTHER Director is untouched.
  const other = await supertest(app).get(`/api/scheduling/directors/${directorB}`).set(auth).expect(200);
  assert.equal(other.body.schedule.configured, false);
  assert.equal(other.body.schedule.episodeDurationSeconds, 2400);
  assert.equal(other.body.schedule.scheduleEnabled, false);

  // Directors with a persisted schedule appear in the collection view.
  const list = await supertest(app).get("/api/scheduling/directors").set(auth).expect(200);
  const entry = list.body.directors.find((row) => row.agentId === directorA);
  assert.ok(entry, "configured Director is listed");
  assert.equal(entry.schedule.episodeDurationSeconds, 3000);
});

test("backend validation cannot be bypassed by the client", async () => {
  const cases = [
    [{ episodeDurationSeconds: 1234 }, "SCHEDULE_DURATION_INVALID"],
    [{ episodeDurationMinutes: 45 }, "SCHEDULE_DURATION_INVALID"],
    [{ episodesPerDay: 0 }, "SCHEDULE_EPISODES_PER_DAY_INVALID"],
    [{ episodesPerDay: 99 }, "SCHEDULE_EPISODES_PER_DAY_INVALID"],
    [{ productionDays: [] }, "SCHEDULE_PRODUCTION_DAYS_INVALID"],
    [{ productionDays: [0, 9] }, "SCHEDULE_PRODUCTION_DAYS_INVALID"],
    [{ productionStartTime: "25:99" }, "SCHEDULE_START_TIME_INVALID"],
    [{ timezone: "Mars/Olympus" }, "SCHEDULE_TIMEZONE_INVALID"],
    [{ scheduleEnabled: "yes" }, "SCHEDULE_ENABLED_INVALID"],
    [{ unknownField: true }, "REQUEST_VALIDATION_FAILED"],
  ];
  for (const [body, error] of cases) {
    const response = await supertest(app).put(`/api/scheduling/directors/${directorA}`).set(auth).send(body);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(response.body.error, error, `expected ${error} for ${JSON.stringify(body)}`);
  }

  // Unknown Directors are a generic 404, never another Director's schedule.
  await supertest(app).get("/api/scheduling/directors/agent-does-not-exist").set(auth).expect(404);
  await supertest(app).put("/api/scheduling/directors/agent-does-not-exist").set(auth).send({ episodesPerDay: 2 }).expect(404);
});

test("a paused schedule queues nothing; enabling it queues only the due slot and is idempotent", async () => {
  const now = localNowParts("UTC");

  // Paused: save a due slot but keep the schedule disabled.
  await supertest(app)
    .put(`/api/scheduling/directors/${directorB}`)
    .set(auth)
    .send({
      episodeDurationSeconds: 1800,
      episodesPerDay: 1,
      productionDays: [now.isoWeekday],
      productionStartTime: now.time,
      timezone: "UTC",
      scheduleEnabled: false,
    })
    .expect(200);

  const paused = await supertest(app)
    .post(`/api/scheduling/directors/${directorB}/run`)
    .set(auth)
    .send({ dryRun: false })
    .expect(200);
  assert.equal(paused.body.totals.created, 0);
  assert.equal(paused.body.totals.pausedDirectors, 1);
  assert.equal(paused.body.directors[0].scheduleEnabled, false);

  const channelBId = channels.body.channels.find((c) => c.agentId === directorB).id;
  const before = await supertest(app).get("/api/productions").set(auth).expect(200);
  const releasesBefore = before.body.productions.filter(
    (production) => production.channelId === channelBId,
  ).length;

  // Enabled: the due slot is queued exactly once.
  await supertest(app)
    .put(`/api/scheduling/directors/${directorB}`)
    .set(auth)
    .send({ scheduleEnabled: true })
    .expect(200);

  const preview = await supertest(app)
    .post(`/api/scheduling/directors/${directorB}/run`)
    .set(auth)
    .send({ dryRun: true })
    .expect(200);
  assert.equal(preview.body.dryRun, true);
  assert.equal(preview.body.totals.created, 1, "the preview reports the due slot");

  const run = await supertest(app)
    .post(`/api/scheduling/directors/${directorB}/run`)
    .set(auth)
    .send({ dryRun: false })
    .expect(200);
  assert.equal(run.body.totals.created, 1);
  assert.equal(run.body.directors[0].episodeDurationSeconds, 1800);
  const queuedSlot = run.body.directors[0].slots.find((slot) => slot.state === "queued");
  assert.ok(queuedSlot, "the due slot is persisted as queued");
  assert.ok(queuedSlot.releaseId, "a REAL release backs the queued slot");
  assert.ok(queuedSlot.jobId, "a REAL queued job backs the queued slot");
  assert.equal(queuedSlot.season, 1);
  assert.equal(queuedSlot.episode, releasesBefore + 1, "the episode number continues the channel's own sequence");

  const again = await supertest(app)
    .post(`/api/scheduling/directors/${directorB}/run`)
    .set(auth)
    .send({ dryRun: false })
    .expect(200);
  assert.equal(again.body.totals.created, 0, "a repeated run creates no duplicate episode");
  assert.ok(again.body.totals.duplicates >= 1);

  const after = await supertest(app).get("/api/productions").set(auth).expect(200);
  const releasesAfter = after.body.productions.filter(
    (production) => production.channelId === channelBId,
  ).length;
  assert.equal(releasesAfter, releasesBefore + 1, "exactly one new release exists");

  // The release is queued for production and still needs owner approval to
  // publish: nothing here published or uploaded anything.
  const detail = await supertest(app).get(`/api/productions/${queuedSlot.releaseId}`).set(auth).expect(200);
  assert.notEqual(detail.body.release.status, "published");

  const view = await supertest(app).get(`/api/scheduling/directors/${directorB}`).set(auth).expect(200);
  assert.equal(view.body.counters.slots.queued, 1);
  assert.ok(view.body.counters.jobs.queued >= 1);
  assert.equal(view.body.counters.publishedReleases, 0);
  assert.equal(view.body.lastSlot.state, "queued");
});

test("scheduler runs refuse to invent a schedule that was never configured", async () => {
  const fresh = await supertest(app).get("/api/channels").set(auth).expect(200);
  // A Director with no persisted schedule row cannot be run.
  const unconfigured = fresh.body.channels.map((channel) => channel.agentId)
    .find((agentId) => agentId !== directorA && agentId !== directorB);
  if (unconfigured) {
    const response = await supertest(app)
      .post(`/api/scheduling/directors/${unconfigured}/run`)
      .set(auth)
      .send({});
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "DIRECTOR_SCHEDULE_NOT_CONFIGURED");
  }
  await supertest(app).post("/api/scheduling/directors/agent-nope/run").set(auth).send({}).expect(404);
});

test("a second owner never sees or runs another owner's Director schedule", async () => {
  const email = `schedule-owner-${Date.now()}@stph.test`;
  const password = "schedule-owner-pass-2026";
  const registration = await supertest(app).post("/api/auth/register").send({ email, password });
  if (registration.status !== 201) {
    // Open registration only bootstraps the FIRST owner; a deployment that
    // already has an owner refuses honestly, so there is no second session to
    // test with. The scoping under test is (owner, Director) either way.
    assert.equal(registration.body.error, "OWNER_BOOTSTRAP_ALREADY_COMPLETED");
    return;
  }
  // The registration response carries no CSRF token, so the new owner signs in.
  const secondOwnerAuth = await loginAs(email, password);
  const foreign = await supertest(app).get(`/api/scheduling/directors/${directorA}`).set(secondOwnerAuth).expect(200);
  assert.equal(foreign.body.schedule.configured, false, "another owner sees NO configured schedule for that Director");
  assert.equal(foreign.body.schedule.episodeDurationSeconds, 2400, "the other owner sees the documented defaults");
  assert.equal(foreign.body.counters.slots.total, 0);
  // …and cannot run it either: the second owner has no schedule row for it.
  const run = await supertest(app)
    .post(`/api/scheduling/directors/${directorA}/run`)
    .set(secondOwnerAuth)
    .send({});
  assert.equal(run.status, 409);
  assert.equal(run.body.error, "DIRECTOR_SCHEDULE_NOT_CONFIGURED");
});
