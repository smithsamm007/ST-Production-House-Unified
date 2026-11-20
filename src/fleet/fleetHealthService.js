/**
 * ST Production House — Fleet health escalation service (Day 5 / D7).
 *
 * Turns the persisted fleet snapshot into durable, deduplicated escalations and
 * (when a notifier and an Owner id are available) into the Day 4 notification
 * outbox. Two honest degenerations:
 *
 *   - no notifier / no Owner id  -> the escalation row is still persisted and
 *     `notificationEventId` stays null; the Owner inbox is never faked.
 *   - notification dispatch throws -> the durable escalation survives, because a
 *     delivery problem must never erase the operational fact.
 *
 * Health is derived from `director_tasks`, `director_workers` and registry rows
 * only. A closed browser is never "OFFLINE": OFFLINE requires a registered
 * runtime whose heartbeat genuinely expired (database clock).
 */

import { NOTIFICATION_EVENT_TYPE, NOTIFICATION_PRIORITY } from "../notifications/notificationPolicy.js";
import { FLEET_HEALTH_STATE, HEARTBEAT_TTL_SECONDS } from "./fleetPolicy.js";

function eventTypeFor(code) {
  if (code === "DIRECTOR_HEARTBEAT_LOST") return NOTIFICATION_EVENT_TYPE.WORKER_CRASH;
  if (code === "DIRECTOR_PROVIDER_BLOCKED") return NOTIFICATION_EVENT_TYPE.PROVIDER_QUOTA_EXHAUSTED;
  if (code === "DIRECTOR_REPEATED_TASK_FAILURE") return NOTIFICATION_EVENT_TYPE.DIRECTOR_PRODUCTION_FAILED;
  if (code === "DIRECTOR_PRODUCTION_BLOCKED") return NOTIFICATION_EVENT_TYPE.DIRECTOR_PRODUCTION_FAILED;
  return NOTIFICATION_EVENT_TYPE.DIRECTOR_PRODUCTION_FAILED;
}

function severityFor(healthState) {
  if (healthState === FLEET_HEALTH_STATE.BLOCKED || healthState === FLEET_HEALTH_STATE.OFFLINE) return "critical";
  if (healthState === FLEET_HEALTH_STATE.DEGRADED) return "warn";
  return "info";
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export class FleetHealthService {
  constructor({ repository, notifier = null, ownerId = null, now = () => new Date() } = {}) {
    if (!repository) throw new Error("FLEET_REPOSITORY_REQUIRED");
    this.repository = repository;
    this.notifier = notifier;
    this.ownerId = ownerId;
    this.now = now;
  }

  /**
   * One health pass: expire genuinely dead runtimes, build the snapshot, persist
   * escalations for every Director whose real records justify one.
   */
  async scan({ heartbeatTtlSeconds = HEARTBEAT_TTL_SECONDS, ownerId = this.ownerId } = {}) {
    const expiredWorkers = await this.repository.expireWorkers({ ttlSeconds: heartbeatTtlSeconds });
    const snapshot = await this.repository.fleetSnapshot({ heartbeatTtlSeconds });
    const day = dayKey(this.now());
    const escalations = [];

    for (const director of snapshot.directors) {
      if (!director.escalationCode) continue;
      const severity = severityFor(director.healthState);
      const detail = [
        `${director.directorId} is ${director.healthState}`,
        `active=${director.activeTasks}`,
        `queued=${director.queuedTasks}`,
        `blocked=${director.blockedTasks}`,
        `failed=${director.failedTasks}`,
        director.providerBlocked ? "provider=blocked" : null,
      ]
        .filter(Boolean)
        .join(" ");

      let notificationEventId = null;
      if (this.notifier && ownerId) {
        try {
          const result = await this.notifier.dispatch({
            eventType: eventTypeFor(director.escalationCode),
            priority: severity === "critical" ? NOTIFICATION_PRIORITY.CRITICAL : NOTIFICATION_PRIORITY.HIGH,
            ownerId,
            directorId: director.directorId,
            taskRef: null,
            idempotencyKey: `fleet-escalation:${director.directorId}:${director.escalationCode}:${day}`,
            payload: {
              code: director.escalationCode,
              healthState: director.healthState,
              activeTasks: director.activeTasks,
              queuedTasks: director.queuedTasks,
              blockedTasks: director.blockedTasks,
              failedTasks: director.failedTasks,
              providerBlocked: director.providerBlocked,
            },
          });
          notificationEventId = result?.event?.id ?? null;
        } catch {
          // Delivery/transport failure never deletes the operational escalation.
          notificationEventId = null;
        }
      }

      escalations.push(
        await this.repository.recordEscalation({
          directorId: director.directorId,
          code: director.escalationCode,
          severity,
          detail,
          dedupeKey: `fleet-escalation:${director.directorId}:${director.escalationCode}:${day}`,
          notificationEventId,
        })
      );
    }

    return {
      generatedAt: snapshot.generatedAt,
      snapshot,
      expiredWorkers,
      escalations,
      heartbeatTtlSeconds,
    };
  }
}
