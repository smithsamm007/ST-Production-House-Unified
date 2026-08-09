# Slice 4.1 — Credential Broker

This document describes the architecture, security policies, and interface contracts for the secure Credential Broker system.

## 1. Architectural Overview

The **Credential Broker** (`CredentialBroker`) isolates and handles access to sensitive provider API keys, tokens, and credentials. Instead of storing credentials in plain text or returning them directly in API/DTO payloads, the system manages credentials strictly via **opaque locators** referencing an external key vault (such as HashiCorp Vault or AWS Secrets Manager).

When a worker or executor requires a credential to communicate with a remote provider:
1. It requests the credential by its identity and provides its specific security context (owner, agent, provider, capability).
2. The Credential Broker validates the request against a strict 5-dimensional security boundary.
3. If authorized, the broker retrieves the secret via the configured Vault resolver and wraps it inside a short-lived, non-serializable, revocable **Credential Lease**.
4. The caller retrieves the raw secret from the lease handle for immediate use. The lease handles automatic and manual revocation, and securely zeroizes cached material.

```
+------------------+      1. Resolve(Context)       +------------------+
| Worker/Executor  | -----------------------------> | CredentialBroker |
|                  |                                +------------------+
|                  |                                         |
|                  |     3. Create lease                     | 2. Fetch & Validate
|                  | <---------------------------------------+
|                  |                                         v
|  +------------+  |                                +------------------+
|  | Lease      |  |                                | Vault/Repository |
|  | Handle     |  |                                +------------------+
|  +------------+  |
+------------------+
```

## 2. Security Guarantees & Validation

### A. Opaque Locators & Allowlist Scheme
Only allowlisted opaque locator schemes are permitted for credential storage. The supported schemes are:
- `vault://`
- `opaque://`

Any registration or update attempt specifying a locator that does not match one of these allowlisted schemes will fail closed, raising a `SecurityViolationError`.

### B. Recursive Plaintext Secret Rejection
To ensure plain text secrets never enter the database, metadata, or logs, the broker scans all incoming credential registration payloads recursively.

Any string matching a sensitive key pattern (such as `password`, `secret`, `token`, `apikey`, `privatekey`, `auth`, `locator`) must start with an allowlisted scheme (e.g., `vault://`). If any matching key is assigned a plaintext string value (e.g. `"my-super-secret-api-key"`), the registration is rejected.

### C. Redacted Logs, Errors, and Evidence
No complete locator path (e.g., `vault://production-secrets/gemini/api-key`) or resolved secret is ever leaked through log statements, error messages, or evidence records. The system employs regular-expression-based sanitizers (`sanitizeErrorMessage`) that replace complete vault/opaque URIs with generic redactions (`[REDACTED_VAULT_LOCATOR]`).

---

## 3. Five-Dimensional Authorization

Authorization is strictly bound along five dimensions to guarantee complete isolation. Mismatch in any of these parameters will result in a failed resolution (fail-closed):

1. **Owner Identity (`ownerId`)**: Verifies that the credential belongs to the requesting workspace/owner.
2. **Agent Identity (`agentId`)**: Prevents cross-agent credential sharing. Agent A cannot access Agent B's credential.
3. **Provider Name (`provider`)**: Restricts the credential's use to the specified provider (e.g., `gemini`, `claude`).
4. **Capability Name (`capability`)**: Confirms the credential is used for its designated task/capability.
5. **Credential Identity (`credentialId`)**: Validates the specific registered credential locator.

---

## 4. Short-Lived, Non-Serializable Leases

To minimize exposure of resolved credential secrets in-memory, the broker returns a `CredentialLease` object:

### A. Short Expiration
Each lease is initialized with a short time-to-live (typically 30 seconds). Upon expiry, the internal reference is destroyed.

### B. Safe Serialization (Non-Serializable Handle)
The lease overrides `toJSON()` to return `undefined`. Any serialization attempt (e.g., `JSON.stringify(lease)`) will completely omit or fail to serialize the sensitive secret material, protecting dashboard states, logs, and telemetry from accidental leak.

### C. Manual Revocation & Zeroization
The lease provides a `revoke()` method. Upon revocation:
- If the secret is a binary Buffer, it is immediately zeroed out (`buffer.fill(0)`).
- If it is a string/object, references are dereferenced to `null`/`undefined` to make them instantly garbage-collectable.
- The state is marked as inactive, and subsequent `getSecret()` calls will throw.

---

## 5. Repository Interfaces for Slice 4.3

To facilitate integration with PostgreSQL-based repository implementations in Slice 4.3, we define the `ICredentialRepository` base interface. This abstract contract defines the interface boundaries:

```javascript
export class ICredentialRepository {
  async findById(id) {
    throw new Error("UNIMPLEMENTED: findById must be implemented by a concrete subclass.");
  }

  async save(credential) {
    throw new Error("UNIMPLEMENTED: save must be implemented by a concrete subclass.");
  }

  async delete(id) {
    throw new Error("UNIMPLEMENTED: delete must be implemented by a concrete subclass.");
  }
}
```
In-memory and Postgres repository implementations in subsequent phases must fully conform to this contract to maintain interface safety.
