/**
 * Abstract Repository Interface for Slice 4.3 Credentials.
 * PostgreSQL implementations must extend this class and override its methods.
 */
export class ICredentialRepository {
  async findScoped({ ownerId, agentId, provider, capability, id }) {
    throw new Error("UNIMPLEMENTED: findScoped must be implemented by a concrete subclass.");
  }

  async save(credential) {
    throw new Error("UNIMPLEMENTED: save must be implemented by a concrete subclass.");
  }

  async delete(id) {
    throw new Error("UNIMPLEMENTED: delete must be implemented by a concrete subclass.");
  }
}

/**
 * In-Memory Test-Only Credential Repository.
 * Conforms to ICredentialRepository. Used in deterministic unit and failure-injection testing.
 * This class is strictly test-only and is excluded from production wiring.
 */
export class TestOnlyInMemoryCredentialRepository extends ICredentialRepository {
  constructor() {
    super();
    this.credentials = new Map();
  }

  async findScoped({ ownerId, agentId, provider, capability, id }) {
    const cred = this.credentials.get(id);
    if (!cred) return null;
    // Enforce 5-dimensional isolation predicate mapping
    if (
      cred.ownerId !== ownerId ||
      cred.agentId !== agentId ||
      cred.provider !== provider ||
      cred.capability !== capability
    ) {
      return null;
    }
    return cred;
  }

  async save(credential) {
    if (!credential || !credential.id) {
      throw new Error("INVALID_CREDENTIAL_DATA: Missing credential.id");
    }
    this.credentials.set(credential.id, credential);
    return credential;
  }

  async delete(id) {
    return this.credentials.delete(id);
  }
}
