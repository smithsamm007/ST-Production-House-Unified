// Phase 2: Argon2id Password Hashing with Configurable Strength
// Implements secure password storage using Argon2id algorithm.

import argon2 from "argon2";

export class PasswordHasher {
  constructor({
    timeCost = 3,
    memoryCost = 65536,
    parallelism = 4,
    type = argon2.argon2id
  } = {}) {
    if (timeCost < 1 || timeCost > 10)
      throw new Error("timeCost must be between 1 and 10");
    if (memoryCost < 8 || memoryCost > 1048576)
      throw new Error("memoryCost must be between 8 and 1048576");
    if (parallelism < 1 || parallelism > 16)
      throw new Error("parallelism must be between 1 and 16");

    this.timeCost = timeCost;
    this.memoryCost = memoryCost;
    this.parallelism = parallelism;
    this.type = type;
  }

  async hash(password) {
    if (!password || typeof password !== "string") {
      throw new Error("password must be a non-empty string");
    }
    if (password.length < 8 || password.length > 256) {
      throw new Error("password must be 8-256 characters");
    }

    try {
      return await argon2.hash(password, {
        timeCost: this.timeCost,
        memoryCost: this.memoryCost,
        parallelism: this.parallelism,
        type: this.type
      });
    } catch (err) {
      throw new Error(`Password hashing failed: ${err.message}`);
    }
  }

  async verify(password, hash) {
    if (!password || typeof password !== "string") {
      throw new Error("password must be a non-empty string");
    }
    if (!hash || typeof hash !== "string") {
      throw new Error("hash must be a non-empty string");
    }

    try {
      return await argon2.verify(hash, password);
    } catch (err) {
      throw new Error(`Password verification failed: ${err.message}`);
    }
  }
}

export class SessionManager {
  constructor({ adapter, sessionTimeoutMs = 3600000 } = {}) {
    if (!adapter) throw new Error("SessionManager requires adapter");
    if (typeof adapter.getConnection !== "function")
      throw new Error("adapter must have getConnection method");
    this.adapter = adapter;
    this.sessionTimeoutMs = sessionTimeoutMs;
  }

  _generateSessionToken() {
    // Cryptographically random 32-byte token (256-bit)
    return require("crypto").randomBytes(32).toString("hex");
  }

  _generateCsrfToken() {
    // CSRF token for double-submit cookie pattern
    return require("crypto").randomBytes(16).toString("hex");
  }

  async createSession({ ownerId, ipAddress, userAgent }) {
    if (!ownerId || !ipAddress || !userAgent) {
      throw new Error("createSession requires ownerId, ipAddress, userAgent");
    }

    const sessionToken = this._generateSessionToken();
    const sessionTokenHash = require("crypto")
      .createHash("sha256")
      .update(sessionToken)
      .digest("hex");
    const csrfToken = this._generateCsrfToken();

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        INSERT INTO owner_sessions (
          owner_id, session_token_hash, csrf_token, ip_address, user_agent,
          expires_at, created_at
        )
        VALUES ($1, $2, $3, $4, $5, now() + $6::interval, now())
        RETURNING id, owner_id, csrf_token, expires_at
        `,
        [
          ownerId,
          sessionTokenHash,
          csrfToken,
          ipAddress,
          userAgent,
          `${Math.round(this.sessionTimeoutMs / 1000)} seconds`
        ]
      );
      return {
        sessionId: result.rows[0].id,
        sessionToken,
        csrfToken: result.rows[0].csrf_token,
        expiresAt: result.rows[0].expires_at
      };
    } finally {
      await conn.release();
    }
  }

  async getSession({ sessionToken }) {
    if (!sessionToken) throw new Error("getSession requires sessionToken");

    const sessionTokenHash = require("crypto")
      .createHash("sha256")
      .update(sessionToken)
      .digest("hex");

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT id, owner_id, csrf_token, expires_at, ip_address
        FROM owner_sessions
        WHERE session_token_hash = $1 AND expires_at > now()
        `,
        [sessionTokenHash]
      );
      return result.rows[0] || null;
    } finally {
      await conn.release();
    }
  }

  async rotateSession({ sessionToken, newIpAddress, newUserAgent }) {
    if (!sessionToken) throw new Error("rotateSession requires sessionToken");

    const oldSession = await this.getSession({ sessionToken });
    if (!oldSession) return null;

    // Create new session
    const newSession = await this.createSession({
      ownerId: oldSession.owner_id,
      ipAddress: newIpAddress || oldSession.ip_address,
      userAgent: newUserAgent || oldSession.user_agent
    });

    // Revoke old session
    const conn = await this.adapter.getConnection();
    try {
      await conn.query(
        `
        UPDATE owner_sessions SET revoked_at = now()
        WHERE id = $1
        `,
        [oldSession.id]
      );
    } finally {
      await conn.release();
    }

    return newSession;
  }

  async revokeSession({ sessionToken }) {
    if (!sessionToken) throw new Error("revokeSession requires sessionToken");

    const session = await this.getSession({ sessionToken });
    if (!session) return false;

    const conn = await this.adapter.getConnection();
    try {
      await conn.query(
        `
        UPDATE owner_sessions SET revoked_at = now()
        WHERE id = $1
        `,
        [session.id]
      );
      return true;
    } finally {
      await conn.release();
    }
  }

  async validateCsrfToken({ sessionToken, csrfToken }) {
    if (!sessionToken || !csrfToken) {
      throw new Error("validateCsrfToken requires sessionToken and csrfToken");
    }

    const session = await this.getSession({ sessionToken });
    if (!session) return false;

    // Double-submit cookie pattern validation
    return session.csrf_token === csrfToken;
  }

  async revokeAllSessionsForOwner({ ownerId }) {
    if (!ownerId) throw new Error("revokeAllSessionsForOwner requires ownerId");

    const conn = await this.adapter.getConnection();
    try {
      await conn.query(
        `
        UPDATE owner_sessions SET revoked_at = now()
        WHERE owner_id = $1 AND revoked_at IS NULL
        `,
        [ownerId]
      );
    } finally {
      await conn.release();
    }
  }

  async getActiveSessions({ ownerId, limit = 10 }) {
    if (!ownerId) throw new Error("getActiveSessions requires ownerId");

    const conn = await this.adapter.getConnection();
    try {
      const result = await conn.query(
        `
        SELECT id, ip_address, user_agent, created_at, expires_at
        FROM owner_sessions
        WHERE owner_id = $1 AND expires_at > now() AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2
        `,
        [ownerId, limit]
      );
      return result.rows;
    } finally {
      await conn.release();
    }
  }
}

export class CsrfProtection {
  static validateToken({ providedToken, sessionCsrfToken }) {
    if (!providedToken || !sessionCsrfToken) {
      throw new Error("CSRF validation requires both tokens");
    }
    // Constant-time comparison to prevent timing attacks
    if (providedToken.length !== sessionCsrfToken.length) {
      return false;
    }
    let result = 0;
    for (let i = 0; i < providedToken.length; i++) {
      result |= providedToken.charCodeAt(i) ^ sessionCsrfToken.charCodeAt(i);
    }
    return result === 0;
  }

  static extractToken({ body, headers }) {
    // Check X-CSRF-Token header first (preferred for API)
    if (headers["x-csrf-token"]) {
      return headers["x-csrf-token"];
    }
    // Fall back to form body
    if (body && body._csrf) {
      return body._csrf;
    }
    return null;
  }
}
