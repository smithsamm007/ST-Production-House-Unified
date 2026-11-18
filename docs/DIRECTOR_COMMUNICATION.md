# Director Communication (Owner ↔ Director AI)

Server-side Owner → Director conversation with a real Gemini response, durable
custody and explicit failure semantics. Agent names remain internal (Rule 15).

## Endpoints

Both routes are mounted at `/api/director-comm` and are **only** reachable behind
the normal Owner session middleware (`authenticateOwner`), the CSRF middleware
for mutations (`requireCsrf`) and a dedicated rate limiter.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/:agentId/messages` | Owner-scoped, Director-scoped history. Returns `{ agentId, messages, correlationId }`. |
| `POST` | `/:agentId/messages` | Body allowlist: `body`, `kind`, `clientMessageId`. Returns the Owner message, a **system delivery acknowledgment** and the Director/provider result. |

Response statuses (all fail closed):

| Status | Meaning |
|---|---|
| `400` | `DIRECTOR_ID_INVALID`, `REQUEST_VALIDATION_FAILED`, `MESSAGE_KIND_INVALID` |
| `401` | No Owner session |
| `403` | CSRF/authorization refusal (cookie sessions) |
| `404` | `DIRECTOR_NOT_FOUND` — unknown and unauthorized are indistinguishable |
| `413` | `MESSAGE_TOO_LONG` (limit `4000` characters) |
| `422` | `MESSAGE_EMPTY` |
| `429` | `TOO_MANY_REQUESTS_TRY_AGAIN_LATER` (Director-communication limiter) |
| `502`/`503`/`504` | `PROVIDER_UNAVAILABLE` with `errorCode` (`PROVIDER_NOT_CONFIGURED`, `PROVIDER_QUOTA_EXHAUSTED`, `PROVIDER_TIMEOUT`, `PROVIDER_ERROR`, `EMPTY_PROVIDER_RESPONSE`) |

`X-Correlation-Id` is echoed on every response and stored with the messages.

## What is never client-controlled

- **Director identity**: `:agentId` is resolved against the `agents` repository;
  an unknown Director is a `404` and never gets a conversation.
- **Prompt context**: `charter` and `channelName` are loaded server-side; a
  request that carries them is rejected as `REQUEST_VALIDATION_FAILED`, so a
  caller cannot rewrite the system instruction.
- **Owner scope**: every read and write is scoped by the authenticated Owner id.

## Custody

| Mode | Store | Durable? |
|---|---|---|
| `postgres` | `director_comm_messages` (migration `041`) via `PostgresConversationRepository` | Yes — per-message rows, `seq bigserial` total order, `UNIQUE (owner_id, agent_id, client_message_id, role)` idempotency |
| `demo` | process-local in-memory map | **No** — labeled non-durable, same as the rest of demo storage |
| explicit `FileConversationStore` | one JSON file | No — local/test only; two instances would overwrite each other |

A failed write throws (`DIRECTOR_COMM_PERSIST_FAILED`), which the router surfaces
as `500 INTERNAL_SERVER_ERROR`; persistence is never implied.

Migration `041_director_comm_messages.sql` is additive: it creates a new table and
never alters an applied migration or table. It has **not** been applied to any
persistent or production database — `npm run migrate` against production is an
Owner-only action.

## Provider

- SDK: `@google/genai` (server side only). Key: `GEMINI_API_KEY` from the server
  environment. It is never sent to the browser, logged or serialized.
- Model: `GEMINI_MODEL` (default `gemini-4-hydrogen`). The model that answered is
  recorded with the reply (`response.modelVersion`); the code never silently
  switches to a different model.
- Timeout: `DirectorCommunicationService.timeoutMs` (default 20000 ms) aborts the
  in-flight request (`AbortController`) and `httpOptions.timeout`.
- Retries: none are automatic. A retry is only safe through the client's
  `clientMessageId`, which replays the durable result instead of calling the
  provider again.
- Evidence: `model`, `correlationId`, `latencyMs`, `providerResponseId` and
  `usage` are recorded on the stored reply. No fabricated response is ever
  written when the provider fails.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | unset | Server-side Gemini credential |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | Model id |
| `DIRECTOR_COMM_RATE_LIMIT_PER_MINUTE` | `30` | Director-communication limiter (own bucket) |

## Verification status (honest)

- Unit + HTTP regressions run in CI: authentication, CSRF, unknown Director,
  cross-Director isolation, oversize, rate limit, concurrent/duplicate writes,
  restart idempotency, provider timeout (mocked provider).
- `tests/directorCommunicationPostgres.integration.js` verifies ordering,
  DB-enforced idempotency, restart durability, concurrent instances and scoping
  on a disposable PostgreSQL 15 database.
- **Live provider conversation: not executed in this environment** — no
  `GEMINI_API_KEY` is configured for the implementation sandbox, so the endpoint
  returns `PROVIDER_UNAVAILABLE` / `PROVIDER_NOT_CONFIGURED`. Run
  `node scripts/gemini_provider_smoke.mjs` on a host where the key is configured
  to record a real provider outcome.
