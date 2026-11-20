/**
 * ST Production House — durable notification repository (Day 4 / D6).
 *
 * PostgreSQL is the only authority for delivery state:
 *   - a row's existence is never "delivered";
 *   - `delivered_at` only exists on a `delivered` row that had a real attempt;
 *   - unconfigured channels are durable `unconfigured` rows with 0 attempts;
 *   - retries are scheduled by database time with bounded exponential backoff;
 *   - claims use `FOR UPDATE SKIP LOCKED` plus a monotonic fencing token, so two
 *     workers can never both own the same delivery.
 *
 * Owner identity is never taken from a client: every read/mutation is scoped by
 * the authenticated Owner id passed in by the router.
 */

import {
  DELIVERY_CHANNELS,
  DELIVERY_ERROR_CLASS,
  DELIVERY_STATE,
  NOTIFICATION_EVENT_TYPE,
  NOTIFICATION_PRIORITY,
  OWNER_INBOX_CHANNEL,
  RETRY_LIMITS,
  buildNotificationEvent,
  notificationIdempotencyKey,
  sanitizeNotificationPayload,
} from "./notificationPolicy.js";

function iso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventType: row.event_type,
    priority: row.priority,
    recipient: row.recipient,
    ownerId: row.owner_id ?? null,
    directorId: row.director_id ?? null,
    taskRef: row.task_ref ?? null,
    idempotencyKey: row.idempotency_key,
    payload: row.payload ?? {},
    createdAt: iso(row.created_at),
    readAt: iso(row.read_at),
    readBy: row.read_by ?? null,
    deliveries: Array.isArray(row.deliveries) ? row.deliveries.map(mapDeliverySummary) : undefined,
  };
}

function mapDeliverySummary(entry) {
  return {
    channel: entry.channel,
    state: entry.state,
    attempts: Number(entry.attempts ?? 0),
    maxAttempts: Number(entry.maxAttempts ?? 0),
    deliveredAt: iso(entry.deliveredAt),
    nextAttemptAt: iso(entry.nextAttemptAt),
    errorClass: entry.errorClass ?? null,
    lastError: entry.lastError ?? null,
  };
}

export function mapDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    channel: row.channel,
    state: row.state,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    nextAttemptAt: iso(row.next_attempt_at),
    errorClass: row.error_class ?? null,
    lastError: row.last_error ?? null,
    channelRef: row.channel_ref ?? null,
    fencingToken: Number(row.fencing_token ?? 0),
    createdAt: iso(row.created_at),
    queuedAt: iso(row.queued_at),
    attemptedAt: iso(row.attempted_at),
    deliveredAt: iso(row.delivered_at),
    failedAt: iso(row.failed_at),
    deadLetteredAt: iso(row.dead_lettered_at),
  };
}

export function mapChannel(row) {
  if (!row) return null;
  return {
    channel: row.channel,
    transport: row.transport ?? null,
    runtimeConfigured: row.runtime_configured === true,
    ownerEnabled: row.owner_enabled === true,
    configured: row.runtime_configured === true && row.owner_enabled === true,
    requiredSecretName: row.required_secret_name ?? null,
    statusReason: row.status_reason ?? null,
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresNotificationRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function") {
      throw new Error("NOTIFICATION_POOL_REQUIRED");
    }
    this.pool = pool;
  }

  async _tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ channels
  async listChannelSettings() {
    const { rows } = await this.pool.query(
      `SELECT * FROM forge_notification_channels
        ORDER BY CASE channel
                   WHEN 'owner_inbox' THEN 0
                   WHEN 'email' THEN 1
                   WHEN 'push' THEN 2
                   ELSE 3
                 END`
    );
    return rows.map(mapChannel);
  }

  /** Record deployment truth (transport presence), never the Owner's consent. */
  async syncChannelRuntime({ channel, transport = null, runtimeConfigured, requiredSecretName = null, statusReason = null }) {
    const { rows } = await this.pool.query(
      `INSERT INTO forge_notification_channels
         (channel, transport, runtime_configured, owner_enabled, required_secret_name, status_reason)
       VALUES ($1, $2, $3, true, $4, $5)
       ON CONFLICT (channel) DO UPDATE
         SET transport = EXCLUDED.transport,
             runtime_configured = EXCLUDED.runtime_configured,
             required_secret_name = EXCLUDED.required_secret_name,
             status_reason = EXCLUDED.status_reason,
             updated_at = clock_timestamp()
       RETURNING *`,
      [channel, transport, runtimeConfigured === true, requiredSecretName, statusReason]
    );
    return mapChannel(rows[0]);
  }

  /** Only an optional channel may be disabled; the inbox is custody. */
  async setChannelEnabled({ channel, enabled }) {
    if (!DELIVERY_CHANNELS.includes(channel)) {
      const error = new Error("CHANNEL_UNKNOWN");
      error.code = "CHANNEL_UNKNOWN";
      error.status = 404;
      throw error;
    }
    if (channel === OWNER_INBOX_CHANNEL) {
      const error = new Error("INBOX_CHANNEL_IMMUTABLE");
      error.code = "INBOX_CHANNEL_IMMUTABLE";
      error.status = 409;
      throw error;
    }
    const { rows } = await this.pool.query(
      `UPDATE forge_notification_channels
          SET owner_enabled = $2, updated_at = clock_timestamp()
        WHERE channel = $1
        RETURNING *`,
      [channel, enabled === true]
    );
    if (!rows[0]) {
      const error = new Error("CHANNEL_UNKNOWN");
      error.code = "CHANNEL_UNKNOWN";
      error.status = 404;
      throw error;
    }
    return mapChannel(rows[0]);
  }

  // -------------------------------------------------------------------- events
  async createEvent(spec) {
    const event = buildNotificationEvent(spec);
    const { rowCount, rows } = await this.pool.query(
      `INSERT INTO forge_notification_events
         (event_type, priority, recipient, owner_id, director_id, task_ref, idempotency_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        event.eventType,
        event.priority,
        event.recipient,
        event.ownerId,
        event.directorId,
        event.taskRef,
        event.idempotencyKey,
        JSON.stringify(event.payload),
      ]
    );
    if (rowCount > 0) return { deduplicated: false, event: mapEvent(rows[0]) };

    const existing = await this.getEventByIdempotencyKey(event.idempotencyKey);
    if (!existing) {
      const error = new Error("NOTIFICATION_EVENT_NOT_FOUND");
      error.code = "NOTIFICATION_EVENT_NOT_FOUND";
      error.status = 404;
      throw error;
    }
    if (
      existing.eventType !== event.eventType ||
      existing.recipient !== event.recipient ||
      existing.ownerId !== event.ownerId
    ) {
      const error = new Error("NOTIFICATION_IDEMPOTENCY_CONFLICT");
      error.code = "NOTIFICATION_IDEMPOTENCY_CONFLICT";
      error.status = 409;
      throw error;
    }
    return { deduplicated: true, event: existing };
  }

  async getEventByIdempotencyKey(key) {
    const { rows } = await this.pool.query(
      "SELECT * FROM forge_notification_events WHERE idempotency_key = $1",
      [key]
    );
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async getEvent({ eventId, ownerId = null }) {
    const { rows } = await this.pool.query(
      `SELECT *, clock_timestamp() AS server_now
         FROM forge_notification_events
        WHERE id = $1
          AND ($2::uuid IS NULL OR owner_id = $2::uuid)`,
      [eventId, ownerId]
    );
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  /** Durable read-back used by the in-app inbox channel to verify custody. */
  async getInboxEvent(eventId) {
    const { rows } = await this.pool.query(
      "SELECT id, owner_id, recipient, priority, payload, created_at FROM forge_notification_events WHERE id = $1",
      [eventId]
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      ownerId: rows[0].owner_id,
      recipient: rows[0].recipient,
      priority: rows[0].priority,
      payload: rows[0].payload ?? {},
      createdAt: iso(rows[0].created_at),
    };
  }

  // --------------------------------------------------------------- deliveries
  /**
   * Persist one delivery row per channel. A channel without a runtime transport
   * is stored as `unconfigured` — the honest, inspectable state — never as a
   * delivery and never as a silent skip.
   */
  async enqueueDeliveries({ eventId, channelPlan }) {
    if (!Array.isArray(channelPlan) || channelPlan.length === 0) {
      throw new Error("CHANNEL_PLAN_REQUIRED");
    }
    await this._tx(async (client) => {
      for (const entry of channelPlan) {
        if (!DELIVERY_CHANNELS.includes(entry.channel)) continue;
        const configured = entry.configured === true || entry.channel === OWNER_INBOX_CHANNEL;
        const state = configured ? DELIVERY_STATE.QUEUED : DELIVERY_STATE.UNCONFIGURED;
        await client.query(
          `INSERT INTO forge_notification_deliveries
             (event_id, channel, state, max_attempts, queued_at, error_class, last_error)
           VALUES ($1, $2, $3, $4,
                   CASE WHEN $3 = 'queued' THEN clock_timestamp() ELSE NULL END,
                   CASE WHEN $3 = 'unconfigured' THEN 'UNCONFIGURED' ELSE NULL END,
                   CASE WHEN $3 = 'unconfigured' THEN left($5, 300) ELSE NULL END)
           ON CONFLICT (event_id, channel) DO NOTHING`,
          [
            eventId,
            entry.channel,
            state,
            Math.max(1, Math.min(RETRY_LIMITS.ABSOLUTE_MAX_ATTEMPTS, Number(entry.maxAttempts) || RETRY_LIMITS.DEFAULT_MAX_ATTEMPTS)),
            entry.reason ?? "CHANNEL_NOT_CONFIGURED",
          ]
        );
      }
    });
    return this.listDeliveriesForEvent(eventId);
  }

  async listDeliveriesForEvent(eventId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM forge_notification_deliveries WHERE event_id = $1 ORDER BY channel ASC",
      [eventId]
    );
    return rows.map(mapDelivery);
  }

  async getDelivery(deliveryId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM forge_notification_deliveries WHERE id = $1",
      [deliveryId]
    );
    return rows[0] ? mapDelivery(rows[0]) : null;
  }

  /** Atomically lease due deliveries. Only one worker can own a row. */
  async claimDueDeliveries({ workerId, leaseSeconds = 60, limit = 10, eventId = null }) {
    if (typeof workerId !== "string" || workerId.length === 0 || workerId.length > 120) {
      throw new Error("WORKER_ID_INVALID");
    }
    const { rows } = await this.pool.query(
      `WITH candidates AS (
         SELECT d.id
           FROM forge_notification_deliveries d
          WHERE d.state IN ('queued', 'retry_scheduled')
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= clock_timestamp())
            AND ($1::uuid IS NULL OR d.event_id = $1::uuid)
          ORDER BY d.created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE forge_notification_deliveries d
          SET state = 'attempted',
              attempts = d.attempts + 1,
              attempted_at = clock_timestamp(),
              lease_owner = $3,
              lease_expires_at = clock_timestamp() + ($4 || ' seconds')::interval,
              fencing_token = d.fencing_token + 1,
              next_attempt_at = NULL
         FROM candidates c
        WHERE d.id = c.id
        RETURNING d.*`,
      [eventId, Math.max(1, Math.min(100, limit)), workerId, String(Math.max(5, leaseSeconds))]
    );
    if (rows.length === 0) return [];
    const eventIds = [...new Set(rows.map((row) => row.event_id))];
    const events = await this.pool.query(
      "SELECT * FROM forge_notification_events WHERE id = ANY($1::uuid[])",
      [eventIds]
    );
    const byId = new Map(events.rows.map((row) => [row.id, mapEvent(row)]));
    return rows
      .filter((row) => byId.has(row.event_id))
      .map((row) => ({ delivery: mapDelivery(row), event: byId.get(row.event_id) }));
  }

  async markDelivered({ deliveryId, fencingToken, channelRef = null }) {
    const { rowCount, rows } = await this.pool.query(
      `UPDATE forge_notification_deliveries
          SET state = 'delivered',
              delivered_at = clock_timestamp(),
              channel_ref = $3,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_attempt_at = NULL
        WHERE id = $1
          AND fencing_token = $2
          AND state = 'attempted'
        RETURNING *`,
      [deliveryId, Number(fencingToken), channelRef ? String(channelRef).slice(0, 300) : null]
    );
    if (rowCount > 0) return { deduplicated: false, delivery: mapDelivery(rows[0]) };

    const current = await this.getDelivery(deliveryId);
    if (!current) {
      const error = new Error("DELIVERY_NOT_FOUND");
      error.code = "DELIVERY_NOT_FOUND";
      error.status = 404;
      throw error;
    }
    if (current.state === DELIVERY_STATE.DELIVERED) {
      return { deduplicated: true, delivery: current };
    }
    const error = new Error(
      current.fencingToken === Number(fencingToken) ? "DELIVERY_NOT_ATTEMPTED" : "DELIVERY_FENCING_STALE"
    );
    error.code = error.message;
    error.status = 409;
    throw error;
  }

  /**
   * Record a real failure: `attempted → failed`, then either
   * `retry_scheduled` (bounded backoff, database clock) or `dead_letter`.
   */
  async markFailed({ deliveryId, fencingToken, errorClass = "TRANSIENT", errorMessage = "", retryInSeconds = null }) {
    const classification = Object.values(DELIVERY_ERROR_CLASS).includes(errorClass)
      ? errorClass
      : DELIVERY_ERROR_CLASS.UNKNOWN;
    const safeMessage = String(
      sanitizeNotificationPayload(String(errorMessage ?? "").slice(0, 500)) ?? "DELIVERY_FAILED"
    ).slice(0, 300);

    return this._tx(async (client) => {
      const current = await client.query(
        "SELECT * FROM forge_notification_deliveries WHERE id = $1 FOR UPDATE",
        [deliveryId]
      );
      if (!current.rows[0]) {
        const error = new Error("DELIVERY_NOT_FOUND");
        error.code = "DELIVERY_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      const row = current.rows[0];
      if (Number(row.fencing_token) !== Number(fencingToken)) {
        const error = new Error("DELIVERY_FENCING_STALE");
        error.code = "DELIVERY_FENCING_STALE";
        error.status = 409;
        throw error;
      }
      if (row.state !== DELIVERY_STATE.ATTEMPTED) {
        const error = new Error("DELIVERY_NOT_ATTEMPTED");
        error.code = "DELIVERY_NOT_ATTEMPTED";
        error.status = 409;
        throw error;
      }

      const failed = await client.query(
        `UPDATE forge_notification_deliveries
            SET state = 'failed',
                failed_at = clock_timestamp(),
                error_class = $3,
                last_error = $4,
                lease_owner = NULL,
                lease_expires_at = NULL
          WHERE id = $1 AND fencing_token = $2
          RETURNING *`,
        [deliveryId, Number(fencingToken), classification, safeMessage || "DELIVERY_FAILED"]
      );

      const attempts = Number(failed.rows[0].attempts);
      const maxAttempts = Number(failed.rows[0].max_attempts);
      const exhausted =
        classification === DELIVERY_ERROR_CLASS.PERMANENT ||
        classification === DELIVERY_ERROR_CLASS.UNCONFIGURED ||
        attempts >= maxAttempts ||
        retryInSeconds === null ||
        retryInSeconds === undefined;

      if (exhausted) {
        const dead = await client.query(
          `UPDATE forge_notification_deliveries
              SET state = 'dead_letter',
                  dead_lettered_at = clock_timestamp(),
                  next_attempt_at = NULL
            WHERE id = $1 AND fencing_token = $2
            RETURNING *`,
          [deliveryId, Number(fencingToken)]
        );
        return { deadLettered: true, delivery: mapDelivery(dead.rows[0]), exhausted: true };
      }

      const retry = await client.query(
        `UPDATE forge_notification_deliveries
            SET state = 'retry_scheduled',
                next_attempt_at = clock_timestamp() + ($3 || ' seconds')::interval,
                dead_lettered_at = NULL
          WHERE id = $1 AND fencing_token = $2
          RETURNING *`,
        [deliveryId, Number(fencingToken), String(Math.max(1, Math.round(retryInSeconds)))]
      );
      return { deadLettered: false, delivery: mapDelivery(retry.rows[0]), exhausted: false };
    });
  }

  /**
   * Restart recovery: an `attempted` row whose lease expired belongs to a
   * worker that is gone. Requeue it — the attempt already counted, so the retry
   * stays bounded.
   */
  async recoverExpiredLeases() {
    const { rowCount } = await this.pool.query(
      `UPDATE forge_notification_deliveries
          SET state = 'retry_scheduled',
              next_attempt_at = clock_timestamp(),
              error_class = 'WORKER_LEASE_EXPIRED',
              last_error = 'WORKER_LEASE_EXPIRED_BEFORE_DELIVERY',
              lease_owner = NULL,
              lease_expires_at = NULL
        WHERE state = 'attempted'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= clock_timestamp()`
    );
    return rowCount ?? 0;
  }

  /** Bounded, Owner-authorized manual retry of a failed/dead-letter delivery. */
  async retryDelivery({ deliveryId, ownerId }) {
    const { rowCount, rows } = await this.pool.query(
      `UPDATE forge_notification_deliveries d
          SET state = 'retry_scheduled',
              next_attempt_at = clock_timestamp(),
              max_attempts = LEAST($3, GREATEST(d.max_attempts, d.attempts + 1)),
              lease_owner = NULL,
              lease_expires_at = NULL
         FROM forge_notification_events e
        WHERE d.id = $1
          AND d.event_id = e.id
          AND e.owner_id = $2
          AND e.recipient = 'OWNER'
          AND d.state IN ('failed', 'dead_letter')
          AND d.attempts < $3
        RETURNING d.*`,
      [deliveryId, ownerId, RETRY_LIMITS.MANUAL_RETRY_CEILING]
    );
    if (rowCount > 0) return { requeued: true, delivery: mapDelivery(rows[0]) };

    const { rows: existing } = await this.pool.query(
      `SELECT d.* FROM forge_notification_deliveries d
         JOIN forge_notification_events e ON e.id = d.event_id
        WHERE d.id = $1 AND e.owner_id = $2 AND e.recipient = 'OWNER'`,
      [deliveryId, ownerId]
    );
    if (!existing[0]) {
      const error = new Error("DELIVERY_NOT_FOUND");
      error.code = "DELIVERY_NOT_FOUND";
      error.status = 404;
      throw error;
    }
    const error = new Error(
      Number(existing[0].attempts) >= RETRY_LIMITS.MANUAL_RETRY_CEILING
        ? "DELIVERY_RETRY_EXHAUSTED"
        : "DELIVERY_NOT_RETRYABLE"
    );
    error.code = error.message;
    error.status = 409;
    throw error;
  }

  async listDeadLetters({ ownerId, limit = 50 }) {
    const { rows } = await this.pool.query(
      `SELECT d.*, e.event_type, e.priority, e.task_ref
         FROM forge_notification_deliveries d
         JOIN forge_notification_events e ON e.id = d.event_id
        WHERE e.owner_id = $1
          AND e.recipient = 'OWNER'
          AND d.state = 'dead_letter'
        ORDER BY d.dead_lettered_at DESC
        LIMIT $2`,
      [ownerId, Math.max(1, Math.min(200, limit))]
    );
    return rows.map((row) => ({
      ...mapDelivery(row),
      eventType: row.event_type,
      priority: row.priority,
      taskRef: row.task_ref ?? null,
    }));
  }

  async countByState({ ownerId }) {
    const { rows } = await this.pool.query(
      `SELECT d.state, d.channel, count(*)::int AS count
         FROM forge_notification_deliveries d
         JOIN forge_notification_events e ON e.id = d.event_id
        WHERE e.owner_id = $1
        GROUP BY d.state, d.channel`,
      [ownerId]
    );
    const counts = { total: 0, byState: {}, byChannel: {} };
    for (const row of rows) {
      counts.total += Number(row.count);
      counts.byState[row.state] = (counts.byState[row.state] ?? 0) + Number(row.count);
      counts.byChannel[row.channel] = (counts.byChannel[row.channel] ?? 0) + Number(row.count);
    }
    return counts;
  }

  // ---------------------------------------------------------------- owner inbox
  async listInbox({ ownerId, limit = 50, unreadOnly = false, priority = null }) {
    const { rows } = await this.pool.query(
      `SELECT e.*,
              clock_timestamp() AS server_now,
              COALESCE(
                json_agg(
                  json_build_object(
                    'channel', d.channel,
                    'state', d.state,
                    'attempts', d.attempts,
                    'maxAttempts', d.max_attempts,
                    'deliveredAt', d.delivered_at,
                    'nextAttemptAt', d.next_attempt_at,
                    'errorClass', d.error_class,
                    'lastError', d.last_error
                  ) ORDER BY d.channel
                ) FILTER (WHERE d.id IS NOT NULL),
                '[]'::json
              ) AS deliveries
         FROM forge_notification_events e
         LEFT JOIN forge_notification_deliveries d ON d.event_id = e.id
        WHERE e.owner_id = $1
          AND e.recipient = 'OWNER'
          AND ($2::boolean = false OR e.read_at IS NULL)
          AND ($3::text IS NULL OR e.priority = $3)
        GROUP BY e.id
        ORDER BY e.created_at DESC
        LIMIT $4`,
      [ownerId, unreadOnly === true, priority, Math.max(1, Math.min(200, limit))]
    );
    return rows.map(mapEvent);
  }

  async unreadCount({ ownerId }) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS unread,
              count(*) FILTER (WHERE priority = 'CRITICAL')::int AS critical
         FROM forge_notification_events
        WHERE owner_id = $1 AND recipient = 'OWNER' AND read_at IS NULL`,
      [ownerId]
    );
    return { unread: Number(rows[0]?.unread ?? 0), critical: Number(rows[0]?.critical ?? 0) };
  }

  async markRead({ eventId, ownerId }) {
    const { rowCount, rows } = await this.pool.query(
      `UPDATE forge_notification_events
          SET read_at = COALESCE(read_at, clock_timestamp()),
              read_by = COALESCE(read_by, $2)
        WHERE id = $1
          AND owner_id = $2
          AND recipient = 'OWNER'
        RETURNING *`,
      [eventId, ownerId]
    );
    if (rowCount === 0) {
      const error = new Error("NOTIFICATION_NOT_FOUND");
      error.code = "NOTIFICATION_NOT_FOUND";
      error.status = 404;
      throw error;
    }
    return mapEvent(rows[0]);
  }

  async markAllRead({ ownerId }) {
    const { rowCount } = await this.pool.query(
      `UPDATE forge_notification_events
          SET read_at = clock_timestamp(), read_by = $1
        WHERE owner_id = $1
          AND recipient = 'OWNER'
          AND read_at IS NULL`,
      [ownerId]
    );
    return { markedRead: rowCount ?? 0 };
  }

  // ------------------------------------------------------------ delivery alerts
  /**
   * Repeated/dead-letter delivery failures become an observable Owner-inbox
   * alert. Idempotent: one alert per (delivery, reason).
   */
  async ensureDeliveryAlert({ sourceEvent, delivery, reasonCode, message, priority = NOTIFICATION_PRIORITY.HIGH }) {
    const key = notificationIdempotencyKey(
      "alert",
      "delivery",
      delivery?.id ?? "unknown",
      reasonCode ?? "FAILED"
    );
    const { deduplicated, event } = await this.createEvent({
      eventType: NOTIFICATION_EVENT_TYPE.DELIVERY_ALERT,
      priority,
      recipient: "OWNER",
      ownerId: sourceEvent.ownerId,
      directorId: sourceEvent.directorId ?? null,
      taskRef: sourceEvent.taskRef ?? null,
      idempotencyKey: key,
      payload: {
        alertCode: reasonCode ?? "NOTIFICATION_DELIVERY_FAILED",
        sourceEventId: sourceEvent.id ?? null,
        sourceEventType: sourceEvent.eventType ?? null,
        channel: delivery?.channel ?? null,
        attempts: delivery?.attempts ?? 0,
        errorClass: delivery?.errorClass ?? null,
        message: message ?? "A notification could not be delivered on one or more channels.",
      },
    });
    if (!deduplicated) {
      await this.pool.query(
        `INSERT INTO forge_notification_deliveries
           (event_id, channel, state, max_attempts, queued_at)
         VALUES ($1, 'owner_inbox', 'queued', $2, clock_timestamp())
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [event.id, RETRY_LIMITS.DEFAULT_MAX_ATTEMPTS]
      );
    }
    return { deduplicated, event };
  }
}
