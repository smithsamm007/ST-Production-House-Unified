# Approved-Free Dispatch Readiness

The dispatch-readiness bridge evaluates whether a durable
`WAITING_FOR_QUOTA` checkpoint has an explicitly approved, zero-cost and
currently available provider candidate.

It is a pure control-plane evaluation. It does not resolve credentials, reserve
quota, select a provider, start a worker or call any provider. A successful
evaluation therefore keeps the checkpoint state unchanged and returns:

- `providerSelection: not_performed`
- `executionStarted: false`
- `providerCallStarted: false`

The canonical zero-cost route is intersected with an explicit capacity
snapshot. Provider configuration alone is never treated as proof that compute
capacity exists. Disabled, unapproved, paid, unavailable, billing-enabled,
overage-enabled, fabricated, cross-agent or secret-bearing entries are
ineligible or rejected.

Script, visual and audio dispatch lanes use the same readiness contract while
retaining their lane-specific durable checkpoint payloads. Actual provider
selection and execution require a later, separately verified slice with durable
quota reservation and credential-broker enforcement.
