/**
 * ST Production House — YouTube OAuth repository (Issue #206).
 *
 * Persistence layer for the owner-scoped YouTube OAuth lifecycle on top of
 * sql/028. Two tables, both strictly scoped by (owner_id, agent_id):
 *
 *   - youtube_oauth_states: the OAuth state is stored ONLY as a SHA-256 hash;
 *     consumption is a single conditional UPDATE (consumed_at IS NULL) so a
 *     state is atomically single-use and replay returns zero rows.
 *   - youtube_director_accounts: one YouTube account per (owner, director),
 *     holding ONLY safe channel identity, the EXISTING connection-status enum
 *     (sql/003: unconfigured | connected | expired | disconnected), and the
 *     OPAQUE secret-manager locator. Raw tokens are never accepted.
 *
 * Security contract (AGENTS.md Rules 1, 5, 6, 15, 17):
 *   - Every read/write is parameterized and scoped by BOTH owner_id and
 *     agent_id; a cross-owner or cross-director access is indistinguishable
 *     from a missing row.
 *   - DTOs are explicit allowlists: the token locator, state hash, and any
 *     secret material NEVER serialize.
 *   - Statements stay inside the SQL subset shared by the PostgreSQL adapter
 *     and the labeled demo adapter (single-table, $n params, inlined integer
 *     LIMITs, RETURNING *, ON CONFLICT DO UPDATE; NO time comparisons in SQL —
 *     expiry is evaluated by the caller in JS so both adapters agree).
 */

/**
 * Issue #206 is the YouTube slice: the provider binding is fixed by contract.
 */
export const OAUTH_PROVIDER_KEY = "youtube";

/**
 * EXISTING status enum from sql/003 agent_social_accounts.connection_status
 * (R5: no new states). A missing account row means "unconfigured".
 */
export const ACCOUNT_STATUSES = Object.freeze([
  "unconfigured",
  "connected",
  "expired",
  "disconnected",
]);

const MAX_LIST_LIMIT = 200;
const LOCATOR_PREFIXES = Object.freeze(["vault://", "opaque://"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isLocatorShaped(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    LOCATOR_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

function boundedLimit(raw, fallback) {
  const n = Math.floor(Number(raw));
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIST_LIMIT);
}

/**
 * Safe account DTO. Explicit allowlist: the token locator NEVER serializes,
 * and there is deliberately no "token" or "secret" field at all (Rule 17).
 */
function accountDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    providerKey: row.provider_key,
    status: row.status,
    channel: {
      id: row.channel_id ?? null,
      title: row.channel_title ?? null,
      handle: row.channel_handle ?? null,
    },
    oauthScope: row.oauth_scope ?? null,
    verifiedAt: toIso(row.verified_at),
    tokenExpiresAt: toIso(row.token_expires_at),
    connectedAt: toIso(row.connected_at),
    revokedAt: toIso(row.revoked_at),
    lastErrorCode: row.last_error_code ?? null,
    updatedAt: toIso(row.updated_at),
  };
}

function stateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    stateHash: row.state_hash,
    ownerId: row.owner_id,
    agentId: row.agent_id,
    providerKey: row.provider_key,
    redirectUri: row.redirect_uri,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    consumedAt: toIso(row.consumed_at),
  };
}

export class YouTubeOAuthRepository {
  constructor(db) {
    this.db = db;
  }

  /** Director existence check (agents are the Director slots). */
  async agentExists(agentId) {
    const rows = await this.db.query("SELECT id FROM agents WHERE id = $1", [agentId]);
    return rows.rows.length > 0;
  }

  /**
   * Mint a state row. `stateHash` is the SHA-256 hex of the state token;
   * the plaintext token is NEVER passed to this layer.
   */
  async insertState({ stateHash, ownerId, agentId, redirectUri, expiresAt }) {
    if (typeof stateHash !== "string" || !/^[0-9a-f]{64}$/.test(stateHash)) {
      throw fail("OAUTH_STATE_HASH_INVALID");
    }
    if (!isLocatorShapedSafeString(redirectUri) || !redirectUri.startsWith("https://")) {
      throw fail("OAUTH_REDIRECT_URI_INVALID");
    }
    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(expiry.getTime())) {
      throw fail("OAUTH_STATE_EXPIRY_INVALID");
    }
    const result = await this.db.query(
      `INSERT INTO youtube_oauth_states
         (state_hash, owner_id, agent_id, provider_key, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [stateHash, ownerId, agentId, OAUTH_PROVIDER_KEY, redirectUri, expiry],
    );
    return stateRow(result.rows[0]);
  }

  async findStateByHash(stateHash) {
    if (typeof stateHash !== "string" || !/^[0-9a-f]{64}$/.test(stateHash)) {
      return null;
    }
    const rows = await this.db.query(
      "SELECT * FROM youtube_oauth_states WHERE state_hash = $1",
      [stateHash],
    );
    return stateRow(rows.rows[0] ?? null);
  }

  /**
   * ATOMIC single-use claim. One conditional UPDATE whose predicate includes
   * every binding (owner, agent, provider) plus consumed_at IS NULL; exactly
   * one caller can flip the marker, so a replayed state yields false.
   */
  async claimState({ stateHash, ownerId, agentId, providerKey = OAUTH_PROVIDER_KEY }) {
    const result = await this.db.query(
      `UPDATE youtube_oauth_states
       SET consumed_at = now()
       WHERE state_hash = $1
         AND owner_id = $2
         AND agent_id = $3
         AND provider_key = $4
         AND consumed_at IS NULL`,
      [stateHash, ownerId, agentId, providerKey],
    );
    return result.rowCount === 1;
  }

  /**
   * Bounded opportunistic cleanup of this (owner, director)'s spent/expired
   * states. Expiry filtering happens in JS (never SQL time comparisons).
   */
  async deleteExpiredStates(ownerId, agentId, { now = new Date(), limit = 50 } = {}) {
    const rows = await this.db.query(
      "SELECT id, expires_at, consumed_at FROM youtube_oauth_states WHERE owner_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT " +
        boundedLimit(limit, 50),
      [ownerId, agentId],
    );
    let deleted = 0;
    for (const row of rows.rows) {
      const expired = new Date(row.expires_at).getTime() <= now.getTime();
      const spent = row.consumed_at !== null && row.consumed_at !== undefined;
      if (!expired && !spent) continue;
      const result = await this.db.query(
        "DELETE FROM youtube_oauth_states WHERE id = $1",
        [row.id],
      );
      deleted += result.rowCount === 1 ? 1 : 0;
    }
    return deleted;
  }

  /**
   * Latest states for a (owner, director) — used to report an honestly
   * pending authorization start without inventing a new status enum.
   */
  async listRecentStates(ownerId, agentId, { limit = 5 } = {}) {
    const rows = await this.db.query(
      "SELECT * FROM youtube_oauth_states WHERE owner_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT " +
        boundedLimit(limit, 5),
      [ownerId, agentId],
    );
    return rows.rows.map(stateRow);
  }

  /**
   * Upsert the single YouTube account for (owner, director). `tokenLocator`
   * MUST be locator-shaped; raw tokens are structurally rejected here and by
   * the sql/028 CHECK constraint (defense in depth, Rule 17).
   */
  async upsertAccount({
    ownerId,
    agentId,
    status = "connected",
    channelId,
    channelTitle,
    channelHandle,
    oauthScope,
    tokenLocator,
    tokenExpiresAt = null,
    verifiedAt = null,
  }) {
    if (!ACCOUNT_STATUSES.includes(status)) {
      throw fail("OAUTH_ACCOUNT_STATUS_INVALID");
    }
    if (!isLocatorShaped(tokenLocator)) {
      throw fail("SECRET_MANAGER_LOCATOR_INVALID");
    }
    if (status === "connected" && (!channelId || typeof channelId !== "string")) {
      // Rule 1: CONNECTED requires real verified identity evidence.
      throw fail("OAUTH_YOUTUBE_IDENTITY_REQUIRED");
    }
    const verified = verifiedAt instanceof Date ? verifiedAt : verifiedAt ? new Date(verifiedAt) : new Date();
    const tokenExpiry = tokenExpiresAt instanceof Date
      ? tokenExpiresAt
      : tokenExpiresAt
        ? new Date(tokenExpiresAt)
        : null;
    const result = await this.db.query(
      `INSERT INTO youtube_director_accounts
         (owner_id, agent_id, provider_key, status, channel_id, channel_title,
          channel_handle, oauth_scope, token_locator, token_expires_at,
          verified_at, connected_at, revoked_at, last_error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), NULL, NULL)
       ON CONFLICT (owner_id, agent_id, provider_key)
       DO UPDATE SET
         status = EXCLUDED.status,
         channel_id = EXCLUDED.channel_id,
         channel_title = EXCLUDED.channel_title,
         channel_handle = EXCLUDED.channel_handle,
         oauth_scope = EXCLUDED.oauth_scope,
         token_locator = EXCLUDED.token_locator,
         token_expires_at = EXCLUDED.token_expires_at,
         verified_at = EXCLUDED.verified_at,
         connected_at = now(),
         revoked_at = NULL,
         last_error_code = NULL,
         updated_at = now()
       RETURNING *`,
      [
        ownerId,
        agentId,
        OAUTH_PROVIDER_KEY,
        status,
        boundedText(channelId, 64),
        boundedText(channelTitle, 200),
        boundedText(channelHandle, 120),
        boundedText(oauthScope, 1000),
        tokenLocator,
        tokenExpiry,
        verified,
      ],
    );
    return accountDto(result.rows[0]);
  }

  /** One account. Cross-owner / cross-director → null (generic not-found). */
  async getAccount(ownerId, agentId) {
    const rows = await this.db.query(
      "SELECT * FROM youtube_director_accounts WHERE owner_id = $1 AND agent_id = $2",
      [ownerId, agentId],
    );
    return accountDto(rows.rows[0] ?? null);
  }

  /** Raw row (locator included) — server-side ONLY, never serialized. */
  async getAccountRow(ownerId, agentId) {
    const rows = await this.db.query(
      "SELECT * FROM youtube_director_accounts WHERE owner_id = $1 AND agent_id = $2",
      [ownerId, agentId],
    );
    return rows.rows[0] ?? null;
  }

  /**
   * Mark the account disconnected (owner-authorized revocation). The stale
   * locator is cleared: the secret is deleted from the secret manager.
   */
  async markDisconnected(ownerId, agentId, { errorCode = null } = {}) {
    const result = await this.db.query(
      `UPDATE youtube_director_accounts
       SET status = 'disconnected',
           token_locator = NULL,
           token_expires_at = NULL,
           revoked_at = now(),
           last_error_code = $3,
           updated_at = now()
       WHERE owner_id = $1 AND agent_id = $2`,
      [ownerId, agentId, boundedText(errorCode, 100)],
    );
    return result.rowCount === 1;
  }

  /** Record an honest error on a still-connected row (never fakes success). */
  async recordErrorCode(ownerId, agentId, errorCode) {
    const result = await this.db.query(
      `UPDATE youtube_director_accounts
       SET last_error_code = $3, updated_at = now()
       WHERE owner_id = $1 AND agent_id = $2`,
      [ownerId, agentId, boundedText(errorCode, 100)],
    );
    return result.rowCount === 1;
  }
}

function boundedText(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  return value.length === 0 ? null : value.slice(0, max);
}

function isLocatorShapedSafeString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
