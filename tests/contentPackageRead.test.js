/**
 * S-M18-01 — durable content package read model: DTO, cursor and filter unit tests.
 *
 * Pure functions only: no database, no network. The PostgreSQL projection itself
 * is exercised in tests/contentPackageRuns.integration.js.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ContentPackageQueryError,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  failureOf,
  parseEvidenceFilters,
  parseLimit,
  parseRunFilters,
  sanitizeRefs,
  sanitizeValidation,
} from "../src/fleet/contentPackageReadRepository.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);

test("cursor round-trips the exact timestamp and id", () => {
  const cursor = encodeCursor("2026-11-21T05:00:00.123Z", UUID_A);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(cursor), { time: "2026-11-21T05:00:00.123Z", id: UUID_A });
  assert.equal(decodeCursor(undefined), null);
  assert.equal(decodeCursor(""), null);
});

test("malformed cursors are rejected with an allowlisted code", () => {
  const garbage = Buffer.from(JSON.stringify({ t: "not-a-date", id: UUID_A })).toString("base64url");
  const wrongId = Buffer.from(JSON.stringify({ t: "2026-11-21T05:00:00.000Z", id: "pkg-1" })).toString("base64url");
  for (const value of ["nope-not-base64-json", garbage, wrongId, "x".repeat(500)]) {
    assert.throws(
      () => decodeCursor(value),
      (error) => error instanceof ContentPackageQueryError && error.code === "CURSOR_INVALID" && error.status === 400
    );
  }
});

test("limit parsing is bounded and deterministic", () => {
  assert.equal(parseLimit(undefined), 25);
  assert.equal(parseLimit("1"), 1);
  assert.equal(parseLimit(String(MAX_LIMIT)), MAX_LIMIT);
  for (const value of ["0", "101", "1.5", "-1", "abc", " 5", "9999"]) {
    assert.throws(
      () => parseLimit(value),
      (error) => error.code === "QUERY_INVALID" && error.status === 400
    );
  }
});

test("run filters accept only known enumerations and ordered timestamps", () => {
  const parsed = parseRunFilters({
    directorId: "director-alpha",
    state: "IN_PRODUCTION",
    stage: "PACKAGE",
    taskStatus: "COMPLETED",
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-21T00:00:00Z",
    limit: "10",
  });
  assert.equal(parsed.directorId, "director-alpha");
  assert.equal(parsed.state, "IN_PRODUCTION");
  assert.equal(parsed.stage, "PACKAGE");
  assert.equal(parsed.taskStatus, "COMPLETED");
  assert.equal(parsed.limit, 10);

  assert.throws(() => parseRunFilters({ state: "PUBLISHED" }), (error) => error.code === "QUERY_INVALID");
  assert.throws(() => parseRunFilters({ stage: "RENDER" }), (error) => error.code === "QUERY_INVALID");
  assert.throws(() => parseRunFilters({ taskStatus: "PENDING" }), (error) => error.code === "QUERY_INVALID");
  assert.throws(() => parseRunFilters({ directorId: "Director Alpha" }), (error) => error.code === "QUERY_INVALID");
  assert.throws(
    () => parseRunFilters({ from: "2026-11-21T00:00:00Z", to: "2026-11-01T00:00:00Z" }),
    (error) => error.code === "QUERY_INVALID"
  );
  assert.throws(() => parseRunFilters({ from: "yesterday" }), (error) => error.code === "QUERY_INVALID");
});

test("evidence filters keep fixtures by default and reject unknown levels", () => {
  assert.equal(parseEvidenceFilters({}).includeTestFixtures, true);
  assert.equal(parseEvidenceFilters({ includeTestFixtures: "false" }).includeTestFixtures, false);
  assert.equal(parseEvidenceFilters({ verificationLevel: "PRODUCTION_VERIFIED" }).verificationLevel, "PRODUCTION_VERIFIED");
  assert.throws(() => parseEvidenceFilters({ verificationLevel: "TRUST_ME" }), (error) => error.code === "QUERY_INVALID");
});

test("references are projected only for opaque known schemes", () => {
  const kept = sanitizeRefs([
    "director-stage://research/abc123",
    "sha256:deadbeef",
    "/etc/passwd",
    "/srv/stph/artifacts/secret.bin",
    "file:///tmp/leak",
    "vault://stph/director/token",
    "https://example.test/ref",
    42,
  ]);
  assert.deepEqual([...kept.refs], ["director-stage://research/abc123", "sha256:deadbeef"]);
  assert.equal(kept.omitted, 6);
  assert.deepEqual([...sanitizeRefs(null).refs], []);
});

test("validation projections drop free-text detail and count unparsed entries", () => {
  const sanitized = sanitizeValidation({
    checkpoint: "research:abcd",
    checks: [
      { name: "document.readable", passed: true, detail: "/home/runner/private/path" },
      { name: "document.min_words", passed: false, detail: "secret-material" },
      { detail: "no name, dropped" },
    ],
  });
  assert.deepEqual(
    sanitized.checks.map((check) => ({ ...check })),
    [
      { name: "document.readable", passed: true },
      { name: "document.min_words", passed: false },
    ]
  );
  assert.equal(sanitized.failed, 1);
  assert.equal(sanitized.omitted, 1);
  assert.equal(sanitized.outcome, "FAILED");
  assert.equal(sanitizeValidation({}).outcome, "NOT_RECORDED");
  assert.equal(sanitizeValidation({ checks: [{ name: "ok", passed: true }] }).outcome, "PASSED");
});

test("failure classification exposes only the known code and its class", () => {
  assert.deepEqual({ ...failureOf("PROVIDER_NOT_CONFIGURED: no credential slot") }, {
    code: "PROVIDER_NOT_CONFIGURED",
    class: "PROVIDER",
    providerState: null,
  });
  assert.equal(failureOf("LEASE_LOST: fencing token 4 rejected").class, "TRANSIENT");
  assert.equal(failureOf("UNSUPPORTED_STAGE: VISUALS").class, "PERMANENT");
  assert.deepEqual({ ...failureOf("connection reset by peer /etc/private") }, {
    code: "FAILURE_RECORDED",
    class: null,
    providerState: null,
  });
  assert.equal(failureOf(null), null);
  // The free-text message never survives the projection.
  assert.equal(JSON.stringify(failureOf("STAGE_TIMEOUT: /srv/private/path")).includes("/srv"), false);
});
