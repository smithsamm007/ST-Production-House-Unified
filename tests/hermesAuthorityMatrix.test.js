/**
 * Hermes authority matrix tests (Issue #166).
 *
 * Scope: the frozen matrix's classification behavior. These tests prove the
 * BOUNDARY, not that any real execution occurred — no providers, no jobs,
 * no network (Rule 1 honest scope).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  HERMES_AUTHORITY_MATRIX,
  AUTHORITY_AUTONOMOUS,
  AUTHORITY_OWNER_POLICY,
  AUTHORITY_PROHIBITED,
  classifyHermesAction,
  classifyHermesActions,
  canHermesExecute,
} from "../src/manager/authorityMatrix.js";

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-09-24T12:00:00.000Z");

test("matrix is frozen and closed — no runtime extension possible", () => {
  assert.ok(Object.isFrozen(HERMES_AUTHORITY_MATRIX));
  const before = Object.keys(HERMES_AUTHORITY_MATRIX).length;
  assert.throws(() => {
    "use strict";
    HERMES_AUTHORITY_MATRIX["new.power"] = AUTHORITY_AUTONOMOUS;
  });
  assert.equal(Object.keys(HERMES_AUTHORITY_MATRIX).length, before);
});

test("the owner's authority table is encoded exactly", () => {
  // Autonomous set (sampling the whole class boundaries):
  for (const action of [
    "production.start", "production.stop", "production.retry",
    "provider.select", "provider.rotate_failed", "provider.use_fallback",
    "schedule.change", "schedule.prioritize_director",
    "resources.rebalance_workload", "resources.send_to_dlq",
    "production.qc_run", "production.generate_media",
  ]) {
    assert.equal(HERMES_AUTHORITY_MATRIX[action], AUTHORITY_AUTONOMOUS, action);
  }
  // Owner-policy controlled:
  for (const action of [
    "publishing.publish_publicly", "publishing.change_destination",
    "data.delete_critical", "spending.commit",
  ]) {
    assert.equal(HERMES_AUTHORITY_MATRIX[action], AUTHORITY_OWNER_POLICY, action);
  }
  // Prohibited:
  for (const action of [
    "secrets.read_values", "secrets.export_keys", "credentials.change_owner",
    "security.disable_controls", "audit.modify_ledger", "approvals.bypass",
  ]) {
    assert.equal(HERMES_AUTHORITY_MATRIX[action], AUTHORITY_PROHIBITED, action);
  }
});

test("classification: autonomous action is executable", () => {
  const result = classifyHermesAction("production.start");
  assert.equal(result.authority, AUTHORITY_AUTONOMOUS);
  assert.equal(result.executable, true);
  assert.equal(result.reason, "AUTONOMOUS_WITHIN_OWNER_LIMITS");
});

test("classification: unknown actions fail closed to PROHIBITED", () => {
  // Empty/malformed input throws (HERMES_ACTION_REQUIRED); unknown but
  // well-formed strings classify as PROHIBITED (fail closed).
  for (const hostile of ["deploy.missiles", "self.grant_owner", "audit.erase"]) {
    const result = classifyHermesAction(hostile);
    assert.equal(result.authority, AUTHORITY_PROHIBITED, hostile);
    assert.equal(result.executable, false);
  }
  assert.throws(() => classifyHermesAction(undefined), /HERMES_ACTION_REQUIRED/);
  assert.throws(() => classifyHermesAction(42), /HERMES_ACTION_REQUIRED/);
});

test("classification: prohibited stays prohibited even WITH an approval", () => {
  const result = classifyHermesAction("secrets.read_values");
  assert.equal(canHermesExecute(result, { ownerId: "owner-1", expiresAt: FUTURE }, { now: NOW }), false);
  const bypass = classifyHermesAction("approvals.bypass");
  assert.equal(canHermesExecute(bypass, { ownerId: "owner-1", expiresAt: FUTURE }, { now: NOW }), false);
});

test("owner-policy actions execute only with an unexpired approval", () => {
  const publish = classifyHermesAction("publishing.publish_publicly");
  assert.equal(canHermesExecute(publish, null, { now: NOW }), false, "no approval → no");
  assert.equal(canHermesExecute(publish, { ownerId: "owner-1", expiresAt: PAST }, { now: NOW }), false, "expired → no");
  assert.equal(canHermesExecute(publish, { expiresAt: FUTURE }, { now: NOW }), false, "no owner id → no");
  assert.equal(canHermesExecute(publish, { ownerId: "owner-1", expiresAt: "not-a-date" }, { now: NOW }), false, "garbage expiry → no");
  assert.equal(canHermesExecute(publish, { ownerId: "owner-1", expiresAt: FUTURE }, { now: NOW }), true, "valid → yes");
});

test("malformed classification input throws", () => {
  assert.throws(() => canHermesExecute(null, {}), /HERMES_CLASSIFICATION_REQUIRED/);
  assert.throws(() => canHermesExecute("not-a-classification", {}), /HERMES_CLASSIFICATION_REQUIRED/);
});

test("bulk classifier reports hostile entries instead of throwing", () => {
  const results = classifyHermesActions(["production.start", null, 7, "unknown.action"]);
  assert.equal(results.length, 4);
  assert.equal(results[0].authority, AUTHORITY_AUTONOMOUS);
  for (const result of results.slice(1)) {
    assert.equal(result.authority, AUTHORITY_PROHIBITED);
  }
});
