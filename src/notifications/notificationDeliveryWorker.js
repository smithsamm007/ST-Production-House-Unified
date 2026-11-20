/**
 * ST Production House — notification delivery worker (Day 4 / D6).
 *
 * Durable, lease-fenced, idempotent delivery over the outbox in sql/044.
 * The interval timer is only a TRIGGER: `runOnce()` is safe to call from a
 * timer, from an HTTP ops route, from a boot hook or from a test.
 *
 * Truthful-state rules:
 *   - `delivered` is written only after the channel adapter confirmed the
 *     delivery; a database insert alone is never "delivered";
 *   - an unconfigured channel is a durable `unconfigured` row, never a success;
 *   - failures schedule bounded exponential backoff on database time and end in
 *     `dead_letter`, which raises an observable Owner-inbox alert;
 *   - restarts recover expired `attempted` leases instead of dropping events.
 */

import crypto from "node:crypto";

import {
  DELIVERY_ERROR_CLASS,
  DELIVERY_STATE,
  NOTIFICATION_PRIORITY,
  classifyDeliveryError,
  computeBackoffSeconds,
  sanitizeNotificationPayload,
} from "./notificationPolicy.js";

export class NotificationDeliveryWorker {
  constructor({
    repository,
    channels,
    instanceId = `notification-worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
    leaseSeconds = 60,
    batchSize = 10,
    logger = console,
    random = Math.random,
  } = {}) {
    if (!repository) throw new Error("NOTIFICATION_REPOSITORY_REQUIRED");
    if (!channels) throw new Error("NOTIFICATION_CHANNELS_REQUIRED");
    this.repository = repository;
    this.channels = channels;
    this.instanceId = instanceId;
    this.leaseSeconds = leaseSeconds;
    this.batchSize = batchSize;
    this.logger = logger;
    this.random = random;
    this._timer = null;
    this._running = false;
  }

  /**
   * Create the logical event (idempotent), persist per-channel delivery state,
   * then attempt what is due. Returns the durable state after the attempt.
   */
  async dispatch(spec) {
    const channelPlan = await this.channels.plan();
    const { deduplicated, event } = await this.repository.createEvent(spec);
    const existing = await this.repository.listDeliveriesForEvent(event.id);
    if (existing.length === 0) {
      await this.repository.enqueueDeliveries({ eventId: event.id, channelPlan });
    }
    const cycle = await this.runOnce({ eventId: event.id });
    const deliveries = await this.repository.listDeliveriesForEvent(event.id);
    return {
      event,
      deduplicated,
      deliveries,
      channels: channelPlan,
      cycle,
      delivered: deliveries.every((entry) =>
        [DELIVERY_STATE.DELIVERED, DELIVERY_STATE.UNCONFIGURED].includes(entry.state)
      ),
    };
  }

  async attempt({ delivery, event }) {
    const adapter = this.channels.get(delivery.channel);
    if (!adapter) {
      return this._fail({
        delivery,
        event,
        error: Object.assign(new Error("UNKNOWN_CHANNEL"), {
          code: "UNKNOWN_CHANNEL",
          errorClass: DELIVERY_ERROR_CLASS.PERMANENT,
        }),
      });
    }

    try {
      const result = await adapter.deliver({ event, delivery });
      const marked = await this.repository.markDelivered({
        deliveryId: delivery.id,
        fencingToken: delivery.fencingToken,
        channelRef: result?.channelRef ?? null,
      });
      return {
        deliveryId: delivery.id,
        channel: delivery.channel,
        outcome: marked.deduplicated ? "already_delivered" : "delivered",
        attempts: marked.delivery.attempts,
      };
    } catch (error) {
      return this._fail({ delivery, event, error });
    }
  }

  async _fail({ delivery, event, error }) {
    const errorClass = classifyDeliveryError(error);
    const attempts = Number(delivery.attempts ?? 0);
    const maxAttempts = Number(delivery.maxAttempts ?? 5);
    const exhausted = errorClass === DELIVERY_ERROR_CLASS.PERMANENT || attempts >= maxAttempts;
    const retryInSeconds = exhausted ? null : computeBackoffSeconds({ attempts, random: this.random });

    let marked;
    try {
      marked = await this.repository.markFailed({
        deliveryId: delivery.id,
        fencingToken: delivery.fencingToken,
        errorClass,
        errorMessage: String(error?.message ?? "DELIVERY_FAILED"),
        retryInSeconds,
      });
    } catch (markError) {
      // A newer lease owns this delivery now; its state is the truth.
      return {
        deliveryId: delivery.id,
        channel: delivery.channel,
        outcome: "superseded",
        code: markError?.code ?? "DELIVERY_STATE_CHANGED",
      };
    }

    if (marked.deadLettered) {
      await this._raiseAlert({
        event,
        delivery: marked.delivery,
        reasonCode: "DEAD_LETTER",
        message: `Notification delivery to ${delivery.channel} exhausted ${attempts}/${maxAttempts} attempts.`,
      });
    } else if (attempts >= 2 && event.priority === NOTIFICATION_PRIORITY.CRITICAL) {
      await this._raiseAlert({
        event,
        delivery: marked.delivery,
        reasonCode: "REPEATED_FAILURE",
        message: `Critical notification delivery to ${delivery.channel} failed ${attempts} times; retry is scheduled.`,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
      });
    }

    if (!marked.deadLettered) {
      this.logger.warn?.(
        JSON.stringify({
          level: "warn",
          code: "NOTIFICATION_RETRY_SCHEDULED",
          eventId: event.id,
          channel: delivery.channel,
          attempts,
          errorClass,
        })
      );
    } else {
      this.logger.error?.(
        JSON.stringify({
          level: "error",
          code: "NOTIFICATION_DEAD_LETTERED",
          eventId: event.id,
          channel: delivery.channel,
          attempts,
          errorClass,
        })
      );
    }

    return {
      deliveryId: delivery.id,
      channel: delivery.channel,
      outcome: marked.deadLettered ? "dead_lettered" : "retry_scheduled",
      errorClass,
      attempts,
      retryInSeconds,
    };
  }

  /** An observable alert in the Owner inbox, delivered immediately if possible. */
  async _raiseAlert({ event, delivery, reasonCode, message, priority = NOTIFICATION_PRIORITY.HIGH }) {
    try {
      const alert = await this.repository.ensureDeliveryAlert({
        sourceEvent: event,
        delivery,
        reasonCode,
        message,
        priority,
      });
      if (alert.deduplicated) return alert;
      const claimed = await this.repository.claimDueDeliveries({
        workerId: `${this.instanceId}-alert`,
        leaseSeconds: this.leaseSeconds,
        limit: 5,
        eventId: alert.event.id,
      });
      for (const entry of claimed) {
        await this.attempt(entry);
      }
      return alert;
    } catch (error) {
      this.logger.error?.(
        JSON.stringify({
          level: "error",
          code: "NOTIFICATION_ALERT_FAILED",
          eventId: event?.id ?? null,
          message: sanitizeNotificationPayload(String(error?.message ?? "ALERT_FAILED")),
        })
      );
      return null;
    }
  }

  /**
   * One delivery cycle: recover abandoned leases, claim due deliveries under a
   * fencing token, attempt each. Never throws for a single delivery failure.
   */
  async runOnce({ eventId = null } = {}) {
    if (this._running) return { skippedCycle: true, reason: "CYCLE_ALREADY_RUNNING" };
    this._running = true;
    const summary = {
      instanceId: this.instanceId,
      recoveredLeases: 0,
      claimed: 0,
      delivered: 0,
      retryScheduled: 0,
      deadLettered: 0,
      failed: 0,
      unconfigured: 0,
      results: [],
    };
    try {
      summary.recoveredLeases = await this.repository.recoverExpiredLeases();
      const claimed = await this.repository.claimDueDeliveries({
        workerId: this.instanceId,
        leaseSeconds: this.leaseSeconds,
        limit: this.batchSize,
        eventId,
      });
      summary.claimed = claimed.length;
      for (const entry of claimed) {
        const outcome = await this.attempt(entry);
        summary.results.push(outcome);
        if (outcome.outcome === "delivered" || outcome.outcome === "already_delivered") summary.delivered += 1;
        else if (outcome.outcome === "retry_scheduled") summary.retryScheduled += 1;
        else if (outcome.outcome === "dead_lettered") summary.deadLettered += 1;
        else summary.failed += 1;
      }
      return summary;
    } finally {
      this._running = false;
    }
  }

  start({ intervalMs = 15_000 } = {}) {
    if (this._timer) return this._timer;
    this._timer = setInterval(() => {
      this.runOnce().catch((error) => {
        this.logger.error?.(
          JSON.stringify({
            level: "error",
            code: "NOTIFICATION_DELIVERY_CYCLE_FAILED",
            message: sanitizeNotificationPayload(String(error?.message ?? "unknown")),
          })
        );
      });
    }, intervalMs);
    this._timer.unref?.();
    return this._timer;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
