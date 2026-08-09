export class PostgresCredentialRepository {
  constructor(postgresAdapter) {
    if (!postgresAdapter || typeof postgresAdapter.query !== "function") {
      throw new Error("PostgresCredentialRepository requires a valid PostgresAdapter instance.");
    }
    this.adapter = postgresAdapter;
  }

  /**
   * Helper to validate that a secret locator is opaque and not plaintext.
   */
  validateSecretLocator(locator) {
    if (typeof locator !== "string" || !locator.trim()) {
      throw new Error("Invalid or missing secret locator");
    }
    if (!locator.startsWith("vault://") && !locator.startsWith("opaque://")) {
      throw new Error(
        "Plaintext secret detected or invalid locator schema. " +
        "Secrets must use opaque locators (e.g. vault://... or opaque://...)."
      );
    }
  }

  /**
   * Creates a new credential metadata record.
   */
  async create({ ownerId, agentId, provider, secretLocator, expiresAt, lastHealthStatus }) {
    this.validateSecretLocator(secretLocator);

    if (!ownerId) throw new Error("Missing ownerId");
    if (!agentId) throw new Error("Missing agentId");
    if (!provider) throw new Error("Missing provider");

    const sql = `
      INSERT INTO broker_credential_metadata (
        owner_id,
        agent_id,
        provider,
        secret_locator,
        expires_at,
        last_health_status
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const res = await this.adapter.query(sql, [
      ownerId,
      agentId,
      provider,
      secretLocator,
      expiresAt || null,
      lastHealthStatus || "healthy"
    ]);
    return res.rows[0];
  }

  /**
   * Finds a credential by its ID and owner ID (enforcing owner-scoping).
   */
  async findById(id, ownerId) {
    if (!id || !ownerId) return null;
    const sql = `
      SELECT * FROM broker_credential_metadata
      WHERE id = $1 AND owner_id = $2;
    `;
    const res = await this.adapter.query(sql, [id, ownerId]);
    return res.rows[0] || null;
  }

  /**
   * Finds a credential by its secret locator and owner ID (enforcing owner-scoping).
   */
  async findByLocator(secretLocator, ownerId) {
    if (!secretLocator || !ownerId) return null;
    const sql = `
      SELECT * FROM broker_credential_metadata
      WHERE secret_locator = $1 AND owner_id = $2;
    `;
    const res = await this.adapter.query(sql, [secretLocator, ownerId]);
    return res.rows[0] || null;
  }

  /**
   * Lists all credentials for a specific agent belonging to an owner.
   */
  async listByAgent(agentId, ownerId) {
    if (!agentId || !ownerId) return [];
    const sql = `
      SELECT * FROM broker_credential_metadata
      WHERE agent_id = $1 AND owner_id = $2
      ORDER BY created_at DESC;
    `;
    const res = await this.adapter.query(sql, [agentId, ownerId]);
    return res.rows;
  }

  /**
   * Lists all credentials belonging to an owner.
   */
  async listAll(ownerId) {
    if (!ownerId) return [];
    const sql = `
      SELECT * FROM broker_credential_metadata
      WHERE owner_id = $1
      ORDER BY created_at DESC;
    `;
    const res = await this.adapter.query(sql, [ownerId]);
    return res.rows;
  }

  /**
   * Concurrency-safe rotation of a credential locator and expiry date.
   * Leverages pessimistic locking (SELECT FOR UPDATE) inside a transaction.
   */
  async rotate(id, ownerId, { newSecretLocator, nextExpiresAt, expectedVersion }) {
    this.validateSecretLocator(newSecretLocator);
    if (!id || !ownerId) throw new Error("Missing required parameters for rotation");

    return await this.adapter.withTransaction(async (client) => {
      const checkSql = `
        SELECT * FROM broker_credential_metadata
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE;
      `;
      const check = await client.query(checkSql, [id, ownerId]);
      if (check.rowCount === 0) {
        throw new Error("Credential not found or unauthorized");
      }

      const current = check.rows[0];
      if (current.revoked_at) {
        throw new Error("Cannot rotate a revoked credential");
      }

      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new Error("CONCURRENCY_ERROR: Version mismatch");
      }

      const updateSql = `
        UPDATE broker_credential_metadata
        SET secret_locator = $1, expires_at = $2, version = version + 1, updated_at = now()
        WHERE id = $3 AND owner_id = $4
        RETURNING *;
      `;
      const res = await client.query(updateSql, [newSecretLocator, nextExpiresAt || null, id, ownerId]);
      return res.rows[0];
    });
  }

  /**
   * Concurrency-safe revocation of a credential metadata record.
   */
  async revoke(id, ownerId) {
    if (!id || !ownerId) throw new Error("Missing required parameters for revocation");

    return await this.adapter.withTransaction(async (client) => {
      const checkSql = `
        SELECT * FROM broker_credential_metadata
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE;
      `;
      const check = await client.query(checkSql, [id, ownerId]);
      if (check.rowCount === 0) {
        throw new Error("Credential not found or unauthorized");
      }

      const current = check.rows[0];
      if (current.revoked_at) {
        return current; // already revoked
      }

      const updateSql = `
        UPDATE broker_credential_metadata
        SET revoked_at = now(), updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING *;
      `;
      const res = await client.query(updateSql, [id, ownerId]);
      return res.rows[0];
    });
  }

  /**
   * Concurrency-safe general updates to credential metadata.
   */
  async updateMetadata(id, ownerId, { rotationStatus, expiresAt, lastHealthStatus, revokedAt }) {
    if (!id || !ownerId) throw new Error("Missing required parameters for update");

    return await this.adapter.withTransaction(async (client) => {
      const checkSql = `
        SELECT * FROM broker_credential_metadata
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE;
      `;
      const check = await client.query(checkSql, [id, ownerId]);
      if (check.rowCount === 0) {
        throw new Error("Credential not found or unauthorized");
      }

      const current = check.rows[0];
      const nextRotationStatus = rotationStatus !== undefined ? rotationStatus : current.rotation_status;
      const nextExpiresAt = expiresAt !== undefined ? expiresAt : current.expires_at;
      const nextLastHealthStatus = lastHealthStatus !== undefined ? lastHealthStatus : current.last_health_status;
      const nextRevokedAt = revokedAt !== undefined ? revokedAt : current.revoked_at;

      const updateSql = `
        UPDATE broker_credential_metadata
        SET rotation_status = $1, expires_at = $2, last_health_status = $3, revoked_at = $4, updated_at = now()
        WHERE id = $5 AND owner_id = $6
        RETURNING *;
      `;
      const res = await client.query(updateSql, [
        nextRotationStatus,
        nextExpiresAt,
        nextLastHealthStatus,
        nextRevokedAt,
        id,
        ownerId
      ]);
      return res.rows[0];
    });
  }
}
