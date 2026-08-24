# Approved-Free Dispatch Admission

Dispatch admission is the durable boundary between readiness evaluation and
provider execution. It re-evaluates a scope-valid `WAITING_FOR_QUOTA`
checkpoint, confirms that the requested provider is an eligible zero-cost
candidate, and creates one idempotent quota reservation through the production
PostgreSQL quota interface.

Admission does not resolve credentials, commit quota, start a worker, call a
provider, or mutate the checkpoint. Its result therefore reports:

- `checkpointState: WAITING_FOR_QUOTA`
- `reservationStatus: reserved`
- `executionStarted: false`
- `providerCallStarted: false`

Local open-source providers are restricted to emergency slots and cannot carry
credential identifiers. Remote providers must use remote slots and opaque
credential identifiers, but remain ineligible until the canonical policy and
explicit capacity snapshot both approve them.

The idempotency key binds the checkpoint task and provider. PostgreSQL quota
locking prevents concurrent admissions from exceeding the configured free
capacity. A later slice must explicitly consume or release the reservation
before execution; admission alone is never evidence that generation occurred.
