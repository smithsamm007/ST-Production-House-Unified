## Goal
Prove the machine survives hostility, and write the manual for the humans.

## Deliverables
- NEW `tests/adversarial/` (all offline):
  - `fuzz-locators.test.js` — 500 mutated locator strings; parser never crashes unhandled
  - `api-header-fuzz.test.js` — oversized/malformed Authorization & headers against
    the AUTH-API server; always clean 4xx, no throw, no leak in body
  - `sql-injection-matrix.test.js` — classic payloads through every repo function;
    all arrive as bound params (assert via fake-client capture)
- NEW `docs/RUNBOOK.md`: startup order, how to read alert_queue, emergency-pause &
  recovery procedure, rotation drill for a credential, rollback policy for migrations
- Update `docs/SECURITY.md` linking new surfaces.

## Acceptance criteria
- [ ] Every fuzz test asserts graceful handling (status/error-code level), not absence of crash alone
- [ ] RUNBOOK covers ALL tasks' components; no TODO placeholders
- [ ] npm test total runtime still <60s
- [ ] This closes the Phase-2 milestone: system is durable, guarded, documented
