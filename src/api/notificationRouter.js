/**
 * ST Production House — Owner notification API (Day 4 / D6).
 *
 * Mounted in production behind the same Owner session gate and CSRF guard as
 * every other Owner route (`src/catalog/server.js`). The router never trusts a
 * client-supplied Owner identity: the Owner id comes from the authenticated
 * session resolved by the mount.
 *
 * Routes (all JSON):
 *   GET   /inbox                     Owner inbox (priority, deliveries, unread)
 *   GET   /inbox/unread-count        unread + critical counters
 *   POST  /inbox/read-all            mark every event read
 *   GET   /inbox/:id                 one event with per-channel delivery state
 *   POST  /inbox/:id/read            mark one event read
 *   GET   /deliveries/dead-letter    inspectable dead-letter list
 *   POST  /deliveries/:id/retry      bounded manual retry
 *   POST  /run                       run one delivery cycle
 *   GET   /channels                  channel truth (configured / unconfigured)
 *   PATCH /channels/:channel         Owner disables/enables an optional channel
 *   GET   /status                    worker + delivery + channel status
 *
 * Every mutation requires a valid CSRF token. Director-recipient events are
 * never returned by these Owner-scoped queries.
 */

import express from "express";

import {
  DELIVERY_CHANNELS,
  OWNER_INBOX_CHANNEL,
  OPTIONAL_CHANNELS,
} from "../notifications/notificationPolicy.js";

function fail(res, code, message, status = 400) {
  return res.status(status).json({ code, message: message ?? code });
}

function publicError(error) {
  return {
    code: error?.code ?? "NOTIFICATION_REQUEST_FAILED",
    message: error?.status && error.status < 500 ? error.message : "The notification request could not be processed.",
    status: Number(error?.status) || 500,
  };
}

/** Sanitized DTO: the stored payload is already allowlist-sanitized. */
export function notificationDto(event) {
  if (!event) return null;
  return {
    id: event.id,
    eventType: event.eventType,
    priority: event.priority,
    recipient: event.recipient,
    taskRef: event.taskRef ?? null,
    directorId: event.directorId ?? null,
    createdAt: event.createdAt,
    readAt: event.readAt ?? null,
    unread: event.readAt === null,
    payload: event.payload ?? {},
    deliveries: Array.isArray(event.deliveries)
      ? event.deliveries.map((entry) => ({
          channel: entry.channel,
          state: entry.state,
          attempts: entry.attempts,
          maxAttempts: entry.maxAttempts,
          deliveredAt: entry.deliveredAt ?? null,
          nextAttemptAt: entry.nextAttemptAt ?? null,
          errorClass: entry.errorClass ?? null,
          deliveryFailed: Boolean(entry.errorClass || entry.lastError),
        }))
      : [],
  };
}

export function deliveryDto(delivery) {
  if (!delivery) return null;
  return {
    id: delivery.id,
    eventId: delivery.eventId,
    channel: delivery.channel,
    state: delivery.state,
    attempts: delivery.attempts,
    maxAttempts: delivery.maxAttempts,
    nextAttemptAt: delivery.nextAttemptAt ?? null,
    deadLetteredAt: delivery.deadLetteredAt ?? null,
    errorClass: delivery.errorClass ?? null,
    eventType: delivery.eventType ?? null,
    priority: delivery.priority ?? null,
    taskRef: delivery.taskRef ?? null,
    retryable: ["failed", "dead_letter"].includes(delivery.state),
  };
}

export function channelDto(channel) {
  if (!channel) return null;
  return {
    channel: channel.channel,
    transport: channel.transport,
    configured: channel.configured,
    runtimeConfigured: channel.runtimeConfigured,
    ownerEnabled: channel.ownerEnabled,
    requiredSecretName: channel.requiredSecretName,
    statusReason: channel.statusReason,
    immutable: channel.channel === OWNER_INBOX_CHANNEL,
  };
}

export function createNotificationRouter({
  repository,
  worker,
  channels,
  getOwnerId = (req) => req?.forgeSession?.id ?? null,
  verifyCsrf = () => false,
  logger = console,
} = {}) {
  if (!repository) throw new Error("NOTIFICATION_REPOSITORY_REQUIRED");
  if (!worker) throw new Error("NOTIFICATION_WORKER_REQUIRED");
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));

  const guard = (handler) => async (req, res) => {
    try {
      const ownerId = getOwnerId(req);
      if (!ownerId) return fail(res, "UNAUTHORIZED", "Authenticated Owner session required.", 401);
      const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
      if (mutation && verifyCsrf(req) !== true) {
        return fail(res, "CSRF_REJECTED", "A valid CSRF token is required for mutations.", 403);
      }
      return await handler(req, res, ownerId);
    } catch (error) {
      const shaped = publicError(error);
      if (shaped.status >= 500) {
        logger.error?.(
          JSON.stringify({ level: "error", code: shaped.code, message: String(error?.message ?? "").slice(0, 200) })
        );
      }
      return fail(res, shaped.code, shaped.message, shaped.status);
    }
  };

  const limitOf = (value, fallback = 50) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.trunc(parsed))) : fallback;
  };

  router.get(
    "/inbox",
    guard(async (req, res, ownerId) => {
      const unreadOnly = req.query.unreadOnly === "true";
      const priority = typeof req.query.priority === "string" ? req.query.priority : null;
      const events = await repository.listInbox({ ownerId, limit: limitOf(req.query.limit), unreadOnly, priority });
      const counts = await repository.unreadCount({ ownerId });
      return res.status(200).json({
        count: events.length,
        unread: counts.unread,
        criticalUnread: counts.critical,
        events: events.map(notificationDto),
      });
    })
  );

  router.get(
    "/inbox/unread-count",
    guard(async (req, res, ownerId) => {
      const counts = await repository.unreadCount({ ownerId });
      return res.status(200).json(counts);
    })
  );

  router.post(
    "/inbox/read-all",
    guard(async (req, res, ownerId) => {
      const result = await repository.markAllRead({ ownerId });
      return res.status(200).json(result);
    })
  );

  router.get(
    "/inbox/:id",
    guard(async (req, res, ownerId) => {
      const event = await repository.getEvent({ eventId: req.params.id, ownerId });
      if (!event || event.recipient !== "OWNER") {
        return fail(res, "NOTIFICATION_NOT_FOUND", "Unknown notification.", 404);
      }
      event.deliveries = undefined;
      const deliveries = await repository.listDeliveriesForEvent(event.id);
      return res.status(200).json({
        event: { ...notificationDto(event), deliveries: deliveries.map((entry) => deliveryDto(entry)) },
      });
    })
  );

  router.post(
    "/inbox/:id/read",
    guard(async (req, res, ownerId) => {
      const event = await repository.markRead({ eventId: req.params.id, ownerId });
      return res.status(200).json({ event: notificationDto(event) });
    })
  );

  router.get(
    "/deliveries/dead-letter",
    guard(async (req, res, ownerId) => {
      const deliveries = await repository.listDeadLetters({ ownerId, limit: limitOf(req.query.limit, 50) });
      return res.status(200).json({ count: deliveries.length, deliveries: deliveries.map(deliveryDto) });
    })
  );

  router.post(
    "/deliveries/:id/retry",
    guard(async (req, res, ownerId) => {
      const retried = await repository.retryDelivery({ deliveryId: req.params.id, ownerId });
      const cycle = await worker.runOnce();
      const deliveries = await repository.listDeliveriesForEvent(retried.delivery.eventId);
      return res.status(200).json({
        delivery: deliveryDto(retried.delivery),
        cycle,
        deliveries: deliveries.map((entry) => deliveryDto(entry)),
      });
    })
  );

  router.post(
    "/run",
    guard(async (req, res) => {
      const cycle = await worker.runOnce();
      return res.status(200).json({ cycle });
    })
  );

  router.get(
    "/channels",
    guard(async (req, res) => {
      await channels.plan();
      const settings = await repository.listChannelSettings();
      return res.status(200).json({
        channels: settings.map(channelDto),
        permitted: [...DELIVERY_CHANNELS],
        optional: [...OPTIONAL_CHANNELS],
        note: "External channels are reported as unconfigured unless a real transport exists in this deployment.",
      });
    })
  );

  router.patch(
    "/channels/:channel",
    guard(async (req, res) => {
      const channel = String(req.params.channel);
      if (!DELIVERY_CHANNELS.includes(channel)) {
        return fail(res, "CHANNEL_UNKNOWN", "Unknown notification channel.", 404);
      }
      if (typeof req.body?.enabled !== "boolean") {
        return fail(res, "CHANNEL_ENABLED_REQUIRED", "A boolean `enabled` is required.", 400);
      }
      if (channel === OWNER_INBOX_CHANNEL) {
        return fail(res, "INBOX_CHANNEL_IMMUTABLE", "The durable Owner inbox cannot be disabled.", 409);
      }
      await channels.plan();
      const settings = await repository.listChannelSettings();
      const current = settings.find((entry) => entry.channel === channel);
      if (req.body.enabled === true && current?.runtimeConfigured !== true) {
        return fail(
          res,
          "CHANNEL_NOT_CONFIGURABLE",
          "This deployment has no transport for that channel; it cannot be enabled here.",
          409
        );
      }
      const updated = await repository.setChannelEnabled({ channel, enabled: req.body.enabled });
      return res.status(200).json({ channel: channelDto(updated) });
    })
  );

  router.get(
    "/status",
    guard(async (req, res, ownerId) => {
      await channels.plan();
      const settings = await repository.listChannelSettings();
      const counts = await repository.countByState({ ownerId });
      const unread = await repository.unreadCount({ ownerId });
      return res.status(200).json({
        workerInstanceId: worker.instanceId,
        unread,
        deliveries: counts,
        channels: settings.map(channelDto),
        unconfiguredChannels: settings
          .filter((entry) => entry.runtimeConfigured !== true)
          .map((entry) => entry.channel),
        note: "A persisted notification is not proof of external delivery; see per-channel delivery state.",
      });
    })
  );

  router.use((req, res) => fail(res, "NOT_FOUND", "Unknown notification route.", 404));
  return router;
}
