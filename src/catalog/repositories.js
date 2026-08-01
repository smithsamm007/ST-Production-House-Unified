import { createHash, randomUUID } from "node:crypto";
import { createPostgresAdapter } from "../db/index.js";

// Canonical database adapter instance singleton
export const dbAdapter = createPostgresAdapter();

// Helper function to sort and normalize object fields for deterministic hashing
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

// ----------------------------------------------------
// Database Health Check Utility
// ----------------------------------------------------
export async function checkDatabaseHealth(adapter = dbAdapter) {
  try {
    const res = await adapter.query("SELECT 1 as ok;");
    if (res.rows && res.rows[0] && res.rows[0].ok === 1) {
      return { status: "healthy", latency: 0 };
    }
    return { status: "unhealthy", reason: "Invalid database response" };
  } catch (err) {
    return { status: "unavailable", error: err.message };
  }
}

// ----------------------------------------------------
// 1. Owner Repository
// ----------------------------------------------------
export class OwnerRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async findById(id) {
    const res = await this.dbAdapter.query("SELECT * FROM owners WHERE id = $1;", [id]);
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      status: row.status,
      role: row.role,
      mfaEnabled: row.mfa_enabled,
      failedLoginAttempts: row.failed_login_attempts,
      lockoutUntil: row.lockout_until ? new Date(row.lockout_until).toISOString() : null,
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      passwordChangedAt: new Date(row.password_changed_at).toISOString(),
      sessionRevocationEpoch: row.session_revocation_epoch,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async findByEmail(email) {
    if (!email) return null;
    const res = await this.dbAdapter.query("SELECT * FROM owners WHERE email = $1;", [email.toLowerCase().trim()]);
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      status: row.status,
      role: row.role,
      mfaEnabled: row.mfa_enabled,
      failedLoginAttempts: row.failed_login_attempts,
      lockoutUntil: row.lockout_until ? new Date(row.lockout_until).toISOString() : null,
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      passwordChangedAt: new Date(row.password_changed_at).toISOString(),
      sessionRevocationEpoch: row.session_revocation_epoch,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async create(owner) {
    const res = await this.dbAdapter.query(
      `INSERT INTO owners (id, email, password_hash, role, status, mfa_enabled, password_changed_at, session_revocation_epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;`,
      [
        owner.id || randomUUID(),
        owner.email.toLowerCase().trim(),
        owner.passwordHash,
        owner.role || "owner",
        owner.status || "anonymous",
        owner.mfaEnabled || false,
        owner.passwordChangedAt || new Date().toISOString(),
        owner.sessionRevocationEpoch || 1,
      ]
    );
    return res.rows[0];
  }

  async update(owner) {
    const res = await this.dbAdapter.query(
      `UPDATE owners
       SET email = $2, password_hash = $3, status = $4, role = $5, mfa_enabled = $6,
           failed_login_attempts = $7, lockout_until = $8, last_success_at = $9,
           password_changed_at = $10, session_revocation_epoch = $11, updated_at = now()
       WHERE id = $1 RETURNING *;`,
      [
        owner.id,
        owner.email,
        owner.passwordHash,
        owner.status,
        owner.role,
        owner.mfaEnabled,
        owner.failedLoginAttempts,
        owner.lockoutUntil,
        owner.lastSuccessAt,
        owner.passwordChangedAt,
        owner.sessionRevocationEpoch,
      ]
    );
    return res.rows[0];
  }
}

// ----------------------------------------------------
// 2. Session Repository
// ----------------------------------------------------
export class SessionRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async create(session) {
    const res = await this.dbAdapter.query(
      `INSERT INTO owner_sessions (id, owner_id, token_hash, created_at, last_seen_at, absolute_expires_at, idle_expires_at, mfa_assurance_level, session_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *;`,
      [
        session.id || randomUUID(),
        session.ownerId,
        session.tokenHash,
        session.createdAt || new Date().toISOString(),
        session.lastSeenAt || new Date().toISOString(),
        session.absoluteExpiresAt,
        session.idleExpiresAt,
        session.mfaAssuranceLevel,
        session.sessionVersion || 1,
      ]
    );
    return res.rows[0];
  }

  async findByTokenHash(tokenHash) {
    const res = await this.dbAdapter.query("SELECT * FROM owner_sessions WHERE token_hash = $1 AND revoked_at IS NULL;", [tokenHash]);
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      ownerId: row.owner_id,
      tokenHash: row.token_hash,
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      absoluteExpiresAt: new Date(row.absolute_expires_at).toISOString(),
      idleExpiresAt: new Date(row.idle_expires_at).toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      sessionVersion: row.session_version,
      mfaAssuranceLevel: row.mfa_assurance_level,
    };
  }

  async updateLastSeen(id, lastSeenAt, idleExpiresAt) {
    await this.dbAdapter.query(
      "UPDATE owner_sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1;",
      [id, lastSeenAt, idleExpiresAt]
    );
  }

  async revoke(id) {
    await this.dbAdapter.query("UPDATE owner_sessions SET revoked_at = now() WHERE id = $1;", [id]);
  }

  async revokeWithOwner(id, ownerId) {
    const res = await this.dbAdapter.query(
      "UPDATE owner_sessions SET revoked_at = now() WHERE id = $1 AND owner_id = $2 RETURNING *;",
      [id, ownerId]
    );
    return res.rows[0] || null;
  }

  async revokeAllForOwner(ownerId) {
    await this.dbAdapter.query("UPDATE owner_sessions SET revoked_at = now() WHERE owner_id = $1 AND revoked_at IS NULL;", [ownerId]);
  }

  async revokeAllOtherSessions(ownerId, keepSessionId) {
    await this.dbAdapter.query(
      "UPDATE owner_sessions SET revoked_at = now() WHERE owner_id = $1 AND id <> $2 AND revoked_at IS NULL;",
      [ownerId, keepSessionId]
    );
  }

  async listActive(ownerId) {
    const res = await this.dbAdapter.query(
      "SELECT * FROM owner_sessions WHERE owner_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now() AND idle_expires_at > now() ORDER BY created_at DESC;",
      [ownerId]
    );
    return res.rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      mfaAssuranceLevel: row.mfa_assurance_level,
    }));
  }
}

// ----------------------------------------------------
// 3. MFA & Secure Verification Repository
// ----------------------------------------------------
export class MfaRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async createTotpEnrollment(enrollment) {
    const res = await this.dbAdapter.query(
      `INSERT INTO owner_totp_enrollments (id, owner_id, encrypted_totp_secret, is_confirmed, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`,
      [
        enrollment.id || randomUUID(),
        enrollment.ownerId,
        enrollment.encryptedTotpSecret,
        enrollment.isConfirmed || false,
        enrollment.createdAt || new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
    return res.rows[0];
  }

  async findTotpEnrollment(id) {
    const res = await this.dbAdapter.query("SELECT * FROM owner_totp_enrollments WHERE id = $1;", [id]);
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      ownerId: row.owner_id,
      encryptedTotpSecret: row.encrypted_totp_secret,
      isConfirmed: row.is_confirmed,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async findConfirmedTotpEnrollment(ownerId) {
    const res = await this.dbAdapter.query("SELECT * FROM owner_totp_enrollments WHERE owner_id = $1 AND is_confirmed = true;", [ownerId]);
    if (!res.rows[0]) return null;
    return res.rows[0];
  }

  async confirmTotpEnrollment(id, ownerId) {
    await this.dbAdapter.withTransaction(async (client) => {
      await client.query("UPDATE owner_totp_enrollments SET is_confirmed = true, updated_at = now() WHERE id = $1 AND owner_id = $2;", [id, ownerId]);
      await client.query("UPDATE owners SET mfa_enabled = true, status = 'authenticated', updated_at = now() WHERE id = $1;", [ownerId]);
    });
  }

  async saveRecoveryCodes(codes) {
    for (const code of codes) {
      await this.dbAdapter.query(
        `INSERT INTO owner_recovery_codes (id, owner_id, code_hash, is_used, created_at)
         VALUES ($1, $2, $3, $4, $5);`,
        [code.id || randomUUID(), code.ownerId, code.codeHash, code.isUsed || false, code.createdAt || new Date().toISOString()]
      );
    }
  }

  async verifyAndUseRecoveryCode(ownerId, codeHash) {
    const res = await this.dbAdapter.query(
      `UPDATE owner_recovery_codes
       SET is_used = true, used_at = now()
       WHERE id = (
         SELECT id FROM owner_recovery_codes
         WHERE owner_id = $1 AND code_hash = $2 AND is_used = false
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id;`,
      [ownerId, codeHash]
    );
    return res.rows.length > 0;
  }

  async recordUsedTotpCode(ownerId, totpCode, timeStep) {
    await this.dbAdapter.query(
      "INSERT INTO used_totp_codes (owner_id, totp_code, time_step) VALUES ($1, $2, $3);",
      [ownerId, totpCode, timeStep]
    );
  }

  async savePasskeyCredential(id, ownerId, credentialId, publicKey, signCounter) {
    await this.dbAdapter.query(
      `INSERT INTO owner_passkey_credentials (id, owner_id, credential_id, public_key, sign_counter)
       VALUES ($1, $2, $3, $4, $5);`,
      [id || randomUUID(), ownerId, credentialId, publicKey, signCounter || 0]
    );
  }

  async findPasskeyCredential(credentialId) {
    const res = await this.dbAdapter.query("SELECT * FROM owner_passkey_credentials WHERE credential_id = $1;", [credentialId]);
    return res.rows[0] || null;
  }

  async createChallenge(challengeToken, expiresAt) {
    await this.dbAdapter.query(
      "INSERT INTO authentication_challenges (challenge_token, expires_at) VALUES ($1, $2);",
      [challengeToken, expiresAt]
    );
  }

  async findChallenge(challengeToken) {
    const res = await this.dbAdapter.query("SELECT * FROM authentication_challenges WHERE challenge_token = $1;", [challengeToken]);
    return res.rows[0] || null;
  }

  async useChallenge(challengeToken) {
    await this.dbAdapter.query("UPDATE authentication_challenges SET is_used = true WHERE challenge_token = $1;", [challengeToken]);
  }
}

// ----------------------------------------------------
// 4. CSRF Repository
// ----------------------------------------------------
export class CsrfRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async createToken(sessionId, tokenValue) {
    await this.dbAdapter.query(
      "INSERT INTO csrf_session_tokens (session_id, token_value) VALUES ($1, $2);",
      [sessionId, tokenValue]
    );
  }

  async verifyToken(sessionId, tokenValue) {
    const res = await this.dbAdapter.query(
      "SELECT 1 FROM csrf_session_tokens WHERE session_id = $1 AND token_value = $2 AND created_at >= now() - interval '30 minutes';",
      [sessionId, tokenValue]
    );
    return res.rows.length > 0;
  }
}

// ----------------------------------------------------
// 5. Security & Audit Repository
// ----------------------------------------------------
export class AuditRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async recordEvent(ownerId, eventType, payload) {
    const cleanPayload = typeof payload === "object" ? JSON.stringify(payload) : payload;
    const res = await this.dbAdapter.query(
      `INSERT INTO authentication_audit_events (id, owner_id, event_type, payload)
       VALUES ($1, $2, $3, $4) RETURNING *;`,
      [randomUUID(), ownerId, eventType, cleanPayload]
    );
    return res.rows[0];
  }

  async listEvents(ownerId = null) {
    const query = ownerId
      ? ["SELECT * FROM authentication_audit_events WHERE owner_id = $1 ORDER BY occurred_at DESC;", [ownerId]]
      : ["SELECT * FROM authentication_audit_events ORDER BY occurred_at DESC;", []];
    const res = await this.dbAdapter.query(query[0], query[1]);
    return res.rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      eventType: row.event_type,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      occurredAt: new Date(row.occurred_at).toISOString(),
    }));
  }
}

// ----------------------------------------------------
// 6. Agent Repository (Preserves 50-Agent Hard Limit)
// ----------------------------------------------------
export class AgentRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async list() {
    const res = await this.dbAdapter.query("SELECT * FROM agents ORDER BY id ASC;");
    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      namespace: row.namespace,
      enabled: row.enabled,
    }));
  }

  async get(id) {
    const res = await this.dbAdapter.query("SELECT * FROM agents WHERE id = $1;", [id]);
    if (!res.rows[0]) return null;
    return {
      id: res.rows[0].id,
      name: res.rows[0].name,
      namespace: res.rows[0].namespace,
      enabled: res.rows[0].enabled,
    };
  }

  async add(agent) {
    // Check 50-agent limit
    const countRes = await this.dbAdapter.query("SELECT count(*) FROM agents;");
    const count = parseInt(countRes.rows[0].count, 10);
    if (count >= 50) {
      throw new Error("AGENT_CAP_REACHED");
    }

    try {
      const res = await this.dbAdapter.query(
        "INSERT INTO agents (id, name, namespace, enabled) VALUES ($1, $2, $3, $4) RETURNING *;",
        [agent.id, agent.name, agent.namespace, agent.enabled !== false]
      );
      return res.rows[0];
    } catch (err) {
      if (err.message.includes("AGENT_CAP_REACHED")) {
        throw new Error("AGENT_CAP_REACHED");
      }
      if (err.message.includes("unique")) {
        throw new Error("DUPLICATE_AGENT_IDENTITY");
      }
      throw err;
    }
  }
}

// ----------------------------------------------------
// 7. Job Repository
// ----------------------------------------------------
export class JobRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async create(job, ownerId = null) {
    const res = await this.dbAdapter.query(
      `INSERT INTO jobs (id, agent_id, capability, idempotency_key, status, priority, attempts, max_attempts, payload, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *;`,
      [
        job.id || randomUUID(),
        job.agentId,
        job.capability,
        job.idempotency_key,
        job.status || "queued",
        job.priority || 100,
        job.attempts || 0,
        job.max_attempts || 3,
        JSON.stringify(job.payload),
        ownerId,
      ]
    );
    return res.rows[0];
  }

  async get(id, ownerId = null) {
    const query = ownerId
      ? ["SELECT * FROM jobs WHERE id = $1 AND owner_id = $2;", [id, ownerId]]
      : ["SELECT * FROM jobs WHERE id = $1;", [id]];
    const res = await this.dbAdapter.query(query[0], query[1]);
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      agentId: row.agent_id,
      capability: row.capability,
      idempotency_key: row.idempotency_key,
      status: row.status,
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      payload: row.payload,
    };
  }

  async claimLease(agentId, capability, leaseOwner, leaseExpiresAt) {
    // Acquire a lease on a claimable job
    const res = await this.dbAdapter.query(
      `UPDATE jobs
       SET status = 'leased', lease_owner = $3, lease_expires_at = $4, attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status IN ('queued', 'leased')
           AND agent_id = $1
           AND capability = $2
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY priority ASC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       ) RETURNING *;`,
      [agentId, capability, leaseOwner, leaseExpiresAt]
    );
    return res.rows[0] || null;
  }

  async updateStatus(id, status, attempts = null) {
    if (attempts !== null) {
      await this.dbAdapter.query(
        "UPDATE jobs SET status = $2, attempts = $3, updated_at = now() WHERE id = $1;",
        [id, status, attempts]
      );
    } else {
      await this.dbAdapter.query(
        "UPDATE jobs SET status = $2, updated_at = now() WHERE id = $1;",
        [id, status]
      );
    }
  }
}

// ----------------------------------------------------
// 8. Provider Attempt Repository
// ----------------------------------------------------
export class ProviderAttemptRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async record(attempt) {
    const res = await this.dbAdapter.query(
      `INSERT INTO provider_attempts (id, job_id, agent_id, slot, provider, outcome, provider_response_id, error_code, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *;`,
      [
        attempt.id || randomUUID(),
        attempt.jobId,
        attempt.agentId,
        attempt.slot,
        attempt.provider,
        attempt.outcome,
        attempt.providerResponseId || null,
        attempt.errorCode || null,
        attempt.startedAt || new Date().toISOString(),
        attempt.finishedAt || new Date().toISOString(),
      ]
    );
    return res.rows[0];
  }
}

// ----------------------------------------------------
// 9. Campaign & Promotion Repository
// ----------------------------------------------------
export class PromotionRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async findOrCreateProductIdentity(canonicalIdentity, sha256) {
    return await this.dbAdapter.withTransaction(async (client) => {
      const existing = await client.query("SELECT * FROM product_identities WHERE identity_sha256 = $1;", [sha256]);
      if (existing.rows[0]) {
        return existing.rows[0];
      }
      const inserted = await client.query(
        "INSERT INTO product_identities (id, canonical_identity, identity_sha256) VALUES ($1, $2, $3) RETURNING *;",
        [randomUUID(), canonicalIdentity, sha256]
      );
      return inserted.rows[0];
    });
  }

  async createCampaign(campaign) {
    const res = await this.dbAdapter.query(
      `INSERT INTO promo_campaigns (id, product_identity_id, owner_agent_id, duplicate_authorized_by, include_in_main_video, target_episode_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;`,
      [
        campaign.id || randomUUID(),
        campaign.productIdentityId,
        campaign.ownerAgentId,
        campaign.duplicateAuthorizedBy || null,
        campaign.includeInMainVideo,
        campaign.targetEpisodeId || null,
        campaign.status || "draft",
      ]
    );
    return res.rows[0];
  }

  async hasCampaignForProduct(productIdentityId) {
    const res = await this.dbAdapter.query("SELECT 1 FROM promo_campaigns WHERE product_identity_id = $1;", [productIdentityId]);
    return res.rows.length > 0;
  }

  async reserveReel(reel) {
    try {
      const res = await this.dbAdapter.query(
        `INSERT INTO promo_reels (id, product_identity_id, campaign_id, owner_agent_id, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
        [
          reel.id || randomUUID(),
          reel.productIdentityId,
          reel.campaignId,
          reel.ownerAgentId,
          reel.status || "reserved",
        ]
      );
      return res.rows[0];
    } catch (err) {
      if (err.message.includes("unique")) {
        throw new Error("REEL_RESERVATION_DUPLICATE");
      }
      throw err;
    }
  }

  async getReelByProduct(productIdentityId) {
    const res = await this.dbAdapter.query("SELECT * FROM promo_reels WHERE product_identity_id = $1;", [productIdentityId]);
    return res.rows[0] || null;
  }
}

// ----------------------------------------------------
// 10. Publishing Request/Receipt Repository
// ----------------------------------------------------
export class PublishingRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async createRequest(req, ownerId = null) {
    const res = await this.dbAdapter.query(
      `INSERT INTO publishing_requests (id, artifact_id, destination, caption_snapshot, mode, status, approved_by, approval_expires_at, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *;`,
      [
        req.id || randomUUID(),
        req.artifactId,
        req.destination,
        req.captionSnapshot,
        req.mode || "draft",
        req.status || "pending",
        req.approvedBy || null,
        req.approvalExpiresAt || null,
        ownerId,
      ]
    );
    return res.rows[0];
  }

  async approveRequest(requestId, ownerId, expiresAt) {
    const res = await this.dbAdapter.query(
      "UPDATE publishing_requests SET status = 'approved', approved_by = $2, approval_expires_at = $3 WHERE id = $1 AND owner_id = $2 RETURNING *;",
      [requestId, ownerId, expiresAt]
    );
    return res.rows[0];
  }

  async findRequest(requestId, ownerId = null) {
    const query = ownerId
      ? ["SELECT * FROM publishing_requests WHERE id = $1 AND owner_id = $2;", [requestId, ownerId]]
      : ["SELECT * FROM publishing_requests WHERE id = $1;", [requestId]];
    const res = await this.dbAdapter.query(query[0], query[1]);
    return res.rows[0] || null;
  }

  async createReceipt(receipt, ownerId = null) {
    const res = await this.dbAdapter.query(
      `INSERT INTO publishing_receipts (id, publishing_request_id, platform_post_id, platform_url, provider_response_sha256, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`,
      [
        receipt.id || randomUUID(),
        receipt.publishingRequestId,
        receipt.platformPostId,
        receipt.platformUrl,
        receipt.providerResponseSha256,
        ownerId,
      ]
    );
    return res.rows[0];
  }
}

// ----------------------------------------------------
// 11. Evidence Ledger Repository (Append-Only Hash Chain)
// ----------------------------------------------------
export class EvidenceLedgerRepository {
  constructor(adapter = dbAdapter) {
    this.dbAdapter = adapter;
  }

  async append(event) {
    if (!event?.subjectId || !event?.kind || !event?.classification) {
      throw new Error("INCOMPLETE_EVIDENCE_EVENT");
    }
    if (event.kind === "platform_publish" &&
        (!event.payload?.platformPostId ||
         !event.payload?.platformUrl ||
         !event.payload?.providerResponseSha256)) {
      throw new Error("VERIFIABLE_PLATFORM_RECEIPT_REQUIRED");
    }
    if (event.kind === "media_verification" &&
        (!event.payload?.artifactSha256 ||
         event.payload?.ffprobeVerified !== true)) {
      throw new Error("FFPROBE_VERIFICATION_EVIDENCE_REQUIRED");
    }

    return await this.dbAdapter.withTransaction(async (client) => {
      // Find previous event to establish chain integrity
      const prevRes = await client.query(
        "SELECT event_hash FROM evidence_events ORDER BY occurred_at DESC, id DESC LIMIT 1;"
      );
      const previousHash = prevRes.rows[0] ? prevRes.rows[0].event_hash : null;

      const recordId = randomUUID();
      const occurredAt = new Date().toISOString();

      const payload = event.payload || {};

      const record = {
        id: recordId,
        occurredAt,
        previousHash,
        subjectId: event.subjectId,
        kind: event.kind,
        classification: event.classification,
        payload,
      };

      const eventHash = createHash("sha256")
        .update(JSON.stringify(stable(record)))
        .digest("hex");

      const res = await client.query(
        `INSERT INTO evidence_events (id, subject_id, kind, classification, payload, previous_hash, event_hash, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;`,
        [
          recordId,
          event.subjectId,
          event.kind,
          event.classification,
          JSON.stringify(payload),
          previousHash,
          eventHash,
          occurredAt,
        ]
      );

      const saved = res.rows[0];
      return Object.freeze({
        id: saved.id,
        subjectId: saved.subject_id,
        kind: saved.kind,
        classification: saved.classification,
        payload: Object.freeze({ ...payload }),
        previousHash: saved.previous_hash,
        eventHash: saved.event_hash,
        occurredAt: new Date(saved.occurred_at).toISOString(),
      });
    });
  }

  async list() {
    const res = await this.dbAdapter.query("SELECT * FROM evidence_events ORDER BY occurred_at ASC, id ASC;");
    return res.rows.map((row) => {
      const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      return Object.freeze({
        id: row.id,
        subjectId: row.subject_id,
        kind: row.kind,
        classification: row.classification,
        payload: Object.freeze(payload || {}),
        previousHash: row.previous_hash,
        eventHash: row.event_hash,
        occurredAt: new Date(row.occurred_at).toISOString(),
      });
    });
  }
}
