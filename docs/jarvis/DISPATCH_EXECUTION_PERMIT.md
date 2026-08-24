# Dispatch execution permit

The execution permit is a durable, bounded control-plane handoff between an
approved-free `DISPATCH_ADMITTED` checkpoint and a future execution adapter.
Issuing it atomically locks the quota, its still-reserved reservation, and the
exact integrity-checked checkpoint. It then records one deterministic permit
identifier and a 30–300 second lease using the PostgreSQL clock.

`DISPATCH_PERMITTED` is not evidence of generation. Provider selection remains
`not_performed`; `executionStarted` and `providerCallStarted` remain `false`.
The operation does not resolve credentials, consume quota, call a provider, or
perform network I/O.

The permit is bound to owner, agent, task, capability, slot, provider,
credential locator, reservation, units, lease owner, and checkpoint hash.
Concurrent or stale requests fail closed. A retry with the identical key is
restart-safe and returns the same permit. Revocation returns the checkpoint to
`DISPATCH_ADMITTED` while retaining the free reservation. Expired permits can
be reclaimed only after the database clock reaches their recorded expiry.
Evidence is appended in the same transaction and contains no secret material.
