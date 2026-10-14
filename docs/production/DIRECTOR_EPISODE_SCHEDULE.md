# Per-Director episode duration & daily production schedule (sql/029)

> Status: implemented and tested offline. Each Director owns an independent,
> persisted episode duration and production schedule. HERMES, the owner API,
> the durable worker loop, and the production pipeline all read that ONE
> configuration, so the duration a Director is configured with is the duration
> the main episode is planned and rendered at.
>
> Honest scope: the scheduler **queues** planned episodes into the existing
> production/approval pipeline. It never publishes, never bypasses the owner
> approval gate (Rule 7), and never enables live workers by itself.

## 1. The settings (and what each one means)

| Setting | Meaning | Allowed values | Default for a new Director |
|---|---|---|---|
| `episodeDurationSeconds` | Target length of the MAIN episode | `1800` (30 min), `2400` (40 min), `3000` (50 min) | **`2400`** |
| `episodesPerDay` | Scheduling target: main episodes per production day | `1`, `2`, `3` as quick choices; any integer `1…6` | `1` |
| `productionDays` | Weekdays that may produce | ISO weekdays `1`(Mon)…`7`(Sun); presets `every_day` `[1..7]` and `five_days_per_week` `[1..5]`; any custom subset | `[1,2,3,4,5,6,7]` |
| `productionStartTime` | Preferred local start time | `HH:MM`, 24-hour | `09:00` |
| `timezone` | IANA zone the start time is interpreted in | any zone the runtime's tz database resolves (`Asia/Kolkata`, `UTC`, …) | `Asia/Kolkata` (fallback only — the owner's configured zone wins) |
| `scheduleEnabled` | Explicit enable/pause flag for FUTURE scheduling | boolean | `false` (paused) |

`episodeDurationMinutes` and `productionDaysLabel` are **derived read-only**
fields in API responses; they are never accepted as input
(`episodeDurationMinutes: 45` is rejected with `SCHEDULE_DURATION_INVALID`).

### Validation limits and error codes

Validation is server-side and total: unknown fields fail closed
(`REQUEST_VALIDATION_FAILED`), and the column CHECK constraints in `sql/029`
mirror it so an out-of-range value cannot be persisted even by a direct write.

| Input | Rejected with |
|---|---|
| duration not in `{1800, 2400, 3000}` (including a minutes shorthand) | `SCHEDULE_DURATION_INVALID` |
| `episodesPerDay` not an integer in `1…6` | `SCHEDULE_EPISODES_PER_DAY_INVALID` |
| empty day list, a day outside `1…7`, duplicates collapsing to nothing | `SCHEDULE_PRODUCTION_DAYS_INVALID` |
| start time that is not `HH:MM` on a 24-hour clock | `SCHEDULE_START_TIME_INVALID` |
| a zone the runtime cannot resolve | `SCHEDULE_TIMEZONE_INVALID` |
| `scheduleEnabled` that is not a boolean | `SCHEDULE_ENABLED_INVALID` |
| unknown field | `REQUEST_VALIDATION_FAILED` |

A positive `episodesPerDay` is a **scheduling target**, not a promise: the run
still has to pass capacity, quota, dependency, and QC gates (§5).

## 2. Data model

`sql/029_director_production_schedule.sql` (additive; R1 — applied migrations
are never edited) adds two tables:

- **`director_schedules`** — one row per `(owner_id, agent_id)`
  (`UNIQUE (owner_id, agent_id)`): `episode_duration_seconds`,
  `episodes_per_day`, `production_days` (compact `'1,2,3'` string),
  `production_start_time`, `timezone`, `schedule_enabled`, `created_at`,
  `updated_at`.
- **`director_schedule_slots`** — the durable IDEMPOTENT reservation of one
  scheduled production slot per `(owner_id, agent_id, schedule_date,
  slot_index)`, with `episode_duration_seconds`, `state`
  (`pending | queued | delayed | blocked | skipped`), a stable `reason_code`,
  and the `release_id` / `job_id` / `season` / `episode` it produced.

Isolation is structural (Rules 5/16): every statement is scoped by BOTH
`owner_id` and `agent_id`. A Director's settings never leak into another
Director's row, queue, or releases; a cross-owner read is indistinguishable
from a missing row (generic `AGENT_NOT_FOUND` → 404).

No credential, token, or secret-shaped field exists in either table
(Rule 17) — the schedule is intent only. Rollback: the migration is additive
and reversible by dropping the two tables; no existing table is altered and
existing Director/release/job records are untouched.

## 3. Owner API (`/api/scheduling`, authenticated + CSRF on mutations)

| Route | Purpose |
|---|---|
| `GET /limits` | The declared duration/frequency limits (`episodeDurationOptionsSeconds`, `episodesPerDayOptions`, `episodesPerDaySafeLimit`, day presets, scheduler defaults). The dashboard renders these; it never invents them. |
| `GET /directors` | Every Director's own schedule + planned slots + next eligible slot + TRUTHFUL queue/release counters. |
| `GET /directors/:agentId` | One Director's schedule, counters, next eligible slot, and recent slot history. Unconfigured Directors report `configured:false` with the documented defaults. |
| `PUT /directors/:agentId` | Create/update the schedule (CSRF + audit `director_schedule_saved`). Partial updates are allowed: omitted fields keep the stored value or the default. |
| `POST /directors/:agentId/run` | Run ONE scheduler tick for that Director (`{ dryRun: true }` plans without writing; CSRF + audit `production_schedule_tick`). |

Only the safe DTO serializes (Rules 15/17): scheduling fields, counters, slots.
The agent id is the only identifier that appears — internal agent names are
never exposed.

The dashboard panel **Episode & Schedule** (`public/index.html` +
`public/dashboard.js`) edits exactly this API: duration, episodes per day,
weekday checkboxes, start time, timezone, and the enable/pause switch, plus a
per-Director view of config, next eligible slot, planned/queued/delayed/blocked/
skipped slot counts, queued vs completed jobs, awaiting-approval releases, and
the last scheduled slot with its honest state and reason code.

## 4. How scheduling works

`runDirectorScheduleTick` (`src/scheduling/productionScheduler.js`) is the ONLY
scheduler — there is no second competing scheduler.

1. Read the Director's persisted settings (`record.settings`). A row that fails
   the contract re-validates to `invalid` and the run is refused with the
   stable reason instead of being "repaired".
2. Compute eligible local dates from `productionDays` within a bounded lookback
   (`DEFAULT_LOOKBACK_DAYS = 1`; the API accepts `0…14`), resolving
   `productionStartTime` in the Director's own `timezone` (DST-aware — the zone
   is resolved through the runtime's tz database, never a fixed offset).
3. For each eligible date, produce `episodesPerDay` distinct slot indices
   (`slot_index` `0…5`) with their own start times.
4. Claim the slot through the repository:
   `INSERT … ON CONFLICT (owner_id, agent_id, schedule_date, slot_index) DO NOTHING`.
   A second run for the same slot claims nothing (see §6).
5. Before creating work, check capacity/quota (see §5). A slot that cannot run
   is recorded as `delayed` or `blocked` **with its reason code** — never
   silently dropped and never reported as an episode.
6. Create the episode through the SAME transactional release+job path the owner
   API uses (`createReleaseWithJob`), stamping the Director's configured
   `episodeDurationSeconds` on the job payload, and mark the slot `queued` with
   its `releaseId`/`jobId`/`season`/`episode`.

Stable slot states: `pending`, `queued`, `delayed`, `blocked`, `skipped`.
Stable reasons: `SLOT_ALREADY_CLAIMED`, `CAPACITY_LIMIT_REACHED`,
`PROVIDER_QUOTA_EXHAUSTED`, `PRODUCTION_UNAVAILABLE`, `DIRECTOR_DISABLED`,
`PRODUCTION_SLOT_TAKEN`, `SCHEDULE_QUEUE_FAILED`, `MISSED_SCHEDULE_WINDOW`.

### Episode numbering

A scheduled episode continues the channel's own sequence: the next season/
episode is derived from the channel's existing releases, so a Director's
schedule and its manual owner-created episodes share one numbering. The
`(channel_id, season, episode)` uniqueness from `sql/019/020` still applies — a
taken slot is reported as `PRODUCTION_SLOT_TAKEN`, never duplicated.

## 5. Capacity, provider quotas, and honest blocking

Planned output is never confused with completed output. Before creating a job
the tick accounts for:

- **Concurrency**: `maxConcurrentJobsPerDirector`
  (`DEFAULT_MAX_CONCURRENT_JOBS_PER_DIRECTOR = 3`, API-bounded to `1…8`).
  Active jobs (`queued | leased | running`) for that Director count against it,
  so a Director never exceeds its own limit and cannot touch another Director's
  queue.
- **Provider quota**: an optional `quotaSnapshotProvider` supplies the real
  snapshot; exhausted capacity records `PROVIDER_QUOTA_EXHAUSTED` and the slot
  stays `delayed` (retry later) instead of starting work that would fail.
- **Dependencies**: without an available production repository the slot is
  `blocked` with `PRODUCTION_UNAVAILABLE`; a disabled Director is
  `DIRECTOR_DISABLED`.
- **Missed windows**: at most `lookbackDays` past dates are examined per run, so
  a long outage cannot generate an uncontrolled backlog
  (`MISSED_SCHEDULE_WINDOW` for what is out of scope).

No provider is contacted by the scheduler, no fallback is silently switched to
a paid provider, and no media/receipt is ever fabricated (Rules 1–3).

## 6. Deduplication guarantees

Deduplication is database-enforced, not best-effort:

1. `director_schedule_slots` is `UNIQUE (owner_id, agent_id, schedule_date,
   slot_index)`; the claim is `ON CONFLICT DO NOTHING`, so two concurrent runs
   (or a retry after a crash) produce exactly ONE slot row and ONE episode.
2. The episode itself goes through `createReleaseWithJob`, which is unique per
   `(channel_id, season, episode)` (Rule 8: a failed attempt creates a new job,
   never a second logical Reel/episode).
3. The job carries `idempotency_key = production-<releaseId>` so the existing
   lease/retry path cannot double-process it.
4. A repeated tick reports the attempt as a duplicate (`totals.duplicates`) and
   creates nothing.

## 7. Pausing and resuming

`scheduleEnabled: false` is the safe default: a paused Director is skipped as
`pausedDirectors` and creates no slots at all — saving a schedule, and enabling
one, never starts production as a side effect. Setting it back to `true`
resumes FUTURE scheduling only: already-recorded slots keep their real state,
and no missed dates are back-filled beyond the bounded lookback. Pausing is
per-Director and cannot affect another Director's queue.

Enabling a schedule does **not** publish. Publishing still requires an
unexpired owner approval bound to the exact artifact hash, destination,
caption, affiliate links, and disclosure (Rule 7), and live publishing also
requires the destination's credentials — neither is touched by this feature.

## 8. Where the configured duration reaches production

The resolution order is contract, implemented in
`resolveEpisodeTargetDuration` (`src/pipeline/episodePipeline.js`):

1. the Director's persisted schedule (`source: "director_schedule"`),
2. the duration stamped on the queued job (`source: "job_payload"`),
3. the documented default (`source: "default"`, 2400 s).

A value that is PRESENT but not selectable throws `EPISODE_DURATION_INVALID` —
a corrupted configuration fails the run instead of silently rendering a
different length.

Consumers:

- **HERMES** (`src/manager/hermesJobBridge.js`, `src/api/hermesRouter.js`) reads
  the Director's own schedule through the injected
  `directorScheduleProvider` and stamps `episodeDurationSeconds` on the real
  release+job it queues (an explicit payload value still wins).
- **Owner production route** (`POST /api/productions`) stamps the Director's
  configured duration the same way, and `GET /api/channels/:id` exposes it to
  the dashboard.
- **The durable worker** (`src/pipeline/workerLoop.js`) resolves each claimed
  job's Director schedule and passes it into `runEpisodePipeline`.
- **Planning**: every pipeline stage input carries
  `targetDurationSeconds`/`targetDurationSource`; the deterministic assembly
  manifest reports `plannedEpisodeDurationSeconds` (planned — never a fabricated
  measured value).
- **The executor boundary** (`src/pipeline/productionExecutorRunner.js`): the
  configured duration is handed to every executor stage, and
  `buildLongformAssemblyPlan` renders the `main_longform` segment at that
  duration. The post-render QC duration gate then measures the REAL ffprobe
  duration; a render that does not report the configured target fails closed
  with `EXECUTOR_TARGET_DURATION_NOT_APPLIED`.
- **Short-form is untouched**: the two content Reels + one brand Reel keep their
  own 3–90 s window, and the 2+1 package rule (Rule 8) is unchanged. The
  per-episode package relationship is unchanged by this feature: one completed
  episode still yields one main video plus its 2+1 promotion package.

If a 50-minute episode cannot be finished within the available capacity/quota,
it stays queued/delayed/blocked with the reason code — it is never marked
complete, and the existing main-video duration window is not weakened.

## 9. Security and auditability

- Every route requires a valid authenticated owner session; mutations require
  the per-session CSRF token (`x-csrf-token`) exactly like the other owner
  routers, and fail closed with `CSRF_TOKEN_INVALID`.
- Owner identity is server-authoritative (`req.ownerId`); the Director is
  scoped by `(owner, agent)`. Unauthorized or cross-Director access is a generic
  404/409 — it never reveals another Director's configuration.
- Validation runs server-side, so the dashboard cannot bypass it.
- Auditable state changes: `director_schedule_saved`,
  `scheduled_production_queued`, and `production_schedule_tick` (counters only).
- No secret is read, stored, or logged anywhere in this flow (Rule 17), and
  API responses use explicit safe DTOs (Rules 15/17).
- Without configured storage the routes degrade honestly with
  `503 STORAGE_NOT_CONFIGURED` instead of faking a schedule.

## 10. Tests

| Command | Covers |
|---|---|
| `node --test tests/directorScheduleContract.test.js` | defaults, independent per-Director settings, duration/frequency/day/timezone/start-time validation, DTO allowlist |
| `node --test tests/productionScheduler.test.js` | 1/2/3 episodes per day → distinct slots; 5-day and 7-day and custom weekday schedules; timezone/date-boundary behavior; duplicate runs create nothing; concurrency limits; pause/resume; bounded backlog; quota honesty; retry idempotency; cross-Director isolation |
| `node --test tests/directorScheduleApi.test.js` | real routes over demo storage: auth required, CSRF enforced, save/persist/reload, backend validation not bypassable, paused queues nothing, enabled queues exactly one due slot and is idempotent, second-owner isolation, nothing published |
| `node --test tests/episodeDurationPipeline.test.js` | duration precedence, fail-closed on a corrupted duration, the configured duration reaching the executor runner and the long-form render target, planned-not-measured manifests, durable quota waits, hold at the owner review gate |
| `node --test tests/hermesJobBridge.test.js` | HERMES queues with the Director's configured duration |
| `node --test tests/backgroundSchedulerTrigger.test.js` | the opt-in background trigger: interval parsing bounds, injected-timer start/stop/overlap-skip/failure accounting, and the cross-owner durable tick   (per-owner scoping, bounded catch-up, audit, duplicate idempotency, failure isolation) |

`npm test`, `npm run verify`, and `npm run lint` must pass (Definition of Done).

### 10.1 The opt-in background scheduler trigger

`scheduling/backgroundSchedulerTrigger.js` closes the in-process half of item
2 below. When `STPH_ENABLE_SCHEDULE_TRIGGER=1` at server startup (with real
PostgreSQL configured), the server starts a durable tick every
`STPH_SCHEDULER_TICK_MINUTES` minutes (integer, 1–1440, default 15) that runs
**all** enabled schedules for **all** owners through the SAME durable,
idempotent `runDirectorScheduleTick` the owner route uses — same admission
gates, same bounded lookback, same per-owner audit events
(`scheduled_production_queued`, `production_schedule_tick_background`). Honest
by construction: still nothing published (Rule 7 unchanged), a failing owner
does not block the others, an overlapping tick is skipped and counted, a
storage error is recorded as a failure (never faked green), and the flag
defaults OFF — enabling it is an explicit deployment decision.

## 11. Remaining deployment requirements (owner action)

The scheduler logic, persistence, API, UI, and pipeline propagation are
complete and verified offline. Operating it unattended still needs:

1. **A real PostgreSQL deployment** with `sql/029` applied through the existing
   migration runner (`npm run migrate`). Until then the routes degrade with
   honest 503s and demo mode is in-memory only.
2. **A reliable background trigger.** `POST /api/scheduling/directors/:agentId/run`
   is an owner/agent-triggered tick; the durable worker loop
   (`STPH_ENABLE_WORKERS=1`) processes what the tick queued. The in-process
   trigger (§10.1) now covers the agent-less case with an explicit opt-in
   (`STPH_ENABLE_SCHEDULE_TRIGGER=1`, cadence via `STPH_SCHEDULER_TICK_MINUTES`)
   and observes `delayed`/`blocked` reasons through the same report. A deployment
   may instead (or additionally) run an external cron that calls the owner route;
   nothing enables either automatically.
3. **Provider capacity and quota snapshots** so `PROVIDER_QUOTA_EXHAUSTED` is
   driven by real data rather than remaining a truthful block.
4. **Owner-approval + destination credentials** before anything publishes
   (Rule 7; Issue #118).

Until 1–4 are done, this feature is verified code-side only: schedules persist
and queue real releases/jobs, but no live provider call, render, or upload is
claimed.
