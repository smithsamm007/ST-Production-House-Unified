# Owner API — Content Runs & Evidence Timeline Routes

> Status: implemented (backlog slice S-M18-01, Module 18 owner-dashboard
> surface part 1). Authenticated, owner-scoped READ routes. No provider call,
> media generation, or publishing is performed or claimed by this document.

## Routes

`src/api/contentRunsRouter.js` is mounted at `/content-runs` behind
`requireAuth` in `src/api/ownerServer.js`. All three routes require a valid
Bearer session token from `POST /session/start`.

| Route | Purpose |
|---|---|
| `GET /content-runs` | Content package runs for the session owner (summary DTO, `limit` 1–100, default 50) |
| `GET /content-runs/:packageTaskId` | One run, detail DTO (stages + plan summaries) |
| `GET /content-runs/:packageTaskId/evidence` | Evidence events for the run with recomputed hash-chain positions and an integrity verdict |

## Security contract

1. **Server-authoritative scoping.** The queried owner is always the
   server-side session owner (`req.session.ownerId`, bound at session start
   from `options.bootstrapOwnerId`, default `owner-01`); client input can
   never select another owner's data.
2. **No existence leak.** A run owned by someone else and a missing run are
   both a generic `404 {"error":"NOT_FOUND"}`.
3. **Rule 17 allowlists.** Outbound serialization uses explicit field
   allowlists (`RUN_SUMMARY_FIELDS`, `RUN_DETAIL_FIELDS`, `PROVENANCE_FIELDS`,
   `PUBLICATION_FIELDS`, `STAGE_FIELDS`, `PLAN_SUMMARY_FIELDS`,
   `EVIDENCE_PAYLOAD_FIELDS`). Unknown fields, secrets, and locators are
   never serialized — verified by tests that plant `internalNote` fields.
4. **Clean error shapes.** `400 PACKAGE_TASK_ID_INVALID` /
   `400 QUERY_INVALID` / `401 UNAUTHORIZED` / `429 TOO_MANY_REQUESTS`
   (existing limiter) / `500 INTERNAL_SERVER_ERROR`; never stack traces.
5. **Honest degradation.** With no evidence ledger configured, the evidence
   route returns `503 EVIDENCE_LEDGER_UNAVAILABLE` rather than fabricating a
   timeline.

## Evidence timeline integrity

The evidence route recomputes the `EvidenceLedger` hash chain exactly as the
ledger computes it (`eventHash = sha256(JSON.stringify(stable({id,
occurredAt, previousHash, subjectId, kind, classification, payload})))`,
with `previousHash` linking to the preceding event). Responses carry:

- `events[]` — only the requested `packageTaskId`'s events, each with its
  **global** `chainPosition` (the ledger's real append order is preserved;
  subject filtering never renumbers positions),
- `chain` — `{ length, firstHash, lastHash, valid }` over the WHOLE ledger:
  `valid` is `false` when any recomputed hash or link mismatches. Tampering
  is surfaced, never hidden (verified by test).

## DTO shapes (summary)

```json
{
  "ownerId": "owner-alpha",
  "count": 1,
  "runs": [{
    "packageTaskId": "pkg-ainews-001",
    "orchestrator": "ai_news_content_package_v1",
    "packageId": "<sha256>",
    "agentId": "agent-ai-news",
    "readiness": "package_incomplete_pending_narration_input",
    "reasonCode": null,
    "stagesCompleted": 3,
    "publication": { "requested": false, "status": "not_requested" },
    "provenance": { "generationMode": "deterministic_local", "providerCalls": 0, "networkCalls": 0, "generatedMediaCount": 0, "mediaStatus": "not_generated" }
  }]
}
```

The detail route adds `stages[]` and `plans` (per-plan `planType`, `planId`,
`readiness`, `reasonCode`, `briefId`). The list route never includes stages
or plans.

## Storage adapter contract

`options.packageRunStore` implements:

```js
async listRuns(ownerId) -> run[]           // pre-scoped to the owner
async getRun(ownerId, packageTaskId) -> run | null
```

An absent store returns an honest empty list. A PostgreSQL-backed store is
the follow-up slice (S-M18-02 covers mutations; the durable run store pairs
with the checkpoint store).

## Verification

`tests/contentRunsRouter.test.js` (10 supertest tests) covers: unauthenticated
rejection on all three routes, owner scoping with cross-owner 404s,
indistinguishable missing/cross-owner 404s, strict allowlists (planted
`internalNote` fields never serialize; exact key sets asserted), malformed id
and query error shapes, global chain positions with subject filtering,
subject-scoped evidence (foreign events never leak), `503` honest degradation
without a ledger, tamper detection surfacing an invalid chain, and hash
recomputation mirroring `EvidenceLedger` exactly.

Evidence from this slice: `npm test` 507/507 passing (10 new), `npm run
verify`, `npm run lint`, and `npm run plan:check` all pass on the slice
branch.
