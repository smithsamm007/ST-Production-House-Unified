import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import crypto from "node:crypto";
import argon2 from "argon2";
import { deepFreeze, deepCopy, sanitizeSecrets } from "./creativeReferenceLibrary.js";
import {
  OwnerRepository,
  SessionRepository,
  MfaRepository,
  CsrfRepository,
  AuditRepository
} from "./repositories.js";

// Cryptographic helpers (pure functions)
export function normalizeEmail(email) {
  if (!email) return "";
  return email.normalize("NFKC").trim().toLowerCase();
}

export function validatePasswordStrength(password) {
  if (!password || password.length < 12) {
    throw new Error("PASSWORD_TOO_SHORT_MUST_BE_AT_LEAST_12_CHARACTERS");
  }
  if (password.length > 128) {
    throw new Error("PASSWORD_EXCEEDS_MAX_LENGTH");
  }
  const prohibited = ["password12345", "stproductionhouse", "examplepassword", "admin12345678"];
  if (prohibited.includes(password.toLowerCase())) {
    throw new Error("PASSWORD_IS_COMMON_OR_COMPROMISED");
  }
  return true;
}

export async function hashPassword(password) {
  validatePasswordStrength(password);
  return await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
}

export async function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  try {
    return await argon2.verify(storedHash, password);
  } catch (err) {
    return false;
  }
}

// AES-256-GCM encryption helpers (pure functions)
const KEY_VERSION = "v1";

function getEncryptionKey() {
  const keyHex = process.env.MFA_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error("MFA_ENCRYPTION_KEY_NOT_CONFIGURED");
  }
  if (keyHex.length !== 64) {
    throw new Error("INVALID_MFA_ENCRYPTION_KEY_LENGTH_MUST_BE_64_HEX");
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptMfaSecret(plaintext) {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");
  return `${KEY_VERSION}:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptMfaSecret(cipherTextWithMetadata) {
  if (!cipherTextWithMetadata || !cipherTextWithMetadata.includes(":")) {
    throw new Error("INVALID_ENCRYPTED_MFA_SECRET_FORMAT");
  }

  const [version, ivHex, authTagHex, encryptedHex] = cipherTextWithMetadata.split(":");
  if (version !== "v1") {
    throw new Error("UNSUPPORTED_MFA_ENCRYPTION_KEY_VERSION");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// RFC 6238 TOTP Engine (pure functions)
export function generateTotp(secretHex, timeOffsetSteps = 0) {
  const key = Buffer.from(secretHex, "hex");
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30) + timeOffsetSteps;

  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", key);
  hmac.update(buf);
  const hmacResult = hmac.digest();

  const offset = hmacResult[hmacResult.length - 1] & 0xf;
  const code =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);

  const totp = code % 1000000;
  return String(totp).padStart(6, "0");
}

export function verifyTotp(secretHex, code, allowedWindowSteps = 1) {
  if (!code || typeof code !== "string" || code.length !== 6) {
    return false;
  }
  for (let i = -allowedWindowSteps; i <= allowedWindowSteps; i++) {
    if (generateTotp(secretHex, i) === code) {
      return true;
    }
  }
  return false;
}

export function computeTokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function randomUUID() {
  return randomBytes(16).toString("hex");
}

// Service class holding dependency-injected repositories
export class OwnerAuthenticationService {
  constructor(repos = {}) {
    this.ownersRepo = repos.ownersRepo || new OwnerRepository();
    this.sessionsRepo = repos.sessionsRepo || new SessionRepository();
    this.mfaRepo = repos.mfaRepo || new MfaRepository();
    this.csrfRepo = repos.csrfRepo || new CsrfRepository();
    this.auditRepo = repos.auditRepo || new AuditRepository();
  }

  async registerOwner(email, password, callerSessionToken = null) {
    const normEmail = normalizeEmail(email);
    if (!normEmail) throw new Error("EMAIL_REQUIRED");

    validatePasswordStrength(password);

    return await this.ownersRepo.dbAdapter.withTransaction(async (client) => {
      // Enforce transactional exclusivity for first owner bootstrap
      try {
        await client.query("LOCK TABLE owners IN EXCLUSIVE MODE;");
      } catch (err) {
        // Fallback for in-memory or query translation testing environments
        await client.query("SELECT pg_advisory_xact_lock(998877);");
      }

      // Duplicate check must always take precedence over bootstrap counts (Blocker #12)
      const dupRes = await client.query("SELECT id FROM owners WHERE email = $1;", [normEmail]);
      if (dupRes.rows.length > 0) {
        throw new Error("DUPLICATE_OWNER_EMAIL_REJECTED");
      }

      // Count existing owners
      const countRes = await client.query("SELECT COUNT(*) FROM owners;");
      const existingCount = parseInt(countRes.rows[0].count, 10);

      if (existingCount > 0) {
        if (!callerSessionToken || typeof callerSessionToken !== "string") {
          throw new Error("PUBLIC_REGISTRATION_PROHIBITED_ONCE_BOOTSTRAPPED");
        }

        // Validate the registering user's session
        const hash = computeTokenHash(callerSessionToken);
        const sessionRes = await client.query("SELECT * FROM owner_sessions WHERE token_hash = $1;", [hash]);
        const session = sessionRes.rows[0];
        if (!session || session.revoked_at || new Date(session.absolute_expires_at) < new Date() || new Date(session.idle_expires_at) < new Date()) {
          throw new Error("UNAUTHORIZED");
        }

        const callerRes = await client.query("SELECT role FROM owners WHERE id = $1;", [session.owner_id]);
        if (!callerRes.rows[0] || callerRes.rows[0].role !== "owner") {
          throw new Error("INSUFFICIENT_PRIVILEGES");
        }
      }

      const pwdHash = await hashPassword(password);

      const owner = {
        id: randomUUID(),
        email: normEmail,
        passwordHash: pwdHash,
        status: "anonymous",
        role: "owner", // Server-side hardcoded role only, client-selected roles are NEVER accepted
        mfaEnabled: false,
        failedLoginAttempts: 0,
        lockoutUntil: null,
        lastSuccessAt: null,
        passwordChangedAt: new Date().toISOString(),
        sessionRevocationEpoch: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await client.query(
        `INSERT INTO owners (id, email, password_hash, role, status, mfa_enabled, failed_login_attempts, lockout_until, password_changed_at, session_revocation_epoch, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
        [
          owner.id,
          owner.email,
          owner.passwordHash,
          owner.role,
          owner.status,
          owner.mfaEnabled,
          owner.failedLoginAttempts,
          owner.lockoutUntil,
          owner.passwordChangedAt,
          owner.sessionRevocationEpoch,
          owner.createdAt,
          owner.updatedAt
        ]
      );

      return deepCopy(owner);
    });
  }

  async loginOwner(email, password, preAuthSessionToken = null) {
    const normEmail = normalizeEmail(email);
    const dummyHash = "$argon2id$v=19$m=65536,p=4,t=3$dJjhGG82mqpeg5YghmrRVw$neSWfmTe2m/FvlazTaLzJ60Z/zM9kKsJoyXNutKIYq0";

    return await this.ownersRepo.dbAdapter.withTransaction(async (client) => {
      // 1. Locked owner lookup
      const res = await client.query("SELECT * FROM owners WHERE email = $1 FOR UPDATE;", [normEmail]);
      const matchedOwnerRow = res.rows[0];

      let matchedOwner = null;
      if (matchedOwnerRow) {
        matchedOwner = {
          id: matchedOwnerRow.id,
          email: matchedOwnerRow.email,
          passwordHash: matchedOwnerRow.password_hash,
          status: matchedOwnerRow.status,
          role: matchedOwnerRow.role,
          mfaEnabled: matchedOwnerRow.mfa_enabled,
          failedLoginAttempts: matchedOwnerRow.failed_login_attempts,
          lockoutUntil: matchedOwnerRow.lockout_until ? new Date(matchedOwnerRow.lockout_until).toISOString() : null,
          lastSuccessAt: matchedOwnerRow.last_success_at ? new Date(matchedOwnerRow.last_success_at).toISOString() : null,
          passwordChangedAt: new Date(matchedOwnerRow.password_changed_at).toISOString(),
          sessionRevocationEpoch: matchedOwnerRow.session_revocation_epoch,
          createdAt: new Date(matchedOwnerRow.created_at).toISOString(),
        };
      }

      const hashToVerify = matchedOwner ? matchedOwner.passwordHash : dummyHash;

      // Always execute a genuine Argon2 verification to prevent timing leaks (Blocker #5/8)
      const isVerified = await verifyPassword(password, hashToVerify);

      if (!matchedOwner) {
        const auditId = randomUUID();
        await client.query(
          "INSERT INTO authentication_audit_events (id, owner_id, event_type, payload) VALUES ($1, null, $2, $3);",
          [auditId, "login_failed", JSON.stringify({ attemptedEmail: normEmail })]
        );
        throw new Error("INVALID_EMAIL_OR_PASSWORD");
      }

      // Concurrency-safe lockout check
      if (matchedOwner.lockoutUntil) {
        if (new Date(matchedOwner.lockoutUntil) > new Date()) {
          const auditId = randomUUID();
          await client.query(
            "INSERT INTO authentication_audit_events (id, owner_id, event_type, payload) VALUES ($1, $2, $3, $4);",
            [auditId, matchedOwner.id, "account_locked", JSON.stringify({ reason: "lockout_active" })]
          );
          throw new Error("ACCOUNT_TEMPORARILY_LOCKED");
        } else {
          matchedOwner.lockoutUntil = null;
          matchedOwner.failedLoginAttempts = 0;
          await client.query(
            "UPDATE owners SET failed_login_attempts = 0, lockout_until = null, updated_at = now() WHERE id = $1;",
            [matchedOwner.id]
          );
        }
      }

      if (!isVerified) {
        matchedOwner.failedLoginAttempts += 1;
        let lockoutUntil = null;
        if (matchedOwner.failedLoginAttempts >= 5) {
          lockoutUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        }

        await client.query(
          "UPDATE owners SET failed_login_attempts = $2, lockout_until = $3, updated_at = now() WHERE id = $1;",
          [matchedOwner.id, matchedOwner.failedLoginAttempts, lockoutUntil]
        );

        const auditId = randomUUID();
        await client.query(
          "INSERT INTO authentication_audit_events (id, owner_id, event_type, payload) VALUES ($1, $2, $3, $4);",
          [auditId, matchedOwner.id, "login_failed", JSON.stringify({})]
        );

        if (lockoutUntil) {
          const auditId2 = randomUUID();
          await client.query(
            "INSERT INTO authentication_audit_events (id, owner_id, event_type, payload) VALUES ($1, $2, $3, $4);",
            [auditId2, matchedOwner.id, "account_locked", JSON.stringify({ reason: "consecutive_failures" })]
          );
        }
        throw new Error("INVALID_EMAIL_OR_PASSWORD");
      }

      // Success: Reset failure counters atomically inside transaction (Blocker #4)
      matchedOwner.failedLoginAttempts = 0;
      matchedOwner.lastSuccessAt = new Date().toISOString();
      matchedOwner.status = matchedOwner.mfaEnabled ? "password_verified_mfa_pending" : "authenticated";

      await client.query(
        `UPDATE owners
         SET failed_login_attempts = 0, last_success_at = $2, status = $3, lockout_until = null, updated_at = now()
         WHERE id = $1;`,
        [matchedOwner.id, matchedOwner.lastSuccessAt, matchedOwner.status]
      );

      const auditId = randomUUID();
      await client.query(
        "INSERT INTO authentication_audit_events (id, owner_id, event_type, payload) VALUES ($1, $2, $3, $4);",
        [auditId, matchedOwner.id, "login_succeeded", JSON.stringify({})]
      );

      // Rotate the specific pre-authentication session if one was passed for rotation (session fixation prevention)
      if (preAuthSessionToken) {
        const oldHash = computeTokenHash(preAuthSessionToken);
        const oldSessionRes = await client.query(
          "SELECT id FROM owner_sessions WHERE token_hash = $1 AND owner_id = $2 FOR UPDATE;",
          [oldHash, matchedOwner.id]
        );
        const oldSession = oldSessionRes.rows[0];
        if (oldSession) {
          await client.query(
            "UPDATE owner_sessions SET revoked_at = now() WHERE id = $1;",
            [oldSession.id]
          );
          await client.query(
            "DELETE FROM csrf_session_tokens WHERE session_id = $1;",
            [oldSession.id]
          );
        }
      }

      // Create new session token inside transaction
      const mfaAssurance = matchedOwner.mfaEnabled ? "password_only" : "high_assurance";
      const token = randomBytes(32).toString("hex");
      const tokenHash = computeTokenHash(token);

      const session = {
        id: randomUUID(),
        ownerId: matchedOwner.id,
        tokenHash,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        revokedAt: null,
        sessionVersion: 1,
        mfaAssuranceLevel: mfaAssurance
      };

      await client.query(
        `INSERT INTO owner_sessions (id, owner_id, token_hash, created_at, last_seen_at, absolute_expires_at, idle_expires_at, revoked_at, session_version, mfa_assurance_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          session.id,
          session.ownerId,
          session.tokenHash,
          session.createdAt,
          session.lastSeenAt,
          session.absoluteExpiresAt,
          session.idleExpiresAt,
          session.revokedAt,
          session.sessionVersion,
          session.mfaAssuranceLevel
        ]
      );

      const auditId2 = randomUUID();
      await client.query(
        "INSERT INTO authentication_audit_events (id, owner_id, event_type, payload) VALUES ($1, $2, $3, $4);",
        [auditId2, matchedOwner.id, "session_created", JSON.stringify({ sessionId: session.id })]
      );

      // Generate CSRF token inside same transaction
      const csrfTokenValue = randomBytes(32).toString("hex");
      const csrfTokenHash = computeTokenHash(csrfTokenValue);
      await client.query(
        "INSERT INTO csrf_session_tokens (session_id, token_value) VALUES ($1, $2);",
        [session.id, csrfTokenHash]
      );

      return {
        owner: deepCopy(matchedOwner),
        session: {
          token,
          session: deepCopy(session)
        },
        csrfToken: csrfTokenValue
      };
    });
  }

  async createSessionToken(ownerId, mfaAssuranceLevel = "password_only") {
    const token = randomBytes(32).toString("hex");
    const tokenHash = computeTokenHash(token);

    // Rotate/replace any pre-authentication active sessions for this owner
    await this.sessionsRepo.revokeAllForOwner(ownerId);

    const session = {
      id: randomUUID(),
      ownerId,
      tokenHash,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      revokedAt: null,
      sessionVersion: 1,
      mfaAssuranceLevel
    };

    await this.sessionsRepo.create(session);
    await this.recordAuditEvent(ownerId, "session_created", { sessionId: session.id });

    return { token, session: deepCopy(session) };
  }

  async validateAndRetrieveSession(token) {
    if (!token) throw new Error("SESSION_TOKEN_REQUIRED");
    const hash = computeTokenHash(token);

    const session = await this.sessionsRepo.findByTokenHash(hash);
    if (!session) throw new Error("INVALID_SESSION_TOKEN");

    // Revocation Epoch check
    const owner = await this.ownersRepo.findById(session.ownerId);
    if (owner && owner.sessionRevocationEpoch > session.sessionVersion) {
      throw new Error("SESSION_REVOKED_BY_REVOCATION_EPOCH");
    }

    if (session.revokedAt) {
      throw new Error("SESSION_REVOKED");
    }

    const now = new Date();
    if (new Date(session.absoluteExpiresAt) < now) {
      throw new Error("SESSION_ABSOLUTE_EXPIRED");
    }
    if (new Date(session.idleExpiresAt) < now) {
      throw new Error("SESSION_IDLE_EXPIRED");
    }

    // Sliding idle expiry
    session.lastSeenAt = now.toISOString();
    session.idleExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await this.sessionsRepo.updateLastSeen(session.id, session.lastSeenAt, session.idleExpiresAt);

    return deepCopy(session);
  }

  async logoutSession(token) {
    const session = await this.validateAndRetrieveSession(token);
    await this.sessionsRepo.revoke(session.id);
    await this.recordAuditEvent(session.ownerId, "logout", { sessionId: session.id });
    return true;
  }

  async changePassword(ownerId, oldPassword, newPassword, sessionToken) {
    const owner = await this.ownersRepo.findById(ownerId);
    if (!owner || !(await verifyPassword(oldPassword, owner.passwordHash))) {
      throw new Error("INVALID_OLD_PASSWORD");
    }

    validatePasswordStrength(newPassword);
    owner.passwordHash = await hashPassword(newPassword);
    owner.passwordChangedAt = new Date().toISOString();
    owner.sessionRevocationEpoch += 1;

    await this.ownersRepo.update(owner);
    await this.recordAuditEvent(ownerId, "password_changed", {});

    const newSession = await this.createSessionToken(ownerId, owner.mfaEnabled ? "high_assurance" : "password_only");
    return newSession;
  }

  async generateCsrfToken(sessionId) {
    const tokenValue = randomBytes(32).toString("hex");
    const tokenHash = computeTokenHash(tokenValue);
    await this.csrfRepo.createToken(sessionId, tokenHash);
    return tokenValue;
  }

  async verifyCsrfToken(sessionId, clientToken) {
    if (!clientToken) throw new Error("CSRF_TOKEN_REQUIRED");
    const tokenHash = computeTokenHash(clientToken);
    const matched = await this.csrfRepo.verifyToken(sessionId, tokenHash);

    if (!matched) {
      await this.recordAuditEvent(null, "csrf_rejected", { sessionId });
      throw new Error("INVALID_CSRF_TOKEN");
    }
    return true;
  }

  async enrollTotpMfa(ownerId, sessionToken) {
    const session = await this.validateAndRetrieveSession(sessionToken);
    if (session.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

    const secret = randomBytes(20).toString("hex");
    const encryptedSecret = encryptMfaSecret(secret);

    const enrollment = {
      id: randomUUID(),
      ownerId,
      encryptedTotpSecret: encryptedSecret,
      rawSecret: secret,
      isConfirmed: false,
      createdAt: new Date().toISOString()
    };

    await this.mfaRepo.createTotpEnrollment(enrollment);
    return { enrollmentId: enrollment.id, secret };
  }

  async confirmTotpMfa(ownerId, enrollmentId, totpCode) {
    const enrollment = await this.mfaRepo.findTotpEnrollment(enrollmentId);
    if (!enrollment || enrollment.ownerId !== ownerId) {
      throw new Error("MFA_ENROLLMENT_NOT_FOUND");
    }

    const decryptedSecret = decryptMfaSecret(enrollment.encrypted_totp_secret || enrollment.encryptedTotpSecret);

    // Blocker #3: Remove every hardcoded accepted TOTP value (no 123456 or 888888!)
    let isVerified = false;
    let matchedStepOffset = 0;
    const epoch = Math.floor(Date.now() / 1000);
    for (let i = -1; i <= 1; i++) {
      if (generateTotp(decryptedSecret, i) === totpCode) {
        isVerified = true;
        matchedStepOffset = i;
        break;
      }
    }

    if (!isVerified) {
      throw new Error("INVALID_TOTP_CODE");
    }

    const timeStep = String(Math.floor(epoch / 30) + matchedStepOffset);
    try {
      await this.mfaRepo.recordUsedTotpCode(ownerId, totpCode, timeStep);
    } catch (err) {
      if (err.message.includes("unique") || err.code === "23505") {
        throw new Error("REPLAYED_TOTP_CODE_REJECTED");
      }
      throw err;
    }
    await this.mfaRepo.confirmTotpEnrollment(enrollmentId, ownerId);

    // Generate 8 recovery codes
    const recoveryCodes = [];
    const hashedCodes = [];
    for (let i = 0; i < 8; i++) {
      const code = randomBytes(4).toString("hex");
      const codeHash = computeTokenHash(code);
      recoveryCodes.push(code);
      hashedCodes.push({
        id: randomUUID(),
        ownerId,
        codeHash,
        isUsed: false,
        createdAt: new Date().toISOString()
      });
    }

    await this.mfaRepo.saveRecoveryCodes(hashedCodes);
    await this.recordAuditEvent(ownerId, "mfa_challenge_succeeded", { action: "totp_enrolled" });

    return { recoveryCodes };
  }

  async verifyTotpAndElevateSession(ownerId, sessionToken, totpCode) {
    const session = await this.validateAndRetrieveSession(sessionToken);
    if (session.ownerId !== ownerId) throw new Error("OWNER_AUTHENTICATION_FAILED");

    const enrollment = await this.mfaRepo.findConfirmedTotpEnrollment(ownerId);
    if (!enrollment) throw new Error("MFA_NOT_ENROLLED");

    const decryptedSecret = decryptMfaSecret(enrollment.encrypted_totp_secret || enrollment.encryptedTotpSecret);

    let isVerified = false;
    let matchedStepOffset = 0;
    const epoch = Math.floor(Date.now() / 1000);
    for (let i = -1; i <= 1; i++) {
      if (generateTotp(decryptedSecret, i) === totpCode) {
        isVerified = true;
        matchedStepOffset = i;
        break;
      }
    }

    if (!isVerified) {
      await this.recordAuditEvent(ownerId, "mfa_challenge_failed", { type: "totp" });
      throw new Error("INVALID_TOTP_CODE");
    }

    const timeStep = String(Math.floor(epoch / 30) + matchedStepOffset);
    try {
      await this.mfaRepo.recordUsedTotpCode(ownerId, totpCode, timeStep);
    } catch (err) {
      if (err.message.includes("unique") || err.code === "23505") {
        throw new Error("REPLAYED_TOTP_CODE_REJECTED");
      }
      throw err;
    }

    // Elevate and rotate token
    await this.sessionsRepo.revoke(session.id);
    const elevated = await this.createSessionToken(ownerId, "high_assurance");
    await this.recordAuditEvent(ownerId, "mfa_challenge_succeeded", { type: "totp" });

    return elevated;
  }

  async useRecoveryCode(ownerId, code) {
    const normCodeHash = computeTokenHash(code);
    const success = await this.mfaRepo.verifyAndUseRecoveryCode(ownerId, normCodeHash);

    if (!success) {
      await this.recordAuditEvent(ownerId, "mfa_challenge_failed", { type: "recovery_code" });
      throw new Error("INVALID_OR_ALREADY_USED_RECOVERY_CODE");
    }

    await this.recordAuditEvent(ownerId, "mfa_challenge_succeeded", { type: "recovery_code" });
    return true;
  }

  async generatePasskeyRegistrationChallenge(ownerId) {
    const challenge = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await this.mfaRepo.createChallenge(challenge, expiresAt);
    return challenge;
  }

  async verifyPasskeyRegistrationAndRegister(ownerId, challenge, credentialId, publicKey) {
    const chObj = await this.mfaRepo.findChallenge(challenge);
    if (!chObj || chObj.is_used || chObj.isUsed || new Date(chObj.expires_at || chObj.expiresAt) < new Date()) {
      throw new Error("CHALLENGE_EXPIRED_OR_REPLAYED");
    }

    await this.mfaRepo.useChallenge(challenge);
    await this.mfaRepo.savePasskeyCredential(randomUUID(), ownerId, credentialId, publicKey, 0);

    await this.recordAuditEvent(ownerId, "passkey_registered", { credentialId });
    return { credentialId };
  }

  async requireAuthenticatedOwner(sessionToken) {
    const session = await this.validateAndRetrieveSession(sessionToken);
    return session.ownerId;
  }

  async requireMfaAssurance(sessionToken) {
    const session = await this.validateAndRetrieveSession(sessionToken);
    if (session.mfaAssuranceLevel !== "high_assurance") {
      throw new Error("MFA_ASSURANCE_REQUIRED");
    }
    return true;
  }

  async requireOwnerRole(ownerId, requiredRole = "owner") {
    const owner = await this.ownersRepo.findById(ownerId);
    if (!owner || owner.role !== requiredRole) {
      throw new Error("INSUFFICIENT_PRIVILEGES");
    }
    return true;
  }

  async recordAuditEvent(ownerId, eventType, payload = {}) {
    const cleanPayload = sanitizeSecrets(payload);
    await this.auditRepo.recordEvent(ownerId, eventType, cleanPayload);
    return { ownerId, eventType };
  }

  async listAuditEvents() {
    return await this.auditRepo.listEvents();
  }
}

// Default export wrapper functions using default service instance for seamless backwards compatibility
const defaultAuthService = new OwnerAuthenticationService();

export async function registerOwner(email, password) {
  return defaultAuthService.registerOwner(email, password);
}
export async function loginOwner(email, password) {
  return defaultAuthService.loginOwner(email, password);
}
export async function createSessionToken(ownerId, mfaAssuranceLevel) {
  return defaultAuthService.createSessionToken(ownerId, mfaAssuranceLevel);
}
export async function validateAndRetrieveSession(token) {
  return defaultAuthService.validateAndRetrieveSession(token);
}
export async function logoutSession(token) {
  return defaultAuthService.logoutSession(token);
}
export async function changePassword(ownerId, oldPassword, newPassword, sessionToken) {
  return defaultAuthService.changePassword(ownerId, oldPassword, newPassword, sessionToken);
}
export async function generateCsrfToken(sessionId) {
  return defaultAuthService.generateCsrfToken(sessionId);
}
export async function verifyCsrfToken(sessionId, clientToken) {
  return defaultAuthService.verifyCsrfToken(sessionId, clientToken);
}
export async function enrollTotpMfa(ownerId, sessionToken) {
  return defaultAuthService.enrollTotpMfa(ownerId, sessionToken);
}
export async function confirmTotpMfa(ownerId, enrollmentId, totpCode) {
  return defaultAuthService.confirmTotpMfa(ownerId, enrollmentId, totpCode);
}
export async function verifyTotpAndElevateSession(ownerId, sessionToken, totpCode) {
  return defaultAuthService.verifyTotpAndElevateSession(ownerId, sessionToken, totpCode);
}
export async function useRecoveryCode(ownerId, code) {
  return defaultAuthService.useRecoveryCode(ownerId, code);
}
export async function generatePasskeyRegistrationChallenge(ownerId) {
  return defaultAuthService.generatePasskeyRegistrationChallenge(ownerId);
}
export async function verifyPasskeyRegistrationAndRegister(ownerId, challenge, credentialId, publicKey) {
  return defaultAuthService.verifyPasskeyRegistrationAndRegister(ownerId, challenge, credentialId, publicKey);
}
export async function requireAuthenticatedOwner(sessionToken) {
  return defaultAuthService.requireAuthenticatedOwner(sessionToken);
}
export async function requireMfaAssurance(sessionToken) {
  return defaultAuthService.requireMfaAssurance(sessionToken);
}
export async function requireOwnerRole(ownerId, requiredRole) {
  return defaultAuthService.requireOwnerRole(ownerId, requiredRole);
}
export async function recordAuditEvent(ownerId, eventType, payload) {
  return defaultAuthService.recordAuditEvent(ownerId, eventType, payload);
}
export async function listAuditEvents() {
  return defaultAuthService.listAuditEvents();
}
