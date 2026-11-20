/**
 * ST Production House — notification delivery channels (Day 4 / D6).
 *
 * A channel is either really configured or honestly unconfigured. This module
 * never invents a provider: `email` needs an Owner-wired SMTP/API transport,
 * `webhook` needs an https URL, `push` needs an https push gateway URL. When a
 * transport is missing the channel plan reports it as unconfigured and the
 * repository stores a durable `unconfigured` delivery row (0 attempts) instead
 * of pretending to deliver.
 *
 * Secrets come only from the environment or an injected transport. Nothing is
 * logged, persisted or returned to the browser.
 */

import {
  CHANNEL_REQUIRED_SECRETS,
  DELIVERY_CHANNELS,
  DELIVERY_ERROR_CLASS,
  NotificationError,
  OWNER_INBOX_CHANNEL,
  sanitizeNotificationPayload,
} from "./notificationPolicy.js";

function httpsUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function typedError(code, message, errorClass, status = 400) {
  const error = new NotificationError(code, message, status);
  error.errorClass = errorClass;
  return error;
}

/** In-app Owner inbox: delivery means the event is durably readable. */
export function createInboxChannel({ repository }) {
  return {
    channel: OWNER_INBOX_CHANNEL,
    transport: "durable_inbox",
    runtimeConfigured: true,
    requiredSecretName: null,
    statusReason: null,
    async deliver({ event }) {
      const persisted = await repository.getInboxEvent(event.id);
      if (!persisted || persisted.id !== event.id) {
        throw typedError(
          "OWNER_INBOX_NOT_DURABLE",
          "The Owner inbox row could not be read back.",
          DELIVERY_ERROR_CLASS.PERMANENT,
          500
        );
      }
      return { channelRef: `inbox:${persisted.id}` };
    },
  };
}

/**
 * Optional external adapter. `transport.send` is supplied by the deployment
 * (never by a Director, never by a client). No transport is shipped here.
 */
export function createEmailChannel({ transport = null } = {}) {
  return {
    channel: "email",
    transport: transport ? "owner_supplied_email_transport" : null,
    runtimeConfigured: typeof transport?.send === "function",
    requiredSecretName: CHANNEL_REQUIRED_SECRETS.email,
    statusReason: typeof transport?.send === "function" ? null : "NO_EMAIL_TRANSPORT_CONFIGURED",
    async deliver({ event }) {
      if (typeof transport?.send !== "function") {
        throw typedError(
          "CHANNEL_NOT_CONFIGURED",
          "No email transport is configured.",
          DELIVERY_ERROR_CLASS.UNCONFIGURED,
          409
        );
      }
      const result = await transport.send({
        eventId: event.id,
        eventType: event.eventType,
        priority: event.priority,
        subject: `[ST ${event.priority}] ${event.eventType}`,
        text: String(event.payload?.message ?? event.eventType),
        metadata: { taskRef: event.taskRef, createdAt: event.createdAt },
      });
      return { channelRef: `email:${result?.messageId ?? "accepted"}` };
    },
  };
}

/** Generic HTTPS webhook / push gateway transport. */
export function createWebhookChannel({
  channel,
  url,
  requiredSecretName,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const endpoint = httpsUrl(url);
  return {
    channel,
    transport: endpoint ? "https_webhook" : null,
    runtimeConfigured: Boolean(endpoint) && typeof fetchImpl === "function",
    requiredSecretName,
    statusReason: endpoint ? null : "NO_WEBHOOK_URL_CONFIGURED",
    async deliver({ event }) {
      if (!endpoint || typeof fetchImpl !== "function") {
        throw typedError(
          "CHANNEL_NOT_CONFIGURED",
          "No https webhook URL is configured.",
          DELIVERY_ERROR_CLASS.UNCONFIGURED,
          409
        );
      }
      const envelope = {
        eventId: event.id,
        eventType: event.eventType,
        priority: event.priority,
        recipient: event.recipient,
        taskRef: event.taskRef ?? null,
        createdAt: event.createdAt,
        payload: sanitizeNotificationPayload(event.payload ?? {}),
      };
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "stph-notifier/1" },
          body: JSON.stringify(envelope),
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
        });
      } catch (cause) {
        throw typedError(
          "WEBHOOK_UNREACHABLE",
          `Webhook transport failed: ${cause?.code ?? cause?.name ?? "NETWORK_ERROR"}`,
          DELIVERY_ERROR_CLASS.TRANSIENT,
          503
        );
      }
      if (!response?.ok) {
        const status = Number(response?.status ?? 0);
        const errorClass =
          status === 429
            ? DELIVERY_ERROR_CLASS.RATE_LIMITED
            : status === 401 || status === 403
              ? DELIVERY_ERROR_CLASS.AUTHENTICATION
              : status >= 500
                ? DELIVERY_ERROR_CLASS.TRANSIENT
                : DELIVERY_ERROR_CLASS.PERMANENT;
        throw typedError(
          "WEBHOOK_REJECTED",
          `Webhook responded with HTTP ${status || "unknown"}.`,
          errorClass,
          status || 502
        );
      }
      return { channelRef: `webhook:${response.status}` };
    },
  };
}

/**
 * Build the registry. `plan()` reconciles deployment truth into the durable
 * channel table, then merges the Owner's enable/disable flag. Owner consent can
 * only turn a channel OFF; it can never make an unconfigured channel work.
 */
export function createChannelRegistry({
  repository,
  env = process.env,
  fetchImpl = globalThis.fetch,
  transports = {},
} = {}) {
  if (!repository) throw new Error("NOTIFICATION_REPOSITORY_REQUIRED");
  const channels = new Map([
    [OWNER_INBOX_CHANNEL, createInboxChannel({ repository })],
    ["email", createEmailChannel({ transport: transports.email ?? null })],
    [
      "push",
      createWebhookChannel({
        channel: "push",
        url: env.STPH_PUSH_WEBHOOK_URL,
        requiredSecretName: CHANNEL_REQUIRED_SECRETS.push,
        fetchImpl,
      }),
    ],
    [
      "webhook",
      createWebhookChannel({
        channel: "webhook",
        url: env.STPH_NOTIFICATION_WEBHOOK_URL,
        requiredSecretName: CHANNEL_REQUIRED_SECRETS.webhook,
        fetchImpl,
      }),
    ],
  ]);

  return {
    channels: DELIVERY_CHANNELS,
    get(channel) {
      return channels.get(channel) ?? null;
    },
    async plan() {
      const plan = [];
      for (const channel of DELIVERY_CHANNELS) {
        const adapter = channels.get(channel);
        const stored = await repository.syncChannelRuntime({
          channel,
          transport: adapter.transport,
          runtimeConfigured: adapter.runtimeConfigured === true,
          requiredSecretName: adapter.requiredSecretName ?? null,
          statusReason: adapter.statusReason ?? null,
        });
        const configured =
          stored.runtimeConfigured === true &&
          stored.ownerEnabled === true &&
          adapter.runtimeConfigured === true;
        plan.push({
          channel,
          configured,
          transport: stored.transport,
          reason: configured
            ? null
            : stored.ownerEnabled === false
              ? "DISABLED_BY_OWNER"
              : adapter.statusReason ?? "CHANNEL_NOT_CONFIGURED",
        });
      }
      return plan;
    },
  };
}
