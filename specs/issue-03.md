## Goal
Make credentials DURABLE: metadata + immutable audit trail in PostgreSQL.
Secret VALUES are forbidden here — metadata only.

## Deliverables
- NEW `sql/008_credential_metadata.sql` (append-only; never edit 001–007):
  - Table `credential_metadata`: locator_id PK (text, matches TASK-4.1 format),
    provider_id, status enum('provisioned','active','cooldown','revoked'),
    scope_label, created_at, rotated_at, expires_at, created_by
  - Table `credential_audit_log`: id BIGSERIAL PK, locator_id FK,
    event enum, actor, detail JSONB, occurred_at DEFAULT now()
    — INSERT-only design; document that updates/deletes are prohibited.
- NEW `src/repos/credential-metadata.js`: every function takes an INJECTED
  client (query interface) — parameterized queries ONLY ($1,$2…), zero string
  interpolation of user data.

## Acceptance criteria
- [ ] Migration runs clean on fresh DB twice (idempotent guards where sensible)
- [ ] Repo functions tested against an in-memory FAKE client (suite stays DB-free & offline)
- [ ] Injection-attempt test: malicious locator string arrives as bound param, never executed
- [ ] Audit rows are append-only by construction (no UPDATE path exists in repo code)
- [ ] Full suite green offline
