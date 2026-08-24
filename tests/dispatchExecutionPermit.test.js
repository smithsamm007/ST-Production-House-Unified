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
