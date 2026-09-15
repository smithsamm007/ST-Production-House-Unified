# Offline Resilience Stress Suite (S-M29-01)

`tests/resilienceStress.test.js` is a deterministic, fully offline stress
layer over the quota, circuit-breaker, and lease-reclaim contracts. It runs
inside `npm test` (no network, no providers, no database) and complements —
never replaces — the basic contract tests in `tests/quotaRecovery.test.js`,
`tests/durableRetry.test.js`, and `tests/resilience.test.js`.

## What it exercises

### 1. QuotaLedger burst settlement (`src/quotas/quotaLedger.js`)

- **Zero-leakage audit**: burst waves (10 × 40 reservations) with
  deterministic ~70% commit / ~30% release settlement must end with
  `usageCount` exactly equal to the committed count. Committed settlements
  legitimately consume quota; a release-eligible handle that was never
  released is the only leak signature, and a dedicated test proves the audit
  detects planted leakage and that releasing exactly the abandoned handles
  drains it.
- **Burst against a small limit**: of a 60-request burst against limit 12,
  exactly 12 succeed and 48 fail closed with
  `QUOTA_RESERVATION_FAILED: quota_exceeded`; full release drains to zero
  and capacity is available again.
- **Exactly-once settlement**: double `commit` throws
  `INVALID_RESERVATION_STATUS`; `release` after commit is a no-op and never
  decrements usage; double `release` never drives usage negative.

### 2. RecoveryContractManager circuit transitions (`src/recovery/recoveryContract.js`)

- Repeated transient failures (`maxConsecutiveFailures = 3`) trip the breaker
  `CLOSED → OPEN`; after the cooldown `isHealthy` recovers through
  `HALF_OPEN`, and `recordSuccess` closes it with a zeroed failure count.
- A failing `HALF_OPEN` probe re-trips `OPEN`.
- An unclassified (fatal) error trips `OPEN` instantly from a clean state,
  and sibling provider scopes stay healthy — fault isolation per scope.
- Under 200 deterministic mixed operations the state machine never leaves
  the legal state set `{CLOSED, OPEN, HALF_OPEN}`.

### 3. Expired-lease reclaim under serialized concurrent claims

The suite models, deterministically, the reclaim semantics implemented by
`src/jobs/lifecycle/jobLifecycle.js` (Task 3.5): a job is reclaimable iff
its status is `leased`/`running` and its lease expiry has passed; claim
sweeps are serialized (the `FOR UPDATE SKIP LOCKED` contract) and each
claimant re-evaluates the predicate against current state.

- Ten sweeps × five claimants over two expired leases: **no double-claim**
  within a sweep window, and at any instant at most one valid lease handle
  exists per job.
- Active leases, `running` jobs, and terminal states (`completed`,
  `dead_letter`, `owner_cancelled`) are never touched across 25 sweeps.
- Across 40 expiry cycles, exactly one claimant wins each window, the winner
  owns the fresh lease, and a freshly leased job is not reclaimable.

### 4. Bounded duration and memory

The combined offline workload (2,000 quota operations + 500 breaker
operations) must finish within 5 seconds, and ledger storage stays bounded
by configuration count, not operation volume.

## Determinism

All randomized decisions use a fixed-seed LCG (constant per test), so the
suite is reproducible run-to-run. Breaker cooldowns use millisecond-scale
real sleeps (bounded, offline). No test reads wall-clock time for anything
other than the duration bound.

## Assertions the suite guarantees

| Guarantee | Where |
|---|---|
| Every reserve settles exactly once; usage == committed count | quota burst tests |
| Over-capacity burst fails closed with the exact reason | small-limit burst test |
| Planted leakage is detected and drainable | abandoned-reservation test |
| Double commit/release cannot corrupt usage | exactly-once test |
| OPEN reached and recovery per contract | breaker sequence tests |
| No double-claim in the deterministic reclaim model | reclaim model tests |
| Bounded runtime and storage | combined workload test |
