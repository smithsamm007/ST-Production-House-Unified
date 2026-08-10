# Task 4.2 — Per-Agent Provider Configuration

Secure integration of the provider-routing layer with Slice 3.3 zero-cost quota and recovery contracts, supporting custom 5-slot layout policy with strict fail-closed validations.

## 1. Architecture & Design

### Custom Slot Layout Policy
To accommodate flexible local open-source and remote options, Slice 4.2 extends the task routing configuration to support exactly 5 deterministic slots:
- **Remote Slots (`primary`, `secondary`, `tertiary`)**: These connect to external APIs (e.g., Gemini, Claude, Sarvam). They accept **only** free or free-trial tier configurations.
- **Emergency Slots (`emergency_1`, `emergency_2`)**: These must be keyless local open-source routes (e.g., Ollama, LLaMA). No `credentialRef` or opaque locator is permitted.

### State Isolation Key
To guarantee strict multi-tenant isolation, the fully qualified isolation key is structured as:
`ownerId:agentId:slotName:provider:secretLocator`
Where `secretLocator` defaults to `"no_secret"` for local keyless slots. This blocks cross-owner and cross-agent data/credential leakage.

### Fail-Closed Enforcements
The `ProviderConfigurationRouter` implements a sequence of defensive, fail-closed guards on every slot attempt:
1. **Explicit Approved Free Classification**: Any slot with missing, unknown, or conflicting billing fields is rejected immediately. Only explicit approved `free`, `trial`, or `free_trial` configurations are allowed.
2. **Owner-Identity Validation**: The `ownerId` is explicitly verified at construction and execution. Accessing a credential belonging to a different owner throws `CROSS_OWNER_CREDENTIAL_ACCESS_DENIED`.
3. **Durable Dependency Injection**: To prevent losing state across restarts or workers, process-local default fallbacks are strictly prohibited in production. Explicitly validated durable dependencies (`quotaLedger`, `recoveryManager`, and `credentialHealthRegistry`) must be injected on construction.
4. **Credential Health Checker**: Integrates with `CredentialHealthRegistry` in `src/providers/credentialHealth.js`. If a credential locator is marked unhealthy, the router skips the slot immediately.
5. **Circuit Breaker Check**: Checks `RecoveryContractManager.isHealthy`. If the provider-credential combination is in `OPEN` or cooldown states, it skips.
6. **Atomic Quota Reservation**: Reserves quota via `QuotaLedger.reserve`. If missing quota or expired trial is detected, it fails closed and transitions.
7. **Plaintext Credential Shield**: Under no circumstance is a plaintext secret logged or resolved. All error messages are sanitized using `sanitizeErrorMessage` from `src/recovery/recoveryContract.js` to strip API keys or vault locator details. Executors only receive a short-lived authorized lease handle, never the raw credential.

---

## 2. Public Contract Integrations

Slice 4.2 interacts with existing modules by public contracts only, without modifying any Slice 4.1 or 4.3 codebases:
- **`QuotaLedger`** (`src/quotas/quotaLedger.js`): Sync-safe atomic reservation (`reserve`, `commit`, `release`).
- **`RecoveryContractManager`** (`src/recovery/recoveryContract.js`): Circuit breaker states (`isHealthy`, `recordSuccess`, `recordFailure`).
- **`sanitizeErrorMessage`**: Cleans API keys and locators out of logs.

---

## 3. Verification & Test Suite

The newly written unit test suite in `tests/providerConfiguration.test.js` covers 32 comprehensive test cases ensuring zero variable cost and full validation:
- Deterministic routing through all 5 slots.
- Multi-tier layout constraint validations (cross-owner blocks, cross-agent blocks, slot-mismatch blocks, keyless emergency constraints, distinct providers).
- Rejection of paid, overage, and automatic billing routes.
- Rejection of missing tier/quota/trial metadata.
- Rejection of default construction and durable-interface failures.
- Sanitized evidence mapping ensuring no raw secret injection.
- Failover on commit and recovery failures to prevent quota leakage.
- Closed failure for missing quota or expired trials.
- Closed failure for unhealthy credentials.
- Cooldown and open circuit verification.
- Non-leakage of plaintext secrets under thrown errors.

All 222 unit tests across the repository execute successfully.
