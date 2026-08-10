import { appendEvidenceEventXact } from "../jobs/retry/retryManager.js";

const VALID_SLOTS = new Set(["primary", "secondary", "tertiary", "emergency_1", "emergency_2"]);
const VALID_TIERS = new Set(["free", "trial", "free_trial"]);
const VALID_COOLDOWN_CODES = new Set([
  "RATE_LIMIT",
  "TIMEOUT",
  "SERVICE_UNAVAILABLE",
  "TEMPORARY_NETWORK_FAILURE",
  "PROVIDER_IN_COOLDOWN",
]);

function requiredString(value, code, max = 200) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(code);
  }
  return value;
}

function normalizeScope(scope, { requireIdempotency = false } = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("QUOTA_SCOPE_REQUIRED");
  }
  const ownerId = requiredString(scope.ownerId, "OWNER_ID_REQUIRED", 100);
  const agentId = requiredString(scope.agentId, "AGENT_ID_REQUIRED", 200);
  const slot = requiredString(scope.slot ?? scope.slotName, "PROVIDER_SLOT_REQUIRED", 30);
  if (!VALID_SLOTS.has(slot)) throw new Error("INVALID_PROVIDER_SLOT");
  const provider = requiredString(scope.provider, "PROVIDER_REQUIRED", 100);
  const credentialId = scope.credentialId == null ? null : requiredString(scope.credentialId, "INVALID_CREDENTIAL_ID", 100);
  const credentialKey = credentialId ?? "__local__";
  const idempotencyKey = requireIdempotency
    ? requiredString(scope.idempotencyKey, "QUOTA_IDEMPOTENCY_KEY_REQUIRED", 200)
    : scope.idempotencyKey;
  return { ownerId, agentId, slot, provider, credentialId, credentialKey, idempotencyKey };
}

function toReservation(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    agentId: row.agent_id,
    slot: row.slot,
    provider: row.provider,
    credentialId: row.credential_key === "__local__" ? null : row.credential_key,
    idempotencyKey: row.idempotency_key,
    units: Number(row.units),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toQuota(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    agentId: row.agent_id,
    slot: row.slot,
    provider: row.provider,
    credentialId: row.credential_key === "__local__" ? null : row.credential_key,
    limit: Number(row.quota_limit),
    usageCount: Number(row.usage_count),
    reservedCount: Number(row.reserved_count),
    tier: row.tier,
    trialExpiresAt: row.trial_expires_at ? new Date(row.trial_expires_at).toISOString() : null,
    resetAt: row.reset_at ? new Date(row.reset_at).toISOString() : null,
    cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until).toISOString() : null,
    cooldownCode: row.cooldown_code,
    enabled: row.enabled,
  };
}

export class PostgresQuotaRepository {
  constructor(adapter) {
    if (!adapter || typeof adapter.withTransaction !== "function") {
      throw new Error("POSTGRES_TRANSACTION_ADAPTER_REQUIRED");
    }
    this.adapter = adapter;
    this.isProductionDurable = true;
  }

  async configureQuota(scope, {
    limit,
    usageCount = 0,
    tier = "free",
    trialExpiryTimestamp = null,
    resetTimestamp = null,
    isPaid = false,
  } = {}) {
    const s = normalizeScope(scope);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("INVALID_QUOTA_LIMIT");
    if (!Number.isSafeInteger(usageCount) || usageCount < 0 || usageCount > limit) {
      throw new Error("INVALID_USAGE_COUNT");
    }
    if (!VALID_TIERS.has(tier) || isPaid) throw new Error("PAID_OR_OVERAGE_ROUTES_FORBIDDEN");
    if (tier === "free" && trialExpiryTimestamp != null) throw new Error("INVALID_TRIAL_EXPIRY");
    if (tier !== "free" && trialExpiryTimestamp == null) throw new Error("TRIAL_EXPIRY_REQUIRED");
    for (const [value, code] of [[trialExpiryTimestamp, "INVALID_TRIAL_EXPIRY"], [resetTimestamp, "INVALID_RESET_TIMESTAMP"]]) {
      if (value != null && Number.isNaN(new Date(value).getTime())) throw new Error(code);
    }

    return this.adapter.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO provider_quota_limits
          (owner_id, agent_id, slot, provider, credential_id, credential_key, quota_limit,
           usage_count, reserved_count, tier, is_paid, trial_expires_at, reset_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,false,$10,$11)
         ON CONFLICT (owner_id, agent_id, slot, provider, credential_key)
         DO UPDATE SET
           quota_limit = EXCLUDED.quota_limit,
           usage_count = EXCLUDED.usage_count,
           tier = EXCLUDED.tier,
           is_paid = false,
           trial_expires_at = EXCLUDED.trial_expires_at,
           reset_at = EXCLUDED.reset_at,
           updated_at = now()
         WHERE provider_quota_limits.reserved_count = 0
         RETURNING *;`,
        [s.ownerId, s.agentId, s.slot, s.provider, s.credentialId, s.credentialKey,
         limit, usageCount, tier, trialExpiryTimestamp, resetTimestamp]
      );
      if (result.rowCount !== 1) throw new Error("QUOTA_CONFIGURATION_HAS_ACTIVE_RESERVATIONS");
      return toQuota(result.rows[0]);
    });
  }

  async getQuotaState(scope) {
    const s = normalizeScope(scope);
    const result = await this.adapter.query(
      `SELECT * FROM provider_quota_limits
       WHERE owner_id=$1 AND agent_id=$2 AND slot=$3 AND provider=$4 AND credential_key=$5;`,
      [s.ownerId, s.agentId, s.slot, s.provider, s.credentialKey]
    );
    return result.rowCount === 1 ? toQuota(result.rows[0]) : null;
  }

  async reserve(scope) {
    const s = normalizeScope(scope, { requireIdempotency: true });
    const units = scope.units ?? 1;
    if (!Number.isSafeInteger(units) || units <= 0) throw new Error("INVALID_RESERVATION_UNITS");

    return this.adapter.withTransaction(async (client) => {
      const quotaResult = await client.query(
        `SELECT * FROM provider_quota_limits
         WHERE owner_id=$1 AND agent_id=$2 AND slot=$3 AND provider=$4 AND credential_key=$5
         FOR UPDATE;`,
        [s.ownerId, s.agentId, s.slot, s.provider, s.credentialKey]
      );
      if (quotaResult.rowCount !== 1) throw new Error("QUOTA_RESERVATION_FAILED: quota_not_configured");
      let quota = quotaResult.rows[0];

      if (quota.reset_at) {
        const reset = await client.query(
          `UPDATE provider_quota_limits
           SET usage_count=0, reset_at=NULL, updated_at=now()
           WHERE id=$1 AND reset_at <= now()
           RETURNING *;`,
          [quota.id]
        );
        if (reset.rowCount === 1) quota = reset.rows[0];
      }

      if (!quota.enabled || quota.is_paid || !VALID_TIERS.has(quota.tier)) {
        throw new Error("QUOTA_RESERVATION_FAILED: paid_route_forbidden");
      }
      if (quota.trial_expires_at) {
        const expiry = await client.query("SELECT $1::timestamptz <= now() AS expired;", [quota.trial_expires_at]);
        if (expiry.rows[0].expired) throw new Error("QUOTA_RESERVATION_FAILED: trial_expired");
      }
      if (quota.cooldown_until) {
        const cooldown = await client.query("SELECT $1::timestamptz > now() AS active;", [quota.cooldown_until]);
        if (cooldown.rows[0].active) throw new Error("PROVIDER_IN_COOLDOWN");
      }

      const existing = await client.query(
        `SELECT * FROM provider_quota_reservations
         WHERE owner_id=$1 AND agent_id=$2 AND idempotency_key=$3
         FOR UPDATE;`,
        [s.ownerId, s.agentId, s.idempotencyKey]
      );
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (row.quota_id !== quota.id || row.slot !== s.slot || row.provider !== s.provider || row.credential_key !== s.credentialKey) {
          throw new Error("QUOTA_IDEMPOTENCY_SCOPE_MISMATCH");
        }
        if (row.status === "committed") throw new Error("QUOTA_IDEMPOTENCY_ALREADY_COMMITTED");
        if (row.status === "reserved") throw new Error("QUOTA_RESERVATION_IN_PROGRESS");
      }

      if (Number(quota.usage_count) + Number(quota.reserved_count) + units > Number(quota.quota_limit)) {
        throw new Error("QUOTA_RESERVATION_FAILED: quota_exceeded");
      }

      await client.query(
        "UPDATE provider_quota_limits SET reserved_count=reserved_count+$2, updated_at=now() WHERE id=$1;",
        [quota.id, units]
      );

      const reservation = existing.rowCount === 1
        ? await client.query(
            `UPDATE provider_quota_reservations
             SET status='reserved', units=$2, updated_at=now(), released_at=NULL
             WHERE id=$1 RETURNING *;`,
            [existing.rows[0].id, units]
          )
        : await client.query(
            `INSERT INTO provider_quota_reservations
              (quota_id, owner_id, agent_id, slot, provider, credential_key, idempotency_key, units)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING *;`,
            [quota.id, s.ownerId, s.agentId, s.slot, s.provider, s.credentialKey, s.idempotencyKey, units]
          );

      const dto = toReservation(reservation.rows[0]);
      await appendEvidenceEventXact(client, {
        subjectId: dto.id,
        kind: "provider_quota_reserved",
        classification: "quota_reservation",
        payload: {
          reservationId: dto.id, ownerId:s.ownerId, agentId:s.agentId, slot:s.slot,
          provider:s.provider, credentialId:s.credentialId, units, status:"reserved"
        }
      });
      return dto;
    });
  }

  async commit(reservation) {
    return this.#finalize(reservation, "committed");
  }

  async release(reservation) {
    return this.#finalize(reservation, "released");
  }

  async #finalize(reservation, targetStatus) {
    if (!reservation || typeof reservation !== "object") throw new Error("RESERVATION_REQUIRED");
    const id = requiredString(reservation.id, "RESERVATION_ID_REQUIRED", 100);
    const ownerId = requiredString(reservation.ownerId, "OWNER_ID_REQUIRED", 100);
    const agentId = requiredString(reservation.agentId, "AGENT_ID_REQUIRED", 200);

    return this.adapter.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT r.*, q.usage_count, q.reserved_count, q.quota_limit
         FROM provider_quota_reservations r
         JOIN provider_quota_limits q ON q.id=r.quota_id
         WHERE r.id=$1 AND r.owner_id=$2 AND r.agent_id=$3
         FOR UPDATE OF r, q;`,
        [id, ownerId, agentId]
      );
      if (result.rowCount !== 1) throw new Error("RESERVATION_SCOPE_MISMATCH");
      const row = result.rows[0];

      if (row.status === targetStatus) return toReservation(row);
      if (row.status === "committed" || row.status === "released") return toReservation(row);

      const units = Number(row.units);
      if (Number(row.reserved_count) < units) throw new Error("QUOTA_RESERVATION_COUNT_CORRUPT");

      if (targetStatus === "committed") {
        if (Number(row.usage_count) + units > Number(row.quota_limit)) throw new Error("QUOTA_LIMIT_EXCEEDED_ON_COMMIT");
        await client.query(
          `UPDATE provider_quota_limits
           SET reserved_count=reserved_count-$2, usage_count=usage_count+$2, updated_at=now()
           WHERE id=$1;`,
          [row.quota_id, units]
        );
      } else {
        await client.query(
          `UPDATE provider_quota_limits
           SET reserved_count=reserved_count-$2, updated_at=now()
           WHERE id=$1;`,
          [row.quota_id, units]
        );
      }

      const updated = await client.query(
        `UPDATE provider_quota_reservations
         SET status=$2, updated_at=now(),
             committed_at=CASE WHEN $2='committed' THEN now() ELSE committed_at END,
             released_at=CASE WHEN $2='released' THEN now() ELSE released_at END
         WHERE id=$1 RETURNING *;`,
        [id, targetStatus]
      );
      const dto = toReservation(updated.rows[0]);
      await appendEvidenceEventXact(client, {
        subjectId:id,
        kind:targetStatus === "committed" ? "provider_quota_committed" : "provider_quota_released",
        classification:"quota_reservation_finalized",
        payload:{
          reservationId:id, ownerId, agentId, slot:row.slot, provider:row.provider,
          credentialId:row.credential_key === "__local__" ? null : row.credential_key,
          units, status:targetStatus
        }
      });
      return dto;
    });
  }

  async recordCooldown(scope, { errorCode, retryAfterSeconds }) {
    const s = normalizeScope(scope);
    if (!VALID_COOLDOWN_CODES.has(errorCode)) throw new Error("INVALID_COOLDOWN_CODE");
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 3600) {
      throw new Error("INVALID_RETRY_AFTER");
    }
    return this.adapter.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE provider_quota_limits
         SET cooldown_until=now()+($6*interval '1 second'), cooldown_code=$7, updated_at=now()
         WHERE owner_id=$1 AND agent_id=$2 AND slot=$3 AND provider=$4 AND credential_key=$5
         RETURNING *;`,
        [s.ownerId,s.agentId,s.slot,s.provider,s.credentialKey,retryAfterSeconds,errorCode]
      );
      if (result.rowCount !== 1) throw new Error("QUOTA_NOT_CONFIGURED");
      const quota=toQuota(result.rows[0]);
      await appendEvidenceEventXact(client,{
        subjectId:quota.id,kind:"provider_cooldown_recorded",classification:"bounded_cooldown",
        payload:{ownerId:s.ownerId,agentId:s.agentId,slot:s.slot,provider:s.provider,
          credentialId:s.credentialId,cooldownCode:errorCode,cooldownUntil:quota.cooldownUntil}
      });
      return quota;
    });
  }

  async recordFallback(scope, { errorCode }) {
    const s=normalizeScope(scope);
    const code=requiredString(errorCode,"FALLBACK_ERROR_CODE_REQUIRED",100);
    return this.adapter.withTransaction(async(client)=>{
      const quota=await client.query(
        `SELECT id FROM provider_quota_limits
         WHERE owner_id=$1 AND agent_id=$2 AND slot=$3 AND provider=$4 AND credential_key=$5;`,
        [s.ownerId,s.agentId,s.slot,s.provider,s.credentialKey]
      );
      if(quota.rowCount!==1) throw new Error("QUOTA_NOT_CONFIGURED");
      await appendEvidenceEventXact(client,{
        subjectId:quota.rows[0].id,kind:"provider_fallback_decision",classification:"approved_fallback",
        payload:{ownerId:s.ownerId,agentId:s.agentId,slot:s.slot,provider:s.provider,
          credentialId:s.credentialId,decision:"fallback",errorCode:code}
      });
      return {recorded:true};
    });
  }
}
