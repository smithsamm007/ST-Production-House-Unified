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

## What is deliberately NOT done

- No autonomous execution loop is started by this slice: Hermes records
  decisions; wiring them to the existing job pipeline is the next governed
  slice.
- The process-lifetime decision store is the labeled demo transport; a
  PostgreSQL-backed store implementing the same `append/list` contract is a
  follow-up migration (R1).
- No secret values, no network calls, no publishing, no provider contact.
  Live publishing remains owner-gated (Rules 7/16).
- No public output is produced anywhere in this layer (Rule 15).
