/**
 * ST Production House — Production repository (channels, releases, artifacts).
 *
 * Security contract (AGENTS.md Rules 6, 13, 17):
 * - Every query is parameterized; owner scoping is always part of the WHERE
 *   clause, so a cross-owner channel/release/artifact is indistinguishable
 *   from a missing one (generic 404 up the stack).
 * - Outbound rows use explicit camelCase DTO projections; internal agent
 *   namespaces and secret-shaped fields never serialize (Rule 15/17).
 * - Status transitions use exactly the sql/019 enum (R5): planned,
 *   in_production, rendering, review, published, cancelled.
 *
 * Portability contract: queries stay inside the SQL subset shared by the
 * PostgreSQL adapter and the labeled demo adapter (single-table statements,
 * no table aliases, no scalar subqueries, no INSERT..SELECT, no join
 * projections, inlined validated integer LIMITs). Multi-table assembly
 * happens in JS after independent parameterized reads.
 */

import { randomUUID } from "node:crypto";

const RELEASE_STATUSES = Object.freeze([
  "planned", "in_production", "rendering", "review", "published", "cancelled",
]);

const PLATFORMS = Object.freeze(["youtube", "instagram", "facebook", "snapchat"]);

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function releaseDto(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    title: row.title,
    season: Number(row.season),
    episode: Number(row.episode),
    status: row.status,
    createdAt: toIso(row.created_at),
  };
}

function artifactDto(row) {
  const metadata = typeof row.metadata === "string" ? safeParse(row.metadata) : row.metadata ?? {};
  return {
    id: row.id,
    releaseId: row.release_id ?? null,
    jobId: row.job_id ?? null,
    kind: row.kind,
    stage: metadata.stage ?? null,
    storageUri: row.storage_uri,
    sha256: row.sha256,
    ffprobeVerified: row.ffprobe_verified === true,
    sizeBytes: Number.isFinite(metadata.sizeBytes) ? metadata.sizeBytes : null,
    mimeType: metadata.mimeType ?? null,
    generationMode: metadata.generationMode ?? "unknown",
    createdAt: toIso(row.created_at),
  };
}

function destinationDto(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    platform: row.platform,
    handle: row.handle,
    isPrimary: row.is_primary === true,
    publicAttribution: row.public_attribution,
    createdAt: toIso(row.created_at),
  };
}

export function isValidChannelSlug(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{1,79}$/.test(slug);
}

export function isKnownReleaseStatus(status) {
  return RELEASE_STATUSES.includes(status);
}

export function isKnownPlatform(platform) {
  return PLATFORMS.includes(platform);
}

export class ProductionRepository {
  constructor(dbAdapter) {
    if (!dbAdapter || typeof dbAdapter.query !== "function") {
      throw new Error("PRODUCTION_DB_ADAPTER_REQUIRED");
    }
    this.db = dbAdapter;
  }

  // ------------------------------------------------------------------
  // Channels
  // ------------------------------------------------------------------
  async listChannels(ownerId) {
    const channelsResult = await this.db.query(
      `SELECT id, slug, display_name, tagline, language, agent_id
         FROM channels WHERE owner_id = $1 ORDER BY display_name ASC;`,
      [ownerId]
    );
    const agentsResult = await this.db.query("SELECT id, enabled FROM agents;");
    const agentEnabledById = new Map(agentsResult.rows.map((row) => [row.id, row.enabled === true]));

    const countResult = await this.db.query(
      `SELECT channel_id, count(*) AS release_count
         FROM production_releases WHERE owner_id = $1 GROUP BY channel_id;`,
      [ownerId]
    );
    const countByChannel = new Map(
      countResult.rows.map((row) => [row.channel_id, Number(row.release_count ?? row.count ?? 0)])
    );

    return channelsResult.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      tagline: row.tagline,
      language: row.language,
      agentId: row.agent_id,
      agentEnabled: agentEnabledById.get(row.agent_id) ?? false,
      releaseCount: countByChannel.get(row.id) ?? 0,
    }));
  }

  async getChannel(ownerId, channelId) {
    const result = await this.db.query(
      `SELECT id, slug, display_name, tagline, language, agent_id, owner_id
         FROM channels WHERE id = $1 AND owner_id = $2;`,
      [channelId, ownerId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const agentResult = await this.db.query("SELECT id, name, enabled FROM agents WHERE id = $1;", [row.agent_id]);
    const agent = agentResult.rows[0];
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      tagline: row.tagline,
      language: row.language,
      agentId: row.agent_id,
      agentEnabled: agent ? agent.enabled === true : false,
      agentInternalName: agent ? agent.name : null,
      ownerId: row.owner_id,
    };
  }

  async createChannel(ownerId, { slug, displayName, tagline, language, agentId }) {
    await this.db.query(
      `INSERT INTO channels (id, slug, display_name, tagline, language, agent_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [randomUUID(), slug, displayName, tagline ?? null, language || "Hindi", agentId, ownerId]
    );
    const created = await this.db.query(
      `SELECT id, slug, display_name, tagline, language, agent_id
         FROM channels WHERE owner_id = $1 AND slug = $2;`,
      [ownerId, slug]
    );
    const row = created.rows[0];
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      tagline: row.tagline,
      language: row.language,
      agentId: row.agent_id,
      releaseCount: 0,
    };
  }

  async channelSlugExists(ownerId, slug) {
    const result = await this.db.query(
      "SELECT 1 FROM channels WHERE owner_id = $1 AND slug = $2 LIMIT 1;",
      [ownerId, slug]
    );
    return result.rows.length > 0;
  }

  // ------------------------------------------------------------------
  // Production releases
  // ------------------------------------------------------------------
  async listReleases(ownerId, { limit = 100 } = {}) {
    const bounded = Math.min(Math.max(1, Math.floor(Number(limit) || 100)), 200);
    const result = await this.db.query(
      `SELECT id, channel_id, title, season, episode, status, created_at
         FROM production_releases WHERE owner_id = $1 ORDER BY created_at DESC LIMIT ${bounded};`,
      [ownerId]
    );
    const channelsResult = await this.db.query("SELECT id, display_name, slug FROM channels WHERE owner_id = $1;", [ownerId]);
    const channelById = new Map(channelsResult.rows.map((row) => [row.id, row]));
    return result.rows.map((row) => ({
      ...releaseDto(row),
      channelName: channelById.get(row.channel_id)?.display_name ?? null,
      channelSlug: channelById.get(row.channel_id)?.slug ?? null,
    }));
  }

  async listReleasesForChannel(ownerId, channelId, { limit = 50 } = {}) {
    const bounded = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 200);
    const result = await this.db.query(
      `SELECT id, channel_id, title, season, episode, status, created_at
         FROM production_releases WHERE owner_id = $1 AND channel_id = $2
        ORDER BY season DESC, episode DESC LIMIT ${bounded};`,
      [ownerId, channelId]
    );
    return result.rows.map(releaseDto);
  }

  async getRelease(ownerId, releaseId) {
    const result = await this.db.query(
      `SELECT id, channel_id, title, season, episode, status, created_at
         FROM production_releases WHERE id = $1 AND owner_id = $2;`,
      [releaseId, ownerId]
    );
    return result.rows[0] ? releaseDto(result.rows[0]) : null;
  }

  /**
   * Creates a release and its queued production job in ONE transaction
   * (Rule 13: the idempotency key ties the job to the release). The job row
   * is inserted through the transaction client so it cannot exist without the
   * release. Returns { release, jobId } or { conflict: true } when the
   * channel/season/episode slot already has a release (Rule 8).
   */
  async createReleaseWithJob(ownerId, { channelId, agentId, title, season, episode }) {
    return this.db.withTransaction(async (client) => {
      const existing = await client.query(
        "SELECT 1 FROM production_releases WHERE channel_id = $1 AND season = $2 AND episode = $3;",
        [channelId, season, episode]
      );
      if (existing.rows.length > 0) return { conflict: true };

      const releaseId = randomUUID();
      const jobId = randomUUID();
      await client.query(
        `INSERT INTO production_releases (id, channel_id, owner_id, title, season, episode, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned');`,
        [releaseId, channelId, ownerId, title, season, episode]
      );
      await client.query(
        `INSERT INTO jobs (id, agent_id, capability, idempotency_key, status, priority, attempts, max_attempts, payload, owner_id)
         VALUES ($1, $2, 'episode_production', $3, 'queued', 100, 0, 3, $4, $5);`,
        [jobId, agentId, `production-${releaseId}`, JSON.stringify({ releaseId, channelId, title, season, episode }), ownerId]
      );
      return {
        release: {
          id: releaseId,
          channelId,
          title,
          season,
          episode,
          status: "planned",
          createdAt: new Date().toISOString(),
        },
        jobId,
      };
    });
  }

  async updateReleaseStatus(ownerId, releaseId, status) {
    if (!isKnownReleaseStatus(status)) throw new Error("PRODUCTION_VALIDATION_FAILED");
    const result = await this.db.query(
      `UPDATE production_releases SET status = $3 WHERE id = $1 AND owner_id = $2;`,
      [releaseId, ownerId, status]
    );
    if (!result.rowCount) return null;
    return this.getRelease(ownerId, releaseId);
  }

  // ------------------------------------------------------------------
  // Artifacts (canonical artifacts table from sql/001 + release_id from 020)
  // ------------------------------------------------------------------
  /**
   * Idempotent by content: identical output for the same release is stored
   * once (sha256 unique per release). Returns the stored DTO, or null when an
   * identical artifact already exists.
   */
  async recordArtifact(artifact) {
    const duplicate = await this.db.query(
      "SELECT id FROM artifacts WHERE release_id = $1 AND sha256 = $2 LIMIT 1;",
      [artifact.releaseId, artifact.sha256]
    );
    if (duplicate.rows.length > 0) return null;

    const id = artifact.id || randomUUID();
    // storage_uri is an honest local descriptor, never a fabricated platform URL.
    const storageUri = `local://deterministic/${artifact.releaseId}/${artifact.stage}`;
    await this.db.query(
      `INSERT INTO artifacts (id, job_id, kind, storage_uri, sha256, ffprobe_verified, metadata, release_id)
       VALUES ($1, $2, $3, $4, $5, false, $6, $7);`,
      [
        id,
        artifact.jobId ?? null,
        artifact.kind,
        storageUri,
        artifact.sha256,
        JSON.stringify({
          stage: artifact.stage,
          generationMode: "deterministic_local",
          sizeBytes: artifact.sizeBytes ?? null,
          mimeType: artifact.mimeType ?? null,
        }),
        artifact.releaseId,
      ]
    );
    return this.getArtifactById(id, artifact.ownerId);
  }

  async getArtifactById(artifactId, ownerId) {
    // Owner scoping goes through the release join performed in two honest,
    // parameterized reads (no join projection in the shared SQL subset).
    const artifactResult = await this.db.query(
      `SELECT id, release_id, job_id, kind, storage_uri, sha256, ffprobe_verified, metadata, created_at
         FROM artifacts WHERE id = $1;`,
      [artifactId]
    );
    const row = artifactResult.rows[0];
    if (!row || !row.release_id) return null;
    const owned = await this.db.query(
      "SELECT 1 FROM production_releases WHERE id = $1 AND owner_id = $2;",
      [row.release_id, ownerId]
    );
    if (owned.rows.length === 0) return null;
    return artifactDto(row);
  }

  async listArtifactsForRelease(ownerId, releaseId) {
    const owned = await this.db.query(
      "SELECT 1 FROM production_releases WHERE id = $1 AND owner_id = $2;",
      [releaseId, ownerId]
    );
    if (owned.rows.length === 0) return [];
    const result = await this.db.query(
      `SELECT id, release_id, job_id, kind, storage_uri, sha256, ffprobe_verified, metadata, created_at
         FROM artifacts WHERE release_id = $1 ORDER BY created_at ASC;`,
      [releaseId]
    );
    return result.rows.map(artifactDto);
  }

  // ------------------------------------------------------------------
  // Pipeline events (durable per-stage log, sql/020)
  // ------------------------------------------------------------------
  async recordPipelineEvent({ releaseId, ownerId, stage, status, jobId = null, detail = {} }) {
    await this.db.query(
      `INSERT INTO pipeline_events (release_id, owner_id, stage, status, job_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [releaseId, ownerId, stage, status, jobId, JSON.stringify(detail)]
    );
  }

  async listPipelineEvents(ownerId, releaseId, { limit = 200 } = {}) {
    const bounded = Math.min(Math.max(1, Math.floor(Number(limit) || 200)), 500);
    const result = await this.db.query(
      `SELECT id, release_id, stage, status, job_id, detail, created_at
         FROM pipeline_events WHERE owner_id = $1 AND release_id = $2 ORDER BY id ASC LIMIT ${bounded};`,
      [ownerId, releaseId]
    );
    return result.rows.map((row, index) => ({
      id: row.id === undefined || row.id === null ? String(index + 1) : String(row.id),
      releaseId: row.release_id,
      stage: row.stage,
      status: row.status,
      jobId: row.job_id ?? null,
      detail: typeof row.detail === "string" ? safeParse(row.detail) : row.detail ?? {},
      createdAt: toIso(row.created_at),
    }));
  }

  // ------------------------------------------------------------------
  // Publish destinations (public channel identities, sql/020)
  // ------------------------------------------------------------------
  async listDestinations(ownerId, channelId) {
    const result = await this.db.query(
      `SELECT id, channel_id, platform, handle, is_primary, public_attribution, created_at
         FROM publish_destinations WHERE owner_id = $1 AND channel_id = $2 ORDER BY platform ASC, created_at ASC;`,
      [ownerId, channelId]
    );
    return result.rows.map(destinationDto);
  }

  async getDestination(ownerId, destinationId) {
    const result = await this.db.query(
      `SELECT id, channel_id, platform, handle, is_primary, public_attribution, created_at
         FROM publish_destinations WHERE id = $1 AND owner_id = $2;`,
      [destinationId, ownerId]
    );
    return result.rows[0] ? destinationDto(result.rows[0]) : null;
  }

  async createDestination(ownerId, { channelId, platform, handle, isPrimary = false, publicAttribution }) {
    await this.db.query(
      `INSERT INTO publish_destinations (channel_id, owner_id, platform, handle, is_primary, public_attribution)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [channelId, ownerId, platform, handle, isPrimary === true, publicAttribution]
    );
    const created = await this.db.query(
      `SELECT id FROM publish_destinations WHERE owner_id = $1 AND channel_id = $2 AND handle = $3 ORDER BY created_at DESC;`,
      [ownerId, channelId, handle]
    );
    return this.getDestination(ownerId, created.rows[0].id);
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 200) };
  }
}

export default ProductionRepository;
