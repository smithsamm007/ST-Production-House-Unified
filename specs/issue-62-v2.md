## Goal
Authenticated owner API on the EXISTING Express stack (express, argon2, supertest already deps).

## Deliverables
- NEW `src/api/ownerServer.js` (Express app, exported factory for tests):
  - `GET /healthz` → 200 `{ok:true}` (no auth)
  - `POST /session/start`: bootstrap token from env `STPH_BOOTSTRAP_TOKEN` (32+ bytes),
    compared via crypto.timingSafeEqual; issues session token (32 random bytes hex);
    stores sha256(token)→{createdAt, expiresAt} in-memory, TTL 30min
  - `requireAuth` middleware: Bearer → sha256 → lookup; 401 on miss/expiry;
    per-IP limiter: 3 bad attempts/min → 429
  - Read-only `GET /charters`, `/agents` wired through EXISTING safe-DTO helpers
- Tests use supertest with `port 0` — suite stays offline

## Constraints
- No secrets in responses; generic 404 elsewhere; no stack traces
- PR body MUST include `Closes #62` and pasted test output
