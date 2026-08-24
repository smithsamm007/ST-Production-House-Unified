## Goal
The kill-switch layer: breakers per provider, quarantine for repeat offenders,
global emergency pause, owner alert QUEUE (rows only — no email/network).

## Deliverables
- NEW `src/providers/breaker.js`: CLOSED→OPEN→HALF_OPEN state machine
  (threshold: 5 consecutive failures → OPEN 5min → HALF_OPEN allows 1 probe)
- NEW `sql/010_quarantine_alerts.sql`: `provider_quarantine`
  (provider_id, reason, quarantined_at, review_status),
  `owner_alert_queue` (id, severity, code, detail JSONB, created_at, acked_at NULL)
- NEW `src/providers/quarantine.js`: quarantine/quota-exceeded escalation writes
  alert rows; `isEmergencyPaused()` reads a `system_flags` row ('pause_all')

## Acceptance criteria
- [ ] Breaker transitions fully unit-tested incl. half-open success reset & probe failure re-open
- [ ] Paused system → router resolveChain throws immediately (tested)
- [ ] Alerts accumulate as rows; nothing sends anywhere (grep-proof: no outbound calls added)
- [ ] Migrations 008–010 remain append-only & forward-only
