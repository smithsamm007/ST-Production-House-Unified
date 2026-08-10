# Task 4.3 — Credential Metadata/Audit Persistence and PostgreSQL Integration

This slice implements durable, secure metadata and access audit logging for the Credential Broker system, built on the canonical PostgreSQL 15+ database.

## 1. Architectural Design & Philosophy

### Opaque Credentials & Strict Redaction
In alignment with rule 4 and 17 of the engineering contract:
- Plaintext API keys, secrets, or passwords are strictly blocked from entering the persistent layer.
- The system exclusively registers opaque, scoped secret-manager locators (e.g. starting with `vault://` or `opaque://`).
- Any attempt to store plaintext secrets throws a validation error and fails closed.

### Owner-Scoped & Agent-Scoped Isolation
- Ownership and access boundaries are strictly enforced using parameterized SQL queries.
- Every read, list, update, rotation, and revocation operation is partitioned by the authenticated `owner_id`, preventing lateral privilege escalation.

### Concurrency-Safe Durable State Updates
- Race conditions during credential rotation or revocation are mitigated via transaction-level pessimistic locking (`SELECT ... FOR UPDATE`) inside PostgreSQL 15.
- Optimistic concurrency control is also supported via a `version` column, ensuring out-of-order updates are blocked safely.

### Immutable Append-Only Audit Log
- All credential accesses and lifecycle mutations are logged to a dedicated audit trail table (`broker_credential_audit_log`).
- This table is made strictly immutable and append-only using a PL/pgSQL database trigger function (`deny_credential_audit_mutation`) which blocks `UPDATE` or `DELETE` statements.
- Error messages stored in the audit trail undergo standard sanitization to prevent accidental secret leakage.

---

## 2. Database Schema (`sql/011_credential_broker_metadata.sql`)

The migration defines two tables:
1. `broker_credential_metadata`
   - `id`: Unique identifier (UUID).
   - `owner_id`: Reference to `owners(id)`.
   - `agent_id`: Reference to `agents(id)`.
   - `provider`: Target provider name (e.g., `gemini`, `claude`).
   - `secret_locator`: Scoped opaque locator. Checked to start with `vault://` or `opaque://`.
   - `version`: Monotonically increasing version counter.
   - `rotation_status`: Enum state (`stable`, `rotating`, `failed_rotation`).
   - `expires_at`: Expiration timestamp.
   - `last_health_status`: Health reporting.
   - `revoked_at`: Soft-revocation marker.
2. `broker_credential_audit_log`
   - Tracks `credential_id`, `owner_id`, `agent_id`, `action`, `status`, `error_message`, `client_ip`, and `user_agent`.
   - Protected by `credential_audit_no_update` trigger preventing any update or deletion.

---

## 3. Repositories (`src/credentials/`)

### PostgresCredentialRepository
Handles durable metadata updates and retrieval:
- `create(...)`: Registers new scoped locator with scheme validation.
- `findById(id, ownerId)` / `findByLocator(locator, ownerId)`: Safe retrieval.
- `listByAgent(agentId, ownerId)` / `listAll(ownerId)`: Scoped listing.
- `rotate(id, ownerId, { newSecretLocator, nextExpiresAt, expectedVersion })`: Race-safe rotation.
- `revoke(id, ownerId)`: Marks a credential as permanently revoked.
- `updateMetadata(...)`: Safe general status updates.

### CredentialAuditRepository
Handles auditing:
- `logAccess(...)`: Records a new access event, automatically sanitizing error messages.
- `listLogsByOwner(ownerId)` / `listLogsByCredential(credentialId, ownerId)`: Owner-scoped listing.

---

## 4. Test Suite (`tests/credentialBrokerPostgres.integration.js`)

A comprehensive integration test suite has been implemented to cover:
1. **Rollback**: Verifies transactions roll back cleanly on constraint failure.
2. **Rerun**: Confirms migration 011 is completely rerunnable/idempotent.
3. **Cross-agent/Cross-owner Denial**: Asserts complete tenant isolation.
4. **Rotation/Revocation Races**: Tests concurrency protection with concurrent database locks.
5. **Sanitization**: Verifies plaintext passwords and keys are redacted from logs and errors.
6. **Append-Only Audit Enforcement**: Confirms the database trigger successfully blocks updates and deletes.
