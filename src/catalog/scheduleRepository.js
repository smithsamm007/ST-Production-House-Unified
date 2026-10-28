/**
 * ST Production House — Director schedule repository (sql/029).
 *
 * Persists each Director's OWN episode & production schedule and the durable,
 * idempotent reservation of every scheduled production slot.
 *
 * Security contract (AGENTS.md Rules 5, 6, 13, 15, 17):
 *   - Every statement is parameterized and scoped by BOTH owner_id and
 *     agent_id: a cross-owner or cross-Director read is indistinguishable from
 *     a missing row (generic NOT_FOUND up the stack). Directors never share
 *     schedule state.
 *   - No credential, locator, or secret-shaped field is accepted or stored:
 *     the schedule carries scheduling intent only (Rule 17).
 *   - Outbound rows use explicit allowlisted DTOs (Rule 15/17) — the internal
 *     agent id is the only identifier that serializes, never an agent name.
 *   - Slot reservation is the IDEMPOTENCY GATE (Rule 13): the unique key
 *     (owner, agent, schedule_date, slot_index) means a repeated scheduler run
 *     cannot create a second logical episode for a slot.
 *
 * Portability contract: statements stay inside the SQL subset shared by the
 * PostgreSQL adapter and the labeled demo adapter (single-table statements, no
 * table aliases, no joins, inlined validated integer LIMITs, no array
 * operators).
 */

import {
  EPISODE_DURATION_OPTIONS_SECONDS,
  directorScheduleDto,
  parseProductionDays,
  serializeProductionDays,
  validateDirectorScheduleInput,
} from "../scheduling/directorSchedule.js";
import {
  SCHEDULER_REASON_CODES,
  SLOT_STATES,
} from "../scheduling/productionScheduler.js";

const MAX_LIST_LIMIT = 200;
const SLOT_LIST_LIMIT = 500;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function boundedLimit(raw, fallback, max = MAX_LIST_LIMIT) {
  const n = Math.floor(Number(raw));
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Safe slot DTO: persisted scheduling state only, explicit allowlist. */
export function scheduleSlotDto(row) {
  return Object.freeze({
    scheduleDate: row.schedule_date ?? null,
    slotIndex: row.slot_index === null || row.slot_index === undefined ? null : Number(row.slot_index),
    state: row.state ?? null,
    reasonCode: row.reason_code ?? null,
    episodeDurationSeconds:
      row.episode_duration_seconds === null || row.episode_duration_seconds === undefined
        ? null
        : Number(row.episode_duration_seconds),
    releaseId: row.release_id ?? null,
    jobId: row.job_id ?? null,
    season: row.season === null || row.season === undefined ? null : Number(row.season),
    episode: row.episode === null || row.episode === undefined ? null : Number(row.episode),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export class DirectorScheduleRepository {
  constructor(db) {
    if (!db || typeof db.query !== "function") throw fail("STORAGE_NOT_CONFIGURED");
    this.db = db;
  }

  // ------------------------------------------------------------------
  // Settings (one row per owner + Director)
  // ------------------------------------------------------------------

  /** Raw schedules for one owner, optionally narrowed to specific Directors. */
  async listScheduleRows(ownerId, { agentIds = null } = {}) {
    if (Array.isArray(agentIds) && agentIds.length > 0) {
      const rows = [];
      for (const agentId of agentIds.slice(0, 50)) {
        const result = await this.db.query(
          "SELECT * FROM director_schedules WHERE owner_id = $1 AND agent_id = $2;",
          [ownerId, agentId],
        );
        rows.push(...result.rows);
      }
      return rows;
    }
    const result = await this.db.query(
      "SELECT * FROM director_schedules WHERE owner_id = $1 ORDER BY agent_id ASC LIMIT " +
        boundedLimit(MAX_LIST_LIMIT, MAX_LIST_LIMIT, MAX_LIST_LIMIT) + ";",
      [ownerId],
    );
    return result.rows;
  }

  /**
   * Scheduling-ready records: `{ agentId, settings, invalid, invalidReason,
   * row, dto }`. A row that fails the contract validation is returned with
   * `settings: null` (never silently repaired, never scheduled).
   */
  async listScheduleRecords(ownerId, { agentIds = null } = {}) {
    const rows = await this.listScheduleRows(ownerId, { agentIds });
    return rows.map((row) => {
      let settings = null;
      let invalidReason = null;
      try {
        settings = validateDirectorScheduleInput({
          episodeDurationSeconds: Number(row.episode_duration_seconds),
          episodesPerDay: Number(row.episodes_per_day),
          // The stored form is the compact '1,2,3' string, so it must be parsed
          // back into weekday numbers before the contract re-validates it.
          productionDays: parseProductionDays(String(row.production_days)),
          productionStartTime: String(row.production_start_time),
          timezone: String(row.timezone),
          scheduleEnabled: row.schedule_enabled === true,
        });
      } catch (err) {
        invalidReason = err?.code ?? "SCHEDULE_INPUT_INVALID";
      }
      return Object.freeze({
        agentId: row.agent_id,
        settings,
        invalid: settings === null,
        invalidReason,
        row,
        dto: directorScheduleDto(row),
      });
    });
  }

  /**
   * Server-internal export for the background scheduler trigger ONLY — never
   * an HTTP route. Returns the SAME validated record shape as
   * listScheduleRecords for every owner row with `schedule_enabled = true`,
   * plus `ownerId` so the tick can keep every write scoped to that row's own
   * owner (Director isolation is never widened by this read).
   */
  async listAllEnabledScheduleRecords() {
    // Portability contract: single-table statement, inlined validated LIMIT.
    const result = await this.db.query(
      "SELECT * FROM director_schedules WHERE schedule_enabled = TRUE ORDER BY owner_id ASC, agent_id ASC LIMIT 2000;",
    );
    return result.rows.map((row) => {
      let settings = null;
      let invalidReason = null;
      try {
        settings = validateDirectorScheduleInput({
          episodeDurationSeconds: Number(row.episode_duration_seconds),
          episodesPerDay: Number(row.episodes_per_day),
          productionDays: parseProductionDays(String(row.production_days)),
          productionStartTime: String(row.production_start_time),
          timezone: String(row.timezone),
          scheduleEnabled: row.schedule_enabled === true,
        });
      } catch (err) {
        invalidReason = err?.code ?? "SCHEDULE_INPUT_INVALID";
      }
      return Object.freeze({
        ownerId: row.owner_id,
        agentId: row.agent_id,
        settings,
        invalid: settings === null,
        invalidReason,
        row,
      });
    });
  }

  async getScheduleRow(ownerId, agentId) {
    const result = await this.db.query(
      "SELECT * FROM director_schedules WHERE owner_id = $1 AND agent_id = $2;",
      [ownerId, agentId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Create or replace one Director's schedule. The settings arrive already
   * normalized by the contract; this method re-validates before writing
   * (defense in depth on top of the column CHECK constraints).
   */
  async upsertSchedule(ownerId, agentId, settings) {
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 80) {
      throw fail("SCHEDULE_INPUT_INVALID");
    }
    const normalized = validateDirectorScheduleInput(settings);
    const result = await this.db.query(
      `INSERT INTO director_schedules
         (owner_id, agent_id, episode_duration_seconds, episodes_per_day, production_days,
          production_start_time, timezone, schedule_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (owner_id, agent_id)
       DO UPDATE SET
         episode_duration_seconds = EXCLUDED.episode_duration_seconds,
         episodes_per_day = EXCLUDED.episodes_per_day,
         production_days = EXCLUDED.production_days,
         production_start_time = EXCLUDED.production_start_time,
         timezone = EXCLUDED.timezone,
         schedule_enabled = EXCLUDED.schedule_enabled,
         updated_at = now()
       RETURNING *;`,
      [
        ownerId,
        agentId,
        normalized.episodeDurationSeconds,
        normalized.episodesPerDay,
        serializeProductionDays(normalized.productionDays),
        normalized.productionStartTime,
        normalized.timezone,
        normalized.scheduleEnabled,
      ],
    );
    return directorScheduleDto(result.rows[0]);
  }

  // ------------------------------------------------------------------
  // Scheduled slots (idempotent reservations)
  // ------------------------------------------------------------------

  /**
   * Claim one scheduled slot. Returns `{ claimed: true }` exactly once for a
   * given (owner, Director, local date, slot index) — every later attempt for
   * the same slot returns `{ claimed: false }` and creates nothing.
   */
  async claimSlot({ ownerId, agentId, scheduleDate, slotIndex, episodeDurationSeconds }) {
    if (typeof scheduleDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate)) {
      throw fail("SCHEDULE_DATE_INVALID");
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 5) {
      throw fail("SCHEDULE_INPUT_INVALID");
    }
    if (!EPISODE_DURATION_OPTIONS_SECONDS.includes(episodeDurationSeconds)) {
      throw fail("SCHEDULE_DURATION_INVALID");
    }
    const result = await this.db.query(
      `INSERT INTO director_schedule_slots
         (owner_id, agent_id, schedule_date, slot_index, episode_duration_seconds, state)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (owner_id, agent_id, schedule_date, slot_index) DO NOTHING
       RETURNING id;`,
      [ownerId, agentId, scheduleDate, slotIndex, episodeDurationSeconds],
    );
    return Object.freeze({ claimed: result.rows.length > 0 });
  }

  /** Record the honest, final state of a claimed slot (with its reason). */
  async markSlot(ownerId, agentId, scheduleDate, slotIndex, {
    state,
    reasonCode = null,
    releaseId = null,
    jobId = null,
    season = null,
    episode = null,
  } = {}) {
    if (!SLOT_STATES.includes(state)) throw fail("SCHEDULE_INPUT_INVALID");
    if (reasonCode !== null && !SCHEDULER_REASON_CODES.includes(reasonCode)) {
      throw fail("SCHEDULE_INPUT_INVALID");
    }
    const result = await this.db.query(
      `UPDATE director_schedule_slots
          SET state = $5,
              reason_code = $6,
              release_id = $7,
              job_id = $8,
              season = $9,
              episode = $10,
              updated_at = now()
        WHERE owner_id = $1 AND agent_id = $2 AND schedule_date = $3 AND slot_index = $4;`,
      [ownerId, agentId, scheduleDate, slotIndex, state, reasonCode, releaseId, jobId, season, episode],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** One already-recorded slot (raw row) or null — used to re-attempt delays. */
  async getSlot(ownerId, agentId, scheduleDate, slotIndex) {
    const result = await this.db.query(
      "SELECT * FROM director_schedule_slots WHERE owner_id = $1 AND agent_id = $2 AND schedule_date = $3 AND slot_index = $4;",
      [ownerId, agentId, scheduleDate, slotIndex],
    );
    return result.rows[0] ?? null;
  }

  /** One Director's persisted slots, newest local date first. */
  async listSlots(ownerId, agentId, { limit } = {}) {
    const result = await this.db.query(
      "SELECT * FROM director_schedule_slots WHERE owner_id = $1 AND agent_id = $2 " +
        "ORDER BY schedule_date DESC, slot_index ASC LIMIT " +
        boundedLimit(limit, SLOT_LIST_LIMIT, SLOT_LIST_LIMIT) + ";",
      [ownerId, agentId],
    );
    return result.rows.map(scheduleSlotDto);
  }

  /**
   * Truthful slot counters for one Director. Counting happens in JS over one
   * bounded parameterized read (shared SQL subset) — planned/delayed/blocked
   * rows are reported as what they are and never as completed episodes.
   */
  async countSlotsByState(ownerId, agentId) {
    const rows = await this.listSlots(ownerId, agentId, { limit: SLOT_LIST_LIMIT });
    const counts = { pending: 0, queued: 0, delayed: 0, blocked: 0, skipped: 0, total: rows.length };
    for (const row of rows) {
      if (Object.hasOwn(counts, row.state)) counts[row.state] += 1;
    }
    return Object.freeze(counts);
  }

  /** The Director's most recent slot row (raw), or null. */
  async getLastSlot(ownerId, agentId) {
    const result = await this.db.query(
      "SELECT * FROM director_schedule_slots WHERE owner_id = $1 AND agent_id = $2 " +
        "ORDER BY schedule_date DESC, slot_index DESC LIMIT 1;",
      [ownerId, agentId],
    );
    return result.rows[0] ?? null;
  }
}

export default DirectorScheduleRepository;
