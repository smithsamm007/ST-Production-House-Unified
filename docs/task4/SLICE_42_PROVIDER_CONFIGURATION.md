# Task 4.2 — Per-Agent Provider Configuration

Secure integration of the provider-routing layer with Slice 3.3 zero-cost quota and recovery contracts, supporting custom 5-slot layout policy with strict fail-closed validations.

## 1. Architecture & Design

### Custom Slot Layout Policy
To accommodate flexible local open-source and remote options, Slice 4.2 extends the task routing configuration to support exactly 5 deterministic slots:
- **Remote Slots (`primary`, `secondary`, `tertiary`)**: These connect to external APIs (e.g., Gemini, Claude, Sarvam). They accept **only** free or free-trial tier configurations.
- **Emergency Slots (`emergency_1`, `emergency_2`)**: These must be keyless local open-source routes (e.g., Ollama, LLaMA). No `credentialRef` or opaque locator is permitted.

### State Isolation Key
To guarantee strict multi-tenant isolation, the key is structured as:
`agentId:slotName:provider:secretLocator`
Where `secretLocator` defaults to `"no_secret"` for local keyless slots. This blocks cross-agent data/credential leakage.

### Fail-Closed Enforcements
The `ProviderConfigurationRouter` implements a sequence of defensive, fail-closed guards on every slot attempt:
1. **Paid/Overage Rejector**: Blocks any slot carrying `isPaid: true`, tier `paid`, tier `overage`, or billing options `billingModel: "automatic"` or `billingEnabled: true`.
2. **Credential Health Checker**: Integrates with `CredentialHealthRegistry` in `src/providers/credentialHealth.js`. If a credential locator is marked unhealthy, the router skips the slot immediately.
3. **Circuit Breaker Check**: Checks `RecoveryContractManager.isHealthy`. If the provider-credential combination is in `OPEN` or cooldown states, it skips.
4. **Atomic Quota Reservation**: Reserves quota via `QuotaLedger.reserve`. If missing quota or expired trial is detected, it fails closed and transitions.
5. **Plaintext Credential Shield**: Under no circumstance is a plaintext secret logged or resolved. All error messages are sanitized using `sanitizeErrorMessage` from `src/recovery/recoveryContract.js` to strip API keys or vault locator details.

---

## 2. Public Contract Integrations

Slice 4.2 interacts with existing modules by public contracts only, without modifying any Slice 4.1 or 4.3 codebases:
- **`QuotaLedger`** (`src/quotas/quotaLedger.js`): Sync-safe atomic reservation (`reserve`, `commit`, `release`).
- **`RecoveryContractManager`** (`src/recovery/recoveryContract.js`): Circuit breaker states (`isHealthy`, `recordSuccess`, `recordFailure`).
- **`sanitizeErrorMessage`**: Cleans API keys and locators out of logs.

---

## 3. Verification & Test Suite

The newly written unit test suite in `tests/providerConfiguration.test.js` covers 20 comprehensive test cases ensuring zero variable cost and full validation:
- Deterministic routing through all 5 slots.
- Multi-tier layout constraint validations (cross-agent blocks, slot-mismatch blocks, keyless emergency constraints, distinct providers).
- Rejection of paid, overage, and automatic billing routes.
- Closed failure for missing quota or expired trials.
- Closed failure for unhealthy credentials.
- Cooldown and open circuit verification.
- Non-leakage of plaintext secrets under thrown errors.

All unit tests execute successfully under standard Node test suites without live network dependencies.
