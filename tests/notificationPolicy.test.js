/**
 * D6 unit tests — notification policy and reporting schedule.
 *
 * No database, no provider. These prove the rules that the PostgreSQL
 * acceptance suite then exercises end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERY_ERROR_CLASS,
  NOTIFICATION_EVENT_TYPE,
  NOTIFICATION_PRIORITY,
  PRIORITY_ORDER,
  RETRY_LIMITS,
  buildNotificationEvent,
  classifyDeliveryError,
  computeBackoffSeconds,
  notificationIdempotencyKey,
  priorityForEventType,
  sanitizeNotificationPayload,
} from "../src/notifications/notificationPolicy.js";
import {
  assertTimeZone,
  localDateString,
  localDateTimeParts,
  nextRunAt,
  windowForReportDate,
} from "../src/reporting/reportSchedule.js";
import {
  canonicalJson,
  hashReportPayload,
  verifyReportEvidenceHash,
} from "../src/reporting/dailyReportGenerator.js";

const OWNER_ID = "11111111-2222-4333-8444-555555555555";

test("notification priority is derived from the event class and never downgraded", () => {
  assert.equal(priorityForEventType(NOTIFICATION_EVENT_TYPE.SECURITY_ALERT), NOTIFICATION_PRIORITY.CRITICAL);
  assert.equal(priorityForEventType(NOTIFICATION_EVENT_TYPE.PUBLISHING_FAILED), NOTIFICATION_PRIORITY.CRITICAL);
  assert.equal(priorityForEventType(NOTIFICATION_EVENT_TYPE.OWNER_APPROVAL_REQUEST), NOTIFICATION_PRIORITY.HIGH);
  assert.equal(priorityForEventType(NOTIFICATION_EVENT_TYPE.FORGE_TASK_COMPLETED), NOTIFICATION_PRIORITY.NORMAL);
  assert.equal(priorityForEventType(NOTIFICATION_EVENT_TYPE.DAILY_FORGE_REPORT), NOTIFICATION_PRIORITY.LOW);
  assert.ok(PRIORITY_ORDER.CRITICAL < PRIORITY_ORDER.LOW);
  assert.throws(() => priorityForEventType("NOT_A_TYPE"), /Unknown notification event type/);

  const escalated = buildNotificationEvent({
    eventType: NOTIFICATION_EVENT_TYPE.OWNER_APPROVAL_REQUEST,
    priority: NOTIFICATION_PRIORITY.CRITICAL,
    ownerId: OWNER_ID,
    idempotencyKey: "unit:priority:escalate",
    payload: { message: "repeated" },
  });
  assert.equal(escalated.priority, NOTIFICATION_PRIORITY.CRITICAL);

  const downgradeAttempt = buildNotificationEvent({
    eventType: NOTIFICATION_EVENT_TYPE.SECURITY_ALERT,
    priority: NOTIFICATION_PRIORITY.LOW,
    ownerId: OWNER_ID,
    idempotencyKey: "unit:priority:downgrade",
    payload: {},
  });
  assert.equal(downgradeAttempt.priority, NOTIFICATION_PRIORITY.CRITICAL);
});

test("bounded exponential backoff grows, stays bounded and jitters within the configured ratio", () => {
  const fixed = computeBackoffSeconds({ attempts: 1, random: () => 0.5 });
  const second = computeBackoffSeconds({ attempts: 2, random: () => 0.5 });
  const third = computeBackoffSeconds({ attempts: 3, random: () => 0.5 });
  assert.equal(fixed, RETRY_LIMITS.BASE_SECONDS);
  assert.equal(second, RETRY_LIMITS.BASE_SECONDS * 2);
  assert.equal(third, RETRY_LIMITS.BASE_SECONDS * 4);

  const maxed = computeBackoffSeconds({ attempts: 40, random: () => 0.5 });
  assert.equal(maxed, RETRY_LIMITS.MAX_SECONDS);

  const low = computeBackoffSeconds({ attempts: 2, random: () => 0 });
  const high = computeBackoffSeconds({ attempts: 2, random: () => 1 });
  const raw = RETRY_LIMITS.BASE_SECONDS * 2;
  assert.equal(low, Math.round(raw * (1 - RETRY_LIMITS.JITTER_RATIO)));
  assert.equal(high, Math.round(raw * (1 + RETRY_LIMITS.JITTER_RATIO)));
  assert.ok(computeBackoffSeconds({ attempts: 0, baseSeconds: 1, random: () => 0 }) >= 1);
});

test("delivery errors are classified for retry decisions", () => {
  assert.equal(classifyDeliveryError({ status: 429 }), DELIVERY_ERROR_CLASS.RATE_LIMITED);
  assert.equal(classifyDeliveryError({ status: 401 }), DELIVERY_ERROR_CLASS.AUTHENTICATION);
  assert.equal(classifyDeliveryError({ status: 503 }), DELIVERY_ERROR_CLASS.TRANSIENT);
  assert.equal(classifyDeliveryError({ status: 422 }), DELIVERY_ERROR_CLASS.PERMANENT);
  assert.equal(classifyDeliveryError({ code: "ECONNRESET" }), DELIVERY_ERROR_CLASS.TRANSIENT);
  assert.equal(classifyDeliveryError({ code: "UNCONFIGURED" }), DELIVERY_ERROR_CLASS.UNCONFIGURED);
  assert.equal(
    classifyDeliveryError({ errorClass: DELIVERY_ERROR_CLASS.PERMANENT, status: 503 }),
    DELIVERY_ERROR_CLASS.PERMANENT
  );
  assert.equal(classifyDeliveryError(new Error("boom")), DELIVERY_ERROR_CLASS.TRANSIENT);
});

test("notification payloads never carry credentials and are bounded", () => {
  const sanitized = sanitizeNotificationPayload({
    eventType: "PUBLISHING_FAILED",
    apiKey: "sk-live-should-never-survive",
    password: "hunter2",
    authorization: "Bearer abc.def.ghi",
    nested: { token: "tok_123", client_secret: "shh", keep: "visible" },
    message: "Upload rejected with https://user:pass@example.test/hook",
    long: "x".repeat(900),
    list: Array.from({ length: 80 }, (_, index) => `entry-${index}`),
  });

  const serialized = JSON.stringify(sanitized);
  assert.ok(!serialized.includes("sk-live"));
  assert.ok(!serialized.includes("hunter2"));
  assert.ok(!serialized.includes("tok_123"));
  assert.ok(!serialized.includes("shh"));
  assert.ok(!serialized.includes("user:pass"));
  assert.equal(sanitized.nested.keep, "visible");
  assert.equal(sanitized.apiKey, undefined);
  assert.equal(sanitized.long.length <= 501, true);
  assert.equal(sanitized.list.length, 50);
});

test("event construction requires an authenticated Owner scope and a deterministic key", () => {
  assert.throws(
    () =>
      buildNotificationEvent({
        eventType: NOTIFICATION_EVENT_TYPE.FORGE_TASK_COMPLETED,
        idempotencyKey: "unit:owner:missing",
        payload: {},
      }),
    /Owner-scoped notifications require/
  );

  const event = buildNotificationEvent({
    eventType: NOTIFICATION_EVENT_TYPE.FORGE_TASK_FAILED,
    ownerId: OWNER_ID,
    taskRef: "task-42",
    idempotencyKey: "unit:event:valid",
    payload: { message: "failed", token: "nope" },
  });
  assert.equal(event.priority, NOTIFICATION_PRIORITY.HIGH);
  assert.equal(event.payload.token, undefined);
  assert.equal(event.ownerId, OWNER_ID);

  const directorEvent = buildNotificationEvent({
    eventType: NOTIFICATION_EVENT_TYPE.DIRECTOR_PRODUCTION_FAILED,
    recipient: "director:agent-01",
    directorId: "agent-01",
    idempotencyKey: "unit:event:director",
    payload: { message: "render failed" },
  });
  assert.equal(directorEvent.recipient, "director:agent-01");
  assert.equal(directorEvent.ownerId, null);

  assert.throws(
    () =>
      buildNotificationEvent({
        eventType: NOTIFICATION_EVENT_TYPE.FORGE_TASK_COMPLETED,
        ownerId: OWNER_ID,
        idempotencyKey: "short",
        payload: {},
      }),
    /idempotency key/i
  );

  assert.equal(
    notificationIdempotencyKey("report", "daily", "2026-11-20"),
    notificationIdempotencyKey("report", "daily", "2026-11-20")
  );
  assert.notEqual(
    notificationIdempotencyKey("report", "daily", "2026-11-20"),
    notificationIdempotencyKey("report", "daily", "2026-11-21")
  );
  assert.throws(() => notificationIdempotencyKey("a"), /too short/);
});

test("08:00 Asia/Kolkata resolves to the correct UTC instant and the next day after the window", () => {
  const sameDay = nextRunAt({
    from: new Date("2026-03-01T00:00:00.000Z"),
    timeZone: "Asia/Kolkata",
    hour: 8,
    minute: 0,
  });
  assert.equal(sameDay.toISOString(), "2026-03-01T02:30:00.000Z");

  const nextDay = nextRunAt({
    from: new Date("2026-03-01T03:00:00.000Z"),
    timeZone: "Asia/Kolkata",
    hour: 8,
    minute: 0,
  });
  assert.equal(nextDay.toISOString(), "2026-03-02T02:30:00.000Z");

  const boundary = localDateString(new Date("2026-03-01T19:00:00.000Z"), "Asia/Kolkata");
  assert.equal(boundary, "2026-03-02", "19:00Z is already the next day in IST");

  const window = windowForReportDate({ reportDate: "2026-03-02", timeZone: "Asia/Kolkata" });
  assert.equal(window.windowStart.toISOString(), "2026-03-01T18:30:00.000Z");
  assert.equal(window.windowEnd.toISOString(), "2026-03-02T18:30:00.000Z");

  assert.throws(() => assertTimeZone("Mars/Olympus"), /REPORT_TIMEZONE_INVALID/);
});

test("scheduled local time is honoured through a DST transition in another zone", () => {
  const beforeDst = nextRunAt({
    from: new Date("2026-03-07T00:00:00.000Z"),
    timeZone: "America/New_York",
    hour: 8,
    minute: 0,
  });
  assert.equal(localDateTimeParts(beforeDst, "America/New_York").hour, 8);

  const onDst = nextRunAt({
    from: new Date("2026-03-08T00:00:00.000Z"),
    timeZone: "America/New_York",
    hour: 8,
    minute: 0,
  });
  assert.equal(localDateTimeParts(onDst, "America/New_York").hour, 8);
  assert.equal(onDst.toISOString(), "2026-03-08T12:00:00.000Z");
});

test("report canonical JSON and evidence hash are reproducible and tamper-evident", () => {
  const payload = { z: 1, a: { b: [1, 2, 3], c: "text" }, reportDate: "2026-11-20" };
  assert.equal(canonicalJson(payload), canonicalJson({ reportDate: "2026-11-20", a: { c: "text", b: [1, 2, 3] }, z: 1 }));
  const hash = hashReportPayload(payload);
  assert.match(hash, /^[a-f0-9]{64}$/);

  const stored = { ...payload, evidenceHash: hash };
  assert.equal(verifyReportEvidenceHash(stored), true);
  assert.equal(verifyReportEvidenceHash({ ...stored, reportDate: "2026-11-21" }), false);
  assert.equal(verifyReportEvidenceHash({ ...payload }), false);
});
