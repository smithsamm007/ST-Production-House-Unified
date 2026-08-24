import { createHash } from "node:crypto";
import { appendEvidenceEventXact } from "../jobs/retry/retryManager.js";
import { stableDispatchCheckpointHash, validateDispatchCheckpointIntegrity } from "./postgresDispatchAdmissionLifecycle.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const SECRET_PATTERN = /vault:\/\/|opaque:\/\/|password|api[_ -]?key|bearer\s/i;
const ADMITTED = "DISPATCH_ADMITTED";
const PERMITTED = "DISPATCH_PERMITTED";
const EXECUTION_INTENT = "DISPATCH_EXECUTION_INTENT";
const INTENT_CLAIMED = "DISPATCH_INTENT_CLAIMED";
const CALL_AUTHORIZED = "DISPATCH_CALL_AUTHORIZED";

export class DispatchExecutionPermitError extends Error {
  constructor(code) { super(code); this.name = "DispatchExecutionPermitError"; this.code = code; }
}
function fail(code) { throw new DispatchExecutionPermitError(code); }
function required(value, code, max = 200) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !SAFE_TOKEN.test(value)) fail(code);
  return value;
}
function validateInput(input = {}, action) {
  const reservation = input.reservation;
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) fail("DISPATCH_PERMIT_RESERVATION_REQUIRED");
  const scope = {
    reservationId: required(reservation.id, "DISPATCH_PERMIT_RESERVATION_ID_REQUIRED", 100),
    ownerId: required(reservation.ownerId, "DISPATCH_PERMIT_OWNER_ID_REQUIRED", 100),
    agentId: required(reservation.agentId, "DISPATCH_PERMIT_AGENT_ID_REQUIRED"),
    slot: required(reservation.slot, "DISPATCH_PERMIT_SLOT_REQUIRED", 30),
    provider: required(reservation.provider, "DISPATCH_PERMIT_PROVIDER_REQUIRED", 100),
    credentialId: reservation.credentialId == null ? null : required(reservation.credentialId, "DISPATCH_PERMIT_CREDENTIAL_INVALID", 100),
    units: reservation.units,
    taskId: required(input.checkpointTaskId, "DISPATCH_PERMIT_TASK_REQUIRED", 160),
    expectedPayloadHash: required(input.expectedPayloadHash, "DISPATCH_PERMIT_HASH_REQUIRED", 64),
    capability: required(input.capability, "DISPATCH_PERMIT_CAPABILITY_REQUIRED", 100),
    leaseOwner: required(input.leaseOwner, "DISPATCH_PERMIT_LEASE_OWNER_REQUIRED", 100),
    permitKey: required(input.permitKey, "DISPATCH_PERMIT_KEY_REQUIRED", 100),
    leaseSeconds: input.leaseSeconds
  };
  if (!SHA256_HEX.test(scope.expectedPayloadHash) || !Number.isSafeInteger(scope.units) || scope.units < 1) fail("DISPATCH_PERMIT_SCOPE_INVALID");
  if (!Number.isSafeInteger(scope.leaseSeconds) || scope.leaseSeconds < 30 || scope.leaseSeconds > 300) fail("DISPATCH_PERMIT_LEASE_INVALID");
  if (SECRET_PATTERN.test(JSON.stringify(input))) fail("DISPATCH_PERMIT_SECRET_REJECTED");
  scope.permitId = createHash("sha256").update(JSON.stringify([
    scope.ownerId, scope.agentId, scope.taskId, scope.capability, scope.reservationId, scope.slot,
    scope.provider, scope.credentialId, scope.units, scope.leaseOwner, scope.permitKey
  ])).digest("hex");
  if (["redeem", "claim-intent", "cancel-intent", "expire-intent"].includes(action)) {
    scope.intentKey = required(input.intentKey, "DISPATCH_INTENT_KEY_REQUIRED", 100);
    scope.executionIntentId = createHash("sha256")
      .update(JSON.stringify([scope.permitId, scope.intentKey]))
      .digest("hex");
  }
  if (["claim-intent", "cancel-intent", "expire-intent", "authorize-call", "cancel-call", "expire-call"].includes(action)) {
    scope.intentLeaseOwner = required(input.intentLeaseOwner, "DISPATCH_INTENT_LEASE_OWNER_REQUIRED", 100);
    scope.intentClaimKey = required(input.intentClaimKey, "DISPATCH_INTENT_CLAIM_KEY_REQUIRED", 100);
    scope.intentLeaseSeconds = input.intentLeaseSeconds;
    if (!Number.isSafeInteger(scope.intentLeaseSeconds) || scope.intentLeaseSeconds < 30 || scope.intentLeaseSeconds > 300) {
      fail("DISPATCH_INTENT_LEASE_INVALID");
    }
    scope.intentClaimId = createHash("sha256")
      .update(JSON.stringify([scope.executionIntentId, scope.intentLeaseOwner, scope.intentClaimKey]))
      .digest("hex");
  }
  if (["authorize-call", "cancel-call", "expire-call"].includes(action)) {
    scope.authorizationKey = required(input.authorizationKey, "DISPATCH_CALL_AUTHORIZATION_KEY_REQUIRED", 100);
    scope.authorizationLeaseSeconds = input.authorizationLeaseSeconds;
    if (!Number.isSafeInteger(scope.authorizationLeaseSeconds) ||
        scope.authorizationLeaseSeconds < 30 || scope.authorizationLeaseSeconds > 300) {
      fail("DISPATCH_CALL_AUTHORIZATION_LEASE_INVALID");
    }
    scope.authorizationId = createHash("sha256")
      .update(JSON.stringify([scope.intentClaimId, scope.intentLeaseOwner, scope.authorizationKey]))
      .digest("hex");
  }
  return scope;
}
function validateReservation(row, scope) {
  if (row.id !== scope.reservationId || row.owner_id !== scope.ownerId || row.agent_id !== scope.agentId ||
      row.slot !== scope.slot || row.provider !== scope.provider ||
      (row.credential_key === "__local__" ? null : row.credential_key) !== scope.credentialId || Number(row.units) !== scope.units) {
    fail("DISPATCH_PERMIT_SCOPE_MISMATCH");
  }
  if (row.status !== "reserved" || row.tier !== "free") fail("DISPATCH_PERMIT_RESERVATION_NOT_APPROVED_FREE");
}

export function buildDispatchExecutionPermitTransition({ checkpointRecord, scope, action, databaseNow }) {
  const now = new Date(databaseNow);
  if (Number.isNaN(now.getTime())) fail("DISPATCH_PERMIT_DATABASE_TIME_INVALID");
  const current = structuredClone(checkpointRecord);
  const data = current.data;
  if (!data || data.ownerId !== scope.ownerId || data.agentId !== scope.agentId || data.capability !== scope.capability ||
      data.reservationId !== scope.reservationId || data.reservationStatus !== "reserved" ||
      data.admittedProviderId !== scope.provider || data.admittedSlot !== scope.slot ||
      data.executionStarted !== false || data.providerCallStarted !== false || data.providerSelection !== "not_performed") {
    fail("DISPATCH_PERMIT_CHECKPOINT_SCOPE_MISMATCH");
  }
  if (action === "issue") {
    if (data.state !== ADMITTED) fail("DISPATCH_PERMIT_CHECKPOINT_NOT_ADMITTED");
    current.step = "dispatch_permitted_for_execution";
    current.data = { ...data, state: PERMITTED, permitId: scope.permitId, permitLeaseOwner: scope.leaseOwner,
      permitIssuedAt: now.toISOString(), permitExpiresAt: new Date(now.getTime() + scope.leaseSeconds * 1000).toISOString(),
      permitStatus: "active", lastPermitId: null, lastPermitLeaseOwner: null,
      executionStarted: false, providerCallStarted: false };
  } else if (action === "redeem") {
    if (data.state !== PERMITTED || data.permitStatus !== "active" ||
        data.permitId !== scope.permitId || data.permitLeaseOwner !== scope.leaseOwner) {
      fail("DISPATCH_INTENT_PERMIT_INVALID");
    }
    if (new Date(data.permitExpiresAt).getTime() <= now.getTime()) fail("DISPATCH_INTENT_PERMIT_EXPIRED");
    current.step = "dispatch_execution_intent_ready";
    current.data = { ...data, state: EXECUTION_INTENT, permitStatus: "consumed",
      permitConsumedAt: now.toISOString(), executionIntentId: scope.executionIntentId,
      executionIntentStatus: "ready", executionIntentCreatedAt: now.toISOString(),
      executionStarted: false, providerCallStarted: false };
  } else if (action === "claim-intent") {
    if (data.state !== EXECUTION_INTENT || data.executionIntentStatus !== "ready" ||
        data.executionIntentId !== scope.executionIntentId || data.permitId !== scope.permitId ||
        data.permitStatus !== "consumed") fail("DISPATCH_INTENT_NOT_READY");
    current.step = "dispatch_execution_intent_claimed";
    current.data = { ...data, state: INTENT_CLAIMED, executionIntentStatus: "claimed",
      intentClaimId: scope.intentClaimId, intentLeaseOwner: scope.intentLeaseOwner,
      intentClaimedAt: now.toISOString(),
      intentClaimExpiresAt: new Date(now.getTime() + scope.intentLeaseSeconds * 1000).toISOString(),
      intentClaimStatus: "active", lastIntentClaimId: null, lastIntentLeaseOwner: null,
      executionStarted: false, providerCallStarted: false };
  } else if (action === "authorize-call") {
    if (data.state !== INTENT_CLAIMED || data.executionIntentId !== scope.executionIntentId ||
        data.executionIntentStatus !== "claimed" || data.intentClaimId !== scope.intentClaimId ||
        data.intentLeaseOwner !== scope.intentLeaseOwner || data.intentClaimStatus !== "active") {
      fail("DISPATCH_CALL_INTENT_CLAIM_INVALID");
    }
    const claimExpiry = new Date(data.intentClaimExpiresAt).getTime();
    const authorizationExpiry = now.getTime() + scope.authorizationLeaseSeconds * 1000;
    if (claimExpiry <= now.getTime()) fail("DISPATCH_CALL_INTENT_CLAIM_EXPIRED");
    if (authorizationExpiry > claimExpiry) fail("DISPATCH_CALL_AUTHORIZATION_EXCEEDS_CLAIM");
    current.step = "dispatch_call_authorized";
    current.data = { ...data, state: CALL_AUTHORIZED, executionIntentStatus: "authorized",
      intentClaimStatus: "consumed", authorizationId: scope.authorizationId,
      authorizationKey: scope.authorizationKey, authorizationStatus: "active",
      authorizationIssuedAt: now.toISOString(),
      authorizationExpiresAt: new Date(authorizationExpiry).toISOString(),
      lastAuthorizationId: null, executionStarted: false, providerCallStarted: false };
  } else if (action === "cancel-call" || action === "expire-call") {
    if (data.state !== CALL_AUTHORIZED || data.executionIntentId !== scope.executionIntentId ||
        data.intentClaimId !== scope.intentClaimId || data.intentLeaseOwner !== scope.intentLeaseOwner ||
        data.authorizationId !== scope.authorizationId || data.authorizationStatus !== "active") {
      fail("DISPATCH_CALL_AUTHORIZATION_CONFLICT");
    }
    if (action === "expire-call" && new Date(data.authorizationExpiresAt).getTime() > now.getTime()) {
      fail("DISPATCH_CALL_AUTHORIZATION_NOT_EXPIRED");
    }
    current.step = "dispatch_execution_intent_ready";
    current.data = { ...data, state: EXECUTION_INTENT, executionIntentStatus: "ready",
      intentClaimId: null, intentLeaseOwner: null, intentClaimedAt: null, intentClaimExpiresAt: null,
      intentClaimStatus: action === "expire-call" ? "authorization_expired" : "authorization_cancelled",
      lastIntentClaimId: scope.intentClaimId, lastIntentLeaseOwner: scope.intentLeaseOwner,
      authorizationId: null, authorizationKey: null,
      authorizationStatus: action === "expire-call" ? "expired" : "cancelled",
      authorizationIssuedAt: null, authorizationExpiresAt: null,
      lastAuthorizationId: scope.authorizationId, executionStarted: false, providerCallStarted: false };
  } else if (action === "cancel-intent" || action === "expire-intent") {
    if (data.state !== INTENT_CLAIMED || data.executionIntentId !== scope.executionIntentId ||
        data.intentClaimId !== scope.intentClaimId || data.intentLeaseOwner !== scope.intentLeaseOwner ||
        data.intentClaimStatus !== "active") fail("DISPATCH_INTENT_CLAIM_CONFLICT");
    if (action === "expire-intent" && new Date(data.intentClaimExpiresAt).getTime() > now.getTime()) {
      fail("DISPATCH_INTENT_CLAIM_NOT_EXPIRED");
    }
    current.step = "dispatch_execution_intent_ready";
    current.data = { ...data, state: EXECUTION_INTENT, executionIntentStatus: "ready",
      intentClaimId: null, intentLeaseOwner: null, intentClaimedAt: null, intentClaimExpiresAt: null,
      intentClaimStatus: action === "expire-intent" ? "expired" : "cancelled",
      lastIntentClaimId: scope.intentClaimId, lastIntentLeaseOwner: scope.intentLeaseOwner,
      executionStarted: false, providerCallStarted: false };
  } else if (action === "revoke" || action === "expire") {
    if (data.state !== PERMITTED || data.permitId !== scope.permitId || data.permitLeaseOwner !== scope.leaseOwner) fail("DISPATCH_PERMIT_REVOKE_CONFLICT");
    if (action === "expire" && new Date(data.permitExpiresAt).getTime() > now.getTime()) fail("DISPATCH_PERMIT_NOT_EXPIRED");
    current.step = "dispatch_admitted_for_execution";
    current.data = { ...data, state: ADMITTED, permitId: null, permitLeaseOwner: null,
      lastPermitId: scope.permitId, lastPermitLeaseOwner: scope.leaseOwner, permitIssuedAt: null,
      permitExpiresAt: null, permitStatus: action === "expire" ? "expired" : "revoked", executionStarted: false, providerCallStarted: false };
  } else fail("DISPATCH_PERMIT_ACTION_INVALID");
  current.updatedAt = now.toISOString();
  const core = { step: current.step, progress: current.progress, data: current.data,
    artifactRefs: current.artifactRefs, evidenceRefs: current.evidenceRefs };
  current.payloadHash = stableDispatchCheckpointHash(core);
  current.checksum = stableDispatchCheckpointHash({ ...current, checksum: undefined });
  return current;
}

export class PostgresDispatchExecutionPermit {
  constructor(adapter) {
    if (!adapter || typeof adapter.withTransaction !== "function") fail("DISPATCH_PERMIT_TRANSACTION_ADAPTER_REQUIRED");
    this.adapter = adapter;
    this.isProductionDurable = true;
  }
  issue(input) { return this.#transition(input, "issue"); }
  revoke(input) { return this.#transition(input, "revoke"); }
  reclaimExpired(input) { return this.#transition(input, "expire"); }
  redeem(input) { return this.#transition(input, "redeem"); }
  claimIntent(input) { return this.#transition(input, "claim-intent"); }
  cancelIntent(input) { return this.#transition(input, "cancel-intent"); }
  reclaimExpiredIntent(input) { return this.#transition(input, "expire-intent"); }
  authorizeCall(input) { return this.#transition(input, "authorize-call"); }
  cancelCallAuthorization(input) { return this.#transition(input, "cancel-call"); }
  reclaimExpiredCallAuthorization(input) { return this.#transition(input, "expire-call"); }
  async #transition(input, action) {
    const scope = validateInput(input, action);
    return this.adapter.withTransaction(async (client) => {
      const precheck = await client.query(`SELECT quota_id FROM provider_quota_reservations WHERE id=$1 AND owner_id=$2 AND agent_id=$3;`,
        [scope.reservationId, scope.ownerId, scope.agentId]);
      if (precheck.rowCount !== 1) fail("DISPATCH_PERMIT_SCOPE_MISMATCH");
      const quota = await client.query(`SELECT id FROM provider_quota_limits WHERE id=$1 FOR UPDATE;`, [precheck.rows[0].quota_id]);
      if (quota.rowCount !== 1) fail("DISPATCH_PERMIT_QUOTA_MISSING");
      const reservationResult = await client.query(
        `SELECT r.*, q.tier FROM provider_quota_reservations r JOIN provider_quota_limits q ON q.id=r.quota_id
          WHERE r.id=$1 AND r.owner_id=$2 AND r.agent_id=$3 FOR UPDATE OF r;`,
        [scope.reservationId, scope.ownerId, scope.agentId]);
      if (reservationResult.rowCount !== 1) fail("DISPATCH_PERMIT_SCOPE_MISMATCH");
      validateReservation(reservationResult.rows[0], scope);
      const checkpointResult = await client.query(
        `SELECT checkpoint_record, payload_hash, checksum, now() AS database_now FROM job_checkpoints
          WHERE task_id=$1 AND owner_id=$2 AND agent_id=$3 FOR UPDATE;`, [scope.taskId, scope.ownerId, scope.agentId]);
      if (checkpointResult.rowCount !== 1) fail("DISPATCH_PERMIT_CHECKPOINT_SCOPE_MISMATCH");
      const checkpoint = checkpointResult.rows[0];
      const record = checkpoint.checkpoint_record;
      validateDispatchCheckpointIntegrity(record, scope.taskId, checkpoint.payload_hash, checkpoint.checksum);
      if (record.payloadHash !== scope.expectedPayloadHash) {
        const retry = action === "issue" && record.data?.state === PERMITTED && record.data?.permitId === scope.permitId && record.data?.permitLeaseOwner === scope.leaseOwner;
        if (retry && new Date(record.data.permitExpiresAt).getTime() <= new Date(checkpoint.database_now).getTime()) {
          fail("DISPATCH_PERMIT_EXPIRED_RECLAIM_REQUIRED");
        }
        const redeemed = action === "redeem" && record.data?.state === EXECUTION_INTENT &&
          record.data?.permitId === scope.permitId && record.data?.executionIntentId === scope.executionIntentId &&
          record.data?.permitStatus === "consumed";
        const intentClaimed = action === "claim-intent" && record.data?.state === INTENT_CLAIMED &&
          record.data?.executionIntentId === scope.executionIntentId &&
          record.data?.intentClaimId === scope.intentClaimId &&
          record.data?.intentLeaseOwner === scope.intentLeaseOwner && record.data?.intentClaimStatus === "active";
        if (intentClaimed && new Date(record.data.intentClaimExpiresAt).getTime() <= new Date(checkpoint.database_now).getTime()) {
          fail("DISPATCH_INTENT_CLAIM_EXPIRED_RECLAIM_REQUIRED");
        }
        const intentRecovered = (action === "cancel-intent" || action === "expire-intent") &&
          record.data?.state === EXECUTION_INTENT && record.data?.executionIntentId === scope.executionIntentId &&
          record.data?.lastIntentClaimId === scope.intentClaimId &&
          record.data?.lastIntentLeaseOwner === scope.intentLeaseOwner &&
          record.data?.intentClaimStatus === (action === "expire-intent" ? "expired" : "cancelled");
        const callAuthorized = action === "authorize-call" && record.data?.state === CALL_AUTHORIZED &&
          record.data?.executionIntentId === scope.executionIntentId &&
          record.data?.intentClaimId === scope.intentClaimId &&
          record.data?.authorizationId === scope.authorizationId &&
          record.data?.authorizationStatus === "active";
        if (callAuthorized && new Date(record.data.authorizationExpiresAt).getTime() <= new Date(checkpoint.database_now).getTime()) {
          fail("DISPATCH_CALL_AUTHORIZATION_EXPIRED_RECLAIM_REQUIRED");
        }
        const callRecovered = (action === "cancel-call" || action === "expire-call") &&
          record.data?.state === EXECUTION_INTENT && record.data?.executionIntentId === scope.executionIntentId &&
          record.data?.lastIntentClaimId === scope.intentClaimId &&
          record.data?.lastAuthorizationId === scope.authorizationId &&
          record.data?.authorizationStatus === (action === "expire-call" ? "expired" : "cancelled");
        const completed = action !== "issue" && action !== "redeem" && record.data?.state === ADMITTED &&
          record.data?.lastPermitId === scope.permitId && record.data?.lastPermitLeaseOwner === scope.leaseOwner &&
          record.data?.permitStatus === (action === "expire" ? "expired" : "revoked");
        if (retry || redeemed || intentClaimed || intentRecovered || callAuthorized || callRecovered || completed) return this.#result(record, scope);
        fail("DISPATCH_PERMIT_STALE_CHECKPOINT");
      }
      const next = buildDispatchExecutionPermitTransition({ checkpointRecord: record, scope, action, databaseNow: checkpoint.database_now });
      const updated = await client.query(
        `UPDATE job_checkpoints SET checkpoint_record=$4::jsonb, payload_hash=$5, checksum=$6, version=version+1, updated_at=now()
          WHERE task_id=$1 AND owner_id=$2 AND agent_id=$3 AND payload_hash=$7 RETURNING version;`,
        [scope.taskId, scope.ownerId, scope.agentId, JSON.stringify(next), next.payloadHash, next.checksum, scope.expectedPayloadHash]);
      if (updated.rowCount !== 1) fail("DISPATCH_PERMIT_STALE_CHECKPOINT");
      await appendEvidenceEventXact(client, { subjectId: scope.permitId,
        kind: action === "issue" ? "dispatch_execution_permit_issued" :
          action === "redeem" ? "dispatch_execution_intent_created" :
          action === "claim-intent" ? "dispatch_execution_intent_claimed" :
          action === "cancel-intent" ? "dispatch_execution_intent_cancelled" :
          action === "expire-intent" ? "dispatch_execution_intent_claim_expired" :
          action === "authorize-call" ? "dispatch_call_authorized" :
          action === "cancel-call" ? "dispatch_call_authorization_cancelled" :
          action === "expire-call" ? "dispatch_call_authorization_expired" :
          action === "expire" ? "dispatch_execution_permit_expired" : "dispatch_execution_permit_revoked",
        classification: "dispatch_execution_permit", payload: { reservationId: scope.reservationId, ownerId: scope.ownerId,
          agentId: scope.agentId, slot: scope.slot, provider: scope.provider,
          status: action === "issue" ? "active" : action === "redeem" ? "ready" :
            action === "claim-intent" ? "claimed" : action === "cancel-intent" ? "cancelled" :
            action === "authorize-call" ? "authorized" : action === "cancel-call" ? "cancelled" :
            (action === "expire-call" || action === "expire-intent" || action === "expire") ? "expired" : "revoked",
          state: next.data.state, operation: action } });
      return this.#result(next, scope);
    });
  }
  #result(record, scope) {
    return Object.freeze({ schemaVersion: 1, permitId: scope.permitId, leaseOwner: scope.leaseOwner,
      permitStatus: record.data.permitStatus, permitExpiresAt: record.data.permitExpiresAt,
      executionIntentId: record.data.executionIntentId ?? null,
      executionIntentStatus: record.data.executionIntentStatus ?? null,
      intentClaimId: record.data.intentClaimId ?? record.data.lastIntentClaimId ?? null,
      intentLeaseOwner: record.data.intentLeaseOwner ?? record.data.lastIntentLeaseOwner ?? null,
      intentClaimStatus: record.data.intentClaimStatus ?? null,
      intentClaimExpiresAt: record.data.intentClaimExpiresAt ?? null,
      authorizationId: record.data.authorizationId ?? record.data.lastAuthorizationId ?? null,
      authorizationStatus: record.data.authorizationStatus ?? null,
      authorizationExpiresAt: record.data.authorizationExpiresAt ?? null,
      checkpointTaskId: record.taskId, checkpointPayloadHash: record.payloadHash, checkpointState: record.data.state,
      reservationId: scope.reservationId, reservationStatus: "reserved", executionStarted: false,
      providerCallStarted: false, providerSelection: "not_performed" });
  }
}
