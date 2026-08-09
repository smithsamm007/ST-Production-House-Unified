# Tasks 1–3 Release Gate

Audit date: 2026-08-09

Baseline: `cdf69db678fc7ec19e8f46dda7553271042a7cfa`

## Scope

- Task 1: production PostgreSQL adapter and safe migration runner.
- Task 2: authenticated control-plane API and PostgreSQL repositories.
- Task 3.1: durable PostgreSQL job lifecycle.
- Task 3.2: worker runtime, checkpoints, and idempotency.
- Task 3.3: zero-cost quota and recovery contracts.
- Infrastructure: governed Jules session watchdog.

## Static acceptance evidence

- Migrations 001–008 are byte-identical to their verified Task 1 heads.
- Additive migrations 009 and 010 are present.
- Production authentication defaults to PostgreSQL; test memory storage requires explicit opt-in.
- MFA secrets use AES-256-GCM; TOTP uses RFC 6238 calculations.
- CSRF tokens are hashed by the PostgreSQL repository.
- Worker, checkpoint, and idempotency construction fails closed without durable production stores.
- Quota routing rejects unconfigured, paid, overage, expired, and cooling-down routes.
- Unknown provider failures fail closed.
- Jules watchdog uses bounded recovery, a three-attempt limit, one-writer safety, and no paid fallback.
- No live provider calls, public publishing, or real credential changes are included.

## Dynamic acceptance gate

This PR exists to run the repository's exact combined verification against PostgreSQL 15:

- `npm run verify`
- `npm test`
- `npm run test:integration`

Task 4 must not start unless this exact PR head is green.
