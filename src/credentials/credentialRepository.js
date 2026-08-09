/**
 * Abstract Repository Interface for Slice 4.3 Credentials.
 * PostgreSQL implementations must extend this class and override its methods.
 * Production interfaces exclude unsafe unscoped methods to prevent insecure usage.
 */
export class ICredentialRepository {
  /**
   * Scoped lookup matching owner, agent, provider, capability, and credentialId in a single predicate.
   * Returns the raw locator string on success, or null if unauthorized/not found.
   */
  async findLocatorScoped({ ownerId, agentId, provider, capability, credentialId }) {
    throw new Error("UNIMPLEMENTED: findLocatorScoped must be implemented by concrete subclass.");
  }

  /**
   * Saves a credential record using PostgreSQL-compatible schema shape.
   */
  async save({ ownerId, agentId, provider, capability, credentialId, locator, metadata }) {
    throw new Error("UNIMPLEMENTED: save must be implemented by concrete subclass.");
  }
}

/**
 * In-Memory Test-Only Credential Repository.
 * Emulates the exact PostgreSQL snake_case schema shape and horizontal isolation.
 */
export class TestOnlyInMemoryCredentialRepository extends ICredentialRepository {
  constructor() {
    super();
    // Stores database-shaped records
    this.records = new Map();
  }

  async findLocatorScoped({ ownerId, agentId, provider, capability, credentialId }) {
    const row = this.records.get(credentialId);
    if (!row) return null;

    // Enforce PostgreSQL-shaped column predicate verification
    if (
      row.owner_id !== ownerId ||
      row.agent_id !== agentId ||
      row.provider !== provider ||
      row.capability !== capability
    ) {
      return null;
    }

    return row.secret_locator;
  }

  async save({ ownerId, agentId, provider, capability, credentialId, locator, metadata }) {
    if (!ownerId || !agentId || !provider || !capability || !locator) {
      throw new Error("INVALID_COLUMNS: Missing required fields for database constraint.");
    }

    const id = credentialId || crypto.randomUUID();

    // Store in PostgreSQL compatible column names
    const row = {
      credential_id: id,
      owner_id: ownerId,
      agent_id: agentId,
      provider: provider,
      capability: capability,
      secret_locator: locator,
      metadata: metadata || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this.records.set(id, row);

    // Return the database representation of the credential ID
    return id;
  }
}
