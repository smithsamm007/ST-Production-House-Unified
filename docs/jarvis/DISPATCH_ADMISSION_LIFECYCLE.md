# Dispatch Admission Lifecycle

The dispatch-admission lifecycle is the last durable control-plane handoff
before provider execution. It operates only on an existing approved-free quota
reservation and its exact checkpoint.

Claiming locks the quota, reservation, and checkpoint in one PostgreSQL
transaction. The reservation remains `reserved`, quota usage remains unchanged,
and the checkpoint moves from `WAITING_FOR_QUOTA` to `DISPATCH_ADMITTED`.
`DISPATCH_ADMITTED` means only that a scoped reservation is durably attached to
the checkpoint; it is not evidence of provider selection, credential resolution,
execution, generation, or a network call.

Releasing reverses that handoff atomically. It marks the reservation `released`,
decrements reserved capacity, and returns the checkpoint to
`WAITING_FOR_QUOTA`. If evidence or checkpoint persistence fails, PostgreSQL
rolls back all reservation and quota changes.

Both operations bind the owner, agent, task, slot, provider, credential locator,
reservation units, and expected checkpoint payload hash. Repeated identical
operations are restart-safe and idempotent. Competing reservations, stale
checkpoint hashes, corrupt records, terminal reservations, secret-bearing data,
and cross-scope inputs fail closed.

Provider calls remain prohibited in this slice. A later execution slice must
verify `DISPATCH_ADMITTED` and still perform its own credential, policy, and
capacity checks before any external side effect.
