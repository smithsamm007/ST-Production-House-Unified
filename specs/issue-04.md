## Goal
The README's named "first increment": authenticated HTTP API using node:http.
NO frameworks, NO new deps.

## Deliverables
- NEW `src/api/server.js` (createServer-based):
  - `GET /healthz` → 200 `{ok:true}` (unauthenticated)
  - `POST /session/start` → exchanges bootstrap token (from env `STPH_BOOTSTRAP_TOKEN`,
    32+ bytes) for a session token; session token stored HASHED (sha256) in-memory
    Map with TTL 30min
  - Auth middleware on all other routes: `Authorization: Bearer …`,
    constant-time compare via crypto.timingSafeEqual, 3 failures/min/IP limit
    (in-memory), then 429
  - Read-only stub routes wired to safe-DTO helpers: `/charters`, `/agents`
- Server factory exports `startServer({port:0})` for tests (ephemeral port).

## Hard constraints
- Reuse existing DTO serialization helpers — raw rows NEVER leave
- No secrets in responses, ever; unknown route → generic 404 (no stack traces)

## Acceptance criteria
- [ ] healthz open; every other route 401 without valid bearer
- [ ] Wrong/garbage/expired tokens rejected; valid flow issues working session
- [ ] Rate limiter trips on 4th bad attempt within window
- [ ] Timing-safe compare used (assert via code inspection note in PR)
- [ ] Tests spin real server on port 0 via node:http — full suite stays offline
