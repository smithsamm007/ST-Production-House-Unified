/**
 * D5 unit coverage: the pure delegated-publishing evaluator and the authority
 * boundary. No database, no clock, no I/O — the same inputs always produce the
 * same APPROVE/REJECT with structured reason codes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DELEGATED_PUBLISHING_CHECKS,
  classifyDelegatedAction,
  evaluateDelegatedPublishingDecision,
} from "../src/publishing/hermesDelegatedPublishingDecision.js";
import {
  ApprovalError,
  PostgresPublishingApprovalRepository,
} from "../src/publishing/publishingApprovalRepository.js";

const ARTIFACT = "a".repeat(64);
const OTHER_ARTIFACT = "b".repeat(64);

function passingChecks() {
  const checks = {};
  for (const name of DELEGATED_PUBLISHING_CHECKS) {
    checks[name] = { passed: true, evidence: `evidence://${name}/verified` };
  }
  return checks;
}

function request(overrides = {}) {
  const notifiedAt = "2026-01-01T00:00:00.000Z";
  return {
    id: "11111111-1111-4111-8111-111111111111",
    directorId: "agent-01",
    artifactSha256: ARTIFACT,
    destinations: ["youtube"],
    requestedAction: "publishing.publish_publicly",
    notifiedAt,
    deadlineAt: "2026-01-01T05:00:00.000Z",
    ownerResponseAt: null,
    policyVersion: "1",
    delegatedPolicyId: "pol-pub-1",
    ...overrides,
  };
}

const policy = {
  policyId: "pol-pub-1",
  category: "publishing",
  allowedActions: ["publishing.publish_publicly"],
  active: true,
  permitsLivePublishing: true,
  expiresAt: null,
  policyVersion: 1,
  revokedAt: null,
};

const AFTER_DEADLINE = new Date("2026-01-01T05:00:01.000Z");

test("APPROVE requires every mandatory check plus an active matching policy", () => {
  const result = evaluateDelegatedPublishingDecision({
    request: request(),
    policy,
    checks: passingChecks(),
    now: AFTER_DEADLINE,
  });
  assert.equal(result.decision, "APPROVE");
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.failedChecks.length, 0);
  assert.match(result.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(result.authority.scope, "SINGLE_REQUEST_ONLY");
  assert.equal(result.authority.grantsUnrestrictedPublishing, false);
  assert.equal(result.authority.grantsSpendingAuthority, false);
  assert.equal(result.authority.grantsSecurityAuthority, false);
  assert.equal(result.authority.overridesOwnerReserved, false);
});

test("no early decision: an open Owner window can never be approved by HERMES", () => {
  const result = evaluateDelegatedPublishingDecision({
    request: request(),
    policy,
    checks: passingChecks(),
    now: new Date("2026-01-01T04:59:59.000Z"),
  });
  assert.equal(result.decision, "REJECT");
  assert.ok(result.reasonCodes.includes("OWNER_WINDOW_STILL_OPEN"));
});

test("missing or unverified evidence is a REJECT, never an implicit pass", () => {
  const checks = passingChecks();
  delete checks.copyrightLicensing;
  checks.advertisingDisclosure = { passed: false, evidence: "" };
  checks.metadata = { passed: true, evidence: "   " };

  const result = evaluateDelegatedPublishingDecision({
    request: request(),
    policy,
    checks,
    now: AFTER_DEADLINE,
  });
  assert.equal(result.decision, "REJECT");
  assert.ok(result.reasonCodes.includes("CHECK_FAILED:copyrightLicensing"));
  assert.ok(result.reasonCodes.includes("CHECK_FAILED:advertisingDisclosure"));
  assert.ok(result.reasonCodes.includes("CHECK_FAILED:metadata"));
  assert.equal(result.evaluatedChecks.copyrightLicensing.passed, false);
});

test("silence without a delegated policy can never publish", () => {
  const result = evaluateDelegatedPublishingDecision({
    request: request(),
    policy: null,
    checks: passingChecks(),
    now: AFTER_DEADLINE,
  });
  assert.equal(result.decision, "REJECT");
  assert.ok(result.reasonCodes.includes("POLICY_NOT_ACTIVE"));
});

test("a revoked or version-mismatched policy blocks an otherwise perfect request", () => {
  const revoked = evaluateDelegatedPublishingDecision({
    request: request(),
    policy: { ...policy, active: false, revokedAt: "2026-01-01T00:30:00.000Z" },
    checks: passingChecks(),
    now: AFTER_DEADLINE,
  });
  assert.equal(revoked.decision, "REJECT");

  const versionDrift = evaluateDelegatedPublishingDecision({
    request: request({ policyVersion: "1" }),
    policy: { ...policy, policyVersion: 2 },
    checks: passingChecks(),
    now: AFTER_DEADLINE,
  });
  assert.equal(versionDrift.decision, "REJECT");
});

test("artifact drift and a non-five-hour deadline are both rejected", () => {
  const drift = evaluateDelegatedPublishingDecision({
    request: request(),
    policy,
    checks: passingChecks(),
    now: AFTER_DEADLINE,
    artifactSha256: OTHER_ARTIFACT,
  });
  assert.ok(drift.reasonCodes.includes("ARTIFACT_CHANGED_SINCE_REQUEST"));

  const wrongWindow = evaluateDelegatedPublishingDecision({
    request: request({ deadlineAt: "2026-01-01T04:00:00.000Z" }),
    policy,
    checks: passingChecks(),
    now: AFTER_DEADLINE,
  });
  assert.ok(wrongWindow.reasonCodes.includes("DEADLINE_NOT_FIVE_HOURS"));
});

test("authority boundary: only publishing is delegable, Owner-reserved actions never are", () => {
  assert.equal(classifyDelegatedAction({ action: "publishing.publish_publicly" }).allowed, true);
  for (const action of [
    "spending.commit",
    "credentials.new_account_connection",
    "security.global_governance_change",
    "policy.change_delegation",
    "data.destructive_deletion",
  ]) {
    const result = classifyDelegatedAction({ action });
    assert.equal(result.allowed, false, `${action} must never be delegable`);
    assert.equal(result.code, "OWNER_RESERVED_AUTHORITY");
  }
  assert.equal(classifyDelegatedAction({ action: "production.start" }).allowed, false);
});

test("repository input validation fails closed before any query runs", async () => {
  const repository = new PostgresPublishingApprovalRepository({
    query: async () => {
      throw new Error("QUERY_MUST_NOT_RUN");
    },
    connect: async () => {
      throw new Error("CONNECT_MUST_NOT_RUN");
    },
  });

  await assert.rejects(
    repository.createRequest({
      idempotencyKey: "idem-validation-1",
      ownerId: "11111111-1111-4111-8111-111111111111",
      directorId: "agent-01",
      artifactSha256: "not-a-hash",
      destinations: ["youtube"],
      policyVersion: "1",
    }),
    (error) => error instanceof ApprovalError && error.code === "ARTIFACT_HASH_INVALID"
  );

  await assert.rejects(
    repository.createRequest({
      idempotencyKey: "idem-validation-2",
      ownerId: "11111111-1111-4111-8111-111111111111",
      directorId: "agent-01",
      artifactSha256: ARTIFACT,
      destinations: ["tiktok"],
      policyVersion: "1",
    }),
    (error) => error instanceof ApprovalError && error.code === "INVALID_PLATFORM_DESTINATION"
  );

  await assert.rejects(
    repository.registerPolicy({
      policyId: "pol-bad",
      category: "spending",
      allowedActions: ["spending.commit"],
    }),
    (error) => error instanceof ApprovalError && error.code === "POLICY_CATEGORY_NOT_DELEGABLE"
  );
});
