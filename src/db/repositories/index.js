// Phase 2: PostgreSQL Repository Layer
// AgentPublicProfileRepository - Manages public-facing agent profiles

export class AgentPublicProfileRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("AgentPublicProfileRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async getAgentProfile({ ownerId, agentId }) {
    if (!ownerId || !agentId) {
      throw new Error("getAgentProfile requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          a.id, a.internal_name, ap.owner_id, ap.public_brand_name,
          ap.public_channel_name, ap.public_narrator_identity,
          ap.description, ap.website_url, ap.updated_at, ap.created_at
        FROM agents a
        LEFT JOIN agent_public_profiles ap
          ON a.id = ap.agent_id AND ap.owner_id = $1
        WHERE a.id = $2
        `,
        [ownerId, agentId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        agentId: row.id,
        internalName: row.internal_name,
        publicBrandName: row.public_brand_name,
        publicChannelName: row.public_channel_name,
        publicNarratorIdentity: row.public_narrator_identity,
        description: row.description,
        websiteUrl: row.website_url,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } finally {
      await conn.release();
    }
  }

  async updateAgentProfile({
    ownerId,
    agentId,
    publicBrandName,
    publicChannelName,
    publicNarratorIdentity,
    description,
    websiteUrl
  }) {
    if (!ownerId || !agentId) {
      throw new Error("updateAgentProfile requires ownerId, agentId");
    }

    // Validate no internal agent names in public fields
    const publicFields = [publicBrandName, publicChannelName, publicNarratorIdentity, description];
    const internalNames = ["JARVIS", "LAKME", "PANCHI", "VEDA", "SHERLOCK", "WATSON"];
    for (const field of publicFields) {
      if (field) {
        for (const internalName of internalNames) {
          if (field.toUpperCase().includes(internalName)) {
            throw new Error(
              `Public fields cannot contain internal agent names (found: ${internalName})`
            );
          }
        }
      }
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO agent_public_profiles (
          owner_id, agent_id, public_brand_name, public_channel_name,
          public_narrator_identity, description, website_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (owner_id, agent_id) DO UPDATE SET
          public_brand_name = COALESCE(EXCLUDED.public_brand_name, agent_public_profiles.public_brand_name),
          public_channel_name = COALESCE(EXCLUDED.public_channel_name, agent_public_profiles.public_channel_name),
          public_narrator_identity = COALESCE(EXCLUDED.public_narrator_identity, agent_public_profiles.public_narrator_identity),
          description = COALESCE(EXCLUDED.description, agent_public_profiles.description),
          website_url = COALESCE(EXCLUDED.website_url, agent_public_profiles.website_url),
          updated_at = now()
        RETURNING *
        `,
        [
          ownerId,
          agentId,
          publicBrandName || null,
          publicChannelName || null,
          publicNarratorIdentity || null,
          description || null,
          websiteUrl || null
        ]
      );

      return {
        agentId: result.rows[0].agent_id,
        publicBrandName: result.rows[0].public_brand_name,
        publicChannelName: result.rows[0].public_channel_name,
        publicNarratorIdentity: result.rows[0].public_narrator_identity,
        description: result.rows[0].description,
        websiteUrl: result.rows[0].website_url,
        updatedAt: result.rows[0].updated_at
      };
    } finally {
      await conn.release();
    }
  }

  async listAgentProfiles({ ownerId, limit = 50 }) {
    if (!ownerId) {
      throw new Error("listAgentProfiles requires ownerId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          a.id, a.internal_name, ap.public_brand_name,
          ap.public_channel_name, ap.created_at
        FROM agents a
        LEFT JOIN agent_public_profiles ap
          ON a.id = ap.agent_id AND ap.owner_id = $1
        LIMIT $2
        `,
        [ownerId, limit]
      );

      return result.rows.map(row => ({
        agentId: row.id,
        internalName: row.internal_name,
        publicBrandName: row.public_brand_name,
        publicChannelName: row.public_channel_name,
        createdAt: row.created_at
      }));
    } finally {
      await conn.release();
    }
  }
}

// CreativeCharterRepository - Manages creative charters and versions
export class CreativeCharterRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("CreativeCharterRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async getCharter({ ownerId, agentId, charterId }) {
    if (!ownerId || !agentId || !charterId) {
      throw new Error("getCharter requires ownerId, agentId, charterId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          cc.id, cc.owner_id, cc.agent_id, cc.universe_id, cc.title,
          cc.description, cc.is_approved, cc.approved_by_owner_id, cc.approved_at,
          cc.is_active, cc.created_at, cc.updated_at
        FROM creative_charters cc
        WHERE cc.owner_id = $1 AND cc.agent_id = $2 AND cc.id = $3
        `,
        [ownerId, agentId, charterId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        charterId: row.id,
        ownerId: row.owner_id,
        agentId: row.agent_id,
        universeId: row.universe_id,
        title: row.title,
        description: row.description,
        isApproved: row.is_approved,
        approvedByOwnerId: row.approved_by_owner_id,
        approvedAt: row.approved_at,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } finally {
      await conn.release();
    }
  }

  async listChartersForAgent({ ownerId, agentId, limit = 50 }) {
    if (!ownerId || !agentId) {
      throw new Error("listChartersForAgent requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, universe_id, title, is_approved, is_active, created_at
        FROM creative_charters
        WHERE owner_id = $1 AND agent_id = $2
        ORDER BY created_at DESC
        LIMIT $3
        `,
        [ownerId, agentId, limit]
      );

      return result.rows.map(row => ({
        charterId: row.id,
        universeId: row.universe_id,
        title: row.title,
        isApproved: row.is_approved,
        isActive: row.is_active,
        createdAt: row.created_at
      }));
    } finally {
      await conn.release();
    }
  }

  async getCharterVersions({ charterId, limit = 20 }) {
    if (!charterId) {
      throw new Error("getCharterVersions requires charterId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, charter_id, version_number, snapshot_hash, is_approved,
          created_at
        FROM creative_charter_versions
        WHERE charter_id = $1
        ORDER BY version_number DESC
        LIMIT $2
        `,
        [charterId, limit]
      );

      return result.rows.map(row => ({
        versionId: row.id,
        charterId: row.charter_id,
        versionNumber: row.version_number,
        snapshotHash: row.snapshot_hash,
        isApproved: row.is_approved,
        createdAt: row.created_at
      }));
    } finally {
      await conn.release();
    }
  }

  async approveCharter({
    ownerId,
    agentId,
    charterId,
    approvedByOwnerId,
    versionNumber
  }) {
    if (!ownerId || !agentId || !charterId || !approvedByOwnerId) {
      throw new Error(
        "approveCharter requires ownerId, agentId, charterId, approvedByOwnerId"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      // Approve charter
      await conn.query(
        `
        UPDATE creative_charters
        SET is_approved = true, approved_by_owner_id = $4, approved_at = now()
        WHERE owner_id = $1 AND agent_id = $2 AND id = $3
        `,
        [ownerId, agentId, charterId, approvedByOwnerId]
      );

      // Mark version as approved
      if (versionNumber) {
        await conn.query(
          `
          UPDATE creative_charter_versions
          SET is_approved = true
          WHERE charter_id = $1 AND version_number = $2
          `,
          [charterId, versionNumber]
        );
      }

      return { charterId, isApproved: true, approvedAt: new Date() };
    } finally {
      await conn.release();
    }
  }
}

// CreativeReferenceRepository - Manages creative references (niche and visual)
export class CreativeReferenceRepository {
  constructor({ adapter }) {
    if (!adapter) throw new Error("CreativeReferenceRepository requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
  }

  async submitReference({
    ownerId,
    agentId,
    referenceType,
    title,
    description,
    sourceUrl,
    tags
  }) {
    if (!ownerId || !agentId || !referenceType || !title) {
      throw new Error(
        "submitReference requires ownerId, agentId, referenceType, title"
      );
    }

    const validTypes = [
      "youtube_channel",
      "youtube_video",
      "youtube_playlist",
      "written_brief",
      "authorized_image",
      "uploaded_asset_metadata"
    ];
    if (!validTypes.includes(referenceType)) {
      throw new Error(`Invalid referenceType: ${referenceType}`);
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO creative_references (
          owner_id, agent_id, reference_type, title, description,
          source_url, tags, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted')
        RETURNING id, created_at
        `,
        [
          ownerId,
          agentId,
          referenceType,
          title,
          description || null,
          sourceUrl || null,
          tags ? JSON.stringify(tags) : null
        ]
      );

      return {
        referenceId: result.rows[0].id,
        status: "submitted",
        createdAt: result.rows[0].created_at
      };
    } finally {
      await conn.release();
    }
  }

  async getReference({ ownerId, referenceId }) {
    if (!ownerId || !referenceId) {
      throw new Error("getReference requires ownerId, referenceId");
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT
          id, agent_id, reference_type, title, description, source_url,
          status, tags, created_at, updated_at
        FROM creative_references
        WHERE owner_id = $1 AND id = $2
        `,
        [ownerId, referenceId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        referenceId: row.id,
        agentId: row.agent_id,
        referenceType: row.reference_type,
        title: row.title,
        description: row.description,
        sourceUrl: row.source_url,
        status: row.status,
        tags: row.tags ? JSON.parse(row.tags) : [],
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } finally {
      await conn.release();
    }
  }

  async listReferences({
    ownerId,
    agentId,
    status,
    limit = 50
  }) {
    if (!ownerId || !agentId) {
      throw new Error("listReferences requires ownerId, agentId");
    }

    const conn = await this.adapter.getConnection();
    try {
      let query = `
        SELECT id, reference_type, title, status, created_at
        FROM creative_references
        WHERE owner_id = $1 AND agent_id = $2
      `;
      const params = [ownerId, agentId];

      if (status) {
        query += ` AND status = $${params.length + 1}`;
        params.push(status);
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await conn.query(query, params);

      return result.rows.map(row => ({
        referenceId: row.id,
        referenceType: row.reference_type,
        title: row.title,
        status: row.status,
        createdAt: row.created_at
      }));
    } finally {
      await conn.release();
    }
  }

  async approveReference({ ownerId, referenceId, approvedByOwnerId }) {
    if (!ownerId || !referenceId || !approvedByOwnerId) {
      throw new Error(
        "approveReference requires ownerId, referenceId, approvedByOwnerId"
      );
    }

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        UPDATE creative_references
        SET status = 'approved', updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING id, status, updated_at
        `,
        [ownerId, referenceId]
      );

      if (result.rows.length === 0) return null;

      return {
        referenceId: result.rows[0].id,
        status: result.rows[0].status,
        updatedAt: result.rows[0].updated_at
      };
    } finally {
      await conn.release();
    }
  }
}
