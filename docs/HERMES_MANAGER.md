# Hermes Manager Layer (Issue #166)

Hermes is the **ST MANAGER**: the orchestration layer between the Owner and
the Directors. It decides what happens next, where work runs, and in what
order — then records every decision as an immutable, auditable record.

```
OWNER (ultimate authority)
  └── HERMES (manager: decision authority, zero secret access)
        └── DIRECTORS (independent content units, up to 50)
              └── WORKERS / PROVIDERS (execution layer)
```

Hermes does not replace the Directors and never becomes a stage inside
another Director's workflow (Blueprint §2). It coordinates: which Director
produces next, which approved provider is used, when work starts, what gets
retried, and what enters the DLQ. The Owner keeps ultimate authority through
an explicit authority matrix — not through trust.

## Authority matrix

`src/manager/authorityMatrix.js` is the ONLY authority surface. It is
frozen, closed, and fail-closed: an action that is not listed is refused,
and a listed prohibited action cannot be executed even with an owner
approval.

| Class | Actions | Effect |
|---|---|---|
| `AUTONOMOUS` | production start/stop/retry/QC/media/script · schedule change/prioritize/topic/research · provider select/rotate/fallback/health/quota · workload rebalance, DLQ, backlog/analytics/cost reads | Hermes decides and executes within owner-defined limits (quotas, schedules, per-agent policies enforce the limits downstream) |
| `OWNER_POLICY_CONTROLLED` | publish publicly, change destination, delete critical data, commit spend | Hermes may PROPOSE; execution requires an explicit, unexpired owner approval reference (Rules 7/8/9) |
| `PROHIBITED` | read secret values, export API keys, change owner credentials, disable security controls, modify audit ledger, bypass approvals | Structurally refused — recorded, never executed |

## Secrets: never seen, never held

Hermes addresses credentials by **REFERENCE**:

```text
Credential: JARVIS / Gemini / production
```

The credential broker resolves the reference and supplies the credential
directly to the authorized adapter (Rules 4/5/17). Hermes never sees:

```text
AIza…  sk-…  Bearer …  client_secret…
```

Two structural defenses:

1. **Payload gate** (`assertDecisionPayloadSafe`): every decision payload is
   validated recursively server-side. Fields named like secrets
   (`api_key`, `token`, `password`, …) and values shaped like live key
   material are REJECTED before any record exists.
2. **DTO allowlist** (`hermesDecisionDto`): records serialize only an
   explicit field list. What the dashboard shows is exactly what exists —
   there is no serialization path for secret material.

## Honest outcomes (Rule 1)

Decision outcomes are a closed record-level enum: `EXECUTING | EXECUTED |
FAILED | BLOCKED | OWNER_APPROVAL_REQUIRED`. A decision becomes `EXECUTED`
ONLY when the ST evidence ledger confirms the receipt (`found: true`).
Unverified "success" lands as `FAILED` with `EVIDENCE_UNVERIFIED`. Refusals
(`BLOCKED`) are recorded too — a security refusal is audit evidence, not an
error to hide.

Records are **append-only**: a completion appends a superseding record; the
original is never mutated. The full decision history reads like:

```text
HERMES DECISION #000184
  Director: agent-01
  Action:   production.start            [AUTONOMOUS]
  Reason:   Scheduled daily production slot available.
  Payload:  { "providerKey": "gemini" }
  Outcome:  EXECUTING → EXECUTED (EVIDENCE_VERIFIED)
```

## API surface

Mounted at `/api/hermes` behind `authenticateOwner`; mutations require a
per-session CSRF token; every state change writes an audit event.

| Route | Purpose |
|---|---|
| `GET /authority` | The frozen matrix itself (transparency for the owner) |
| `GET /overview` | Counts by outcome/category, refusals, pending approvals |
| `GET /decisions` | Auditable decision history (safe DTO, bounded limit) |
| `POST /decisions` | Record one decision (authority enforced server-side) |
| `POST /decisions/:n/complete` | Honest completion (ledger-verified) |

The dashboard renders the Command Center panel from these endpoints only.

## Execution: decisions → the durable job pipeline (Issue #168)

`src/manager/hermesJobBridge.js` executes decisions against the REAL
pipeline. A `production.start` decision in state `EXECUTING` queues an
episode through the SAME transactional path as the owner API
(`createReleaseWithJob`): one `production_releases` row + one queued
`episode_production` job in the durable `jobs` table, database-unique per
(channel, season, episode) — a failed attempt never creates a second
logical release (Rule 8).

Guards, in order (every refusal is recorded as a FAILED decision or, for
terminal decisions, refused without rewriting history):

1. Decision exists (else `DECISION_NOT_FOUND` — generic, no leak).
2. Outcome is `EXECUTING` (`BLOCKED`/`FAILED`/`EXECUTED` are terminal — a
   BLOCKED refusal is never rewritten as a FAILED execution).
3. Action is `production.start` (the bridge grows one action at a time
   through governed slices; `EXECUTION_ACTION_NOT_EXECUTABLE` otherwise).
4. Payload matches the owner-API bounds (`channelId, title 1..200, season
   1..100, episode 1..2000`).
5. Channel resolves for the SESSION owner (`CHANNEL_NOT_FOUND` otherwise),
   agent enabled (`AGENT_DISABLED`).
6. **Tenant isolation (Rule 5)**: the decision's `directorId` must equal
   the channel's `agentId` — Hermes cannot queue work for one director
   under another director's channel identity (`DIRECTOR_CHANNEL_MISMATCH`).

On success the bridge appends an evidence event (`production_queued`,
subjectId = releaseId) and the decision completes `EXECUTED` only after
the ledger verifies that receipt (Rule 1). The durable worker (or the
owner's `/run` route) then drives the release through the deterministic
pipeline exactly as before — Hermes changes WHO decides, not HOW work
runs.

API: `POST /api/hermes/decisions/:decisionNumber/execute` (authenticated,
CSRF, audit event). `201` when work was queued, `409` when refused, `200`
with the FAILED decision record when the attempt failed honestly.

## What is deliberately NOT done

- No autonomous scheduler/loop is started by this slice: execution is
  explicit (an owner-authenticated `execute` call). A bounded autonomous
  loop is a future governed slice with its own concurrency/duration limits.
- The process-lifetime decision store is the labeled demo transport; a
  PostgreSQL-backed store implementing the same `append/list` contract is a
  follow-up migration (R1).
- Only `production.start` executes. Retry/DLQ/provider-rotation execution
  land as separate governed slices, each reusing this bridge's guards.
- No secret values, no network calls, no publishing, no provider contact.
  Live publishing remains owner-gated (Rules 7/16).
- No public output is produced anywhere in this layer (Rule 15).
