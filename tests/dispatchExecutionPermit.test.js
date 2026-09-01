import test from "node:test";
import assert from "node:assert/strict";
import {
  DispatchExecutionPermitError,
  PostgresDispatchExecutionPermit,
  buildDispatchExecutionPermitTransition
} from "../src/providers/postgresDispatchExecutionPermit.js";

const scope = { permitId: "a".repeat(64), ownerId: "owner-test", agentId: "agent-01",
  taskId: `dispatch-${"b".repeat(64)}`, capability: "text_generation", reservationId: "reservation-1",
  slot: "emergency_1", provider: "p_local_fallback", credentialId: null, units: 1,
  leaseOwner: "worker-1", permitKey: "attempt-1", leaseSeconds: 60 };
const checkpoint = () => ({ taskId: scope.taskId, step: "dispatch_admitted_for_execution", progress: 0,
  data: { state: "DISPATCH_ADMITTED", ownerId: scope.ownerId, agentId: scope.agentId,
    capability: scope.capability, capacityPolicy: "approved_free_only", providerSelection: "not_performed",
    executionStarted: false, providerCallStarted: false, reservationId: scope.reservationId,
    reservationStatus: "reserved", admittedProviderId: scope.provider, admittedSlot: scope.slot },
  artifactRefs: [], evidenceRefs: [], updatedAt: "2026-08-24T00:00:00.000Z",
  payloadHash: "c".repeat(64), checksum: "d".repeat(64) });

test("builds a bounded truthful permit and revokes it without consuming admission", () => {
  const source = checkpoint();
  const permitted = buildDispatchExecutionPermitTransition({ checkpointRecord: source, scope, action: "issue",
    databaseNow: "2026-08-24T00:01:00.000Z" });
  assert.equal(permitted.data.state, "DISPATCH_PERMITTED");
  assert.equal(permitted.data.permitStatus, "active");
  assert.equal(permitted.data.permitExpiresAt, "2026-08-24T00:02:00.000Z");
  assert.equal(permitted.data.executionStarted, false);
  assert.equal(permitted.data.providerCallStarted, false);
  assert.equal(permitted.data.providerSelection, "not_performed");
  assert.equal(source.data.state, "DISPATCH_ADMITTED");
  const revoked = buildDispatchExecutionPermitTransition({ checkpointRecord: permitted, scope, action: "revoke",
    databaseNow: "2026-08-24T00:01:10.000Z" });
  assert.equal(revoked.data.state, "DISPATCH_ADMITTED");
  assert.equal(revoked.data.permitStatus, "revoked");
  assert.equal(revoked.data.reservationStatus, "reserved");
});

test("expiry recovery is database-clock bounded and fails before expiry", () => {
  const permitted = buildDispatchExecutionPermitTransition({ checkpointRecord: checkpoint(), scope, action: "issue",
    databaseNow: "2026-08-24T00:01:00.000Z" });
  assert.throws(() => buildDispatchExecutionPermitTransition({ checkpointRecord: permitted, scope, action: "expire",
    databaseNow: "2026-08-24T00:01:59.999Z" }), /DISPATCH_PERMIT_NOT_EXPIRED/);
  const expired = buildDispatchExecutionPermitTransition({ checkpointRecord: permitted, scope, action: "expire",
    databaseNow: "2026-08-24T00:02:00.000Z" });
  assert.equal(expired.data.state, "DISPATCH_ADMITTED");
  assert.equal(expired.data.permitStatus, "expired");
});

test("redeems an active permit once into a truthful pre-call execution intent", () => {
  const redeemScope = { ...scope, executionIntentId: "e".repeat(64), intentKey: "intent-1" };
  const permitted = buildDispatchExecutionPermitTransition({ checkpointRecord: checkpoint(), scope: redeemScope,
    action: "issue", databaseNow: "2026-08-24T00:01:00.000Z" });
  const intent = buildDispatchExecutionPermitTransition({ checkpointRecord: permitted, scope: redeemScope,
    action: "redeem", databaseNow: "2026-08-24T00:01:10.000Z" });
  assert.equal(intent.data.state, "DISPATCH_EXECUTION_INTENT");
  assert.equal(intent.data.permitStatus, "consumed");
  assert.equal(intent.data.executionIntentId, redeemScope.executionIntentId);
  assert.equal(intent.data.executionIntentStatus, "ready");
  assert.equal(intent.data.reservationStatus, "reserved");
  assert.equal(intent.data.executionStarted, false);
  assert.equal(intent.data.providerCallStarted, false);
  assert.equal(intent.data.providerSelection, "not_performed");
  assert.throws(() => buildDispatchExecutionPermitTransition({ checkpointRecord: intent, scope: redeemScope,
    action: "redeem", databaseNow: "2026-08-24T00:01:11.000Z" }), /DISPATCH_INTENT_PERMIT_INVALID/);
});

test("rejects invalid lease, secret-bearing scope, and transaction failure", async () => {
  let transactions = 0;
  const permit = new PostgresDispatchExecutionPermit({ async withTransaction() { transactions += 1; throw new Error("DB_FAILED"); } });
  const reservation = { id: scope.reservationId, ownerId: scope.ownerId, agentId: scope.agentId, slot: scope.slot,
    provider: scope.provider, credentialId: null, units: 1 };
  const input = { reservation, checkpointTaskId: scope.taskId, expectedPayloadHash: "a".repeat(64),
    capability: scope.capability, leaseOwner: scope.leaseOwner, permitKey: scope.permitKey, leaseSeconds: 60 };
  await assert.rejects(permit.issue({ ...input, leaseSeconds: 29 }), DispatchExecutionPermitError);
  await assert.rejects(permit.issue({ ...input, permitKey: "vault://secret" }), DispatchExecutionPermitError);
  await assert.rejects(permit.issue(input), /DB_FAILED/);
  assert.equal(transactions, 1);
});

test("claims and recovers a bounded execution intent without starting a provider", () => {
  const claimScope = { ...scope, executionIntentId: "e".repeat(64), intentKey: "intent-1",
    intentClaimId: "f".repeat(64), intentLeaseOwner: "worker-intent-1",
    intentClaimKey: "claim-1", intentLeaseSeconds: 60 };
  const permitted = buildDispatchExecutionPermitTransition({ checkpointRecord: checkpoint(), scope: claimScope,
    action: "issue", databaseNow: "2026-08-24T00:01:00.000Z" });
  const intent = buildDispatchExecutionPermitTransition({ checkpointRecord: permitted, scope: claimScope,
    action: "redeem", databaseNow: "2026-08-24T00:01:10.000Z" });
  const claimed = buildDispatchExecutionPermitTransition({ checkpointRecord: intent, scope: claimScope,
    action: "claim-intent", databaseNow: "2026-08-24T00:01:20.000Z" });
  assert.equal(claimed.data.state, "DISPATCH_INTENT_CLAIMED");
  assert.equal(claimed.data.intentClaimStatus, "active");
  assert.equal(claimed.data.intentClaimExpiresAt, "2026-08-24T00:02:20.000Z");
  assert.equal(claimed.data.executionStarted, false);
  assert.equal(claimed.data.providerCallStarted, false);
  const cancelled = buildDispatchExecutionPermitTransition({ checkpointRecord: claimed, scope: claimScope,
    action: "cancel-intent", databaseNow: "2026-08-24T00:01:30.000Z" });
  assert.equal(cancelled.data.state, "DISPATCH_EXECUTION_INTENT");
  assert.equal(cancelled.data.executionIntentStatus, "ready");
  assert.equal(cancelled.data.intentClaimStatus, "cancelled");
  assert.equal(cancelled.data.reservationStatus, "reserved");
});

test("authorizes and recovers a bounded pre-call handoff without starting execution", () => {
  const authorizationScope = { ...scope, executionIntentId: "e".repeat(64), intentKey: "intent-1",
    intentClaimId: "f".repeat(64), intentLeaseOwner: "worker-intent-1",
    intentClaimKey: "claim-1", intentLeaseSeconds: 90,
    authorizationId: "1".repeat(64), authorizationKey: "authorization-1",
    authorizationLeaseSeconds: 30 };
  const permitted = buildDispatchExecutionPermitTransition({ checkpointRecord: checkpoint(), scope: authorizationScope,
    action: "issue", databaseNow: "2026-08-24T00:01:00.000Z" });
  const intent = buildDispatchExecutionPermitTransition({ checkpointRecord: permitted, scope: authorizationScope,
    action: "redeem", databaseNow: "2026-08-24T00:01:10.000Z" });
  const claimed = buildDispatchExecutionPermitTransition({ checkpointRecord: intent, scope: authorizationScope,
    action: "claim-intent", databaseNow: "2026-08-24T00:01:20.000Z" });
  const authorized = buildDispatchExecutionPermitTransition({ checkpointRecord: claimed, scope: authorizationScope,
    action: "authorize-call", databaseNow: "2026-08-24T00:01:30.000Z" });
  assert.equal(authorized.data.state, "DISPATCH_CALL_AUTHORIZED");
  assert.equal(authorized.data.authorizationStatus, "active");
  assert.equal(authorized.data.authorizationExpiresAt, "2026-08-24T00:02:00.000Z");
  assert.equal(authorized.data.intentClaimStatus, "consumed");
  assert.equal(authorized.data.executionStarted, false);
  assert.equal(authorized.data.providerCallStarted, false);
  assert.equal(authorized.data.providerSelection, "not_performed");
  assert.throws(() => buildDispatchExecutionPermitTransition({ checkpointRecord: authorized,
    scope: authorizationScope, action: "expire-call", databaseNow: "2026-08-24T00:01:59.999Z" }),
  /DISPATCH_CALL_AUTHORIZATION_NOT_EXPIRED/);
  const cancelled = buildDispatchExecutionPermitTransition({ checkpointRecord: authorized,
    scope: authorizationScope, action: "cancel-call", databaseNow: "2026-08-24T00:01:40.000Z" });
  assert.equal(cancelled.data.state, "DISPATCH_EXECUTION_INTENT");
  assert.equal(cancelled.data.executionIntentStatus, "ready");
  assert.equal(cancelled.data.authorizationStatus, "cancelled");
  assert.equal(cancelled.data.reservationStatus, "reserved");
});
