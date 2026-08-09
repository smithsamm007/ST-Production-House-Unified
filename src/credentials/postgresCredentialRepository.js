export class PostgresCredentialRepository {
  constructor(postgresAdapter, credentialAuditRepository = null) {
    if (!postgresAdapter || typeof postgresAdapter.query !== "function") {
      throw new Error("PostgresCredentialRepository requires a valid PostgresAdapter instance.");
    }
    this.adapter = postgresAdapter;
    this.auditRepo = credentialAuditRepository;
  }

  _toDTO(row) {
    if (!row) return null;
    const dto = { ...row };
    if (dto.secret_locator) {
      dto.secret_locator = dto.secret_locator.replace(/^(vault:\/\/|opaque:\/\/).+$/, "$1[REDACTED]");
    }
    return Object.freeze(dto);
  }

  validateSecretLocator(locator) {
    if (typeof locator !== "string" || !locator.trim()) {
      throw new Error("Invalid or missing secret locator");
    }
    if (locator.length > 500) {
      throw new Error("secretLocator length exceeds limit of 500");
    }
    if (!locator.startsWith("vault://") && !locator.startsWith("opaque://")) {
      throw new Error(
        "Plaintext secret detected or invalid locator schema. " +
        "Secrets must use opaque locators (e.g. vault://... or opaque://...)."
      );
    }
  }

  validateMetadataFields({ provider, capability, rotationStatus, lastHealthStatus }) {
    if (provider) {
      if (typeof provider !== "string" || provider.length < 1 || provider.length > 100) {
        throw new Error("provider length must be between 1 and 100");
      }
    }
    if (capability) {
      if (typeof capability !== "string" || capability.length < 1 || capability.length > 100) {
        throw new Error("capability length must be between 1 and 100");
      }
    }
    if (rotationStatus) {
      if (!["stable", "rotating", "failed_rotation"].includes(rotationStatus)) {
        throw new Error("Invalid rotationStatus value");
      }
    }
    if (lastHealthStatus) {
      if (!["healthy", "unhealthy", "degraded"].includes(lastHealthStatus)) {
        throw new Error("Invalid lastHealthStatus value");
      }
    }
  }

  /**
   * Public save / create method.
   */
  async save({ ownerId, agentId, provider, capability, secretLocator, expiresAt, lastHealthStatus }) {
    return this.create({ ownerId, agentId, provider, capability, secretLocator, expiresAt, lastHealthStatus });
  }

  async create({ ownerId, agentId, provider, capability, secretLocator, expiresAt, lastHealthStatus }) {
    try {
      this.validateSecretLocator(secretLocator);
      this.validateMetadataFields({ provider, capability, lastHealthStatus });
      if (!ownerId) throw new Error("Missing ownerId");
      if (!agentId) throw new Error("Missing agentId");
      if (!provider) throw new Error("Missing provider");
      if (!capability) throw new Error("Missing capability");
    } catch (err) {
      if (this.auditRepo && ownerId && agentId) {
        await this.auditRepo.logAccess({
          credentialId: null,
          ownerId,
          agentId,
          action: 'create',
          status: 'failure',
          errorMessage: err.message
        });
      }
      throw err;
    }

    return await this.adapter.withTransaction(async (client) => {
      try {
        const sql = `
          INSERT INTO broker_credential_metadata (
            owner_id,
            agent_id,
            provider,
            capability,
            secret_locator,
            expires_at,
            last_health_status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `;
        const res = await client.query(sql, [
          ownerId,
          agentId,
          provider,
          capability,
          secretLocator,
          expiresAt || null,
          lastHealthStatus || "healthy"
        ]);
        const created = res.rows[0];

        if (this.auditRepo) {
          await this.auditRepo.logAccess({
            credentialId: created.id,
            ownerId,
            agentId,
            action: 'create',
            status: 'success'
          }, client);
        }

        return this._toDTO(created);
      } catch (err) {
        if (this.auditRepo) {
          await this.auditRepo.logAccess({
            credentialId: null,
            ownerId,
            agentId,
            action: 'create',
            status: 'failure',
            errorMessage: err.message
          }, client);
        }
        throw err;
      }
    });
  }

  /**
   * Scoped find method (point 3 & 5).
   */
  async findScoped({ ownerId, agentId, provider, capability, credentialId }) {
    if (!ownerId || !agentId || !provider || !capability || !credentialId) {
      throw new Error("Missing required parameters for findScoped");
    }

    const sql = `
      SELECT * FROM broker_credential_metadata
      WHERE owner_id = $1 AND agent_id = $2 AND provider = $3 AND capability = $4 AND id = $5;
    `;
    let res;
    try {
      res = await this.adapter.query(sql, [ownerId, agentId, provider, capability, credentialId]);
    } catch (err) {
      if (this.auditRepo) {
        await this.auditRepo.logAccess({
          credentialId: null,
          ownerId,
          agentId,
          action: 'read',
          status: 'failure',
          errorMessage: err.message
        });
      }
      throw err;
    }

    if (res.rowCount === 0) {
      if (this.auditRepo) {
        await this.auditRepo.logAccess({
          credentialId: null,
          ownerId,
          agentId,
          action: 'read',
          status: 'failure',
          errorMessage: 'Credential not found or unauthorized'
        });
      }
      throw new Error("Credential not found or unauthorized");
    }

    const cred = res.rows[0];
    if (this.auditRepo) {
      await this.auditRepo.logAccess({
        credentialId: cred.id,
        ownerId,
        agentId,
        action: 'read',
        status: 'success'
      });
    }

    const dto = this._toDTO(cred);
    // Broker expects real secret locator in locator field (point 1)
    return {
      ...dto,
      locator: cred.secret_locator,
      secret_locator: cred.secret_locator
    };
  }

  /**
   * Internal lookup method for the broker to fetch the actual locator (point 6).
   */
  async resolveSecretLocatorInternal({ ownerId, agentId, provider, capability, credentialId }) {
    if (!ownerId || !agentId || !provider || !capability || !credentialId) {
      throw new Error("Missing required parameters for internal resolution");
    }
    const sql = `
      SELECT * FROM broker_credential_metadata
      WHERE owner_id = $1 AND agent_id = $2 AND provider = $3 AND capability = $4 AND id = $5;
    `;
    const res = await this.adapter.query(sql, [ownerId, agentId, provider, capability, credentialId]);
    if (res.rowCount === 0) {
      throw new Error("Credential not found or unauthorized");
    }

    if (this.auditRepo) {
      await this.auditRepo.logAccess({
        credentialId: credentialId,
        ownerId,
        agentId,
        action: 'resolve',
        status: 'success'
      });
    }

    return res.rows[0]; // Returns raw object containing unmasked secret_locator
  }

  /**
   * Finds by ID scoped by owner and agent (point 5).
   */
  async findById(id, ownerId, agentId) {
    if (!id || !ownerId || !agentId) return null;
    const sql = `
      SELECT * FROM broker_credential_metadata
      WHERE id = $1 AND owner_id = $2 AND agent_id = $3;
    `;
    const res = await this.adapter.query(sql, [id, ownerId, agentId]);
    if (res.rowCount === 0) return null;
    return this._toDTO(res.rows[0]);
  }

  /**
   * Finds by locator scoped by owner and agent (point 5).
   */
  async findByLocator(secretLocator, ownerId, agentId) {
    if (!secretLocator || !ownerId || !agentId) return null;
    const sql = `
      SELECT * FROM broker_credential_metadata
      WHERE secret_locator = $1 AND owner_id = $2 AND agent_id = $3;
    `;
    const res = await this.adapter.query(sql, [secretLocator, ownerId, agentId]);
    if (res.rowCount === 0) return null;
    return this._toDTO(res.rows[0]);
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
    return res.rows.map(row => this._toDTO(row));
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
    return res.rows.map(row => this._toDTO(row));
  }

  /**
   * Concurrency-safe rotation of a credential locator and expiry date.
   * Scoped by owner and agent.
   */
  async rotate(id, ownerId, agentId, { newSecretLocator, nextExpiresAt, expectedVersion }) {
    try {
      this.validateSecretLocator(newSecretLocator);
      if (!id || !ownerId || !agentId) throw new Error("Missing required parameters for rotation");
    } catch (err) {
      if (this.auditRepo && ownerId && agentId) {
        await this.auditRepo.logAccess({
          credentialId: id || null,
          ownerId,
          agentId,
          action: 'rotate',
          status: 'failure',
          errorMessage: err.message
        });
      }
      throw err;
    }

    return await this.adapter.withTransaction(async (client) => {
      try {
        const checkSql = `
          SELECT * FROM broker_credential_metadata
          WHERE id = $1 AND owner_id = $2 AND agent_id = $3
          FOR UPDATE;
        `;
        const check = await client.query(checkSql, [id, ownerId, agentId]);
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
          WHERE id = $3 AND owner_id = $4 AND agent_id = $5
          RETURNING *;
        `;
        const res = await client.query(updateSql, [newSecretLocator, nextExpiresAt || null, id, ownerId, agentId]);

        if (this.auditRepo) {
          await this.auditRepo.logAccess({
            credentialId: id,
            ownerId,
            agentId,
            action: 'rotate',
            status: 'success'
          }, client);
        }

        return this._toDTO(res.rows[0]);
      } catch (err) {
        if (this.auditRepo) {
          const existsRes = await client.query(
            "SELECT id FROM broker_credential_metadata WHERE id = $1 AND owner_id = $2 AND agent_id = $3",
            [id, ownerId, agentId]
          );
          const hasCred = existsRes.rowCount > 0;
          await this.auditRepo.logAccess({
            credentialId: hasCred ? id : null,
            ownerId,
            agentId,
            action: 'rotate',
            status: 'failure',
            errorMessage: err.message
          }, client);
        }
        throw err;
      }
    });
  }

  /**
   * Concurrency-safe revocation. Scoped by owner and agent.
   */
  async revoke(id, ownerId, agentId) {
    if (!id || !ownerId || !agentId) {
      if (this.auditRepo && ownerId && agentId) {
        await this.auditRepo.logAccess({
          credentialId: id || null,
          ownerId,
          agentId,
          action: 'revoke',
          status: 'failure',
          errorMessage: 'Missing required parameters for revocation'
        });
      }
      throw new Error("Missing required parameters for revocation");
    }

    return await this.adapter.withTransaction(async (client) => {
      try {
        const checkSql = `
          SELECT * FROM broker_credential_metadata
          WHERE id = $1 AND owner_id = $2 AND agent_id = $3
          FOR UPDATE;
        `;
        const check = await client.query(checkSql, [id, ownerId, agentId]);
        if (check.rowCount === 0) {
          throw new Error("Credential not found or unauthorized");
        }

        const current = check.rows[0];
        if (current.revoked_at) {
          return this._toDTO(current);
        }

        const updateSql = `
          UPDATE broker_credential_metadata
          SET revoked_at = now(), updated_at = now()
          WHERE id = $1 AND owner_id = $2 AND agent_id = $3
          RETURNING *;
        `;
        const res = await client.query(updateSql, [id, ownerId, agentId]);

        if (this.auditRepo) {
          await this.auditRepo.logAccess({
            credentialId: id,
            ownerId,
            agentId,
            action: 'revoke',
            status: 'success'
          }, client);
        }

        return this._toDTO(res.rows[0]);
      } catch (err) {
        if (this.auditRepo) {
          const existsRes = await client.query(
            "SELECT id FROM broker_credential_metadata WHERE id = $1 AND owner_id = $2 AND agent_id = $3",
            [id, ownerId, agentId]
          );
          const hasCred = existsRes.rowCount > 0;
          await this.auditRepo.logAccess({
            credentialId: hasCred ? id : null,
            ownerId,
            agentId,
            action: 'revoke',
            status: 'failure',
            errorMessage: err.message
          }, client);
        }
        throw err;
      }
    });
  }

  /**
   * Concurrency-safe updates to metadata. Scoped by owner and agent.
   */
  async updateMetadata(id, ownerId, { rotationStatus, expiresAt, lastHealthStatus, revokedAt }) {
    // Left for PR #31 compatibility, but we enforce scoping when possible, or check:
    throw new Error("updateMetadata requires both ownerId and agentId parameters");
  }

  async updateMetadataScoped(id, ownerId, agentId, { rotationStatus, expiresAt, lastHealthStatus, revokedAt }) {
    if (!id || !ownerId || !agentId) {
      if (this.auditRepo && ownerId && agentId) {
        await this.auditRepo.logAccess({
          credentialId: id || null,
          ownerId,
          agentId,
          action: 'update_metadata',
          status: 'failure',
          errorMessage: 'Missing required parameters for update'
        });
      }
      throw new Error("Missing required parameters for update");
    }
    this.validateMetadataFields({ rotationStatus, lastHealthStatus });

    return await this.adapter.withTransaction(async (client) => {
      try {
        const checkSql = `
          SELECT * FROM broker_credential_metadata
          WHERE id = $1 AND owner_id = $2 AND agent_id = $3
          FOR UPDATE;
        `;
        const check = await client.query(checkSql, [id, ownerId, agentId]);
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
          WHERE id = $5 AND owner_id = $6 AND agent_id = $7
          RETURNING *;
        `;
        const res = await client.query(updateSql, [
          nextRotationStatus,
          nextExpiresAt,
          nextLastHealthStatus,
          nextRevokedAt,
          id,
          ownerId,
          agentId
        ]);

        if (this.auditRepo) {
          await this.auditRepo.logAccess({
            credentialId: id,
            ownerId,
            agentId,
            action: 'update_metadata',
            status: 'success'
          }, client);
        }

        return this._toDTO(res.rows[0]);
      } catch (err) {
        if (this.auditRepo) {
          const existsRes = await client.query(
            "SELECT id FROM broker_credential_metadata WHERE id = $1 AND owner_id = $2 AND agent_id = $3",
            [id, ownerId, agentId]
          );
          const hasCred = existsRes.rowCount > 0;
          await this.auditRepo.logAccess({
            credentialId: hasCred ? id : null,
            ownerId,
            agentId,
            action: 'update_metadata',
            status: 'failure',
            errorMessage: err.message
          }, client);
        }
        throw err;
      }
    });
  }
}
