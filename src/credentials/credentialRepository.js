/**
 * Abstract Repository Interface for Slice 4.3 Credentials.
 * PostgreSQL implementations must extend this class and override its methods.
 */
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

/**
 * In-Memory Test-Only Credential Repository.
 * Conforms to ICredentialRepository. Used in deterministic unit and failure-injection testing.
 */
export class TestOnlyInMemoryCredentialRepository extends ICredentialRepository {
  constructor() {
    super();
    this.credentials = new Map();
  }

  async findById(id) {
    const cred = this.credentials.get(id);
    if (!cred) return null;
    // Return deep copy to prevent external mutation
    return JSON.parse(JSON.stringify(cred));
  }

  async save(credential) {
    if (!credential || !credential.id) {
      throw new Error("INVALID_CREDENTIAL_DATA: Missing credential.id");
    }
    // Deep copy to prevent external mutation
    this.credentials.set(credential.id, JSON.parse(JSON.stringify(credential)));
    return this.findById(credential.id);
  }

  async delete(id) {
    return this.credentials.delete(id);
  }
}
