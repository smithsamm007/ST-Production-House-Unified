import { createHash } from "node:crypto";
import { appendEvidenceEventXact } from "../jobs/retry/retryManager.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SECRET_PATTERN = /vault:\/\/|opaque:\/\/|password|api[_ -]?key|bearer\s/i;
const CLAIMED_STATE = "DISPATCH_ADMITTED";
const WAITING_STATE = "WAITING_FOR_QUOTA";

export class DispatchAdmissionLifecycleError extends Error {
  constructor(code) {
    super(code);
    this.name = "DispatchAdmissionLifecycleError";
    this.code = code;
  }
}

function fail(code) {
  throw new DispatchAdmissionLifecycleError(code);
}

function requiredString(value, code, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) fail(code);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function validateRecordIntegrity(record, taskId, storedPayloadHash, storedChecksum) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.taskId !== taskId) {
    fail("DISPATCH_ADMISSION_CHECKPOINT_RECORD_INVALID");
  }
  if (
    !SHA256_HEX.test(record.payloadHash || "") ||
    !SHA256_HEX.test(record.checksum || "") ||
    record.payloadHash !== storedPayloadHash ||
    record.checksum !== storedChecksum
  ) {
    fail("DISPATCH_ADMISSION_CHECKPOINT_HASH_MISMATCH");
  }
  const { checksum, taskId: recordTaskId, payloadHash, ...stateFields } = record;
  if (stableHash({ taskId: recordTaskId, ...stateFields, payloadHash }) !== checksum) {
    fail("DISPATCH_ADMISSION_CHECKPOINT_CHECKSUM_INVALID");
  }
  const { step, progress, data, artifactRefs, evidenceRefs, updatedAt } = stateFields;
  if (
    stableHash({ step, progress, data, artifactRefs, evidenceRefs }) !== payloadHash ||
    typeof updatedAt !== "string" ||
    !data ||
    typeof data !== "object"
  ) {
    fail("DISPATCH_ADMISSION_CHECKPOINT_PAYLOAD_INVALID");
  }
  if (SECRET_PATTERN.test(JSON.stringify(record))) fail("DISPATCH_ADMISSION_LIFECYCLE_SECRET_REJECTED");
}

function validateScope({ reservation, checkpointTaskId, expectedPayloadHash }) {
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    fail("DISPATCH_ADMISSION_RESERVATION_REQUIRED");
  }
  const scope = {
    id: requiredString(reservation.id, "DISPATCH_ADMISSION_RESERVATION_ID_REQUIRED", 100),
    ownerId: requiredString(reservation.ownerId, "DISPATCH_ADMISSION_OWNER_ID_REQUIRED", 100),
    agentId: requiredString(reservation.agentId, "DISPATCH_ADMISSION_AGENT_ID_REQUIRED", 200),
    slot: requiredString(reservation.slot, "DISPATCH_ADMISSION_SLOT_REQUIRED", 30),
    provider: requiredString(reservation.provider, "DISPATCH_ADMISSION_PROVIDER_REQUIRED", 100),
    credentialId: reservation.credentialId == null
      ? null
      : requiredString(reservation.credentialId, "DISPATCH_ADMISSION_CREDENTIAL_ID_INVALID", 100),
    units: reservation.units,
    checkpointTaskId: requiredString(checkpointTaskId, "DISPATCH_ADMISSION_CHECKPOINT_TASK_REQUIRED", 160),
    expectedPayloadHash: requiredString(
      expectedPayloadHash,
      "DISPATCH_ADMISSION_EXPECTED_PAYLOAD_HASH_REQUIRED",
      64
    )
  };
  if (!SHA256_HEX.test(scope.expectedPayloadHash) || !Number.isSafeInteger(scope.units) || scope.units < 1) {
    fail("DISPATCH_ADMISSION_LIFECYCLE_SCOPE_INVALID");
  }
  if (SECRET_PATTERN.test(JSON.stringify({ reservation, checkpointTaskId }))) {
    fail("DISPATCH_ADMISSION_LIFECYCLE_SECRET_REJECTED");
  }
  return scope;
}

function validateDatabaseScope(row, scope) {
  if (
    row.id !== scope.id ||
    row.owner_id !== scope.ownerId ||
    row.agent_id !== scope.agentId ||
    row.slot !== scope.slot ||
    row.provider !== scope.provider ||
    (row.credential_key === "__local__" ? null : row.credential_key) !== scope.credentialId ||
    Number(row.units) !== scope.units
  ) {
    fail("DISPATCH_ADMISSION_LIFECYCLE_SCOPE_MISMATCH");
  }
}

export function buildDispatchAdmissionCheckpointTransition({
  checkpointRecord,
  reservation,
  action,
  updatedAt
}) {
  if (action !== "claim" && action !== "release") fail("DISPATCH_ADMISSION_LIFECYCLE_ACTION_INVALID");
  if (typeof updatedAt !== "string" || Number.isNaN(new Date(updatedAt).getTime())) {
    fail("DISPATCH_ADMISSION_LIFECYCLE_TIMESTAMP_INVALID");
  }
  const current = JSON.parse(JSON.stringify(checkpointRecord));
  const data = current.data;
  if (
    !data ||
    data.ownerId !== reservation.ownerId ||
    data.agentId !== reservation.agentId ||
    data.executionStarted !== false ||
    data.providerSelection !== "not_performed"
  ) {
    fail("DISPATCH_ADMISSION_CHECKPOINT_SCOPE_MISMATCH");
  }

  if (action === "claim") {
    if (data.state !== WAITING_STATE) fail("DISPATCH_ADMISSION_CHECKPOINT_NOT_WAITING");
    current.step = "dispatch_admitted_for_execution";
    current.data = {
      ...data,
      state: CLAIMED_STATE,
      reservationId: reservation.id,
      reservationStatus: "reserved",
      admittedProviderId: reservation.provider,
      admittedSlot: reservation.slot,
      providerCallStarted: false
    };
  } else {
    if (
      data.state !== WAITING_STATE &&
      !(data.state === CLAIMED_STATE && data.reservationId === reservation.id)
    ) {
      fail("DISPATCH_ADMISSION_CHECKPOINT_RELEASE_CONFLICT");
    }
    current.step = "dispatch_waiting_for_quota";
    current.data = {
      ...data,
      state: WAITING_STATE,
      reasonCode: "DISPATCH_ADMISSION_RELEASED",
      reservationId: reservation.id,
      reservationStatus: "released",
      admittedProviderId: null,
      admittedSlot: null,
      providerCallStarted: false
    };
  }

  current.updatedAt = updatedAt;
  const core = {
    step: current.step,
    progress: current.progress,
    data: current.data,
    artifactRefs: current.artifactRefs,
    evidenceRefs: current.evidenceRefs
  };
  current.payloadHash = stableHash(core);
  current.checksum = stableHash({ ...current, checksum: undefined });
  // JSON serialization omits undefined; this mirrors CheckpointStore's checksum input.
  return current;
}

export class PostgresDispatchAdmissionLifecycle {
  constructor(adapter) {
    if (!adapter || typeof adapter.withTransaction !== "function") {
      fail("DISPATCH_ADMISSION_TRANSACTION_ADAPTER_REQUIRED");
    }
    this.adapter = adapter;
    this.isProductionDurable = true;
  }

  claim(input) {
    return this.#transition(input, "claim");
  }

  release(input) {
    return this.#transition(input, "release");
  }

  async #transition(input, action) {
    const scope = validateScope(input || {});
    return this.adapter.withTransaction(async (client) => {
      const precheck = await client.query(
        `SELECT quota_id FROM provider_quota_reservations
          WHERE id=$1 AND owner_id=$2 AND agent_id=$3;`,
        [scope.id, scope.ownerId, scope.agentId]
      );
      if (precheck.rowCount !== 1) fail("DISPATCH_ADMISSION_LIFECYCLE_SCOPE_MISMATCH");

      const quotaLock = await client.query(
        `SELECT id FROM provider_quota_limits WHERE id=$1 FOR UPDATE;`,
        [precheck.rows[0].quota_id]
      );
      if (quotaLock.rowCount !== 1) fail("DISPATCH_ADMISSION_QUOTA_MISSING");

      const reservationResult = await client.query(
        `SELECT r.*, q.reserved_count
           FROM provider_quota_reservations r
           JOIN provider_quota_limits q ON q.id=r.quota_id
          WHERE r.id=$1 AND r.owner_id=$2 AND r.agent_id=$3
          FOR UPDATE OF r;`,
        [scope.id, scope.ownerId, scope.agentId]
      );
      if (reservationResult.rowCount !== 1) fail("DISPATCH_ADMISSION_LIFECYCLE_SCOPE_MISMATCH");
      const row = reservationResult.rows[0];
      validateDatabaseScope(row, scope);

      const checkpointResult = await client.query(
        `SELECT checkpoint_record, payload_hash, checksum
           FROM job_checkpoints
          WHERE task_id=$1 AND owner_id=$2 AND agent_id=$3
          FOR UPDATE;`,
        [scope.checkpointTaskId, scope.ownerId, scope.agentId]
      );
      if (checkpointResult.rowCount !== 1) fail("DISPATCH_ADMISSION_CHECKPOINT_SCOPE_MISMATCH");
      const checkpointRow = checkpointResult.rows[0];
      const record = checkpointRow.checkpoint_record;
      validateRecordIntegrity(record, scope.checkpointTaskId, checkpointRow.payload_hash, checkpointRow.checksum);

      if (record.payloadHash !== scope.expectedPayloadHash) {
        const alreadyClaimed = action === "claim" &&
          record.data?.state === CLAIMED_STATE &&
          record.data?.reservationId === scope.id &&
          row.status === "reserved";
        const alreadyReleased = action === "release" &&
          record.data?.state === WAITING_STATE &&
          record.data?.reservationId === scope.id &&
          record.data?.reservationStatus === "released" &&
          row.status === "released";
        if (alreadyClaimed || alreadyReleased) return this.#result(record, row, action);
        fail("DISPATCH_ADMISSION_STALE_CHECKPOINT");
      }

      if (action === "claim" && row.status !== "reserved") {
        fail("DISPATCH_ADMISSION_RESERVATION_NOT_RESERVED");
      }
      if (action === "release" && row.status === "committed") {
        fail("DISPATCH_ADMISSION_RESERVATION_TERMINAL_CONFLICT");
      }

      const reservation = {
        id: scope.id,
        ownerId: scope.ownerId,
        agentId: scope.agentId,
        slot: scope.slot,
        provider: scope.provider,
        credentialId: scope.credentialId,
        units: scope.units
      };
      const next = buildDispatchAdmissionCheckpointTransition({
        checkpointRecord: record,
        reservation,
        action,
        updatedAt: new Date().toISOString()
      });

      if (action === "release" && row.status === "reserved") {
        if (Number(row.reserved_count) < scope.units) fail("DISPATCH_ADMISSION_RESERVED_COUNT_CORRUPT");
        await client.query(
          `UPDATE provider_quota_limits
              SET reserved_count=reserved_count-$2, updated_at=now()
            WHERE id=$1;`,
          [row.quota_id, scope.units]
        );
        await client.query(
          `UPDATE provider_quota_reservations
              SET status='released', released_at=now(), updated_at=now()
            WHERE id=$1;`,
          [scope.id]
        );
        row.status = "released";
      } else if (action === "release" && row.status !== "released") {
        fail("DISPATCH_ADMISSION_RESERVATION_TERMINAL_CONFLICT");
      }

      const updated = await client.query(
        `UPDATE job_checkpoints
            SET checkpoint_record=$4::jsonb, payload_hash=$5, checksum=$6,
                version=version+1, updated_at=now()
          WHERE task_id=$1 AND owner_id=$2 AND agent_id=$3 AND payload_hash=$7
          RETURNING version;`,
        [
          scope.checkpointTaskId,
          scope.ownerId,
          scope.agentId,
          JSON.stringify(next),
          next.payloadHash,
          next.checksum,
          scope.expectedPayloadHash
        ]
      );
      if (updated.rowCount !== 1) fail("DISPATCH_ADMISSION_STALE_CHECKPOINT");

      await appendEvidenceEventXact(client, {
        subjectId: scope.id,
        kind: action === "claim" ? "dispatch_admission_claimed" : "dispatch_admission_released",
        classification: "dispatch_admission_lifecycle",
        payload: {
          reservationId: scope.id,
          ownerId: scope.ownerId,
          agentId: scope.agentId,
          slot: scope.slot,
          provider: scope.provider,
          credentialId: scope.credentialId,
          units: scope.units,
          status: action === "claim" ? "reserved" : "released",
          state: next.data.state
        }
      });
      return this.#result(next, row, action);
    });
  }

  #result(record, reservationRow, action) {
    return Object.freeze({
      schemaVersion: 1,
      checkpointTaskId: record.taskId,
      checkpointPayloadHash: record.payloadHash,
      checkpointState: record.data.state,
      reservationId: reservationRow.id,
      reservationStatus: action === "release" ? "released" : reservationRow.status,
      ownerId: reservationRow.owner_id,
      agentId: reservationRow.agent_id,
      executionStarted: false,
      providerCallStarted: false
    });
  }
}
