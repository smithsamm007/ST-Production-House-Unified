// Phase 2: Provider Configuration and Credential Management Repositories

export class ProviderConfigurationRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("ProviderConfigurationRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async getProviderConfig({ ownerId, agentId, configId }) {
    if (!ownerId || !agentId || !configId) {
      throw new Error("getProviderConfig requires ownerId, agentId, configId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, owner_id, agent_id, slot, provider, credential_id,
          api_version, timeout_ms, retry_limit, is_enabled, created_at, updated_at
        FROM agent_provider_configurations
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        `,
        [ownerId, agentId, configId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        configId: row.id,
        slot: row.slot,
        provider: row.provider,
        credentialId: row.credential_id,
        apiVersion: row.api_version,
        timeoutMs: row.timeout_ms,
        retryLimit: row.retry_limit,
        isEnabled: row.is_enabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } finally {
      await conn.release();
    }
  }

  async listProviderConfigs({ ownerId, agentId, limit = 50 }) {
    if (!ownerId || !agentId) {
      throw new Error("listProviderConfigs requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, slot, provider, is_enabled, created_at
        FROM agent_provider_configurations
        WHERE owner_id = $1 AND agent_id = $2
        ORDER BY slot, created_at
        LIMIT $3
        `,
        [ownerId, agentId, limit]
      );

      return result.rows.map(row => ({
        configId: row.id,
        slot: row.slot,
        provider: row.provider,
        isEnabled: row.is_enabled,
        createdAt: row.created_at
      }));
    } finally {
      await conn.release();
    }
  }

  async createProviderConfig({
    ownerId,
    agentId,
    slot,
    provider,
    credentialId,
    apiVersion,
    timeoutMs,
    retryLimit
  }) {
    if (!ownerId || !agentId || !slot || !provider) {
      throw new Error(
        "createProviderConfig requires ownerId, agentId, slot, provider"
      );
    }

    const validSlots = ["primary", "secondary", "tertiary", "emergency_1", "emergency_2"];
    if (!validSlots.includes(slot)) {
      throw new Error(`Invalid slot: ${slot}`);
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO agent_provider_configurations (
          owner_id, agent_id, slot, provider, credential_id,
          api_version, timeout_ms, retry_limit, is_enabled
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        ON CONFLICT (owner_id, agent_id, slot) DO UPDATE SET
          provider = EXCLUDED.provider,
          credential_id = EXCLUDED.credential_id,
          api_version = EXCLUDED.api_version,
          timeout_ms = EXCLUDED.timeout_ms,
          retry_limit = EXCLUDED.retry_limit,
          updated_at = now()
        RETURNING id, created_at
        `,
        [
          ownerId,
          agentId,
          slot,
          provider,
          credentialId || null,
          apiVersion || "v1",
          timeoutMs || 30000,
          retryLimit || 3
        ]
      );

      return {
        configId: result.rows[0].id,
        slot,
        provider,
        isEnabled: true,
        createdAt: result.rows[0].created_at
      };
    } finally {
      await conn.release();
    }
  }

  async disableProviderConfig({ ownerId, agentId, configId }) {
    if (!ownerId || !agentId || !configId) {
      throw new Error("disableProviderConfig requires ownerId, agentId, configId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE agent_provider_configurations
        SET is_enabled = false, updated_at = now()
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        RETURNING id, is_enabled
        `,
        [ownerId, agentId, configId]
      );

      if (result.rows.length === 0) return null;

      return {
        configId: result.rows[0].id,
        isEnabled: result.rows[0].is_enabled
      };
    } finally {
      await conn.release();
    }
  }
}

export class CredentialRegistryRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("CredentialRegistryRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async registerCredential({
    ownerId,
    agentId,
    provider,
    credentialName,
    vaultLocator
  }) {
    if (!ownerId || !agentId || !provider || !credentialName || !vaultLocator) {
      throw new Error(
        "registerCredential requires ownerId, agentId, provider, credentialName, vaultLocator"
      );
    }

    if (!vaultLocator.startsWith("vault://")) {
      throw new Error("vaultLocator must start with vault://");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO owner_credentials (
          owner_id, agent_id, provider, credential_name, vault_locator
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at
        `,
        [ownerId, agentId, provider, credentialName, vaultLocator]
      );

      return {
        credentialId: result.rows[0].id,
        vaultLocator, // Return opaque locator, never actual secret
        createdAt: result.rows[0].created_at
      };
    } finally {
      await conn.release();
    }
  }

  async listCredentials({ ownerId, agentId, limit = 50 }) {
    if (!ownerId || !agentId) {
      throw new Error("listCredentials requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, provider, credential_name, vault_locator, created_at
        FROM owner_credentials
        WHERE owner_id = $1 AND agent_id = $2
        ORDER BY created_at DESC
        LIMIT $3
        `,
        [ownerId, agentId, limit]
      );

      return result.rows.map(row => ({
        credentialId: row.id,
        provider: row.provider,
        credentialName: row.credential_name,
        vaultLocator: row.vault_locator, // Safe to return - opaque locator
        createdAt: row.created_at
      }));
    } finally {
      await conn.release();
    }
  }

  async revokeCredential({ ownerId, agentId, credentialId }) {
    if (!ownerId || !agentId || !credentialId) {
      throw new Error("revokeCredential requires ownerId, agentId, credentialId");
    }

    const conn = await this.adapter.getConnection();
    try {
      await conn.query(
        `
        UPDATE owner_credentials
        SET is_active = false, revoked_at = now()
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        `,
        [ownerId, agentId, credentialId]
      );

      return { credentialId, isActive: false, revokedAt: new Date() };
    } finally {
      await conn.release();
    }
  }
}

// Agent Social Account Repository - Manages social media connections
export class AgentSocialAccountRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("AgentSocialAccountRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async addSocialAccount({
    ownerId,
    agentId,
    platform,
    channelName,
    channelId
  }) {
    if (!ownerId || !agentId || !platform || !channelName) {
      throw new Error(
        "addSocialAccount requires ownerId, agentId, platform, channelName"
      );
    }

    const validPlatforms = ["youtube", "instagram", "facebook", "snapchat", "tiktok"];
    if (!validPlatforms.includes(platform)) {
      throw new Error(`Invalid platform: ${platform}`);
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO agent_social_accounts (
          owner_id, agent_id, platform, channel_name, channel_id, account_type
        )
        VALUES ($1, $2, $3, $4, $5, 'unconfigured')
        ON CONFLICT (owner_id, agent_id, platform) DO UPDATE SET
          channel_name = EXCLUDED.channel_name,
          channel_id = EXCLUDED.channel_id,
          updated_at = now()
        RETURNING id, platform, account_type, created_at
        `,
        [ownerId, agentId, platform, channelName, channelId || null]
      );

      return {
        accountId: result.rows[0].id,
        platform: result.rows[0].platform,
        accountType: result.rows[0].account_type,
        createdAt: result.rows[0].created_at
      };
    } finally {
      await conn.release();
    }
  }

  async listSocialAccounts({ ownerId, agentId }) {
    if (!ownerId || !agentId) {
      throw new Error("listSocialAccounts requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, platform, channel_name, channel_id, account_type, created_at
        FROM agent_social_accounts
        WHERE owner_id = $1 AND agent_id = $2
        ORDER BY platform, created_at
        `,
        [ownerId, agentId]
      );

      return result.rows.map(row => ({
        accountId: row.id,
        platform: row.platform,
        channelName: row.channel_name,
        channelId: row.channel_id,
        accountType: row.account_type,
        createdAt: row.created_at
      }));
    } finally {
      await conn.release();
    }
  }

  async removeSocialAccount({ ownerId, agentId, accountId }) {
    if (!ownerId || !agentId || !accountId) {
      throw new Error("removeSocialAccount requires ownerId, agentId, accountId");
    }

    const conn = await this.adapter.getConnection();
    try {
      await conn.query(
        `
        DELETE FROM agent_social_accounts
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        `,
        [ownerId, agentId, accountId]
      );

      return { accountId, deleted: true };
    } finally {
      await conn.release();
    }
  }
}
