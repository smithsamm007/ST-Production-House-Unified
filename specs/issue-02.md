## Goal
Pure-function routing engine: given an agent + request context, return the
ordered provider chain. NO live calls. NO fabricated providers.

## Deliverables
- NEW `src/providers/config.js`:
  - Canonical provider registry (data only): exactly 3 private remote slots +
    1 keyless local fallback, ids `p_local_fallback`, `p_remote_1..3`.
    Remote entries have `enabled:false` until real credentials exist.
- NEW `src/providers/router.js` exporting `resolveChain(agentPolicy, ctx)`:
  - Returns ordered array of provider ids per agent policy (priority + enabled flag)
  - Zero-cost mode: when `ctx.costMode === 'zero'`, local fallback sorts FIRST
  - Emits failover-evidence objects: `{ attempt, providerId, reason }` (pure data)

## Acceptance criteria
- [ ] Deterministic: same inputs → identical chain, 100 iterations
- [ ] Disabled providers never appear in any chain
- [ ] Zero-cost mode reorders correctly; default mode preserves priority order
- [ ] Unknown agent policy → throws `RoutingError` (no silent fallback)
- [ ] Full suite green; evidence posted in PR body
